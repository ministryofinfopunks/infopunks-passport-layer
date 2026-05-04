import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

let server: TestServer;

async function startServer(overrides?: Record<string, unknown>): Promise<TestServer> {
  const { app, config } = createApp({
    port: 0,
    publicBaseUrl: "http://127.0.0.1:0",
    x402MockMode: true,
    x402Network: "eip155:8453",
    x402Asset: "USDC",
    x402PriceUsd: "0.01",
    x402FacilitatorProvider: "mock",
    ...(overrides ?? {})
  });

  const listener = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = listener.address();
  if (!addr || typeof addr === "string") throw new Error("address unavailable");
  config.publicBaseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl: config.publicBaseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => listener.close((err) => (err ? reject(err) : resolve())));
    }
  };
}

async function post(path: string, body: unknown, paid = true) {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(paid ? { "x-payment": "mock-paid-header" } : {})
    },
    body: JSON.stringify(body)
  });
}

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await server.close();
});

describe("infopunks-passport-layer mvp", () => {
  test("health", async () => {
    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", service: "infopunks-passport-layer" });
  });

  test("unpaid paid endpoint returns 402", async () => {
    const res = await post("/v1/verify-claim", {
      claim: "AI agents will replace all analysts",
      context: "Discussion context with some detail for deterministic heuristics.",
      requested_depth: "standard",
      risk_mode: "general"
    }, false);

    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toContain('x402 realm="infopunks-passport"');
    expect(res.headers.get("x402-payment-rail")).toBe("x402");
    expect(res.headers.get("x402-required")).toBe("true");
    expect(res.headers.get("x402-pricing-units")).toBe("1");
    expect(res.headers.get("x402-supported-networks")).toBe("eip155:8453");
    expect(res.headers.get("x402-accepted-assets")).toBe("USDC");
  });

  test("mock paid endpoint returns 200 with receipt", async () => {
    const res = await post("/v1/verify-claim", {
      claim: "Agents may automate parts of market analysis",
      context: "We have receipts, tests, and benchmarks in this context for deterministic checks.",
      requested_depth: "light",
      risk_mode: "general"
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt).toBeTruthy();
    expect(body.receipt.x402_verified).toBe(true);
    expect(body.receipt.asset).toBe("USDC");
  });

  test("passport registration", async () => {
    const res = await post("/v1/passport/register", {
      subject_type: "agent",
      display_name: "Atlas Router",
      wallet: "0x1111111111111111111111111111111111111111",
      domains: ["routing", "defi"],
      claims: [{ type: "capability", value: "execution" }]
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passport_id).toMatch(/^infp_agent_/);
    expect(body.trust_score).toBe(65);
    expect(body.claim_count).toBe(1);
  });

  test("passport fetch", async () => {
    const created = await post("/v1/passport/register", {
      subject_type: "human",
      display_name: "Sam",
      wallet: "0x1111111111111111111111111111111111111111",
      domains: []
    });
    const createdBody = await created.json();

    const fetched = await fetch(`${server.baseUrl}/v1/passport/${createdBody.passport_id}`);
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody.passport_id).toBe(createdBody.passport_id);
    expect(fetchedBody.display_name).toBe("Sam");
  });

  test("passport attestation updates score", async () => {
    const created = await post("/v1/passport/register", {
      subject_type: "agent",
      display_name: "Ops Agent",
      wallet: "0x1111111111111111111111111111111111111111",
      domains: ["ops"]
    });
    const createdBody = await created.json();

    const attested = await post("/v1/passport/attest", {
      passport_id: createdBody.passport_id,
      attestation_type: "task_success",
      summary: "Completed 12 tasks with quality evidence"
    });

    expect(attested.status).toBe(200);
    const attestedBody = await attested.json();
    expect(attestedBody.updated_trust_score).toBe(createdBody.trust_score + 8);
    expect(attestedBody.evidence_count).toBe(1);
  });

  test("verify-claim overextension behavior", async () => {
    const res = await post("/v1/verify-claim", {
      claim: "This strategy is guaranteed to win and will replace discretionary investing",
      context: "The context includes a few arguments but no audited or complete proof of universal success.",
      requested_depth: "standard",
      risk_mode: "market"
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["directionally_supported", "weakly_supported", "unsupported"]).toContain(body.claim_status);
    expect(body.narrative_risk).toBe("overextension");
    expect(body.policy.reject_if_used_for_investment_claim).toBe(true);
  });

  test("route-agent selects best candidate", async () => {
    const res = await post("/v1/route-agent", {
      task: "Route an onchain execution task for defi market making",
      context: { domain: "defi", urgency: "medium" },
      candidates: [
        { agent_id: "a1", trust_score: 66, evidence_count: 3, domains: ["defi"], status: "unproven" },
        { agent_id: "a2", trust_score: 84, evidence_count: 8, domains: ["defi", "routing"], status: "verified" }
      ],
      budget: { amount: "10", asset: "USDC" },
      risk_tolerance: "medium",
      policy: {
        minimum_trust_score: 70,
        require_recent_evidence: true,
        prefer_domain_fit: true,
        allow_unproven_agents: false
      }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("route");
    expect(body.selected_agent).toBe("a2");
  });

  test("route-agent returns do_not_route if no candidate passes", async () => {
    const res = await post("/v1/route-agent", {
      task: "Critical routing",
      context: { domain: "defi" },
      candidates: [
        { agent_id: "low1", trust_score: 40, evidence_count: 0, domains: ["nft"], status: "watch" },
        { agent_id: "low2", trust_score: 35, evidence_count: 0, domains: ["gaming"], status: "restricted" }
      ],
      budget: { amount: "5", asset: "USDC" },
      risk_tolerance: "low",
      policy: {
        minimum_trust_score: 75,
        require_recent_evidence: true,
        prefer_domain_fit: true,
        allow_unproven_agents: false
      }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("do_not_route");
    expect(body.selected_agent).toBeNull();
  });

  test("receipts endpoint", async () => {
    const paid = await post("/v1/verify-claim", {
      claim: "A careful claim",
      context: "Detailed enough context with evidence and benchmarks for deterministic heuristics.",
      requested_depth: "light",
      risk_mode: "general"
    });
    const paidBody = await paid.json();

    const receiptRes = await fetch(`${server.baseUrl}/receipts/${paidBody.receipt.receipt_id}`);
    expect(receiptRes.status).toBe(200);
    const receipt = await receiptRes.json();
    expect(receipt.receipt_id).toBe(paidBody.receipt.receipt_id);
    expect(receipt.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.output_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("events endpoint", async () => {
    await post("/v1/verify-claim", {
      claim: "Agents may improve coordination outcomes",
      context: "Context includes tests and receipts and benchmarks for deterministic checks.",
      requested_depth: "light",
      risk_mode: "general"
    });

    const res = await fetch(`${server.baseUrl}/v1/events/recent`);
    expect(res.status).toBe(200);
    const events = await res.json();
    const eventTypes = events.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toContain("paid_call.success");
    expect(eventTypes).toContain("claim.verified");
  });

  test("openapi includes Phase 3 endpoints", async () => {
    const res = await fetch(`${server.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain("/v1/passport/register");
    expect(paths).toContain("/v1/passport/attest");
    expect(paths).toContain("/v1/verify-claim");
    expect(paths).toContain("/v1/route-agent");
  });

  test("discovery manifest includes Phase 3 resources", async () => {
    const res = await fetch(`${server.baseUrl}/.well-known/infopunks-passport-layer.json`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resources.passport_register.path).toBe("/v1/passport/register");
    expect(doc.resources.passport_register.url).toBe(`${server.baseUrl}/v1/passport/register`);
    expect(doc.resources.passport_attest.path).toBe("/v1/passport/attest");
    expect(doc.resources.passport_attest.url).toBe(`${server.baseUrl}/v1/passport/attest`);
    expect(doc.resources.verify_claim.path).toBe("/v1/verify-claim");
    expect(doc.resources.verify_claim.url).toBe(`${server.baseUrl}/v1/verify-claim`);
    expect(doc.resources.route_agent.path).toBe("/v1/route-agent");
    expect(doc.resources.route_agent.url).toBe(`${server.baseUrl}/v1/route-agent`);
  });

  test("facilitator mode success returns cdp receipt fields", async () => {
    await server.close();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/verify")) {
        return new Response(JSON.stringify({ ok: true, reference: "verify_ref" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/settle")) {
        return new Response(JSON.stringify({ settled: true, transactionHash: "0xabc" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      server = await startServer({
        x402MockMode: false,
        x402FacilitatorProvider: "cdp",
        x402FacilitatorUrl: "https://facilitator.test/v2/x402"
      });

      const paid = await fetch(`${server.baseUrl}/v1/verify-claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-payment": JSON.stringify({
            paymentPayload: { payload: { authorization: { from: "0x2222222222222222222222222222222222222222" } } },
            paymentRequirements: {
              scheme: "exact",
              network: "eip155:8453",
              maxAmountRequired: "10000",
              resource: `${server.baseUrl}/v1/verify-claim`,
              description: "Infopunks Passport Layer paid endpoint",
              mimeType: "application/json",
              payTo: "0x0000000000000000000000000000000000000000",
              maxTimeoutSeconds: 300,
              asset: "0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913"
            }
          })
        },
        body: JSON.stringify({
          claim: "Agents may automate parts of analysis",
          context: "Context with evidence and benchmark language for deterministic heuristic checks.",
          requested_depth: "standard",
          risk_mode: "general"
        })
      });

      expect(paid.status).toBe(200);
      const body = await paid.json();
      expect(body.receipt.facilitator_provider).toBe("cdp");
      expect(body.receipt.x402_verified).toBe(true);
      expect(body.receipt.network).toBe("eip155:8453");
      expect(body.receipt.asset).toBe("USDC");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
