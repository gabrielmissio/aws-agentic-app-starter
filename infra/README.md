# Infra

AWS CDK application for provisioning the template's infrastructure.

This package owns the cloud resources for authentication, the Bedrock AgentCore runtime, the BFF, and the static frontend. Repository-level architecture and positioning live in the root [README.md](../README.md).

## Local setup

```bash
npm install
cp .env.example .env
```

## Useful scripts

| Script | Purpose |
|---|---|
| `npm run synth` | Build required dependencies and synthesize the CDK app |
| `npm run deploy` | Build required dependencies and deploy all stacks |
| `npm run deploy:agent` | Deploy only the agent stack |
| `npm run deploy:bff` | Build the BFF and deploy only the BFF stack |
| `npm run destroy` | Destroy all stacks |
| `npm run typecheck` | Run `tsc --noEmit` |
| `npm run test` | Build `chatbot-bff`/`chatbot-frontend`, then run the test suite (vitest) |
| `npm run docker:setup-arm64` | Enable local ARM64 emulation for Docker |

## Stacks

The CDK app provisions four stacks, in dependency order:

| Stack | What it holds |
|---|---|
| `auth` | Cognito user pool, the admin group, and the CustomMessage email trigger |
| `agent` | The agent container and the Bedrock AgentCore Runtime |
| `bff` | API Gateway plus the chat and admin Lambdas, the per-caller quota table, alarms, the budget and the optional web ACL |
| `frontend` | S3 and CloudFront hosting, plus the runtime `config.js` |

`agent` before `bff` because the BFF's role is scoped to the runtime ARN; `bff` before `frontend`
because the frontend's `config.js` carries the API URL. `agent` needs nothing from `auth` at all —
see the note on the transport below for why that is the point rather than an oversight.

### Where a data layer goes

There is deliberately none: this template stores no domain data, and the one table it does create —
the per-caller rate-limit counter — belongs to the BFF that reads it. A project that adds one should
add a `data` stack ahead of `agent` and `bff`, and follow two rules:

**Grants are identity-based, not resource-based.** `table.grantReadWriteData(role)` writes the
consumer's role into the *resource's* policy, which lives in the data stack — making that stack
depend on its consumers, which already depend on it. Adding the statement to the consumer's own role
keeps the dependency one-directional and is equally effective, since a table's default policy
delegates to account IAM.

**Grant the narrowest verb that works.** The rate-limit grant is `dynamodb:UpdateItem` and nothing
else, because a conditional check-and-increment is the only operation the code performs. A read-only
consumer of an audit trail gets `Query` and no write, so the surface that displays a log cannot
amend it.

`stacks.test.ts` asserts the security properties in [Guardrails](#guardrails) against the
synthesized template, so they fail in CI rather than in review.

## Environment variables

Use [infra/.env.example](.env.example) as the source of truth.

| Variable | Required | Purpose |
|---|---|---|
| `AWS_REGION` | Yes | Target deployment region |
| `PROJECT_NAME` | Yes | Prefix used for stack and resource naming |
| `AGENT_IMAGE_PLATFORM` | No | Docker platform for the agent image build |
| `DEPLOY_PROFILE` | No | `demo` (default), `pilot` or `prod`. Decides what everything below is *allowed* to be — see [Guardrails](#guardrails) |
| `DEPLOY_ACCOUNT` / `DEPLOY_REGION` | Under `pilot`/`prod` | The account and region this stack belongs in. A mismatch fails the synth before a resource is described |
| `BEDROCK_MODEL_ID` | No | The model the agent invokes. Its execution role is scoped to this model and no other |
| `COGNITO_MFA` | No | `off` (default), `optional` or `required`. Authenticator app (TOTP) only |
| `COGNITO_THREAT_PROTECTION` | No | `off` (default), `audit` or `enforced`. Anything but `off` moves the pool to the billed Plus plan |
| `WAF_ENABLED` | No | A web ACL in front of the API stage. Off by default in every profile |
| `PUBLIC_SIGNUP_ENABLED` | No | `true` (default): visitors can self sign-up. `false`: invite-only — see below |
| `APP_URL` | No | Canonical app URL, linked from the invite/verification emails. Unset, falls back to the frontend stack's CloudFront URL — see [Emails](#emails) |
| `RETAIN_DATA` | No | `true` (default): the user pool and frontend bucket survive `cdk destroy`. `false`: disposable environment — see below |
| `ALERT_EMAIL` | No | Subscribed to the CloudWatch alarms and the budget notification |
| `MONTHLY_BUDGET_USD` | No | Monthly spend ceiling that triggers a budget notification at 80%/100%. Requires `ALERT_EMAIL` |
| `API_RATE_LIMIT` / `API_BURST_LIMIT` | No | Requests/second (and burst above it) allowed on the API stage. Default `10` / `20` |
| `ALLOWED_ORIGIN` | No | Browser origin allowed to call the BFF (CORS). Default `*` — see [Guardrails](#guardrails) |
| `USER_RATE_LIMIT` / `USER_RATE_LIMIT_WINDOW_SECONDS` | No | Requests one signed-in caller gets on `/chat` per window (seconds). Default `20` / `60` — see [Guardrails](#guardrails) |

Additional runtime environment variables for the agent can also be passed through this package, including model and tool configuration.

> **There is no transport to choose.** The AgentCore runtime carries no authorizer configuration, so
> it accepts SigV4 alone, and the BFF's chat function is the only principal granted
> `bedrock-agentcore:InvokeAgentRuntime` on it. The browser holds a Cognito token and talks to API
> Gateway; it has no path to the runtime and no AWS credentials of its own — this stack creates no
> identity pool and no browser-assumable IAM role.
>
> That matters beyond tidiness. The agent learns who is asking from an identity block the BFF
> prepends to the prompt, built from claims the gateway authorizer already verified. The block is
> plain text, so it is exactly as trustworthy as whoever could have written it. A JWT authorizer on
> the runtime would let the browser call it directly, making "whoever" any signed-in user — and the
> agent's tools would act for whatever `userId` the block named.
>
> There is no Cognito identity pool at all, and adding one is the quiet way to bring that problem
> back, since every policy on its authenticated role is a policy granted to anyone who can sign in.
> `src/__tests__/stacks.test.ts` asserts the pool is absent, that no role is federated to Cognito,
> and that nothing here grants `InvokeAgentRuntime`, so a direct path cannot appear unnoticed.

## User provisioning (invite-only)

With `PUBLIC_SIGNUP_ENABLED=false`, self sign-up is disabled at the Cognito pool level — not just hidden in the UI, the public `SignUp` API rejects the client too. Every account is created by an operator:

```bash
COGNITO_USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name "${PROJECT_NAME}-auth" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

aws cognito-idp admin-create-user \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "new-user@example.com" \
  --user-attributes Name=email,Value="new-user@example.com" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Cognito emails the address a temporary password. On first sign-in the frontend's auth screen answers Cognito's `NEW_PASSWORD_REQUIRED` challenge, and the user picks their own password.

Signed-in admins can also invite users from the app itself — see [chatbot-frontend/README.md](../chatbot-frontend/README.md#admin-panel). This CLI path still matters as the way to create the *first* admin, and as a fallback if the app is unreachable.

## Admin group

Roles are Cognito **groups**, not a separate database. The `-auth` stack declares an `admins` group; everyone else is in no group. Cognito puts membership in the `cognito:groups` claim of both the id token and the access token, so it is readable by both the BFF (which sees the id token) and AgentCore (which sees the access token).

```bash
ADMIN_GROUP=$(aws cloudformation describe-stacks --stack-name "${PROJECT_NAME}-auth" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminGroupName'].OutputValue" --output text)

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$COGNITO_USER_POOL_ID" --username "new-user@example.com" --group-name "$ADMIN_GROUP"

# Who is an admin today
aws cognito-idp list-users-in-group \
  --user-pool-id "$COGNITO_USER_POOL_ID" --group-name "$ADMIN_GROUP" --query 'Users[].Username' --output table
```

Group changes only reach the browser on the next token issuance — the user has to sign out and back in, or wait for the refresh token to mint a new access token. The admin badge in the UI is cosmetic; the BFF's admin routes re-check group membership server-side on every call (see `chatbot-bff/src/admin.ts`), so a stale client-side claim can under-grant but never over-grant access.

## Emails

Cognito sends two emails this stack controls: the admin invite (temporary password) and the self
sign-up confirmation code. Both are configured twice: a plain-text template on the user pool itself
(`userInvitation` / `userVerification` in `auth-stack.ts`), and a
[CustomMessage trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-message.html)
(`lambdas/custom-message/`) that rewrites both as designed HTML. The trigger never throws — any
failure falls back to the plain-text template, so a broken template degrades an email rather than
blocking sign-up. It touches only these two trigger sources; forgot-password keeps Cognito's default.

The sign-in link needs the app's URL, which the auth stack cannot reference at synth time without a
cycle (`frontend` depends on `auth`, not the reverse). Set `APP_URL` explicitly, or leave it unset
and the trigger reads what `frontend-stack.ts` last published to SSM at `/<project>/app-url`. Before
that parameter exists the trigger omits the link rather than failing.

**Language.** Both emails follow the recipient's `custom:inviteLocale` attribute (`en-US` or `pt-BR`,
falling back to English), written at sign-up by the frontend and at invite time by the admin routes.
It must not be named `locale`: that collides with a reserved standard attribute, and the schema entry
becomes indistinguishable from declaring the standard one — so `custom:locale` is never created and
every write to it fails. Note that adding a custom attribute is a one-way door; Cognito cannot delete
one from a pool's schema.

**Expect these to land in spam, and it isn't the HTML.** The pool's default mailer sends from
`no-reply@verificationemail.com`, shared by every Cognito pool that hasn't configured a sender: no
SPF/DKIM/DMARC alignment with a domain the recipient's provider recognizes, a reputation earned by
every other pool using it, and a 50 emails/day cap. The template already follows the content-side
practices (documented in `email-template.mjs`), and none of them move a decision that is about sender
identity.

**The fix is SES**, which is not wired in because it needs a domain you control and a manual step CDK
cannot shortcut: verify a domain identity in SES, add the DKIM CNAMEs it gives you, then request
production access — a new SES account starts in a sandbox that only delivers to *verified*
recipients, which an invite flow cannot use. Once granted, add
`email: cognito.UserPoolEmail.withSES({ fromEmail, fromName, sesVerifiedDomain })` to the `UserPool`
in `auth-stack.ts` and redeploy.

## Guardrails

Opt-in settings whose failure mode is silent until it is expensive or irreversible. Each is described
in [.env.example](.env.example); what matters here is why they exist.

- **`RETAIN_DATA`** (default `true`) — the `RemovalPolicy` on the user pool and frontend bucket.
  Retaining in a throwaway environment leaves something to delete by hand; destroying in a real one
  deletes every account irreversibly. That asymmetry is why the default is retain.
- **`ALERT_EMAIL`** — subscribes an address to the SNS topic three CloudWatch alarms publish to (chat
  errors, admin errors, API Gateway 5XX). The alarms exist either way; without this nobody is told.
- **`MONTHLY_BUDGET_USD`** (needs `ALERT_EMAIL`) — notifies at 80% and 100%. A budget alerts, it
  cannot stop spend; it exists so a runaway loop is noticed in hours rather than on the invoice.
- **`API_RATE_LIMIT`** / **`API_BURST_LIMIT`** (default `10` / `20`) — stage throttling. Unset, the
  stage inherits the account's 10,000 rps, and every request that gets through costs Bedrock tokens.
- **`ALLOWED_ORIGIN`** (default `*`) — a comma-separated allowlist, or literal `*`. A listed origin is
  reflected back; anything else gets the first configured origin, which the calling page is not, so
  the browser refuses the response (`resolveOrigin` in `chatbot-bff/src/http.ts`). Setting it is what
  puts the value into both the Lambdas and the API Gateway CORS config. It defaults open because the
  frontend's CloudFront URL does not exist on a first `cdk deploy --all`; close it and redeploy `-bff`
  once the app has a real origin.
- **`USER_RATE_LIMIT`** / **`USER_RATE_LIMIT_WINDOW_SECONDS`** (default `20` / `60`) — `/chat` calls
  per caller per window. `API_RATE_LIMIT` bounds the account and cannot stop one caller consuming all
  of it, since API Gateway has no per-JWT-claim throttling. The chat Lambda enforces this itself
  against a small DynamoDB table of disposable counters (`chatbot-bff/src/rate-limit.ts`).

API Gateway access logs — method, path, status, latency, caller `sub`, never the request body — are
always on, in `/aws/apigateway/<project>-chat-api`, independent of `ALERT_EMAIL`.

## Notes

- The frontend and BFF are built before synth or deploy through package scripts
- The agent image defaults to `linux/arm64`
- If Docker cannot build the ARM64 image locally, use the troubleshooting guidance in the root [README.md](../README.md#troubleshooting)
- All scripts run through `dotenvx run -f .env --overload`. Without `--overload`, `dotenvx` does not override a variable already exported in the shell — a stale `export PROJECT_NAME=…` left in a terminal would silently win over `.env` and deploy against the wrong stacks with no warning.
