# infopunks-passport-layer

Minimal production-style MVP for Infopunks Passport Layer: machine-readable identity, claim hygiene, and routing for agents with x402-paid calls, public receipts, events, proof page, OpenAPI, and discovery manifest.

## Endpoints
- `GET /health`
- `POST /v1/passport/register` (paid)
- `GET /v1/passport/:passport_id`
- `POST /v1/passport/attest` (paid)
- `POST /v1/verify-claim` (paid)
- `POST /v1/route-agent` (paid)
- `GET /receipts/:receipt_id`
- `GET /v1/events/recent`
- `GET /proof`
- `GET /openapi.json`
- `GET /.well-known/infopunks-passport-layer.json`

## Mainnet Proof Archive

Canonical Infopunks v0 proof archive:
https://github.com/ministryofinfopunks/infopunks-v0-mainnet-proof

## Local install
```bash
npm install
cp .env.example .env
npm run dev
```

## Test + build
```bash
npm run test
npm run typecheck
npm run build
```

## Unpaid curl example (returns 402)
```bash
curl -i -X POST http://localhost:4023/v1/verify-claim \
  -H 'content-type: application/json' \
  -d '{"claim":"Agents will replace analysts","context":"Some context text long enough for validation","requested_depth":"standard","risk_mode":"general"}'
```

## Mock-paid curl example
```bash
curl -s -X POST http://localhost:4023/v1/verify-claim \
  -H 'content-type: application/json' \
  -H 'x-payment: mock-paid-header' \
  -d '{"claim":"Agents may automate parts of analysis","context":"Context with evidence, tests, and constraints for deterministic heuristic evaluation.","requested_depth":"standard","risk_mode":"general"}'
```
Mock mode is for local testing only and is not real settlement.

## Buyer test (real facilitator mode)
```bash
curl -s -X POST http://localhost:4023/v1/verify-claim \
  -H 'content-type: application/json' \
  -H "x-payment: <BASE64_OR_JSON_X402_PAYMENT_FROM_BUYER>" \
  -d '{"claim":"Agents may automate parts of analysis","context":"Context with evidence and constraints for deterministic heuristic evaluation.","requested_depth":"standard","risk_mode":"general"}'
```

## Proof URL
- `http://localhost:4023/proof`

## Deployment env vars
- `PORT`
- `PUBLIC_BASE_URL`
- `X402_MOCK_MODE`
- `X402_NETWORK`
- `X402_ASSET`
- `X402_PRICE_USD`
- `X402_FACILITATOR_PROVIDER`
- `X402_FACILITATOR_URL` (required when `X402_MOCK_MODE=false`)
- `CDP_API_KEY_ID` (required when `X402_MOCK_MODE=false`)
- `CDP_API_KEY_SECRET` (required when `X402_MOCK_MODE=false`)
- `X402_VERIFIER_TIMEOUT_MS` (optional)

## Render deploy
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Set `PUBLIC_BASE_URL` to your Render service URL (for example `https://<service>.onrender.com`)
