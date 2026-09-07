import { describe, expect, it } from 'vitest'
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets'
import {
  assertDeploymentPosture,
  assertDeploymentTarget,
  resolveExpectedAccount,
  resolveDeployProfile,
  resolveMfaMode,
  resolveThreatProtection,
  resolveWafEnabled,
  DEFAULT_API_THROTTLE,
  pickDefinedEnvironment,
  resolveAgentImagePlatform,
  resolveAlertEmail,
  resolveAllowedOrigin,
  resolveApiThrottle,
  resolveMonthlyBudgetUsd,
  resolvePublicSignUpEnabled,
  resolveRetainData,
  resolveUserRateLimit,
  DEFAULT_USER_RATE_LIMIT,
  resolveConversationRetentionDays,
  resolveGuardrailEnabled,
  resolveTracingEnabled,
} from '../config.js'

describe('resolveAgentImagePlatform', () => {
  it('defaults to arm64 — the AgentCore runtime target', () => {
    expect(resolveAgentImagePlatform(undefined)).toBe(ecrassets.Platform.LINUX_ARM64)
    expect(resolveAgentImagePlatform('linux/arm64')).toBe(ecrassets.Platform.LINUX_ARM64)
    expect(resolveAgentImagePlatform('arm64')).toBe(ecrassets.Platform.LINUX_ARM64)
  })

  it('supports amd64 for local troubleshooting', () => {
    expect(resolveAgentImagePlatform('AMD64')).toBe(ecrassets.Platform.LINUX_AMD64)
  })

  it('returns undefined for the host platform so CDK builds natively', () => {
    expect(resolveAgentImagePlatform('current')).toBeUndefined()
    expect(resolveAgentImagePlatform('local')).toBeUndefined()
    expect(resolveAgentImagePlatform('host')).toBeUndefined()
  })

  it('passes anything else through as a custom platform', () => {
    expect(resolveAgentImagePlatform('linux/riscv64')?.platform).toBe('linux/riscv64')
  })
})

describe('pickDefinedEnvironment', () => {
  it('keeps only the requested keys that carry a real value', () => {
    const picked = pickDefinedEnvironment(['A', 'B', 'C', 'D'], {
      A: 'value',
      B: '',
      C: '   ',
      D: undefined,
      E: 'ignored',
    })

    expect(picked).toEqual({ A: 'value' })
  })

  it('defaults to reading process.env when no env object is given', () => {
    process.env.CONFIG_TEST_KEY = 'from-process-env'
    try {
      expect(pickDefinedEnvironment(['CONFIG_TEST_KEY'])).toEqual({
        CONFIG_TEST_KEY: 'from-process-env',
      })
    } finally {
      delete process.env.CONFIG_TEST_KEY
    }
  })
})

describe('resolvePublicSignUpEnabled', () => {
  it('defaults to enabled — lowest friction for trying the template', () => {
    expect(resolvePublicSignUpEnabled(undefined)).toBe(true)
    expect(resolvePublicSignUpEnabled('')).toBe(true)
  })

  it('accepts the usual spellings of both answers', () => {
    expect(resolvePublicSignUpEnabled('false')).toBe(false)
    expect(resolvePublicSignUpEnabled('NO')).toBe(false)
    expect(resolvePublicSignUpEnabled('true')).toBe(true)
  })

  it('refuses a value it cannot interpret rather than guessing', () => {
    expect(() => resolvePublicSignUpEnabled('maybe')).toThrow(/PUBLIC_SIGNUP_ENABLED/)
  })
})

describe('resolveRetainData', () => {
  // Asymmetric outcomes: retaining in a demo leaves an orphan, destroying in a pilot loses users.
  it('defaults to retaining', () => {
    expect(resolveRetainData(undefined)).toBe(true)
    expect(resolveRetainData('')).toBe(true)
  })

  it('accepts the usual spellings of both answers', () => {
    expect(resolveRetainData('false')).toBe(false)
    expect(resolveRetainData('NO')).toBe(false)
    expect(resolveRetainData(' 0 ')).toBe(false)
    expect(resolveRetainData('true')).toBe(true)
    expect(resolveRetainData('yes')).toBe(true)
  })

  it('refuses a value it cannot interpret rather than guessing', () => {
    expect(() => resolveRetainData('maybe')).toThrow(/RETAIN_DATA/)
  })
})

describe('resolveAlertEmail', () => {
  it('passes a valid address through and treats blank as unset', () => {
    expect(resolveAlertEmail(' ops@example.com ')).toBe('ops@example.com')
    expect(resolveAlertEmail(undefined)).toBeUndefined()
    expect(resolveAlertEmail('  ')).toBeUndefined()
  })

  it('fails at synth rather than silently never alerting', () => {
    expect(() => resolveAlertEmail('not-an-email')).toThrow(/ALERT_EMAIL/)
  })
})

describe('resolveMonthlyBudgetUsd', () => {
  it('parses a positive amount and treats blank as disabled', () => {
    expect(resolveMonthlyBudgetUsd('200')).toBe(200)
    expect(resolveMonthlyBudgetUsd(undefined)).toBeUndefined()
  })

  it('rejects zero, negatives and nonsense', () => {
    expect(() => resolveMonthlyBudgetUsd('0')).toThrow(/MONTHLY_BUDGET_USD/)
    expect(() => resolveMonthlyBudgetUsd('-5')).toThrow(/MONTHLY_BUDGET_USD/)
    expect(() => resolveMonthlyBudgetUsd('lots')).toThrow(/MONTHLY_BUDGET_USD/)
  })
})

describe('resolveAllowedOrigin', () => {
  it('defaults to the wildcard — the frontend origin does not exist yet on a first deploy', () => {
    expect(resolveAllowedOrigin(undefined)).toBe('*')
    expect(resolveAllowedOrigin('')).toBe('*')
    expect(resolveAllowedOrigin('   ')).toBe('*')
  })

  it('passes a configured origin through, trimmed', () => {
    expect(resolveAllowedOrigin(' https://app.example.com ')).toBe('https://app.example.com')
  })
})

describe('resolveUserRateLimit', () => {
  it('falls back to the defaults', () => {
    expect(resolveUserRateLimit(undefined, undefined)).toEqual(DEFAULT_USER_RATE_LIMIT)
  })

  it('overrides either side independently', () => {
    expect(resolveUserRateLimit('5', undefined)).toEqual({
      limit: 5,
      windowSeconds: DEFAULT_USER_RATE_LIMIT.windowSeconds,
    })
  })

  it('rejects a non-positive limit — an unbounded caller is the thing being prevented', () => {
    expect(() => resolveUserRateLimit('0', undefined)).toThrow(/USER_RATE_LIMIT/)
    expect(() => resolveUserRateLimit(undefined, 'none')).toThrow(/USER_RATE_LIMIT_WINDOW_SECONDS/)
  })
})

describe('resolveApiThrottle', () => {
  it('falls back to the defaults', () => {
    expect(resolveApiThrottle(undefined, undefined)).toEqual(DEFAULT_API_THROTTLE)
  })

  it('overrides either side independently', () => {
    expect(resolveApiThrottle('50', undefined)).toEqual({
      rateLimit: 50,
      burstLimit: DEFAULT_API_THROTTLE.burstLimit,
    })
  })

  it('rejects a non-positive limit — an unlimited stage is the thing being prevented', () => {
    expect(() => resolveApiThrottle('0', undefined)).toThrow(/API_RATE_LIMIT/)
    expect(() => resolveApiThrottle(undefined, 'none')).toThrow(/API_BURST_LIMIT/)
  })
})

describe('the deployment profile gate', () => {
  /**
   * The template ships sandbox defaults on purpose — public sign-up, CORS open to everything, no
   * second factor — each documented as sandbox-only. Documentation is the control that fails here:
   * whoever copies this repo to run a pilot is not whoever read the comment. These tests pin the
   * mechanism that turns those notes into a build failure.
   */
  const pilot = () => ({
    profile: 'pilot' as const,
    publicSignUpEnabled: false,
    allowedOrigin: 'https://app.example.com',
    alertEmail: 'ops@example.com',
    mfa: 'required' as const,
    threatProtection: 'audit' as const,
    retainData: true,
    guardrailEnabled: true,
    tracingEnabled: true,
    agentObservabilityEnabled: true,
    transactionSearchEnabled: true,
    conversationRetentionDays: 30,
  })

  it('accepts a pilot that has actually been configured for one', () => {
    expect(() => assertDeploymentPosture(pilot())).not.toThrow()
  })

  it('leaves a demo alone', () => {
    // Making the sandbox nag about production posture would teach exactly the habit this exists to
    // prevent: that these errors are noise to be worked around.
    expect(() =>
      assertDeploymentPosture({
        ...pilot(),
        profile: 'demo',
        publicSignUpEnabled: true,
        allowedOrigin: '*',
        alertEmail: undefined,
        mfa: 'off',
        threatProtection: 'off',
        guardrailEnabled: false,
        tracingEnabled: false,
        conversationRetentionDays: undefined,
      }),
    ).not.toThrow()
  })

  it.each([
    ['PUBLIC_SIGNUP_ENABLED', { publicSignUpEnabled: true }],
    ['ALLOWED_ORIGIN', { allowedOrigin: '*' }],
    ['ALERT_EMAIL', { alertEmail: undefined }],
    ['COGNITO_MFA', { mfa: 'optional' as const }],
    ['COGNITO_THREAT_PROTECTION', { threatProtection: 'off' as const }],
    ['RETAIN_DATA', { retainData: false }],
    ['GUARDRAIL_ENABLED', { guardrailEnabled: false }],
    ['TRACING_ENABLED', { tracingEnabled: false }],
    ['AGENT_OBSERVABILITY_ENABLED', { agentObservabilityEnabled: false }],
    ['TRANSACTION_SEARCH_ENABLED', { transactionSearchEnabled: false }],
    ['CONVERSATION_RETENTION_DAYS', { conversationRetentionDays: undefined }],
  ])('refuses a pilot still carrying the sandbox %s', (variable, override) => {
    expect(() => assertDeploymentPosture({ ...pilot(), ...override })).toThrow(variable)
  })

  it('names every violation at once, not the first one', () => {
    // An operator turning a demo into a pilot has a handful of these to fix. Discovering them one
    // failed synth at a time is how people stop reading the message and start guessing.
    const err = (() => {
      try {
        assertDeploymentPosture({
          ...pilot(),
          publicSignUpEnabled: true,
          allowedOrigin: '*',
          alertEmail: undefined,
        })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(err?.message).toContain('PUBLIC_SIGNUP_ENABLED')
    expect(err?.message).toContain('ALLOWED_ORIGIN')
    expect(err?.message).toContain('ALERT_EMAIL')
  })

  /**
   * The three additions a pilot's *evidence* posture depends on, as opposed to its access posture.
   * A deployment can pass every original rule and still be unable to say what the agent replied, for
   * how long it is kept, or which turn a user is complaining about.
   */
  it('refuses a pilot that records conversations without saying for how long', () => {
    const err = (() => {
      try {
        assertDeploymentPosture({
          ...pilot(),
          guardrailEnabled: false,
          tracingEnabled: false,
          agentObservabilityEnabled: false,
          transactionSearchEnabled: false,
          conversationRetentionDays: undefined,
        })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(err?.message).toContain('GUARDRAIL_ENABLED')
    expect(err?.message).toContain('TRACING_ENABLED')
    expect(err?.message).toContain('CONVERSATION_RETENTION_DAYS')
  })

  it('holds prod to everything pilot requires', () => {
    const prod = { ...pilot(), profile: 'prod' as const }
    expect(() => assertDeploymentPosture(prod)).not.toThrow()
    expect(() => assertDeploymentPosture({ ...prod, retainData: false })).toThrow('RETAIN_DATA')
  })

  it('defaults to demo and rejects a profile it does not know', () => {
    expect(resolveDeployProfile()).toBe('demo')
    expect(resolveDeployProfile('pilot')).toBe('pilot')
    // A typo must not silently downgrade the deployment to the permissive profile.
    expect(() => resolveDeployProfile('production')).toThrow('DEPLOY_PROFILE')
  })

  it('leaves the WAF off unless it is asked for, in every profile', () => {
    // Opt-in rather than profile-driven: a web ACL is billed per ACL, per rule and per million
    // requests, and a gate that forces recurring spend is one people learn to work around. The
    // recommendation for an internet-facing pilot lives in the docs, not in a build failure.
    expect(resolveWafEnabled()).toBe(false)
    expect(resolveWafEnabled('true')).toBe(true)
    expect(() => resolveWafEnabled('sometimes')).toThrow('WAF_ENABLED')
  })

  it('does not fail a pilot for running without one', () => {
    expect(() => assertDeploymentPosture(pilot())).not.toThrow()
  })

  /**
   * Both are billed per unit of use, so both stay off until asked for — the template's promise is
   * that an unset profile costs nothing. What makes that safe is the gate above, not the default.
   */
  it('leaves the guardrail and tracing off unless asked for', () => {
    expect(resolveGuardrailEnabled()).toBe(false)
    expect(resolveGuardrailEnabled('true')).toBe(true)
    expect(() => resolveGuardrailEnabled('maybe')).toThrow('GUARDRAIL_ENABLED')

    expect(resolveTracingEnabled()).toBe(false)
    expect(resolveTracingEnabled('true')).toBe(true)
    expect(() => resolveTracingEnabled('maybe')).toThrow('TRACING_ENABLED')
  })

  /**
   * Unset means unset, not thirty. "How long do you keep what people typed" is the question a pilot
   * is asked first, and a number this template picked would be an answer nobody chose.
   */
  it('has no retention default to fall back on', () => {
    expect(resolveConversationRetentionDays()).toBeUndefined()
    expect(resolveConversationRetentionDays('  ')).toBeUndefined()
    expect(resolveConversationRetentionDays('90')).toBe(90)
  })

  it.each([['0'], ['-1'], ['1.5'], ['forever']])(
    'refuses %s as a retention period rather than coercing it',
    (input) => {
      expect(() => resolveConversationRetentionDays(input)).toThrow('CONVERSATION_RETENTION_DAYS')
    },
  )

  it('rejects an unknown MFA or threat-protection mode rather than guessing', () => {
    expect(resolveMfaMode()).toBe('off')
    expect(resolveMfaMode('required')).toBe('required')
    expect(() => resolveMfaMode('yes')).toThrow('COGNITO_MFA')
    expect(resolveThreatProtection()).toBe('off')
    expect(() => resolveThreatProtection('on')).toThrow('COGNITO_THREAT_PROTECTION')
  })
})

describe('pinning a deployment to its account and region', () => {
  /**
   * `cdk deploy` targets whatever credentials are in the shell. For a sandbox that is the point;
   * for a deployment holding real user data it means the difference between the scratch account and
   * the real one is which `AWS_PROFILE` was exported last, with nothing in between to notice.
   */
  const target = {
    profile: 'pilot' as const,
    account: '123456789012',
    region: 'us-east-1',
    expectedAccount: '123456789012',
    expectedRegion: 'us-east-1',
  }

  it('accepts a deployment landing where it was pinned', () => {
    expect(() => assertDeploymentTarget(target)).not.toThrow()
  })

  it('refuses an account the deployment was not meant for', () => {
    expect(() =>
      assertDeploymentTarget({ ...target, account: '999999999999' }),
    ).toThrow('999999999999')
  })

  it('refuses a region the deployment was not meant for', () => {
    expect(() => assertDeploymentTarget({ ...target, region: 'eu-west-1' })).toThrow('eu-west-1')
  })

  it('refuses a pilot with no pin at all', () => {
    // The rule that matters. An unset variable is exactly the accident the pin guards against, so
    // "not configured" cannot be the way past it.
    expect(() =>
      assertDeploymentTarget({ ...target, expectedAccount: undefined, expectedRegion: undefined }),
    ).toThrow('DEPLOY_ACCOUNT')
  })

  it('leaves an unpinned demo alone', () => {
    expect(() =>
      assertDeploymentTarget({
        profile: 'demo',
        account: '123456789012',
        region: 'us-east-1',
      }),
    ).not.toThrow()
  })

  it('rejects an account id that is not one', () => {
    // A typo here silently disables the check if it is merely ignored.
    expect(() => resolveExpectedAccount('12345')).toThrow('DEPLOY_ACCOUNT')
    expect(resolveExpectedAccount('  ')).toBeUndefined()
    expect(resolveExpectedAccount('123456789012')).toBe('123456789012')
  })
})
