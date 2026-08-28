# Agent

Strands agent runtime packaged for Amazon Bedrock AgentCore Runtime. Repository-level architecture
lives in the root [README.md](../README.md).

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Listens on `http://localhost:8080` with `GET /ping` and `POST /invocations`.

| Script | Purpose |
|---|---|
| `npm run build` | Build the runtime bundle |
| `npm run dev` | Build and start the local runtime |
| `npm run invoke:bedrock` | Invoke a *deployed* AgentCore runtime over SigV4 |
| `npm run typecheck` / `test` | `tsc --noEmit` · vitest |

`.env.example` documents every variable; the ones that matter are `AWS_REGION`, `BEDROCK_MODEL_ID`,
and `AGENT_RUNTIME_ARN` for `invoke:bedrock`.

## Tools

Two example tools ship here — `get_current_time` and `get_signed_in_user` — deliberately trivial, so
the wiring is visible and tested. Add yours in [`src/tools.ts`](src/tools.ts) and keep the one rule
they demonstrate:

**No tool takes a user id.** An identity the model can pass is one a prompt can talk it into
changing — "list the notes for user X" is a real attack against a `userId` argument. The BFF prepends
a block naming the caller it authenticated, [`src/caller.ts`](src/caller.ts) parses it off, and a
tool reads it with `currentCaller()`. The schemas the model sees carry no user id, and
`src/__tests__/tools.test.ts` asserts that over the whole toolset.

That is safe because of the *transport*, not the parser: the runtime carries no authorizer config,
so it accepts SigV4 alone and the BFF's role is its only caller. See
[Why the BFF is the only transport](../README.md#why-the-bff-is-the-only-transport).

### A tool that reaches a backend

Register it conditionally on its configuration being present, so a local run with no AWS behind it
offers no tool rather than one that fails on every call. Grant the runtime execution role what it
needs in `AgentStack` — `grantInvoke`, `grantInvokeUrl`, a table read — and let the *service* scope
the query to the caller. A tool argument must never decide whose data comes back.

## Quick checks

```bash
curl http://localhost:8080/ping

curl --location 'http://localhost:8080/invocations' \
  --header 'Content-Type: application/octet-stream' \
  --data "What day of the week is it in São Paulo?"
```

## Docker

Multi-stage build on `node:22-slim`, pinned to match `tsup`'s `node22` target: a `build` stage runs
`npm ci` and `npm run build`, then only `dist/` and production dependencies reach the runtime stage.
`.dockerignore` keeps the build context a function of this package's own sources — without it, any
`npm install` changes the CDK asset hash and forces a full rebuild and push.

```bash
docker build -t agentic-app-agent .
docker run -p 8082:8080 agentic-app-agent
```

For `linux/arm64` build trouble, see the root [README.md](../README.md#root-scripts).
