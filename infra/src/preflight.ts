/**
 * A read-only look at the account-level state a first deploy needs and cannot create for itself.
 *
 * Three things the stacks depend on live outside them, and on a new account each fails late and
 * misleadingly: the CDK toolkit stack (fails at the first asset), CloudWatch Transaction Search
 * (fails minutes in, on the agent stack's `TRACES` delivery, after the image has already been
 * built) and the Bedrock model agreement (deploys green, fails on the first chat message). This
 * reports all of them before `cdk deploy`, with the command that fixes each.
 *
 * It never writes. Two of the fixes change account-wide state that other workloads share, which is
 * the reason the stacks do not make them either (see `TRANSACTION_SEARCH_ENABLED` in `.env.example`)
 * — so they are printed for a person to run, not run.
 *
 * Pure apart from the injected `AwsCli`: `preflight-cli.ts` supplies the one that shells out and the
 * tests supply a table. The AWS CLI rather than the SDK because every fix is a CLI command anyway,
 * and because it adds no dependency to a package that has only CDK.
 */
import {
  assertDeploymentTarget,
  DEFAULT_REGION,
  parseBedrockModelId,
  resolveAgentObservabilityEnabled,
  resolveBedrockModelId,
  resolveDeployProfile,
  resolveExpectedAccount,
  resolveExpectedRegion,
} from './config.js'

export type Status = 'ok' | 'fail' | 'pending' | 'warn' | 'skip' | 'info'

export interface CheckResult {
  title: string
  status: Status
  detail: string[]
  /** Commands or instructions, in the order to run them. */
  fix?: string[]
}

/**
 * `code` is the AWS error code when the CLI printed one (`AccessDeniedException`,
 * `ResourceNotFoundException`, …), or one of this module's own: `CliMissing`, `NoCredentials`,
 * `CliTooOld`, `Unknown`.
 */
export type AwsResult = { ok: true; output: string } | { ok: false; code: string; message: string }

export type AwsCli = (args: string[]) => Promise<AwsResult>

export interface PreflightOptions {
  env: Record<string, string | undefined>
  /**
   * Also check what turning on deploy-on-merge needs. The workflow deploys under `prod`, whose
   * posture turns agent observability on, so this implies the Transaction Search check even when the
   * local `.env` is a sandbox with it off.
   */
  githubOidc: boolean
}

export interface PreflightReport {
  account?: string
  region: string
  profile?: string
  results: CheckResult[]
}

/** `get-foundation-model-availability` and the agreement commands arrived in this CLI release. */
export const MIN_CLI_VERSION = [2, 27, 42] as const

/**
 * Providers AWS documents as not sold through Marketplace, so there is no agreement to create. Taken
 * from the "Models from the following providers aren't sold through AWS Marketplace" note in
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html — extend it from there,
 * not from a guess: a wrong entry here reports a real missing agreement as fine.
 */
const NO_AGREEMENT_PROVIDERS = new Set(['amazon', 'deepseek', 'mistral', 'meta', 'qwen'])

const HEALTHY_STACK_STATUS = /^(?:CREATE|UPDATE|IMPORT)_COMPLETE$|^UPDATE_ROLLBACK_COMPLETE$/

const CREDENTIAL_CODES = new Set([
  'NoCredentials',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AuthFailure',
])

/** Reads what a failed `aws` invocation said, without letting the caller depend on its wording. */
export function classifyFailure(failure: { spawnCode?: string; stderr: string }): {
  code: string
  message: string
} {
  const stderr = failure.stderr.trim()

  if (failure.spawnCode === 'ENOENT') {
    return { code: 'CliMissing', message: 'The `aws` command was not found on PATH.' }
  }

  const coded = /An error occurred \((\w+)\)/.exec(stderr)
  if (coded?.[1]) return { code: coded[1], message: stderr }

  if (/Unable to locate credentials/i.test(stderr)) return { code: 'NoCredentials', message: stderr }
  if (/Invalid choice/i.test(stderr)) return { code: 'CliTooOld', message: stderr }

  return { code: 'Unknown', message: stderr || 'The aws command failed without saying why.' }
}

/** Whether `aws --version` output names a release older than `MIN_CLI_VERSION`. Unparseable is not old. */
export function isCliTooOld(versionOutput: string): boolean {
  const match = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(versionOutput)
  if (!match) return false

  const found = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let index = 0; index < MIN_CLI_VERSION.length; index += 1) {
    const need = MIN_CLI_VERSION[index] as number
    const have = found[index] as number
    if (have !== need) return have < need
  }
  return false
}

/**
 * The resource policy that lets X-Ray write spans into the two log groups Transaction Search uses.
 * Verbatim from AWS's "Enable Transaction Search" page, with the account and Region filled in — the
 * console applies this for you, and the API path does not, which is exactly the step that gets
 * skipped and surfaces as an `AccessDeniedException` naming the caller's own permissions.
 */
export function transactionSearchPolicy(target: {
  partition: string
  region: string
  account: string
}): object {
  const { partition, region, account } = target
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'TransactionSearchXRayAccess',
        Effect: 'Allow',
        Principal: { Service: 'xray.amazonaws.com' },
        Action: 'logs:PutLogEvents',
        Resource: [
          `arn:${partition}:logs:${region}:${account}:log-group:aws/spans:*`,
          `arn:${partition}:logs:${region}:${account}:log-group:/aws/application-signals/data:*`,
        ],
        Condition: {
          ArnLike: { 'aws:SourceArn': `arn:${partition}:xray:${region}:${account}:*` },
          StringEquals: { 'aws:SourceAccount': account },
        },
      },
    ],
  }
}

interface Context {
  account: string
  region: string
  partition: string
  /** ` --profile <name>` when one is exported, so a printed fix runs against the account it was found in. */
  profileArg: string
  /** The injected CLI with `--region` and `--output json` appended. */
  call: AwsCli
  /** The injected CLI as given — for `--version`, which takes neither. */
  raw: AwsCli
}

/** A printable, copy-pasteable `aws` command for the Region under test. */
function awsCommand(ctx: Context, subcommand: string): string {
  return `aws ${subcommand} --region ${ctx.region}${ctx.profileArg}`
}

function shellQuote(value: string): string {
  return /^[\w.@:/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function parseJson<T>(output: string): T | undefined {
  try {
    return JSON.parse(output) as T
  } catch {
    return undefined
  }
}

/** A check that could not run: reported, but never a failure — a denied read is not a missing setup. */
function unverified(title: string, result: { code: string; message: string }, needs: string): CheckResult {
  const first = result.message.split('\n')[0] ?? result.message
  return {
    title,
    status: 'warn',
    detail: [
      `Could not verify (${result.code}). This identity may lack ${needs}.`,
      first,
    ],
  }
}

/** Why `sts:GetCallerIdentity` failed, in the terms of whoever has to fix it. */
function credentialsFailure(
  env: PreflightOptions['env'],
  failure: { code: string; message: string },
): CheckResult {
  const title = 'AWS credentials'

  if (failure.code === 'CliMissing') {
    return {
      title,
      status: 'fail',
      detail: [failure.message],
      fix: ['Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'],
    }
  }

  if (!CREDENTIAL_CODES.has(failure.code)) {
    return {
      title,
      status: 'fail',
      detail: [`Could not call sts:GetCallerIdentity (${failure.code}).`, failure.message.split('\n')[0] ?? failure.message],
    }
  }

  const profile = env.AWS_PROFILE ? shellQuote(env.AWS_PROFILE) : undefined
  return {
    title,
    status: 'fail',
    detail: ['No working AWS credentials.'],
    fix: [
      profile
        ? `AWS_PROFILE=${profile} did not yield credentials — for SSO, run: aws sso login --profile ${profile}`
        : 'Export AWS_PROFILE (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY); for SSO run: aws sso login --profile <name>',
      'Use the same identity you will run `npm run deploy` with.',
    ],
  }
}

/** Runs every check that applies to this configuration, in a stable order. */
export async function runPreflight(options: PreflightOptions, aws: AwsCli): Promise<PreflightReport> {
  const { env, githubOidc } = options

  let inputs: ReturnType<typeof resolveInputs>
  try {
    inputs = resolveInputs(env)
  } catch (error) {
    return {
      region: DEFAULT_REGION,
      results: [
        {
          title: 'Configuration',
          status: 'fail',
          detail: [(error as Error).message],
          fix: ['Correct infra/.env — the same value fails `cdk synth`.'],
        },
      ],
    }
  }

  const { profile, expectedAccount, expectedRegion, envRegion, modelId, observabilityEnabled } = inputs
  const region = expectedRegion ?? envRegion

  const call: AwsCli = (args) => aws([...args, '--region', region, '--output', 'json'])
  const identity = await call(['sts', 'get-caller-identity'])

  if (!identity.ok) {
    return { region, profile, results: [credentialsFailure(env, identity)] }
  }

  const who = parseJson<{ Account?: string; Arn?: string }>(identity.output)
  if (!who?.Account || !who.Arn) {
    return {
      region,
      profile,
      results: [
        {
          title: 'AWS credentials',
          status: 'fail',
          detail: ['sts:GetCallerIdentity answered with something this could not read.'],
        },
      ],
    }
  }

  const ctx: Context = {
    account: who.Account,
    region,
    partition: who.Arn.split(':')[1] ?? 'aws',
    profileArg: env.AWS_PROFILE ? ` --profile ${shellQuote(env.AWS_PROFILE)}` : '',
    call,
    raw: aws,
  }

  const results: CheckResult[] = [
    { title: 'AWS credentials', status: 'ok', detail: [who.Arn] },
  ]

  // The same gate `cdk synth` applies, run here so a wrong account or Region is found before an
  // image is built for it rather than after.
  try {
    assertDeploymentTarget({
      profile,
      account: ctx.account,
      region: envRegion,
      expectedAccount,
      expectedRegion,
    })
  } catch (error) {
    results.push({
      title: 'Deployment target',
      status: 'fail',
      detail: (error as Error).message.split('\n'),
      fix: ['Point AWS_PROFILE at the intended account, or correct DEPLOY_ACCOUNT / DEPLOY_REGION in infra/.env.'],
    })
  }

  const needsTransactionSearch = observabilityEnabled || githubOidc

  const rest = await Promise.all([
    checkCdkToolkit(ctx),
    checkTransactionSearch(ctx, needsTransactionSearch, observabilityEnabled),
    checkBedrockAccess(ctx, modelId),
    ...(githubOidc ? [checkGithubOidcProvider(ctx)] : []),
  ])

  return { account: ctx.account, region, profile, results: [...results, ...rest] }
}

/** Everything read from the environment, resolved with the same functions `app.ts` uses. */
function resolveInputs(env: PreflightOptions['env']) {
  const expectedRegion = resolveExpectedRegion(env.DEPLOY_REGION)

  return {
    profile: resolveDeployProfile(env.DEPLOY_PROFILE),
    expectedAccount: resolveExpectedAccount(env.DEPLOY_ACCOUNT),
    expectedRegion,
    // What `app.ts` would resolve, minus CDK_DEFAULT_REGION, which the CDK CLI derives from these.
    envRegion: env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || DEFAULT_REGION,
    modelId: resolveBedrockModelId(env.BEDROCK_MODEL_ID),
    observabilityEnabled: resolveAgentObservabilityEnabled(env.AGENT_OBSERVABILITY_ENABLED),
  }
}

// ── CDK toolkit ─────────────────────────────────────────────────────────

async function checkCdkToolkit(ctx: Context): Promise<CheckResult> {
  const title = 'CDK bootstrap'
  const result = await ctx.call(['cloudformation', 'describe-stacks', '--stack-name', 'CDKToolkit'])

  if (!result.ok) {
    if (result.code === 'ValidationError' && /does not exist/i.test(result.message)) {
      return {
        title,
        status: 'fail',
        detail: [`No CDKToolkit stack in ${ctx.account}/${ctx.region}. The first asset upload fails without it.`],
        fix: [`npm --prefix infra run cdk -- bootstrap aws://${ctx.account}/${ctx.region}`],
      }
    }
    return unverified(title, result, 'cloudformation:DescribeStacks')
  }

  const status = parseJson<{ Stacks?: { StackStatus?: string }[] }>(result.output)?.Stacks?.[0]?.StackStatus
  if (status && HEALTHY_STACK_STATUS.test(status)) {
    return { title, status: 'ok', detail: [`CDKToolkit is ${status} in ${ctx.account}/${ctx.region}.`] }
  }

  return {
    title,
    status: 'fail',
    detail: [`The CDKToolkit stack is ${status ?? 'in an unreadable state'}, which cannot take an asset.`],
    fix: [
      `Look at it: ${awsCommand(ctx, 'cloudformation describe-stack-events --stack-name CDKToolkit --max-items 10')}`,
      `then re-run: npm --prefix infra run cdk -- bootstrap aws://${ctx.account}/${ctx.region}`,
    ],
  }
}

// ── Transaction Search ──────────────────────────────────────────────────

async function checkTransactionSearch(
  ctx: Context,
  needed: boolean,
  observabilityEnabled: boolean,
): Promise<CheckResult> {
  const title = 'CloudWatch Transaction Search'

  if (!needed) {
    return {
      title,
      status: 'skip',
      detail: [
        'Only the agent stack\'s TRACES delivery needs it, and AGENT_OBSERVABILITY_ENABLED is off.',
        'Run this again before turning that on, and under DEPLOY_PROFILE=pilot|prod, which requires it.',
      ],
    }
  }

  const why = observabilityEnabled
    ? []
    : ['Checked because deploy-on-merge runs under `prod`, which turns AGENT_OBSERVABILITY_ENABLED on.']

  const destination = await ctx.call(['xray', 'get-trace-segment-destination'])
  if (!destination.ok) return unverified(title, destination, 'xray:GetTraceSegmentDestination')

  const state = parseJson<{ Destination?: string; Status?: string }>(destination.output)

  if (state?.Destination === 'CloudWatchLogs' && state.Status === 'ACTIVE') {
    return { title, status: 'ok', detail: [`Trace segment destination is CloudWatchLogs and ACTIVE in ${ctx.region}.`, ...why] }
  }

  if (state?.Destination === 'CloudWatchLogs' && state.Status === 'PENDING') {
    return {
      title,
      status: 'pending',
      detail: [
        'Enabled, still propagating (up to ~10 minutes). A deploy now fails exactly as if it were off.',
        ...why,
      ],
      fix: [`Wait, then re-run this: ${awsCommand(ctx, 'xray get-trace-segment-destination')}`],
    }
  }

  // Only now is the resource policy worth a second call: it decides whether step 1 is in the fix.
  const policies = await ctx.call(['logs', 'describe-resource-policies'])
  const hasPolicy =
    policies.ok &&
    (parseJson<{ resourcePolicies?: { policyDocument?: string }[] }>(policies.output)?.resourcePolicies ?? []).some(
      (policy) =>
        Boolean(policy.policyDocument?.includes('xray.amazonaws.com')) &&
        Boolean(policy.policyDocument?.includes('aws/spans')),
    )

  const policy = JSON.stringify(transactionSearchPolicy(ctx))
  const fix = [
    ...(hasPolicy
      ? []
      : [
          '# 1. Let X-Ray write spans. Skipping this makes step 2 fail with an AccessDeniedException that',
          '#    blames X-Ray\'s permissions on the log group — not yours, even as an administrator.',
          `${awsCommand(ctx, `logs put-resource-policy --policy-name TransactionSearchXRayAccess --policy-document '${policy}'`)}`,
        ]),
    `# ${hasPolicy ? '1' : '2'}. Point the trace segment destination at CloudWatch Logs.`,
    awsCommand(ctx, 'xray update-trace-segment-destination --destination CloudWatchLogs'),
    `# ${hasPolicy ? '2' : '3'}. Wait for ACTIVE (up to ~10 minutes) before deploying.`,
    awsCommand(ctx, 'xray get-trace-segment-destination'),
  ]

  return {
    title,
    status: 'fail',
    detail: [
      `The trace segment destination is ${state?.Destination ?? 'unreadable'} in ${ctx.region}, not CloudWatchLogs.`,
      hasPolicy
        ? 'The X-Ray resource policy is already in place.'
        : 'No CloudWatch Logs resource policy for xray.amazonaws.com yet — the console creates it, the API does not.',
      'The agent stack fails on its TRACES delivery without this, after the image build.',
      ...why,
    ],
    fix,
  }
}

// ── Bedrock model access ────────────────────────────────────────────────

async function checkBedrockAccess(ctx: Context, modelId: string): Promise<CheckResult> {
  const title = 'Bedrock model access'
  const { foundationModelId } = parseBedrockModelId(modelId)
  const provider = foundationModelId.split('.')[0] ?? ''
  const named = `${foundationModelId}${foundationModelId === modelId ? '' : ` (via ${modelId})`}`

  if (NO_AGREEMENT_PROVIDERS.has(provider)) {
    return {
      title,
      status: 'skip',
      detail: [`${provider} models are not sold through Marketplace, so there is no agreement to create.`],
    }
  }

  const version = await ctx.raw(['--version'])
  if (version.ok && isCliTooOld(version.output)) {
    return tooOldCli(title, version.output)
  }

  const availability = await ctx.call(['bedrock', 'get-foundation-model-availability', '--model-id', foundationModelId])
  if (!availability.ok) {
    if (availability.code === 'CliTooOld') return tooOldCli(title, availability.message)
    return unverified(title, availability, 'bedrock:GetFoundationModelAvailability (AmazonBedrockFullAccess covers it)')
  }

  const state = parseJson<{
    agreementAvailability?: { status?: string }
    authorizationStatus?: string
    entitlementAvailability?: string
    regionAvailability?: string
  }>(availability.output)
  const agreement = state?.agreementAvailability?.status
  const summary = `agreement ${agreement ?? '?'} · authorization ${state?.authorizationStatus ?? '?'} · entitlement ${state?.entitlementAvailability ?? '?'} · region ${state?.regionAvailability ?? '?'}`

  if (state?.authorizationStatus && state.authorizationStatus !== 'AUTHORIZED') {
    return {
      title,
      status: 'fail',
      detail: [`Not authorized to use ${named} (${summary}).`, 'That is IAM or an SCP on the account, not a missing agreement.'],
      fix: ['Check the identity\'s policies and any Organization SCP that denies bedrock:* or aws-marketplace:*.'],
    }
  }

  if (agreement !== 'AVAILABLE') {
    return {
      title,
      status: 'fail',
      detail: [
        `No agreement for ${named} in this account (${summary}).`,
        'The deploy will be green and the first chat message will answer "Model access is denied".',
      ],
      fix: await agreementFix(ctx, foundationModelId, provider === 'anthropic'),
    }
  }

  return {
    title,
    status: state?.regionAvailability && state.regionAvailability !== 'AVAILABLE' ? 'warn' : 'ok',
    detail: [
      `${named}: ${summary}.`,
      ...(state?.regionAvailability && state.regionAvailability !== 'AVAILABLE'
        ? [`${foundationModelId} itself is not offered in ${ctx.region}; an inference profile may still route to a Region that does — confirm with a converse call.`]
        : []),
    ],
  }
}

function tooOldCli(title: string, found: string): CheckResult {
  return {
    title,
    status: 'fail',
    detail: [
      `The AWS CLI is older than ${MIN_CLI_VERSION.join('.')}, which introduced the model-agreement commands.`,
      found.split('\n')[0] ?? found,
    ],
    fix: ['Upgrade to AWS CLI v2 (>= 2.27.42): https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'],
  }
}

/** The steps that create the agreement, with the use-case form first when Anthropic still wants it. */
async function agreementFix(ctx: Context, foundationModelId: string, isAnthropic: boolean): Promise<string[]> {
  let formSubmitted: boolean | undefined
  if (isAnthropic) {
    const form = await ctx.call(['bedrock', 'get-use-case-for-model-access'])
    formSubmitted = form.ok ? true : form.code === 'ResourceNotFoundException' ? false : undefined
  }

  const steps: string[] = []
  if (isAnthropic && formSubmitted !== true) {
    steps.push(
      formSubmitted === false
        ? '# 1. Anthropic\'s first-time-use form is not on file for this account. Submit it once (fields: infra/README.md#model-access-is-denied-on-the-first-message).'
        : '# 1. If step 3 answers "You have not filled out the request form", submit Anthropic\'s first-time-use form once (fields: infra/README.md#model-access-is-denied-on-the-first-message).',
      awsCommand(ctx, 'bedrock put-use-case-for-model-access --form-data fileb://anthropic-ftu.json'),
    )
  }

  const n = (offset: number) => steps.length === 0 ? offset : offset + 1
  steps.push(
    `# ${n(1)}. Fetch the offer token.`,
    `OFFER=$(${awsCommand(ctx, `bedrock list-foundation-model-agreement-offers --model-id ${foundationModelId} --query 'offers[0].offerToken' --output text`)})`,
    `# ${n(2)}. Create the agreement (a new account also needs a valid payment method for Marketplace).`,
    awsCommand(ctx, `bedrock create-foundation-model-agreement --model-id ${foundationModelId} --offer-token "$OFFER"`),
    `# ${n(3)}. agreementAvailability.status must read AVAILABLE; allow ~2 minutes.`,
    awsCommand(ctx, `bedrock get-foundation-model-availability --model-id ${foundationModelId}`),
  )
  return steps
}

// ── GitHub OIDC ─────────────────────────────────────────────────────────

const GITHUB_OIDC_DOMAIN = 'token.actions.githubusercontent.com'

async function checkGithubOidcProvider(ctx: Context): Promise<CheckResult> {
  const title = 'GitHub OIDC provider'
  const result = await ctx.call(['iam', 'list-open-id-connect-providers'])
  if (!result.ok) return unverified(title, result, 'iam:ListOpenIDConnectProviders')

  const found = (parseJson<{ OpenIDConnectProviderList?: { Arn?: string }[] }>(result.output)?.OpenIDConnectProviderList ?? [])
    .some((provider) => provider.Arn?.endsWith(`oidc-provider/${GITHUB_OIDC_DOMAIN}`))

  return found
    ? {
        title,
        status: 'info',
        detail: [
          `This account already trusts ${GITHUB_OIDC_DOMAIN} — another project registered it, and an account holds only one.`,
        ],
        fix: ['Deploy infra/bootstrap with `-c reuseExistingProvider=true`, or it fails with "provider already exists".'],
      }
    : {
        title,
        status: 'info',
        detail: [`No ${GITHUB_OIDC_DOMAIN} provider yet. infra/bootstrap creates it; no extra flag is needed.`],
      }
}

// ── Output ──────────────────────────────────────────────────────────────

const LABEL: Record<Status, string> = {
  ok: '[ ok ]',
  fail: '[FAIL]',
  pending: '[WAIT]',
  warn: '[warn]',
  skip: '[skip]',
  info: '[info]',
}

export function formatReport(report: PreflightReport): string {
  const target = [report.account, report.region].filter(Boolean).join(' · ')
  const lines = [`Preflight — ${target}${report.profile ? ` (DEPLOY_PROFILE=${report.profile})` : ''}`, '']

  for (const result of report.results) {
    lines.push(`${LABEL[result.status]}  ${result.title}`)
    for (const line of result.detail) lines.push(`        ${line}`)
    if (result.fix) {
      lines.push(result.status === 'info' ? '        Next:' : '        Fix:')
      for (const line of result.fix) lines.push(`          ${line}`)
    }
    lines.push('')
  }

  const failing = report.results.filter((r) => r.status === 'fail' || r.status === 'pending').length
  const unverifiedCount = report.results.filter((r) => r.status === 'warn').length
  lines.push(
    failing > 0
      ? `${failing} check${failing === 1 ? '' : 's'} need${failing === 1 ? 's' : ''} attention before \`npm run deploy\`.`
      : 'Nothing found that would stop a first deploy.',
  )
  if (unverifiedCount > 0) {
    lines.push(`${unverifiedCount} could not be verified with this identity — that is not the same as fine.`)
  }
  return lines.join('\n')
}

/** Non-zero when something would stop the deploy. A check that could not run does not count. */
export function exitCode(report: PreflightReport): number {
  return report.results.some((r) => r.status === 'fail' || r.status === 'pending') ? 1 : 0
}
