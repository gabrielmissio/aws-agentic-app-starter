import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The gate's *rules* are unit-tested in `config.test.ts`. This file asserts the *wiring*: that
 * `app.ts` actually calls them, and calls them before it describes a single resource. Nothing else
 * executes the entry point, so without this a change that drops `assertDeploymentPosture` — or
 * stops passing it one of the values it judges — ships green.
 *
 * Only the refusing direction is exercised, deliberately. A configuration the gate *accepts* carries
 * on into `new AgentStack(...)`, whose `DockerImageAsset` runs a real `docker build` at construction
 * time; that is why `stacks.test.ts` never synthesizes that stack, and this suite inherits the same
 * boundary. A refusal throws at `app.ts`'s gate calls, ahead of the first construct — which is also
 * what these tests prove: they could not complete in milliseconds, with no Docker daemon, if the
 * gate ran any later.
 */

/** Everything `app.ts` reads that could change the outcome, including what CDK injects. */
const OWNED_ENVIRONMENT = [
  'DEPLOY_PROFILE',
  'DEPLOY_ACCOUNT',
  'DEPLOY_REGION',
  'PUBLIC_SIGNUP_ENABLED',
  'ALLOWED_ORIGIN',
  'ALERT_EMAIL',
  'COGNITO_MFA',
  'COGNITO_THREAT_PROTECTION',
  'RETAIN_DATA',
  'GUARDRAIL_ENABLED',
  'TRACING_ENABLED',
  'CONVERSATION_RETENTION_DAYS',
  'MONTHLY_BUDGET_USD',
  'PROJECT_NAME',
  'AWS_REGION',
  'CDK_DEFAULT_ACCOUNT',
  'CDK_DEFAULT_REGION',
] as const

const ACCOUNT = '123456789012'
const REGION = 'us-east-1'

beforeEach(() => {
  // Cleared rather than overridden: a developer's exported AWS_REGION or a CI runner's
  // CDK_DEFAULT_ACCOUNT would otherwise decide which error these tests see. `stubEnv` with
  // `undefined` removes the variable, and `unstubAllEnvs` puts the shell's own values back — so
  // this file never has to restore an environment it did not record correctly.
  for (const key of OWNED_ENVIRONMENT) vi.stubEnv(key, undefined)
  // `app.ts` does its work at module scope, so it has to be re-evaluated for each case.
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const synthesize = () => import('../app.js')

describe('the app entry point', () => {
  it('refuses a pilot still carrying the sandbox defaults', async () => {
    vi.stubEnv('DEPLOY_PROFILE', 'pilot')
    vi.stubEnv('DEPLOY_ACCOUNT', ACCOUNT)
    vi.stubEnv('DEPLOY_REGION', REGION)
    vi.stubEnv('CDK_DEFAULT_ACCOUNT', ACCOUNT)
    vi.stubEnv('CDK_DEFAULT_REGION', REGION)

    await expect(synthesize()).rejects.toThrow(/refuses \d+ sandbox defaults/)
  })

  it('names every violated rule at once, not the first one it meets', async () => {
    vi.stubEnv('DEPLOY_PROFILE', 'prod')
    vi.stubEnv('DEPLOY_ACCOUNT', ACCOUNT)
    vi.stubEnv('DEPLOY_REGION', REGION)
    vi.stubEnv('CDK_DEFAULT_ACCOUNT', ACCOUNT)
    vi.stubEnv('CDK_DEFAULT_REGION', REGION)
    // Two rules satisfied, so what is left has to be reported together rather than one failed
    // synth at a time — the property that keeps people reading the message.
    vi.stubEnv('RETAIN_DATA', 'true')
    vi.stubEnv('ALERT_EMAIL', 'ops@example.com')

    await expect(synthesize()).rejects.toThrow(
      /GUARDRAIL_ENABLED[\s\S]*TRACING_ENABLED[\s\S]*CONVERSATION_RETENTION_DAYS/,
    )
  })

  it('refuses a pilot that names no account or region', async () => {
    vi.stubEnv('DEPLOY_PROFILE', 'pilot')

    await expect(synthesize()).rejects.toThrow(/requires DEPLOY_ACCOUNT and DEPLOY_REGION/)
  })

  it('refuses credentials that resolve to another account', async () => {
    vi.stubEnv('DEPLOY_PROFILE', 'pilot')
    vi.stubEnv('DEPLOY_ACCOUNT', ACCOUNT)
    vi.stubEnv('DEPLOY_REGION', REGION)
    vi.stubEnv('CDK_DEFAULT_ACCOUNT', '999999999999')
    vi.stubEnv('CDK_DEFAULT_REGION', REGION)

    await expect(synthesize()).rejects.toThrow(/Refusing to synthesize/)
  })

  it('rejects a profile it does not recognize instead of falling back to demo', async () => {
    vi.stubEnv('DEPLOY_PROFILE', 'production')

    await expect(synthesize()).rejects.toThrow(/Unsupported DEPLOY_PROFILE/)
  })
})
