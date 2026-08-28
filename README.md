# Agentic apps on AWS — Strands Agents on Bedrock AgentCore

A starting point for building an agentic application on AWS: a Strands agent in TypeScript running on
Amazon Bedrock AgentCore Runtime, reached through one pattern — **Frontend → BFF → AgentCore
Runtime** — with authentication, user management, guardrails and infrastructure already in place.

The browser never reaches the runtime. That is a security boundary rather than a layering
preference — see [Why the BFF is the only transport](#why-the-bff-is-the-only-transport).

The domain is deliberately thin. The agent is a general-purpose personal assistant with two example
tools, so what you inherit is the scaffolding, not someone else's product. Replace the system prompt,
add your tools, rebrand two files.

## What this repository includes

* A Strands-based agent running on Amazon Bedrock AgentCore Runtime, with a tested pattern for tools
  that act **for a signed-in user without ever accepting a user id**
* A React chat frontend — streaming replies, Markdown, light UI kit, and full i18n (en-US, pt-BR)
* An AWS Lambda-based BFF: the only transport to the agent, with per-caller rate limiting and
  session ids bound to the authenticated caller
* Amazon Cognito authentication, with public self sign-up or invite-only enrollment behind a single
  env var, optional TOTP two-factor, and localized invitation emails
* An admin panel and API for inviting users and managing access without leaving the browser
* AWS CDK infrastructure for the runtime, auth, hosting and the BFF, with a **deployment-profile
  gate** that refuses to synthesize a pilot still carrying sandbox defaults
* Opt-in operational guardrails: data retention, spend alarms, a budget, request throttling and a WAF

## Prerequisites

Before deploying, make sure you have:

* Node.js 22+
* npm 10+
* Docker with Buildx enabled
* AWS credentials configured for the target account
* Access to Amazon Bedrock AgentCore Runtime
* Access to the model configured by `BEDROCK_MODEL_ID`

## Quick start

### 1. Install dependencies

```bash
npm run bootstrap
```

### 2. Configure infrastructure variables

```bash
cp infra/.env.example infra/.env
```

At minimum, set `PROJECT_NAME` — it prefixes every stack and resource name, so two deployments can
share an account.

### 3. Deploy the stack

```bash
npm run deploy
```

This command deploys the infrastructure through `infra/` and builds the required application
artifacts as part of the deployment flow. For deployment details and environment-specific options,
see [infra/README.md](infra/README.md).

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/poc-strands-agents-bedrock-agentcore-bff-dark.png">
  <img alt="BFF integration architecture" src="media/poc-strands-agents-bedrock-agentcore-bff-light.png">
</picture>

* Browser authenticates with Cognito
* Frontend sends requests to a Lambda-based BFF, carrying its Cognito ID token
* API Gateway's Cognito authorizer validates the token and hands the verified claims to the Lambda
* The BFF invokes AgentCore over SigV4 and re-streams responses to the frontend

The diagram's right-hand side shows where external tool integrations attach; this template ships two
in-process example tools and no external ones.

### Why the BFF is the only transport

The reason generalizes to any agent that acts for a user, so it is worth being explicit.

The agent has no tool that takes a user id — an identity a model can pass is an identity a prompt can
talk it into changing. It learns who is asking from a block the BFF prepends to the prompt, built
from claims the gateway authorizer already verified. But that block is **plain text**: it is only as
trustworthy as whoever could have written it. Give the browser a direct path to the runtime — a
Cognito JWT authorizer on it, and a call to `/runtimes/{arn}/invocations` — and "whoever" becomes the
browser, so anyone who can sign in can type an identity block naming another user's `sub` and have
the agent's tools act for them.

Making the runtime SigV4-only settles that structurally rather than by validation: the BFF's
execution role is the one principal granted `InvokeAgentRuntime`, so the BFF is the only writer of
that block. There is **no Cognito identity pool**, so a signed-in browser holds a user pool token and
no AWS credentials at all — nothing to assume, nothing to escalate.
`infra/src/__tests__/stacks.test.ts` asserts the absence of the pool, of any role federated to
Cognito, and of any `InvokeAgentRuntime` grant, so a direct path cannot appear by accident.

If a tool ever needs a backend to *believe* the caller rather than merely be told, the next step is a
signed assertion: have the BFF mint a short-lived JWS of the caller's `sub` with a KMS key it alone
holds `kms:Sign` on, and have the backend verify it. The transport property above is what makes the
plain-text version sufficient until then.

## Repository structure

```text
agent/               Strands agent runtime, its toolset, and the image build
chatbot-frontend/    React + Vite chat UI, admin panel, UI kit and i18n
chatbot-bff/         Lambda-friendly BFF: the chat proxy and the admin routes
infra/               AWS CDK app for auth, the runtime, the BFF and hosting
```

Additional package documentation:

* [agent/README.md](agent/README.md)
* [chatbot-frontend/README.md](chatbot-frontend/README.md)
* [chatbot-bff/README.md](chatbot-bff/README.md)
* [infra/README.md](infra/README.md)

## Making it yours

| To change | Edit |
|---|---|
| What the agent is and how it behaves | `agent/src/agent.ts` — the system prompt |
| What the agent can do | `agent/src/tools.ts`, plus any IAM grant in `infra/src/stacks/agent-stack.ts` |
| Product name, tagline, icon | `chatbot-frontend/src/lib/brand.ts` |
| Colours and type | `chatbot-frontend/src/styles.css` — every component resolves to a token here |
| Copy, in both languages | `chatbot-frontend/src/lib/i18n/messages/` |
| Stack and resource names | `PROJECT_NAME` in `infra/.env` |

Adding a tool that reaches a backend has one rule worth keeping: **no tool takes a user id**. Read
the caller from `currentCaller()` and let the backend scope the query — see
[agent/README.md](agent/README.md#tools-and-the-rule-they-follow). `agent/src/__tests__/tools.test.ts`
asserts it over the whole toolset, so a tool that breaks it fails the build.

## Configuration

Deploying needs one file: `infra/.env`. Running a component locally needs its own — `agent/.env`,
`chatbot-bff/.env`, `chatbot-frontend/.env` — created from the `.env.example` beside it.

Every variable is documented in the `.env.example` files, which are the source of truth;
[infra/README.md](infra/README.md) covers what the deployment-level ones do to the stacks. Three are
worth knowing before a first deploy:

* `DEPLOY_PROFILE` — `demo` (default), `pilot` or `prod`. It decides what everything else is
  *allowed* to be; see [Deployment profiles](#deployment-profiles)
* `PUBLIC_SIGNUP_ENABLED` — self sign-up (default) vs. invite-only
* `ALLOWED_ORIGIN` — CORS; defaults to `*` because the CloudFront URL does not exist yet on a first
  deploy

## Deployment profiles

The template ships sandbox defaults on purpose — open sign-up, CORS open to everything, no second
factor — each documented as sandbox-only. Documentation is the control that fails here: whoever
copies this repo to run a pilot is not whoever read the comment.

So `DEPLOY_PROFILE=pilot` (or `prod`) turns those notes into a build that refuses. `cdk synth` fails
before a single resource is described, listing every violation at once rather than one failed synth
at a time:

```text
DEPLOY_PROFILE=pilot refuses 3 sandbox defaults:
  - PUBLIC_SIGNUP_ENABLED must be false. Open sign-up lets anyone mint accounts, …
  - ALLOWED_ORIGIN must name the app origin. "*" is the first-deploy default …
  - ALERT_EMAIL is required. The alarms exist either way — without a subscriber …
```

`demo` is deliberately unchecked: making the sandbox nag about production posture would teach exactly
the habit the gate exists to prevent.

## Local development

Start the agent from `agent/`, then the BFF from `chatbot-bff/`, then the frontend from
`chatbot-frontend/`. Each package README has its own commands.

The local BFF (`chatbot-bff` → `npm run dev`) serves `/chat` only, with no token validation and a
fixed caller id — it exists to exercise the streaming path, not the authorization one.

## Root scripts

The root package provides a small set of convenience commands for common workflows.

| Script                       | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `npm run bootstrap`          | Install locked dependencies for the root package and each subpackage (`npm ci`) |
| `npm run install:all`        | Same, but with `npm install` — use when a lockfile needs updating, e.g. after adding a dependency |
| `npm run install:all:fix`    | `install:all`, then `npm audit fix` in the root package and each subpackage (semver-compatible fixes only — no `--force`). Each `audit fix` runs regardless of whether an earlier one still has unresolved findings, so one package short of a full fix never blocks the rest |
| `npm run lint`               | Run repository-wide ESLint checks                                    |
| `npm run typecheck`          | Run `tsc --noEmit` in every subpackage                                |
| `npm run test`               | Run the test suite in every subpackage (vitest)                       |
| `npm run verify`             | `lint` + `typecheck` + `test` — what to run before opening a PR      |
| `npm run audit`              | `npm audit --audit-level=high` in the root package and each subpackage |
| `npm run synth`              | Build deployable artifacts and synthesize the CDK app                |
| `npm run deploy`             | Deploy all infrastructure                                            |
| `npm run destroy`            | Destroy all deployed stacks                                          |
| `npm run docker:setup-arm64` | Enable local ARM64 Docker emulation for agent image builds           |

The audit gate is `high`, not `critical`: a remotely exploitable flaw in a dependency that handles
request bodies is routinely scored high, and a gate that only stops `critical` lets those through
while reporting green. When a finding sits in a transitive tree this repo's own `package.json`
cannot reach — `aws-cdk-lib`'s, typically — the fix is to bump the *parent* once upstream ships a
release that carries it, not to lower the gate.

`npm run install:all:fix` only makes semver-compatible changes, but in `infra/` that still isn't risk-free: `npm audit fix` can bump `aws-cdk-lib` within its declared range to a version whose cloud-assembly schema is newer than the pinned `aws-cdk` CLI can read, and `cdk synth` then fails with a schema-version mismatch even though nothing in `infra/package.json` changed. Run `npm run synth` after using this script and, if it fails that way, either bump `aws-cdk` to the version the error message names or revert `infra/package-lock.json`.

## Testing

Every package uses [vitest](https://vitest.dev), scoped to `environment: 'node'` — no AWS
credentials, no Docker and no browser are needed for `npm test` in any of them.

| Package | Covered |
|---|---|
| `agent/` | Request-body size limits, a drift guard keeping `tsconfig.json`'s inlined options in sync with the repo base (see the note in `agent/src/__tests__/tsconfig.test.ts` for why it can't just `extends` it), the toolset boundary — that no tool accepts a user id, and that the request-scoped caller reaches a tool callback — and the identity block's exact wire format |
| `chatbot-bff/` | CORS/SSE framing, prompt-length validation, session-id binding to the authenticated caller, admin request parsing and claim checks, AgentCore stream-shape normalization, the per-caller quota, and the identity block's wire format from the other side |
| `infra/` | Every env-var/context resolver and the profile gate in `config.ts`, plus synthesized-template assertions (`aws-cdk-lib/assertions`) for the security properties in [Deployment notes](#deployment-notes) — no identity pool, no Cognito-federated role, no stray `InvokeAgentRuntime` grant, a Cognito authorizer on every route, a chat role that holds nothing but what `/chat` needs, an agent scoped to one Bedrock model, and the CSP on the distribution |
| `chatbot-frontend/` | `src/lib/` only: the i18n engine (locale fallback, pluralization, catalog completeness), admin-group membership off a decoded token, SSE stream parsing, the streaming-Markdown repair, TOTP/QR helpers and the auth step machine |

Two deliberate exclusions. `AgentStack` is never synthesized in `infra/`'s suite: it builds a real
Docker image at synth time, which is right for `cdk synth`/`deploy` and wrong for a unit-test run.
And rendered React components are not covered — that needs `@testing-library/react` + `jsdom`, which
none of the `vitest.config.ts` files pull in.

## Deployment notes

The CDK app provisions four stacks in dependency order — `auth`, `agent`, `bff`, `frontend` — each
described in [infra/README.md](infra/README.md#stacks).

One thing that is easy to miss: the frontend receives its runtime configuration through a `config.js`
written at deploy time rather than through a build-time `.env`.

## Which token authenticates the API

The app sends the **ID token**, and the authorizer forces that rather than the app choosing it.

A REST API `COGNITO_USER_POOLS` authorizer decides how to read the token from whether the method
declares authorization scopes:

> *"If the OAuth Scopes option isn't specified, API Gateway treats the supplied token as an identity
> token and verifies the claimed identity against the one from the user pool. Otherwise, API Gateway
> treats the supplied token as an access token and verifies the access scopes."*
> — [Integrate a REST API with an Amazon Cognito user pool](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html)

No method here declares scopes, so an access token is rejected with `401` and never reaches the BFF.
An access token is the OAuth-correct credential for an API, and accepting one would need a resource
server with a custom scope on every method — which this app cannot get from SRP sign-in without a
pre-token-generation trigger, making every API call depend on a Lambda succeeding. The full reasoning,
including why the exposure that OAuth rule guards against does not arise here, sits next to the
authorizer in [`infra/src/stacks/bff-stack.ts`](infra/src/stacks/bff-stack.ts). A Lambda authorizer
verifying the JWT directly is the path if that ever stops being true.

## Troubleshooting

### Docker ARM64 build fails with `exec format error`

If the agent image build fails during deployment, run:

```bash
cd infra
npm run docker:setup-arm64
```

Then retry:

```bash
cd ..
npm run deploy
```

## Production readiness

This is a template, not a finished product. What it gives you is a deployment whose security posture
is asserted by tests rather than described in a document: one transport to the agent, no browser-held
AWS credentials, a chat role with two permissions, a model-scoped agent, per-caller quotas, and a
synth that refuses a mispostured pilot.

What it does not give you is anything about *your* domain. Before a pilot with real users, at
minimum: set `DEPLOY_PROFILE=pilot` and fix what it refuses, pin `DEPLOY_ACCOUNT`/`DEPLOY_REGION`,
turn on `WAF_ENABLED`, and decide what your tools are allowed to reach.

Two things this template deliberately leaves open, because the right answer depends on the
application:

* **Conversation history lives in the container's memory** (`agent/src/index.ts`), keyed by AgentCore
  session id and evicted after 30 minutes. It is lost on restart and not shared across replicas.
  A durable deployment should swap in the Strands SDK's `SessionManager` over a persistent store.
* **There is no data layer.** [infra/README.md](infra/README.md#where-a-data-layer-goes) covers where
  one goes and the two grant rules to follow when adding it.
