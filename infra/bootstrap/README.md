# GitHub OIDC deploy bootstrap (optional, one-time)

This directory holds a **separate, optional** CDK app that provisions the trust letting GitHub
Actions deploy this repository on merge to `main` — **without any long-lived AWS key**.

It is not part of `cdk deploy --all`. It has its own entrypoint, so the application deploy never
touches it and this never touches the application. **Skipping it changes nothing:** a clone that
never runs this keeps working exactly as before — manual `npm run deploy` from a laptop, and a
credential-free CI. Run it only when you want deploy-on-merge.

## What it creates

- A **GitHub OIDC identity provider** (`token.actions.githubusercontent.com`) — one per account.
- An **IAM deploy role** whose trust policy is pinned to
  `repo:<owner>/<repo>:ref:refs/heads/main`, so only a workflow run from this repo's `main` can
  assume it. The role holds **no** service permissions itself — it can only `sts:AssumeRole` into
  the roles `cdk bootstrap` already created. CDK holds the real power; the workflow just becomes CDK.

## Prerequisites

1. A profile with permission to create IAM roles and an OIDC provider (typically the same admin
   profile you already use for `npm run deploy`).
2. The target account/region already `cdk bootstrap`-ed with the default qualifier `hnb659fds`:
   ```
   npx cdk bootstrap aws://<account-id>/<region>
   ```

## Deploy it (once, by hand)

```
cd infra
npx cdk --app "npx tsx bootstrap/bootstrap-app.ts" deploy \
  -c githubRepo=gabrielmissio/aws-agentic-app-starter
```

Optional context flags:

| Flag | Default | Purpose |
|---|---|---|
| `-c githubRepo=owner/repo` | *(required)* | Repository the deploy role trusts. |
| `-c allowedRef=refs/heads/main` | `refs/heads/main` | Git ref allowed to assume the role. |
| `-c cdkQualifier=hnb659fds` | `hnb659fds` | Only if the account was bootstrapped with `--qualifier`. |
| `-c reuseExistingProvider=true` | `false` | Set if this account already has the GitHub OIDC provider. |
| `-c githubOwnerId=<id>` | *(unset)* | Numeric org/user id — pins the immutable subject claim (recommended). |
| `-c githubRepoId=<id>` | *(unset)* | Numeric repo id — pins the immutable subject claim (recommended). |

> **Recommended: pass the numeric ids.** Since 2026-07-15 GitHub issues OIDC tokens with an
> *immutable* subject claim (`repo:OWNER@<id>/REPO@<id>:ref:…`) for new or renamed repos. Passing
> `githubOwnerId`/`githubRepoId` makes the trust match both that form and the classic slug form, so
> the role keeps working across a rename and cannot be hijacked by someone reclaiming a deleted slug.
> Find them with:
> ```
> gh api repos/gabrielmissio/aws-agentic-app-starter --jq '.owner.id, .id'
> ```
> Without them the trust falls back to an exact match on the classic slug — correct today, but add
> the ids before the repo is ever renamed.

If deploy fails with *"provider already exists"*, another project already registered the GitHub
OIDC provider on this account — re-run with `-c reuseExistingProvider=true`.

## After deploy — wire the GitHub Environment

The deploy prints a `DeployRoleArn` output. You now register it (and the deploy target) as GitHub
**Variables** so the workflow can read them. None of these are secrets — the role ARN is not
sensitive (the trust policy is what protects it), so use **Variables**, not Secrets, throughout.

### Step 1 — create the `prod` Environment

In the repository on GitHub: **Settings → Environments → New environment**, name it `prod`, Configure.
(You can add required reviewers here later — see the note on the guard job below before you do.)

### Step 2 — set the role ARN as a REPOSITORY variable

**Settings → Secrets and variables → Actions → Variables tab → New repository variable:**

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output from the deploy |

> **Why repository scope, not the Environment?** The workflow's `guard` job runs *without*
> `environment: prod` on purpose — so a fork that puts required reviewers on the Environment does not
> block the "is CD configured?" check on a human approval. A job with no environment can only read
> repository-scoped variables, so the guard reads `AWS_DEPLOY_ROLE_ARN` at repo scope.

### Step 3 — set the deploy target + posture on the `prod` Environment

On the `prod` Environment page (**Settings → Environments → prod → Environment variables → Add
variable**), add these. The `deploy` job declares `environment: prod`, so it sees them.

**Deploy target:**

| Variable | Value |
|---|---|
| `PROJECT_NAME` | your project name (prefixes every resource) |
| `DEPLOY_ACCOUNT` | target AWS account id (12 digits) |
| `DEPLOY_REGION` | target region, e.g. `us-east-1` |
| `DEPLOY_PROFILE` | `prod` |

**Posture controls required under `DEPLOY_PROFILE=prod`.** The gate in `infra/src/config.ts`
(`assertDeploymentPosture`) refuses sandbox defaults and lists every missing one at once. Set all of
these, or the deploy fails by design:

| Variable | Value that satisfies the gate | Why |
|---|---|---|
| `PUBLIC_SIGNUP_ENABLED` | `false` | Open sign-up lets anyone mint accounts. |
| `ALLOWED_ORIGIN` | your app origin, e.g. `https://app.example.com` | `*` is the pre-frontend default. |
| `ALERT_EMAIL` | an address that receives alarms | Alarms fire into an empty room otherwise. |
| `COGNITO_MFA` | `required` | A password alone is one leak from someone's conversations. |
| `COGNITO_THREAT_PROTECTION` | `audit` or `enforced` | Note: moves the pool to the billed Cognito Plus plan. |
| `RETAIN_DATA` | `true` | A stack replacement would otherwise take every account with it. |
| `GUARDRAIL_ENABLED` | `true` | Nothing else filters model input/output. |
| `TRACING_ENABLED` | `true` | So a wrong answer is reconstructable across browser/BFF/agent. |
| `AGENT_OBSERVABILITY_ENABLED` | `true` | The agent is where the turn is decided. |
| `TRANSACTION_SEARCH_ENABLED` | `true` | Assertion, not a switch — enable it once per account/Region first (`infra/README.md`), then acknowledge it here. |
| `CONVERSATION_RETENTION_DAYS` | a number, e.g. `30` | How long recorded conversations are kept is your call. |

### Or set everything from the CLI (`gh`)

Faster and reproducible. From the repo directory:

```bash
# Repository variable (read by the guard job)
gh variable set AWS_DEPLOY_ROLE_ARN --body "arn:aws:iam::<account>:role/github-deploy-..."

# Environment variables (read by the deploy job)
for kv in \
  PROJECT_NAME=my-project \
  DEPLOY_ACCOUNT=123456789012 \
  DEPLOY_REGION=us-east-1 \
  DEPLOY_PROFILE=prod \
  PUBLIC_SIGNUP_ENABLED=false \
  ALLOWED_ORIGIN=https://app.example.com \
  ALERT_EMAIL=ops@example.com \
  COGNITO_MFA=required \
  COGNITO_THREAT_PROTECTION=enforced \
  RETAIN_DATA=true \
  GUARDRAIL_ENABLED=true \
  TRACING_ENABLED=true \
  AGENT_OBSERVABILITY_ENABLED=true \
  TRANSACTION_SEARCH_ENABLED=true \
  CONVERSATION_RETENTION_DAYS=30 ; do
  gh variable set "${kv%%=*}" --env prod --body "${kv#*=}"
done
```

### Step 4 — verify

```bash
gh variable list                 # AWS_DEPLOY_ROLE_ARN should be listed (repo scope)
gh variable list --env prod      # the DEPLOY_* + posture variables should be listed
```

Once `AWS_DEPLOY_ROLE_ARN` is set, `.github/workflows/deploy.yml` deploys on every merge to `main`.
Until then, that workflow ends **green with a notice** — it never fails a fork that has not opted in.
A good smoke test is **Actions → Deploy → Run workflow** (`workflow_dispatch`) before relying on the
merge trigger.

## Tear down

```
cd infra
npx cdk --app "npx tsx bootstrap/bootstrap-app.ts" destroy \
  -c githubRepo=gabrielmissio/aws-agentic-app-starter
```

Destroying removes the deploy role (and the OIDC provider, unless it was reused). The application
stacks are unaffected.

## Roadmap

- Multiple environments (`dev` / `hml` / `prod`) — one role + Environment each, with promotion.
- `cdk diff` on pull requests — a separate job assuming a **read-only** role via OIDC.
- Required reviewers on the `prod` Environment (approval gate).
