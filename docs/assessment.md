# Technical Assessment — `aws-agentic-app-starter`

**Scope:** an independent evaluation of the template's engineering, setting the application domain
aside.
**Date:** 2026-09-07 · **Commit assessed:** `5cfc27d` (branch `fix/assessment-v3`)
**Previous revisions:** 2026-09-06 over `332d74f` · 2026-08-29 over `c2d05ae` · **Original issue:**
2026-08-28 over `6ca67f3` — §10, §11 and §12 record what changed between them.
**Goal:** determine whether the template is ready to accelerate (1) demos, (2) closed pilots
including sensitive data, and (3) public production applications.

> **On this revision.** The application source is byte-identical to `c2d05ae`, two revisions back:
> `git diff --name-only c2d05ae..HEAD` reports no change to any `.ts`, `.tsx` or `.mjs` file, so
> every finding in §3-§8 carries over. This revision exists to correct one: the two previous
> revisions recorded the agent container as having no `SIGTERM` handler and no `HEALTHCHECK`, in
> four places, when both have been present since `3ee31cb` — a commit that predates the first of
> those revisions. §12 records the correction and the re-verification pass that found it.

---

## 1. Executive summary

This is an above-average template for its category. The engineering is deliberate: the security
decisions are not merely documented — they are **asserted by tests against the synthesized
template**, which is rare. The deployment profile gate (`infra/src/config.ts`) is a genuinely good
idea, well executed: it turns README comments into a build that refuses to synthesize.

Since the original issue (§10), the template has **closed most of the level-2 gap**: there is now a
Bedrock content guardrail, distributed tracing with an end-to-end correlation id, customer-managed
key encryption across every store, and durable conversation state in AgentCore Memory with retention
and per-`actorId` isolation. The profile gate grew from 6 rules to 9, taking on guardrail, tracing
and retention as *evidence posture*.

What **still** separates "a system that works" from "a system you operate with sensitive data" is
narrower: network isolation for the runtime (VPC), a deploy pipeline, business and per-user cost
metrics, and handler test coverage. None is the wide hole the first issue described.

### Verdict by level

| Level | Readiness | Score | Summary |
|---|---|---|---|
| **1. Demos** | ✅ **Ready** | 5/5 | One deploy command, coherent sandbox defaults, zero blockers. |
| **2. Closed pilots (sensitive data)** | ✅ **Ready with conditions** | 4/5 | The gate covers access *and* evidence (tracing, retention and guardrail all mandatory); content is recorded under a CMK. Remaining: runtime network isolation, a deploy pipeline, handler tests — all addressable before or shortly after go-live. |
| **3. Public production** | ⚠️ **Partially ready** | 3/5 | Persistence is solved. Remaining: no CD, no custom domain or TLS floor, optional WAF, no SLO or dashboard, Cognito's 50-emails/day ceiling, no DR. |

### Scores by dimension

| Dimension | Score | One-line comment |
|---|---|---|
| Architecture | 4.5/5 | A clear, coherent and (almost entirely) tested trust boundary; three Lambdas with separated privileges over memory. |
| Code quality | 4.5/5 | Strict TS, pure modules separated from I/O, comments that explain the *why*. |
| Tests and quality gates | 4.0/5 | 319 tests of very high quality — untested handlers remain, and coverage is never measured. |
| Security | 4.5/5 | Real least-privilege IAM, now with an own CMK across every store; missing mandatory WAF and network isolation. |
| AWS infrastructure | 4.0/5 | 100% IaC, explicit dependencies, KMS shared across stacks; no VPC and no multi-account strategy. |
| Observability | 3.5/5 | X-Ray on 3 Lambdas + stage, OTel in the agent, end-to-end correlation id, structured logging. Missing dashboard, SLO and business metrics. |
| Resilience | 3.0/5 | Conversation state is now durable (AgentCore Memory); per-session context ceiling. Missing retry, DLQ, reserved concurrency, DR. |
| Scalability | 3.0/5 | The serverless layer scales; the agent no longer holds state in memory, but keeps AgentCore session affinity. |
| Performance | 3.5/5 | End-to-end streaming and correct pooling decisions; nothing is measured. |
| CI/CD | 3.0/5 | Exemplary CI supply-chain hygiene, repository governance now in place; CD still nonexistent. |
| AI governance | 3.5/5 | Strong identity control + guardrail (content/PII/prompt-attack) + auditable content record. Missing eval suite and prompt versioning. |
| Cost optimization | 3.5/5 | Good preventive ceilings + a per-session context ceiling; still no instrumentation of real consumption (tokens/cost per `sub`). |

---

## 2. Methodology and evidence collected

This assessment is based on a full read of the source (~12,150 lines across tracked `.ts`/`.tsx`/
`.mjs` files, of which ~3,280 are tests — ~8,600 and ~2,440 respectively once blank and comment-only
lines are excluded), of the documentation (5 READMEs, 4 `.env.example` files) and of the IaC,
complemented by real execution:

| Check executed | Result |
|---|---|
| `npm run verify` (lint + typecheck + test) | ✅ **Exit 0** — 319 tests, all passing |
| `npm run audit` (`--audit-level=high`) | ✅ **Exit 0** — 2 *low* findings (the same esbuild advisory in `agent` and `chatbot-bff`, dev-only, Windows dev server); nothing moderate or above |
| CloudFormation synthesis of `auth`, `bff`, `frontend` | ✅ resources generated, inspected property by property |
| Inventory of hardening properties in the synthesized template | See §6.6 |
| Production build of the frontend | ✅ see §6.9 for the measured bundle |

Test distribution: `infra` 97 · `chatbot-frontend` 79 · `chatbot-bff` 107 · `agent` 36.

> **Methodological note:** `AgentStack` is not synthesizable without a real `docker build`, so its
> properties were evaluated by reading code rather than by inspecting a template. That is a
> limitation of this assessment **and** a gap in the template (§6.3).

---

## 3. Level 1 verdict — Demos

### Readiness: ✅ **Ready** (5/5)

The template hits exactly its stated goal. A developer with AWS credentials and Docker goes from
nothing to an authenticated agentic application, with streaming and an admin panel, in three
commands (`README.md`, "Quick start").

### Positive evidence

- **Coherent, conscious sandbox defaults.** Open sign-up, CORS `*`, no MFA — each documented as
  sandbox-only in `infra/.env.example`, with the reason it is the default spelled out.
- **`demo` is deliberately unchecked** (`infra/src/config.ts:173`). The justification in the code —
  "a sandbox that nags teaches that these errors are noise" — is mature product reasoning.
- **A no-cost-regression guarantee.** The test `costs nothing and changes nothing when no profile is
  set` (`infra/src/__tests__/stacks.test.ts:707`) ensures no billed resource appears without an
  explicit choice: `UserPoolTier`, `UserPoolAddOns` and `MfaConfiguration` are all absent by default.
- **Tests run with no AWS, no Docker and no browser** (`environment: 'node'` in all four packages).
- **Documented error recovery** for the most likely first-run failure (`exec format error` on the
  ARM64 build → `npm run docker:setup-arm64`).
- **A 10 rps / 20 burst stage default** plus a 20-requests-per-60s per-user quota stop a forgotten
  demo from generating a Bedrock bill.

### Risks and gaps (non-blocking)

| Item | Severity | Evidence |
|---|---|---|
| Cognito emails land in spam (default mailer `no-reply@verificationemail.com`) | Low | Honestly documented in `infra/README.md`, "Emails" section |
| Deploy assumes Docker + Buildx + ARM64 emulation | Low | `README.md`, "Quick start" |
| No `CODEOWNERS` | Low | Review routing is manual; the rest of the governance set now exists (§11) |

### Recommended actions (priority)

1. **P3 —** Add a `docker compose` file or a single script that brings up agent + BFF + frontend
   locally, to shorten the three-terminal path described in `README.md` ("Local development").

> The original P2 of this section — "add `LICENSE` and `SECURITY.md`; a template without a license is
> a template a client's legal team blocks" — was **executed** on 2026-09-06. See §11.

---

## 4. Level 2 verdict — Closed pilots, including sensitive data

### Readiness: ✅ **Ready with conditions** (4/5)

The template **understands** the pilot problem better than most — the profile gate is the proof — and
since the original issue it has come to **implement** the layer that was missing. The *evidence*
posture the first version flagged as absent now exists and is enforced by the gate: a pilot handling
sensitive data can answer "what did the agent reply" (AgentCore Memory), "how long is that kept"
(`CONVERSATION_RETENTION_DAYS`, mandatory) and "which turn is the user complaining about"
(an end-to-end correlation id that reaches the stored turn).

What remains for a clean go is no longer a capability gap — it is **runtime network isolation**
(VPC), **an auditable deploy path** and **handler test coverage**. All three are addressable; none is
the wide hole of the first issue.

### Positive evidence

**The profile gate does real work** (`infra/src/config.ts`, `assertDeploymentPosture`). With
`DEPLOY_PROFILE=pilot`, `cdk synth` fails before any resource is described, listing **every**
violation at once. There are **nine** rules now — the six from the original issue (five of *access
posture*, one of *durability*: `RETAIN_DATA`) plus three of *evidence posture* added since. That is
the same grouping the root README uses:

- `PUBLIC_SIGNUP_ENABLED` must be `false`
- `ALLOWED_ORIGIN` may not be `*`
- `ALERT_EMAIL` is required
- `COGNITO_MFA` must be `required`
- `COGNITO_THREAT_PROTECTION` may not be `off`
- `RETAIN_DATA` must be `true`
- `GUARDRAIL_ENABLED` must be `true` — nothing else in the stack inspects content, redacts PII or
  recognizes prompt injection *(new)*
- `TRACING_ENABLED` must be `true` — a wrong answer has to be reconstructable across all three
  runtimes *(new)*
- `CONVERSATION_RETENTION_DAYS` must be set — conversations are recorded, so how long for is a
  decision someone has to make *(new)*

And `assertDeploymentTarget` (`infra/src/config.ts:119`) requires `DEPLOY_ACCOUNT`/`DEPLOY_REGION`
under `pilot`/`prod`, failing if ambient credentials resolve to a different account. Both have
dedicated test coverage (`infra/src/__tests__/config.test.ts:184` onward, `describe('the deployment
profile gate')`).

**Identity isolation — the template's strongest point.** The chain is coherent from IaC to runtime:

| Layer | Control | Evidence |
|---|---|---|
| Browser | No AWS credentials — user pool with no identity pool | `chatbot-frontend/src/lib/auth.ts` |
| Test | The identity pool's absence is **asserted** | `stacks.test.ts:87-88`, and `:107-108` — `sts:AssumeRoleWithWebIdentity` absent from the entire template |
| Transport | AgentCore runtime with no `authorizerConfiguration` → SigV4 only | `agent-stack.ts:364` |
| IAM | Only the chat BFF role holds `InvokeAgentRuntime` | `bff-stack.ts:152`; asserted in `stacks.test.ts:111` and `:586` |
| Session | `sessionId` prefixed with `sha256(sub)[:16]` — blocks replay of someone else's conversation | `chatbot-bff/src/session.ts:7`, `:28` |
| Tools | **No tool accepts a `userId`**; identity comes from `AsyncLocalStorage` | `agent/src/tools.ts`, `agent/src/caller.ts:20-28`; asserted across the whole toolset |

**Privilege separation across functions.** Chat and admin are distinct Lambdas, and the test
`keeps every privileged grant off the function that relays model output`
(`stacks.test.ts:586`) asserts **exhaustively** that the chat role can do exactly two things:
`bedrock-agentcore:InvokeAgentRuntime` and `dynamodb:UpdateItem`. No `cognito-idp:`, no
`secretsmanager`, no `kms:`, no `sns:Publish`.

**Least-privilege IAM, with reasoning.** `bedrockModelResources` (`agent-stack.ts:528`) scopes
Bedrock to **one** model, emitting both required ARN forms (foundation-model and inference-profile) —
a correct and non-obvious detail, with three tests covering the cases. ECR is scoped to the asset's
own repository; DynamoDB is `UpdateItem` only; Cognito has four enumerated actions scoped to the
pool.

**Server-side authorization on the admin route.** `admin-handler.ts:71` rechecks `cognito:groups`
against the `admins` group on every call. The frontend badge is explicitly cosmetic
(`chatbot-frontend/src/lib/session-roles.ts`). `parseGroupsClaim` (`admin.ts:53`) handles all three
shapes the authorizer serializes the claim into — a place where getting it wrong fails open.

**An audit trail for privileged actions.** `auditRecord` (`admin.ts:202`) emits one JSON line per
action — **including denials** — naming the human (`actorSub`, `actorEmail`), which CloudTrail does
not do (it attributes to the Lambda's role).

**Data hygiene in logs.** `dataTraceEnabled` is explicitly off (`bff-stack.ts:182`); the access log
format carries identity and outcome, never a body; the audit record carries only actor, action and
target, with a comment explaining the decision (`admin.ts`).

**Safe rendering of model output.** `AgentMarkdown` uses `react-markdown@^10.1.0` without
`rehype-raw` and without `dangerouslySetInnerHTML`; the library's `defaultUrlTransform` sanitizes
`javascript:` URIs. User messages are rendered as plain text, by documented decision. That closes the
most common XSS vector in agentic apps.

### ✅ Blockers resolved since the original issue

These were the first version's blockers. They were closed in commit `3ee31cb`
(*"make conversations durable, guarded and traceable"*) and verified at HEAD:

| # | Original risk | How it was resolved | Evidence |
|---|---|---|---|
| **B1** | No Bedrock Guardrail | `createGuardrail` builds content filters (SEXUAL/VIOLENCE/HATE `HIGH`, INSULTS/MISCONDUCT `MEDIUM`), `PROMPT_ATTACK` input-only, and PII `ANONYMIZE` across 9 entities — **mandatory under `pilot`/`prod`** by the gate. A numbered, immutable version, pinned by the runtime. | `agent-stack.ts:439` `createGuardrail`, filters at `:460-483`; `config.ts` `GUARDRAIL_ENABLED` rule |
| **B3** | No record of what the agent replied | Conversations recorded in **AgentCore Memory** (`CfnMemory`), with `eventExpiryDuration = CONVERSATION_RETENTION_DAYS` and `encryptionKeyArn` on the CMK. Isolation by `actorId` derived from the session namespace. One event per turn; what gets stored is already PII-anonymized. | `agent-stack.ts:165-172` `ConversationMemory`; `agent/src/memory.ts` |
| **B4** | Zero distributed tracing | `TRACING_ENABLED` **mandatory under `pilot`/`prod`**: `lambda.Tracing.ACTIVE` on all three Lambdas and `tracingEnabled` on the stage. `agent/src/telemetry.ts` registers the SDK's OTel provider. **End-to-end correlation id**: minted in the browser (`X-Correlation-Id`), propagated as W3C baggage to the runtime, and written onto the turn. | `bff-stack.ts` `tracing`; `config.ts` `TRACING_ENABLED` rule; `agent/src/telemetry.ts` |
| **B5** | No customer-managed key encryption | An own `kms.Key` (`DataKey`) created in `AgentStack` and shared with `BffStack`: DynamoDB tables `CUSTOMER_MANAGED`, log groups with `encryptionKey`, the SNS topic with `masterKey`, memory and guardrail on the same key. Key policies scoped per service and per account. | `agent-stack.ts` `DataKey`; `bff-stack.ts` `encryptionKey` |

The **level-3 P1 blocker** (conversation state in container memory) was also resolved by the same
change: history is now durable, survives restarts, is isolated by `actorId` and has a per-session
context ceiling (`MAX_REPLAYED_MESSAGES`, default 40, `agent/src/memory.ts:54`), which partly
addresses the superlinear cost noted in §5.

### 🔴 Remaining risks and blockers

| # | Risk | Sev. | Evidence |
|---|---|---|---|
| **B2** | **AgentCore runtime on `networkMode: 'PUBLIC'`** — no VPC, no private subnets, no VPC endpoints, no egress control. A compromised container has unrestricted outbound reach. It is the only remaining *structural* blocker at level 2. `README.md` now names this explicitly ("The agent runtime has no VPC"). | **High** | `agent-stack.ts:334-336` |
| **B6** | **WAF optional in every profile, and outside the gate.** It is the only layer that filters **before** authentication. The implementation improved (4 managed rule groups + a per-IP rate rule, all in `block`), but `resolveWafEnabled` still defaults to `false` and the gate does not even demand an explicit choice. | **Medium** | `config.ts` `resolveWafEnabled`; `bff-stack.ts:494` `attachWebAcl` |
| **B7** | **Manual deploys, from a developer machine, on ambient credentials.** No pipeline, no approval, no separation of duties. `npm run deploy:no-approval` exists. CI **explicitly never runs `cdk synth`** (preserving the credential boundary), so a break in the profile gate still passes CI. | **Medium** | `.github/workflows/ci.yml`; `infra/package.json` `deploy:no-approval` |
| **B8** | **A 30-day refresh token with no documented revocation process.** Combined with the note that a group change only takes effect on the next token, the effective revocation window is long for sensitive data. Unchanged. | **Medium** | `auth-stack.ts:238` `refreshTokenValidity: cdk.Duration.days(30)` |
| **B9** | **No versioning and no access logging on the S3 bucket, and no CloudFront access logs.** There is no trail of who reached the frontend. Unchanged. | **Low** | `frontend-stack.ts` — neither `versioned` nor `serverAccessLogs` appears |

### Test gaps relevant to this level

- **`AgentStack` is tested by source reading only.** The absence of `authorizerConfiguration` is
  asserted (`stacks.test.ts:806`), as are the ECR scope and the log groups — but the stack is never
  synthesized, so the runtime's environment variables, the execution role's trust policy and the
  `lifecycleConfiguration` remain uncovered.
- **No handler tests.** `handler.ts` and `admin-handler.ts` have no test at all — only their pure
  helpers do. Untested: the *fail-closed* path when `claims.sub` is absent (`handler.ts:123-128`),
  and the **silent rate-limit bypass** when `RATE_LIMIT_TABLE_NAME` is empty (`handler.ts:17`,
  `:142`).
- **`infra/lambdas/custom-message/` has no test**, despite sitting on the critical path of `SignUp`
  and `AdminCreateUser`. The module even exports `resetAppUrlCache` as a "test seam"
  (`index.mjs:35`) — which no test uses.
- **No coverage measurement** in any of the four `vitest.config.ts` files, and no coverage gate in
  CI.

### Recommended actions — level 2, by criticality

The original issue's P0 actions (guardrail, tracing + correlation id, retention policy, CMK) are
done. What remains:

| Prio | Action | Effort |
|---|---|---|
| **P0** | Move the AgentCore runtime into a VPC with private subnets, controlled NAT and VPC endpoints for Bedrock/DynamoDB/Cognito — the only remaining structural blocker (B2). | M |
| **P1** | Test the handlers: fail-closed with no claims, rate-limit bypass with the table absent, the OPTIONS/405 path, and `custom-message` end to end. `handler.ts`, `admin-handler.ts` and `conversations-handler.ts` still have no handler test — only their pure helpers. | M |
| **P1** | Require `WAF_ENABLED=true` under `pilot`/`prod` — or at minimum turn it into an explicit choice the gate demands (B6). | S |
| **P1** | Replace manual deploys with an OIDC pipeline (no long-lived keys), mandatory `cdk diff` on PRs, and approval for `pilot`/`prod` (B7). See §6.10. | M |
| **P2** | Enable versioning and access logging on the S3 bucket, and access logs on CloudFront (B9). | S |
| **P2** | Measure coverage (`vitest --coverage`) and set a floor in CI. | S |
| **P2** | Shorten refresh-token validity under `pilot`/`prod` and document the revocation procedure (`admin-user-global-sign-out`) (B8). | XS |
| **P2** | Run `cdk synth` (of the three synthesizable stacks) in CI, so a break in the profile gate cannot pass. | S |

---

## 5. Level 3 verdict — Public production applications

### Readiness: ⚠️ **Partially ready** (3/5)

The template does not claim to be ready for this — `README.md` is explicit ("It is scaffolding, not a
finished product"). Since the original issue the highest-impact blocker (conversation state in
memory) was resolved, which raises the score. The remaining gaps are about operating at public scale,
not about functional correctness.

### 🔴 Structural blockers

The **original P1 — conversation state in container memory — is RESOLVED**: history now lives in
AgentCore Memory, durable across restarts and replicas, isolated by `actorId` and with a per-session
context ceiling (`agent/src/memory.ts`). The rest remain:

| # | Blocker | Why it blocks | Evidence |
|---|---|---|---|
| **P2** | **No CD.** No deploy workflow, no OIDC role, no protected environments, no cross-account promotion, no `cdk diff` on PRs, no drift detection, no rollback procedure. | Public production demands auditable, reversible deploys | `.github/workflows/` contains only `ci.yml` |
| **P3** | **No custom domain or ACM certificate.** The app serves from `*.cloudfront.net` on CloudFront's default certificate — whose protocol floor is TLSv1. | A branding, phishing and TLS-compliance problem | Synthesis: no `ViewerCertificate`, no `MinimumProtocolVersion` |
| **P4** | **Cognito's default mailer caps at 50 emails/day.** SES is not connected (which needs a verified domain and sandbox exit). | Public onboarding stalls on day one | Documented in `infra/README.md`, "Emails" |
| **P5** | **No WAF on CloudFront.** The optional ACL is `REGIONAL`, attached to the API Gateway stage; the SPA distribution is left uncovered. | A public surface with no edge filtering | `bff-stack.ts:514` `scope: 'REGIONAL'` |
| **P6** | **Single region, no DR.** No replica, no declared backup, no RTO/RPO, no runbook. | With no recovery objective there is no SLA | Absent throughout the IaC |
| **P7** | **No reserved concurrency and no DLQ on any Lambda.** A traffic spike can consume the whole account's concurrency; async failures have nowhere to go. | Cascading failure and silent loss | Synthesis: `ReservedConcurrentExecutions`, `DeadLetterConfig` = 0 |
| **P8** | **No retry/backoff and no circuit breaker on the Bedrock/AgentCore call.** A Bedrock throttle becomes a 500 straight to the user. | `agent-client.ts:76` — a bare `client.send()` with no throttling handling |
| **P9** | **No SLO, dashboard or latency alarm.** There are 3 alarms, all on errors (`threshold: 1`), none on latency, throttling, Bedrock errors or quota rejections. | You cannot operate against an objective | `bff-stack.ts:417`, `:425`, `:433` |
| **P10** | **No load or performance testing.** No baseline for time-to-first-token, throughput, or cost per conversation. | Capacity and cost at scale are unknown | Absent throughout the repository |
| **P11** | **No output moderation and no quality evaluation.** No eval suite, no model-behavior regression test, no system-prompt versioning. | A public app answers strangers with no safety net | `agent/src/agent.ts:61` |

### Additional scale and cost risks

- **Per-session context now has a ceiling — partially.** `MAX_REPLAYED_MESSAGES` (default 40,
  overridable via `MEMORY_MAX_MESSAGES`, `agent/src/memory.ts:54`) limits how many past messages are
  replayed each turn, bounding the superlinear cost the original issue flagged. It is a ceiling, not
  a summarizer: beyond it the oldest turns stop being seen by the model (though they remain in memory
  and in the transcript). A *token* ceiling and context summarization still do not exist, and no
  metric reveals when the ceiling is hit.
- **`evictStaleSessions()` being O(n)** stopped being a hot-path problem: per-container state was
  replaced by AgentCore Memory (`agent/src/index.ts` rewritten).
- **No token telemetry and no cost attribution.** `cloudwatch:PutMetricData` is still granted to the
  runtime; `agent/src/telemetry.ts` registers the Strands SDK's OTel provider, but it only exports
  when `OTEL_EXPORTER_OTLP_ENDPOINT` points at a collector — which the template does not provide.
  Without that collector it is still impossible to answer "which user spent the budget" or "what does
  a conversation cost" from business/EMF metrics.
- **The budget measures the whole account, not the project** — despite being named
  `${projectName}-monthly`. There is no `costFilters` on the `CfnBudget` (`bff-stack.ts:448`,
  `:456`). In a dedicated account — which is where `DEPLOY_ACCOUNT` pushes a pilot — that is the same
  thing; in a shared account, a ceiling below what the account already spends alerts at 100% every
  day until someone silences it. The `Project` tag now exists on every taggable resource (`app.ts`),
  which makes the scoping *possible*, but filtering on a tag not yet activated in Billing makes the
  budget measure zero and never fire — trading a noisy failure mode for a silent one. A pending
  decision, not a defect.
- **The budget is *account-wide***, not scoped by tag or service, and only alerts — it does not cap
  spend. The scope is now stated in `.env.example`, in `infra/README.md` and in the stack itself;
  previously only the `bff-stack.ts` comment mentioned it, while the resource name suggested the
  opposite.
- **No idempotency handling** on retried chat requests: a client retry produces a fresh invocation
  (and fresh token cost).
- **Chat errors are not localizable.** The `ErrorCode` contract (`chatbot-bff/src/errors.ts`) exists
  and is used by the admin routes, but the chat handler never imports it and emits raw English prose
  (`handler.ts:112`, `:132`, `:148`, `:230`). `retryAfterSeconds` is **sent by the BFF and ignored by
  the frontend** (`handler.ts:149`; no reference in `ChatExperience.tsx`).

### Recommended actions — level 3, by criticality

| Prio | Action | Effort |
|---|---|---|
| **✅ done** | ~~Replace in-memory session storage with a persistent store~~ — resolved via AgentCore Memory (`agent/src/memory.ts`), with a CMK and declared retention. | — |
| **P0** | Build the CD pipeline: OIDC, `cdk diff` on PRs, protected environments, dev→stage→prod promotion, documented rollback. Consider CDK Pipelines. | L |
| **P0** | Custom domain + ACM certificate + `MinimumProtocolVersion: TLSv1.2_2021`; WAF on CloudFront too. | M |
| **P0** | Connect SES (verified domain identity, DKIM, sandbox exit) — the path is already documented in `infra/README.md`. | M |
| **✅ done** | ~~Mandatory Bedrock Guardrails~~ — resolved (B1). Dedicated **output moderation** beyond the guardrail is still missing. | — |
| **P1** | Exponential backoff with jitter on the AgentCore call; treat Bedrock's `ThrottlingException` distinctly from a generic error. | S |
| **P1** | Reserved concurrency on the Lambdas; DLQs where applicable. | S |
| **P1** | CloudWatch dashboard + SLOs + alarms on latency (p99), throttles, Bedrock errors and quota rejection rate. | M |
| **P1** | Business metrics via EMF: input/output tokens per invocation, estimated cost per `sub`, invocations per tool, turn duration. | M |
| **P1** | A per-session turn/token ceiling and context truncation or summarization. | M |
| **P1** | An eval suite for the agent (behavior regression cases) + system-prompt versioning. | L |
| **P2** | Decide the budget's scope (account vs. `Project` tag, with Billing activation as a prerequisite); AWS Cost Anomaly Detection. | S |
| **P2** | A DR strategy: user-pool backup, declared RTO/RPO, incident runbook. | M |
| **P2** | Load testing with a baseline for time-to-first-token and cost per conversation. | M |
| **P2** | Unify the error contract: make `/chat` emit `{ code, error }` like the admin routes, and have the frontend consume `retryAfterSeconds`. | S |
| **✅ done** | ~~A `SIGTERM` handler + `HEALTHCHECK` in the agent container~~ — both present since `3ee31cb`: `agent/src/index.ts:147` drains in-flight requests on `SIGTERM`/`SIGINT`, `agent/Dockerfile:46` polls `/ping`. Recorded as absent by the two previous revisions; corrected in §12. | — |
| **P3** | Move the Lambdas to `arm64` (Graviton) — roughly 20% cheaper for the same load profile. | XS |

---

## 6. Dimension-by-dimension detail

### 6.1 Architecture — 4.5/5

**Strengths.** Four stacks with crisp boundaries and unidirectional, justified dependencies
(`infra/README.md`, "Stacks"): `agent` before `bff` because the BFF's role is scoped to the runtime
ARN; `bff` before `frontend` because `config.js` carries the API URL. The `auth ↔ frontend` cycle
(the email trigger needs the app URL, which only exists after the frontend) is broken by an SSM
parameter read at *runtime* rather than at synthesis (`frontend-stack.ts:216`,
`auth-stack.ts:188-206`) — a clean solution, correctly documented.

The central decision — the BFF as the only transport — is coherent from IaC to frontend, and its
rationale (`README.md`, "Why the BFF is the only transport") is the best writing in the repository:
it identifies that the identity block is *plain text* and therefore only as trustworthy as the
transport that carried it.

The two-Lambda pattern (chat unprivileged, admin privileged) is explicitly presented as the model to
copy (`bff-stack.ts:160`) — a template that teaches, not merely one that works.

**Weaknesses.**
- `AgentStack` has no synthesis-based test coverage (§4).
- No VPC anywhere — the template *expects* tools to reach backends (`agent-stack.ts:320-322`
  documents exactly where that grant goes) but does not show the network pattern for it.
- No multi-account or multi-environment strategy beyond `PROJECT_NAME` plus the profile.
- The identity block has no in-band integrity (no signature or HMAC). The code acknowledges this
  (`agent/src/caller.ts:6-9`) and mitigates via transport — defensible, but it means the trust
  boundary depends on IAM staying correct forever, with no in-band detection.

### 6.2 Code quality — 4.5/5

TypeScript `strict` throughout (`tsconfig.base.json`), ESLint on `tseslint.configs.strict`. A
consistent separation of pure logic from I/O — `admin.ts` vs `admin-handler.ts`, `config.ts` vs
`app.ts`, `caller.ts` vs `index.ts` — which is precisely what makes the test suite possible without
heavy mocking.

The comments explain the *why* at a level well above average, and **I verified a number of them
against the code**: they are accurate. Examples of genuinely non-obvious reasoning, correctly
recorded:
- Why the `BedrockModel` is shared at module scope but the `Agent` is per-request
  (`agent/src/agent.ts:90-97`).
- Why the entire stream is consumed *inside* the `AsyncLocalStorage` scope, not merely created inside
  it (`agent/src/index.ts:62-65`).
- Why the attribute cannot be called `locale` (`auth-stack.ts:104-107`) — a collision with a reserved
  standard attribute, and a one-way door.
- Why there are two `BucketDeployment`s with opposite `cache-control` (`frontend-stack.ts:177`,
  `:193`).

Duplication risks are handled explicitly: the identity block's wire format is asserted literally on
both sides (`chatbot-bff/src/session-context.ts:5-7`), because the packages cannot import from each
other.

**Defects found** (all minor, none security-relevant):

| Defect | Location |
|---|---|
| `resetAppUrlCache` exported as a "test seam" with no test using it | `infra/lambdas/custom-message/index.mjs:35` |
| The chat path never imports the `ErrorCode` contract the admin routes use | `handler.ts:112`, `:132`, `:148`, `:230` vs `errors.ts` |
| `retryAfterSeconds` sent and ignored | `handler.ts:149` vs `ChatExperience.tsx` (no reference) |
| `local.ts` duplicates the streaming loop from `handler.ts` instead of sharing it | `chatbot-bff/src/local.ts` |

### 6.3 Tests and quality gates — 4.0/5

**319 tests, all passing** (infra 97 · frontend 79 · bff 107 · agent 36). The quality remains
exceptional: the tests assert *invariants together with their stated failure mode*, not
implementation. The newer ones cover privilege separation across the three Lambdas over memory, the
correlation id's wire format, conditional durability (`memory.test.ts`) and the added gate rules.
Original highlights still standing:

- `gates every method on the API behind the Cognito authorizer` (`stacks.test.ts:569`) **enumerates**
  every method in the template instead of listing known routes — a new route is born covered.
- `keeps every privileged grant off the function that relays model output` (`:586`) makes an
  **exhaustive** assertion over the action set, not an absence check.
- `never puts a phone number in the schema, in any configuration` (`:731`) guards against a real,
  Cognito-specific failure mode (adding a standard attribute to a live pool breaks the deploy).

**Gaps** (repeated from §4, consolidated):

| Gap | Impact |
|---|---|
| `AgentStack` never synthesized — runtime env vars, trust policy and lifecycle uncovered (the absence of `authorizerConfiguration` **is** asserted, by source reading) | Medium |
| No handler tests (`handler.ts`, `admin-handler.ts`) | High |
| `infra/lambdas/custom-message/` untested, on the sign-up critical path | Medium |
| No React component tests (declared deliberate in `chatbot-frontend/vitest.config.ts`) | Medium |
| No integration or E2E tests | Medium |
| No coverage measurement and no coverage gate | Medium |
| No load testing | Medium (level 3) |

### 6.4 Security — 4.5/5

Covered in detail in §4. Summary of controls **present and verified**: no identity pool (asserted),
least-privilege IAM scoped per resource, privilege separation across functions (asserted
exhaustively), session namespacing by hash of `sub`, server-side group recheck, CSP with no
`unsafe-inline` in `script-src` (`frontend-stack.ts:89`), HSTS with `preload` and a 365-day max-age
(`:104-107`), `frame-ancestors 'none'` (`:98`), OAC rather than OAI on S3 (`:70`), a private bucket,
structured auditing including denials, and above-average CI supply-chain hygiene (actions pinned by
SHA, `persist-credentials: false`, `permissions: contents: read`, a timeout, an audit gate at `high`
— with the correct justification for why `critical` would be insufficient).

**Absent**: mandatory WAF, network isolation, a TLS floor, image scanning (ECR scan-on-push is not
enabled anywhere in `infra/src/`), SBOM, IaC scanning (cdk-nag), and a pinned
`PublicAccessBlockConfiguration` on the bucket (a deliberate, documented omission in
`frontend-stack.ts:62` on account of SCPs — but the control does not live in the template).
**Content guardrails and CMK are no longer absent** (see B1/B5): there is a mandatory guardrail under
`pilot`/`prod` and an own CMK encrypting conversations, tables, logs and the alarm topic.

Note: `NODE_TLS_REJECT_UNAUTHORIZED=0` appears commented out in two `.env.example` files, with strong
and correct warnings about its whole-process scope. Acceptable, but present.

### 6.5 AWS infrastructure — 4.0/5

Everything in CDK, no console steps. Naming derived from a single variable. Reasoned removal policies
(`RETAIN` by default on the user pool and the bucket; `DESTROY` on the counter table, with the
correct justification that they are disposable counters). The `cache-control` split across the two
`BucketDeployment`s — with a test — is a detail most templates get wrong.

Missing: a VPC, endpoints, and a multi-account strategy.

### 6.6 Observability — 3.5/5

**Present:** X-Ray on all three Lambdas and on the API Gateway stage (under `TRACING_ENABLED`,
mandatory in `pilot`/`prod`); an OTel provider registered in the agent container
(`agent/src/telemetry.ts`); an **end-to-end correlation id** — minted in the browser
(`X-Correlation-Id`), propagated as W3C baggage on the runtime invocation, and written onto the turn
in AgentCore Memory, so the id a user quotes locates the exact exchange; structured JSON logging on
the chat path (`logEvent`, `handler.ts`); 3 CloudWatch alarms with an encrypted SNS topic; API
Gateway access logs (identity and outcome, no body); 30-day retention on log groups
(`auth-stack.ts:193`); structured JSON auditing on the admin routes.

**Still absent:**

| Property | State |
|---|---|
| CloudWatch dashboard | 0 resources |
| Business/EMF metrics (tokens, cost per `sub`, invocations per tool) | not emitted — the OTel provider only exports with `OTEL_EXPORTER_OTLP_ENDPOINT` and an external collector |
| Latency / throttle / Bedrock-error / quota-rejection alarms | absent (all 3 alarms are error alarms) |
| A declared SLO | absent |

Tracing and the correlation id close what most separated level 2 from level 1 in the original issue.
What remains is the *operating-against-an-objective* layer (dashboard, SLO, business metrics) — more
relevant to public production than to a closed pilot.

### 6.7 Resilience — 3.0/5

**Present:** **durable conversation state** in AgentCore Memory — the highest-impact item from the
original issue, now resolved: history survives restarts and is shared across replicas by `actorId`,
no longer pinned to a container-local `Map`; the `CustomMessage` trigger never throws, degrading to
the plain-text template (`index.mjs`); the admin invite falls back to the path without the locale
attribute if the pool lacks it; the stream parser ignores unknown events; `complete()` is idempotent;
memory degrades to "no history" (rather than failing) when `AGENTCORE_MEMORY_ID` is absent; the
container drains in-flight requests on `SIGTERM`/`SIGINT` instead of cutting them mid-stream
(`agent/src/index.ts:147`), and the image declares a `HEALTHCHECK` that polls `/ping`
(`agent/Dockerfile:46`) for runners that do not probe it themselves.

**Absent:** retry/backoff, circuit breaker, DLQ, reserved concurrency, DR, and retry idempotency.

### 6.8 Scalability — 3.0/5

The Lambda/DynamoDB/CloudFront layer scales naturally; `PAY_PER_REQUEST` is the right choice for
counters. The ceilings (10 rps at the stage, 20 per 60s per user) are deliberate, documented and easy
to raise.

The real limiters are now the agent's AgentCore session affinity and the Cognito mailer (50/day).
Container-local state and O(n) eviction are gone, replaced by AgentCore Memory.

### 6.9 Performance — 3.5/5

**Good:** `BedrockModel` at module scope (a shared connection pool) paired with a per-request `Agent`
(avoiding state leakage across callers) — the correct and non-obvious pairing, with the reasoning
recorded (`agent/src/agent.ts:90-97`); end-to-end streaming (Lambda response streaming → SSE →
incremental markdown); `AgentMarkdown` loaded on demand; content-hashed, `immutable` assets;
CloudFront compression; an ARM64 image.

Production bundle, measured on this revision: 410.83 KB JS (125.54 KB gzip) + a 158.31 KB markdown
chunk (48.02 KB gzip) + 24.17 KB CSS (5.67 KB gzip). Acceptable.

**Not measured:** anything. No performance budget, no time-to-first-token baseline, no cold-start
mitigation. The Lambdas are `x86_64` at 512/256/256 MB (`bff-stack.ts:126-127`, `:283-284`,
`:339-340`) — with no recorded justification and no measurement supporting it.

### 6.10 CI/CD — 3.0/5

CI is genuinely good **within the scope it covers**, and its supply-chain hygiene is above average:
actions pinned by commit SHA (with a comment explaining that a tag is a mutable pointer),
`persist-credentials: false`, `permissions: contents: read` at the top, `timeout-minutes: 20`, and an
audit gate at `high` with an explicit justification.

Repository governance, flagged as incomplete in the previous revision, is now largely in place:
`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, a PR template and two issue forms
all exist, alongside the Dependabot configuration that was already there. `CODEOWNERS` is the
remaining absence. Node and npm floors are now declared (`engines` in all five `package.json` files,
plus `.nvmrc` pinning the major CI uses).

But: **there is still no CD**, and CI **never runs `cdk synth`** — so a change that breaks synthesis
in `app.ts`, where the profile gate lives, passes CI. The workflow's comment justifies this as a
credential boundary; the justification holds for `AgentStack` (a real Docker build), but the other
three stacks would synthesize without credentials.

### 6.11 AI governance — 3.5/5

**Present, and strong:** the "no tool accepts a user id" rule asserted across the whole toolset;
identity only from verified claims; a system prompt instructing the model never to accept an identity
claim originating in the conversation; `<thinking>` stripped from visible output; the model pinned by
id in a single place shared between configuration and IAM; input ceilings at two layers (8,000 chars
at the BFF, `http.ts:93`; 20,000 at the runtime, `agent/src/limits.ts:7`). **New since the original
issue:** a content/PII/prompt-attack guardrail mandatory under `pilot`/`prod`, with PII anonymized
before storage; an **auditable record of conversational content** in AgentCore Memory with declared
retention; and a **per-conversation context ceiling** (`MAX_REPLAYED_MESSAGES`).

**Absent:** dedicated output moderation (beyond the guardrail), an eval suite, behavior regression
tests, prompt versioning, a model-swap procedure, human-in-the-loop for consequential actions, and a
model card or acceptable-use policy.

### 6.12 Cost optimization — 3.5/5

**Present:** Bedrock scoped to one model (a cost boundary as much as a security one); a stage
throttle; a per-user quota; input ceilings; a **per-session context ceiling**
(`MAX_REPLAYED_MESSAGES`, which bounds the superlinear cost noted earlier); an optional budget
alerting at 80% and 100%; ARM64 for the agent; `PAY_PER_REQUEST`; `PriceClass_100`; a `Project` tag
on every taggable resource; the warning that threat protection moves the pool onto the Plus plan
billed per MAU; and the `costs nothing and changes nothing when no profile is set` test.

**Absent:** token telemetry and per-user/session cost attribution (the OTel provider exists but needs
an external collector), a *token* ceiling, a tag-scoped budget, anomaly detection, reserved
concurrency as a worst-case spend ceiling, and `arm64` on the Lambdas.

---

## 7. Consolidated prioritized backlog

Ordered by absolute criticality, across all three levels. The ✅ rows were completed since the
original issue and stay here as a record.

| # | Action | Blocks level | Dimension | Effort |
|---|---|---|---|---|
| ✅ | ~~Bedrock Guardrails (content + PII + prompt-attack), mandatory under `pilot`/`prod`~~ | 2, 3 | AI governance | done |
| ✅ | ~~Distributed tracing (X-Ray/OTel) + end-to-end correlation id~~ | 2, 3 | Observability | done |
| ✅ | ~~Persist conversation state~~ — AgentCore Memory, isolated by `actorId`, CMK, retention | 3 | Resilience | done |
| ✅ | ~~A retention policy for conversational content~~ — `CONVERSATION_RETENTION_DAYS`, enforced by the gate | 2 | AI governance | done |
| ✅ | ~~A CMK for logs, DynamoDB and SNS~~ — one own key shared across stacks | 2 | Security | done |
| ✅ | ~~`LICENSE`, `SECURITY.md`, contribution guide, PR template~~ — added 2026-09-06 (§11); `CODEOWNERS` still open | 1, 2 | Governance | done |
| 1 | VPC + endpoints + egress control for the runtime (B2) | 2 | Infra / Security | M |
| 2 | A CD pipeline with OIDC, `cdk diff` on PRs, protected environments, rollback (B7) | 2, 3 | CI/CD | L |
| 3 | Handler tests (fail-closed, rate-limit bypass, `custom-message`, conversations) | 2 | Tests | M |
| 4 | Mandatory WAF (or an explicit choice the gate demands) under `pilot`/`prod` (B6) | 2 | Security | S |
| 5 | Custom domain + ACM + `TLSv1.2_2021` + WAF on CloudFront | 3 | Security | M |
| 6 | SES connected (verified domain, DKIM, sandbox exit) | 3 | Infra | M |
| 7 | Business metrics via EMF: tokens, cost per `sub`, invocations per tool (needs an OTLP collector) | 2, 3 | Observability / Cost | M |
| 8 | Retry/backoff + Bedrock throttling handling | 3 | Resilience | S |
| 9 | Reserved concurrency + DLQ | 3 | Resilience | S |
| 10 | Dashboard + SLOs + latency/throttle/Bedrock alarms | 3 | Observability | M |
| 11 | A per-session token ceiling + context summarization (the message ceiling already exists) | 3 | Cost | M |
| 12 | An eval suite + system-prompt versioning | 3 | AI governance | L |
| 13 | `CODEOWNERS` (the rest of the governance set now exists) | 1, 2 | Governance | XS |
| 14 | Measured coverage with a floor in CI; `cdk synth` (of the 3 synthesizable stacks) in CI | 2 | Quality gates | S |
| 15 | Decide the budget's scope: whole account (today) vs. a `Project` tag activated in Billing | 3 | Cost | S |
| 16 | Versioning and access logging on S3; access logs on CloudFront (B9) | 2 | Security | S |
| 17 | Unify the error contract on `/chat`; consume `retryAfterSeconds` in the frontend | 3 | Quality / UX | S |
| 18 | Shorten refresh-token validity under `pilot`/`prod` + a revocation procedure (B8) | 2 | Security | XS |
| ✅ | ~~`SIGTERM` + `HEALTHCHECK` in the container~~ — both present since `3ee31cb`; recorded as absent in error until §12 | 3 | Resilience | done |
| 19 | Lambdas on `arm64` (Graviton) — roughly 20% cheaper for the same load profile | 3 | Cost | XS |

---

## 8. What this template does better than its category average

Recorded in fairness — these are points that rarely appear in comparable templates:

1. **Security properties asserted against the synthesized template**, not merely documented. The
   identity pool's absence, the exhaustive action set of the chat role, and the authentication of
   *every* enumerated method are tests that prevent regression by habit.
2. **The deployment profile gate.** The observation that "whoever copies the repository to run a
   pilot is not whoever read the comment" (`config.ts`) is a correct thesis about why documentation
   fails as a control — and the gate is the right implementation of that thesis.
3. **The dual Bedrock ARN** (`agent-stack.ts:528`) — inference profile *and* foundation model. It is
   a detail almost everyone gets wrong, and it is tested both ways.
4. **The "no tool accepts a user id" rule**, asserted across the whole toolset, with the concrete
   attack named. It is the right control for the real risk in agentic applications.
5. **CI supply-chain hygiene** above average, with the reasoning recorded at every decision.
6. **Honesty about limitations.** The "What this template leaves open" section names exactly the
   biggest functional gaps. This assessment confirms and extends them — but the template does not try
   to hide them.

---

## 9. Limitations of this assessment

- **`AgentStack` was not synthesized.** It requires a real `docker build`. Its properties were
  evaluated by reading code rather than by inspecting a template — the same limitation the test suite
  has.
- **No deploy was executed.** Runtime behavior (real latency, AgentCore under concurrency, email
  delivery, CSP effectiveness against the live app) was not observed.
- **No penetration testing** was conducted. The security conclusions derive from reading code and
  IaC.
- **No performance or cost measurement** beyond the production bundle build — the observations in
  those dimensions are structural, not empirical.
- This assessment reflects commit `332d74f`, whose application source is identical to `c2d05ae`
  (the previous revision) and `6ca67f3` plus the changes recorded in §10. File references were
  re-verified against this tree on 2026-09-06 (§11); where a reference names a line, that line was
  read.

### Verification executed in this revision (`332d74f`)

- `npm run verify` → **exit 0**, 319 tests passing (infra 97 · frontend 79 · bff 107 · agent 36).
- `npm run audit` (`--audit-level=high`) → **exit 0**: 2 *low* findings, both the same esbuild
  advisory (dev-only, Windows dev server) in `agent` and `chatbot-bff`; nothing moderate or above in
  any package.
- `npm run build` in `chatbot-frontend` → bundle measured, §6.9.
- `git diff --name-only c2d05ae..HEAD` → no `.ts`, `.tsx` or `.mjs` file changed.
- Source reading confirming the state of every blocker: `agent-stack.ts`, `bff-stack.ts`,
  `config.ts`, `app.ts`, `auth-stack.ts`, `frontend-stack.ts`, `agent/src/memory.ts`,
  `agent/src/caller.ts`, `agent/src/agent.ts`, `chatbot-bff/src/handler.ts`,
  `chatbot-bff/src/session.ts`, `chatbot-bff/src/admin.ts`, `infra/lambdas/custom-message/index.mjs`.

### Revision — 2026-08-28 (over `6ca67f3`, original issue)

Points raised in the first issue that were corrected in the repository, and therefore no longer
appear in the sections above:

| Original finding | Correction applied |
|---|---|
| A stale comment in `infra/.env.example` claiming the sign-in screen did not handle the TOTP enrollment challenge (which discouraged the only MFA posture the pilot gate accepts) | Comment rewritten to describe actual behavior: accounts with no factor get the setup challenge at next sign-in, handled by `chatbot-frontend/src/lib/auth-steps.ts` |
| The absence of `authorizerConfiguration` in `AgentStack` was not asserted by any test | Test `declares no authorizer configuration on the runtime` added (`infra/src/__tests__/stacks.test.ts:806`), by source reading — verified to fail when the property is introduced |
| No client-side character limit matching the server's `MAX_MESSAGE_LENGTH = 8000` | `maxLength={8000}` on the chat input (`chatbot-frontend/src/components/ChatExperience.tsx:377`), with a comment pointing at the mirrored constant |
| Cost allocation tags missing on every resource except the runtime | `cdk.Tags.of(app)` applies `Project` (`infra/src/app.ts`); verified in synthesis to reach every taggable resource, including the user pool via `UserPoolTags` |
| No Dependabot/Renovate — the `npm audit` gate reported without anything moving dependencies | `.github/dependabot.yml` covering all five `package.json` files and the GitHub Actions, with minor/patch grouped |
| The budget's scope undocumented: the resource is named `${projectName}-monthly` but measures the whole account, and neither `.env.example` nor `infra/README.md` said so | Scope and its consequence in a shared account documented in both files and in `bff-stack.ts`, along with why it does not filter by tag |

The test count at that 2026-08-28 revision was 249.

---

## 10. Revision — 2026-08-29 (`6ca67f3` → `c2d05ae`)

Between the original issue and that revision, commit `3ee31cb`
(*"make conversations durable, guarded and traceable"*) and those following it closed most of the
level-2 blockers. This is the delta, verified by source reading and by `npm run verify`/`audit` (both
exit 0).

### What was resolved

| Original blocker | State | Evidence |
|---|---|---|
| **B1** — no Bedrock Guardrail | ✅ Resolved | `createGuardrail` (content + PII `ANONYMIZE` + `PROMPT_ATTACK`), mandatory under `pilot`/`prod` |
| **B3** — no record of what the agent replied | ✅ Resolved | AgentCore Memory with retention and a CMK; `agent/src/memory.ts` |
| **B4** — zero distributed tracing | ✅ Resolved | X-Ray on 3 Lambdas + stage; OTel in the agent; end-to-end correlation id, mandatory under `pilot`/`prod` |
| **B5** — no CMK | ✅ Resolved | An own `DataKey` (KMS) shared across stacks, over conversations, tables, logs and the topic |
| **P1 (level 3)** — conversation state in memory | ✅ Resolved | AgentCore Memory, durable, isolated by `actorId`, per-session context ceiling |
| Profile gate with 6 rules | ✅ Extended to 9 | `GUARDRAIL_ENABLED`, `TRACING_ENABLED`, `CONVERSATION_RETENTION_DAYS` added |

The test count moved from 249 to 319 across that revision.

---

## 11. Revision — 2026-09-06 (`c2d05ae` → `332d74f`)

This revision made no engineering findings of its own. It did three things: translated the document
from Portuguese to English, re-verified every claim against the tree, and recorded the governance
changes made in the meantime.

### Application source: unchanged

`git diff --name-only c2d05ae..HEAD` reports no change to any `.ts`, `.tsx` or `.mjs` file. Every
architectural, security, test and cost finding in §3-§8 therefore carries over unchanged, and was
re-verified rather than assumed. What changed outside the source: governance files, dependency
versions (Dependabot, plus an OpenTelemetry alignment fix in `agent/package.json`), the README, the
architecture diagrams, and this document.

### What was resolved since the previous revision

| Previous finding | State | Evidence |
|---|---|---|
| No `LICENSE` — "a template without a license is a template a client's legal team blocks" (level 1, P2) | ✅ Resolved | `LICENSE` (MIT), plus `license: "MIT"` in all five `package.json` files |
| No `SECURITY.md` | ✅ Resolved | `SECURITY.md` — private vulnerability reporting, an in-scope list built around the profile gate and the IAM grants, and an explicit out-of-scope note that a `demo` default the gate already refuses is a design decision rather than a finding |
| No contribution guide, no PR template | ✅ Resolved | `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and two issue forms under `.github/ISSUE_TEMPLATE/` |
| Node/npm floors documented but unenforced | ✅ Resolved | `engines` (`node >=22.0.0`, `npm >=10.0.0`) in all five `package.json` files, and `.nvmrc` pinning the major CI uses. npm warns rather than fails on a mismatch: `engine-strict=true` in an `.npmrc` would make it hard, and is deliberately not set |
| `CODEOWNERS` absent | ⬜ Still open | Review routing remains manual (backlog #13) |

This moved **CI/CD from 2.5/5 to 3.0/5** — repository governance was one of that score's two
complaints; the absence of CD, the larger half, is unchanged. The level-1 verdict stays 5/5, with the
`LICENSE` risk row removed.

### Corrections made to the document itself

The previous revision noted in §9 that references pointed at symbols rather than lines "because the
tree changed substantially between the two issues". In practice many line references had been carried
over from the `6ca67f3` tree and no longer pointed at what they named. Every reference was re-read
against `332d74f` and corrected. The substance was accurate in each case — only the coordinates were
stale. The larger drifts:

| Claim | Was cited | Actually at |
|---|---|---|
| `keeps every privileged grant off the function that relays model output` | `stacks.test.ts:399` | `:586` |
| `gates every method on the API behind the Cognito authorizer` | `:382` | `:569` |
| `costs nothing and changes nothing when no profile is set` | `:504` | `:707` |
| `never puts a phone number in the schema` | `:528` | `:731` |
| `declares no authorizer configuration on the runtime` | `:592` | `:806` |
| Identity pool absence asserted | `:64`, `:71`, `:106` | `:87-88`, `:107-108` |
| `bedrockModelResources` | `agent-stack.ts:242` | `:528` |
| `networkMode: 'PUBLIC'` | (unlocated) | `agent-stack.ts:334-336` |
| `dataTraceEnabled` off | `bff-stack.ts:113` | `:182` |
| The three CloudWatch alarms | `bff-stack.ts:261-286` | `:417`, `:425`, `:433` |
| WAF `scope: 'REGIONAL'` | `bff-stack.ts:352` | `:514` |
| `InvokeAgentRuntime` grant | `bff-stack.ts:95-101` | `:152` |
| Two-Lambda pattern comment | `bff-stack.ts:193-196` | `:160` |
| `MAX_MESSAGE_LENGTH = 8000` | `http.ts:80` | `http.ts:93` |
| Rate-limit bypass on an empty table | `handler.ts:84` | `handler.ts:17`, `:142` |
| Fail-closed with no `claims.sub` | `handler.ts:73-78` | `handler.ts:123-128` |
| System prompt | `agent/src/agent.ts:22-50` | `:61` |

One substantive contradiction was also removed: §6.2's defect table listed "no client-side character
limit matching the server" against `http.ts:80`, while §9 recorded that same finding as *fixed* in
the 2026-08-28 revision. The fix is real — `maxLength={8000}` is present at
`ChatExperience.tsx:377` — so the defect row was wrong and is gone.

Two scores also disagreed with themselves between the §1 summary table and the §6 section headings.
Both are now harmonized to the summary table's value, which the surrounding prose supports:

| Dimension | §1 table said | §6 heading said | Now |
|---|---|---|---|
| Security | 4.5/5 | 4.0/5 (§6.4) | **4.5/5** |
| Scalability | 3.0/5 | 2.5/5 (§6.8) | **3.0/5** |

§6.8's prose was also stale in a way the score already reflected: it still named "container-local
state and O(n) eviction" as live limiters, which §5 and §6.7 both record as resolved by AgentCore
Memory. Only AgentCore session affinity and the Cognito mailer remain.

### Measurements refreshed

| Measurement | Previous revision | This revision |
|---|---|---|
| `npm run audit` | 1 *low* (esbuild), moderates below the gate | 2 *low* — the same esbuild advisory in `agent` and `chatbot-bff`; **nothing moderate or above** in any package |
| Frontend bundle (JS) | 403.8 KB / 123.5 KB gzip | 410.83 KB / 125.54 KB gzip |
| Frontend bundle (CSS) | 22.1 KB | 24.17 KB / 5.67 KB gzip |
| Markdown chunk | 158.3 KB / 48.0 KB gzip | 158.31 KB / 48.02 KB gzip (unchanged) |
| Test count | 319 | 319 (unchanged) |
| Source size | ~9,680 LOC, ~2,668 in tests (method unstated) | ~12,150 lines tracked `.ts`/`.tsx`/`.mjs`, ~3,280 tests; ~8,600 and ~2,440 excluding blank and comment-only lines (method stated) |

The bundle and audit drift comes from dependency updates, not from source changes.

### Go decision — closed pilot with sensitive data and real users

Unchanged from the previous revision, since no source changed. The template sits at **ready with
conditions (4/5)** for this scenario, up from **conditionally ready (3/5)** at the original issue. A
**clean** go depends on three decisions, in order of weight:

1. **Runtime network isolation (B2) — the only blocker that is not a process choice.** While the
   runtime is on `networkMode: 'PUBLIC'`, a compromised container has unrestricted egress. For a
   pilot whose toolset **makes no outbound calls** (the template's case today), the risk is
   containable and can be accepted *explicitly and in writing* as a time-boxed exception. The moment
   a tool reaches any backend, this becomes a hard blocker — moving to a VPC with endpoints before
   go-live is the safe path.

2. **An auditable deploy path (B7).** A pilot with real data needs reversible, traceable deploys.
   It does not require the full pipeline before go-live: the acceptable minimum is **dedicated (not
   personal) deploy credentials, a reviewed `cdk diff` before each deploy, and `npm run deploy` with
   approval (never `deploy:no-approval`)**. The full OIDC pipeline can follow shortly after.

3. **Confidence in the critical path (handler tests).** The IaC's security invariants are tested, but
   the chat handler's fail-closed behavior with no `claims.sub` and the rate-limit bypass with an
   absent table are not. For sensitive data, **cover those two paths before go-live** — it is low
   effort and closes the most consequential failure mode in the application runtime.

**Operational prerequisites for go-live (independent of code):** `DEPLOY_PROFILE=pilot` with all 9
rules satisfied (the gate guarantees this), `DEPLOY_ACCOUNT`/`DEPLOY_REGION` pinned, `WAF_ENABLED=true`
(strongly recommended even though optional), `CONVERSATION_RETENTION_DAYS` agreed with the privacy
function, and `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at a collector if token/cost metrics are required
during the pilot.

**Summary:** the go is viable. With WAF on and the network exception accepted in writing (given that
the toolset performs no egress), items 2 and 3 are the difference between a conditional go and a
clean one — both low effort. B9, `CODEOWNERS` and the `/chat` error contract do not block this
scenario.

---

## 12. Revision — 2026-09-07 (`332d74f` → `5cfc27d`)

A correction pass, not a new evaluation. The application source is unchanged since `c2d05ae`
(`git diff --name-only c2d05ae..HEAD` reports no `.ts`, `.tsx` or `.mjs` file), so §3-§8 stand as
written, with one exception.

### The correction

Two revisions of this document recorded, in four places, that the agent container has **no `SIGTERM`
handler and no `HEALTHCHECK`**. Both have been present since `3ee31cb` — the same commit whose other
work §10 credits — which predates both revisions. §11 claimed every claim had been re-verified
against the tree; this one had not been.

| Where | Was | Now |
|---|---|---|
| §5, scale and cost risks | "No graceful shutdown in the agent container" | Bullet removed |
| §5, recommended actions | `P2` — add a `SIGTERM` handler + `HEALTHCHECK` | Marked done, with evidence |
| §6.7, Resilience | Listed under **Absent** | Moved to **Present**, with file and line |
| §7, consolidated backlog | Row 19, bundled with `arm64` | Split: the container half closed, `arm64` still open |

`agent/src/index.ts:147` handles `SIGTERM` and `SIGINT` by calling `server.close()`, so in-flight
turns finish instead of being cut mid-stream when AgentCore recycles the container.
`agent/Dockerfile:46` declares a `HEALTHCHECK` that polls `/ping` with Node's own `fetch` (the slim
image ships no curl). The Resilience score stays at **3.0/5**: retry/backoff, DLQ, reserved
concurrency, DR and retry idempotency remain absent, and those are what hold the score down.

### What else was re-checked

Every other verifiable claim in the document was tested against the tree in this pass, including the
ones most likely to rot — the line-number citations. All held: `agent/src/memory.ts:54`
(`MAX_REPLAYED_MESSAGES`), `infra/src/stacks/agent-stack.ts:528` (`bedrockModelResources`),
`chatbot-bff/src/handler.ts:112`/`:132`/`:148`/`:230` (raw English error prose) and `:149`
(`retryAfterSeconds` emitted), the `CfnBudget` with no `costFilters`, `errors.ts` imported by the
admin and conversation handlers but not the chat one, `retryAfterSeconds` unreferenced in the
frontend, and the absence of reserved concurrency, DLQs and any retry policy on the AgentCore call.
`npm run verify` exits 0 at 319 tests (`agent` 36 · `chatbot-bff` 107 · `infra` 97 ·
`chatbot-frontend` 79); `npm run audit` exits 0.

### The lesson this revision records

A document that asserts "re-verified line by line" is making a claim about itself that nothing
checks. The template's own thesis applies to its assessment: documentation is the control that fails.
The claims worth trusting here are the ones carrying a file and a line, because those are the ones a
reader can falsify in one command — which is how this error was eventually found.
