/**
 * Synthesized-template assertions for the GitHub OIDC deploy trust. Each guards a property whose
 * loss would silently break a deploy or weaken the trust — the kind of regression a fork would not
 * notice until an assume-role fails against a real account.
 */
import { describe, expect, it } from 'vitest'
import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { GithubOidcStack } from '../github-oidc-stack.js'

const REPO = 'gabrielmissio/aws-agentic-app-starter'

function synth(props?: Partial<Parameters<typeof makeStack>[0]>) {
  return makeStack({ githubRepo: REPO, ...props })
}

function makeStack(props: {
  githubRepo: string
  githubOwnerId?: string
  githubRepoId?: string
  reuseExistingProvider?: boolean
}) {
  const app = new cdk.App()
  const stack = new GithubOidcStack(app, 'test-github-oidc', {
    ...props,
    env: { account: '123456789012', region: 'us-east-1' },
  })
  return Template.fromStack(stack)
}

describe('GithubOidcStack', () => {
  it('grants assume-role on the CDK bootstrap roles via iam:ResourceTag, NOT the global aws:ResourceTag', () => {
    // The global aws:ResourceTag is not evaluated for tag-based auth on an IAM role resource, so the
    // wrong prefix would never match and would silently deny every deploy. This locks the correct key.
    const t = synth()
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Condition: {
              StringEquals: {
                'iam:ResourceTag/aws-cdk:bootstrap-role': Match.arrayWith([
                  'deploy',
                  'file-publishing',
                  'image-publishing',
                ]),
              },
            },
          }),
        ]),
      },
    })
  })

  it('never grants assume-role via the global aws:ResourceTag key', () => {
    const t = synth()
    const policies = t.findResources('AWS::IAM::Policy')
    const json = JSON.stringify(policies)
    expect(json).not.toContain('aws:ResourceTag/aws-cdk:bootstrap-role')
  })

  it('pins the sub claim to this repo + ref exactly when no numeric ids are given (classic form)', () => {
    const t = synth()
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: Match.objectLike({
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': `repo:${REPO}:ref:refs/heads/main`,
              }),
            },
          }),
        ]),
      },
    })
  })

  it('matches BOTH the classic and immutable subject-claim forms when numeric ids are given', () => {
    const t = synth({ githubOwnerId: '123456', githubRepoId: '789012' })
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              // aud stays an exact match...
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              // ...sub becomes a two-entry StringLike list (classic + immutable-id).
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  `repo:${REPO}:ref:refs/heads/main`,
                  'repo:gabrielmissio@123456/aws-agentic-app-starter@789012:ref:refs/heads/main',
                ],
              },
            },
          }),
        ]),
      },
    })
  })

  it('caps the role session at one hour (must stay >= the workflow role-duration-seconds)', () => {
    const t = synth()
    t.hasResourceProperties('AWS::IAM::Role', { MaxSessionDuration: 3600 })
  })

  it('creates its own OIDC provider by default, and imports one when reuseExistingProvider is set', () => {
    synth().resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1)
    synth({ reuseExistingProvider: true }).resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0)
  })

  it('rejects a githubRepo that is not owner/repo', () => {
    expect(() => synth({ githubRepo: 'not-a-repo' })).toThrow(/owner\/repo/)
  })
})
