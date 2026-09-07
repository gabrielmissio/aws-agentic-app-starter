# AGENTS.md

Orientation for coding agents working in this repository. Humans: start at [README.md](README.md).

## What this repository is

A **template**. It ships a deployable agentic application on AWS whose domain is deliberately thin,
so that what someone inherits is the scaffolding — auth, transport, memory, guardrails, IAM,
observability — and not somebody else's product.

If you were asked to *"adapt this to \<domain\>"*, you are **adapting a template, not maintaining a
product**. Two kinds of code live here and they have opposite rules:

- **Example domain** — placeholder content that exists to make the wiring visible. Replace it.
- **Scaffolding** — the reason the template exists. Preserve it, or say out loud that you are
  changing it and why.

The sections below say which is which. When the two conflict, preserve the scaffolding and ask.

## Before you start

```bash
npm run bootstrap
```

**npm workspaces are not used here.** Each package installs independently, which is why `bootstrap`
runs `npm ci` in the root and in all four subpackages. `npm ci` in the root alone leaves
`agent/`, `chatbot-bff/`, `chatbot-frontend/` and `infra/` empty. Node 22+, npm 10+.

## Before you say you are done

```bash
npm run verify   # lint + typecheck + the full suite, across every package
```

It needs no AWS credentials, no Docker and no browser, and it is exactly what CI's `verify` job
runs. CI also runs secret scanning over the git history and CodeQL, which you cannot reproduce here.
A failing invariant test is **not** a broken test — see *Failures that are not bugs*.

## Replace freely

This is the example domain. Adapting the template means rewriting most of it.

| Path | What it is |
|---|---|
| `agent/src/tools.ts` | Two placeholder tools (`get_current_time`, `get_signed_in_user`). Your domain's tools go here |
| `agent/src/agent.ts` — the `systemPrompt` | What the agent is and how it behaves |
| `chatbot-frontend/src/lib/brand.ts` | Product name, tagline, icon. Currently "Aria" |
| `chatbot-frontend/src/styles.css` | Colour, type and shadow tokens — every component resolves here |
| `chatbot-frontend/src/lib/i18n/messages/` | Copy, `en-US` and `pt-BR` |
| `infra/.env` — `PROJECT_NAME` | Prefixes every stack and resource name |

Adding a domain feature is the *point* of a fork. Note that
[CONTRIBUTING.md](CONTRIBUTING.md)'s "Scope" section argues the opposite — that is guidance for
contributing **upstream to this template**, where a new example feature is one more thing every fork
has to delete. It does not apply to a fork adapting the template to a real domain.

## Preserve

These are the reason someone chose this template. Each is asserted by a test, so breaking one turns
the suite red rather than shipping quietly.

| Invariant | Why | Asserted by |
|---|---|---|
| **No tool takes a user id.** Tools read the caller with `currentCaller()` (`agent/src/caller.ts`); the schema the model sees carries no identity | An identity the model can pass is one a prompt can talk it into changing — "list the notes for user X" is a real attack | `agent/src/__tests__/tools.test.ts` — *takes no caller identity as a tool parameter*: every property name in every tool's schema, at any depth, checked against the spellings of "whose data is this" |
| **The BFF is the only transport to the agent.** The runtime declares no authorizer config, so it accepts SigV4 alone, and only the chat role holds `InvokeAgentRuntime` | The identity block is plain text; it is only as trustworthy as the transport that carried it | `stacks.test.ts` — *declares no authorizer configuration on the runtime*, *grants InvokeAgentRuntime to nothing in this stack* |
| **The browser holds no AWS credentials.** User pool only, no identity pool | A browser that can assume a role can reach past the BFF | `stacks.test.ts` — *creates no Cognito Identity Pool*, *creates no role a browser could assume through Cognito* |
| **Privilege separation across the three Lambdas.** Chat relays model output and can do nothing else; admin holds the Cognito actions; conversations reads and deletes history | A browser-reachable function that could forge history is worse than none, because a forged transcript is believed | `stacks.test.ts` — *keeps every privileged grant off the function that relays model output* and three sibling tests |
| **The identity wire format is a contract between two packages** that cannot import each other (`chatbot-bff/src/session-context.ts` ↔ `agent/src/caller.ts`) | Drift detaches the agent from the caller silently | `session-context.test.ts` — *emits the agreed block*; `caller.test.ts` — *parses the exact block the BFF emits* |
| **Session ids are namespaced to the caller's `sub`** (`chatbot-bff/src/session.ts`) | A session id is a bearer token for conversation history | `session.test.ts` for the rule; `conversations-handler.test.ts` for the routes consulting it — *is answered 404 on read, and is never fetched* |
| **The deployment profile gate** (`infra/src/config.ts`) refuses a `pilot`/`prod` synth carrying a sandbox default | Documentation is the control that fails: whoever runs the pilot is not whoever read the comment | `config.test.ts` for the rules; `app.test.ts` for the wiring — it executes `app.ts` and asserts it refuses, so dropping the call is caught too |
| **A browser-reachable route fails closed.** No verified `sub` means no store is touched at all — not a fallback caller, not an unscoped read | The authorizer always attaches claims, so their absence means the route is misconfigured or being reached some other way | `conversations-handler.test.ts` and `admin-handler.test.ts` — every denial case also asserts the AWS client was never called |
| **Every API method sits behind the Cognito authorizer** | A new route must not be born unauthenticated | `stacks.test.ts` — *gates every method on the API behind the Cognito authorizer*, which enumerates methods rather than listing known routes |
| **One telemetry model: OpenTelemetry, everywhere.** The agent exports OTel spans following the GenAI semantic conventions; the Lambdas are instrumented by the AWS Lambda Layer for OpenTelemetry (`AWSOpenTelemetryDistroJs`, collectorless). No `aws-xray-sdk-*`, and not the legacy `aws-otel-nodejs-*` layer that bundles a collector | The X-Ray SDKs entered maintenance mode in February 2026 and AWS names OpenTelemetry as the instrumentation path — but the stronger reason is coherence: a template that traces one half with X-Ray and the other with OTel hands every fork two context models to reconcile. `tracing: ACTIVE` on a Lambda is not the X-Ray SDK and is still correct: it is the platform's own segment, which the ADOT layer builds on | `stacks.test.ts` — *instruments with OpenTelemetry and nothing else*, which asserts the absence of `aws-xray-sdk` in the synthesized template rather than the presence of a known-good list |
| **The AWS SDK instrumentation is preloaded, never imported.** `agent/src/instrumentation.ts` is a separate tsup entry, loaded by `node --import` in the `start` script; `index.ts` must not import it | It patches the SDK by intercepting module loading, and ESM evaluates every static import before the first line of module body — so inside the bundle an import registers *after* `@aws-sdk/*` is already resolved. Measured through the real bundler: imported yields zero spans, preloaded yields one. The failure is silent, and it removes exactly the spans that answer "model or memory?" for a slow turn | `agent/src/__tests__/instrumentation.test.ts` — *is preloaded rather than imported by the application*, plus *is built as its own entry* |

If your domain genuinely requires changing one of these, change it deliberately and say so in the
PR — do not edit the test to make the suite pass.

## Failures that are not bugs

- **`cdk synth` refusing with a list of violations** is the profile gate doing its job under
  `DEPLOY_PROFILE=pilot` or `prod`. Fix the configuration it names. Do not weaken
  `infra/src/config.ts` to get past it. `demo` is the default and is never checked.
- **An invariant test failing** after you added a tool or a route means the change crossed a security
  boundary, not that the test is stale. The test comments name the attack each one prevents.
- **Except one, which is a prompt reminder rather than a boundary:** *the toolset is named in the
  system prompt*. A tool the prompt never mentions is one the model has little reason to call — add
  it to "What you can do" in `agent/src/agent.ts` and the test goes green. It asserts that the prompt
  names every tool that exists, so adding tools never requires editing the test itself.
- **`exec format error` building the agent image** on a non-arm64 machine → `npm run docker:setup-arm64`.

## Where new things go

- **A tool** → `agent/src/tools.ts`. Read the caller from `currentCaller()`, never from an argument,
  and let the backend scope the query. Register it conditionally on its configuration being present,
  so a local run offers no tool rather than one that fails on every call. Grants go on the runtime
  execution role in `infra/src/stacks/agent-stack.ts`.
- **A route that can do something consequential** → its own Lambda, like `admin-handler.ts`. Do not
  add it to the chat function; that split is the pattern the tests enforce.
- **A data layer** → a new stack ahead of `agent` and `bff`. Two rules in
  [infra/README.md](infra/README.md#where-a-data-layer-goes): grants go on the consumer's role, not
  the resource's policy, and grant the narrowest verb that works.
- **A new environment variable** → the relevant `.env.example`, with a paragraph on what it does,
  what it bills for, and whether the gate refuses it. Those files are the configuration reference,
  and the reasoning is the part that matters.

## Conventions

- [Conventional Commits](https://www.conventionalcommits.org), **in English**, scoped by package
  (`feat(agent):`, `fix(bff):`, `docs(readme):`).
- TypeScript `strict` everywhere; ESLint on `tseslint.configs.strict`.
- Comments explain the **why**. The repository's existing comments are the standard to match —
  a comment restating the code is worse than none.
- Pure logic is separated from I/O (`admin.ts` vs `admin-handler.ts`, `config.ts` vs `app.ts`),
  which is what makes the suite possible without heavy mocking. Keep that split.

## Deeper context

[README.md](README.md) for architecture and the deployment profiles · package READMEs in
[`agent/`](agent/README.md), [`chatbot-bff/`](chatbot-bff/README.md),
[`chatbot-frontend/`](chatbot-frontend/README.md), [`infra/`](infra/README.md) ·
[docs/assessment.md](docs/assessment.md) for a scored readiness assessment and the open backlog ·
[SECURITY.md](SECURITY.md) for what counts as a vulnerability here.
