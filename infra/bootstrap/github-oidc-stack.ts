import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'

/**
 * Provisions the trust that lets GitHub Actions deploy this repository into an AWS account WITHOUT
 * any long-lived key: a GitHub OIDC identity provider, plus one IAM role that only a workflow run
 * from this repository's `main` branch can assume.
 *
 * This stack is deliberately NOT part of `app.ts`. It has its own entrypoint (`bootstrap-app.ts`),
 * so `cdk deploy --all` — the command the pipeline runs — never sees it. Two reasons:
 *
 *   1. Chicken-egg. The application stacks are deployed *by* the role this stack creates. A role that
 *      grants deploy access cannot live inside the thing it deploys.
 *   2. Blast radius. The application stacks change every commit; this trust changes ~never. Keeping
 *      them apart means a routine `cdk deploy` can never rewrite the permissions that authorize it.
 *
 * Running this is OPTIONAL. A clone that never deploys it keeps working exactly as before: manual
 * `npm run deploy` from a laptop, and a credential-free CI. It only becomes relevant once someone
 * opts in to deploy-on-merge.
 */

export interface GithubOidcStackProps extends cdk.StackProps {
  /**
   * `owner/repo` this trust is scoped to, e.g. `gabrielmissio/aws-agentic-app-starter`. The role's
   * trust policy pins the OIDC `sub` claim to exactly this repository, so no other repo — and no
   * fork — can assume it.
   */
  readonly githubRepo: string
  /**
   * Git ref allowed to assume the role. Defaults to `refs/heads/main`, matching the deploy-on-merge
   * design. Widen it (e.g. to a tag pattern) only with intent.
   */
  readonly allowedRef?: string
  /**
   * The CDK bootstrap qualifier in use on the target account. The default `hnb659fds` is CDK's own
   * default; override only if this account was bootstrapped with `--qualifier`.
   */
  readonly cdkQualifier?: string
  /**
   * Reuse an OIDC provider that already exists in this account instead of creating a new one. An
   * account may hold exactly one provider for a given issuer URL, so set this to `true` if another
   * project already registered `token.actions.githubusercontent.com`.
   */
  readonly reuseExistingProvider?: boolean
  /**
   * Numeric GitHub owner (org/user) ID. Since 2026-07-15 GitHub issues OIDC tokens with an
   * *immutable* subject claim embedding numeric IDs — `repo:OWNER@<ownerId>/REPO@<repoId>:ref:…` —
   * for newly created or renamed repositories. When both `githubOwnerId` and `githubRepoId` are
   * given, the trust policy matches BOTH the classic slug form and this immutable form, so it keeps
   * working across a rename and cannot be satisfied by an attacker who reclaims a deleted slug.
   * Find the IDs with `gh api repos/<owner>/<repo> --jq '.owner.id, .id'`. Optional but recommended.
   */
  readonly githubOwnerId?: string
  /** Numeric GitHub repository ID. See `githubOwnerId`. */
  readonly githubRepoId?: string
}

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com'
const GITHUB_OIDC_DOMAIN = 'token.actions.githubusercontent.com'
/** GitHub's OIDC audience when using `aws-actions/configure-aws-credentials`. */
const AWS_STS_AUDIENCE = 'sts.amazonaws.com'
const DEFAULT_ALLOWED_REF = 'refs/heads/main'
const DEFAULT_CDK_QUALIFIER = 'hnb659fds'

export class GithubOidcStack extends cdk.Stack {
  /** ARN of the deploy role. Set this as `AWS_DEPLOY_ROLE_ARN` on the GitHub `prod` Environment. */
  public readonly deployRoleArn: string

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props)

    const allowedRef = props.allowedRef ?? DEFAULT_ALLOWED_REF
    const qualifier = props.cdkQualifier ?? DEFAULT_CDK_QUALIFIER

    if (!/^[\w.-]+\/[\w.-]+$/.test(props.githubRepo)) {
      throw new Error(
        `githubRepo must be "owner/repo", got: ${props.githubRepo}. Pass it via -c githubRepo=owner/repo or GITHUB_REPO.`,
      )
    }

    // The provider is the account-wide trust anchor. An account can hold only one per issuer URL, so
    // a second project must reuse it rather than create a duplicate — `reuseExistingProvider` covers
    // that. The thumbprint list is intentionally left to the CDK default: for an OIDC (not SAML)
    // provider IAM validates the JWT against the issuer's published JWKS, so the thumbprint is not
    // the security boundary here — the `sub` condition on the role below is.
    const provider = props.reuseExistingProvider
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidcProvider',
          `arn:${this.partition}:iam::${this.account}:oidc-provider/${GITHUB_OIDC_DOMAIN}`,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
          url: GITHUB_OIDC_URL,
          clientIds: [AWS_STS_AUDIENCE],
        })

    // The principal that may assume the role: a GitHub Actions run whose OIDC token proves it is this
    // repository at the allowed ref. `aud` is always the STS audience configure-aws-credentials
    // requests, asserted under StringEquals. `sub` is the identity claim, pinned to this repo + ref
    // (never a wildcard — a slug-only wildcard is reusable after a rename/delete and is a real attack
    // surface).
    //
    // Since 2026-07-15 GitHub issues an IMMUTABLE subject claim for new/renamed repos that embeds
    // numeric ids: `repo:OWNER@<ownerId>/REPO@<repoId>:ref:<ref>`. A classic-slug-only condition
    // silently fails to match those, denying every deploy. When the numeric ids are supplied we match
    // BOTH forms with StringLike; without them we fall back to an exact StringEquals on the classic
    // form (correct today, but add the ids before this repo is ever renamed).
    const classicSub = `repo:${props.githubRepo}:ref:${allowedRef}`
    const hasImmutableIds = Boolean(props.githubOwnerId && props.githubRepoId)

    const subConditions: Record<string, Record<string, string | string[]>> = hasImmutableIds
      ? (() => {
          const [owner, repo] = props.githubRepo.split('/')
          const immutableSub = `repo:${owner}@${props.githubOwnerId}/${repo}@${props.githubRepoId}:ref:${allowedRef}`
          return {
            StringLike: { [`${GITHUB_OIDC_DOMAIN}:sub`]: [classicSub, immutableSub] },
          }
        })()
      : { StringEquals: { [`${GITHUB_OIDC_DOMAIN}:sub`]: classicSub } }

    const principal = new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        [`${GITHUB_OIDC_DOMAIN}:aud`]: AWS_STS_AUDIENCE,
        ...(subConditions.StringEquals ?? {}),
      },
      ...(subConditions.StringLike ? { StringLike: subConditions.StringLike } : {}),
    })

    // The role holds NO service permissions of its own. It can only assume the roles that
    // `cdk bootstrap` already created — the deploy, file-publishing and image-publishing roles. Those
    // are what actually hold the power to change infrastructure; this role just lets a trusted
    // workflow "become" CDK. This is why the pipeline never needs AdministratorAccess.
    const bootstrapRolePattern = `arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-*-${this.account}-*`

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `github-deploy-${cdk.Names.uniqueResourceName(this, { maxLength: 40 })}`,
      assumedBy: principal,
      description: `Assumed by GitHub Actions (${props.githubRepo} @ ${allowedRef}) to run cdk deploy via the CDK bootstrap roles.`,
      maxSessionDuration: cdk.Duration.hours(1),
    })

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [bootstrapRolePattern],
        // The bootstrap roles are tagged with their purpose; this narrows the grant to CDK's own
        // roles even if another role happened to match the name pattern. The key MUST be the IAM
        // service-specific `iam:ResourceTag/*` — for tag-based authorization on an IAM role resource
        // the global `aws:ResourceTag/*` is not evaluated, so it would never match and would silently
        // deny every deploy after an apply that looks clean. Verified against AWS's own
        // "assume roles that have a specific tag" reference policy.
        conditions: {
          StringEquals: {
            'iam:ResourceTag/aws-cdk:bootstrap-role': [
              'deploy',
              'file-publishing',
              'image-publishing',
              'lookup',
            ],
          },
        },
      }),
    )

    this.deployRoleArn = deployRole.roleArn

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN variable on the GitHub "prod" Environment.',
    })
    new cdk.CfnOutput(this, 'GithubRepo', {
      value: props.githubRepo,
      description: 'Repository this deploy role trusts.',
    })
    new cdk.CfnOutput(this, 'AllowedRef', {
      value: allowedRef,
      description: 'Git ref allowed to assume the deploy role.',
    })
  }
}
