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

## Tools, and the rule they follow

The agent ships two deliberately trivial tools — `get_current_time` and `get_signed_in_user`. They
exist so the wiring is visible and tested, not because a personal assistant needs nothing else.
Add yours in [`src/tools.ts`](src/tools.ts), and keep the one rule they demonstrate:

**Identity is never a tool parameter.** An identity the model can pass is one a prompt can talk it
into changing — "list the notes for user X" is a real attack against a `userId` argument. The BFF
prepends a block naming the caller it authenticated, [`src/caller.ts`](src/caller.ts) parses it off,
and a tool reads it from the request's async context with `currentCaller()`. The schemas the model
sees carry no user id, and `src/__tests__/tools.test.ts` asserts that over the whole toolset.

`caller.ts` is safe because of the *transport*, not because of the parser. The runtime carries no
authorizer configuration, so it accepts SigV4 alone and the BFF's execution role is its only caller
(see [`infra/src/stacks/agent-stack.ts`](../infra/src/stacks/agent-stack.ts)). Give the browser a
direct path and the identity block becomes text the browser composed.

### Adding a tool that reaches a backend

Register it conditionally on its configuration being present, so a local run with no AWS behind it
offers no tool rather than one that fails on every call. Grant the runtime execution role what it
needs in `AgentStack` — `grantInvoke`, `grantInvokeUrl`, a table read — and let the *service* scope
the query to the caller. A tool argument must never be what decides whose data comes back.

## Quick checks

Health check:

```bash
curl http://localhost:8080/ping
```

Invoke the local runtime:

```bash
curl --location 'http://localhost:8080/invocations' \
  --header 'Content-Type: application/octet-stream' \
  --data "What day of the week is it in São Paulo?"
```

## Docker

Multi-stage build on `node:22-slim`, pinned to match `tsup`'s `node22` target: a `build` stage runs
`npm ci` and `npm run build`, then only `dist/` and production dependencies land in the `runtime`
stage. `.dockerignore` keeps the context a function of the agent's own sources — without it any
`npm install` changes the CDK asset hash and forces a full rebuild and push.

Build the image:

```bash
docker build -t agentic-app-agent .
```

Run the container:

```bash
docker run -p 8082:8080 agentic-app-agent
```

For cross-platform `linux/arm64` build troubleshooting, use the root [README.md](../README.md#troubleshooting).
