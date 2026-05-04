interface OpenApiConfig {
  publicBaseUrl: string;
  x402Network: string;
  x402Asset: string;
  x402PriceUsd: string;
}

function paidOp(summary: string, eventType: string) {
  return {
    summary,
    "x-bazaar": {
      payment_rail: "x402",
      price_units: 1,
      event_type: eventType
    },
    responses: {
      "200": { description: "Success" },
      "402": { description: "Payment required" }
    }
  };
}

export function buildOpenApiDocument(config: OpenApiConfig): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Infopunks Passport Layer",
      version: "0.1.0",
      description: "Machine-readable identity, claim hygiene, and routing for agents."
    },
    servers: [{ url: config.publicBaseUrl }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: { "200": { description: "OK" } }
        }
      },
      "/v1/passport/register": { post: paidOp("Register passport", "passport.registered") },
      "/v1/passport/{passport_id}": {
        get: {
          summary: "Fetch passport public profile",
          parameters: [{ name: "passport_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Passport" }, "404": { description: "Not found" } }
        }
      },
      "/v1/passport/attest": { post: paidOp("Attach passport attestation", "passport.attested") },
      "/v1/verify-claim": { post: paidOp("Verify claim heuristically", "claim.verified") },
      "/v1/route-agent": { post: paidOp("Route best agent", "route.decided") },
      "/receipts/{receipt_id}": {
        get: {
          summary: "Fetch public receipt",
          parameters: [{ name: "receipt_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Receipt" }, "404": { description: "Not found" } }
        }
      },
      "/v1/events/recent": {
        get: {
          summary: "Recent events",
          responses: { "200": { description: "Events" } }
        }
      },
      "/proof": {
        get: {
          summary: "Proof page",
          responses: { "200": { description: "HTML proof" } }
        }
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI document",
          responses: { "200": { description: "OpenAPI" } }
        }
      },
      "/.well-known/infopunks-passport-layer.json": {
        get: {
          summary: "Discovery manifest",
          responses: { "200": { description: "Manifest" } }
        }
      }
    },
    x402: {
      network: config.x402Network,
      asset: config.x402Asset,
      price_usd: config.x402PriceUsd
    }
  };
}
