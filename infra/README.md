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
[Why the BFF is the only transport](../README.md#why-the-bff-is-the-only-transport) for why that is
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
| `TRACING_ENABLED` | X-Ray on the API stage and all three Lambdas. Off by default (billed per trace); **required** under `pilot`/`prod` |
| `CONVERSATION_RETENTION_DAYS` | How long a conversation is kept. Sets `eventExpiryDuration` on the memory resource and the TTL on the index rows. **Required** under `pilot`/`prod`, with no default — the answer is yours |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Where the agent container exports spans and token metrics. Passed through untouched; unset, the container's instruments stay silent while the Lambdas still trace |
| `MEMORY_MAX_MESSAGES` | How much history is replayed into a turn, default `40`. Every turn re-sends its context, so this bounds what a long conversation costs |
| `APP_URL` | Canonical app URL for the emails. Unset, falls back to what `frontend` published to SSM |
| `RETAIN_DATA` | `true` (default): the user pool and frontend bucket survive `cdk destroy` |
| `ALERT_EMAIL` | Subscribes an address to the three CloudWatch alarms and the budget. They fire either way |
| `MONTHLY_BUDGET_USD` | Notifies at 80% and 100%. Needs `ALERT_EMAIL`. A budget alerts; it cannot stop spend. Scoped to the **whole account**, not this project — see [.env.example](.env.example) |
| `API_RATE_LIMIT` / `API_BURST_LIMIT` | Stage throttling, default `10`/`20`. Unset, the stage inherits the account's 10,000 rps |
| `ALLOWED_ORIGIN` | CORS allowlist, default `*` — the CloudFront URL does not exist on a first deploy. Close it and redeploy `-bff` once it does |
| `USER_RATE_LIMIT` / `USER_RATE_LIMIT_WINDOW_SECONDS` | `/chat` calls per caller per window, default `20`/`60`. `API_RATE_LIMIT` bounds the account and cannot stop one caller consuming all of it |

API Gateway access logs — method, path, status, latency, caller `sub`, never the body — are always
on, in `/aws/apigateway/<project>-chat-api`. Every log group, table and the alarm topic are encrypted
with the deployment's own KMS key.

The three gated variables above are the *evidence* half of the profile gate: whether a deployment can
say what the agent replied, for how long it is kept, and which turn a user is complaining about. A
deployment can satisfy every access rule and still answer none of those.

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
