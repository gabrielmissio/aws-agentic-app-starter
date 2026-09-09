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

If deploy fails with *"provider already exists"*, another project already registered the GitHub
OIDC provider on this account — re-run with `-c reuseExistingProvider=true`.

## After deploy — wire the GitHub Environment

The deploy prints a `DeployRoleArn` output. In the repository's GitHub settings, create an
**Environment** named `prod` and add these **variables**:

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output |
| `DEPLOY_ACCOUNT` | target AWS account id |
| `DEPLOY_REGION` | target region |
| `DEPLOY_PROFILE` | `prod` |
| `PROJECT_NAME` | your project name |

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
