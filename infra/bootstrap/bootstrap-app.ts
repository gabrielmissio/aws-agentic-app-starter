#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { GithubOidcStack } from './github-oidc-stack.js'

/**
 * SEPARATE CDK entrypoint — this is NOT `src/app.ts`.
 *
 * The application stacks live in `src/app.ts` and are the ones `cdk deploy --all` (and the pipeline)
 * deploy. This app holds only the one-time, opt-in trust that lets GitHub Actions deploy on merge.
 * Because it is its own `cdk.App`, the application deploy command never sees it, and this command
 * never sees the application stacks.
 *
 * Run it ONCE, by hand, with a profile that can create IAM roles and an OIDC provider:
 *
 *   cd infra
 *   npx cdk --app "npx tsx bootstrap/bootstrap-app.ts" deploy \
 *     -c githubRepo=owner/repo
 *
 * Then copy the `DeployRoleArn` output into the GitHub "prod" Environment as AWS_DEPLOY_ROLE_ARN.
 *
 * Prerequisite: the account/region must already be `cdk bootstrap`-ed (default qualifier hnb659fds).
 *
 * Config is read from CDK context (`-c key=value`) first, then environment variables:
 *   githubRepo             (required) owner/repo, e.g. gabrielmissio/aws-agentic-app-starter
 *   allowedRef             (optional) default refs/heads/main
 *   cdkQualifier           (optional) default hnb659fds
 *   reuseExistingProvider  (optional) "true" if this account already has the GitHub OIDC provider
 *   githubOwnerId          (optional) numeric org/user id — pins the immutable subject claim
 *   githubRepoId           (optional) numeric repo id — pins the immutable subject claim
 */

const app = new cdk.App()

const ctx = (key: string): string | undefined => {
  const v = app.node.tryGetContext(key)
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

const githubRepo = ctx('githubRepo') ?? process.env.GITHUB_REPO
if (!githubRepo) {
  throw new Error(
    'githubRepo is required. Pass it with -c githubRepo=owner/repo or set GITHUB_REPO. ' +
      'Example: npx cdk --app "npx tsx bootstrap/bootstrap-app.ts" deploy -c githubRepo=gabrielmissio/aws-agentic-app-starter',
  )
}

const allowedRef = ctx('allowedRef') ?? process.env.GITHUB_ALLOWED_REF
const cdkQualifier = ctx('cdkQualifier') ?? process.env.CDK_QUALIFIER
const reuseExistingProvider =
  (ctx('reuseExistingProvider') ?? process.env.REUSE_EXISTING_OIDC_PROVIDER) === 'true'
const githubOwnerId = ctx('githubOwnerId') ?? process.env.GITHUB_OWNER_ID
const githubRepoId = ctx('githubRepoId') ?? process.env.GITHUB_REPO_ID

const projectName = ctx('projectName') ?? process.env.PROJECT_NAME ?? 'agentic-app-template'

new GithubOidcStack(app, `${projectName}-github-oidc`, {
  githubRepo,
  allowedRef,
  cdkQualifier,
  reuseExistingProvider,
  githubOwnerId,
  githubRepoId,
  env: {
    // Falls back to whatever the calling credentials resolve to, like the main app.
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION,
  },
  description: `GitHub OIDC trust + scoped deploy role for ${githubRepo}. Deploy once, out of band. See infra/bootstrap/README.md.`,
})
