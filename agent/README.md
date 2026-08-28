# Agent

Strands agent runtime packaged for Amazon Bedrock AgentCore Runtime.

This package owns the runtime HTTP surface, tool wiring, and local invoke helper. Repository-level architecture and deployment context live in the root [README.md](../README.md).

## Local setup

```bash
npm install
cp .env.example .env
```

Start the agent runtime:

```bash
npm run dev
```

The local runtime listens on `http://localhost:8080` and exposes:

- `GET /ping`
- `POST /invocations`

## Useful scripts

| Script | Purpose |
|---|---|
| `npm run build` | Build the runtime bundle |
| `npm run dev` | Build and start the local runtime |
| `npm run invoke:bedrock` | Invoke a deployed AgentCore runtime |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test` | Run the test suite (vitest) |

## Environment variables

Use [agent/.env.example](.env.example) as the source of truth. The most important variables are:

| Variable | Required | Purpose |
|---|---|---|
| `AWS_REGION` | Yes | AWS region for Bedrock and runtime behavior |
| `BEDROCK_MODEL_ID` | Yes | Model used by the Strands agent |
| `AGENT_RUNTIME_ARN` | For `invoke:bedrock` | Target deployed runtime ARN |
| `MERCHANT_URL`, `CONSENT_URL`, `CP_URL` | For AP2 | The AP2 entity Function URLs. The checkout tools register only when **all three** are present |

## AP2 checkout tools

When the three entity URLs are configured, the agent gains four tools — registered conditionally, so
a local run with no AWS behind it offers none rather than offering tools that fail on every call.

The four are `search_products`, `create_merchant_cart`, `list_payment_methods` and
`initiate_consent_session`. What is **absent** is the design: no tool signs a mandate, issues a
credential or starts a payment — those happen in the BFF behind a human approval the agent never
sees. It is not instructed to avoid moving money; it has no way to.

The separation holds at the IAM layer too: the runtime role gets `InvokeFunctionUrl` on the Merchant,
Consent and Credential Provider only, and the payment processor is reachable by the Merchant alone.

**Identity is never a tool parameter.** An identity the model can pass is one a prompt can talk it
into changing — "list the payment methods for user X" is a real attack against a `userId` argument.
The BFF prepends a block naming the caller it authenticated,
[`src/tools/ap2/caller.ts`](src/tools/ap2/caller.ts) parses it off, and the tools read it from the
request's async context. The schemas the model sees carry no user id.

The agent uses its own small SigV4 client rather than `ap2-core`'s: this package's Docker build
context is its own directory, so a `file:` dependency does not resolve at image build time — and a
propose-only agent has no business carrying the signing domain anyway.

See [docs/ap2-architecture.md](../docs/ap2-architecture.md) §4 for where this sits in the flow.

## Quick checks

Health check:

```bash
curl http://localhost:8080/ping
```

Invoke the local runtime:

```bash
curl --location 'http://localhost:8080/invocations' \
  --header 'Content-Type: application/octet-stream' \
  --data "What's on the menu that's high in protein and arrives in under 20 minutes?"
```

## Docker

Multi-stage build on `node:22-slim`, pinned to match `tsup`'s `node22` target: a `build` stage runs
`npm ci` and `npm run build`, then only `dist/` and production dependencies land in the `runtime`
stage. `.dockerignore` keeps the context a function of the agent's own sources — without it any
`npm install` changes the CDK asset hash and forces a full rebuild and push.

Build the image:

```bash
docker build -t poc-strands-agents-ts .
```

Run the container:

```bash
docker run -p 8082:8080 poc-strands-agents-ts
```

For cross-platform `linux/arm64` build troubleshooting, use the root [README.md](../README.md#troubleshooting).
