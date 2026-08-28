# Chatbot BFF

The Lambda Backend-for-Frontend: it accepts chat requests, invokes AgentCore over SigV4 and
re-streams the result, and serves the admin API. Repository-level architecture lives in the root
[README.md](../README.md).

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The local server listens on `http://localhost:3001/chat` and re-streams AgentCore events as SSE. It
serves `/chat` only, with no token validation and a fixed caller id — it exercises the streaming
path, not the authorization one.

| Script | Purpose |
|---|---|
| `npm run build` | Build the Lambda bundles |
| `npm run dev` | Start the local streaming proxy |
| `npm run typecheck` / `test` | `tsc --noEmit` · vitest |

`.env.example` covers what local dev needs. The admin and rate-limit variables are set on the
deployed Lambdas by `infra/src/stacks/bff-stack.ts` and are absent from it on purpose: `local.ts` has
no admin routes to exercise and no DynamoDB table to point at.

## What it guarantees

- **It is the only transport to the agent.** It prepends a block naming the caller it authenticated
  (`withSessionContext` in [`src/session-context.ts`](src/session-context.ts)), built from claims the
  gateway authorizer already verified — that is how the agent's tools act for a user without any tool
  accepting a user id. The wire format is a contract with `agent/src/caller.ts`, asserted literally
  on both sides because the packages cannot share it by import.
- **Session ids are namespaced to the caller's `sub`** ([`src/session.ts`](src/session.ts)). A
  client-supplied id is honoured only if it carries *that* caller's namespace. A session id is a
  bearer token for AgentCore conversation history, so without this any signed-in user could replay
  another's.
- **`/chat` is metered per caller** ([`src/rate-limit.ts`](src/rate-limit.ts)): a fixed window keyed
  by `sub`, in a DynamoDB table of disposable counters. `API_RATE_LIMIT` bounds the account; this
  bounds one caller within it. Exceeding it returns an `error` SSE event with `retryAfterSeconds`.

## Admin routes

A second Lambda (`admin-handler.ts`) serves `GET`/`POST /admin/users`, so the chat function never
holds `cognito-idp:AdminCreate*`. That split is the shape to copy when this template grows a route
that can do something consequential: give it its own function and leave the chat role alone.

The gateway's authorizer validates the token; the handler re-checks the `cognito:groups` claim itself
and returns `403` outside the admin group. Every call — allowed, denied or errored — emits one
structured audit line. `POST` takes an optional `locale`, written to `custom:inviteLocale` so the
invite email matches. Errors are `{ code, error }`: `code` is a stable `ErrorCode` the frontend
localizes, `error` the English fallback for a client that never reached one.

## Build output

`npm run build` emits `dist/handler.handler` (chat) and `dist/admin-handler.handler` (admin), both
bundled **self-contained** (`noExternal`). The CDK asset ships this package with `node_modules`
excluded, so anything left external would be a bet on what the managed runtime happens to provide —
a bet that fails at cold start when it is wrong, and that pins the SDK version to whatever AWS
shipped rather than the one these handlers were tested against.
