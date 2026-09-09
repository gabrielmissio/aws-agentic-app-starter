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

The deploy prints a `DeployRoleArn` output. In the repository's GitHub settings, create an
**Environment** named `prod` and add these **variables**:

| Variable | Value | Scope |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output | **Repository** variable (see note) |
| `DEPLOY_ACCOUNT` | target AWS account id | `prod` Environment |
| `DEPLOY_REGION` | target region | `prod` Environment |
| `DEPLOY_PROFILE` | `prod` | `prod` Environment |
| `PROJECT_NAME` | your project name | `prod` Environment |

> **`AWS_DEPLOY_ROLE_ARN` must be a repository-scoped variable, not (only) an Environment one.** The
> `guard` job runs without `environment: prod` on purpose — so that a fork with required reviewers on
> the Environment does not block the "is CD configured?" check on a human approval. A job with no
> environment only sees repository-scoped variables, so the guard reads `AWS_DEPLOY_ROLE_ARN` at repo
> scope. The other `DEPLOY_*` values are read by the `deploy` job, which does declare the Environment,
> so they can live on the Environment (and inherit its protection rules).

Once `AWS_DEPLOY_ROLE_ARN` is set, `.github/workflows/deploy.yml` will deploy on every merge to
`main`. Until then, that workflow ends **green with a notice** — it never fails a fork that has not
opted in.

> `DEPLOY_PROFILE=prod` triggers the posture gate in `infra/src/config.ts`, which refuses sandbox
> defaults. The controls it requires under `prod` (tracing, retention, guardrail, …) must be set as
> Environment variables too, or the deploy fails by design.

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
