/**
 * Env/context → config resolvers. Split out of `app.ts`, which instantiates stacks the moment it
 * runs, so these stay unit-testable without synthesizing anything.
 *
 * Each variable's meaning is documented once, in `.env.example`; the notes here cover only what a
 * resolver decides that the variable's description does not — mostly why a bad value throws.
 */
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets'

export const DEFAULT_PROJECT_NAME = 'demo-strands-agents-ts'
export const DEFAULT_REGION = 'us-east-1'

/**
 * Picks the subset of `env` (default `process.env`) whose keys are in `keys` and whose value is a
 * non-blank string — the shape `CfnRuntime.environmentVariables` and Lambda `environment` both want,
 * since neither tolerates `undefined` values.
 */
export function pickDefinedEnvironment(
  keys: string[],
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    keys
      .map((key) => [key, env[key]])
      .filter(([, value]) => value && value.trim().length > 0),
  ) as Record<string, string>
}

// ── Deployment profile ──────────────────────────────────────────────────

/**
 * What this deployment is for. It is the one knob that changes what the others are *allowed* to be.
 *
 * The template ships defaults chosen for a disposable sandbox — public sign-up, a one-time code
 * echoed back in the response, CORS open to every origin. Each is documented as sandbox-only, and
 * documentation is exactly the control that fails: the person who copies this repo to run a pilot
 * is not the person who read the comment. The profile turns those notes into a build that refuses
 * to synthesize.
 */
export const DEPLOY_PROFILES = ['demo', 'pilot', 'prod'] as const
export type DeployProfile = (typeof DEPLOY_PROFILES)[number]

/**
 * Defaults to `demo`, which is what an unconfigured clone should be. The safety is not in the
 * default — it is that `pilot` and `prod` refuse the demo defaults rather than inheriting them.
 */
export function resolveDeployProfile(input?: string): DeployProfile {
  const normalized = input?.trim().toLowerCase()
  if (!normalized) return 'demo'

  if (!(DEPLOY_PROFILES as readonly string[]).includes(normalized)) {
    throw new Error(
      `Unsupported DEPLOY_PROFILE: ${input}. Expected one of ${DEPLOY_PROFILES.join(', ')}.`,
    )
  }
  return normalized as DeployProfile
}

/** Whether a profile carries real users and real data, and therefore refuses the sandbox defaults. */
export function isRegulated(profile: DeployProfile): boolean {
  return profile !== 'demo'
}

/** Second-factor posture on the user pool. */
export const MFA_MODES = ['off', 'optional', 'required'] as const
export type MfaMode = (typeof MFA_MODES)[number]

/**
 * Defaults to `off` — a sandbox where every reviewer would otherwise have to enroll an authenticator
 * before seeing the demo. `pilot` and `prod` require `required`: an account takeover on this system
 * approves payments and reads someone's purchase history, and a password is not a second factor.
 */
export function resolveMfaMode(input?: string): MfaMode {
  const normalized = input?.trim().toLowerCase()
  if (!normalized) return 'off'

  if (!(MFA_MODES as readonly string[]).includes(normalized)) {
    throw new Error(`Unsupported COGNITO_MFA: ${input}. Expected one of ${MFA_MODES.join(', ')}.`)
  }
  return normalized as MfaMode
}

/** Cognito threat protection: compromised-credential and risk detection on the pool. */
export const THREAT_PROTECTION_MODES = ['off', 'audit', 'enforced'] as const
export type ThreatProtectionMode = (typeof THREAT_PROTECTION_MODES)[number]

/**
 * Defaults to `off`, because anything else moves the pool onto the **Plus** feature plan, which is
 * billed per monthly active user. That is a cost decision an operator has to make deliberately, so
 * the profile check refuses `off` outside a demo rather than quietly enabling the spend.
 */
export function resolveThreatProtection(input?: string): ThreatProtectionMode {
  const normalized = input?.trim().toLowerCase()
  if (!normalized) return 'off'

  if (!(THREAT_PROTECTION_MODES as readonly string[]).includes(normalized)) {
    throw new Error(
      `Unsupported COGNITO_THREAT_PROTECTION: ${input}. Expected one of ${THREAT_PROTECTION_MODES.join(', ')}.`,
    )
  }
  return normalized as ThreatProtectionMode
}

/**
 * Whether a WAF web ACL fronts the API. **Off unless asked for**, in every profile.
 *
 * Opt-in rather than profile-driven because a web ACL is billed — per ACL, per rule and per million
 * requests — and because the right rules depend on the traffic a deployment actually sees. The
 * profile gate deliberately does not require it: a gate that forces recurring spend is one people
 * work around, and the controls it complements (stage throttle, per-caller quotas) are already on.
 *
 * It is still the right thing to turn on for an internet-facing pilot — it is the only layer here
 * that filters traffic *before* authentication — which is a recommendation, not a build failure.
 */
export function resolveWafEnabled(input?: string): boolean {
  return parseBoolean(input, false, 'WAF_ENABLED')
}

/**
 * The account and region this deployment is pinned to, when it is pinned to one.
 *
 * `cdk deploy` targets whatever credentials happen to be in the shell. That is fine for a sandbox
 * and is how the template is meant to be tried — but it means the difference between deploying to
 * a scratch account and deploying to the one holding real user data is which `AWS_PROFILE` was
 * exported last, with nothing in between to notice.
 *
 * Unset, nothing is checked. Set, a mismatch fails the synth before a single resource is described.
 */
export function resolveExpectedAccount(input?: string): string | undefined {
  const trimmed = input?.trim()
  if (!trimmed) return undefined

  if (!/^\d{12}$/.test(trimmed)) {
    throw new Error(`DEPLOY_ACCOUNT must be a 12-digit AWS account id: ${input}`)
  }
  return trimmed
}

export function resolveExpectedRegion(input?: string): string | undefined {
  return input?.trim() || undefined
}

/**
 * Refuses to synthesize against an account or region this deployment was not meant for.
 *
 * Two rules, and the second is the one that matters. A pin that does not match is always an error.
 * A `pilot` or `prod` with **no pin at all** is also an error: the whole point of naming the target
 * is that a deployment holding real data should not be reachable by accident, and an unset variable
 * is exactly the accident it guards against.
 */
export function assertDeploymentTarget(target: {
  profile: DeployProfile
  account?: string
  region?: string
  expectedAccount?: string
  expectedRegion?: string
}): void {
  const { profile, account, region, expectedAccount, expectedRegion } = target

  if (isRegulated(profile) && (!expectedAccount || !expectedRegion)) {
    throw new Error(
      [
        `DEPLOY_PROFILE=${profile} requires DEPLOY_ACCOUNT and DEPLOY_REGION to be set.`,
        'They pin this stack to the account and region it belongs in, so a stray AWS_PROFILE',
        'cannot point a deployment holding real data at the wrong place — or the reverse.',
      ].join('\n'),
    )
  }

  if (expectedAccount && account && account !== expectedAccount) {
    throw new Error(
      `Refusing to synthesize: DEPLOY_ACCOUNT is ${expectedAccount} but the credentials resolve to ${account}.`,
    )
  }

  if (expectedRegion && region && region !== expectedRegion) {
    throw new Error(
      `Refusing to synthesize: DEPLOY_REGION is ${expectedRegion} but the target region is ${region}.`,
    )
  }
}

/** Everything the profile gate judges, resolved from the environment by `app.ts`. */
export interface DeploymentPosture {
  profile: DeployProfile
  publicSignUpEnabled: boolean
  otpRevealInUi: boolean
  allowedOrigin: string
  alertEmail?: string
  mfa: MfaMode
  threatProtection: ThreatProtectionMode
  retainData: boolean
  autoProvisionSandboxMethod: boolean
}

/** One violated rule: what is wrong, and the variable that fixes it. */
interface PostureViolation {
  variable: string
  problem: string
}

/**
 * Refuses to synthesize a `pilot` or `prod` stack that still carries a sandbox default.
 *
 * Every violation is collected before throwing, rather than failing on the first. An operator
 * turning a demo into a pilot has a handful of these to fix, and discovering them one failed synth
 * at a time is how people stop reading the message and start guessing.
 *
 * `demo` is deliberately unchecked. Making the sandbox nag about production posture would train
 * exactly the habit this exists to prevent — that these errors are noise to work around.
 */
export function assertDeploymentPosture(p: DeploymentPosture): void {
  if (!isRegulated(p.profile)) return

  const violations: PostureViolation[] = []
  const fail = (variable: string, problem: string) => violations.push({ variable, problem })

  if (p.publicSignUpEnabled) {
    fail(
      'PUBLIC_SIGNUP_ENABLED',
      'must be false. Open sign-up lets anyone mint accounts, which defeats the per-user quotas and puts strangers on a deployment holding real data.',
    )
  }
  if (p.otpRevealInUi) {
    fail(
      'OTP_REVEAL_IN_UI',
      'must be false. Returning the code on the channel that requested it proves possession of nothing — the step-up becomes decoration, and the mandate says a step-up happened.',
    )
  }
  if (p.allowedOrigin === '*') {
    fail(
      'ALLOWED_ORIGIN',
      'must name the app origin. "*" is the first-deploy default from before the frontend URL exists; it should not outlive it.',
    )
  }
  if (!p.alertEmail) {
    fail(
      'ALERT_EMAIL',
      'is required. The alarms exist either way — without a subscriber they fire into an empty room.',
    )
  }
  if (p.mfa !== 'required') {
    fail(
      'COGNITO_MFA',
      'must be "required". An account on this system can approve payments and read a purchase history.',
    )
  }
  if (p.threatProtection === 'off') {
    fail(
      'COGNITO_THREAT_PROTECTION',
      'must be "audit" or "enforced". Note that either moves the pool to the Cognito Plus feature plan, which is billed per monthly active user.',
    )
  }
  if (!p.retainData) {
    fail('RETAIN_DATA', 'must be true. A stack replacement would otherwise take every account with it.')
  }
  if (p.profile === 'prod' && p.autoProvisionSandboxMethod) {
    fail(
      'AUTO_PROVISION_SANDBOX_METHOD',
      'must be false in prod. It mints a fake instrument for any account that has none.',
    )
  }

  if (violations.length === 0) return

  throw new Error(
    [
      `DEPLOY_PROFILE=${p.profile} refuses ${violations.length} sandbox default${violations.length === 1 ? '' : 's'}:`,
      ...violations.map((v) => `  - ${v.variable} ${v.problem}`),
      '',
      'These are the defaults that make the template easy to try. Fix them in infra/.env, or set',
      'DEPLOY_PROFILE=demo if this deployment really is a sandbox with synthetic data only.',
    ].join('\n'),
  )
}

/**
 * Parses a boolean-ish environment variable, throwing on anything unrecognized. Every caller governs
 * something a silent default gets quietly wrong: who can sign up, whether accounts survive a
 * teardown, whether a payment needs a step-up.
 */
function parseBoolean(input: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = input?.trim().toLowerCase()

  if (!normalized) return fallback
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true

  throw new Error(`Unsupported ${name}: ${input}`)
}

/** Whether visitors can create their own account. Defaults to `true`; `false` is invite-only. */
export function resolvePublicSignUpEnabled(input?: string): boolean {
  return parseBoolean(input, true, 'PUBLIC_SIGNUP_ENABLED')
}

/**
 * Whether the user pool and frontend bucket survive a stack deletion. Defaults to **retain**: the
 * outcomes are asymmetric — an orphaned pool is a manual cleanup, a destroyed one is every account,
 * irreversibly.
 */
export function resolveRetainData(input?: string): boolean {
  return parseBoolean(input, true, 'RETAIN_DATA')
}

/** Address that receives alarm and budget notifications. Alarms still fire without it. */
export function resolveAlertEmail(input?: string): string | undefined {
  const trimmed = input?.trim()
  if (!trimmed) return undefined

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error(`ALERT_EMAIL is not a valid address: ${input}`)
  }

  return trimmed
}

/**
 * Monthly USD ceiling that triggers a budget notification; undefined disables the budget. A budget
 * alerts, it cannot stop spend — it exists so a runaway loop is noticed in hours, not on the invoice.
 */
export function resolveMonthlyBudgetUsd(input?: string): number | undefined {
  const trimmed = input?.trim()
  if (!trimmed) return undefined

  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MONTHLY_BUDGET_USD must be a positive number: ${input}`)
  }

  return value
}

/** Requests/second allowed on the API stage, and the burst above it. */
export interface ApiThrottle {
  rateLimit: number
  burstLimit: number
}

export const DEFAULT_API_THROTTLE: ApiThrottle = { rateLimit: 10, burstLimit: 20 }

/**
 * Caps how fast the API can be hit. Unset, the stage inherits the 10k rps account default, and every
 * request that gets through costs Bedrock tokens.
 */
export function resolveApiThrottle(rate?: string, burst?: string): ApiThrottle {
  const parse = (input: string | undefined, fallback: number, name: string) => {
    const trimmed = input?.trim()
    if (!trimmed) return fallback

    const value = Number(trimmed)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number: ${input}`)
    }

    return value
  }

  return {
    rateLimit: parse(rate, DEFAULT_API_THROTTLE.rateLimit, 'API_RATE_LIMIT'),
    burstLimit: parse(burst, DEFAULT_API_THROTTLE.burstLimit, 'API_BURST_LIMIT'),
  }
}

/**
 * Browser origin allowed to call the BFF, echoed on the CORS preflight and every response.
 *
 * Defaults to `*` because on a first `cdk deploy --all` the frontend's CloudFront URL does not exist
 * yet (`FrontendStack` depends on `BffStack`, not the reverse), so there is no real origin to lock
 * to. Set it once the app has one and redeploy the BFF stack.
 */
export function resolveAllowedOrigin(input?: string): string {
  const trimmed = input?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '*'
}

/** Requests a single caller gets per window, and the window length in seconds. */
export interface UserRateLimit {
  limit: number
  windowSeconds: number
}

export const DEFAULT_USER_RATE_LIMIT: UserRateLimit = { limit: 20, windowSeconds: 60 }

/**
 * Caps how often *one signed-in caller* can invoke the agent. `API_RATE_LIMIT` above caps the whole
 * account and does not stop one caller consuming all of it. Enforced by the chat Lambda against a
 * DynamoDB table, because API Gateway has no per-JWT-claim throttling primitive.
 */
export function resolveUserRateLimit(limitInput?: string, windowInput?: string): UserRateLimit {
  const parse = (input: string | undefined, fallback: number, name: string) => {
    const trimmed = input?.trim()
    if (!trimmed) return fallback

    const value = Number(trimmed)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number: ${input}`)
    }

    return value
  }

  return {
    limit: parse(limitInput, DEFAULT_USER_RATE_LIMIT.limit, 'USER_RATE_LIMIT'),
    windowSeconds: parse(windowInput, DEFAULT_USER_RATE_LIMIT.windowSeconds, 'USER_RATE_LIMIT_WINDOW_SECONDS'),
  }
}

export const DEFAULT_AP2_RATE_LIMIT: UserRateLimit = { limit: 10, windowSeconds: 60 }

/**
 * Requests one caller gets on `/intent`, `/confirm` and `/decline` per window. Metered under its own
 * key so a conversation cannot spend the checkout budget or the reverse, and tighter because a
 * normal checkout is two or three calls.
 */
export function resolveAp2RateLimit(limitInput?: string, windowInput?: string): UserRateLimit {
  const parse = (input: string | undefined, fallback: number, name: string) => {
    const trimmed = input?.trim()
    if (!trimmed) return fallback

    const value = Number(trimmed)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number: ${input}`)
    }

    return value
  }

  return {
    limit: parse(limitInput, DEFAULT_AP2_RATE_LIMIT.limit, 'AP2_RATE_LIMIT'),
    windowSeconds: parse(
      windowInput,
      DEFAULT_AP2_RATE_LIMIT.windowSeconds,
      'AP2_RATE_LIMIT_WINDOW_SECONDS',
    ),
  }
}

export function resolveAgentImagePlatform(input?: string): ecrassets.Platform | undefined {
  const normalized = input?.trim().toLowerCase()

  if (!normalized || normalized === 'linux/arm64' || normalized === 'arm64') {
    return ecrassets.Platform.LINUX_ARM64
  }

  if (normalized === 'linux/amd64' || normalized === 'amd64') {
    return ecrassets.Platform.LINUX_AMD64
  }

  if (normalized === 'current' || normalized === 'local' || normalized === 'host') {
    return undefined
  }

  return ecrassets.Platform.custom(input as string)
}

/**
 * The Bedrock model the agent invokes.
 *
 * It lives here rather than only in the container because the agent's IAM is scoped to it: the role
 * may invoke this model and no other. `agent/src/agent.ts` carries the same string as its own
 * fallback, and the two must not drift — so the infrastructure always injects `BEDROCK_MODEL_ID`
 * explicitly, which means the container's fallback never engages in a deployed stack.
 */
export const DEFAULT_BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-6'

export function resolveBedrockModelId(input?: string): string {
  const trimmed = input?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BEDROCK_MODEL_ID
}

// ── AP2 ─────────────────────────────────────────────────────────────────

/** The default MPP identity a payment credential may be scoped to. */
export const DEFAULT_TARGET_MPP = 'mpp-sandbox-001'

/**
 * Which MPPs the Credential Provider will scope a credential to. The CP refuses any MPP outside this
 * list, which is what makes "settles via a processor we chose" enforceable. Blank entries are
 * dropped, so a stray comma cannot authorize an empty MPP id.
 */
export function resolveAllowedMpps(input?: string): string[] {
  const parsed = (input ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  return parsed.length > 0 ? parsed : [DEFAULT_TARGET_MPP]
}

/**
 * Whether the CP mints a sandbox payment method for a user who has none. Defaults to `true`, or a
 * new account reaches checkout with nothing to pay with and reads as broken rather than empty.
 */
export function resolveAutoProvisionSandboxMethod(input?: string): boolean {
  return parseBoolean(input, true, 'AUTO_PROVISION_SANDBOX_METHOD')
}

/** The default step-up threshold, in minor units — R$100.00. */
export const DEFAULT_OTP_STEPUP_THRESHOLD_CENTS = 10_000

/**
 * Cart total, in minor units, at or above which checkout requires an OTP step-up; below it a
 * one-tap confirm on the sealed intent is the approval. `0` means always. An unparseable value
 * throws rather than defaulting — silently making every payment frictionless is unnoticeable.
 */
export function resolveOtpStepUpThresholdCents(input?: string): number {
  const trimmed = input?.trim()
  if (!trimmed) return DEFAULT_OTP_STEPUP_THRESHOLD_CENTS

  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`OTP_STEPUP_THRESHOLD_CENTS must be a non-negative integer: ${input}`)
  }

  return value
}

/** The default lifetime of a checkout approval window, in minutes. */
export const DEFAULT_INTENT_TTL_MINUTES = 5

/**
 * How long a user has to authorize a proposed checkout. Bounds the window in which a signed cart, a
 * sealed intent and an OTP are simultaneously valid — a security parameter, not just a UX one.
 */
export function resolveIntentTtlMinutes(input?: string): number {
  const trimmed = input?.trim()
  if (!trimmed) return DEFAULT_INTENT_TTL_MINUTES

  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`INTENT_TTL_MIN must be a positive number: ${input}`)
  }

  return value
}

/**
 * Whether the BFF returns the real one-time code in its `/intent` response. Sandbox only: SNS SMS
 * reaches verified numbers alone, so without this a reviewer with no verified phone cannot check
 * out. Verification is unchanged, but anyone who can read the response gets the code.
 */
export function resolveOtpRevealInUi(input?: string): boolean {
  return parseBoolean(input, false, 'OTP_REVEAL_IN_UI')
}
