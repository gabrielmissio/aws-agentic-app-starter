# Agentic payments on AWS — Strands Agents, Bedrock AgentCore and AP2

A reference repository for two things that fit together: deploying Strands Agents in TypeScript on
Amazon Bedrock AgentCore Runtime, and letting such an agent complete a purchase under the **Agent
Payments Protocol (AP2)** without ever holding payment data or approving on the user's behalf.

One pattern for the conversation — **Frontend → BFF → AgentCore Runtime** — and one for the money:
the agent **proposes**, the human **authorizes**, the infrastructure **settles**, each step producing
a signed artifact the next party re-verifies. The browser never reaches the runtime, which is a
security boundary rather than a layering preference — see
[Why the BFF is the only transport](#why-the-bff-is-the-only-transport).

## What this repository includes

* A Strands-based agent running on Amazon Bedrock AgentCore Runtime
* **AP2 end to end**: five verifying entities, a signed and hash-chained credential chain, a
  human-present approval gate, and an explorer that shows the mandates, the signatures and the
  authorization chain
* A React chatbot frontend
* An AWS Lambda-based BFF — the only transport to the agent, and the surface that gates payment
* Amazon Cognito authentication for browser access, with public self sign-up or invite-only enrollment controlled by a single env var
* An admin panel and API for inviting users and managing access without leaving the browser
* AWS CDK infrastructure for runtime, auth, frontend hosting, BFF and the AP2 entities, with opt-in operational guardrails (data retention, spend alarms, request throttling)

## AP2 in one screen

An agent that buys on your behalf cannot simply be trusted: it is non-deterministic, and part of what
it reads is attacker-controlled. AP2 moves the trust into the infrastructure — every party signs a
credential the next party checks.

```text
Cart Mandate → Checkout Mandate → Payment Mandate → Payment Credential → Payment Receipt
   merchant         you              you                provider            processor
```

The agent has four tools: search the menu, ask the merchant to sign a cart, list opaque payment
references, and open a consent session. It has **no tool** that signs a mandate, issues a credential
or starts a payment — enforced by its toolset and by IAM, not by its prompt. The approval happens in
the browser through the BFF, behind a code the agent never sees.

If anything is tampered with, expired, reused or out of scope, the chain blocks the payment with a
typed reason (`TAMPERED`, `EXPIRED`, `DOUBLE_SPEND`, `OUT_OF_SCOPE`, …) and a **signed** rejection
receipt. Every one of those paths has a test.

Read next:

* **[docs/ap2-architecture.md](docs/ap2-architecture.md)** — the components, the signed chain,
  where the human fits, and the AWS mapping.
* **[docs/ap2-conformance.md](docs/ap2-conformance.md)** — what is machine-checked against the
  specification, what diverges deliberately, and what is not built.
* **[ap2-core/README.md](ap2-core/README.md)** — the domain itself.

### Trying it

The whole chain — including every way it refuses — runs offline, with no AWS account, no Docker and
no network:

```bash
npm --prefix ./ap2-core test
```

Deploying needs no transport decision: the runtime is SigV4-only and the BFF is its single caller.

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

### 3. Deploy the stack

```bash
npm run deploy
```

This command deploys the infrastructure through `infra/` and builds the required application artifacts as part of the deployment flow.

### 4. Seed the catalog

```bash
npm run seed
```

Once, after the first deploy: the agent has nothing to search until the AP2 catalog exists. It reads
`PROJECT_NAME` from `infra/.env` and derives the table names automatically.

For deployment details and environment-specific options, see [infra/README.md](infra/README.md).

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/poc-strands-agents-bedrock-agentcore-bff-dark.png">
  <img alt="BFF integration architecture" src="media/poc-strands-agents-bedrock-agentcore-bff-light.png">
</picture>

* Browser authenticates with Cognito
* Frontend sends requests to a Lambda-based BFF, carrying its Cognito token
* API Gateway's Cognito authorizer validates the token and hands the verified claims to the Lambda
* The BFF invokes AgentCore over SigV4 and re-streams responses to the frontend

### Why the BFF is the only transport

The reason generalizes to any agent that acts for a user, so it is worth being explicit.

The agent has no tool that takes a user id — an identity a model can pass is an identity a prompt can
talk it into changing. It learns who is asking from a block the BFF prepends to the prompt, built
from claims the gateway authorizer already verified. But that block is **plain text**: it is only as
trustworthy as whoever could have written it. Give the browser a direct path to the runtime — a
Cognito JWT authorizer on it, and a call to `/runtimes/{arn}/invocations` — and "whoever" becomes the
browser, so anyone who can sign in can type an identity block naming another user's `sub` and have
the agent's payment tools act for them.

So the block carries a second, **signed** half. The BFF mints a short-lived JWS asserting the
caller's `sub`, using a KMS key it alone holds `kms:Sign` on; the Merchant, the consent surface and
the Credential Provider verify it and read the user out of it, and refuse a call that arrives
without one. What an entity believes about the caller therefore rests on a signature the agent
cannot produce, not on who could have written a line of text. The token is stripped off with the
rest of the block before the prompt reaches the model, so no injected instruction can read it out.

Making the runtime SigV4-only settles the other half structurally rather than by validation: the
BFF's execution role is the one principal granted `InvokeAgentRuntime`, so the BFF is the only
writer of that block. There is **no Cognito identity pool**, so a signed-in browser holds a user
pool token and no AWS credentials at all — nothing to assume, nothing to escalate.
`infra/src/__tests__/stacks.test.ts` asserts the absence of the pool, of any role federated to
Cognito, and of any `InvokeAgentRuntime` grant, so a direct path cannot appear by accident.

## Repository structure

```text
ap2-core/            The AP2 domain: signed artifacts, the five verifying entities, AWS adapters
agent/               Strands agent runtime, its propose-only AP2 toolset, and the image build
chatbot-frontend/    React + Vite chatbot UI, the checkout card, and the proof explorer
chatbot-bff/         Lambda-friendly BFF: chat proxy, admin routes, and the AP2 checkout flow
infra/               AWS CDK app for data, keys, the AP2 entities, runtime, auth, BFF and hosting
docs/                AP2 architecture and conformance
```

Additional package documentation:

* [ap2-core/README.md](ap2-core/README.md)
* [agent/README.md](agent/README.md)
* [chatbot-frontend/README.md](chatbot-frontend/README.md)
* [chatbot-bff/README.md](chatbot-bff/README.md)
* [infra/README.md](infra/README.md)

## Configuration

Deploying needs one file: `infra/.env`. Running a component locally needs its own — `agent/.env`,
`chatbot-bff/.env`, `chatbot-frontend/.env` — created from the `.env.example` beside it.

Every variable is documented in the `.env.example` files, which are the source of truth;
[infra/README.md](infra/README.md) covers what the deployment-level ones do to the stacks. Four are
worth knowing before a first deploy:

* `PUBLIC_SIGNUP_ENABLED` — self sign-up (default) vs. invite-only
* `ALLOWED_ORIGIN` — CORS; defaults to `*` because the CloudFront URL does not exist yet on a first deploy
* `OTP_STEPUP_THRESHOLD_CENTS` — the cart total at or above which checkout requires a one-time code
* `OTP_REVEAL_IN_UI` — sandbox only, returns the real code in the response. Never enable it for real

## Local development

Start the agent from `agent/`, then the BFF from `chatbot-bff/`, then the frontend from
`chatbot-frontend/`. Each package README has its own commands.

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
| `npm run audit`              | `npm audit --audit-level=critical` in the root package and each subpackage — see the note below |
| `npm run synth`              | Build deployable artifacts and synthesize the CDK app                |
| `npm run deploy`             | Deploy all infrastructure                                            |
| `npm run destroy`            | Destroy all deployed stacks                                          |
| `npm run seed`               | Seed the AP2 catalog into DynamoDB — run once after the first deploy  |
| `npm run docker:setup-arm64` | Enable local ARM64 Docker emulation for agent image builds           |

`npm run install:all:fix` only makes semver-compatible changes, but in `infra/` that still isn't risk-free: `npm audit fix` can bump `aws-cdk-lib` within its declared range to a version whose cloud-assembly schema is newer than the pinned `aws-cdk` CLI can read, and `cdk synth` then fails with a schema-version mismatch even though nothing in `infra/package.json` changed. Run `npm run synth` after using this script and, if it fails that way, either bump `aws-cdk` to the version the error message names or revert `infra/package-lock.json`.

`npm run audit` gates on `critical` rather than `high` because the transitive trees of `aws-cdk-lib`, `vitest`, `tsup` and `tsx` regularly carry findings that reach no deployed artifact and are not fixable from this repo's own `package.json`. Gating on `critical` keeps CI red only for things this repository can act on; re-run `npm audit` with no `--audit-level` periodically to see the full picture and re-tighten the gate if you can.

## Testing

Every package uses [vitest](https://vitest.dev), scoped to `environment: 'node'` — no AWS
credentials, no Docker and no browser are needed for `npm test` in any of them.

| Package | Covered |
|---|---|
| `ap2-core/` | The whole signed chain against in-memory adapters and a real ES256 signer: the happy path and every way it refuses (`TAMPERED`, `EXPIRED`, `REPLAYED`, `DOUBLE_SPEND`, `OUT_OF_SCOPE`, `INVALID_MANDATE`), the JWS and SD-JWT layers, the DER↔JOSE signature bridge, the request envelope, the logger's redaction rules, and a conformance suite validating every emitted artifact against the AP2 JSON Schemas — which is what makes "AP2-conformant" a checked property rather than a claim |
| `agent/` | Request-body size limits, a drift guard keeping `tsconfig.json`'s inlined options in sync with the repo base (see the note in `agent/src/__tests__/tsconfig.test.ts` for why it can't just `extends` it), and the AP2 boundary: that the toolset contains nothing which could move money, that no tool accepts a user id, and that the request-scoped caller reaches a tool callback |
| `chatbot-bff/` | CORS/SSE framing, prompt-length validation, session-id binding to the authenticated caller, admin request parsing and claim checks, AgentCore stream-shape normalization, and the checkout gate: that an approval sealed to one cart cannot be replayed against another, that the step-up decision cannot be downgraded by a client, and that only the exact money-moving routes are recognized |
| `infra/` | Every env-var/context resolver in `config.ts`, plus synthesized-template assertions (`aws-cdk-lib/assertions`) for the security properties in [Deployment notes](#deployment-notes) and [docs/ap2-architecture.md](docs/ap2-architecture.md) §6 — no public entity URL, one signing key per entity, an append-only evidence log, a chat function that can reach neither the HMAC secret nor an entity, a single Mandate Authority signer, point-in-time recovery on every table, and a Cognito authorizer on every checkout route |
| `chatbot-frontend/` | `src/lib/` only: the i18n engine (locale fallback, pluralization, catalog completeness), admin-group membership off a decoded token, SSE stream parsing, and the AP2 presentation logic — journey status, timeline grouping, formatting, and the tool-result shapes consent-session detection has to survive across SDK versions |

Two deliberate exclusions. `AgentStack` is never synthesized in `infra/`'s suite: it builds a real
Docker image at synth time, which is right for `cdk synth`/`deploy` and wrong for a unit-test run.
And rendered React components are not covered — that needs `@testing-library/react` + `jsdom`, which
none of the `vitest.config.ts` files pull in.

## Deployment notes

The CDK app provisions seven stacks in dependency order — `data`, `security`, `auth`, `ap2`, `agent`,
`bff`, `frontend` — each described in [infra/README.md](infra/README.md#stacks), along with why the
AP2 resources are shaped the way they are.

Two things that are easy to miss: `npm run seed` is needed once after the first deploy or the agent
has an empty catalog, and the frontend receives its runtime configuration through a `config.js`
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

This repository is a reference implementation, not a production-ready template. It moves no real
money: the payment processor is simulated.

An independent security and architecture review is checked in as [assessment.md](docs/assessments/assessment.md).
Where the template stands against three uses:

| Use | Verdict | What decides it |
|---|---|---|
| **Demos** | `GO` | Set `PUBLIC_SIGNUP_ENABLED=false` and `ALLOWED_ORIGIN`, pick a step-up path, use a disposable account |
| **Controlled pilots with sensitive data** | `CONDITIONAL GO` | No critical or high finding is open. What remains is scope, not defect: a step-up channel that proves possession, a real processor, and Cognito MFA |
| **Public production** | `NO-GO` | Simulated processor, no key rotation, no dispute flow, no WAF, and one organization operating every AP2 role |

No AP2 MUST is currently unmet — [docs/ap2-conformance.md](docs/ap2-conformance.md) §2 scores them
one by one, and §3 lists the ten divergences that are deliberate, including the serialization
envelope that is the one thing blocking interoperability with a third-party AP2 implementation.

## Usage guidance

Use this repository as:

* a reference for AgentCore integration patterns
* a reference for what an agent-driven payment looks like when the trust lives in the
  infrastructure rather than in the agent
* a starting point for an internal hardened template
