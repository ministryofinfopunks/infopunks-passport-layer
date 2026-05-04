import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { createCdpAuthHeaders } from "@coinbase/x402";
import {
  AttestSchema,
  RegisterPassportSchema,
  RouteAgentSchema,
  VerifyClaimSchema,
  type PassportRecord,
  type PassportStatus,
  type PublicEvent,
  type PublicReceipt,
  type PaymentVerification
} from "./types.js";
import { buildOpenApiDocument } from "./openapi.js";

type PaidResource = "/v1/passport/register" | "/v1/passport/attest" | "/v1/verify-claim" | "/v1/route-agent";
type EventType = PublicEvent["event_type"];

interface AppConfig {
  port: number;
  publicBaseUrl: string;
  x402MockMode: boolean;
  x402Network: string;
  x402Asset: string;
  x402PriceUsd: string;
  x402PaymentAssetAddress: string;
  x402PayTo: string;
  x402FacilitatorProvider: string;
  x402FacilitatorUrl: string | null;
  x402VerifierTimeoutMs: number;
  cdpApiKeyId: string | null;
  cdpApiKeySecret: string | null;
  x402Debug: boolean;
}

interface ReceiptWithMeta {
  receipt: PublicReceipt;
  paid_resource: PaidResource;
}

interface Stores {
  passports: Map<string, PassportRecord>;
  receipts: Map<string, ReceiptWithMeta>;
  events: PublicEvent[];
}

interface PaidRequest<TBody = unknown> extends Request {
  body: TBody;
  payment?: PaymentVerification;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  return String(v).trim().toLowerCase() === "true";
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function sanitizeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "subject";
}

function walletLooksValid(wallet: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(wallet.trim());
}

function statusFromScore(score: number): PassportStatus {
  if (score <= 39) return "restricted";
  if (score <= 59) return "watch";
  if (score <= 74) return "unproven";
  if (score <= 89) return "verified";
  return "preferred";
}

function nowIso(): string {
  return new Date().toISOString();
}

function newReceiptId(): string {
  return `xrc_${randomUUID()}`;
}

function newEventId(): string {
  return `evt_${randomUUID()}`;
}

interface SelectedPaymentHeader {
  name: string;
  value: string;
}

function getPaymentHeader(req: Request): SelectedPaymentHeader | null {
  const candidates = [
    "payment-signature",
    "x-payment",
    "x402-payment",
    "payment"
  ];
  for (const key of candidates) {
    const v = req.header(key);
    if (v && v.trim()) {
      return { name: key, value: v.trim() };
    }
  }
  return null;
}

function apply402Headers(reply: Response): void {
  reply.setHeader("www-authenticate", 'x402 realm="infopunks-passport", units="1", rail="x402"');
  reply.setHeader("x402-payment-rail", "x402");
  reply.setHeader("x402-required", "true");
  reply.setHeader("x402-pricing-units", "1");
  reply.setHeader("x402-supported-networks", "eip155:8453");
  reply.setHeader("x402-accepted-assets", "USDC");
}

function normalizeRequestPath(requestPath: string): string {
  const pathWithoutQuery = requestPath.split("?")[0] ?? requestPath;
  if (pathWithoutQuery.startsWith("/")) return pathWithoutQuery;
  return `/${pathWithoutQuery}`;
}

function priceUsdToAtomic(priceUsd: string): string {
  const numeric = Number(priceUsd);
  if (!Number.isFinite(numeric) || numeric <= 0) return "10000";
  return String(Math.round(numeric * 1_000_000));
}

function buildX402PaymentRequirement(config: AppConfig, requestPath: string): Record<string, unknown> {
  const resource = `${config.publicBaseUrl}${normalizeRequestPath(requestPath)}`;
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: priceUsdToAtomic(config.x402PriceUsd),
    resource,
    description: "Infopunks Passport Layer paid endpoint",
    mimeType: "application/json",
    payTo: config.x402PayTo,
    maxTimeoutSeconds: 300,
    asset: config.x402PaymentAssetAddress,
    extra: { name: "USD Coin", version: "2" }
  };
}

function buildPaymentChallenge(config: AppConfig, requestPath: string, error: string): Record<string, unknown> {
  const requirement = buildX402PaymentRequirement(config, requestPath);
  return {
    x402Version: 1,
    accepts: [requirement],
    error,
    message: "x402 payment required for this endpoint.",
    payment: {
      version: "x402",
      mode: config.x402MockMode ? "mock" : "facilitator",
      scheme: "exact",
      network: "base",
      asset_symbol: config.x402Asset,
      asset_address: config.x402PaymentAssetAddress,
      price_usd: config.x402PriceUsd,
      price_atomic: priceUsdToAtomic(config.x402PriceUsd),
      pay_to: config.x402PayTo,
      required_header: "PAYMENT-SIGNATURE",
      facilitator_url: config.x402FacilitatorUrl,
      resource: requirement.resource,
      method: "POST"
    }
  };
}

function setPaymentRequiredHeader(reply: Response, challenge: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
  reply.setHeader("PAYMENT-REQUIRED", encoded);
}

function decodePossibleBase64Json(input: string): Record<string, unknown> | null {
  try {
    const direct = JSON.parse(input);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch {
    // continue
  }
  try {
    const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.length % 4 === 0 ? normalized : `${normalized}${"=".repeat(4 - (normalized.length % 4))}`;
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(decoded);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

async function verifyViaFacilitator(
  config: AppConfig,
  paymentHeader: string,
  requestPath: string
): Promise<PaymentVerification | null> {
  if (!config.x402FacilitatorUrl) return null;
  const decoded = decodePossibleBase64Json(paymentHeader);
  if (!decoded) return null;

  const isObj = (value: unknown): value is Record<string, unknown> =>
    value != null && typeof value === "object" && !Array.isArray(value);

  const paymentPayload = isObj(decoded.paymentPayload) ? decoded.paymentPayload : decoded;
  const paymentRequirements = buildX402PaymentRequirement(config, requestPath);

  const payload = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements
  };
  const baseUrl = config.x402FacilitatorUrl.replace(/\/$/, "");
  const cdpHeadersFactory = (config.cdpApiKeyId && config.cdpApiKeySecret)
    ? createCdpAuthHeaders(config.cdpApiKeyId, config.cdpApiKeySecret)
    : null;
  const authHeaders = cdpHeadersFactory ? await cdpHeadersFactory() : {};

  const verifyRequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...((authHeaders as { verify?: Record<string, string> }).verify ?? {})
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.x402VerifierTimeoutMs)
  } as const;

  const verifyRes = await fetch(`${baseUrl}/verify`, verifyRequestInit);
  if (!verifyRes.ok) return null;
  const verifyBody = (await verifyRes.json().catch(() => ({}))) as Record<string, unknown>;
  const verifyOk = verifyBody.ok === true || verifyBody.verified === true || verifyBody.isValid === true;
  if (!verifyOk) return null;

  const settleRequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...((authHeaders as { settle?: Record<string, string> }).settle ?? {})
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.x402VerifierTimeoutMs)
  } as const;

  const settleRes = await fetch(`${baseUrl}/settle`, settleRequestInit);
  if (!settleRes.ok) return null;
  const settleBody = (await settleRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (settleBody.success === false || settleBody.settled === false) return null;

  const reference = String(
    settleBody.reference
      ?? settleBody.transactionHash
      ?? verifyBody.reference
      ?? verifyBody.transactionHash
      ?? `fac_${createHash("sha256").update(paymentHeader).digest("hex").slice(0, 16)}`
  );

  return { verified: true, provider: "cdp", reference };
}

function buildDiscoveryManifest(config: AppConfig): Record<string, unknown> {
  const pricing = {
    rail: "x402",
    scheme: "exact",
    price_usd: config.x402PriceUsd,
    facilitator: config.x402FacilitatorProvider
  };

  return {
    name: "Infopunks Passport Layer",
    description: "Machine-readable identity, claim hygiene, and routing for agents.",
    resources: {
      passport_register: {
        method: "POST",
        path: "/v1/passport/register",
        url: `${config.publicBaseUrl}/v1/passport/register`,
        resource: `${config.publicBaseUrl}/v1/passport/register`,
        routeTemplate: "/v1/passport/register",
        description: "Register a machine-readable Passport for an agent, wallet, endpoint, human, or project.",
        pricing,
        network: config.x402Network,
        asset: config.x402Asset,
        payTo: config.x402PayTo
      },
      passport_attest: {
        method: "POST",
        path: "/v1/passport/attest",
        url: `${config.publicBaseUrl}/v1/passport/attest`,
        resource: `${config.publicBaseUrl}/v1/passport/attest`,
        routeTemplate: "/v1/passport/attest",
        description: "Attach evidence or attestations to an existing Passport.",
        pricing,
        network: config.x402Network,
        asset: config.x402Asset,
        payTo: config.x402PayTo
      },
      verify_claim: {
        method: "POST",
        path: "/v1/verify-claim",
        url: `${config.publicBaseUrl}/v1/verify-claim`,
        resource: `${config.publicBaseUrl}/v1/verify-claim`,
        routeTemplate: "/v1/verify-claim",
        description: "Verify whether a claim is supported, weak, disputed, outdated, or narratively risky.",
        pricing,
        network: config.x402Network,
        asset: config.x402Asset,
        payTo: config.x402PayTo
      },
      route_agent: {
        method: "POST",
        path: "/v1/route-agent",
        url: `${config.publicBaseUrl}/v1/route-agent`,
        resource: `${config.publicBaseUrl}/v1/route-agent`,
        routeTemplate: "/v1/route-agent",
        description: "Select the best agent for a task based on trust, domain fit, budget, and risk tolerance.",
        pricing,
        network: config.x402Network,
        asset: config.x402Asset,
        payTo: config.x402PayTo
      }
    },
    extensions: {
      bazaar: {
        compatibility: ["x402", "agentic-market", "bazaar"],
        paid_resources: ["/v1/passport/register", "/v1/passport/attest", "/v1/verify-claim", "/v1/route-agent"]
      }
    }
  };
}

function scoreClaim(input: { claim: string; context: string; risk_mode: "narrative" | "market" | "technical" | "general" }) {
  const claim = input.claim.trim();
  const context = input.context.trim();
  const combined = `${claim} ${context}`.toLowerCase();

  const tooShort = claim.length < 18 || context.length < 24;
  const hasAbsolute = /\b(guaranteed|certain|default|will replace|always|never|cannot fail)\b/i.test(claim);
  const manipulative = /\b(risk[- ]?free|can't lose|100x|must buy now|insider secret|guaranteed returns?)\b/i.test(combined);
  const disputed = /\b(disputed|controversial|lawsuit|alleged|critics|challenge|unclear)\b/i.test(combined);
  const unsupported = /\b(no evidence|without proof|fabricated|made up|fake)\b/i.test(combined);
  const outdated = /\b(2019|2020|2021|2022|legacy model|deprecated)\b/i.test(combined) && /\b(today|currently|now)\b/i.test(combined);
  const evidenceSignals = (combined.match(/\b(data|source|receipt|proof|audit|log|metric|benchmark|test)\b/g) ?? []).length;

  let claim_status:
    | "supported"
    | "directionally_supported"
    | "weakly_supported"
    | "disputed"
    | "outdated"
    | "unsupported"
    | "manipulative"
    | "insufficient_context" = "supported";
  let confidence = 0.78;
  let narrative_risk: "low" | "medium" | "high" | "overextension" = "low";

  if (tooShort) {
    claim_status = "insufficient_context";
    confidence = 0.2;
    narrative_risk = "medium";
  } else if (manipulative) {
    claim_status = "manipulative";
    confidence = 0.88;
    narrative_risk = "high";
  } else if (unsupported) {
    claim_status = "unsupported";
    confidence = 0.82;
    narrative_risk = hasAbsolute ? "overextension" : "high";
  } else if (outdated) {
    claim_status = "outdated";
    confidence = 0.76;
    narrative_risk = "medium";
  } else if (disputed) {
    claim_status = "disputed";
    confidence = 0.7;
    narrative_risk = "high";
  } else if (hasAbsolute) {
    claim_status = evidenceSignals >= 2 ? "directionally_supported" : "weakly_supported";
    confidence = evidenceSignals >= 2 ? 0.61 : 0.48;
    narrative_risk = "overextension";
  } else if (evidenceSignals === 0) {
    claim_status = "weakly_supported";
    confidence = 0.43;
    narrative_risk = "medium";
  } else if (evidenceSignals < 2) {
    claim_status = "directionally_supported";
    confidence = 0.62;
    narrative_risk = "medium";
  }

  const recommended_language = hasAbsolute
    ? claim.replace(/\bguaranteed\b/gi, "can improve the odds")
      .replace(/\bcertain\b/gi, "plausible")
      .replace(/\bdefault\b/gi, "common")
      .replace(/\bwill replace\b/gi, "may partially replace")
    : `Based on available context, ${claim.charAt(0).toLowerCase()}${claim.slice(1)}.`;

  const counterpoints = [
    "Evidence quality and recency should be checked before amplification.",
    "Alternative explanations or edge cases may change the conclusion."
  ];

  const rejectMarket = input.risk_mode === "market"
    && (hasAbsolute || ["weakly_supported", "unsupported", "manipulative", "disputed", "outdated"].includes(claim_status));

  return {
    claim_status,
    confidence,
    evidence_summary: `Deterministic language-risk heuristic based on claim/context structure. Evidence signal count: ${evidenceSignals}.`,
    counterpoints,
    narrative_risk,
    recommended_language,
    policy: {
      safe_to_amplify: ["supported", "directionally_supported"].includes(claim_status) && narrative_risk !== "overextension" && claim_status !== "disputed",
      requires_caveat: !["supported"].includes(claim_status) || narrative_risk !== "low",
      reject_if_used_for_investment_claim: rejectMarket
    }
  };
}

function renderProofHtml(config: AppConfig, stores: Stores): string {
  const recentReceipts = Array.from(stores.receipts.values())
    .map((x) => x.receipt)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10);
  const recentEvents = stores.events.slice(0, 20);

  const receiptRows = recentReceipts
    .map((r) => `<li>${r.timestamp} | ${r.endpoint} | ${r.receipt_id} | ${r.status}</li>`)
    .join("");
  const eventRows = recentEvents
    .map((e) => `<li>${e.timestamp} | ${e.event_type} | ${e.receipt_id}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Infopunks Proof</title>
<style>body{background:#0b0f14;color:#d4e0ee;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}main{max-width:980px;margin:0 auto;padding:24px}h1{margin:0 0 10px}.box{border:1px solid #273444;border-radius:10px;padding:14px;margin:12px 0;background:#101722}ul{margin:0;padding-left:20px}li{margin:4px 0;word-break:break-all}.k{color:#9fb3c8}</style></head>
<body><main>
<h1>Infopunks Passport Layer Proof</h1>
<div class="box"><div><span class="k">service</span>: infopunks-passport-layer</div><div><span class="k">public base url</span>: ${config.publicBaseUrl}</div><div><span class="k">paid resources</span>: /v1/passport/register, /v1/passport/attest, /v1/verify-claim, /v1/route-agent</div><div><span class="k">facilitator provider</span>: ${config.x402FacilitatorProvider}</div><div><span class="k">network</span>: ${config.x402Network}</div><div><span class="k">asset</span>: ${config.x402Asset}</div></div>
<div class="box"><div class="k">recent receipts</div><ul>${receiptRows || "<li>none</li>"}</ul></div>
<div class="box"><div class="k">recent events</div><ul>${eventRows || "<li>none</li>"}</ul></div>
</main></body></html>`;
}

function createDefaultConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 4023);
  return {
    port,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    x402MockMode: parseBool(process.env.X402_MOCK_MODE, true),
    x402Network: process.env.X402_NETWORK ?? "eip155:8453",
    x402Asset: process.env.X402_ASSET ?? "USDC",
    x402PriceUsd: process.env.X402_PRICE_USD ?? "0.01",
    x402PaymentAssetAddress: process.env.X402_PAYMENT_ASSET_ADDRESS ?? "0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913",
    x402PayTo: process.env.X402_PAY_TO ?? "0xe4E8908308a86aB43E5dEb6C0fd0F006786104c3",
    x402FacilitatorProvider: process.env.X402_FACILITATOR_PROVIDER ?? "cdp",
    x402FacilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://api.cdp.coinbase.com/platform/v2/x402",
    x402VerifierTimeoutMs: Number(process.env.X402_VERIFIER_TIMEOUT_MS ?? 8000),
    cdpApiKeyId: process.env.CDP_API_KEY_ID ?? null,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET ?? null,
    x402Debug: parseBool(process.env.X402_DEBUG, false)
  };
}

export function createApp(overrides?: Partial<AppConfig>) {
  const config = { ...createDefaultConfig(), ...(overrides ?? {}) };
  const stores: Stores = {
    passports: new Map(),
    receipts: new Map(),
    events: []
  };

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  function addEvent(type: EventType, receipt: PublicReceipt): void {
    stores.events.unshift({
      event_id: newEventId(),
      event_type: type,
      receipt_id: receipt.receipt_id,
      endpoint: receipt.endpoint,
      timestamp: receipt.timestamp
    });
    if (stores.events.length > 200) stores.events.length = 200;
  }

  async function requirePaid(req: PaidRequest, res: Response, next: NextFunction): Promise<void> {
    const selectedHeader = getPaymentHeader(req);
    if (!selectedHeader) {
      apply402Headers(res);
      const challenge = buildPaymentChallenge(config, req.path, "PAYMENT-SIGNATURE header is required");
      setPaymentRequiredHeader(res, challenge);
      res.status(402).json(challenge);
      return;
    }

    if (config.x402MockMode) {
      req.payment = {
        verified: true,
        provider: "mock",
        reference: `mock_${createHash("sha256").update(selectedHeader.value).digest("hex").slice(0, 16)}`
      };
      next();
      return;
    }

    const verified = await verifyViaFacilitator(config, selectedHeader.value, req.path).catch(() => null);
    if (!verified) {
      apply402Headers(res);
      const challenge = buildPaymentChallenge(config, req.path, "x402 facilitator verify/settle failed.");
      setPaymentRequiredHeader(res, challenge);
      if (config.x402Debug) {
        const decoded = decodePossibleBase64Json(selectedHeader.value);
        const requirement = buildX402PaymentRequirement(config, req.path);
        res.status(402).json({
          ...challenge,
          debug: {
            received_payment_header_name: selectedHeader.name,
            payment_payload_present: Boolean(decoded && typeof decoded === "object"),
            payment_requirements_network: requirement.network,
            payment_requirements_resource: requirement.resource,
            facilitator_provider: config.x402FacilitatorProvider
          }
        });
        return;
      }
      res.status(402).json(challenge);
      return;
    }

    req.payment = verified;
    next();
  }

  function finalizePaidCall(
    req: PaidRequest,
    res: Response,
    endpoint: PaidResource,
    eventType: EventType,
    output: Record<string, unknown> | PassportRecord
  ): void {
    const paid = req.payment;
    if (!paid) {
      res.status(500).json({ error: "payment_context_missing" });
      return;
    }
    const timestamp = nowIso();
    const receipt: PublicReceipt = {
      receipt_id: newReceiptId(),
      endpoint,
      paid_resource: endpoint,
      timestamp,
      input_hash: sha256(req.body ?? {}),
      output_hash: sha256(output),
      x402_verified: true,
      network: config.x402Network,
      asset: config.x402Asset,
      facilitator_provider: paid.provider,
      status: 200
    };

    stores.receipts.set(receipt.receipt_id, { receipt, paid_resource: endpoint });
    addEvent("paid_call.success", receipt);
    addEvent(eventType, receipt);

    res.status(200).json({ ...output, receipt });
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "infopunks-passport-layer" });
  });

  app.post("/v1/passport/register", requirePaid, (req: PaidRequest, res: Response) => {
    const parsed = RegisterPassportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const score = clamp(
      50
      + (walletLooksValid(input.wallet) ? 5 : 0)
      + (input.domains.length > 0 ? 5 : 0)
      + ((input.claims?.length ?? 0) > 0 ? 5 : 0),
      0,
      100
    );

    const passportId = `infp_${input.subject_type}_${sanitizeIdPart(input.display_name)}_${randomUUID().slice(0, 8)}`;
    const lastVerified = nowIso();
    const record: PassportRecord = {
      passport_id: passportId,
      subject_type: input.subject_type,
      display_name: input.display_name,
      wallet: input.wallet,
      domains: input.domains,
      ...(input.endpoint_url ? { endpoint_url: input.endpoint_url } : {}),
      ...(input.operator ? { operator: input.operator } : {}),
      trust_score: score,
      evidence_count: 0,
      claim_count: input.claims?.length ?? 0,
      last_verified: lastVerified,
      status: statusFromScore(score),
      passport_url: `${config.publicBaseUrl}/v1/passport/${passportId}`
    };

    stores.passports.set(passportId, record);
    finalizePaidCall(req, res, "/v1/passport/register", "passport.registered", record);
  });

  app.get("/v1/passport/:passport_id", (req, res) => {
    const id = String(req.params.passport_id);
    const record = stores.passports.get(id);
    if (!record) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(record);
  });

  app.post("/v1/passport/attest", requirePaid, (req: PaidRequest, res: Response) => {
    const parsed = AttestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const passport = stores.passports.get(input.passport_id);
    if (!passport) {
      res.status(404).json({ error: "passport_not_found" });
      return;
    }

    const deltaMap: Record<string, number> = {
      task_success: 8,
      capability: 4,
      domain: 3,
      external_reference: 5,
      task_failure: -10,
      dispute: -15
    };

    passport.trust_score = clamp(passport.trust_score + (deltaMap[input.attestation_type] ?? 0), 0, 100);
    passport.evidence_count += 1;
    passport.last_verified = nowIso();
    passport.status = statusFromScore(passport.trust_score);

    finalizePaidCall(req, res, "/v1/passport/attest", "passport.attested", {
      attestation_id: `att_${randomUUID()}`,
      passport_id: passport.passport_id,
      accepted: true,
      evidence_count: passport.evidence_count,
      updated_trust_score: passport.trust_score,
      status: passport.status
    });
  });

  app.post("/v1/verify-claim", requirePaid, (req: PaidRequest, res: Response) => {
    const parsed = VerifyClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const out = scoreClaim(parsed.data);
    finalizePaidCall(req, res, "/v1/verify-claim", "claim.verified", out as Record<string, unknown>);
  });

  app.post("/v1/route-agent", requirePaid, (req: PaidRequest, res: Response) => {
    const parsed = RouteAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const taskLower = input.task.toLowerCase();
    const desiredDomain = input.context?.domain?.toLowerCase() ?? "";

    const riskDivisor = input.risk_tolerance === "low" ? 10 : input.risk_tolerance === "medium" ? 20 : 33;

    const evaluated = input.candidates.map((candidate, index) => {
      const agentId = candidate.agent_id ?? candidate.passport_id ?? candidate.wallet ?? `candidate_${index + 1}`;
      const trust = clamp(candidate.trust_score ?? 50, 0, 100);
      const evidence = Math.max(0, Math.floor(candidate.evidence_count ?? 0));
      const domains = (candidate.domains ?? []).map((x) => x.toLowerCase());
      const status = candidate.status ?? statusFromScore(trust);

      const hasDomainFit = desiredDomain
        ? domains.some((d) => d.includes(desiredDomain) || desiredDomain.includes(d))
        : domains.some((d) => taskLower.includes(d));
      const domainBonus = input.policy.prefer_domain_fit ? (hasDomainFit ? 10 : 0) : 0;
      const evidenceBonus = clamp(evidence, 0, 10);
      const riskPenalty = (100 - trust) / riskDivisor;
      const unprovenPenalty = status === "unproven" && !input.policy.allow_unproven_agents ? 12
        : status === "watch" ? 8
        : status === "restricted" || status === "revoked" ? 30
        : 0;

      const routingScore = Number((trust + domainBonus + evidenceBonus - riskPenalty - unprovenPenalty).toFixed(2));

      const policyReasons: string[] = [];
      if (trust < input.policy.minimum_trust_score) policyReasons.push("trust_below_minimum");
      if (input.policy.require_recent_evidence && evidence < 1) policyReasons.push("missing_recent_evidence");
      if (!input.policy.allow_unproven_agents && status === "unproven") policyReasons.push("unproven_not_allowed");
      if (status === "restricted" || status === "revoked") policyReasons.push("restricted_or_revoked");

      return { agentId, routingScore, policyReasons, status, trust };
    });

    evaluated.sort((a, b) => b.routingScore - a.routingScore);
    const best = evaluated[0];
    const fallback = evaluated.find((c) => c.agentId !== best.agentId) ?? null;

    let decision: "route" | "do_not_route" | "needs_validation" = "do_not_route";
    let reason = "No candidate passed policy.";

    if (best && best.policyReasons.length === 0) {
      decision = "route";
      reason = "Best candidate passed policy and scored highest.";
    } else if (best && best.status !== "restricted" && best.status !== "revoked" && best.routingScore >= input.policy.minimum_trust_score - 5) {
      decision = "needs_validation";
      reason = "Best candidate is close but requires manual validation.";
    }

    const rejected = evaluated
      .filter((c) => c.policyReasons.length > 0)
      .map((c) => ({ agent_id: c.agentId, reason: c.policyReasons.join(",") }))
      .slice(0, 25);

    finalizePaidCall(req, res, "/v1/route-agent", "route.decided", {
      selected_agent: decision === "route" ? best?.agentId ?? null : null,
      fallback_agent: fallback?.agentId ?? null,
      decision,
      reason,
      routing_score: best?.routingScore ?? 0,
      policy: input.policy,
      rejected_candidates: rejected
    });
  });

  app.get("/receipts/:receipt_id", (req, res) => {
    const id = String(req.params.receipt_id);
    const record = stores.receipts.get(id);
    if (!record) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(record.receipt);
  });

  app.get("/v1/events/recent", (_req, res) => {
    res.json(stores.events.slice(0, 100));
  });

  app.get("/proof", (_req, res) => {
    res.type("text/html; charset=utf-8").send(renderProofHtml(config, stores));
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiDocument(config));
  });

  app.get("/.well-known/infopunks-passport-layer.json", (_req, res) => {
    res.json(buildDiscoveryManifest(config));
  });

  return { app, config, stores };
}
