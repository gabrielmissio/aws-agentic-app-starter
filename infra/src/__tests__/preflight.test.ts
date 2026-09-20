import { describe, expect, it } from 'vitest'
import {
  classifyFailure,
  exitCode,
  formatReport,
  isCliTooOld,
  runPreflight,
  transactionSearchPolicy,
  type AwsCli,
  type AwsResult,
  type CheckResult,
  type PreflightReport,
} from '../preflight.js'

const ACCOUNT = '123456789012'
const MODEL = 'anthropic.claude-sonnet-5'

const json = (value: unknown): AwsResult => ({ ok: true, output: JSON.stringify(value) })
const failure = (code: string, message = `An error occurred (${code}) when calling the operation`): AwsResult => ({
  ok: false,
  code,
  message,
})

const IDENTITY = 'sts get-caller-identity'
const TOOLKIT = 'cloudformation describe-stacks --stack-name CDKToolkit'
const DESTINATION = 'xray get-trace-segment-destination'
const POLICIES = 'logs describe-resource-policies'
const AVAILABILITY = `bedrock get-foundation-model-availability --model-id ${MODEL}`
const FORM = 'bedrock get-use-case-for-model-access'

const availability = (agreement: string, extra: Record<string, string> = {}) =>
  json({
    agreementAvailability: { status: agreement },
    authorizationStatus: 'AUTHORIZED',
    entitlementAvailability: 'AVAILABLE',
    regionAvailability: 'AVAILABLE',
    ...extra,
  })

/** A new account that is fully set up. Individual tests knock one thing out of it. */
const READY: Record<string, AwsResult> = {
  [IDENTITY]: json({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/dev` }),
  [TOOLKIT]: json({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }),
  '--version': { ok: true, output: 'aws-cli/2.34.31 Python/3.14.4 Linux/5.15 exe/x86_64.ubuntu.24' },
  [AVAILABILITY]: availability('AVAILABLE'),
}

/**
 * Answers by the arguments before `--region`, and records every call. An unscripted call fails
 * loudly rather than returning something plausible — a check that reaches for an API the test did
 * not expect is a finding, not a default.
 */
function fakeAws(replies: Record<string, AwsResult>) {
  const calls: string[] = []
  const aws: AwsCli = async (args) => {
    const at = args.indexOf('--region')
    const key = (at === -1 ? args : args.slice(0, at)).join(' ')
    calls.push(key)
    return replies[key] ?? failure('Unscripted', `no reply scripted for: ${key}`)
  }
  return { aws, calls }
}

const run = (
  replies: Record<string, AwsResult>,
  env: Record<string, string> = {},
  githubOidc = false,
) => {
  const fake = fakeAws({ ...READY, ...replies })
  return runPreflight({ env: { AWS_REGION: 'us-east-1', ...env }, githubOidc }, fake.aws).then(
    (report) => ({ report, calls: fake.calls }),
  )
}

const check = (report: PreflightReport, title: string): CheckResult => {
  const found = report.results.find((r) => r.title === title)
  if (!found) throw new Error(`no check titled "${title}" in: ${report.results.map((r) => r.title).join(', ')}`)
  return found
}

describe('a fully prepared account', () => {
  it('passes, and asks for nothing it does not need', async () => {
    const { report, calls } = await run({})

    expect(exitCode(report)).toBe(0)
    expect(report.results.map((r) => r.status)).toEqual(['ok', 'ok', 'skip', 'ok'])
    // Observability is off, so X-Ray is never asked; the agreement is there, so the form never is.
    expect(calls).not.toContain(DESTINATION)
    expect(calls).not.toContain(FORM)
  })

  it('never issues a call that writes', async () => {
    const { calls } = await run(
      {
        [AVAILABILITY]: availability('NOT_AVAILABLE'),
        [FORM]: failure('ResourceNotFoundException'),
        [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }),
        [POLICIES]: json({ resourcePolicies: [] }),
      },
      { AGENT_OBSERVABILITY_ENABLED: 'true' },
      true,
    )

    const writes = calls.filter((c) =>
      /(^|\s)(put|create|update|delete|attach|set)-/.test(c),
    )
    expect(writes).toEqual([])
  })
})

describe('credentials and target', () => {
  it('stops at the first check when there are no credentials, since nothing else can run', async () => {
    const { report, calls } = await run({ [IDENTITY]: failure('NoCredentials', 'Unable to locate credentials') })

    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.status).toBe('fail')
    expect(report.results[0]?.fix?.join('\n')).toMatch(/AWS_PROFILE/)
    expect(calls).toEqual([IDENTITY])
    expect(exitCode(report)).toBe(1)
  })

  it('names the profile in the SSO hint when one is exported', async () => {
    const { report } = await run(
      { [IDENTITY]: failure('ExpiredToken') },
      { AWS_PROFILE: 'my-sso' },
    )

    expect(report.results[0]?.fix?.join('\n')).toContain('aws sso login --profile my-sso')
  })

  it('reports a missing CLI as such rather than as bad credentials', async () => {
    const { report } = await run({ [IDENTITY]: failure('CliMissing', 'The `aws` command was not found on PATH.') })

    expect(report.results[0]?.detail.join('\n')).toMatch(/not found on PATH/)
    expect(report.results[0]?.fix?.join('\n')).toMatch(/Install the AWS CLI/)
  })

  it('applies the same account pin `cdk synth` would, before anything is built', async () => {
    const { report } = await run({}, { DEPLOY_ACCOUNT: '999999999999' })

    const target = check(report, 'Deployment target')
    expect(target.status).toBe('fail')
    expect(target.detail.join('\n')).toContain('DEPLOY_ACCOUNT is 999999999999')
    expect(exitCode(report)).toBe(1)
  })

  it('refuses a pilot with no pin, exactly as the synth does', async () => {
    const { report } = await run({}, { DEPLOY_PROFILE: 'pilot' })

    expect(check(report, 'Deployment target').detail.join('\n')).toMatch(/requires DEPLOY_ACCOUNT and DEPLOY_REGION/)
  })

  it('checks the pinned Region, not whatever else is in the environment', async () => {
    const seen: string[] = []
    const aws: AwsCli = async (args) => {
      seen.push(args[args.indexOf('--region') + 1] ?? '')
      return failure('Unscripted')
    }
    await runPreflight(
      { env: { AWS_REGION: 'us-east-1', DEPLOY_REGION: 'eu-west-1' }, githubOidc: false },
      aws,
    )

    expect(seen).toEqual(['eu-west-1'])
  })

  it('reports an unparseable value as configuration, not as a crash', async () => {
    const { report } = await run({}, { DEPLOY_PROFILE: 'staging' })

    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.title).toBe('Configuration')
    expect(report.results[0]?.detail.join('\n')).toMatch(/Unsupported DEPLOY_PROFILE/)
  })
})

describe('CDK bootstrap', () => {
  it('prints the bootstrap command for this exact account and Region when the toolkit is missing', async () => {
    const { report } = await run({
      [TOOLKIT]: failure('ValidationError', 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist'),
    })

    const toolkit = check(report, 'CDK bootstrap')
    expect(toolkit.status).toBe('fail')
    expect(toolkit.fix).toEqual([`npm --prefix infra run cdk -- bootstrap aws://${ACCOUNT}/us-east-1`])
  })

  it('fails a toolkit stack stuck in a state that cannot take an asset', async () => {
    const { report } = await run({ [TOOLKIT]: json({ Stacks: [{ StackStatus: 'ROLLBACK_COMPLETE' }] }) })

    expect(check(report, 'CDK bootstrap').status).toBe('fail')
  })

  it('accepts a toolkit that was updated after creation', async () => {
    const { report } = await run({ [TOOLKIT]: json({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }) })

    expect(check(report, 'CDK bootstrap').status).toBe('ok')
  })

  it('says it could not check, rather than that it is missing, when the read is denied', async () => {
    const { report } = await run({ [TOOLKIT]: failure('AccessDenied') })

    expect(check(report, 'CDK bootstrap').status).toBe('warn')
    expect(exitCode(report)).toBe(0)
  })
})

describe('Transaction Search', () => {
  const OBSERVED = { AGENT_OBSERVABILITY_ENABLED: 'true' }

  it('is skipped while nothing needs it', async () => {
    const { report, calls } = await run({})

    expect(check(report, 'CloudWatch Transaction Search').status).toBe('skip')
    expect(calls).not.toContain(DESTINATION)
  })

  it('is checked once agent observability is on', async () => {
    const { report } = await run({ [DESTINATION]: json({ Destination: 'CloudWatchLogs', Status: 'ACTIVE' }) }, OBSERVED)

    expect(check(report, 'CloudWatch Transaction Search').status).toBe('ok')
  })

  it('is checked for deploy-on-merge even when the local .env has observability off', async () => {
    const { report } = await run(
      { [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }), [POLICIES]: json({ resourcePolicies: [] }) },
      {},
      true,
    )

    const search = check(report, 'CloudWatch Transaction Search')
    expect(search.status).toBe('fail')
    expect(search.detail.join('\n')).toMatch(/deploy-on-merge runs under `prod`/)
  })

  it('treats PENDING as not-yet, with nothing to fix but waiting', async () => {
    const { report } = await run({ [DESTINATION]: json({ Destination: 'CloudWatchLogs', Status: 'PENDING' }) }, OBSERVED)

    const search = check(report, 'CloudWatch Transaction Search')
    expect(search.status).toBe('pending')
    expect(exitCode(report)).toBe(1)
    expect(search.fix?.join('\n')).not.toContain('update-trace-segment-destination')
  })

  it('puts the resource policy BEFORE the destination change on a fresh account', async () => {
    const { report } = await run(
      { [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }), [POLICIES]: json({ resourcePolicies: [] }) },
      OBSERVED,
    )

    const fix = check(report, 'CloudWatch Transaction Search').fix?.join('\n') ?? ''
    expect(fix).toContain('logs put-resource-policy')
    expect(fix.indexOf('logs put-resource-policy')).toBeLessThan(fix.indexOf('xray update-trace-segment-destination'))
    expect(fix.indexOf('xray update-trace-segment-destination')).toBeLessThan(fix.lastIndexOf('xray get-trace-segment-destination'))
  })

  it('omits the policy step when the account already has it', async () => {
    const policy = JSON.stringify(transactionSearchPolicy({ partition: 'aws', region: 'us-east-1', account: ACCOUNT }))
    const { report } = await run(
      {
        [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }),
        [POLICIES]: json({ resourcePolicies: [{ policyName: 'console-made', policyDocument: policy }] }),
      },
      OBSERVED,
    )

    const fix = check(report, 'CloudWatch Transaction Search').fix?.join('\n') ?? ''
    expect(fix).not.toContain('put-resource-policy')
    expect(fix).toContain('update-trace-segment-destination --destination CloudWatchLogs')
  })

  it('does not mistake an unrelated resource policy for the X-Ray one', async () => {
    const { report } = await run(
      {
        [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }),
        [POLICIES]: json({ resourcePolicies: [{ policyDocument: '{"Principal":{"Service":"es.amazonaws.com"}}' }] }),
      },
      OBSERVED,
    )

    expect(check(report, 'CloudWatch Transaction Search').fix?.join('\n')).toContain('put-resource-policy')
  })

  it('prints a policy that is valid JSON, names X-Ray, and is scoped to this account and Region', async () => {
    const { report } = await run(
      { [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }), [POLICIES]: json({ resourcePolicies: [] }) },
      { ...OBSERVED, AWS_REGION: 'eu-west-1' },
    )

    const command = check(report, 'CloudWatch Transaction Search').fix?.find((l) => l.includes('put-resource-policy')) ?? ''
    const document = /--policy-document '([^']+)'/.exec(command)?.[1]
    const parsed = JSON.parse(document ?? 'null')

    expect(parsed.Statement[0].Principal.Service).toBe('xray.amazonaws.com')
    expect(parsed.Statement[0].Action).toBe('logs:PutLogEvents')
    expect(parsed.Statement[0].Resource).toEqual([
      `arn:aws:logs:eu-west-1:${ACCOUNT}:log-group:aws/spans:*`,
      `arn:aws:logs:eu-west-1:${ACCOUNT}:log-group:/aws/application-signals/data:*`,
    ])
    expect(parsed.Statement[0].Condition.StringEquals['aws:SourceAccount']).toBe(ACCOUNT)
    expect(command).toContain('--region eu-west-1')
  })

  it('takes the partition from the caller rather than assuming `aws`', async () => {
    const { report } = await run(
      {
        [IDENTITY]: json({ Account: ACCOUNT, Arn: `arn:aws-us-gov:iam::${ACCOUNT}:user/dev` }),
        [DESTINATION]: json({ Destination: 'XRay', Status: 'ACTIVE' }),
        [POLICIES]: json({ resourcePolicies: [] }),
      },
      OBSERVED,
    )

    expect(check(report, 'CloudWatch Transaction Search').fix?.join('\n')).toContain('arn:aws-us-gov:logs:')
  })
})

describe('Bedrock model access', () => {
  it('asks about the foundation model, not the inference profile the app names', async () => {
    const { calls } = await run({}, { BEDROCK_MODEL_ID: `global.${MODEL}` })

    expect(calls).toContain(AVAILABILITY)
    expect(calls.some((c) => c.includes('global.anthropic'))).toBe(false)
  })

  it('reads BEDROCK_MODEL_ID, with the template default when unset', async () => {
    const { calls } = await run({})

    expect(calls).toContain('bedrock get-foundation-model-availability --model-id anthropic.claude-sonnet-5')
  })

  it('submits the use-case form first when Anthropic has none on file', async () => {
    const { report } = await run({
      [AVAILABILITY]: availability('NOT_AVAILABLE'),
      [FORM]: failure('ResourceNotFoundException'),
    })

    const access = check(report, 'Bedrock model access')
    const fix = access.fix?.join('\n') ?? ''
    expect(access.status).toBe('fail')
    expect(fix).toContain('put-use-case-for-model-access')
    expect(fix.indexOf('put-use-case-for-model-access')).toBeLessThan(fix.indexOf('create-foundation-model-agreement'))
    expect(fix.indexOf('list-foundation-model-agreement-offers')).toBeLessThan(fix.indexOf('create-foundation-model-agreement'))
    expect(fix).toContain(`--model-id ${MODEL}`)
  })

  it('leaves the form out when it is already on file', async () => {
    const { report } = await run({
      [AVAILABILITY]: availability('NOT_AVAILABLE'),
      [FORM]: json({ formData: 'ZXhhbXBsZQ==' }),
    })

    const fix = check(report, 'Bedrock model access').fix?.join('\n') ?? ''
    expect(fix).not.toContain('put-use-case-for-model-access')
    expect(fix).toContain('create-foundation-model-agreement')
  })

  it('keeps the form in the fix, conditionally, when it cannot tell whether one is on file', async () => {
    const { report } = await run({
      [AVAILABILITY]: availability('NOT_AVAILABLE'),
      [FORM]: failure('AccessDeniedException'),
    })

    const fix = check(report, 'Bedrock model access').fix?.join('\n') ?? ''
    expect(fix).toContain('put-use-case-for-model-access')
    expect(fix).toMatch(/If step 3 answers "You have not filled out the request form"/)
  })

  it('numbers its steps so the reference to "step 3" points at the agreement', async () => {
    const { report } = await run({
      [AVAILABILITY]: availability('NOT_AVAILABLE'),
      [FORM]: failure('AccessDeniedException'),
    })

    const lines = check(report, 'Bedrock model access').fix ?? []
    const step3 = lines.find((l) => l.startsWith('# 3.')) ?? ''
    expect(step3).toMatch(/Create the agreement/)
  })

  it('never asks about the Anthropic form for another provider', async () => {
    const other = 'cohere.command-r-v1:0'
    const { report, calls } = await run(
      {
        [`bedrock get-foundation-model-availability --model-id ${other}`]: availability('NOT_AVAILABLE'),
      },
      { BEDROCK_MODEL_ID: other },
    )

    expect(calls).not.toContain(FORM)
    expect(check(report, 'Bedrock model access').fix?.join('\n')).not.toContain('put-use-case-for-model-access')
  })

  it('does not look for an agreement on a first-party model, which has none to find', async () => {
    const { report, calls } = await run({}, { BEDROCK_MODEL_ID: 'us.amazon.nova-pro-v1:0' })

    expect(check(report, 'Bedrock model access').status).toBe('skip')
    expect(calls.some((c) => c.startsWith('bedrock'))).toBe(false)
  })

  it('reads a denial as an IAM or SCP problem, which no agreement fixes', async () => {
    const { report } = await run({ [AVAILABILITY]: availability('NOT_AVAILABLE', { authorizationStatus: 'NOT_AUTHORIZED' }) })

    const access = check(report, 'Bedrock model access')
    expect(access.status).toBe('fail')
    expect(access.detail.join('\n')).toMatch(/IAM or an SCP/)
    expect(access.fix?.join('\n')).not.toContain('create-foundation-model-agreement')
  })

  it('fails on a CLI too old to know the agreement commands, before asking one', async () => {
    const { report, calls } = await run({ '--version': { ok: true, output: 'aws-cli/2.27.10 Python/3.13' } })

    expect(check(report, 'Bedrock model access').status).toBe('fail')
    expect(check(report, 'Bedrock model access').detail.join('\n')).toMatch(/2\.27\.42/)
    expect(calls).not.toContain(AVAILABILITY)
  })

  it('recognizes an old CLI from its own complaint when the version string cannot be read', async () => {
    const { report } = await run({
      '--version': { ok: true, output: 'something unexpected' },
      [AVAILABILITY]: failure('CliTooOld', 'aws: error: argument operation: Invalid choice'),
    })

    expect(check(report, 'Bedrock model access').status).toBe('fail')
  })

  it('warns, and does not fail, when the read is denied', async () => {
    const { report } = await run({ [AVAILABILITY]: failure('AccessDeniedException') })

    expect(check(report, 'Bedrock model access').status).toBe('warn')
    expect(exitCode(report)).toBe(0)
  })

  it('warns when the foundation model is not offered in the Region, since a profile may still route', async () => {
    const { report } = await run({ [AVAILABILITY]: availability('AVAILABLE', { regionAvailability: 'NOT_AVAILABLE' }) })

    expect(check(report, 'Bedrock model access').status).toBe('warn')
  })

  it('adds --profile to every printed command when one is exported', async () => {
    const { report } = await run(
      { [AVAILABILITY]: availability('NOT_AVAILABLE'), [FORM]: json({}) },
      { AWS_PROFILE: 'labs-admin' },
    )

    const commands = (check(report, 'Bedrock model access').fix ?? []).filter((l) => l.includes('aws bedrock'))
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) expect(command).toContain('--profile labs-admin')
  })

  it('quotes a profile name that a shell would misread', async () => {
    const { report } = await run(
      { [AVAILABILITY]: availability('NOT_AVAILABLE'), [FORM]: json({}) },
      { AWS_PROFILE: 'a b; rm -rf ~' },
    )

    expect((check(report, 'Bedrock model access').fix ?? []).join('\n')).toContain(`--profile 'a b; rm -rf ~'`)
  })
})

describe('GitHub OIDC provider', () => {
  const LIST = 'iam list-open-id-connect-providers'

  it('is not asked about unless deploy-on-merge is being set up', async () => {
    const { report, calls } = await run({})

    expect(report.results.some((r) => r.title === 'GitHub OIDC provider')).toBe(false)
    expect(calls).not.toContain(LIST)
  })

  it('tells the bootstrap to reuse a provider another project already registered', async () => {
    const { report } = await run(
      {
        [LIST]: json({ OpenIDConnectProviderList: [{ Arn: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com` }] }),
        [DESTINATION]: json({ Destination: 'CloudWatchLogs', Status: 'ACTIVE' }),
      },
      {},
      true,
    )

    const provider = check(report, 'GitHub OIDC provider')
    expect(provider.status).toBe('info')
    expect(provider.fix?.join('\n')).toContain('reuseExistingProvider=true')
  })

  it('says no flag is needed on an account with no provider, and never fails on it', async () => {
    const { report } = await run(
      { [LIST]: json({ OpenIDConnectProviderList: [] }), [DESTINATION]: json({ Destination: 'CloudWatchLogs', Status: 'ACTIVE' }) },
      {},
      true,
    )

    const provider = check(report, 'GitHub OIDC provider')
    expect(provider.status).toBe('info')
    expect(provider.fix).toBeUndefined()
    expect(exitCode(report)).toBe(0)
  })
})

describe('classifyFailure', () => {
  it('reads the error code the CLI prints', () => {
    expect(
      classifyFailure({ stderr: '\nAn error occurred (AccessDeniedException) when calling the X operation: no' }).code,
    ).toBe('AccessDeniedException')
  })

  it('recognizes a missing binary, missing credentials and an old CLI', () => {
    expect(classifyFailure({ spawnCode: 'ENOENT', stderr: '' }).code).toBe('CliMissing')
    expect(classifyFailure({ stderr: 'Unable to locate credentials. You can configure credentials by running "aws configure".' }).code).toBe('NoCredentials')
    expect(classifyFailure({ stderr: 'aws: [ERROR]: argument operation: Invalid choice, valid choices are:' }).code).toBe('CliTooOld')
  })

  it('falls back to Unknown with whatever was said', () => {
    expect(classifyFailure({ stderr: 'boom' })).toEqual({ code: 'Unknown', message: 'boom' })
    expect(classifyFailure({ stderr: '' }).code).toBe('Unknown')
  })
})

describe('isCliTooOld', () => {
  it('compares against 2.27.42, the release that added the agreement commands', () => {
    expect(isCliTooOld('aws-cli/2.27.41 Python/3.13')).toBe(true)
    expect(isCliTooOld('aws-cli/2.27.42 Python/3.13')).toBe(false)
    expect(isCliTooOld('aws-cli/2.28.0 Python/3.13')).toBe(false)
    expect(isCliTooOld('aws-cli/2.9.99 Python/3.9')).toBe(true)
    expect(isCliTooOld('aws-cli/1.40.0 Python/3.9')).toBe(true)
    expect(isCliTooOld('aws-cli/3.0.0 Python/3.9')).toBe(false)
  })

  it('does not call an unreadable version old', () => {
    expect(isCliTooOld('who knows')).toBe(false)
  })
})

describe('formatReport', () => {
  it('shows what failed, what to run, and how many checks need attention', async () => {
    const { report } = await run({ [TOOLKIT]: failure('ValidationError', 'Stack with id CDKToolkit does not exist') })
    const text = formatReport(report)

    expect(text).toContain(`Preflight — ${ACCOUNT} · us-east-1 (DEPLOY_PROFILE=demo)`)
    expect(text).toContain('[FAIL]  CDK bootstrap')
    expect(text).toContain('Fix:')
    expect(text).toContain(`bootstrap aws://${ACCOUNT}/us-east-1`)
    expect(text).toContain('1 check needs attention before `npm run deploy`.')
  })

  it('says plainly when nothing was found — and that an unverified check is not the same as fine', async () => {
    const clean = formatReport((await run({})).report)
    expect(clean).toContain('Nothing found that would stop a first deploy.')

    const unverified = formatReport((await run({ [TOOLKIT]: failure('AccessDenied') })).report)
    expect(unverified).toContain('1 could not be verified with this identity')
  })
})
