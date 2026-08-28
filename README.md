# Agentic apps on AWS — Strands Agents on Bedrock AgentCore

A starting point for an agentic application on AWS: a Strands agent in TypeScript on Amazon Bedrock
AgentCore Runtime, reached through one pattern — **Frontend → BFF → AgentCore Runtime** — with
authentication, user management, guardrails and infrastructure already in place.

The domain is deliberately thin. The agent is a general-purpose personal assistant with two example
tools, so what you inherit is the scaffolding, not someone else's product.

## What you get

* A Strands agent on AgentCore Runtime, with a tested pattern for tools that act **for a signed-in
  user without ever accepting a user id**
* A React chat frontend — streaming replies, Markdown, a small UI kit, i18n (en-US, pt-BR)
* A Lambda BFF: the only transport to the agent, with per-caller rate limiting and session ids bound
  to the authenticated caller
* Cognito auth — self sign-up or invite-only behind one env var, optional TOTP, localized emails —
  plus an admin panel for inviting users from the browser
* CDK infrastructure for all of it, with a **deployment-profile gate** that refuses to synthesize a
  pilot still carrying sandbox defaults
* Opt-in guardrails: data retention, alarms, a budget, request throttling, WAF

## Quick start

Needs Node 22+, npm 10+, Docker with Buildx, AWS credentials, and access to AgentCore Runtime and to
the model in `BEDROCK_MODEL_ID`.

```bash
npm run bootstrap
cp infra/.env.example infra/.env   # set PROJECT_NAME — it prefixes every resource
npm run deploy
```

`deploy` builds the app artifacts and deploys the four stacks. See
[infra/README.md](infra/README.md) for what each variable does.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/poc-strands-agents-bedrock-agentcore-bff-dark.png">
  <img alt="BFF integration architecture" src="media/poc-strands-agents-bedrock-agentcore-bff-light.png">
</picture>

The browser authenticates with Cognito and posts to the BFF with its ID token; API Gateway's Cognito
authorizer validates it and hands the verified claims to the Lambda; the BFF invokes AgentCore over
SigV4 and re-streams the response. (The diagram's right-hand side shows where external tool
integrations attach — this template ships two in-process ones and no external ones.)

### Why the BFF is the only transport

This generalizes to any agent that acts for a user, so it is worth stating once.

No tool takes a user id — an identity a model can pass is one a prompt can talk it into changing.
The agent learns who is asking from a block the BFF prepends to the prompt, built from claims the
authorizer already verified. That block is **plain text**, so it is only as trustworthy as whoever
could have written it. The runtime therefore carries no authorizer configuration: it accepts SigV4
alone, the BFF's role is the only principal granted `InvokeAgentRuntime`, and there is no Cognito
identity pool, so a signed-in browser holds a token and no AWS credentials at all.

Give the browser a direct path and that block becomes a request body any signed-in user can compose.
`infra/src/__tests__/stacks.test.ts` asserts the pool is absent, that no role is federated to
Cognito, and that nothing else grants `InvokeAgentRuntime`, so it cannot happen by accident.

## Repository structure

```text
agent/               Strands agent runtime, its toolset, and the image build
chatbot-frontend/    React + Vite chat UI, admin panel, UI kit and i18n
chatbot-bff/         Lambda BFF: the chat proxy and the admin routes
infra/               AWS CDK app for auth, the runtime, the BFF and hosting
```

Each has its own README: [agent](agent/README.md) · [frontend](chatbot-frontend/README.md) ·
[bff](chatbot-bff/README.md) · [infra](infra/README.md).

## Making it yours

| To change | Edit |
|---|---|
| What the agent is and how it behaves | `agent/src/agent.ts` — the system prompt |
| What the agent can do | `agent/src/tools.ts`, plus any IAM grant in `infra/src/stacks/agent-stack.ts` |
| Product name, tagline, icon | `chatbot-frontend/src/lib/brand.ts` |
| Colours and type | `chatbot-frontend/src/styles.css` — every component resolves to a token here |
| Copy, in both languages | `chatbot-frontend/src/lib/i18n/messages/` |
| Stack and resource names | `PROJECT_NAME` in `infra/.env` |

Adding a tool keeps one rule: **no tool takes a user id.** Read the caller from `currentCaller()`
and let the backend scope the query — see [agent/README.md](agent/README.md#tools). It is asserted
over the whole toolset, so a tool that breaks it fails the build.

## Configuration

Deploying needs `infra/.env`. Running a component locally needs its own — `agent/.env`,
`chatbot-bff/.env`, `chatbot-frontend/.env` — copied from the `.env.example` beside it. Those files
are the source of truth for every variable.

Three are worth knowing before a first deploy: `DEPLOY_PROFILE` (below), `PUBLIC_SIGNUP_ENABLED`
(self sign-up vs. invite-only), and `ALLOWED_ORIGIN` (CORS, open by default because the CloudFront
URL does not exist yet on a first deploy).

### Deployment profiles

The template ships sandbox defaults on purpose — open sign-up, open CORS, no second factor — each
documented as sandbox-only. Documentation is the control that fails here: whoever copies this repo
to run a pilot is not whoever read the comment.

So `DEPLOY_PROFILE=pilot` (or `prod`) turns those notes into a build that refuses. `cdk synth` fails
before a resource is described, naming every violation at once:

```text
DEPLOY_PROFILE=pilot refuses 3 sandbox defaults:
  - PUBLIC_SIGNUP_ENABLED must be false. Open sign-up lets anyone mint accounts, …
  - ALLOWED_ORIGIN must name the app origin. "*" is the first-deploy default …
  - ALERT_EMAIL is required. The alarms exist either way — without a subscriber …
```

`demo` is unchecked on purpose: making the sandbox nag about production posture teaches exactly the
habit the gate exists to prevent.

## Local development

Start the agent from `agent/`, then the BFF from `chatbot-bff/`, then the frontend from
`chatbot-frontend/` — commands are in each README. The local BFF serves `/chat` only, with no token
validation and a fixed caller id: it exercises the streaming path, not the authorization one.

## Root scripts

| Script | Purpose |
|---|---|
| `npm run bootstrap` | `npm ci` in the root package and every subpackage |
| `npm run install:all` | The same with `npm install` — when a lockfile needs updating |
| `npm run install:all:fix` | `install:all`, then `npm audit fix` everywhere (semver-compatible only) |
| `npm run lint` / `typecheck` / `test` | ESLint · `tsc --noEmit` · vitest, across every package |
| `npm run verify` | All three — what to run before opening a PR |
| `npm run audit` | `npm audit --audit-level=high` in every package |
| `npm run synth` | Build artifacts and synthesize the CDK app |
| `npm run deploy` | Deploy all infrastructure |
| `npm run deploy:no-approval` | The same with no confirmation prompt — sandbox or pipeline only |
| `npm run destroy` | Destroy all stacks |
| `npm run docker:setup-arm64` | Enable local ARM64 emulation for the agent image build |

`deploy` passes `--require-approval broadening`, so CDK stops whenever a changeset *widens* IAM or
security-group rules. Every stack asks on its first deploy; after that only one whose diff actually
adds permission does. Keep it as the default — a permission that widened unnoticed is what the
prompt exists to catch.

If the agent image fails to build with `exec format error`, run `npm run docker:setup-arm64` and
retry.

## Testing

Every package uses [vitest](https://vitest.dev) scoped to `environment: 'node'` — `npm test` needs
no AWS credentials, no Docker and no browser.

What the suites are for beyond the obvious: `infra/` asserts the security properties above against
the synthesized template (`aws-cdk-lib/assertions`), and `agent/` + `chatbot-bff/` each assert one
half of the identity block's wire format, which the two packages cannot share by import.

`AgentStack` is never synthesized in `infra/`'s suite — it builds a real Docker image — and rendered
React components are not covered, which would need `@testing-library/react` + `jsdom`.

## What this template leaves open

It is scaffolding, not a finished product. Two decisions are deliberately yours:

* **Conversation history lives in the container's memory** (`agent/src/index.ts`), keyed by session
  id and evicted after 30 minutes — lost on restart, not shared across replicas. A durable
  deployment swaps in the Strands SDK's `SessionManager` over a persistent store.
* **There is no data layer.** [infra/README.md](infra/README.md#where-a-data-layer-goes) covers
  where one goes and the two grant rules to follow.

Before a pilot with real users: set `DEPLOY_PROFILE=pilot` and fix what it refuses, pin
`DEPLOY_ACCOUNT`/`DEPLOY_REGION`, turn on `WAF_ENABLED`, and decide what your tools may reach.
