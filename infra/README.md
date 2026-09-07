# Infra

AWS CDK app for the template's cloud resources: Cognito, the AgentCore runtime, the BFF and the
static frontend. Repository-level architecture lives in the root [README.md](../README.md).

## Setup

```bash
npm install
cp .env.example .env
```

| Script | Purpose |
|---|---|
| `npm run synth` | Build required artifacts and synthesize the CDK app |
| `npm run deploy` | Build required artifacts and deploy all stacks |
| `npm run deploy:no-approval` | The same with no confirmation prompt — sandbox or pipeline only |
| `npm run deploy:agent` / `deploy:bff` | Deploy a single stack |
| `npm run destroy` | Destroy all stacks |
| `npm run typecheck` / `test` | `tsc --noEmit` · vitest (builds `chatbot-bff` and `chatbot-frontend` first) |
| `npm run docker:setup-arm64` | Enable local ARM64 emulation for Docker |

Every script runs through `dotenvx run -f .env --overload`. The `--overload` matters: without it a
stale `export PROJECT_NAME=…` in your shell silently wins over `.env` and deploys the wrong stacks.

## Stacks

| Stack | What it holds |
|---|---|
| `auth` | Cognito user pool, the `admins` group, the CustomMessage email trigger |
| `agent` | The agent container, the Bedrock AgentCore Runtime, the conversation memory, the optional guardrail, and the deployment's KMS key |
| `bff` | API Gateway, the chat, admin and conversation Lambdas, the quota and conversation-index tables, alarms, budget, optional web ACL |
| `frontend` | S3 + CloudFront, and the runtime `config.js` written at deploy time |

`agent` before `bff` because the BFF's role is scoped to the runtime ARN, and because the memory
resource and the KMS key it creates are what the conversation routes read and every store in `bff` is
encrypted with; `bff` before `frontend` because `config.js` carries the API URL. `agent` needs
nothing from `auth` — see
[Why the BFF is the only transport](../chatbot-bff/README.md#why-the-bff-is-the-only-transport) for why that is
the point rather than an oversight.

### One key for the whole deployment

`AgentStack` creates a single customer-managed KMS key and `BffStack` uses it for its log groups,
both tables and the alarm topic. One key rather than one per service: an operator who has to reason
about which key protects what will get it wrong, and the blast radius of the key is the deployment
either way.

AWS-owned keys encrypt at rest too. What a CMK adds is that the grants are visible, auditable in
CloudTrail by key, and revocable — the difference between "encrypted" and "encrypted under a key we
control" that a pilot's security review actually asks about.

Two grants on it are easy to miss and fail silently if dropped: CloudWatch Logs encrypts *as the
service* and needs a statement scoped by encryption context, and an alarm publishing to an encrypted
topic is CloudWatch calling KMS — without that grant the alarm delivers nothing and reports nothing.

### Conversation memory

`AgentStack` creates an AgentCore Memory resource whose `eventExpiryDuration` **is** the retention
policy — enforced by the service rather than by a cleanup job this template would have to keep
correct. `CONVERSATION_RETENTION_DAYS` sets it, and the same number becomes the TTL on the
conversation index rows in `BffStack`, so the index cannot outlive the conversations it points at.

The grants split three ways, and the split is the point:

| Principal | Can | Cannot |
|---|---|---|
| Agent runtime | `CreateEvent`, `ListEvents`, `GetEvent` | Delete anything |
| Conversations Lambda | `ListEvents`, `GetEvent`, `DeleteEvent` | Write history, invoke the model |
| Chat Lambda | Invoke the runtime, `UpdateItem` on both tables | Read or write any stored conversation |

A browser-reachable function that could write history could also forge it, and a forged transcript is
worse than none because it is believed.

### What is recoverable, and what is not

`RETAIN_DATA` is about CloudFormation: it decides whether `cdk destroy` takes the stateful resources
with it. It is not a backup, and the two questions have different answers here.

| Holds | Survives `cdk destroy` | Survives a bad write or an out-of-band delete |
|---|---|---|
| Cognito user pool | `RETAIN_DATA` | **Yes** — `DeletionProtection` makes `DeleteUserPool` fail. No point-in-time restore of user records, though |
| Conversation index (DynamoDB) | `RETAIN_DATA` | **Yes** — continuous backups (PITR) are on, and `DeletionProtectionEnabled` follows `RETAIN_DATA`. Restore with `aws dynamodb restore-table-to-point-in-time` |
| Rate-limit counters (DynamoDB) | No, deliberately | No, deliberately — losing them resets every quota, and paying to protect disposable counters is spend with nothing to recover |
| **AgentCore Memory** (the conversations themselves) | `RETAIN_DATA` | **No.** See below |
| Frontend bucket | `RETAIN_DATA` | Not needed — it holds a rebuildable build |
| Log groups | No, deliberately | No — see the note on the telemetry group in `agent-stack.ts` |

**The gap worth knowing before a pilot: AgentCore Memory has no backup in this template.** The service
provides no point-in-time restore, and nothing here exports events on a schedule. So a deletion — by
the `/conversations` route, by `eventExpiryDuration` elapsing, or by a mistake — is final, and the
conversation index can be restored while the transcripts it points at cannot, which surfaces as
sidebar rows that open empty.

That is the correct default for a template: an export job is a data-residency and retention decision,
and writing conversation content into a second store contradicts the promise
`CONVERSATION_RETENTION_DAYS` makes. If your obligations require recoverable transcripts, add a
scheduled reader over `ListEvents` writing to a bucket with its own lifecycle — put it on the
conversations function's role, which already holds the read, and never on the chat function's.

### Where a data layer goes

There is none: the template stores no domain data, and the one table it creates — the rate-limit
counter — belongs to the BFF that reads it. A project adding one should put a `data` stack ahead of
`agent` and `bff`, and follow two rules:

**Grants go on the consumer's role, not the resource's policy.** `table.grantReadWriteData(role)`
writes into the *table's* policy, which lives in the data stack — making that stack depend on its
consumers, which already depend on it. An identity policy on the consumer keeps the dependency
one-directional and is equally effective.

**Grant the narrowest verb that works.** The rate-limit grant is `dynamodb:UpdateItem` alone,
because a conditional check-and-increment is the only operation the code performs.

## Environment variables

[.env.example](.env.example) documents every variable and is the source of truth. The map:

| Variable | Purpose |
|---|---|
| `AWS_REGION`, `PROJECT_NAME` | Region, and the prefix on every stack and resource name |
| `DEPLOY_PROFILE` | `demo` (default) · `pilot` · `prod` — decides what everything else may be |
| `DEPLOY_ACCOUNT` / `DEPLOY_REGION` | Where this stack belongs. Required under `pilot`/`prod`; a mismatch fails the synth |
| `BEDROCK_MODEL_ID` | The model the agent invokes — its role is scoped to this one and no other |
| `AGENT_IMAGE_PLATFORM` | Docker platform for the agent image. Defaults to `linux/arm64` |
| `PUBLIC_SIGNUP_ENABLED` | `true` (default) self sign-up · `false` invite-only |
| `COGNITO_MFA` | `off` (default) · `optional` · `required`. Authenticator app (TOTP) only |
| `COGNITO_THREAT_PROTECTION` | `off` (default) · `audit` · `enforced`. Anything but `off` moves the pool to the billed Plus plan |
| `WAF_ENABLED` | A web ACL on the API stage. Off in every profile — the only layer that filters *before* authentication |
| `GUARDRAIL_ENABLED` | A Bedrock guardrail on model input and output: content filters, prompt-attack detection, PII anonymization. Off by default (billed per text unit); **required** under `pilot`/`prod` |
| `TRACING_ENABLED` | X-Ray on the API stage and all three Lambdas, **plus the ADOT OpenTelemetry layer** that instruments the AWS SDK — without it a trace map stops at Lambda and the AgentCore call shows as `UnknownRemoteService`. Off by default (billed per trace); **required** under `pilot`/`prod` |
| `AGENT_OBSERVABILITY_ENABLED` | Spans and token/tool metrics from inside the agent container, plus its telemetry log group, masking policy and vended-log deliveries. Off by default; **required** under `pilot`/`prod`. AgentCore's own variable name, passed through unchanged |
| `TRANSACTION_SEARCH_ENABLED` | An **acknowledgement** that CloudWatch Transaction Search is on for this account and Region — nothing here creates it. **Required** under `pilot`/`prod`, because without it spans are accepted and then silently discarded. Verify with `aws xray get-trace-segment-destination` before deploying: it must read `CloudWatchLogs` **and** `ACTIVE` — see [Troubleshooting](#troubleshooting) |
| `CONVERSATION_RETENTION_DAYS` | How long a conversation is kept. Sets `eventExpiryDuration` on the memory resource, the TTL on the index rows, and the retention on the agent's telemetry log group, so a trace never outlives the turn it describes. **Required** under `pilot`/`prod`, with no default — the answer is yours |
| `MEMORY_MAX_MESSAGES` | How much history is replayed into a turn, default `40`. Every turn re-sends its context, so this bounds what a long conversation costs |
| `APP_URL` | Canonical app URL for the emails. Unset, falls back to what `frontend` published to SSM |
| `RETAIN_DATA` | `true` (default): the user pool and frontend bucket survive `cdk destroy` |
| `ALERT_EMAIL` | Subscribes an address to every CloudWatch alarm and to the budget. The alarms fire either way — without this nobody is notified |
| `MONTHLY_BUDGET_USD` | Notifies at 80% and 100%. Needs `ALERT_EMAIL`. A budget alerts; it cannot stop spend. Scoped to the **whole account**, not this project — see [.env.example](.env.example) |
| `API_RATE_LIMIT` / `API_BURST_LIMIT` | Stage throttling, default `10`/`20`. Unset, the stage inherits the account's 10,000 rps |
| `ALLOWED_ORIGIN` | CORS allowlist, default `*` — the CloudFront URL does not exist on a first deploy. Close it and redeploy `-bff` once it does |
| `USER_RATE_LIMIT` / `USER_RATE_LIMIT_WINDOW_SECONDS` | `/chat` calls per caller per window, default `20`/`60`. `API_RATE_LIMIT` bounds the account and cannot stop one caller consuming all of it |

API Gateway access logs — method, path, status, latency, caller `sub`, never the body — are always
on, in `/aws/apigateway/<project>-chat-api`. Every log group, table and the alarm topic are encrypted
with the deployment's own KMS key.

The four gated variables above are the *evidence* half of the profile gate: whether a turn is traced at
all, whether the agent's own decisions are recorded, whether the spans survive being accepted, and how
long any of it is kept. A deployment can satisfy every access rule and still answer none of those.

### Alarms

Seven, all publishing to the `<project>-alarms` topic. The first three fire on an error; the last four
fire on the failures that return **200**, which is why they exist — a turn can fail with nothing above
it looking wrong.

| Alarm | Fires when |
|---|---|
| `<project>-chat-errors` | The chat Lambda is failing — users see a broken conversation |
| `<project>-admin-errors` | The admin Lambda is failing — invites and the user list are broken |
| `<project>-api-5xx` | The API is returning 5XX — the failure is at or before the integration |
| `<project>-chat-latency` | p95 turn duration over 45s. Nothing is erroring; users are abandoning the turn |
| `<project>-agent-throttles` | AgentCore is throttling — the deployment is at a service quota, not broken |
| `<project>-agent-system-errors` | AgentCore is failing server-side, and the chat Lambda may still answer 200 |
| `<project>-bedrock-throttles` | Bedrock is throttling model calls — turns fail for capacity, not correctness |

`ALERT_EMAIL` is what puts a subscriber on the topic. `<project>-operations` is the dashboard to open
next: three rows — what the user got, which layer produced it, what the model was doing — with the
agent row present only when `AGENT_OBSERVABILITY_ENABLED` put those metrics there.

## Managing users and admins

Signed-in admins can invite users from the app itself (see
[chatbot-frontend](../chatbot-frontend/README.md#admin-panel)). The CLI below is how you create the
*first* admin, and the fallback when the app is unreachable.

Roles are Cognito **groups**, not a separate table. The `auth` stack declares one group, `admins`;
everyone else belongs to none. Membership lands in the `cognito:groups` claim.

```bash
# Resolve the pool and group names from the deployed stack
export POOL_ID=$(aws cloudformation describe-stacks --stack-name "${PROJECT_NAME}-auth" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
export ADMIN_GROUP=$(aws cloudformation describe-stacks --stack-name "${PROJECT_NAME}-auth" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminGroupName'].OutputValue" --output text)
```

**Create a user.** Cognito emails a temporary password; the first sign-in answers the
`NEW_PASSWORD_REQUIRED` challenge and the user picks their own.

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "new-user@example.com" \
  --user-attributes Name=email,Value="new-user@example.com" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Add `Name=custom:inviteLocale,Value=pt-BR` to send the invite in Portuguese. To skip the email
entirely — a seeded test account — pass `--message-action SUPPRESS` and set the password yourself:

```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" --username "new-user@example.com" \
  --password 'ReplaceMe!123' --permanent
```

**Grant and revoke admin.**

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL_ID" --username "new-user@example.com" --group-name "$ADMIN_GROUP"

aws cognito-idp admin-remove-user-from-group \
  --user-pool-id "$POOL_ID" --username "new-user@example.com" --group-name "$ADMIN_GROUP"
```

**Inspect.**

```bash
# Who is an admin today
aws cognito-idp list-users-in-group \
  --user-pool-id "$POOL_ID" --group-name "$ADMIN_GROUP" \
  --query 'Users[].Username' --output table

# Everyone, with their status
aws cognito-idp list-users --user-pool-id "$POOL_ID" \
  --query 'Users[].[Username,UserStatus,Enabled]' --output table

# One user's groups
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id "$POOL_ID" --username "new-user@example.com" \
  --query 'Groups[].GroupName' --output text
```

**Revoke access.** Disabling blocks sign-in and keeps the account; deleting is irreversible.

```bash
aws cognito-idp admin-disable-user --user-pool-id "$POOL_ID" --username "new-user@example.com"
aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL_ID" --username "new-user@example.com"
aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username "new-user@example.com"
```

> A group change only reaches the browser on the next token issuance — the user signs out and back
> in, or waits for the refresh token to mint a new one. `admin-user-global-sign-out` forces it.
> Removing someone from `admins` therefore does not revoke a token already issued; the BFF's admin
> routes re-check membership server-side on every call, so a stale claim can under-grant access but
> never over-grant it.

## Emails

Cognito sends two emails this stack controls: the admin invite and the self sign-up confirmation
code. Each is configured twice — a plain-text template on the user pool, and a
[CustomMessage trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-message.html)
(`lambdas/custom-message/`) that rewrites both as HTML. The trigger never throws: any failure falls
back to the plain-text version, so a broken template degrades an email rather than blocking sign-up.

Both follow the recipient's `custom:inviteLocale` (`en-US` or `pt-BR`, falling back to English),
written at sign-up by the frontend and at invite time by the admin routes. It must not be named
`locale` — that collides with a reserved standard attribute, and Cognito then never creates the
custom one. Adding a custom attribute is also a one-way door; it cannot be removed from a schema.

**Expect these to land in spam, and it isn't the HTML.** The default mailer sends from
`no-reply@verificationemail.com`, shared by every unconfigured Cognito pool: no domain alignment, a
reputation earned by everyone else using it, and a 50/day cap. **The fix is SES**, left unwired
because it needs a domain you control plus a manual step: verify a domain identity, add the DKIM
CNAMEs, then request production access (the SES sandbox only delivers to *verified* recipients,
which an invite flow cannot use). Then add
`email: cognito.UserPoolEmail.withSES({ fromEmail, fromName, sesVerifiedDomain })` to the `UserPool`
in `auth-stack.ts`.

## Troubleshooting

### The deploy fails on an X-Ray delivery destination

`cdk deploy` rolls back on the agent stack with:

```text
Resource handler returned message: "X-Ray Delivery Destination is supported with CloudWatch Logs as
a Trace Segment Destination. Please enable the CloudWatch Logs destination for your traces using the
UpdateTraceSegmentDestination API" (Service: CloudWatchLogs, Status Code: 400)
```

The `TRACES` delivery in `agent-stack.ts` is asking X-Ray to file this agent's spans, and X-Ray only
accepts that once the **account's** trace segment destination is CloudWatch Logs. That is not
something this stack sets — see the note on `TRANSACTION_SEARCH_ENABLED` above for why a template
must not reach into account-wide state.

Two things make this easy to hit even when you believe Transaction Search is on:

- **It is three settings, not one.** The console's *Enable Transaction Search* button applies a
  CloudWatch Logs resource policy, the trace segment destination, and an indexing rule together. A
  session saved in a different Region, or one that did not complete, can leave the destination on
  `XRay` while the rest looks configured.
- **It is applied asynchronously.** The destination reports `PENDING` for up to ~10 minutes, and a
  deploy against `PENDING` fails with this exact message — indistinguishable from never having
  enabled it.

Check which of the two you are in:

```bash
aws xray get-trace-segment-destination --region <your region>
```

| Output | Meaning |
|---|---|
| `"Destination": "XRay"` | Not enabled in this Region. Run the `update` below |
| `"Destination": "CloudWatchLogs"`, `"Status": "PENDING"` | Enabled, still propagating. Wait and retry the deploy — nothing to fix |
| `"Destination": "CloudWatchLogs"`, `"Status": "ACTIVE"` | Ready. If the deploy still fails, check the Region matches `DEPLOY_REGION` |

To set it — once per account and Region, with an identity that has X-Ray admin rights:

```bash
aws xray update-trace-segment-destination --destination CloudWatchLogs --region <your region>
```

Then wait for `ACTIVE` before re-running `cdk deploy`. Nothing needs to be rolled back or cleaned up
first: the failed stack update leaves no partial delivery behind.

### The deploy fails with "Not authorized to use the audit operation"

`cdk deploy` rolls back on the agent stack with:

```text
Received response status [FAILED] from custom resource. Message returned: Not authorized to use the
audit operation in the data protection policy
```

This reads like the account lacks a feature. It is four missing IAM actions.

The data protection policy sends its audit findings to a log group. Configuring that makes CloudWatch
Logs create a delivery and write a resource policy on the caller's behalf, and it checks the caller
for the rights to do so — so `logs:PutDataProtectionPolicy` alone is not enough. AWS documents the
set, and notes that a Lambda execution role performing the call needs them too:

| Action | Resource |
|---|---|
| `logs:PutDataProtectionPolicy` | the log group |
| `logs:CreateLogDelivery` | `*` |
| `logs:PutResourcePolicy` | `*` |
| `logs:DescribeResourcePolicies` | `*` |
| `logs:DescribeLogGroups` | `*` |

`governRuntimeLogGroup` grants all five to the custom resource that applies the policy. If you hit
this after editing that function, check that the last four survived — they look like over-broad
permissions worth trimming and they are not. The equivalent grant for the telemetry log group is
invisible because CloudFormation applies that policy under the deployment role, not through a Lambda.

See [IAM permissions required to create or work with a data protection
policy](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/data-protection-policy-permissions.html).

### The traces exist in the logs but the trace map is empty

`aws xray get-trace-summaries` and `get-service-graph` return nothing, and Transaction Search shows
far fewer traces than the agent actually served — while a Logs Insights query over the span log
groups finds them all.

This is sampling, not loss. Transaction Search stores **100%** of spans as structured logs and
**indexes** only a percentage of them for search and the trace map. The default is 1%:

```bash
aws xray get-indexing-rules --region <your region>
```

```json
{ "IndexingRules": [ { "Name": "Default", "Rule": { "Probabilistic": { "DesiredSamplingPercentage": 1.0 } } } ] }
```

Raise it when you are developing or piloting, where you want to open the map for a turn you just
made rather than for a random one in a hundred:

```bash
aws xray update-indexing-rule --name "Default" \
  --rule '{"Probabilistic": {"DesiredSamplingPercentage": 100}}' --region <your region>
```

This is account-and-Region-wide state, like Transaction Search itself, so this stack does not set it
— the same reasoning as `TRANSACTION_SEARCH_ENABLED`. Indexing is what Transaction Search bills on,
so 100% is a development setting; lower it before a workload with real volume.

Two related things worth knowing when the map still looks thin:

- **The legacy X-Ray APIs go quiet by design.** Once the trace segment destination is CloudWatch
  Logs, `BatchGetTraces`, `GetTraceSummaries` and `GetServiceGraph` stop being fed. Use Transaction
  Search in the CloudWatch console, or query the span log groups directly.
- **`lastEventTimestamp` lies.** `describe-log-streams` updates it on an eventual-consistency basis
  and it can trail by more than an hour, so a stream that looks stalled may be receiving fine. Use
  `filter-log-events` with a `--start-time` to tell whether spans are actually arriving.

### The deploy fails on a delivery source that "already exists"

`cdk deploy` rolls back on the agent stack with:

```text
Resource handler returned message: "Update to existing Delivery Source with new ResourceId is not
allowed. Please create a new Delivery Source instead. (Service: CloudWatchLogs, Status Code: 400)"
(HandlerErrorCode: AlreadyExists)
```

You are upgrading from a version of this template whose delivery sources named the runtime with a
wildcard ARN (`...:runtime/*`). That wildcard matched no runtime, so `APPLICATION_LOGS` and
`USAGE_LOGS` were never actually delivered — the fix points the source at the real runtime ARN.

CloudWatch Logs treats a delivery source's `resourceArn` as immutable, but the CloudFormation schema
declares only `Name` as create-only. CloudFormation therefore attempts an update where it should
have replaced, and the service refuses.

The current template already resolves this: the sources are named `<project>-agent-<log-type>`, and
changing the name is what makes CloudFormation replace rather than update. If you are on that version
and still see this error, you have an older source lingering under the previous name. List them:

```bash
aws logs describe-delivery-sources --region <your region> \
  --query 'deliverySources[?contains(name, `<project>`)].{name:name,arn:resourceArns[0]}'
```

Any entry whose ARN ends in `runtime/*` is the stale one. It is no longer referenced by the stack,
carries no data, and can be deleted:

```bash
aws logs delete-delivery-source --name <stale name> --region <your region>
```

Delete the delivery that references it first if the call complains it is in use. The stack itself
needs no cleanup — a rolled-back update leaves the previous, working configuration in place.

### Model access is denied on the first message

The deploy is green, all four stacks are up, and the first message in the chat answers with this
instead of a reply:

```text
Something went wrong: Model access is denied due to IAM user or service role is not authorized to
perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions,
aws-marketplace:Subscribe) to enable access to this model.
```

The same sentence is in the agent's log group as a `turn.failed` line carrying the correlation id,
which is the copy to reach for when the report arrives second-hand.

Nothing is misconfigured. Third-party models are sold through AWS Marketplace, and the **first**
invocation of one in an account makes Bedrock create the subscription in the background — which
requires the *invoking* principal to hold `aws-marketplace:Subscribe` and `ViewSubscriptions`. Here
the invoking principal is the AgentCore runtime's execution role, scoped in `agent-stack.ts` to
`bedrock:InvokeModel*` on one model and nothing else. So the auto-enablement fails, and it fails at
*chat* time rather than at deploy time — the stacks describe a runtime that is perfectly valid and
cannot yet reach a model.

The agreement is **per model, not per provider or per account**, so this returns every time
`BEDROCK_MODEL_ID` moves to a model this account has never invoked — including the first deploy of
this template, whichever model it names. The error also confirms the id is *valid*: an unknown one
fails validation long before Marketplace is consulted.

**Fix it once, with an admin identity — not with the runtime role.** Needs AWS CLI 2.27.42+:

```bash
# The FOUNDATION MODEL id: no `us.`/`eu.`/`global.` prefix, which names an inference profile.
MODEL=anthropic.claude-sonnet-5
REGION=us-east-1

aws bedrock get-foundation-model-availability --model-id $MODEL --region $REGION
aws bedrock list-foundation-model-agreement-offers --model-id $MODEL --region $REGION
aws bedrock create-foundation-model-agreement --model-id $MODEL --offer-token <OFFER_TOKEN> --region $REGION
aws bedrock get-foundation-model-availability --model-id $MODEL --region $REGION
```

The last call should report `agreementAvailability.status: AVAILABLE`. Wait about two minutes before
retrying the chat — the subscription is not instant, and calls in between still fail the same way.
Subscribing in one Region makes the model available to request in every Region it is offered in, so
a geography-scoped inference profile needs this done once, in the source Region.

Opening the model once in the Bedrock console playground, signed in as someone who holds the
Marketplace permissions, does the same thing through the same auto-enablement path.

If the agreement call asks for a use-case form, that is Anthropic's First Time Use requirement —
once per account, or once at an organization's management account, covering every Anthropic model.
`aws bedrock put-use-case-for-model-access` submits it.

**Do not fix this by granting `aws-marketplace:Subscribe` to the runtime role.** AWS is explicit that
the permission is needed only the first time a model is used in an account, and never afterwards, so
it would be a permanent grant bought for a one-time step — one that lets a container which relays
untrusted model output subscribe the account to arbitrary Marketplace products. Enable the model out
of band and the role works as it is written.
