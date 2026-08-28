# Chatbot BFF

Thin Backend-for-Frontend that accepts chat requests and invokes AgentCore with SigV4, plus an admin API for user management.

This package owns the streaming proxy layer used by the chatbot application, and the server-side half of the admin panel. Repository-level architecture and deployment context live in the root [README.md](../README.md).

## Local setup

```bash
npm install
cp .env.example .env
```

Start the local development server:

```bash
npm run dev
```

The local server listens on `http://localhost:3001/chat` and re-streams AgentCore events as SSE.

## Useful scripts

| Script | Purpose |
|---|---|
| `npm run build` | Build the Lambda bundle |
| `npm run dev` | Start the local streaming proxy |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test` | Run the test suite (vitest) |

## Environment variables

Use [chatbot-bff/.env.example](.env.example) as the source of truth.

| Variable | Required | Purpose |
|---|---|---|
| `AWS_REGION` | No | AWS region for the AgentCore client |
| `ALLOWED_ORIGIN` | No | Allowed browser origin for CORS. Only read here for local dev (`local.ts`); in the deployed path it's set on both Lambdas by `infra/src/stacks/bff-stack.ts` from the infra-level `ALLOWED_ORIGIN` — see [infra/README.md](../infra/README.md#guardrails) |
| `AGENT_RUNTIME_ARN` | Yes | Target Bedrock AgentCore runtime ARN |

The admin and rate-limit variables are set on the deployed Lambdas by `bff-stack.ts` and are absent
from `.env.example` on purpose: `local.ts` only serves `/chat`, so it has no admin routes to
exercise and no DynamoDB table to point at — the rate-limit check is skipped when
`RATE_LIMIT_TABLE_NAME` is unset.

## Behavior notes

- **The BFF is the only transport to the agent, and that is a security boundary.** It prepends a
  block naming the caller it authenticated (`withSessionContext` in
  [`src/session-context.ts`](src/session-context.ts)), built from claims the gateway authorizer
  already verified — which is how the agent's tools act for a user without any tool accepting a
  user id. The block is plain text, so it is only as trustworthy as whoever could have written it;
  the runtime accepts SigV4 alone and this function's role is its one caller. The wire format is a
  contract with `agent/src/caller.ts`, asserted literally on both sides.
- The BFF invokes AgentCore with SigV4 from the credentials available to the process or function. In
  the deployed path Cognito protects `/chat` at API Gateway; the local server does no token
  validation of its own and exists to exercise the streaming proxy.
- **Session ids are namespaced to the caller's Cognito `sub`** (`resolveSessionId` in
  [`src/session.ts`](src/session.ts)). A client-supplied id is reused only if it carries *that
  caller's* namespace; otherwise a fresh one is minted silently. A session id is a bearer token for
  AgentCore conversation history, so without this any authenticated user could replay another's.
- **`/chat` caps how often one caller invokes the agent** (`checkRateLimit` in
  [`src/rate-limit.ts`](src/rate-limit.ts)): a fixed window keyed by `sub`, in the DynamoDB table
  `bff-stack.ts` provisions. `API_RATE_LIMIT` bounds the account; this bounds one caller within it.
  Exceeding it returns an `error` SSE event with `retryAfterSeconds` rather than a hard failure.

## Admin routes

A second Lambda (`admin-handler.ts`) serves `GET`/`POST /admin/users`, so the chat function never
holds `cognito-idp:AdminCreate*`. The gateway's authorizer validates the token; the handler re-checks
the `cognito:groups` claim itself and returns `403` outside the admin group. Every call — allowed,
denied or errored — emits one structured audit line (`auditRecord` in `admin.ts`).

`POST /admin/users` takes an optional `locale`, written to `custom:inviteLocale` for the
CustomMessage trigger to read (see [infra/README.md](../infra/README.md#emails)). Errors are
`{ code, error }`: `code` is a stable `ErrorCode` the frontend localizes, `error` the English
fallback for a client that never reached one — a 403 from the authorizer, say.

## Lambda build output

```bash
npm run build
```

Two handler entry points are produced: `dist/handler.handler` (chat) and
`dist/admin-handler.handler` (admin routes).

Both are bundled **self-contained** (`noExternal` in `tsup.config.ts`). The CDK asset ships this
package with `node_modules` excluded, so anything left external would have to be something the
managed Node runtime happens to provide — a bet that fails at cold start when it is wrong, and that
silently pins the SDK version to whatever AWS shipped rather than the one these handlers were tested
against.
