# Repository Assessment v4

**Repository:** `aws-agentic-app-starter`
**Commit assessed:** `15e4cd7` (*Merge pull request #29 from gabrielmissio/feat/observability*)
**Date:** 2026-09-07
**Method:** independent, evidence-based. Formed from the current source, IaC, configuration and
executed checks only. `docs/assessment.md` and any prior revision were deliberately **not** read as
a source, and no conclusion, score or finding below is inherited from them. No file in the
repository was modified; the only artefact created is this document.

---

## 1. Executive Summary

This is an unusually strong template, and its strength is not in the application it ships — which is
deliberately thin — but in the fact that **its security properties are executable rather than
documented**. The invariants a reviewer would normally have to take on trust (the browser holds no
AWS credentials, the agent runtime accepts SigV4 only, the function that relays model output cannot
read a conversation, every API method sits behind the authorizer, no tool accepts a user id) are each
asserted against the synthesized CloudFormation template or the source, and the suite is green:
**419 tests across four packages, plus lint and typecheck, in ~40 seconds with no AWS credentials,
no Docker and no browser.**

The single best decision in the repository is the **deployment-profile gate** (`infra/src/config.ts`).
`DEPLOY_PROFILE=pilot` refuses to synthesize while any sandbox default remains, and it names every
violation at once with the reason for each. I ran it: it refused with **10** named violations before
a single construct was instantiated. That converts a class of problem that documentation reliably
fails at — "whoever runs the pilot is not whoever read the comment" — into a build failure. Very few
accelerators do this, and it is the property that makes the demo→pilot path credible rather than
aspirational.

IAM is genuinely least-privilege, not nominally so. Across all four synthesized stacks the only
`Resource: "*"` statements remaining are the ones AWS gives no alternative for
(`ecr:GetAuthorizationToken`, the X-Ray write actions, `cloudwatch:PutMetricData` — and that one
carries a namespace condition), plus the four documented `logs:*Delivery` actions the data-protection
audit path requires. Bedrock is scoped to one model id and its inference profile; the chat Lambda
holds `dynamodb:UpdateItem` and nothing else; the conversations Lambda can read and delete history
but never write it; the agent runtime can write and replay events but never delete them.

Against that, three things stand out as real, and they are all *evolution* problems rather than
foundation problems:

1. **The agent loop is unbounded.** `createAgent` passes no `limits` to the Strands `Agent`, and
   `BedrockModel` is constructed with no `maxTokens`. The SDK's own typings state that omitting
   `limits` means "no limit on that dimension" for turns, cumulative output tokens and cumulative
   total tokens. A single authenticated request can therefore drive an arbitrary number of
   model calls. The controls that exist bound *how often* (20 requests/caller/minute) and *how large
   the input is* (8,000 characters) — nothing bounds what one request costs. For a template whose
   own README is careful about billing, this is the notable omission.
2. **There is no evaluation layer and no prompt lifecycle.** The system prompt is a template literal
   in `agent/src/agent.ts`, versioned only by git, carried on no span, and covered by exactly one
   test — that it mentions every registered tool. There is no golden set, no regression harness, no
   way to tell whether a prompt edit made the agent worse. Under the Agentic AI Lens this is the
   largest single gap, and it is the one a fork is least likely to build for itself.
3. **Documentation drift has begun, and the comment volume is the surface it drifts on.** Non-test
   source is 6,772 code lines to 2,368 comment lines (35%; 65% in `agent/src`). The comments are
   high-quality *why* comments and are the repository's best asset — but I found five documented
   claims the code no longer supports, across nine sites: six comments describing conversation storage
   as S3 prefixes and bucket lifecycle rules in a system that uses AgentCore Memory and DynamoDB, and a
   `.env.example` documenting a telemetry gate the code no longer reads. The essay-length comment style
   is not itself the problem; the problem is that it is a large, untested surface, and it has started to
   diverge.

Nothing I found requires refactoring the foundation. The transport boundary, the identity model, the
privilege split across three Lambdas, the memory/index separation and the profile gate are all
decisions I would keep. What a team adopting this must add before a sensitive pilot is bounded
autonomy, backups and an evaluation harness — additions, not rewrites.

---

## 2. Final Verdict

| Target | Verdict |
|---|---|
| **Demo** | **READY** |
| **Sensitive Pilot** | **READY WITH CONDITIONS** |
| **Public Production** | **READY WITH CONDITIONS** |
| **General-purpose Template** | **READY WITH CONDITIONS** |

**Demo — READY.** `npm run bootstrap`, one variable (`PROJECT_NAME`), `npm run deploy`. The `demo`
profile ships with the billed controls off (guardrail, X-Ray, WAF, Cognito Plus), so the fixed cost
of a sandbox is essentially the KMS key plus log storage. The one failure a green deploy does not
predict — the Bedrock Marketplace agreement on first model use — is documented with the exact fix and
the reason it must not be solved with IAM.

**Sensitive Pilot — READY WITH CONDITIONS.** The access-control posture is strong enough: per-user
isolation is enforced twice (session namespace plus `actorId`), everything at rest is under one
customer-managed key, retention is a service property rather than a cron job, PII is masked at both
the span source and the log destination, and the gate refuses to synthesize until MFA, threat
protection, the guardrail, tracing and a declared retention are all set. The conditions are
**P1-01 (bound the agent loop)**, **P1-02 (PITR/backup on the conversation index)** and
**P1-03 (fix the stale storage comments before anyone reasons about data location from them)**.

**Public Production — READY WITH CONDITIONS.** The foundation scales and degrades correctly:
serverless throughout, no NAT, Graviton, streaming, per-caller quotas, a WAF path, seven alarms
covering the failures that return HTTP 200, and a dashboard ordered the way an incident unfolds. What
is missing is operational rather than architectural: no CD pipeline, no reserved concurrency, no
CloudFront or S3 access logging, no PITR, no SLOs, and no cost ceiling that actually stops spend.

**General-purpose Template — READY WITH CONDITIONS.** As scaffolding this is excellent and the
example domain really is thin. The conditions are template-hygiene ones: a 75 KB internal assessment
document shipped in `docs/` that seven production comments reference by name, and the five drift
instances above. A fork inherits all of it.

---

## 3. Repository & Architecture Overview

### Components and entrypoints

| Package | Entrypoint | Runtime | Purpose |
|---|---|---|---|
| `agent/` | `src/index.ts` (Express, `POST /invocations`, `GET /ping`) | Bedrock AgentCore Runtime, container, arm64 | Strands agent, two tools, AgentCore Memory, OTel export |
| `chatbot-bff/` | `src/handler.ts`, `src/admin-handler.ts`, `src/conversations-handler.ts` | Lambda Node 22, arm64 | The only transport to the agent; admin and conversation APIs |
| `chatbot-frontend/` | `src/main.tsx` | React 19 + Vite 7, S3/CloudFront | Chat UI, admin panel, i18n (en-US, pt-BR) |
| `infra/` | `src/app.ts` | AWS CDK v2 | Four stacks, plus the profile gate |
| `infra/lambdas/custom-message/` | `index.mjs` | Lambda Node 22, no build step | Cognito CustomMessage trigger (HTML, localized emails) |

Local entrypoints also exist: `chatbot-bff/src/local.ts` (`/chat` only, no token validation, fixed
caller id) and `agent/src/invoke.ts` (SigV4 invoke of a deployed runtime).

### Request path

```
Browser (Amplify, user pool only — no identity pool)
  └─ ID token + X-Correlation-Id ──▶ API Gateway REST (Cognito authorizer on every method)
        └─ chat Lambda (streamifyResponse)
              ├─ per-caller quota   → DynamoDB conditional UpdateItem
              ├─ session id         → namespace = sha256(sub)[0:16] + "-" + uuid
              ├─ conversation index → DynamoDB UpdateItem (title, recency, TTL)
              └─ SigV4 InvokeAgentRuntime (baggage: correlationId)
                    └─ AgentCore Runtime (networkMode PUBLIC, no authorizer config)
                          ├─ parsePrompt → AsyncLocalStorage caller
                          ├─ loadHistory (AgentCore Memory, actorId = namespace)
                          ├─ Strands Agent → Bedrock (+ optional guardrail)
                          └─ recordTurn (one event per exchange)
```

Two sibling paths: `GET|DELETE /conversations[/{id}]` on a **separate** Lambda that can read and
delete history but cannot invoke the model; `GET|POST /admin/users` on a **third** Lambda that holds
the four Cognito actions and nothing else.

### Stacks and dependency order

`auth` → `agent` → `bff` → `frontend`. `agent` intentionally depends on nothing from `auth` — that
absence *is* the transport boundary. `frontend` publishes its CloudFront URL to SSM so the auth
stack's email trigger can read it at send time without creating a synth-time cycle. Synthesized
resource counts under a full pilot posture: agent 31, auth 9, bff 65, frontend 14 (119 total).

### Data flow and storage

| Store | Holds | Encryption | Retention | Reachable by |
|---|---|---|---|---|
| AgentCore Memory | User/assistant text only, one event per turn | Deployment CMK | `eventExpiryDuration` = `CONVERSATION_RETENTION_DAYS` | agent (write/read), conversations Lambda (read/delete) |
| DynamoDB `-bff-conversations` | Title, timestamps, one row per conversation | CMK | TTL, same number | chat (UpdateItem), conversations (Query/DeleteItem) |
| DynamoDB `-bff-rate-limit` | Disposable counters | CMK | TTL | chat (UpdateItem) |
| S3 site bucket | Built SPA + `config.js` | SSE-S3 | n/a | CloudFront via OAC |
| CloudWatch log groups (6) | Structured logs, spans, EMF metrics | CMK | 1 month, or matched to conversation retention | operators |

Tool calls and results are deliberately **not** stored in memory — the stated reason (a `toolUse`
block replayed without its `toolResult` is a message Bedrock rejects) is correct and is the right
trade.

### Frameworks, auth, config, CI

- **Agentic framework:** `@strands-agents/sdk` pinned exactly at `1.14.0` (the only exact pin in the
  repo — appropriate for the component whose event shapes the frontend parser depends on).
- **Auth:** Cognito user pool, SRP only, `userPassword: false`, `preventUserExistenceErrors: true`,
  ID-token authorizer, groups (`admins`) for roles, no identity pool. Authorization is re-checked
  server-side on every admin call.
- **Config:** per-package `.env` + `.env.example`, loaded with `dotenvx run --overload`. No secrets
  anywhere; nothing in Secrets Manager because nothing needs it yet.
- **CI:** one GitHub Actions job — `npm run bootstrap`, `npm run verify`, `npm run audit`. Actions
  pinned to commit SHAs with the release in a trailing comment, `permissions: contents: read`,
  `persist-credentials: false`, `timeout-minutes: 20`. Dependabot on all five lockfiles plus
  `github-actions`.
- **Environments:** one. `DEPLOY_PROFILE` selects a *posture*, not an environment; separation of
  dev/staging/prod is by `PROJECT_NAME` and account/region pinning.

### Documentation for humans vs for agents

Human: root `README.md`, four package READMEs, `infra/README.md` (the operational runbook —
troubleshooting for five real deploy failures), `CONTRIBUTING.md`, `SECURITY.md`,
`CODE_OF_CONDUCT.md`, four `.env.example` files, `media/architecture.drawio` + two rendered PNGs,
`docs/assessment.md`. Agent-facing: `AGENTS.md`, with `CLAUDE.md` as a two-line pointer to it. No
`.kiro/`, no ADRs, no specs directory (`.gitignore` lists `.kiro/`, but none is present).

---

## 4. Validation Performed

Everything below was executed on this checkout. No deploy, no AWS mutation.

| Check | Command | Result |
|---|---|---|
| Dependency install | `npm run bootstrap` | Pass, 5 packages |
| Lint | `npm run lint` (eslint, `tseslint.configs.strict`) | Pass, 0 findings |
| Typecheck | `npm run typecheck` (4 packages) | Pass |
| Tests — agent | `vitest run` | **74 passed** (9 files) |
| Tests — bff | `vitest run` | **132 passed** (10 files) |
| Tests — infra | `vitest run` | **129 passed** (3 files) |
| Tests — frontend | `vitest run` | **84 passed** (8 files) |
| Full gate | `npm run verify` | **Pass**, no `npm ERR` |
| Audit | `npm run audit` (`--audit-level=high`) | **Pass.** One *low* advisory: `esbuild` 0.27.3–0.28.0, dev-server file read on Windows (GHSA-g7r4-m6w7-qqqr), dev dependency only |
| IaC synth — demo | `PROJECT_NAME=… DEPLOY_PROFILE=demo cdk synth` | **Success**, 4 stacks, empty validation report |
| IaC synth — pilot, unpinned | `DEPLOY_PROFILE=pilot` | **Refused** at `config.ts:129` — `DEPLOY_ACCOUNT`/`DEPLOY_REGION` required |
| IaC synth — pilot, sandbox defaults | `DEPLOY_PROFILE=pilot` + account/region | **Refused** at `config.ts:249` with **10** named violations |
| IaC synth — pilot, full posture | all 10 satisfied + `WAF_ENABLED` + budget | **Success**, 119 resources |
| Template IAM inspection | parsed all four templates for `Resource:"*"` | See §7 Security — only documented unavoidable wildcards |
| Comment/code ratio | line classifier over non-test sources | 6,772 code / 2,368 comment (0.35); `agent/src` 0.65 |

**Limitations recorded explicitly:**

- **No deploy was performed**, so runtime behaviour is inferred from source and template. Claims that
  depend on live AWS (guardrail streaming behaviour, Transaction Search indexing, email
  deliverability, AgentCore session recycling) are unverified here.
- **No rendered-React tests exist** in the repository (`@testing-library/react` + `jsdom` are absent
  by the README's own admission), so component behaviour is reviewed by reading only.
- **The Docker image was not built.** Notably, `cdk synth` did **not** build it either — see
  DOC-04, which corrects a claim the repository makes in three places.
- AWS credentials in the environment were expired; synth ran env-agnostic. This does not affect any
  assertion above, since none required an account lookup.

---

## 5. Readiness by Target

### 5.1 Demo — READY

**Time to first value is genuinely short.** `npm run bootstrap`; copy one `.env`; set
`PROJECT_NAME`; `cdk bootstrap`; `npm run deploy`. The root README distinguishes the two unrelated
"bootstraps" in a callout, which is the kind of friction most templates leave in. `DEPLOY_PROFILE`
defaults to `demo` and is **never checked**, which is the right call — a sandbox that nags teaches
people that these errors are noise.

**Minimum cost is low and deliberate.** Guardrail, X-Ray, agent observability, WAF and Cognito Plus
are each off by default with the billing reason stated at the resolver. The residual fixed cost is
one KMS key (~USD 1/month), CloudFront/S3 at near zero, and log storage; everything else is
per-request. No NAT gateway, no provisioned capacity, no always-on compute.

**Customisation is signposted.** The root README's "Making it yours" table and `AGENTS.md`'s
"Replace freely" table name the same six places, and they agree.

**Debugging locally works, with an honest caveat.** The local BFF serves `/chat` only, with no token
validation and a fixed caller id — stated in three places. `AGENTCORE_MEMORY_ID` unset means the
agent answers without history and records nothing, so local dev needs no managed resource.

Two frictions worth naming, neither blocking: the first chat message will fail on Bedrock
Marketplace in a fresh account (documented, with the fix and the reason not to grant
`aws-marketplace:Subscribe` to the runtime role), and enabling agent telemetry locally is
undiscoverable because `agent/.env.example` still documents the retired variable (DOC-02).

### 5.2 Sensitive Pilot — READY WITH CONDITIONS

What makes this credible rather than a hope:

- **Per-user isolation is enforced twice.** `belongsToCaller` refuses a session id that does not
  carry `sha256(sub)[0:16]`, *and* every read into memory passes an `actorId` derived independently
  from the caller's own verified `sub` (`conversations-handler.ts` `readEvents`). Either control
  alone would suffice; both means a bug in one is not an exposure. A non-owned id answers `404`, not
  `403`, so the id space is not an existence oracle.
- **Authorization is server-side at the tool and route boundary, never in the prompt.** No tool takes
  a user id; identity arrives via `AsyncLocalStorage` bound per request (correctly — a module-level
  variable on a warm container would cross callers, and the test suite pins the async-context
  behaviour). The frontend's admin badge is explicitly cosmetic and the BFF re-checks
  `cognito:groups` on every call.
- **Fail-closed is tested as such.** Every denial path in `conversations-handler.test.ts` and
  `admin-handler.test.ts` also asserts the AWS client was never invoked. A rule that holds in
  isolation but is never consulted protects nothing; these tests close that gap.
- **Encryption is under a key the deployment controls,** with the two easy-to-miss grants present
  (CloudWatch Logs via encryption-context condition; CloudWatch/SNS for encrypted alarm delivery —
  without which alarms fail silently).
- **Retention is a service property.** `eventExpiryDuration` on the memory resource, TTL on the index,
  and the telemetry log group's retention rounded *up* to the next supported value so a trace never
  outlives the turn it describes.
- **PII is handled in two layers with the blind spots named.** `span-redaction.ts` redacts tool
  arguments and results at the source (where `get_signed_in_user` returns the caller's email, which
  the guardrail provably cannot reach), and a CloudWatch Logs data-protection policy masks structured
  identifiers on write in **both** the telemetry group and the group AgentCore creates for the
  runtime. Unmasking requires `logs:Unmask`, which nothing grants. The README states plainly that
  guardrail `ANONYMIZE` is unreliable on a streamed response, with an observed example — that honesty
  is worth more than the control.
- **Privileged actions are audited by human, not by role.** `auditRecord` emits one structured line
  per admin and delete action naming the actor's `sub` and email; denials are logged too.

**Conditions before real user data:**

| # | Condition | Why |
|---|---|---|
| P1-01 | Bound the agent loop (`limits.turns`, `limits.totalTokens`, `maxTokens`) | One authenticated request can currently drive unbounded model calls |
| P1-02 | PITR + a backup plan on `-bff-conversations` | `RETAIN` protects against stack deletion, not against a bad write or an accidental table delete; there is no recovery path for the conversation index, and none documented for AgentCore Memory |
| P1-03 | Correct the five stale storage comments | People make data-location decisions from comments; five of them describe S3 prefixes and bucket lifecycle rules that do not exist |
| P1-04 | Add secret scanning and a CDK policy scan to CI | Neither exists; a template's security posture is inherited, and CI is where regressions are caught |
| P1-05 | Decide and document a prompt/eval baseline | Non-determinism is not covered by any of the 419 tests |

### 5.3 Public Production — READY WITH CONDITIONS

The architecture holds. What is absent is operational, and each item can be added without moving a
boundary.

**Already right for public exposure:** API stage throttle defaulted to 10/20 rps rather than
inheriting the account's 10,000; per-caller fixed-window quota enforced with a *conditional*
`UpdateItem`, so it is atomic across concurrent invocations rather than read-then-write; an 8,000
character input ceiling in the BFF and a 20,000 character ceiling in the agent as defence in depth;
an opt-in regional WAF with three AWS managed groups and a per-IP rate rule, every rule in `block`
mode ("a managed rule group in count mode is a dashboard"); CSP with `script-src 'self'` and no
`unsafe-inline`, HSTS with preload, `frame-ancestors 'none'`, OAC-only bucket access; seven alarms
that include the three failures which return HTTP 200 (AgentCore throttles, AgentCore system errors,
Bedrock throttles) plus a p95 latency alarm below the function timeout.

**Conditions:**

| # | Condition | Evidence |
|---|---|---|
| P2-01 | A CD pipeline with a `cdk synth`/diff gate | `deploy` runs from a developer's machine with ambient credentials; CI never validates a template |
| P2-02 | `reservedConcurrentExecutions` on the three functions | Absent on all three; a burst can consume the account's concurrency pool for every other workload |
| P2-03 | CloudFront + S3 access logging | `Logging: null` on the distribution; no server access logs on the bucket. There is no record of who fetched the SPA |
| P2-04 | A ceiling that *stops* spend, not only alerts | The budget "alerts; it cannot stop spend" (correctly stated) and is account-wide with no cost filter |
| P2-05 | SLOs/SLIs | Application Signals is deliberately disabled pending a target; no target is defined anywhere |
| P2-06 | Cognito `DeletionProtection` and DynamoDB `DeletionProtectionEnabled` | Both unset; `RemovalPolicy.RETAIN` covers stack operations but not an API-level delete |

Not conditions, but decisions to revisit at scale: `networkMode: 'PUBLIC'` on the runtime (correct
today — the toolset makes no outbound calls — and the README says so); single region with no DR; and
no idempotency key on `POST /chat`, so a client retry duplicates a stored turn.

### 5.4 General-purpose Template — READY WITH CONDITIONS

**What makes it a good template, specifically:** the example domain is two tools and one system
prompt, and both are marked as replaceable in two documents that agree; every invariant a fork might
break by habit is a red test rather than a paragraph; `AGENTS.md` names the test that guards each
invariant, which is the difference between an instruction a coding agent can verify and one it can
only obey; the "Failures that are not bugs" section pre-empts the four failures a newcomer will hit
and misdiagnose; and pure logic is split from I/O everywhere (`admin.ts`/`admin-handler.ts`,
`conversations.ts`/`conversations-handler.ts`, `config.ts`/`app.ts`), which is what makes a
419-test suite possible without heavy mocking.

**Conditions:**

| # | Condition | Evidence |
|---|---|---|
| P0-01 | Remove or relocate `docs/assessment.md` and the seven code comments referencing it | 75 KB / 11,371 words of upstream self-review that every fork inherits; `bff-stack.ts:157,556,851`, `agent-stack.ts:836`, `emf-metrics.ts:7,15`, `telemetry.ts:6` reason from it in production comments |
| P0-02 | Fix the five drift instances (DOC-01…DOC-05) | Documented behaviour that the code does not have, in files the README calls the source of truth |
| P3-x | Reconcile the `--ignore-scripts` asymmetry and the missing formatter | See §13 |

---

## 6. Scorecard

| Dimension | Score | One-line justification |
|---|---:|---|
| Architecture | **5** | Boundaries are chosen for a reason, enforced by IAM, and each one is asserted; three Lambdas split by privilege rather than by convenience |
| Code Quality | **4** | Strict TS, no `any`, no `@ts-ignore`, one `eslint-disable`, zero TODOs; loses a point for essay-length comments that have begun to drift and no type-aware lint |
| Security | **4** | Least privilege verified in the synthesized template, double-enforced tenant isolation, fail-closed tested; no secret scanning, no SAST, no IaC policy scan |
| Reliability | **3** | Graceful degradation is deliberate everywhere; no PITR, no backups, no DR, no idempotency, no reserved concurrency |
| Operational Excellence | **4** | Seven alarms including the silent failures, a purposeful dashboard, a real runbook; no CD pipeline and no template-validation gate |
| Performance Efficiency | **4** | Streaming end to end, Graviton, right-sized memory, history capped, guardrail scoped to the latest message; no load evidence and no cold-start mitigation |
| Cost Optimization | **4** | Every billed control opt-in with its reason, no NAT, no idle capacity, EMF instead of `PutMetricData`; undermined by the unbounded per-request token spend |
| Sustainability | **4** | arm64 throughout, on-demand tables, bounded retention, `PRICE_CLASS_100`, one row per turn rather than per message |
| Agentic AI Safety & Reliability | **3** | Best-in-class identity and tool-permission model; no execution limits, no evaluations, no prompt versioning, no human-in-the-loop hook |
| Observability | **5** | One coherent OTel model, `traceparent` joining all three runtimes, a browser-minted correlation id reaching the stored turn, GenAI-convention spans, token/tool metrics, and redaction at both source and destination |
| Testing & Quality Gates | **4** | 419 tests asserting security properties against the synthesized template, both directions of the gate; no coverage signal, no rendered-component tests, no synth gate in CI |
| Documentation | **4** | Exceptional depth and reasoning, a genuine runbook; five drift findings across nine sites, and one document that should not ship |
| Developer Experience | **4** | Two commands to a working deploy, one variable to change; implicit knowledge is low but the doc volume is high |
| Template Reusability | **4** | Thin example domain, invariants guarded by tests, clear replace/preserve split; inherits an upstream assessment and its drift |
| Production Evolution Path | **4** | The profile gate *is* the path, and the remaining gaps are additive; only the missing CD pipeline is structural work |

**Weighted read:** the repository is strongest exactly where templates are usually weakest
(observability, enforced boundaries, IaC test coverage) and weakest where agentic systems are usually
weakest (bounded autonomy, evaluation). That is a fixable shape.

---

## 7. AWS Well-Architected Assessment

### Operational Excellence

**Strong.** Three signals are structured and correlated: `logEvent` emits one JSON object per line
with a correlation id; `loggingFormat: JSON` with `applicationLogLevelV2: INFO` /
`systemLogLevelV2: WARN` is set on all three functions, so Lambda's own `START`/`END`/`REPORT` lines
are queryable too — the comment explains that an Insights query filtering on a correlation id
silently skipped them before. API Gateway access logs carry identity and outcome (`actorSub` from the
authorizer claims) and never a payload; `dataTraceEnabled` is explicitly off with the reason.

The dashboard is three rows ordered the way an incident is diagnosed — what the user got, which layer
produced it, what the model was doing — and the agent row is *omitted* when agent observability is
off, because "a widget charting a namespace nothing writes to renders as a flat line at zero, which
reads as 'the agent is idle' rather than 'this was never switched on'". That reasoning is better than
most production dashboards get.

`infra/README.md`'s Troubleshooting section is a real runbook: five failures, each with the exact
error text, the diagnostic command, a table mapping output to meaning, and the fix. Four of the five
are non-obvious AWS behaviours (Transaction Search being three settings applied asynchronously; the
1% default indexing rule; a delivery source's immutable `resourceArn` that CloudFormation does not
declare create-only; `logs:PutDataProtectionPolicy` needing four further actions).

**Gaps:** no CD pipeline — `deploy` runs from a developer's machine against ambient credentials, and
the README says so rather than hiding it. CI never runs `cdk synth`, so "a template that synthesizes
but describes the wrong resource" is uncaught; the stated reason for that (Docker) does not hold —
see DOC-04. No deployment strategy beyond CloudFormation rollback, no canary, no documented rollback
runbook. Tagging is one key (`Project`) applied app-wide, which is sufficient here and correctly
noted as requiring manual activation in Billing before it becomes a cost dimension.

### Security

**IAM, as synthesized.** I parsed all four pilot-posture templates. Every `Resource: "*"` that
remains is one AWS gives no alternative for, and each is annotated:

| Statement | Scope | Assessment |
|---|---|---|
| `ecr:GetAuthorizationToken` | `*` | Unavoidable; the *pull* actions are scoped to the asset repository |
| `xray:PutTraceSegments`, `PutTelemetryRecords`, `GetSamplingRules`, `GetSamplingTargets` | `*` | Unavoidable |
| `cloudwatch:PutMetricData` | `*` + `StringEquals cloudwatch:namespace = bedrock-agentcore` | Correctly conditioned |
| `logs:CreateLogDelivery`, `PutResourcePolicy`, `DescribeResourcePolicies`, `DescribeLogGroups` | `*` | Documented as AWS's own prescribed resource for the audit half of a data-protection policy, with the failure message it produces when absent |
| `bedrock:InvokeModel*` | one foundation model + its inference profile | Both ARN shapes, correctly — naming only one denies every call |
| `bedrock:ApplyGuardrail` | this guardrail | A wildcard would let the container name a guardrail with every filter off |
| `bedrock-agentcore:*` (runtime) | `CreateEvent`, `ListEvents`, `GetEvent` on one memory ARN | **No `DeleteEvent`** |
| `bedrock-agentcore:*` (conversations Lambda) | `ListEvents`, `GetEvent`, `DeleteEvent` | **No `CreateEvent`** |
| `dynamodb` (chat) | `UpdateItem` on two tables | No `Query`, no `GetItem` |
| `dynamodb` (conversations) | `Query`, `DeleteItem` | No `UpdateItem` — it cannot rewrite a title |
| `cognito-idp` (admin) | four named actions on this pool | No `cognito-idp:*` |

The runtime's trust policy carries both `aws:SourceAccount` and an `aws:SourceArn` ArnLike condition
— confused-deputy protection that is frequently omitted.

**Trust boundary.** The runtime declares no `authorizerConfiguration`, making it SigV4-only, and
only the chat role holds `InvokeAgentRuntime`. There is no identity pool, so a signed-in browser
holds a token and no AWS credentials. This matters because the identity block the agent trusts is
plain text: a JWT authorizer on the runtime would turn it into client-composable input, and any
signed-in user could name another user's `sub`. Four tests assert the absence in both directions
(no identity pool, no Cognito-federated role, no other `InvokeAgentRuntime` grant, no exported pool
id). This is the single most important decision in the repository and it is correctly identified as
a security boundary rather than a layering preference.

**Encryption.** One customer-managed key with rotation, 30-day pending window, `RETAIN` under
`retainData`, covering AgentCore Memory, both tables, six log groups, the SNS topic and the
guardrail. In transit: HTTPS via CloudFront `REDIRECT_TO_HTTPS`, TLS to all AWS endpoints, SigV4 on
the runtime hop. The site bucket lacks an `aws:SecureTransport` deny policy — low risk behind OAC,
but it is the one at-rest/in-transit control not pinned.

**Secrets.** None in the repository; `.env` gitignored; no `Secrets Manager` usage because nothing
needs one, and `agent-stack.ts` states where a real secret would go. `agent/.env.example` documents
`NODE_TLS_REJECT_UNAUTHORIZED=0` (commented, with a strong warning) — defensible, but it is a
process-wide TLS bypass in a file the README tells people to copy verbatim.

**Gaps:** no secret scanning, no SAST/CodeQL, no IaC policy scan (`cdk-nag` or equivalent), no
container image scanning or SBOM, base image pinned by tag rather than digest, and
`npm run bootstrap` passes `--ignore-scripts` only to the root install.

### Reliability

**Graceful degradation is a deliberate pattern, not an accident.** Every non-essential dependency
degrades rather than failing the turn, and each has a comment saying which trade was chosen: a memory
read failure answers without history ("answering without history is a worse conversation, but
refusing the turn outright is a worse outage"); a memory write failure keeps the answer and logs
loudly; a conversation-index write failure costs a sidebar entry; the email trigger swallows its own
failures so a broken template degrades an email rather than blocking sign-up; the SSM app-URL lookup
caches only successes, so a miss does not persist; the SigV4 span exporter logs and continues rather
than taking the turn down; `RedactingSpanExporter` fails **closed**, dropping a batch rather than
exporting unredacted spans.

`SIGTERM`/`SIGINT` handlers drain in-flight requests and then flush the telemetry batch buffer — the
recycle is exactly when the export interval will not elapse, so flushing after `close()` resolves is
the correct order. A `HEALTHCHECK` is present for runners other than AgentCore, implemented with
`node -e fetch` rather than adding `curl` to a slim image.

The silent-failure class is handled in three places at once, which is the part I would single out: a
failed model or tool call arrives as an ordinary lifecycle event carrying an `error` and does **not**
throw, so the runtime answers 200 and the BFF relays `done: ok`. `agent/src/index.ts` logs
`turn.failed`; `stream-parser.ts` treats an `error` on *any* event as a failure; and a turn that
produces neither text nor a reported error raises `EmptyReplyError` so the user gets a sentence
instead of an empty bubble.

**Gaps:** no PITR and no backup plan on either table — `RETAIN` is not a recovery story, and there is
no documented export path for AgentCore Memory either; single region, no DR; no idempotency on
`POST /chat`; no reserved or provisioned concurrency; no DLQ (defensible — all three functions are
synchronous, so there is no asynchronous invocation to dead-letter); retries rely on AWS SDK defaults
with no explicit `maxAttempts` or per-call timeout on the AgentCore invoke.

### Performance Efficiency

Streaming is end to end and correct: `streamifyResponse` with `HttpResponseStream.from`, the
`ResponseTransferMode.STREAM` integration, an explicit `lambda:InvokeWithResponseStream` permission
scoped to `POST /chat` on the `prod` stage, and SSE framing that splits multi-line payloads into one
`data:` line each per spec. The chat function's 60 s timeout deliberately exceeds the 29 s buffered
integration ceiling because it streams; the other two are pinned *at* 29 s with the reason (longer
only keeps billing after the gateway has returned 504) — that is a distinction most templates get
wrong in one direction or the other.

Right-sizing: chat 512 MB, admin and conversations 256 MB, email trigger 128 MB, all arm64.
`guardLatestUserMessage: true` prevents guardrail cost growing with the square of conversation
length. `MEMORY_MAX_MESSAGES` (40) bounds replayed context. The conversation index exists so listing
costs one `Query` and decrypts no transcript — a privilege property as much as a performance one. The
frontend code-splits `AgentMarkdown` into its own 158 KB chunk, keeping the entry bundle at 411 KB
(126 KB gzipped).

The module-level `BedrockModel` is shared (one connection pool, no TLS handshake per call) while the
`Agent` is created per request — the comment explains that a reused `Agent` accumulates `messages`
across callers on a warm container. That distinction is exactly right and is the kind of thing that
produces a cross-user leak when got wrong.

**Gaps:** no load testing evidence; no cold-start mitigation; the browser has no `AbortController`,
so a hung stream leaves the UI "thinking" with no way to cancel.

### Cost Optimization

**Strong on structure, weak on the per-request ceiling.**

Structure: no NAT gateway, no VPC endpoints, no idle compute, on-demand DynamoDB, arm64 everywhere
(~20% cheaper per GB-second), `PRICE_CLASS_100`, immutable caching on hashed assets with `no-cache`
only on the two files whose names never change, log retention bounded (1 month on Lambda/API groups;
telemetry matched to conversation retention; masking findings at 1 week because "these are findings to
act on, not a second copy of the data to keep"). Metrics go out as EMF to a log group the stack
already owns rather than through `PutMetricData` — cheaper *and* a narrower grant, since
`PutMetricData` cannot be scoped to a resource. Every billed control is opt-in with the billing
reason at the resolver, and the ADOT layer is gated on `tracingEnabled` so it cannot export telemetry
a deployment declared it did not want.

**The gap.** Under adversarial or merely careless use, the bound on a single request's model spend is
nothing. `createAgent` passes no `limits`; `BedrockModel` sets no `maxTokens`. A caller within quota
(20 requests/minute) can issue requests that each drive an unbounded number of model calls. The
budget notifies at 80% and 100% of a monthly, account-wide ceiling — after the fact. The controls
that do exist bound frequency and input size, which is the wrong axis for a reasoning loop.

### Sustainability

Consistent with cost. arm64 on all four compute surfaces, no over-provisioning, serverless with no
idle draw, one memory event per *turn* rather than per message, transcripts fetched only when opened,
bounded retention on every log group and both tables, and `nearestRetention` rounding up rather than
keeping telemetry indefinitely. The one deliberate inefficiency — deleting conversation events one at
a time — is the only granularity the API offers, and the alternative (letting retention expire them)
is not the deletion a user asked for.

---

## 8. Agentic AI Lens Assessment

Assessed against the AWS Well-Architected Agentic AI Lens dimensions that apply to this system.

### Agent scope and bounded autonomy — **Partial**

Scope is tight and honest: one agent, two read-only tools, no side effects, no external integrations,
no multi-agent coordination, no MCP, no A2A. The system prompt is short on purpose — "a long prompt
tuned to one product is the first thing a new project has to unpick".

Autonomy is **not** bounded in the execution sense. The SDK exposes `limits: { turns, outputTokens,
totalTokens }` and documents that omitting them means no limit; the template omits them. There is
also no `AbortSignal` wired from the HTTP request, so a client disconnect does not cancel the loop.
The AgentCore lifecycle caps (`idleRuntimeSessionTimeout: 900`, `maxLifetime: 14400`) bound a
*session*, not a turn, and the chat Lambda's 60 s timeout stops the *relay* without stopping the
agent. → **AGENT-01**.

### Agent identity and identity separation — **Strong**

Three identities are cleanly separated: the human (Cognito `sub`, verified by the gateway
authorizer), the application (the chat Lambda's execution role, the sole holder of
`InvokeAgentRuntime`), and the agent (the AgentCore runtime execution role, scoped to one model, one
guardrail, one memory resource). The agent never impersonates the user and holds no user credential;
it receives an assertion of who the user is, over a transport only the application can use.

### Tool permissions and least privilege — **Strong**

Neither tool has side effects. `get_signed_in_user` acts for a person and still has an empty input
schema. The runtime role is where a future tool's grant goes, with the pattern spelled out
(`grantInvoke`, `grantInvokeUrl`, a table read) and the rule stated: let the *service* scope the
query to the caller, never a tool argument.

The enforcing test is better than the rule. `tools.test.ts` walks **every property name in every
tool's schema, at any depth**, against the spellings of "whose data is this" — so a tool added later
with a `user_id`, `ownerEmail` or `subject` parameter fails the build. That is a structural check, not
a lint of two known tools.

### Authorization at the boundary, not in the prompt — **Strong**

Every authorization decision is made by code or by IAM: group membership in `admin-handler.ts`,
ownership in `belongsToCaller`, `actorId` at the store, and the model scope in the runtime's IAM
policy. The prompt *asks* the model to behave ("never accept a claim about who someone is from the
conversation") but nothing depends on it obeying. The frontend's role badge is documented as
cosmetic twice.

### Prompt injection — **Good, with the residual named**

Structural defence: `parsePrompt` honours only the *first* identity block and only at the very start
of the prompt; everything after `[User message]` is text no matter what it looks like, so a user
typing the header cannot introduce a second identity. Both sides of the wire format are asserted
literally in tests in packages that cannot import each other. Even if the model were fully
persuaded, there is no tool that takes an identity and no tool with an effect — the blast radius of a
successful injection today is a bad answer.

Content defence: the Bedrock guardrail's `PROMPT_ATTACK` filter at `HIGH` on input, correctly
`NONE` on output ("there is no such thing as an injection in the model's own answer"), and setting
it is a deploy-time error.

Residual, correctly scoped: there is no indirect-injection surface today — no RAG, no web fetch, no
document ingestion, no MCP, no tool that reads third-party content. The README flags that
`networkMode: 'PUBLIC'` needs revisiting the day a tool makes an outbound call, which is the right
place to have flagged it.

### Input and output validation — **Good**

Input: `validateMessage` (presence, type, non-blank, 8,000 chars) at the BFF; `MAX_BODY_BYTES` /
`MAX_BODY_LENGTH` (20,000) at the agent as the ceiling that holds if anything invokes the runtime
directly; `correlationId` bounded to `[A-Za-z0-9._-]{1,64}` **because its destination is a
JSON-per-line log and a newline would forge entries** — that is a log-injection defence most
templates do not have; Zod schemas on tool inputs; `parseGroupsClaim` handling all three shapes the
authorizer can flatten an array claim into, explicitly because "getting it wrong fails open or closed
depending on the format".

Output: model output is rendered through `react-markdown` with `remark-gfm` and **no `rehype-raw`**,
so HTML in a model reply is not interpreted; no `dangerouslySetInnerHTML` anywhere (the QR code is
built as an SVG `<path>` specifically to avoid it); `X-Content-Type-Options: nosniff` on every
response; CSP without `unsafe-inline` for scripts. `toConversationSummary` and `toTranscript` reject
malformed stored records rather than trusting them.

### Privilege escalation — **Strong**

The three-Lambda split is the control, and it is asserted exhaustively: the chat role's action set is
enumerated by test, so a new grant on it turns the suite red. A compromise of the function that
relays untrusted model output reaches `InvokeAgentRuntime` and `UpdateItem` on two tables — it cannot
read a conversation, cannot delete one, cannot create a Cognito user, and cannot write history. The
stated reason is the right one: "a browser-reachable function that could forge history is worse than
none, because a forged transcript is believed."

### Human oversight and reversibility — **Partial, proportionate today**

No tool takes an irreversible action, so no approval gate is needed *yet*. Where the *user* takes an
irreversible action, it is handled: conversation deletion requires a browser `window.confirm`
(deliberately the browser's own dialog, so it cannot be mistaken for page content), deletes content
before the index row so an interruption cannot orphan content, and writes an audit line naming the
human.

What is missing is the **hook**. `AGENTS.md` tells a coding agent where a new tool goes and that it
must not take a user id, but says nothing about confirmation, dry-run or approval for a tool that
*mutates*. The first fork to add a write tool has no pattern to copy. → **AGENT-04**.

### Non-determinism, evaluations and goal alignment — **Weak. The largest gap.**

There is no evaluation capability of any kind: no golden set, no regression harness, no LLM-as-judge,
no tool-selection accuracy check, no refusal-rate or injection-resistance suite, no offline replay
over stored turns. The 419 tests are all deterministic and none exercises model behaviour.

The one behavioural test is a **prompt-reminder** rather than a quality check: it asserts the prompt
names every registered tool. `AGENTS.md` is admirably clear that this is not a boundary. But it means
a prompt edit that degrades tool selection, changes refusal behaviour or breaks the "reply entirely
in the user's language" rule ships with a green suite. → **AGENT-02**.

### Prompt lifecycle and versioning — **Absent**

The system prompt is a template literal exported from `agent/src/agent.ts`. It carries no version or
hash, is not stamped on any span, and is not resolved from a store — so a trace cannot answer "which
prompt produced this answer", and a rollback is a code deploy. The guardrail, by contrast, is pinned
to an immutable numbered version whose logical id carries a hash of the policy *precisely so that an
edit forces a new version* — the reasoning is right there in the same repository, applied to the
guardrail and not to the prompt. → **AGENT-03**.

### Tracing, auditability and decision observability — **Strong. Best-in-class for a template.**

The full chain is reconstructable, and I can name the mechanism for each hop:

| Hop | Mechanism |
|---|---|
| Browser → BFF | `X-Correlation-Id` minted in the browser (`crypto.randomUUID`), echoed on the response and exposed via CORS so the UI can show it |
| API stage → Lambda | `tracingEnabled` on the stage makes it the trace root, so the gateway's own latency is visible |
| Lambda internals | ADOT layer (`AWSOpenTelemetryDistroJs`, collectorless, pinned v15) instruments the AWS SDK — without it DynamoDB and Cognito are invisible and AgentCore renders as `UnknownRemoteService` |
| BFF → agent | `traceparent` propagated by the instrumentation (**not** hand-injected — the comment records that hand-injection broke SigV4, because the SDK signs `X-Amzn-Trace-Id`/`traceparent` and the instrumentation rewrites them after signing); `baggage` carries the correlation id |
| Inside the agent | `withRemoteContext` extracts the parent so the agent's spans join the same trace; Strands emits GenAI-convention spans; `session.id` and `correlation.id` are stamped as trace attributes |
| Agent → Bedrock/Memory | `instrumentation.ts` preloaded via `node --import`, so the AWS SDK is patched before any client resolves — the ordering is asserted by test, and the comment records it was *measured* (imported: zero spans; preloaded: one) |
| Spans → CloudWatch | SigV4-signed OTLP to `xray.<region>.amazonaws.com/v1/traces`, directed by header into the deployment's own log group so retention, the CMK and the masking policy reach them |
| Metrics | EMF to the same log group: tokens in/out, tool call and error counts, tool duration, model latency, time-to-first-token, DELTA temporality so a token graph does not only climb |
| Stored turn | `recordTurn` files the correlation id as event metadata, so the id a user quotes locates the exact exchange without searching by timestamp |

Two details show real operational experience: `suppressTracing` around the exporters' own AWS calls
(otherwise telemetry-about-telemetry grows without bound and a batch never settles), and
`envDetector` used to build the resource because `resourceFromAttributes` does not read
`OTEL_RESOURCE_ATTRIBUTES` — which had silently dropped `aws.log.group.names`, the attribute that
offers a span's surrounding log lines.

**Sensitive data in telemetry** is layered with the blind spots named: origin redaction of tool
arguments and results (keyed on `gen_ai.operation.name === 'execute_tool'`, not on the presence of a
tool name, because the *model* span of a turn that chose a tool also carries that name and its prompt
is meant to survive), destination masking via a data-protection policy on both log groups, and the
deliberate decision to keep model prompt and completion — because a trace that cannot reconstruct the
decision is the anti-pattern the Lens itself names. The masked-identifier list is short and the
reason is empirical: ten identifiers produced masked Portuguese prose, a masked bind address, and a
masked span-attribute *name* that the GenAI console reads to tell an LLM span from a tool span.

### Memory, state and data protection — **Strong**

Managed service rather than hand-rolled storage, so encryption and retention are resource properties.
Isolation by `actorId` on every read. Only user/assistant text stored. `AsyncLocalStorage` for
per-request caller identity. A fresh `Agent` per request. The one thing absent is a documented
backup/export path for AgentCore Memory — a pilot asked "restore this conversation" has no answer.

### Failure behaviour — **Good**

| Failure | Behaviour |
|---|---|
| Model denied/throttled | Arrives as an event with `error`; logged as `turn.failed` with the correlation id; the parser reports it; the UI quotes the server's sentence (which names the real problem) appended to whatever text arrived |
| Tool returns badly | Tool errors are returned as `{ error }` for the model to recover from (invalid timezone), or produce a lifecycle `error` the parser catches |
| Output invalid/empty | `EmptyReplyError` — the silent-failure shape is named rather than rendered as a blank bubble |
| Agent loops | **Nothing stops it.** The relay times out at 60 s; the loop does not |
| Memory unavailable | Read: answer without history. Write: keep the answer, log loudly |
| Guardrail intervenes | Redacted on input and output; the redacted text is what is stored, because the turn is taken from the agent's message array rather than reassembled from the stream |
| Telemetry backend refusing | Logged and continued; redaction failure drops the batch rather than exporting unredacted |
| Container recycled | `SIGTERM` drains, then flushes telemetry |

---

## 9. Security & Sensitive Data Assessment

Threat model proportional to the system, against the requirement of a closed pilot with real data.

| Threat | Posture | Basis |
|---|---|---|
| Authentication bypass | **Mitigated** | Cognito authorizer on **every** method — the test enumerates methods rather than listing known routes, so a new route cannot be born unauthenticated. SRP only; `userPassword: false` |
| Broken authorization | **Mitigated** | Group check in the handler, not the UI; denial paths assert no AWS call was made |
| IDOR / cross-user read | **Mitigated ×2** | `belongsToCaller` (namespace + minimum length, so a bare namespace cannot match all of a caller's sessions) **and** `actorId` derived independently at the store. `404` not `403` |
| Tenant escape | **Mitigated** | Single-tenant per deployment; user partition is `USER#<sub>` in DynamoDB (no filter to get wrong — the wrong rows are in a different partition) and `actorId` in memory |
| Privilege escalation | **Mitigated** | Three roles split by capability, chat role's action set asserted exhaustively |
| Secret leakage | **Low** | No secrets in the repo; `.env` ignored; no secret scanning in CI (gap) |
| Sensitive data in logs | **Mitigated** | `logEvent` never logs message content ("conversation content has a storage location with a declared retention, and a log group is not it"); `actorSub` never email; `dataTraceEnabled` off; data-protection policy on both agent log groups |
| Sensitive data in prompts | **Accepted, layered** | The identity block carries email and display name by design; `span-redaction.ts` strips it from spans defensively even though `parsePrompt` already removes it |
| Sensitive data in traces | **Mitigated, honestly bounded** | Two-layer redaction; the README states guardrail `ANONYMIZE` is unreliable on a streamed response and gives an observed example |
| Sensitive agent memory | **Mitigated** | CMK, `eventExpiryDuration`, `actorId`, user-initiated deletion that removes content before the pointer |
| Insecure direct tool access | **N/A** | Tools are in-process; no tool endpoint exists |
| Prompt injection (direct) | **Mitigated structurally** | See §8. No tool takes identity; no tool has an effect |
| Indirect prompt injection | **N/A today, flagged** | No external content ingestion |
| Malicious tool output | **N/A today** | Both tools return code-generated values |
| Data exfiltration | **Constrained** | CSP `connect-src` lists only `execute-api` and `cognito-idp` for the region — the AgentCore host is deliberately absent "because the browser has no transport to it, and listing it would widen exfiltration". No tool makes outbound calls |
| SSRF | **N/A** | No URL is fetched from user or model input |
| Arbitrary code execution | **N/A** | No `eval`, no dynamic `require` of untrusted input, no shell-out |
| Vulnerable dependencies | **Clean at the gate** | `npm audit --audit-level=high` passes; one *low* dev-only `esbuild` advisory |
| Supply chain | **Good, one inconsistency** | Five lockfiles; actions pinned by SHA with `permissions: contents: read` and `persist-credentials: false`; `--ignore-scripts` only on the root install (**SEC-04**); base image pinned by tag not digest |
| Overly permissive CORS | **Demo-only, gated** | `ALLOWED_ORIGIN=*` is the documented first-deploy default (the CloudFront URL does not exist yet) and the gate refuses it under `pilot`/`prod`. `resolveOrigin` reflects only listed origins; no `Allow-Credentials`, bearer header not cookie |
| Missing rate limits | **Mitigated for frequency** | Stage throttle + per-caller conditional-update quota + optional WAF per-IP rule. **Not** mitigated for per-request cost (**AGENT-01**) |
| Replay attacks | **Partially** | 1 h token validity, `preventUserExistenceErrors`, `admin-user-global-sign-out` documented. No nonce/idempotency on `POST /chat` |
| Webhook authentication | **N/A** | No inbound webhooks |
| Unsafe defaults | **Deliberate and gated** | Every sandbox default is named in `.env.example` and refused under `pilot`/`prod`; verified by running the gate |
| Insecure debug configuration | **Low** | `dataTraceEnabled` off; no debug endpoints; `NODE_TLS_REJECT_UNAUTHORIZED=0` documented-but-commented in two `.env.example` files |
| Token storage (XSS) | **Accepted, mitigated** | Amplify keeps tokens in `localStorage`; the CSP closing the injection point is documented as the compensating control, and it is real (`script-src 'self'`, no `unsafe-inline`, no `rehype-raw`) |

**No authentication-bypass, tenant-escape or exfiltration blocker was found.** The blockers for a
sensitive pilot are availability-of-recovery (no PITR/backup) and bounded autonomy (unbounded loop
and token spend), not access control.

---

## 10. Architecture & Code Quality

### Separation of responsibilities

The dominant pattern is **pure logic separated from I/O**, applied consistently:

| Pure | I/O | What the split buys |
|---|---|---|
| `admin.ts` | `admin-handler.ts` | The authorization rule is unit-testable without a Cognito mock |
| `conversations.ts` | `conversations-handler.ts` | Routing, key layout and transcript projection tested against plain objects |
| `config.ts` | `app.ts` | The profile gate is tested without synthesizing |
| `session.ts`, `session-context.ts` | `handler.ts` | The ownership rule and the wire format are testable in isolation |
| `emf-metrics.ts` `toEmfRecords` | `EmfMetricExporter` | The OTel→EMF mapping is asserted without a log client |
| `markdown.ts`, `stream-parser.ts` | React components | 238 + 122 tests over streaming edge cases, no DOM needed |

This is why a 419-test suite runs in ~40 s with no mocking framework beyond `vi.fn()`, and it is the
structural decision I would most want a fork to preserve. `AGENTS.md` says so explicitly.

### Coupling, cohesion, contracts

The interesting case is the identity block, a contract between two packages that **cannot** import
each other (the agent's Docker build context is its own directory). Rather than pretend, the
repository restates it on both sides and asserts the literal wire format in each — `session-context.test.ts`
*emits the agreed block*, `caller.test.ts` *parses the exact block the BFF emits*. Same treatment for
`ACTOR_ID_LENGTH` / `SESSION_NAMESPACE_LENGTH` (16, asserted in both packages) and `ADMIN_GROUP` /
`LOCALE_ATTRIBUTE`. This is the right answer to a real constraint, and each duplication is annotated
with why it cannot be an import.

Cross-stack coupling is handled with care: `appUrlParameterName` is a plain string function
deliberately, "not a construct: importing it elsewhere creates no cross-stack reference, only
agreement on a parameter name" — which is what breaks the auth↔frontend cycle. `agent` depends on
nothing from `auth`, and that absence is the transport boundary.

### Error handling, contracts, idempotency, retries, timeouts

Error handling is a stable code contract (`errors.ts`: ten `ErrorCode`s, `{ code, error }`) where
`code` is what the client localizes and `error` is the English fallback for a failure that never
reached a handler. This keeps server-side i18n out of the system entirely — adding a language touches
only the frontend catalogs. Genuinely good design.

Timeouts are reasoned per function against the 29 s buffered integration ceiling. Retries rely on AWS
SDK defaults, with no explicit `maxAttempts` or per-call timeout on the AgentCore invoke — acceptable,
worth pinning. Idempotency is absent on `POST /chat`; a retried request duplicates a stored turn and
bumps the index. The rate-limit and index writes *are* idempotent-by-construction (conditional
`UpdateItem`, `if_not_exists` on title and creation time — which is why no read is needed to decide
whether a conversation is new).

Concurrency and state are handled correctly at the two places it matters: `AsyncLocalStorage` for
per-request caller identity, and a fresh `Agent` per request. `withCaller` wraps the **whole**
iteration of the stream rather than its creation, because "a generator's body inherits the context
active while it is *iterated*" — and a test pins exactly that.

### Substitutability and removability

Strong. `SpanExporter`/`PushMetricExporter` interfaces mean the telemetry backend is swappable;
`RedactingSpanExporter` is a decorator, chosen over a `SpanProcessor` specifically so the guarantee is
positional rather than dependent on registration order. `createTools()` returns an array. `Message`
history is an injected parameter. Removing a feature is cheap and the seams are obvious: drop the
guardrail (unset two variables), drop conversations (delete one Lambda and three routes), drop the
admin panel (delete one Lambda and two routes), drop i18n (one directory), drop MFA (one variable).

### Code quality, measured

- **Zero** `TODO`/`FIXME`/`XXX`/`HACK` across the repository.
- **Zero** `@ts-ignore` / `@ts-expect-error`. **One** `eslint-disable`, for an unused Lambda `_context`
  parameter required by the signature.
- **Zero** `: any` in source (the only `any` matches were the word "any" inside prose comments).
- No commented-out code blocks. No dead modules found — every file is imported by something or is an
  entrypoint.
- Strict TypeScript everywhere; `tseslint.configs.strict`; `tsconfig.base.json` shared.
- No duplicated logic beyond the four annotated cross-package constants.

### Where I disagree with the design

Two small things, neither structural:

- `chatbot-frontend/src/lib/api.ts` re-implements SSE envelope parsing that `bff-client.ts` does not
  cover, and it constructs a synthetic `new Response(agentCoreStream)` to hand to
  `parseAgentCoreStream`. It works, but the `fakeResponse` indirection exists only to satisfy a
  signature that could take a `ReadableStream` directly.
- `ChatExperience.send` mints `crypto.randomUUID()` as a session id when none exists; the BFF always
  rejects it (it carries no namespace) and returns a real one via the `session` event. Harmless, but
  the local variable is dead by design and reads as if the client were choosing the id.

---

## 11. Template & Developer Experience

### Bootstrap / Time to First Value

A newcomer can answer the eight questions from the README alone:

| Question | Answered | Where |
|---|---|---|
| What is this? | Yes | Root README, first three lines, plus a "What you get" table |
| Prerequisites? | Yes | Node 22+, npm 10+, Docker+Buildx, AWS credentials, AgentCore + model access |
| Run locally? | Yes | Per-package README, with the local BFF's limitation stated |
| Deploy? | Yes | Four commands, with the two `bootstrap`s disambiguated |
| Where to customise? | Yes | "Making it yours" table (6 rows) |
| What is opinionated? | Yes | "Deployment profiles" + "What this template leaves open" |
| What is example? | Yes | `AGENTS.md` "Replace freely" (6 rows), agrees with the README |
| What is production-oriented? | Yes | `AGENTS.md` "Preserve" (11 invariants, each with its test) |

**Implicit knowledge required is low but not zero.** Three things a newcomer must absorb: npm
workspaces are *not* used (stated in three places, because `npm ci` at the root leaves four packages
empty); Transaction Search is an account-level prerequisite the template will not enable; and the
Bedrock Marketplace agreement is a one-time out-of-band step. All three are documented; the third is
the only one that produces a confusing failure after a green deploy, and it has its own README section.

**The friction I would actually hit:** enabling agent telemetry locally. `agent/.env.example` — which
the root README calls "the source of truth for every variable" — documents
`OTEL_EXPORTER_OTLP_ENDPOINT` as the switch, and the code no longer reads it. The variable that works
(`AGENT_OBSERVABILITY_ENABLED`) does not appear in that file at all.

### Reusability

The example domain is genuinely thin: two tools (~90 lines), one ~35-line system prompt, one brand
file (14 lines), one token stylesheet. Everything else is scaffolding a real project keeps.

What makes it reusable beyond thinness is that the invariants are **guarded rather than described**.
`AGENTS.md` pairs each of eleven invariants with the test that asserts it *and* names the attack it
prevents. That converts "please don't break this" into "you cannot break this quietly", which is the
only form of guidance that survives contact with a coding agent or a hurried human.

`PROJECT_NAME` prefixes every stack and resource name, and `DEPLOY_ACCOUNT`/`DEPLOY_REGION` pin the
target, so deploying to another account or region is a configuration change. Two deployments cannot
share an account+region — correctly noted, since names would collide.

### Complexity / Overengineering

I looked specifically for premature abstraction and found very little. Assessment by component:

| Component | Verdict | Reasoning |
|---|---|---|
| Profile gate (`config.ts`, 19 KB) | **Necessary foundation** | It is the mechanism the whole demo→pilot claim rests on. Verified working |
| Three Lambdas instead of one | **Necessary foundation** | The privilege split *is* the security property, and it is asserted |
| Conversation index alongside memory | **Necessary foundation** | Listing without decrypting a transcript; `SessionSummary` carries no title or recency |
| One CMK for everything | **Good simplification** | Explicitly chosen over per-service keys |
| `otlp-sigv4.ts` (8 KB, hand-rolled SigV4) | **Justified, reluctantly** | The stock exporter does not sign and CloudWatch's endpoint requires it; subclassing would reach into internals. ~40 lines of that file is a `Sha256` shim to avoid a dependency that would drag in a vulnerable transitive |
| `emf-metrics.ts` (8 KB) | **Justified** | CloudWatch's metrics OTLP endpoint feeds PromQL, not the alarmable metrics a dashboard needs |
| `governRuntimeLogGroup` (4 custom resources) | **Justified but heavy** | The log group AgentCore creates is otherwise ungoverned; a CDK `LogGroup` cannot adopt it. Four sequential `AwsCustomResource` calls each carry the same four-action `*` policy |
| `markdown.ts` table repair (159 lines) | **Borderline** | Solves a real streaming defect, well tested (122 tests), but it is domain polish every fork inherits and few will read |
| i18n layer, dependency-free | **Good extension** | ~200 lines including CLDR pluralization via `Intl.PluralRules`, no dependency |
| MFA/TOTP + QR code | **Good extension** | Needed the moment the gate requires `COGNITO_MFA=required` |
| UI kit (13 primitives) | **Good extension** | Small, and it is what makes the two-file rebrand claim true |
| `docs/assessment.md` (75 KB) | **Should not ship** | Upstream self-review, inherited by every fork, referenced by seven production comments |

Asking "does this need to be in the base template?" of each: I would answer no only for
`docs/assessment.md`, and *maybe* for the markdown table repair. That is a very good ratio.

### Code Comments

This deserves a direct answer because the volume invites the question.

**Measured:** 6,772 non-test code lines to 2,368 comment lines — **35% overall**, and **65% in
`agent/src`** (800 code / 523 comment). Several block comments run 20–30 lines.

**Quality: high.** These are overwhelmingly *why* comments, and a large share record something that
was measured or observed rather than reasoned:

- "Measured, not assumed — registering after a static `import` of `@aws-sdk/client-cloudwatch-logs`
  produces zero spans, against one when the import follows registration."
- "the account showed five service records against 351 lines of stdout over the same hour."
- "ordinary Portuguese prose came back as `"pode me ********** pergunta real"`, the bind address
  `0.0.0.0` was masked as an IP address, and the span attribute whose values are `LLM` and `AGENT`
  arrived with its *name* masked, in six of nine spans."
- "`logGroupArn` already ends in `:*`... Appending another — as this did — renders `...:*:*` and
  matches nothing."
- "spreading it copies own properties but not prototype methods, and the OTLP serializer calls
  `span.spanContext()` on the result... so the redaction was working and the telemetry was silently
  going nowhere."

Comments like these are worth more than the code they annotate: each is a defect someone paid for
once. I found **no** comment that merely restates its line, no AI-flavoured filler, no stale TODO, no
commented-out code.

**The real cost, and it is measurable.** A 2,368-line untested prose surface drifts, and it has:

1. **Five comments describe conversation storage as S3** — `session.ts:25` ("everything under
   `<namespace>-` in the bucket belongs to one person"), `session.ts:34` and
   `conversations-handler.ts:13` ("a session id names an S3 prefix"), `conversations.ts:87` ("a TTL
   matched to the bucket's lifecycle rule"), `session-context.ts:39` ("persisted to the session
   snapshot"). Storage is AgentCore Memory plus a DynamoDB index; there is no bucket, no prefix and no
   lifecycle rule. These are the comments a reader consults to answer "where does user data live",
   which is the worst place for a five-instance inaccuracy.
2. **`agent/Dockerfile:36`** — "a deployed runtime writes its session snapshots to S3, not to disk" —
   is the justification given for `USER node`. The conclusion is right; the premise is gone.
3. Three comments and one `.env.example` section describe the retired telemetry gate.
4. Seven comments reason from `docs/assessment.md`.

**Conclusion:** the repository is *not* over-commented in the sense the question usually means — there
is almost nothing that should be replaced by a better name. It *is* commented at a volume that
requires maintenance discipline, and the discipline has slipped in nine places in one refactor (the S3
→ AgentCore Memory move). The right remedy is not fewer comments but a review pass whenever storage or
telemetry moves, and possibly moving the longest architectural essays (the ~35-line notes in
`agent-stack.ts` on `governRuntimeLogGroup` and `MASKED_IDENTIFIERS`) into `infra/README.md` where
they are already half-duplicated.

### Configuration

Four `.env.example` files carry the reasoning, not just the name — what a default is, what it bills
for, and whether the gate refuses it. `CONTRIBUTING.md` makes that paragraph part of the definition of
done for a new variable. Every resolver validates and throws on an unrecognized value ("every caller
governs something a silent default gets wrong"), except the two that run at Lambda cold start
(`resolveRateLimitConfig`, `resolveRetentionDays`), which fall back silently — with the reason stated:
throwing there takes the chat route down.

The runtime-config indirection is right: deployed values arrive as `config.js` written at deploy time
and read from `window.__APP_CONFIG__`, so the SPA bundle is not rebuilt per environment, with
`import.meta.env` as the local fallback.

Two configuration weaknesses: the drift in `agent/.env.example`, and five variables that must be kept
in sync by hand across packages (each annotated, three covered by tests, but `MAX_MESSAGE_LENGTH` ↔ the
input's `maxLength={8000}` is annotated and **not** tested). The root `package.json` pinning
`typescript@^6.0.3` while the four subpackages pin `^7.0.2` looks like a third and is not — it is the
ceiling `typescript-eslint` imposes (see TPL-02); the only thing missing there is a comment saying so.

### Extensibility

The four extension points are each documented with the rule that keeps them safe:

- **A tool** → `tools.ts`, read the caller from `currentCaller()`, register conditionally on its
  configuration, grant on the runtime role. Enforced by a schema-walking test.
- **A consequential route** → its own Lambda, like `admin-handler.ts`. Enforced by the exhaustive
  chat-role assertion.
- **A data layer** → a new stack ahead of `agent` and `bff`, with two rules: grants on the consumer's
  identity policy (so the dependency stays one-directional) and the narrowest verb that works. The
  existing `dynamodb:UpdateItem`-only grant is the worked example.
- **A variable** → the relevant `.env.example` with the reasoning paragraph.

What is *not* provided and would be the first thing I add: a pattern for a tool that mutates state
(approval, dry-run, audit), and a pattern for evaluating a prompt change.

---

## 12. Documentation & Artifact Consistency

### Inventory

| Artefact | Size | Role | Assessment |
|---|---|---|---|
| `README.md` | 2,728 words | Root: architecture, profiles, testing, what is left open | Excellent; two numeric drifts |
| `AGENTS.md` | 1,649 words | Coding-agent guidance | Excellent; one incorrect technical claim |
| `CLAUDE.md` | 2 lines | Pointer to `AGENTS.md` | Correct — "one file, so the guidance cannot drift between agents" |
| `CONTRIBUTING.md` | 665 words | Setup, gate, scope | Good; repeats the same incorrect claim |
| `SECURITY.md` | 468 words | Scope of a vulnerability | Unusually well-reasoned (see below) |
| `CODE_OF_CONDUCT.md` | — | Standard | Fine |
| `infra/README.md` | 3,582 words | Operational runbook | The best document in the repository; one numeric drift |
| `agent/README.md` | 1,117 words | Agent internals, telemetry, tools | Accurate and matches the code |
| `chatbot-bff/README.md` | 906 words | Transport boundary, guarantees | Accurate; the canonical statement of the boundary |
| `chatbot-frontend/README.md` | 727 words | Rebranding, transport, i18n | Accurate |
| `docs/assessment.md` | 11,371 words | Upstream self-review | Should not ship in a template |
| `infra/.env.example` | 9.2 KB | Configuration reference | Accurate and reasoned |
| `agent/.env.example` | 3.1 KB | Configuration reference | **Documents a retired gate; omits the live one** |
| `chatbot-bff/.env.example` · `chatbot-frontend/.env.example` | — | Configuration reference | Accurate |
| `media/architecture.drawio` + 2 PNGs | — | Diagram, light/dark | Present and referenced with `<picture>`; source file included, which is right |
| `.github/` (ci, dependabot, 2 issue templates, PR template) | — | Process | Well-configured |
| Absent | — | ADRs, specs, `.kiro/`, runbooks beyond `infra/README.md`, CHANGELOG, releases | Reasonable for a template; `.gitignore` lists `.kiro/` but none exists |

### Correctness — verified claims

Spot-checked against code and against the synthesized template. Accurate: the profile-gate mechanism;
"no tool takes a user id"; the SigV4-only runtime; no identity pool; the three-way memory grant split;
retention flowing from one variable to memory, index TTL and log retention; the ID-token authorizer
reasoning; "`AgentStack` needs nothing from `auth`"; the ADOT layer family distinction
(`/opt/otel-instrument` vs `/opt/otel-handler`); the `nearestRetention` rounding direction; the WAF
being regional and on the stage; every `npm run *` script; "419 tests, no credentials, no Docker, no
browser".

### Drift found — five instances

| ID | Claim | Reality |
|---|---|---|
| **DOC-01** | `README.md:131` — "`DEPLOY_PROFILE=pilot` refuses **9** sandbox defaults", with a breakdown of 5 + 1 + 3 | The gate refuses **10**; I ran it. `AGENT_OBSERVABILITY_ENABLED` and `TRANSACTION_SEARCH_ENABLED` were both added, and the "last three are evidence posture" arithmetic no longer closes |
| **DOC-02** | `agent/.env.example:29–35` — "Setting this — the standard OTel variable... turns on tracing and metrics export", naming `OTEL_EXPORTER_OTLP_ENDPOINT` | `telemetry.ts` keys on `AGENT_OBSERVABILITY_ENABLED` and never reads `OTEL_EXPORTER_OTLP_ENDPOINT`. `agent/README.md` explicitly documents this gate as *retired*, so the two files contradict each other. `AGENT_OBSERVABILITY_ENABLED` is absent from `agent/.env.example` |
| **DOC-03** | `infra/README.md:112` — `ALERT_EMAIL` "subscribes an address to **the three** CloudWatch alarms" | Seven alarms exist (chat errors, admin errors, API 5xx, chat p95 latency, AgentCore throttles, AgentCore system errors, Bedrock throttles) and all seven get the SNS action |
| **DOC-04** | `README.md:197` and `CONTRIBUTING.md:42` — "`AgentStack` is never synthesized... constructing it builds a real Docker image"; `ci.yml` gives the same reason for CI not synthesizing | **Disproved.** `cdk synth` synthesized all four stacks including `AgentStack` in seconds; the staged asset directory contains only the copied build context (`Dockerfile`, `package.json`, `src`, …) and **no image was built**. CDK builds container assets at publish time, not synth time. The consequence matters: the gap the README itself names — "a template that synthesizes but describes the wrong resource" — is closable in CI today, and the stated obstacle does not exist |
| **DOC-05** | Five source comments describing S3 storage, plus `agent/Dockerfile:36` | No bucket, prefix or lifecycle rule exists for conversations. Detailed in §11 |

### Coherence

Cross-document agreement is otherwise strong and deliberately structured. The transport-boundary
argument is stated **once**, in `chatbot-bff/README.md`, and linked from the root README,
`agent/README.md`, `chatbot-frontend/README.md` and two source comments — "stated once here rather
than repeated per package". `.env.example` is named the single source of truth for configuration and
the READMEs summarize rather than restate. `CLAUDE.md` is a pointer rather than a copy.

One intentional tension is handled well: `CONTRIBUTING.md` argues *against* adding example-domain
features, `AGENTS.md` says adding a domain feature is the point of a fork. Both name the other and
explain that one governs upstream contributions and the other governs forks. That is not a
contradiction; it is a distinction most repositories fail to draw.

`SECURITY.md` is worth singling out: it defines in-scope precisely ("a sandbox default that a `pilot`
or `prod` synth accepts anyway is a vulnerability **in the gate**"), and out-of-scope with a real
argument ("a default the gate already refuses is a design decision, not a finding. A default it
*fails* to refuse is"). That is a scope boundary derived from the architecture rather than boilerplate.

### Hierarchy

Clear and stated: `.env.example` for configuration; `chatbot-bff/README.md` for the transport
boundary; `infra/README.md` for operations; root `README.md` for architecture; `AGENTS.md` for
agent-facing invariants; `docs/assessment.md` for — and this is the problem — nothing a fork needs.

### Agent instructions (`AGENTS.md`) — assessed directly

**Useful:** yes, and specifically so. The "Preserve" table's third column names the *test* that
asserts each invariant, which lets an agent verify rather than obey. "Failures that are not bugs"
pre-empts the four failures most likely to be misdiagnosed as broken tests — including the one
exception that *is* a prompt reminder rather than a boundary, correctly distinguished.

**Specific to this template:** yes. Every row names a real file, a real test and a real attack. There
is no generic "write clean code" filler.

**Up to date:** almost. The eleven invariants match the code. The one incorrect claim is the
Docker/synth one (DOC-04), which is load-bearing for the guidance it gives about the `infra/` suite.

**Redundant rules:** minor and justified — the "no tool takes a user id" rule appears in `AGENTS.md`,
the root README, `agent/README.md` and `tools.ts`. Given that it is the invariant most likely to be
broken by a plausible-looking change, four statements is a defensible choice rather than drift, and
all four agree.

**Over-restrictive?** No. The framing — "If your domain genuinely requires changing one of these,
change it deliberately and say so in the PR — do not edit the test to make the suite pass" — permits
change while forbidding silent change. That is the correct posture.

**Does it induce wrong architectural decisions?** One risk: the OTel invariant is stated absolutely
("No `aws-xray-sdk-*`"), and a fork integrating a library that bundles the X-Ray SDK transitively will
see a red test. The rationale (coherence — "a template that traces one half with X-Ray and the other
with OTel hands every fork two context models to reconcile") is sound and the escape hatch is stated,
so this is acceptable.

**Does it duplicate the README?** Partly, by design — it opens by directing humans to the README and
covers the same six replaceable files. The overlap is the *tables*, not the reasoning, and the two
agree.

**Is essential human information hidden only there?** One item. The "Failures that are not bugs"
section is the clearest statement of what a failing invariant test means, and a human debugging a red
suite would benefit from it — the root README's Testing section covers what the suites are *for* but
not how to read a failure. Minor; worth a cross-link.

**Should anything move out?** No. The content is agent-appropriate: invariants, guard tests, and where
new things go.

---

## 13. Testing, CI/CD & Quality Gates

### What exists

| Gate | Present | Detail |
|---|---|---|
| Lint | Yes | `eslint` flat config, `js.configs.recommended` + `tseslint.configs.strict`, one directory-scoped override for the plain-`.mjs` Lambda |
| Formatting | **No** | No Prettier, no `editorconfig`, no `--check`. Style is consistent by convention only |
| Type checking | Yes | `tsc --noEmit` in all four packages; strict |
| Type-aware lint | **No** | `tseslint.configs.strict` without `strictTypeChecked` or the project service, so rules needing type information are off |
| Unit tests | Yes | **419** across 30 files |
| Integration tests | Partial | Handler-level tests with mocked AWS clients; no live-AWS integration suite (correctly, for a PR gate) |
| Contract tests | Yes | The identity wire format asserted on both sides of a boundary that cannot be crossed by import |
| Infrastructure validation | Yes, in tests | `aws-cdk-lib/assertions` over the synthesized template — 129 assertions including IAM action sets, authorizer coverage, encryption, TTLs, the CSP, and the absence of an identity pool |
| IaC synth in CI | **No** | See DOC-04 — the stated reason does not hold |
| IaC policy scan | **No** | No `cdk-nag`, Checkov or equivalent |
| Dependency scanning | Yes | `npm audit --audit-level=high` in all five packages, gated. The choice of `high` over `critical` is argued |
| Secret scanning | **No** | Neither `gitleaks` nor GitHub's push protection is configured in-repo |
| SAST | **No** | No CodeQL or equivalent |
| Build validation | Yes | `chatbot-frontend`'s `build` runs `tsc --noEmit && vite build`; `infra`'s `pretest`/`presynth` build the BFF and frontend first, so a broken build fails the test run |
| Coverage | **No** | No thresholds, no reporting. Given what the suite covers, an unreported number is defensible |
| Lockfiles | Yes | Five, all committed, `npm ci` everywhere |
| Dependency updates | Yes | Dependabot on five npm directories plus `github-actions`, grouped minor+patch, majors separate |
| Branch/release strategy | Partial | `main` only, Conventional Commits enforced by convention not by hook; `SECURITY.md` states there are no releases yet |
| Deployment safety | Partial | `--require-approval broadening` on `deploy` (stops on any changeset widening IAM or SG rules) — a good default, argued for |
| Rollback | Implicit | CloudFormation rollback only; no documented procedure, no canary |
| Environment promotion | **No** | No pipeline; `DEPLOY_PROFILE` is a posture, not an environment |

### Test quality

The suite is better than its count suggests, for three reasons:

1. **It asserts security properties against the synthesized artefact**, not against intentions. "Gates
   every method on the API behind the Cognito authorizer" **enumerates** methods rather than listing
   known routes, so a route added later is covered without editing the test. "Instruments with
   OpenTelemetry and nothing else" asserts the *absence* of `aws-xray-sdk` rather than the presence of
   a known-good list. "Keeps every privileged grant off the function that relays model output"
   enumerates the chat role's actions exhaustively.
2. **It tests rules and their consultation separately.** `session.ts` and `admin.ts` are tested
   directly; the handlers are tested for calling them *and* for reaching no store when they say no.
   `config.test.ts` covers the gate's rules; `app.test.ts` executes `app.ts` and asserts it refuses —
   so deleting the call is caught. This closes the "a rule that holds in isolation and is never
   consulted protects nothing" gap, which is the most common way a tested authorization rule fails.
3. **Both directions of the gate are covered** — the value accepted and the value refused — which
   `CONTRIBUTING.md` makes a requirement.

Where `AgentStack` cannot be synthesized (on the now-incorrect premise), invariants are asserted by
reading the source. That is a weaker technique, and it is the reason DOC-04 matters: those assertions
could be template assertions instead.

### CI hygiene

Better than most: actions pinned to commit SHAs with the release recorded in a trailing comment
("a tag is a mutable pointer the action's owner can move at any time... which is a
write-access-to-your-CI relationship with every action author"); `permissions: contents: read` at the
workflow level with the reasoning; `persist-credentials: false` so the token is not left in
`.git/config` for anything `npm ci` executes; `timeout-minutes: 20`; npm cache keyed on all five
lockfiles.

### Verdict on quality gates

**Adequate for a template, with three specific insufficiencies** rather than a general one: no
secret scanning, no IaC policy scan, and no `cdk synth` validation despite it being available. They
are not excessive anywhere — there is no ceremony that a fork would have to strip out. Missing a
formatter is a mild DX gap in a repository that will receive contributions from many hands.

---

## 14. Observability & Operations

Can a team answer the operational questions? Assessed one by one.

| Question | Answer | Mechanism |
|---|---|---|
| Is the system healthy? | **Yes** | Dashboard row 1 (requests, 5xx, errors, p50/p95) + seven alarms |
| Which request failed? | **Yes** | Correlation id minted in the browser, echoed on the response, on every BFF log line, in `baggage` to the agent, on the agent's spans, and as metadata on the stored turn |
| Which agent execution failed? | **Yes** | `turn.failed` log line with correlation id and session id; `SystemErrors`/`UserErrors` alarms; GenAI spans |
| Which tool was called? | **Yes** | GenAI-convention spans (`gen_ai.operation.name = execute_tool`) with arguments and results redacted; `GenAiAgentToolCallCount` / `ToolErrorCount` / `ToolDuration` metrics; the UI shows tool badges live |
| How long did each step take? | **Yes** | One trace spanning stage → Lambda → AgentCore → model and memory, because the SDK instrumentation is preloaded. Time-to-first-token and model latency as metrics |
| What did each execution cost? | **Partly** | `GenAiAgentTokensInput`/`Output` per service, in a namespace an alarm can read. Not per user, per session or per conversation — the EMF dimension set is `ServiceName` only, deliberately, "so the metric stays cheap to alarm on" |
| Which model was used? | **Yes** | `BEDROCK_MODEL_ID` on the runtime and in the Bedrock metric dimensions; on spans via GenAI conventions |
| Abnormal token / tool-call growth? | **Detectable, not alarmed** | The metrics exist and are charted; no anomaly detection or threshold alarm on tokens or tool calls |
| Silent errors? | **Handled explicitly** | This is the repository's strongest operational instinct — see below |
| Useful business + technical metrics? | **Yes** | Technical: invocations, throttles, errors, latency, sessions. Business-adjacent: tokens, time-to-first-token, tool calls/errors/duration |
| Actionable alarms? | **Yes** | Seven, each with an `alarmDescription` written as a diagnosis rather than a restatement: "AgentCore is throttling invocations — the deployment is at a service quota, not broken"; "The chat Lambda is slow. Nothing is erroring — users are abandoning the turn instead" |
| End-to-end correlation? | **Yes** | `traceparent` (by instrumentation, not hand-injected) plus `baggage` for the correlation id |
| Can sensitive data appear in traces/logs? | **Bounded, honestly** | Two-layer redaction with each layer's blind spot named; `logs:Unmask` granted to nobody |

**The silent-failure treatment is what I would hold up as exemplary.** The failure mode is real and
subtle: a failed model or tool call arrives as an ordinary lifecycle event carrying an `error`, does
not throw, and the runtime answers 200 while the BFF relays `done: ok`. Left alone, the log group shows
a successful turn and the only evidence is in the browser's event stream. It is addressed at three
layers simultaneously — an error log in the agent, an error check on *every* event in the frontend
parser, and `EmptyReplyError` for a turn that produced neither text nor a reported error — plus three
alarms on precisely the conditions that return 200. Most production systems do not do this.

**Telemetry quality over quantity** is the evident design principle: the dashboard has nine widgets,
not forty ("a page with forty graphs is one nobody reads under pressure"); the agent row is omitted
when the agent is not exporting, because a flat zero line reads as "idle" rather than "never switched
on"; the masked-identifier list was *narrowed* on evidence rather than widened for appearances;
histograms become means rather than four-value statistic sets because "a mean is what a dashboard line
and a latency alarm both read".

**Operational gaps:** no SLO/SLI (Application Signals disabled pending a target); no per-tenant or
per-conversation cost attribution; no anomaly detection on tokens; no synthetic canary; no incident
response runbook (the troubleshooting section is a *deploy*-failure runbook, which is a different
artefact); Transaction Search's 1% default indexing means the trace map is sampled unless raised, which
is documented but is a footgun for anyone diagnosing a specific turn; and CloudFront/S3 access logs are
absent, so there is no record of SPA delivery.

---

## 15. Cost & Scalability

### Cost behaviour by stage

**Demo.** Fixed cost is ~USD 1/month for the KMS key plus negligible CloudFront/S3 and log storage.
Everything else is per-request: Lambda (arm64, 256–512 MB), DynamoDB on-demand, AgentCore per session,
Bedrock per token. Guardrail, X-Ray, agent observability, WAF and Cognito Plus are all off. No NAT
gateway, no provisioned capacity, no idle compute. This is close to the floor for the functionality.

**Pilot.** Turning on what the gate requires adds: Cognito Plus (per monthly active user — flagged
three times because it is the one that surprises people), the guardrail (per text unit), X-Ray (per
trace), and agent telemetry (log ingestion plus Transaction Search indexing). Each increase is
declared at its resolver with what it bills for. Log volume is bounded by retention matched to
conversation retention.

**Production.** Adds WAF (per ACL, per rule, per million requests) and whatever indexing percentage is
chosen. Scaling is linear in requests with no step functions — the architecture has no component that
must be resized.

### Abuse and adversarial cost

Layered, with one hole:

| Layer | Bounds | Bypass |
|---|---|---|
| WAF per-IP rate rule (1,000) | Unauthenticated flood, scripted sign-up | Off by default; deliberately loose for shared NAT |
| API stage throttle (10/20 rps) | Total account request rate | Shared across all callers |
| Per-caller quota (20/60 s) | One authenticated caller's request *frequency* | Requires an account; `PUBLIC_SIGNUP_ENABLED=false` under the gate closes free account minting |
| `MAX_MESSAGE_LENGTH` 8,000 | Input size per request | — |
| `MEMORY_MAX_MESSAGES` 40 | Replayed context growth | — |
| `guardLatestUserMessage` | Guardrail cost growing with conversation² | — |
| Budget at 80%/100% | Nothing — it notifies | Account-wide, no cost filter, after the fact |
| **Absent** | **Model calls, tokens and cost within a single request** | **Nothing bounds it** |

The hole is the one that matters most for an agentic workload, because a reasoning loop is the one
component whose cost is not proportional to request count. A caller inside every existing limit — 20
requests per minute, 8,000 characters each — can submit prompts engineered to maximise loop iterations,
and neither `limits.turns`, `limits.totalTokens`, `limits.outputTokens` nor `maxTokens` is set. The
Lambda's 60 s timeout stops the *relay*, not the loop; the agent continues, keeps calling Bedrock, and
the tokens are billed. This is **AGENT-01 / COST-01** and it is the single change with the largest
cost-posture effect.

### Scalability

**Scales without redesign:** all compute is serverless or managed; DynamoDB is on-demand with
well-distributed partition keys (`USER#<sub>`, and `<caller>#<window>` for counters, which naturally
spreads); the conversation index means listing does not scale with transcript size; CloudFront absorbs
static load; streaming means no buffering of long replies.

**Limits to plan for:** Lambda has no reserved concurrency, so a burst competes with every other
workload in the account for the concurrency pool (and there is no floor guaranteeing this workload
capacity either); `listConversations` caps at 100 with no pagination, so a heavy user's sidebar
silently truncates; `deleteConversation` is one API call per turn, so deleting a very long conversation
is slow and could exceed the 29 s timeout; AgentCore Runtime service quotas are alarmed but not
documented; and the single region caps availability at that region's.

**Cold starts:** the BFF bundles self-contained with `noExternal` (argued: anything external is a bet
on what the managed runtime provides, and it pins the SDK to whatever AWS shipped rather than what was
tested). The admin bundle is large (`admin-handler.js.map` at 238 KB implies a substantial bundle from
the Cognito SDK). No provisioned concurrency, so first-request latency after idle is unmitigated.

---

## 16. Findings

Ordered by severity, then by impact. **Class** is Blocker / Required / Recommended / Optional for the
earliest stage it affects.

### High

---

**`AGENT-01` — The agent loop has no execution or token ceiling**
**Severity:** High · **Class:** Required (Sensitive Pilot), Blocker (Public Production) · **Effort:** S
**Affected stage:** Sensitive Pilot · Public Production

**Evidence.** `agent/src/agent.ts:104` — `createAgent` constructs `new strands.Agent({ systemPrompt,
model, tools, messages?, traceAttributes? })` and passes no `limits`. `agent/src/agent.ts:45` —
`new strands.BedrockModel({ region, modelId, guardrailConfig? })` sets no `maxTokens`. The SDK's own
typing (`@strands-agents/sdk/dist/src/types/agent.d.ts:97–113`) documents
`limits?: { turns?, outputTokens?, totalTokens? }` and states: *"Omit any field (or `limits` itself)
for no limit on that dimension."* No `AbortSignal` is passed either, so a client disconnect does not
cancel the loop. `grep` for `maxTokens|maxCycles|maxIterations|recursion` across `agent/src` returns
nothing.

**Why it matters.** One authenticated request inside every existing limit can drive an unbounded number
of model calls. The BFF's 60 s timeout ends the *relay*; the loop continues and the tokens are billed.
This is simultaneously a cost exposure (the only ceiling is a monthly budget that notifies after the
fact), an availability exposure (a container occupied by a runaway turn is not serving others), and a
bounded-autonomy failure under the Agentic AI Lens. It is also the failure a fork is least likely to
notice, because it produces no error.

**Recommendation.** Pass per-invocation limits in `createAgent` — e.g.
`limits: { turns: 10, totalTokens: 120_000 }` — sourced from environment variables with documented
defaults in `agent/.env.example`, and set `maxTokens` on `BedrockModel`. Wire the request's
`AbortSignal` into `agent.stream()` so a disconnect cancels. Add a test asserting `limits` is present
(the same shape as the existing tool-schema invariant test), and add a `limitTurns`/`limitTotalTokens`
counter to the dashboard so a cap that starts firing is visible.

---

**`OPS-01` — No CD pipeline and no template validation in CI**
**Severity:** High · **Class:** Required (Public Production), Recommended (Template) · **Effort:** M
**Affected stage:** Public Production · Template Adoption

**Evidence.** `README.md` states plainly: "There is no deploy pipeline: `deploy` runs from your machine
against whatever credentials are in the shell." `.github/workflows/ci.yml` runs `bootstrap`, `verify`,
`audit` and nothing else. The README names the residual gap itself — "What CI still cannot catch is a
template that synthesizes but describes the wrong resource" — and attributes it to Docker, which
**DOC-04 disproves**: I ran `cdk synth` and all four stacks, `AgentStack` included, synthesized without
building an image.

**Why it matters.** Every deploy carries a developer's ambient credentials, with no reviewable record
of what was deployed and no automated rollback path. And the one gate that would catch a wrong-resource
template is unimplemented for a reason that does not hold.

**Recommendation.** Two separable changes. (1) Add a `synth` job to CI now — it needs no credentials
and no Docker; run `cdk synth` under `DEPLOY_PROFILE=demo` and assert it succeeds, and optionally
snapshot the four templates so an unintended resource change surfaces in a diff. (2) Add a minimal
OIDC-based deploy workflow (`aws-actions/configure-aws-credentials` with a role, `--require-approval
broadening` preserved) and document the promotion path. Correct the three places that state the Docker
rationale.

---

**`SEC-01` — No secret scanning, SAST or IaC policy scan in CI**
**Severity:** High · **Class:** Required (Sensitive Pilot) · **Effort:** S
**Affected stage:** Sensitive Pilot · Template Adoption

**Evidence.** `.github/workflows/ci.yml` contains exactly three steps beyond checkout and setup. No
`gitleaks`/`trufflehog`, no CodeQL, no `cdk-nag`, no Checkov. `SECURITY.md` lists "Secrets or account
identifiers committed to the repository" as in scope for a vulnerability report, with no automated
control behind it.

**Why it matters.** A template's security posture is inherited by every fork, so its CI is the highest-
leverage place to catch a regression. `cdk-nag` in particular would have surfaced several items in this
very assessment (missing PITR, absent access logging, deletion protection) automatically and would keep
surfacing them in forks.

**Recommendation.** Add three jobs: `gitleaks` (or enable GitHub secret-scanning push protection),
`github/codeql-action` for JavaScript/TypeScript, and `cdk-nag` with `AwsSolutionsChecks` on the demo
synth from OPS-01 — with documented suppressions for the wildcards §7 shows are unavoidable, so the
suppression list itself becomes the reviewable record.

---

**`AGENT-02` — No evaluation capability for non-deterministic behaviour**
**Severity:** High · **Class:** Required (Sensitive Pilot) · **Effort:** M
**Affected stage:** Sensitive Pilot · Public Production · Template Adoption

**Evidence.** All 419 tests are deterministic. `agent/src/__tests__/tools.test.ts` contains the only
prompt-related assertion — that the system prompt names every registered tool — and `AGENTS.md`
correctly labels it "a prompt reminder rather than a boundary". There is no golden set, no
tool-selection accuracy check, no refusal or injection-resistance suite, no LLM-as-judge, and no replay
harness over stored turns (which is notable, because AgentCore Memory means the turns exist).

**Why it matters.** A prompt edit that degrades tool selection, weakens the "never accept a claim about
who someone is" instruction, or breaks the single-language rule ships with a green suite. In a pilot
with real users, "did that change make it worse?" is unanswerable. The Agentic AI Lens treats
evaluation as a first-class requirement precisely because deterministic tests cannot cover it.

**Recommendation.** Ship a *small* harness rather than a framework: a `agent/evals/` directory with
~15 cases as JSON (prompt, expected tool calls, expected refusal/behaviour), a runner behind
`npm run eval` that is explicitly **not** part of `verify` (it costs tokens and needs credentials), and
one paragraph in `agent/README.md` on adding a case. Fifteen cases and a runner is enough to make the
capability exist and to give a fork a pattern; a large suite would be example-domain baggage.

---

### Medium

---

**`REL-01` — No point-in-time recovery or backup on the conversation index**
**Severity:** Medium · **Class:** Required (Sensitive Pilot) · **Effort:** S
**Affected stage:** Sensitive Pilot · Public Production

**Evidence.** Synthesized `AWS::DynamoDB::Table` for `ConversationTable`:
`PointInTimeRecoverySpecification: null`, `DeletionProtectionEnabled: null`, `DeletionPolicy: Retain`.
The rate-limit table is correctly excluded (disposable counters). No AWS Backup plan exists in any
stack. No export or restore path is documented for AgentCore Memory either.

**Why it matters.** `RETAIN` protects against stack deletion only. It does not protect against a bad
write, a bulk delete through the API, or a `DeleteTable` call. `conversations.ts` notes the rows "name
what someone talked about" and treats them as user data for retention purposes — which is exactly the
argument for making them recoverable. A pilot asked "restore last Tuesday" currently has no answer for
either store.

**Recommendation.** Set `pointInTimeRecovery: true` and `deletionProtection: retainData` on
`ConversationTable`, and add a paragraph to `infra/README.md` stating what is and is not recoverable —
including that AgentCore Memory has no template-provided export, so a fork with a retention obligation
must build one.

---

**`DOC-05` — Five source comments describe conversation storage as S3**
**Severity:** Medium · **Class:** Required (Sensitive Pilot), Required (Template) · **Effort:** S
**Affected stage:** Sensitive Pilot · Template Adoption

**Evidence.** `chatbot-bff/src/session.ts:25` ("everything under `<namespace>-` in the bucket belongs
to one person"); `session.ts:34` and `conversations-handler.ts:13` ("a session id names an S3
prefix"); `conversations.ts:87` ("a TTL matched to the bucket's lifecycle rule"); `session-context.ts:39`
("persisted to the session snapshot"). Plus `agent/Dockerfile:36`, where "a deployed runtime writes its
session snapshots to S3, not to disk" is the stated justification for dropping to `USER node`. No S3
bucket holds conversations; storage is AgentCore Memory plus a DynamoDB index.

**Why it matters.** These are precisely the comments a reviewer reads to answer "where does user data
live and how is it expired" — the first question of a data-protection review. Five instances agreeing
with each other is more convincing than one, and all five are wrong. The `Dockerfile` case is worse in
kind: the security conclusion is right and its premise no longer exists, so the next person to
re-derive it may reach a different conclusion.

**Recommendation.** Rewrite all six to name AgentCore Memory and the DynamoDB index. Add a note to
`CONTRIBUTING.md`'s "Documentation is part of the change" section that a storage or telemetry move
requires a comment sweep — this drift arrived in one refactor and would have been caught by one.

---

**`DOC-04` — Three documents state that synthesizing `AgentStack` builds a Docker image; it does not**
**Severity:** Medium · **Class:** Required (Template) · **Effort:** S
**Affected stage:** Template Adoption · Public Production

**Evidence.** `README.md:197` and `CONTRIBUTING.md:42` both state that `AgentStack` is never
synthesized "because constructing it builds a real Docker image", and `.github/workflows/ci.yml` gives
the same reason for CI not running a synth. **Disproved by execution:** `cdk synth` produced all four
templates including `AgentStack` (31 resources) in seconds; the staged asset directory
`asset.3a49bc…/` contains only `Dockerfile`, `package.json`, `package-lock.json`, `src`,
`tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` — the copied build context — and `docker images`
shows no image for that hash. CDK builds container assets at publish time (`cdk-assets`), not at synth.

**Why it matters.** Two consequences. The `AgentStack` invariants (absent authorizer config, narrow ECR
grant, model scoping) are asserted by *reading source strings* when they could be asserted against the
synthesized template — a materially stronger test. And the gap the README names, "a template that
synthesizes but describes the wrong resource", is closable in CI today on the strength of the same fact.

**Recommendation.** Correct the three statements. Move the `AgentStack` assertions in
`infra/src/__tests__/stacks.test.ts` onto `Template.fromStack`, and add the synth job from OPS-01.

---

**`COST-01` — The only spend ceiling notifies rather than acting, and measures the whole account**
**Severity:** Medium · **Class:** Recommended (Sensitive Pilot), Required (Public Production) · **Effort:** M
**Affected stage:** Sensitive Pilot · Public Production

**Evidence.** `bff-stack.ts` creates `CfnBudget` with `notificationsWithSubscribers` at 80% and 100%,
`notificationType: ACTUAL`, and deliberately no `costFilters` — the comment argues that filtering on an
unactivated cost-allocation tag "tracks zero and never fires", which is a correct trade. But the
resulting control is an email about the whole account, after the money is spent. Combined with
`AGENT-01`, nothing constrains the actual spend rate.

**Why it matters.** For a publicly exposed agentic app, "we were notified at 100% of monthly budget on
the 4th" is not a control. Bedrock spend can move faster than a daily budget evaluation.

**Recommendation.** Layer three things: `AGENT-01`'s per-request token cap (the effective control);
`FORECASTED` notifications in addition to `ACTUAL`, which fire before the ceiling is reached; and a
CloudWatch alarm on the existing `GenAiAgentTokensInput`/`Output` EMF metrics with an actionable
threshold, which reacts in minutes rather than a day. Document in `infra/.env.example` that the budget
alerts and the token alarm is what detects abuse.

---

**`SEC-02` — No CloudFront or S3 access logging**
**Severity:** Medium · **Class:** Required (Public Production) · **Effort:** S
**Affected stage:** Public Production

**Evidence.** Synthesized `AWS::CloudFront::Distribution` has `Logging: null` and `WebACLId: null`.
`AWS::S3::Bucket` (`SiteBucket`) has `LoggingConfiguration: null` and no `VersioningConfiguration`.

**Why it matters.** There is no record of who fetched the application, from where, or at what rate. For
a public deployment this is the primary source for detecting scraping, enumeration or a spike ahead of
its cost appearing, and it is the log an incident review asks for first. Bucket versioning is also the
cheapest protection against a bad `BucketDeployment`.

**Recommendation.** Add a log bucket with a short lifecycle and enable standard CloudFront access logs
(or real-time logs if the volume justifies it) plus S3 server access logging. Enable bucket versioning.
Consider a CloudFront-scoped WAF as a separate opt-in from the existing API-stage ACL — the code comment
already notes correctly that they are "a different door".

---

**`REL-02` — No reserved concurrency on any function**
**Severity:** Medium · **Class:** Required (Public Production) · **Effort:** S
**Affected stage:** Public Production

**Evidence.** All three BFF functions and the email trigger synthesize with
`ReservedConcurrentExecutions: null`.

**Why it matters.** Two directions. Upward: a burst on `/chat` can consume the account's concurrency
pool and starve unrelated workloads — which for a template deployed into a shared account is a
neighbour problem, not just a self problem. Downward: nothing guarantees this workload any capacity when
something else in the account bursts.

**Recommendation.** Set a modest `reservedConcurrentExecutions` on all three, derived from
`API_RATE_LIMIT` (the stage throttle already caps arrival rate, so the number follows from it), exposed
as an optional variable with the reasoning in `infra/.env.example`.

---

**`SEC-03` — Deletion protection absent on the two stateful resources**
**Severity:** Medium · **Class:** Recommended (Sensitive Pilot), Required (Public Production) · **Effort:** S
**Affected stage:** Sensitive Pilot · Public Production

**Evidence.** `AWS::Cognito::UserPool` has `DeletionProtection: null` (though `DeletionPolicy: Retain`);
`ConversationTable` has `DeletionProtectionEnabled: null`.

**Why it matters.** `RemovalPolicy.RETAIN` governs CloudFormation. It does not stop an operator or a
script calling `DeleteUserPool` or `DeleteTable`. The user pool holds every account and its loss is
explicitly identified as unrecoverable; the API-level guard is one property.

**Recommendation.** Set `deletionProtection: retainData` on both, so it follows the same decision the
rest of the template already makes.

---

**`DOC-02` — `agent/.env.example` documents a retired telemetry gate and omits the live one**
**Severity:** Medium · **Class:** Required (Template) · **Effort:** S
**Affected stage:** Demo · Template Adoption

**Evidence.** `agent/.env.example:29–35` describes `OTEL_EXPORTER_OTLP_ENDPOINT` as the switch that
"turns on tracing and metrics export". `agent/src/telemetry.ts` returns a no-op unless
`AGENT_OBSERVABILITY_ENABLED === 'true'` and never reads `OTEL_EXPORTER_OTLP_ENDPOINT`.
`AGENT_OBSERVABILITY_ENABLED` does not appear in the file (`grep -c` returns 0). `agent/README.md`
explicitly documents the old gate as retired, so the two files contradict each other — and the root
README names `.env.example` as "the source of truth for every variable".

**Why it matters.** A developer following the documented path gets silence with no error, which is the
exact failure the telemetry module's own comments say it was written to fix. The contradiction also
undermines the `.env.example`-is-canonical convention that the rest of the configuration story rests on.

**Recommendation.** Replace the section with `AGENT_OBSERVABILITY_ENABLED`, `AGENT_METRICS_LOG_GROUP`,
`AGENT_METRICS_NAMESPACE` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, noting which the stack sets and what
a local run needs. Consider a test asserting that every `process.env.X` read in `agent/src` appears in
`agent/.env.example` — cheap, and it would have caught this.

---

**`TPL-01` — A 75 KB upstream self-assessment ships in the template and seven production comments cite it**
**Severity:** Medium · **Class:** Required (Template) · **Effort:** S
**Affected stage:** Template Adoption

**Evidence.** `docs/assessment.md` — 75,745 bytes, 11,371 words — is an assessment of the upstream
repository, dated, commit-stamped, and carrying a revision history of prior reviews. Seven production
comments reason from it: `infra/src/stacks/bff-stack.ts:157` ("the SLO layer this template deliberately
defers (docs/assessment.md)"), `:556` ("Each was in the assessment's 'still absent' list"), `:851`
("the assessment lists them as absent business metrics"), `infra/src/stacks/agent-stack.ts:836` ("See
`docs/assessment.md`"), `agent/src/emf-metrics.ts:7` and `:15`, `agent/src/telemetry.ts:6` ("which is
the state the assessment found").

**Why it matters.** Every fork inherits a review of somebody else's repository, and — more awkwardly —
inherits code comments that explain *why* a feature exists by reference to a finding in that review.
Once a fork diverges, those comments explain a decision against a document that no longer describes the
fork. It is also the largest single file a new adopter has to decide whether to read.

**Recommendation.** Move it out of the template's default surface: a GitHub release note, a wiki page,
or `docs/history/` with a one-line README stating it describes the upstream template and is not
guidance. Rewrite the seven comments to state the *reason* directly ("these instruments were emitted
and never collected") rather than citing the document — each reads perfectly well without the citation.

---

**`SEC-04` — `--ignore-scripts` is applied only to the root install**
**Severity:** Medium · **Class:** Recommended (Sensitive Pilot) · **Effort:** S
**Affected stage:** Sensitive Pilot · Template Adoption

**Evidence.** `package.json`: `"bootstrap": "npm ci --ignore-scripts && npm --prefix ./agent ci && npm
--prefix ./chatbot-bff ci && npm --prefix ./chatbot-frontend ci && npm --prefix ./infra ci"`. The root
gets `--ignore-scripts`; the four packages that hold every runtime dependency do not. `install:all` has
the same asymmetry. On this machine, npm 11 warned that `esbuild@0.28.2` has an unapproved postinstall —
but `engines` declares `npm >=10.0.0`, where those scripts run.

**Why it matters.** Lifecycle scripts are the primary npm supply-chain execution vector, and the same
`bootstrap` runs in CI where the workflow has gone to real trouble to limit token exposure
(`persist-credentials: false` exists specifically so "anything `npm ci` executes" cannot read it). The
mitigation is applied where the risk is smallest.

**Recommendation.** Either apply `--ignore-scripts` uniformly and add explicit approvals for the
packages that genuinely need a postinstall (esbuild), or drop it from the root and document that
lifecycle scripts run — inconsistency is worse than either choice, because it reads as a control that
is present.

---

**`AGENT-03` — The system prompt has no version identity**
**Severity:** Medium · **Class:** Recommended (Sensitive Pilot) · **Effort:** S
**Affected stage:** Sensitive Pilot · Public Production

**Evidence.** `agent/src/agent.ts` exports `systemPrompt` as a template literal. No version, no hash,
not among the `traceAttributes` stamped on spans (`session.id` and `correlation.id` are), not resolved
from a store. By contrast the guardrail in the same repository is pinned to an immutable numbered
version whose CloudFormation logical id embeds a hash of the policy, *specifically* so an edit cannot
change enforcement without a deployment and a record.

**Why it matters.** A trace cannot answer "which prompt produced this answer", so a regression report
from a pilot cannot be tied to a prompt revision. Rollback is a code deploy. The repository already
demonstrates it knows better — the same argument made for the guardrail applies to the prompt.

**Recommendation.** Compute a short hash of `systemPrompt` at module load and add it to
`traceAttributes` as `gen_ai.system_instructions.version` (or equivalent), and log it in the boot line
that already reports `guardrail=`, `durableSessions=`, `telemetry=`. Two lines, and it makes every
trace attributable.

---

**`AGENT-04` — No pattern for a tool with side effects**
**Severity:** Medium · **Class:** Recommended (Template) · **Effort:** M
**Affected stage:** Template Adoption · Sensitive Pilot

**Evidence.** Both example tools are read-only. `AGENTS.md`'s "Where new things go" covers identity and
IAM grants for a new tool but says nothing about confirmation, dry-run, reversibility or audit for a
tool that *mutates*. The user-facing delete flow does the right things (browser confirm, content before
pointer, audit line naming the human) but no agent-initiated path exists to copy from.

**Why it matters.** The first thing most forks add is a tool that writes something. The template's
guidance stops exactly where the risk starts, and the Agentic AI Lens treats reversibility and
proportionate oversight as core requirements. A fork left to invent this will usually invent nothing.

**Recommendation.** Add a section to `agent/README.md` and a row to `AGENTS.md`: a mutating tool returns
a proposed action for confirmation rather than performing it, or performs it idempotently with an audit
record naming the caller from `currentCaller()`, and irreversible actions require an explicit
confirmation turn. A ~30-line commented example (not registered by default) would make the pattern
copyable without adding to the example domain.

---

### Low

---

**`DOC-01` — README states the gate refuses 9 defaults; it refuses 10**
**Severity:** Low · **Class:** Recommended · **Effort:** S · **Stage:** Template Adoption
`README.md:131` shows a sample refusal reading "refuses 9 sandbox defaults" and the prose breaks them
down as 5 access + 1 durability + 3 evidence. Executed, the gate reports **10**
(`AGENT_OBSERVABILITY_ENABLED` and `TRANSACTION_SEARCH_ENABLED` are both present, making the evidence
group four). **Recommendation:** update the number and the breakdown; better, derive the sample from
the gate in a test so it cannot drift again.

---

**`DOC-03` — `infra/README.md` says three alarms; there are seven**
**Severity:** Low · **Class:** Recommended · **Effort:** S · **Stage:** Public Production
`infra/README.md:112` — `ALERT_EMAIL` "subscribes an address to the three CloudWatch alarms and the
budget". Seven alarms exist and all seven receive the SNS action. **Recommendation:** state seven and
list them, or say "every alarm" so the count cannot drift.

---

**`REL-03` — No idempotency on `POST /chat`**
**Severity:** Low · **Class:** Recommended · **Effort:** M · **Stage:** Public Production
A retried request (client retry, proxy retry, user double-submit) produces a second stored turn and a
second index bump. There is no request key; `correlationId` is minted per attempt and would be a
natural one. The Lambda-internal writes *are* individually idempotent-by-construction (conditional
`UpdateItem`, `if_not_exists`), so the exposure is a duplicated conversation turn rather than corrupt
state. **Recommendation:** accept a client-supplied idempotency key (or reuse the correlation id) and
short-circuit a duplicate within a short window using the existing rate-limit table.

---

**`REL-04` — `listConversations` truncates silently at 100**
**Severity:** Low · **Class:** Recommended · **Effort:** S · **Stage:** Public Production
`conversations-handler.ts` — `LIST_LIMIT = 100`, no `nextToken` returned, and the recency sort runs
*after* the limit, so a heavy user's sidebar can omit recent conversations without any indication. The
comment ("a sidebar, not an archive browser") shows the trade was considered; the silence is the issue.
**Recommendation:** return a `hasMore` flag and surface it in the sidebar, or paginate.

---

**`REL-05` — No client-side cancellation or request timeout**
**Severity:** Low · **Class:** Recommended · **Effort:** S · **Stage:** Public Production
`chatbot-frontend/src/lib/api.ts` uses `fetch` with no `AbortController` and no timeout; `ChatExperience`
offers no stop control. A hung stream leaves the UI in `thinking` indefinitely with the composer
disabled. **Recommendation:** an `AbortController` with a timeout above the Lambda's 60 s, plus a stop
button that aborts — which also gives `AGENT-01`'s `cancelSignal` a natural trigger.

---

**`TPL-02` — Root TypeScript version diverges from every subpackage — WITHDRAWN, the constraint is real**
**Severity:** Informational · **Class:** — · **Effort:** — · **Stage:** —
Root `package.json` pins `typescript@^6.0.3`; the four subpackages pin `^7.0.2`. This looked like
drift and is not: `typescript-eslint@8.68.0`, which the root uses to lint every package, declares
`peerDependencies.typescript: ">=4.8.4 <6.1.0"`. The latest published release (`8.70.0`) declares the
same range, so **no current `typescript-eslint` supports TypeScript 7**. The root pin is therefore the
highest version the linter accepts, and raising it would break `npm run lint`. The divergence is a
consequence of an upstream constraint, not an oversight. **No action.** Worth a one-line comment in
`package.json` recording *why* the root lags, so the next reader does not file this same finding — and
worth revisiting when `typescript-eslint` widens the range.

---

**`TPL-03` — No formatter and no type-aware linting**
**Severity:** Low · **Class:** Optional · **Effort:** S · **Stage:** Template Adoption
No Prettier, no `.editorconfig`, no `--check` step; `tseslint.configs.strict` is used without
`strictTypeChecked` or the project service, so rules requiring type information (`no-floating-promises`,
`no-misused-promises`, `no-unnecessary-condition`) are off. Style is currently consistent by convention,
which does not survive many contributors. **Recommendation:** add Prettier with a `--check` step, and
consider `strictTypeChecked` — the codebase is `void`-explicit about floating promises already, so it
would likely pass with little work.

---

**`TPL-04` — Five values kept in sync by hand; one is untested**
**Severity:** Low · **Class:** Optional · **Effort:** S · **Stage:** Template Adoption
Annotated cross-package constants: `SESSION_NAMESPACE_LENGTH`/`ACTOR_ID_LENGTH` (tested both sides), the
identity wire format (tested both sides), `ADMIN_GROUP` (tested), `LOCALE_ATTRIBUTE` (three copies:
`auth-stack.ts`, `admin.ts`, `custom-message/index.mjs`), and `MAX_MESSAGE_LENGTH` ↔ the frontend's
`maxLength={8000}` — annotated as hand-synced and **not** tested. **Recommendation:** the frontend can
read its own constant and assert equality against the documented number in a test, closing the one gap.

---

**`SEC-05` — `NODE_TLS_REJECT_UNAUTHORIZED=0` documented in two `.env.example` files**
**Severity:** Low · **Class:** Optional · **Effort:** S · **Stage:** Template Adoption
Present (commented) in `agent/.env.example` and `chatbot-bff/.env.example`, each with a clear warning
that it disables verification process-wide. The warnings are good; the concern is that these files exist
to be copied verbatim, and a process-wide TLS bypass is a poor thing to have one uncomment away.
**Recommendation:** remove it and move the explanation to a troubleshooting note.

---

**`SEC-06` — Container base image pinned by tag, not digest**
**Severity:** Low · **Class:** Optional · **Effort:** S · **Stage:** Sensitive Pilot
`agent/Dockerfile` — `FROM public.ecr.aws/docker/library/node:22-slim` in both stages. The comment
explains why `22-slim` rather than `latest`, which is the important half; `22-slim` is still mutable.
No image scanning or SBOM step exists either. **Recommendation:** pin by digest with the tag in a
comment (the same convention the repository already uses for GitHub Actions), and enable ECR scan-on-push
or add a `trivy`/`grype` step.

---

### Informational

- **`INF-01`** — Non-test source is 35% comments (65% in `agent/src`), with several 20–30 line block
  comments. The quality is high and none is redundant; the volume is the drift surface that produced
  DOC-02 and DOC-05. Consider moving the longest architectural essays (`governRuntimeLogGroup`,
  `MASKED_IDENTIFIERS` in `agent-stack.ts`) into `infra/README.md`, where they are already half-present.
- **`INF-02`** — `chatbot-frontend/src/lib/api.ts` re-implements SSE envelope parsing and wraps the
  result in a synthetic `new Response(stream)` to satisfy `parseAgentCoreStream`'s signature. Accepting
  a `ReadableStream` directly would remove the indirection.
- **`INF-03`** — `ChatExperience.send` mints a client-side `crypto.randomUUID()` session id that the BFF
  always discards (it carries no namespace). Harmless; it reads as if the client chose the id.
- **`INF-04`** — `governRuntimeLogGroup` creates four sequential `AwsCustomResource`s each carrying the
  same four-action `logs:*` policy on `*`. Correct and documented, but one custom resource performing
  all four calls would carry the grant once.
- **`INF-05`** — No `CODEOWNERS`, no `CHANGELOG`, no releases/tags. `SECURITY.md` states this
  deliberately ("`main` is the only supported line"). A template that forks will track benefits from
  tagged versions.
- **`INF-06`** — `.gitignore` lists `.kiro/` but no such directory exists; a leftover.
- **`INF-07`** — `index.html` produces a Vite warning: `<script src="/config.js">` "can't be bundled
  without type="module"". Intentional — `config.js` is written at deploy time — but the warning appears
  on every build and a one-line comment would stop it reading as a defect.

---

## 17. Priority Remediation Plan

Ordered by how much each changes the project's posture, not by count.

### P0 — Fix before broader template adoption

| # | Problem | Change | Files | Effort | Impact |
|---|---|---|---|---|---|
| **P0-1** (TPL-01) | A 75 KB upstream self-assessment ships in the template and seven production comments reason from it | Move `docs/assessment.md` out of the default surface (release notes, wiki, or `docs/history/` with a disclaimer). Rewrite the seven comments to state the reason directly instead of citing the document | `docs/assessment.md`, `infra/src/stacks/bff-stack.ts:157,556,851`, `infra/src/stacks/agent-stack.ts:836`, `agent/src/emf-metrics.ts:7,15`, `agent/src/telemetry.ts:6` | S | Every fork stops inheriting a review of somebody else's repo, and its own code stops explaining itself by reference to it |
| **P0-2** (DOC-02, DOC-05, DOC-01, DOC-03, DOC-04) | Six documented behaviours the code does not have, in files the README names as sources of truth | Rewrite the five S3/snapshot comments and the `Dockerfile` justification; replace `agent/.env.example`'s telemetry section with the live variables; correct 9→10, three→seven alarms, and the Docker/synth claim in three places | `chatbot-bff/src/{session,session-context,conversations,conversations-handler}.ts`, `agent/Dockerfile`, `agent/.env.example`, `README.md`, `infra/README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml` | S | Restores the documentation's authority, which is this template's primary asset; unblocks P2-1 |
| **P0-3** (TPL-02) | — | **Withdrawn.** The root's `typescript@^6.0.3` is the highest version `typescript-eslint` accepts (`<6.1.0` on 8.68.0 and on the current 8.70.0), so the divergence is an upstream constraint. Optionally record the reason in `package.json` | `package.json` | S | None; documenting the constraint prevents the finding being re-filed |

### P1 — Fix before sensitive pilots

| # | Problem | Change | Files | Effort | Impact |
|---|---|---|---|---|---|
| **P1-1** (AGENT-01) | A single request can drive unbounded model calls and token spend | Pass `limits: { turns, totalTokens }` and `maxTokens`, sourced from documented env vars; wire an `AbortSignal`; assert `limits` is present in a test; chart the limit stop-reasons | `agent/src/agent.ts`, `agent/src/index.ts`, `agent/.env.example`, `agent/src/__tests__/`, `infra/src/stacks/bff-stack.ts` (dashboard) | S | The single highest-leverage change in this plan: closes the cost, availability and bounded-autonomy gap at once |
| **P1-2** (REL-01, SEC-03) | No recovery path for the conversation index; no API-level delete guard on either stateful resource | `pointInTimeRecovery: true` and `deletionProtection` on `ConversationTable`; `deletionProtection` on the user pool; document what is and is not recoverable, including that AgentCore Memory has no export | `infra/src/stacks/bff-stack.ts`, `infra/src/stacks/auth-stack.ts`, `infra/README.md`, `infra/src/__tests__/stacks.test.ts` | S | Makes "restore last Tuesday" answerable, and closes the gap between `RETAIN` and actual protection |
| **P1-3** (SEC-01) | CI has no secret scanning, no SAST, no IaC policy scan | Add `gitleaks` (or push protection), CodeQL, and `cdk-nag` `AwsSolutionsChecks` over the demo synth, with reviewed suppressions for the unavoidable wildcards | `.github/workflows/ci.yml`, `infra/src/app.ts` (aspect + suppressions) | S | Every fork inherits three regression gates; the suppression list becomes the reviewable record of accepted exceptions |
| **P1-4** (AGENT-02) | No way to tell whether a prompt or tool change made the agent worse | A small `agent/evals/` set (~15 JSON cases: tool selection, refusals, injection resistance, language rule) with `npm run eval`, deliberately outside `verify` | `agent/evals/`, `agent/package.json`, `agent/README.md`, `AGENTS.md` | M | Creates the capability the Agentic AI Lens requires and a fork will not build unprompted |
| **P1-5** (AGENT-03) | A trace cannot say which prompt produced an answer | Hash `systemPrompt` at load; add it to `traceAttributes` and the boot line | `agent/src/agent.ts`, `agent/src/index.ts` | S | Every span becomes attributable to a prompt revision; makes a pilot regression report actionable |
| **P1-6** (SEC-04) | `--ignore-scripts` protects only the root install | Apply uniformly with explicit approvals, or drop it and document that scripts run | `package.json` | S | Removes a control that looks present and is not, on the four packages that matter |

### P2 — Fix before public production

| # | Problem | Change | Files | Effort | Impact |
|---|---|---|---|---|---|
| **P2-1** (OPS-01, DOC-04) | Deploys run from a laptop; CI never validates a template, on a premise that is false | Add a credential-free `cdk synth` job (+ optional template snapshots); move the `AgentStack` assertions onto `Template.fromStack`; add an OIDC deploy workflow keeping `--require-approval broadening` | `.github/workflows/`, `infra/src/__tests__/stacks.test.ts` | M | Closes the "synthesizes but describes the wrong resource" gap the README names, and makes a deploy reviewable |
| **P2-2** (COST-01) | The only spend ceiling notifies, account-wide, after the fact | Add `FORECASTED` budget notifications and a CloudWatch alarm on the existing token EMF metrics | `infra/src/stacks/bff-stack.ts`, `infra/.env.example` | S | Turns cost from a monthly surprise into a minute-scale signal; complements P1-1 |
| **P2-3** (SEC-02) | No record of who fetched the application | CloudFront access logs + S3 server access logging into a short-lifecycle log bucket; bucket versioning; optionally a CloudFront-scoped WAF as a separate opt-in | `infra/src/stacks/frontend-stack.ts`, `infra/.env.example` | S | Makes abuse of the public surface detectable and an incident reviewable |
| **P2-4** (REL-02) | A burst can consume the account's concurrency pool | `reservedConcurrentExecutions` on all three functions, derived from `API_RATE_LIMIT` | `infra/src/stacks/bff-stack.ts`, `infra/.env.example` | S | Bounds the blast radius in both directions |
| **P2-5** | No SLOs and no error budget | Define availability and p95 latency targets; enable Application Signals (already wired behind `OTEL_AWS_APPLICATION_SIGNALS_ENABLED`) as an opt-in; document the targets | `infra/src/stacks/bff-stack.ts`, `infra/README.md` | M | Alarms currently fire on absolutes; an SLO is what makes "is this bad enough to page" answerable |
| **P2-6** (REL-03, REL-04, REL-05) | Duplicate turns on retry; silent sidebar truncation; no way to cancel a hung turn | Idempotency key on `/chat` using the existing rate-limit table; `hasMore` on the listing; `AbortController` plus a stop button | `chatbot-bff/src/handler.ts`, `chatbot-bff/src/conversations-handler.ts`, `chatbot-frontend/src/lib/api.ts`, `chatbot-frontend/src/components/ChatExperience.tsx` | M | Three user-visible correctness gaps, each small |

### P3 — Template polish

| # | Problem | Change | Files | Effort | Impact |
|---|---|---|---|---|---|
| **P3-1** (AGENT-04) | No pattern for a tool with side effects | A documented pattern plus a commented, unregistered example: confirm-or-idempotent, audit naming the caller, irreversible actions need a confirmation turn | `agent/README.md`, `AGENTS.md`, `agent/src/tools.ts` | M | The first thing most forks add is a write tool, and there is currently nothing to copy |
| **P3-2** (TPL-03) | No formatter; type-aware lint rules off | Prettier with a `--check` step; evaluate `strictTypeChecked` | root config, `.github/workflows/ci.yml` | S | Keeps style consistent across many hands without review comments |
| **P3-3** (INF-01) | 2,368 comment lines are an untested drift surface | Move the longest architectural essays into `infra/README.md`; add a line to `CONTRIBUTING.md` requiring a comment sweep when storage or telemetry moves | `infra/src/stacks/agent-stack.ts`, `infra/README.md`, `CONTRIBUTING.md` | S | Preserves the reasoning while shrinking what can silently go stale |
| **P3-4** (TPL-04, DOC-02) | Hand-synced values, one untested; env vars can drift from `.env.example` | Test `MAX_MESSAGE_LENGTH` against the frontend's `maxLength`; test that every `process.env` read in `agent/src` appears in `agent/.env.example` | `chatbot-frontend/src/__tests__/`, `agent/src/__tests__/` | S | Turns two conventions into two guards; the second would have caught DOC-02 |
| **P3-5** (SEC-05, SEC-06, INF-05, INF-06, INF-07) | Assorted hygiene | Remove `NODE_TLS_REJECT_UNAUTHORIZED` from both `.env.example`s; pin the base image by digest and add image scanning; add `CODEOWNERS` and tagged releases; drop the stale `.kiro/` ignore; comment the `config.js` Vite warning | various | S | Small, cheap, each removes a paper cut a fork inherits |

---

## 18. What Is Already Strong

Decisions I would preserve without modification, and the reason each is worth protecting:

1. **The deployment-profile gate.** `pilot`/`prod` refuse to synthesize while any sandbox default
   remains, collecting *all* violations before throwing ("discovering them one failed synth at a time is
   how people stop reading the message") and naming the variable plus the reason for each. `demo` is
   never checked, because "a sandbox that nags teaches that these errors are noise". Tested in both
   directions, and the wiring is tested separately so deleting the call is caught. **This is the
   mechanism the entire demo→pilot claim rests on, and it works — I ran it.**

2. **The BFF as the only transport, treated as a security boundary.** The runtime declares no authorizer
   configuration; only the chat role holds `InvokeAgentRuntime`; there is no identity pool. The
   reasoning is the part to preserve: the identity block is plain text, so it is only as trustworthy as
   the transport, and a JWT authorizer on the runtime would make it client-composable. Four tests assert
   the absence from both directions.

3. **"No tool takes a user id," enforced structurally.** Identity comes from `currentCaller()` via
   `AsyncLocalStorage`; the schema the model sees carries none. The test walks every property name in
   every tool's schema at any depth against the spellings of "whose data is this" — so a tool added in
   two years is covered without the test being touched.

4. **Privilege separation across three Lambdas.** Chat relays model output and can do nothing else;
   conversations reads and deletes but cannot invoke the model or write history; admin holds four
   Cognito actions. The chat role's action set is asserted exhaustively, so a new grant turns the suite
   red. The stated reason is the right one: a forged transcript is worse than none, because it is
   believed.

5. **Double-enforced per-user isolation.** `belongsToCaller` on the session namespace *and* an
   independently derived `actorId` at the store, with `404` rather than `403` so the id space is not an
   existence oracle. Two controls, either of which would suffice.

6. **Fail-closed tested as fail-closed.** Every denial path also asserts the AWS client was never
   called. This closes the most common way a correct authorization rule still fails.

7. **Pure logic split from I/O, everywhere.** It is why 419 tests run in ~40 seconds with no mocking
   framework, and it is the property that makes the security assertions cheap enough to keep writing.

8. **Security properties asserted against the synthesized template**, with assertions written as
   *enumerations and absences* rather than allow-lists: every method is enumerated for the authorizer,
   `aws-xray-sdk`'s absence is asserted rather than a known-good list, the chat role's actions are
   enumerated exhaustively. These survive additions.

9. **One coherent telemetry model.** OTel everywhere, `traceparent` joining three runtimes, a
   browser-minted correlation id that reaches the stored turn, GenAI-convention spans, token/tool
   metrics via EMF (cheaper *and* a narrower grant than `PutMetricData`), and the SDK instrumentation
   preloaded rather than imported — with the measurement recorded in the comment.

10. **PII handled in two layers with each layer's blind spot named.** Origin redaction of tool
    arguments and results (which the guardrail provably cannot reach), destination masking on both log
    groups, and a masked-identifier list *narrowed* on observed evidence rather than widened for
    appearances. The README's honesty about guardrail `ANONYMIZE` being unreliable on a streamed
    response is worth more than the control it describes.

11. **The silent-failure treatment.** A failed turn that returns HTTP 200 is caught at three layers plus
    three alarms. Most production systems do not do this; a template doing it is remarkable.

12. **Graceful degradation as a stated policy.** Every non-essential dependency degrades with the trade
    written down — history, index writes, emails, the app-URL lookup, span export — and the one place
    that must fail closed (redaction) does.

13. **Retention as a service property.** `eventExpiryDuration` on the memory resource, matching TTLs,
    telemetry retention rounded *up* so a trace never outlives its turn, and the gate refusing to
    synthesize until someone chooses the number. Refusing to pick a default here is the correct call.

14. **Documentation that carries reasoning, and a real runbook.** `.env.example` explains what each
    default bills for and whether the gate refuses it; `CONTRIBUTING.md` makes that paragraph part of
    done; `infra/README.md` documents five real deploy failures with the error text, the diagnostic
    command, an output-to-meaning table and the fix. `SECURITY.md` derives its scope from the
    architecture. `CLAUDE.md` is a pointer, not a copy.

15. **`AGENTS.md` pairing each invariant with its guard test and the attack it prevents**, and its
    "Failures that are not bugs" section. This is the right shape for agent-facing guidance: verifiable
    rather than merely obeyed.

16. **Comments that record what was measured.** "Imported yields zero spans, preloaded yields one";
    "five service records against 351 lines of stdout"; "`...:*:*` matches nothing"; the masked Portuguese
    prose. Each is a defect someone paid for once, and each is now un-repeatable.

17. **Cost honesty as a design constraint.** Every billed control is opt-in with the billing reason at
    the resolver; the ADOT layer is gated with the tracing it belongs to; the budget's account-wide scope
    is disclosed rather than hidden; the agent dashboard row is omitted rather than showing a misleading
    flat zero.

---

## 19. Final Recommendation

### Would I recommend a new team clone this foundation tomorrow for a real project?

## **YES, WITH CONDITIONS**

**Why yes.** The things that are expensive to retrofit are already correct and, more importantly,
*enforced*. The transport boundary, the identity model, the three-way privilege split, the memory/index
separation, per-user isolation enforced twice, least-privilege IAM verified in the synthesized template,
and one coherent observability model — these are the decisions that cost weeks to change later, and each
is held in place by a test rather than by a paragraph. The profile gate means a team cannot accidentally
run a pilot on sandbox defaults, which is the failure mode that actually happens. And the example domain
really is thin: two tools and a 35-line prompt, both marked replaceable in two documents that agree.

I would additionally recommend it for the quality of its reasoning. A repository whose comments record
that ten data identifiers masked ordinary Portuguese prose and the span attribute the GenAI console
reads, and that then *narrowed* the list, is a repository whose defaults were tested against reality
rather than copied from a checklist. That is rare and it is not something a fork can reconstruct.

**The conditions**, in the order I would do them:

1. **Bound the agent loop** (P1-1). One config change closes a cost, availability and autonomy gap
   simultaneously. Do this first; it is the smallest change with the largest effect.
2. **Fix the six documentation drifts** (P0-2). This template's principal asset is that its
   documentation is trustworthy. Five comments describing conversation storage as S3 prefixes in a
   system that uses AgentCore Memory undermine exactly that, in the files a data-protection review reads
   first.
3. **Add PITR and deletion protection** (P1-2) before any real data.
4. **Add secret scanning, CodeQL and `cdk-nag`** (P1-3). Cheap, and a template's CI is inherited.
5. **Add a small eval set and a prompt hash** (P1-4, P1-5). This is the capability a fork will not build
   for itself, and without it nobody can say whether a prompt change helped.
6. **Relocate `docs/assessment.md` and decouple the seven comments from it** (P0-1) before anyone forks.

If a team can only do two, do (1) and (2).

### Are there structural problems requiring significant refactoring before something built on this reaches production?

## **NO**

Every finding above is **additive**. Nothing requires moving a boundary, changing the identity model,
restructuring the stacks, or reversing a decision.

- Bounding the loop is a config object passed to an existing constructor.
- PITR, deletion protection, reserved concurrency and access logging are properties on resources that
  already exist.
- An eval set and a prompt hash are new files and two lines; nothing has to be rearranged to accept
  them.
- A CD pipeline is a new workflow. The deploy path it would drive is already scripted, already gated on
  `--require-approval broadening`, and already parameterized by account and region.
- Documentation fixes are edits.

The two decisions that *will* need revisiting are both already documented as such by the repository
itself, and neither is a refactor of what exists: `networkMode: 'PUBLIC'` on the runtime becomes a real
question the day a tool makes an outbound call (adding a VPC configuration to one construct), and a data
layer arrives as a new stack ahead of `agent` and `bff` with two grant rules already written down and
already demonstrated by the existing `dynamodb:UpdateItem`-only grant.

The strongest evidence that the foundation is sound is the shape of this assessment: the findings cluster
in *operational maturity* (CD, backups, evaluation, scanning) and *documentation upkeep*, not in
architecture or security design. That is the profile of a foundation to build on, not one to rebuild.

*Assessment performed on commit `15e4cd7` by reading the repository and executing its own checks:
`npm run bootstrap`, `npm run verify` (419 tests, lint, typecheck — all passing), `npm run audit`
(passing; one low dev-only advisory), and `cdk synth` under three profile configurations (demo:
success; pilot unpinned: refused; pilot with sandbox defaults: refused with 10 named violations; pilot
fully configured: success, 119 resources), plus static analysis of the four synthesized CloudFormation
templates. No AWS resource was created or modified. No prior assessment was consulted. Sections 20-22
record the remediation applied afterwards.*

---

## 20. Addendum — P0 remediation applied

Recorded after the assessment above, which stands as the review of commit `15e4cd7`. The findings are
left as written; this section states what changed and what was verified, so the document remains an
audit trail rather than being rewritten in place.

### Applied

| Finding | What changed |
|---|---|
| **DOC-05** | The six stale storage comments now name AgentCore Memory and the DynamoDB index: `session.ts` (namespace as `actorId` and index partition key; session id names a conversation, not an S3 prefix), `conversations-handler.ts`, `conversations.ts` (TTL matched to `eventExpiryDuration`, not a bucket lifecycle rule), `session-context.ts`, `agent/Dockerfile` (the `USER node` justification now rests on "nothing writes to disk"). `stripSessionContext`'s comment was additionally *wrong on substance*, not only on naming — it claimed the wrapped form is persisted, when `agent/src/index.ts` records the unwrapped prompt; it now says so and states that both callers are defensive |
| **DOC-02** | `agent/.env.example`'s telemetry section replaced. `AGENT_OBSERVABILITY_ENABLED` is now documented as the switch, with an explicit note that it is *not* `OTEL_EXPORTER_OTLP_ENDPOINT` and why that gate was retired, plus the four stack-derived variables and the fact that an unset metrics log group makes the exporter a no-op rather than an error |
| **DOC-01** | `README.md` corrected to 10 and "seven more", and the posture breakdown to 5 access / 1 durability / 4 evidence. `infra/README.md`'s "three gated variables are the evidence half" corrected to four and reworded to name what each answers. Verified by running the gate: its output and the README sample now match line for line |
| **DOC-03** | `infra/README.md`'s `ALERT_EMAIL` row no longer states a count. Since removing the number lost information, an **Alarms** subsection was added listing all seven with what each fires on, split into the three that fire on an error and the four that fire on failures returning 200 |
| **DOC-04** | Corrected in `README.md` (both places — the Testing section and the "no CD pipeline" bullet), `CONTRIBUTING.md` and `.github/workflows/ci.yml`. The CD bullet now states that a synth job is an open gap rather than a Docker constraint |
| **DOC-04 (code)** | Beyond the prose: `AgentStack` is now **constructed and synthesized** in `infra/src/__tests__/stacks.test.ts`. Two invariants moved off source greps onto the synthesized template — *declares no authorizer configuration on the runtime* (the flagship invariant, previously a regex over `agent-stack.ts`) and *scopes the container registry and the log listing to its own resources* — and one assertion was added, *grants the model actions on the scoped ARNs and nothing wider*. New helpers `synthAgentStack()` and `runtimeRoleStatements()` locate the runtime execution role by its trust policy. `readFileSync` is no longer imported. This is the strengthening the finding argued for: a source grep passes on a stack that assigns the property through a variable; the template does not |
| **TPL-01 (partial)** | All **seven** production comments that reasoned from `docs/assessment.md` now state the reason directly. `grep -rn assessment` over `*.ts`, `*.tsx`, `*.mjs`, `*.yml` outside tests returns nothing |
| **TPL-02** | Withdrawn as a finding (see above) and the constraint documented: `CONTRIBUTING.md`'s Setup section now records that the root lags on TypeScript because `typescript-eslint` caps at `<6.1.0`, and when to revisit. `package.json` is unchanged — it is JSON and cannot carry the note |

### Not applied — awaiting a decision

**TPL-01's relocation of `docs/assessment.md`.** The finding recommends moving it out of the
template's default surface, because every fork inherits a review of the upstream repository. That
recommendation now applies equally to this document, which was placed in `docs/` by request. The two
cannot be reconciled without a decision on what `docs/` is for:

- If `docs/` is **template documentation a fork keeps**, both assessments should move to release notes,
  a wiki, or `docs/history/` with a one-line disclaimer.
- If `docs/` is **the upstream project's own record**, both belong where they are, and the thing worth
  adding is a line in the root README saying so — that these are reviews of the template itself and not
  guidance for a fork.

The code-level half of the finding — production comments citing the document — is applied either way,
and is the half that actually followed a fork into its own codebase.

### Verified after the changes

| Check | Result |
|---|---|
| `npm run verify` | **Pass**, exit 0 — lint, typecheck, and **420 tests** (agent 74, bff 132, infra **130**, frontend 84; infra gained the new Bedrock-scope assertion) |
| `cdk synth`, `DEPLOY_PROFILE=demo` | Success, four stacks |
| `cdk synth`, `DEPLOY_PROFILE=pilot` with sandbox defaults | Refused with 10 violations, matching the corrected README sample line for line |
| `AgentStack` synthesized in vitest | Confirmed by a temporary probe before the migration (one `AWS::BedrockAgentCore::Runtime`, ~1.3 s, no image built); probe removed, and the behaviour is now covered by the three migrated/added assertions |
| `grep -rn assessment` in non-test source | No matches |

### Still open from this plan

Nothing in P0 remains except the `docs/` decision above. P1 was applied next — see §21.

---

## 21. Addendum — P1 (effort S) remediation applied

The five P1 items scoped **S** were applied. **P1-4 (an evaluation set, effort M) was not**, and
remains the largest open gap in the Agentic AI Lens assessment. One item, P1-3, turned out to be two
different sizes and was split on measurement rather than on estimate — see below.

### P1-1 — the agent loop is bounded

The finding: `createAgent` passed no `limits` and `BedrockModel` no `maxTokens`, so one authenticated
request could drive an unbounded number of model calls.

`agent/src/limits.ts` — which already held the body ceilings and is therefore where a reader looks —
now also exports three loop ceilings, each configurable and each with the reasoning for its default:

| Variable | Default | Bounds |
|---|---:|---|
| `AGENT_MAX_TURNS` | 10 | Model calls per turn. The predictable cap; an ordinary exchange needs one to three |
| `AGENT_MAX_TOTAL_TOKENS` | 400,000 | Cumulative input + output across the turn. Deliberately generous — every call re-sends its context, so the counter compounds, and a tight value truncates real answers rather than catching runaways |
| `AGENT_MAX_OUTPUT_TOKENS` | 8,192 | One model response, set on the model. The only cap that cannot be overshot |

Three things beyond the caps themselves:

- **They are passed on every call.** `agent.stream(prompt, { limits: agentLimits, cancelSignal })` —
  verified in the built bundle, not only in source, because the SDK's contract is that an omitted
  dimension is unlimited, so "forgot to pass it" and "chose no limit" are the same code.
- **A disconnect now cancels the loop.** An `AbortController` aborts on the response's `close` event
  when the stream has not already ended. Previously the BFF's 60s timeout ended the relay while the
  container kept calling Bedrock for an answer nobody was reading.
- **A cap firing is logged.** It produces no error and returns 200 with a short answer, so
  `turn.limited` (with the correlation id, the stop reason and the caps in force) is the only thing
  that distinguishes a capped turn from a model that had nothing more to say. `LIMIT_STOP_REASONS` is
  asserted against the SDK's `StopReason` union so a rename cannot silently turn that line into one
  that is never written.

`agent/.env.example` documents all three with the arithmetic behind them. The boot line now reports
`maxTurns` and `maxTotalTokens` alongside `guardrail`/`durableSessions`/`telemetry`.

### P1-5 — the prompt has a version, and it reaches the trace

`agent/src/agent.ts` exports `systemPromptVersion`: eight hex characters of a SHA-256 of the prompt
itself, merged into `traceAttributes` as `gen_ai.system_instructions.version` **unconditionally**, so a
directly invoked runtime that carries no `session.id` still carries this. Also printed at boot.

A content hash rather than a hand-maintained number, because a version someone must remember to bump
is one that silently stops matching the prompt.

Testing this needed a detour worth recording: the SDK hands `traceAttributes` to a private tracer and
exposes them nowhere on the instance, so asserting the computed value would have proved nothing about
whether it was passed. `agent/src/__tests__/agent.test.ts` mocks the `Agent` constructor to observe the
config — the same reason `app.test.ts` executes `app.ts` instead of only testing `config.ts`.

### P1-2 — recoverability, separated from retention

`ConversationTable` gains `pointInTimeRecoverySpecification` and `deletionProtection`; the user pool
gains `deletionProtection`. Both track `RETAIN_DATA`, so a sandbox that opted out of retention is still
destroyable rather than leaving `cdk destroy` wedged on a protected resource. The rate-limit table
deliberately gets neither, and a test asserts that too — continuous backups on disposable counters are
spend with nothing to recover.

The point the finding made was that `RemovalPolicy.RETAIN` governs CloudFormation and nothing else: it
survives `cdk destroy` and says nothing about a `DeleteTable` or `DeleteUserPool` call, or about a bad
write. `infra/README.md` now carries a **What is recoverable, and what is not** table making that
distinction per store — and naming the gap plainly:

> **AgentCore Memory has no backup in this template.** The service offers no point-in-time restore and
> nothing here exports events, so the conversation index can be restored while the transcripts it
> points at cannot — which surfaces as sidebar rows that open empty.

That is left as the correct default (an export job writes conversation content into a second store,
which contradicts the promise `CONVERSATION_RETENTION_DAYS` makes) with the shape of the fix and the
role it belongs on.

### P1-3 — split on measurement: two of three delivered

**Delivered.** `.github/workflows/ci.yml` now has three jobs instead of one, so a failure names which
concern broke:

- **`secrets`** — TruffleHog over the **whole git history** (`fetch-depth: 0`, `base: ''`), because a
  credential committed once is leaked even after it is deleted, and a diff scan passes on a secret that
  arrived before the pull request. `--results=verified,unknown` rather than `--only-verified`:
  verification proves a credential is *live*, so verified-only reports nothing for a key that has
  already been rotated, which is exactly what a history scan is for.
  *Not* gitleaks-action, and for a reason specific to a template — it requires a paid
  `GITLEAKS_LICENSE` for any organization-owned repository, so most forks that matter would inherit a
  gate that fails until someone buys a key.
- **`sast`** — CodeQL with `security-extended`, the one check here that reasons across files. Its
  `security-events: write` is the only elevated grant in the workflow and is scoped to that job.

Both actions are pinned to commit SHAs with the release in a trailing comment, matching the
convention already in the file; all three SHAs in the workflow were confirmed against the GitHub API.
`README.md`, `CONTRIBUTING.md` and `AGENTS.md` each claimed CI ran only `verify` and `audit` and were
corrected — fixing drift while creating more would have been a poor trade.

**Not delivered, and re-scoped on evidence: the IaC policy scan.** Measured rather than estimated.
`cdk-nag` 3.0.2 was installed and run against all four stacks under a full pilot posture; note it no
longer works as a CDK aspect at all — `AwsSolutionsChecks` has no `visit`, and the current integration
is `Validations.of(app).addPlugins(...)`. It reports **51 errors and 4 warnings across 14 rules**:

| Rule | Count | What it is |
|---|---:|---|
| `IAM5` | 62 | Wildcard resources — the ones §7 of this assessment already found to be the ones AWS gives no alternative for |
| `IAM4` | 14 | CDK's own `AWSLambdaBasicExecutionRole` on generated roles |
| `L1` | 5 | Lambda runtime not the newest |
| `COG1`, `COG2`, `COG8` | 3 | Password policy, MFA, Plus tier — all of which the profile gate already requires under `pilot`/`prod` and deliberately relaxes under `demo` |
| `CFR1`–`CFR4`, `S1`, `S10`, `APIG2`, `DDB3` | 8 | Geo restriction, CloudFront WAF, CloudFront logging, TLS, S3 access logs, SSL-only, request validation, PITR on the counters table |

Every one needs either an evidenced suppression or a fix, and the judgement is per-finding: the `IAM5`
and `IAM4` groups are suppressions, `COG*` and `DDB3` are suppressions that must explain the profile
gate and the counters decision, and `CFR1`–`CFR3`, `S1` and `APIG2` are **not** suppressions at all —
they are the P2 items already recorded here (P2-3, and the CloudFront hardening under §5.3). Writing 76
suppressions, several of which would be wrong, is an M-to-L change and would have shipped a template
whose forks inherit a large baseline of acknowledged findings.

`cdk-nag` was uninstalled again so no unused dependency remains. The root README's "Root scripts"
section now names the missing IaC scan and the reason it is not a one-liner, so the gap is stated rather
than implied. **Recommendation: track the IaC policy scan as its own P2 item, effort M.**

### Not applied

**P1-4 — the evaluation set (effort M).** Out of scope for this pass and unchanged as a finding: all
428 tests remain deterministic, and a prompt edit that degrades tool selection or weakens the identity
instruction still ships with a green suite. This is the largest single gap in §8.

### Verified after the changes

| Check | Result |
|---|---|
| `npm run verify` | **Pass**, exit 0 — **428 tests** (agent 79 ← 74, bff 132, infra 133 ← 130, frontend 84) |
| `npm run audit` | **Pass**, exit 0 |
| Clean-room install | All five `node_modules` deleted, `npm run bootstrap` re-run with `--ignore-scripts` everywhere: **0 npm errors**, then `verify` green. This is what establishes that nothing in the tree needs a lifecycle script — `esbuild`, the only package with one, gets its platform binary through `optionalDependencies` |
| `cdk synth`, demo | Success. `t-bff-conversations` renders `PointInTimeRecoveryEnabled: true` + `DeletionProtectionEnabled: true` + `DeletionPolicy: Retain`; `t-bff-rate-limit` renders neither and `DeletionPolicy: Delete`; the user pool renders `DeletionProtection: ACTIVE` |
| Agent bundle | `tsup` build succeeds and the built `dist/index.js` contains `agent.stream(prompt, { limits: agentLimits, cancelSignal: ... })` and `gen_ai.system_instructions.version` — checked in the artifact, not only in source, because the wiring is the part no test observes |
| Workflow | Parsed with `yaml.safe_load`: jobs `verify`, `secrets`, `sast`; `security-events: write` scoped to `sast` alone. All three action SHAs resolve to real commits (HTTP 200) |

### Still open

P1-4 (eval set, M). P2 in full, plus the re-scoped IaC policy scan. P3 in full. And the `docs/`
decision recorded at the end of §20.

---

## 22. Addendum — the CI gate reworked

A review of the workflow shipped in §21 found two defects in it and one design choice that does not
survive contact with a template. All three are corrected. **P2-1's synth gate is now also delivered**,
which was the change §21 recommended and did not make.

### What was wrong with §21's workflow

| # | Defect | Evidence |
|---|---|---|
| 1 | **The scanner was not actually pinned.** The `trufflehog` action was pinned by commit SHA, which pins the *wrapper*, not the tool: its `action.yml` declares `version` with `default: "latest"` and runs `docker run ghcr.io/trufflesecurity/trufflehog:${VERSION}`. Every run pulled whatever was newest | Read from the action manifest at the pinned SHA |
| 2 | **The `--results` rationale was factually wrong.** The comment claimed `verified,unknown` was chosen to catch already-rotated keys that `--only-verified` would miss. It is the opposite: a candidate a detector checks and finds dead is `unverified`, which `verified,unknown` *excludes*. The setting is right; the stated reason was not | TruffleHog's result states are `verified`, `unknown`, `unverified` |
| 3 | **`base: '' / head: HEAD` forced a full-history scan on every pull request.** It also overrode the action's event-aware defaults, so the diff scan a PR should get never happened | The manifest's branch logic: with `base`/`head` unset it derives the range from the event |
| 4 | **CodeQL was the wrong baseline for a template.** Its results upload requires code scanning, which needs GitHub Code Security — paid on private repositories. Every fork in a private org would inherit a job that goes red for a reason the fork cannot fix without buying something | GitHub's code-scanning availability |

### The workflow now

Five jobs, each named for the concern it covers, and the whole gate runs on a fresh clone with no AWS
credentials, no repository secrets and no paid feature:

| Job | Runs | Notes |
|---|---|---|
| `verify` | `npm run verify` then `npm run build` | Identical to the local commands |
| `audit` | `npm run audit` | Its own job now, and it installs nothing — `npm audit` resolves from the lockfiles, verified |
| `synth` | `npm run synth` | **New.** The only check that executes the real `app.ts`. Credential-free because `CDK_DEFAULT_ACCOUNT` is unset, and Docker-free because CDK stages a container asset at synth and builds it at publish |
| `secrets` | TruffleHog, `version: 3.97.4` | Diff on a pull request, full history on the weekly schedule |
| `sast` | Semgrep CE, `p/default`, image pinned by digest | No account, no token; `p/default` is fetched anonymously |

Also: `concurrency` with `cancel-in-progress`, so a newer push supersedes an in-flight run;
`cache-dependency-path: '**/package-lock.json'` instead of five enumerated paths, so a new package
cannot silently fall out of the cache key; a `schedule` + `workflow_dispatch` trigger, which is what
makes the full-history scan and a fresh advisory check possible without slowing every PR; and
`permissions: contents: read` with **no job raising it** — `security-events: write` is gone with CodeQL,
so the workflow now writes nothing at all.

`npm run synth` needed no new script: `dotenvx run -f .env` warns and continues when `.env` is absent,
so the command a contributor runs is the command CI runs. `npm run build` **was** added to the root —
the frontend and BFF builds already ran via `infra`'s `pretest`, but the agent bundle was built by
nothing in the gate.

### Semgrep's baseline, and what it found

Not adopted blind — measured first: 267 rules over 163 files, **5 findings**. Three were real and are
fixed; two are suppressed at the line with the evidence beside them.

| Finding | Disposition |
|---|---|
| `dependabot-missing-cooldown` ×2 | **Fixed, and a genuine improvement.** `.github/dependabot.yml` now sets `cooldown: default-days: 7` on both ecosystems. The npm supply-chain attacks of recent years share a shape — a compromised maintainer publishes a malicious patch, and it is yanked within days — so a bot that upgrades on publication day is the fastest path from that compromise into a fork. Security updates are exempt |
| `unsafe-formatstring` in `agent/src/invoke.ts` | **Fixed.** The event type came from the model's own stream and was interpolated into a `console.log` format string. Now passed as a `%s` argument. Small, but this repository already treats log forging as real — see the character bound on the correlation id |
| `detect-non-literal-regexp` in `agent/src/caller.ts` | **Suppressed.** `new RegExp` on a `name` that is a string literal at every call site. Suppressed rather than refactored deliberately: this is the identity parser, its semantics are pinned by an invariant test, and rewriting it to satisfy a taint heuristic is the wrong risk |
| `detected-generic-secret` in `qrcode.test.ts` | **Suppressed.** The RFC 6238 example base32 secret, published in the spec |

Worth recording for whoever maintains this: a `nosemgrep` directive must sit on the flagged line or the
line immediately above it, and must carry the **full** rule id including its duplicated final segment
(`javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp`). A short id or a
comment two lines up is silently ignored — both were tried and both failed before the placement was
confirmed by re-running the scan.

### Verified

| Check | Result |
|---|---|
| `npm run verify` | Pass, exit 0 — 428 tests |
| `npm run build` | Pass, exit 0 — agent, BFF and frontend artifacts |
| `npm run audit` | Pass, exit 0. Also verified to pass in a directory holding only the lockfiles, which is what lets the `audit` job skip installing |
| `npm run synth` | Pass, exit 0 with **no `.env` and expired credentials** — CDK reports it will synthesize environment-agnostically, which is the intended CI behaviour |
| Semgrep | Exit **0** after the fixes and suppressions (was exit 1 with 5 findings) |
| Workflow | Parses; five jobs; `contents: read` at the top and `None` on every job |
| Action and image pins | All resolve: three action SHAs (HTTP 200), and `ghcr.io/trufflesecurity/trufflehog:3.97.4` exists as a tag — checked, because the action interpolates `version` straight into an image reference and `v3.97.4` would 404 |

### Still depends on GitHub configuration outside the repository

The workflow makes the checks *run*; it cannot make them *required*. Nothing in a repository can.

- **Branch protection or a ruleset** on `main` has to list `verify`, `audit`, `synth`, `secrets` and
  `sast` as required status checks. Until someone does, a red gate is advisory and a pull request can
  still be merged.
- **Actions must be enabled** on the fork, and for a fork of a public repository the first workflow run
  from an outside contributor needs approval.
- **Optional, not required:** GitHub's own secret-scanning push protection is a repository setting and
  is strictly better than a CI job, because it blocks the push instead of reporting after the fact. The
  `secrets` job is the portable floor, not a replacement.
- `schedule` triggers only run on the default branch, and GitHub disables them on repositories with no
  activity for 60 days.