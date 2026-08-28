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

The admin, rate-limit and AP2 variables are set on the deployed Lambdas by `bff-stack.ts` and are
absent from `.env.example` on purpose: `local.ts` only serves `/chat`, so it has no admin routes to
exercise and no DynamoDB table to point at — the rate-limit check is skipped when
`RATE_LIMIT_TABLE_NAME` is unset.

## Behavior notes

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

## AP2 checkout routes

A third Lambda (`ap2-handler.ts`) serves the half of the AP2 flow the agent is deliberately excluded
from:

| Route | Purpose |
|---|---|
| `POST /intent` | Opens the approval gate over a consent session the agent proposed |
| `POST /confirm` | Verifies the approval, has both mandates signed, and settles the chain |
| `POST /decline` | Closes a proposed checkout without paying |
| `GET /journeys` | The caller's own checkouts |
| `GET /evidence/{journeyId}` | The signed accountability trail for one checkout |
| `GET /actors` | The four signing actors and their public keys |

Separate for a sharper version of the admin routes' reason: this is the only role holding the HMAC
secret, `sns:Publish` and invoke rights on the AP2 entities. Keeping those off the chat role is what
makes "the agent cannot move money" structural, and `infra`'s tests fail if it ever gains them.

Two properties carry the gate, both unit-tested in [`src/ap2/intent.ts`](src/ap2/intent.ts):

- **An approval is HMAC-sealed** to one session, cart, amount and user. A one-time code proves
  someone is present, not what they agreed to — without the seal, a code minted for a small cart
  would authorize a large one.
- **The step-up decision is re-derived at `/confirm` from the sealed amount**, so a client cannot
  downgrade a high-value checkout to the one-tap path by flipping a flag. An unparseable threshold
  errs toward more friction, because defaulting to "no code required" is the one direction nobody
  would notice.

Identity comes from the gateway authorizer's verified claims, the same as the admin routes, and fails
closed when they are absent. That only holds if no route reaches the handler unauthenticated, so
`infra`'s tests assert every checkout route carries the authorizer.

The checkout role can `Query` the evidence log and nothing more: the surface that displays the audit
trail must not be able to alter it.

Its environment (`INTENTS_TABLE`, `EVIDENCE_TABLE`, `HMAC_SECRET_ARN`, the entity URLs, the KMS key
ARNs and the checkout policy) is set by `bff-stack.ts` and is not part of `.env.example`, for the
same reason as the admin variables: `local.ts` only exercises `/chat`.

## Lambda build output

```bash
npm run build
```

Three handler entry points are produced: `dist/handler.handler` (chat),
`dist/admin-handler.handler` (admin routes) and `dist/ap2-handler.handler` (AP2 checkout).

The build emits **two bundles**, because the handlers need opposite treatment. The chat and admin
handlers keep dependencies external — everything they import is an AWS SDK client the managed runtime
provides, and the CDK asset excludes `node_modules`. The AP2 handler pulls in `ap2-core`, JOSE,
SD-JWT and the JSON canonicalizer, none of which the runtime ships, so it is bundled self-contained.
