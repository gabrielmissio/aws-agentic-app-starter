/**
 * Env/context → config resolvers, kept out of `app.ts` so they are testable without synthesizing.
 *
 * Each variable's meaning is documented once, in `.env.example`. The notes here cover only what a
 * resolver decides that the description does not.
 */
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets'

export const DEFAULT_PROJECT_NAME = 'demo-strands-agents-ts'
export const DEFAULT_REGION = 'us-east-1'

/** The listed keys with non-blank values. Neither Lambda `environment` nor `CfnRuntime` tolerates `undefined`. */
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
 * What this deployment is for — the one knob that changes what the others are *allowed* to be.
 *
 * The template's defaults suit a disposable sandbox and each is documented as sandbox-only.
 * Documentation is the control that fails: whoever copies this repo to run a pilot is not whoever
 * read the comment. The profile turns those notes into a build that refuses to synthesize.
 */
export const DEPLOY_PROFILES = ['demo', 'pilot', 'prod'] as const
export type DeployProfile = (typeof DEPLOY_PROFILES)[number]

/** Defaults to `demo`. The safety is not the default but that `pilot`/`prod` refuse its settings. */
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

/** Defaults to `off` so a reviewer need not enroll an authenticator to see the demo. */
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

/** Defaults to `off`: anything else moves the pool onto the Plus plan, billed per monthly active user. */
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
 * Whether a WAF web ACL fronts the API. Off unless asked for, in every profile: it is billed per ACL,
 * per rule and per million requests, and a gate that forces recurring spend is one people work
 * around. Recommended for an internet-facing pilot — it is the only layer that filters traffic
 * *before* authentication — but a recommendation, not a build failure.
 */
export function resolveWafEnabled(input?: string): boolean {
  return parseBoolean(input, false, 'WAF_ENABLED')
}

/**
 * The account this deployment is pinned to, if any. `cdk deploy` otherwise targets whatever
 * credentials are in the shell, making a wrong target a matter of which `AWS_PROFILE` was exported
 * last. Unset, nothing is checked; set, a mismatch fails the synth.
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
 * Refuses an account or region this deployment was not meant for. A mismatched pin is an error, and
 * so is a `pilot`/`prod` with no pin at all — an unset variable is the accident this guards against.
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
  allowedOrigin: string
  alertEmail?: string
  mfa: MfaMode
  threatProtection: ThreatProtectionMode
  retainData: boolean
}

/** One violated rule: what is wrong, and the variable that fixes it. */
interface PostureViolation {
  variable: string
  problem: string
}

/**
 * Refuses a `pilot`/`prod` stack still carrying a sandbox default. Every violation is collected
 * before throwing: discovering them one failed synth at a time is how people stop reading the
 * message. `demo` is unchecked — a sandbox that nags teaches that these errors are noise.
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
      'must be "required". A password alone is one leaked credential away from someone else\'s conversations.',
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

/** Throws on an unrecognized value: every caller governs something a silent default gets wrong. */
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

/** Defaults to retain: an orphaned pool is a manual cleanup, a destroyed one is every account. */
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

/** Ceiling that triggers a budget notification. A budget alerts; it cannot stop spend. */
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

/** Unset, the stage inherits the 10k rps account default — and every request costs Bedrock tokens. */
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
 * Defaults to `*`: on a first `cdk deploy --all` the CloudFront URL does not exist yet
 * (`FrontendStack` depends on `BffStack`, not the reverse), so there is no origin to lock to.
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
 * Caps one caller; `API_RATE_LIMIT` caps the account and cannot stop one caller consuming all of it.
 * Enforced in the chat Lambda because API Gateway has no per-JWT-claim throttling.
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

/** The Docker platform the agent image is built for. Defaults to the AgentCore target, arm64. */
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
 * The model the agent invokes. It lives here because the agent's role is scoped to it — permission
 * and configuration must come from one place. `agent/src/agent.ts` repeats it as a local fallback
 * that never engages deployed, since the stack always injects `BEDROCK_MODEL_ID`.
 */
export const DEFAULT_BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-6'

export function resolveBedrockModelId(input?: string): string {
  const trimmed = input?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BEDROCK_MODEL_ID
}
