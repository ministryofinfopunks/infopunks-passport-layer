# Infopunks Passport Layer

An x402-paid passport and routing primitive for agents on Base.

## Live Service

Base URL:

```text
https://infopunks-passport-layer.onrender.com
```

Health:

```text
GET /health
```

Public event feed:

```text
GET /v1/events/recent
```

## Paid Resources

The Passport Layer exposes four paid resources:

```text
POST /v1/passport/register
POST /v1/passport/attest
POST /v1/verify-claim
POST /v1/route-agent
```

Resource map:

- `/v1/passport/register` registers a machine-readable Passport for an agent, wallet, endpoint, human, or project.
- `/v1/passport/attest` attaches evidence or attestations to an existing Passport.
- `/v1/verify-claim` checks whether a claim is supported, weak, disputed, outdated, or narratively risky.
- `/v1/route-agent` selects the best agent for a task based on trust, domain fit, budget, and risk tolerance.

## Proof

Proof index:

```text
https://infopunks-passport-layer.onrender.com/proof
```

Fresh proof page:

```text
https://infopunks-passport-layer.onrender.com/proof/xrc_7ac41db8-b3a4-447c-b871-bb8a60289755
```

## Receipts

Public receipt endpoint:

```text
GET /receipts/{receipt_id}
```

Fresh receipt:

```text
https://infopunks-passport-layer.onrender.com/receipts/xrc_7ac41db8-b3a4-447c-b871-bb8a60289755
```

Receipts expose public metadata only: receipt id, endpoint, paid resource, timestamp, input hash, output hash, x402 verification status, network, asset, facilitator provider, and final status.

## x402 / Base Configuration

Current public configuration:

```text
Facilitator: CDP x402
Network: Base mainnet
Network CAIP-2: eip155:8453
Asset: USDC
Payment scheme: exact
Default price: 0.01 USDC per paid call
```

The service returns a `402 Payment Required` challenge when a paid resource is called without a valid x402 payment header. A successful paid call returns `200` and includes a public receipt object.

## Discovery

Infopunks discovery manifest:

```text
https://infopunks-passport-layer.onrender.com/.well-known/infopunks-passport-layer.json
```

The discovery metadata advertises the paid Passport resources, route templates, pricing, Base network configuration, accepted asset, payTo address, and Bazaar-compatible extension metadata.

## OpenAPI

OpenAPI contract:

```text
https://infopunks-passport-layer.onrender.com/openapi.json
```

The OpenAPI document includes the public contract for:

```text
/v1/passport/register
/v1/passport/attest
/v1/verify-claim
/v1/route-agent
/receipts/{receipt_id}
/v1/events/recent
/proof
```

## Example Paid Call

Example paid request shape for `/v1/route-agent`:

```bash
curl -i 'https://infopunks-passport-layer.onrender.com/v1/route-agent' \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-payment: <x402-payment-payload>' \
  -d '{
    "task": "Route a market-intelligence job to the most reliable agent.",
    "context": {
      "market": "agentic commerce",
      "chain": "base",
      "urgency": "medium",
      "domain": "routing"
    },
    "candidates": [
      {
        "agent_id": "agent_a",
        "domains": ["analysis", "content"],
        "trust_score": 72,
        "evidence_count": 4,
        "status": "verified"
      },
      {
        "agent_id": "agent_b",
        "domains": ["routing", "agentic commerce"],
        "trust_score": 86,
        "evidence_count": 8,
        "status": "preferred"
      }
    ],
    "budget": {
      "amount": "1.00",
      "asset": "USDC"
    },
    "risk_tolerance": "medium",
    "policy": {
      "minimum_trust_score": 60,
      "require_recent_evidence": true,
      "prefer_domain_fit": true,
      "allow_unproven_agents": false
    }
  }'
```

Expected paid result:

```text
HTTP 200
```

The response includes a route decision and a receipt object.

## Local Development

Install dependencies:

## Mainnet Proof Archive

Canonical Infopunks v0 proof archive:
https://github.com/ministryofinfopunks/infopunks-v0-mainnet-proof

## Local install
```bash
npm install
```

Run the service locally:

```bash
npm run dev
```

Build and test:

```bash
npm run test
npm run typecheck
npm run build
```

Local development can use mock payment verification. Production deployments should use facilitator verification through CDP x402.

## Environment Variables

Core runtime:

```text
PORT
PUBLIC_BASE_URL
```

x402 configuration:

```text
X402_MOCK_MODE
X402_NETWORK
X402_ASSET
X402_PRICE_USD
X402_PAYMENT_ASSET_ADDRESS
X402_PAY_TO
X402_FACILITATOR_PROVIDER
X402_FACILITATOR_URL
X402_VERIFIER_TIMEOUT_MS
X402_DEBUG
```

CDP facilitator credentials, when facilitator mode is enabled:

```text
CDP_API_KEY_ID
CDP_API_KEY_SECRET
```

## Status

Phase 3: Passport + Routing is confirmed as a v0 mainnet proof.

Fresh paid receipt:

`xrc_7ac41db8-b3a4-447c-b871-bb8a60289755`

The service verifies x402 payment through CDP on Base mainnet and returns a route decision through `/v1/route-agent`.
