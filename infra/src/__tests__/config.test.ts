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
  resolveAp2RateLimit,
  DEFAULT_AP2_RATE_LIMIT,
  resolveMonthlyBudgetUsd,
  resolvePublicSignUpEnabled,
  resolveRetainData,
  resolveUserRateLimit,
  DEFAULT_USER_RATE_LIMIT,
  DEFAULT_INTENT_TTL_MINUTES,
  DEFAULT_OTP_STEPUP_THRESHOLD_CENTS,
  DEFAULT_TARGET_MPP,
  resolveAllowedMpps,
  resolveAutoProvisionSandboxMethod,
  resolveIntentTtlMinutes,
  resolveOtpRevealInUi,
  resolveOtpStepUpThresholdCents,
} from '../config.js'

describe('resolveAp2RateLimit', () => {
  it('defaults tighter than the chat quota — these are the routes that move money', () => {
    expect(resolveAp2RateLimit()).toEqual(DEFAULT_AP2_RATE_LIMIT)
    expect(DEFAULT_AP2_RATE_LIMIT.limit).toBeLessThan(DEFAULT_USER_RATE_LIMIT.limit)
  })

  it('accepts an override', () => {
    expect(resolveAp2RateLimit('4', '30')).toEqual({ limit: 4, windowSeconds: 30 })
  })

  it('fails loudly at synth time rather than silently widening the quota', () => {
    expect(() => resolveAp2RateLimit('0')).toThrow(/AP2_RATE_LIMIT/)
    expect(() => resolveAp2RateLimit('lots')).toThrow(/AP2_RATE_LIMIT/)
    expect(() => resolveAp2RateLimit('10', '-1')).toThrow(/AP2_RATE_LIMIT_WINDOW_SECONDS/)
  })
})

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

describe('resolveAllowedMpps', () => {
  it('defaults to the sandbox MPP when unset or blank', () => {
    expect(resolveAllowedMpps(undefined)).toEqual([DEFAULT_TARGET_MPP])
    expect(resolveAllowedMpps('   ')).toEqual([DEFAULT_TARGET_MPP])
  })

  it('splits and trims a comma-separated list', () => {
    expect(resolveAllowedMpps('mpp-a, mpp-b ,mpp-c')).toEqual(['mpp-a', 'mpp-b', 'mpp-c'])
  })

  it('drops blank entries so a stray comma cannot authorize an empty MPP id', () => {
    expect(resolveAllowedMpps('mpp-a,,mpp-b,')).toEqual(['mpp-a', 'mpp-b'])
    expect(resolveAllowedMpps(',')).toEqual([DEFAULT_TARGET_MPP])
  })
})

describe('resolveAutoProvisionSandboxMethod', () => {
  it('defaults to on, so a brand-new account can reach checkout', () => {
    expect(resolveAutoProvisionSandboxMethod(undefined)).toBe(true)
  })

  it('accepts the usual spellings, case-insensitively', () => {
    expect(resolveAutoProvisionSandboxMethod('FALSE')).toBe(false)
    expect(resolveAutoProvisionSandboxMethod('off')).toBe(false)
    expect(resolveAutoProvisionSandboxMethod('1')).toBe(true)
  })

  it('fails loudly on an unrecognized value instead of silently defaulting', () => {
    expect(() => resolveAutoProvisionSandboxMethod('maybe')).toThrow(
      /Unsupported AUTO_PROVISION_SANDBOX_METHOD/,
    )
  })
})

describe('resolveOtpStepUpThresholdCents', () => {
  it('defaults to R$100.00 in minor units', () => {
    expect(resolveOtpStepUpThresholdCents(undefined)).toBe(DEFAULT_OTP_STEPUP_THRESHOLD_CENTS)
    expect(DEFAULT_OTP_STEPUP_THRESHOLD_CENTS).toBe(10_000)
  })

  it('accepts zero, which means every payment steps up', () => {
    expect(resolveOtpStepUpThresholdCents('0')).toBe(0)
  })

  it('rejects a non-integer or negative threshold rather than guessing', () => {
    // Silently falling back here would make every payment frictionless, which is precisely the
    // failure nobody notices until it matters.
    expect(() => resolveOtpStepUpThresholdCents('50.5')).toThrow(/OTP_STEPUP_THRESHOLD_CENTS/)
    expect(() => resolveOtpStepUpThresholdCents('-1')).toThrow(/OTP_STEPUP_THRESHOLD_CENTS/)
    expect(() => resolveOtpStepUpThresholdCents('lots')).toThrow(/OTP_STEPUP_THRESHOLD_CENTS/)
  })
})

describe('resolveIntentTtlMinutes', () => {
  it('defaults to five minutes', () => {
    expect(resolveIntentTtlMinutes(undefined)).toBe(DEFAULT_INTENT_TTL_MINUTES)
  })

  it('rejects a non-positive or unparseable window', () => {
    expect(() => resolveIntentTtlMinutes('0')).toThrow(/INTENT_TTL_MIN/)
    expect(() => resolveIntentTtlMinutes('-5')).toThrow(/INTENT_TTL_MIN/)
    expect(() => resolveIntentTtlMinutes('soon')).toThrow(/INTENT_TTL_MIN/)
  })
})

describe('resolveOtpRevealInUi', () => {
  it('defaults to off — the code is never handed back in a response by accident', () => {
    expect(resolveOtpRevealInUi(undefined)).toBe(false)
    expect(resolveOtpRevealInUi('')).toBe(false)
  })

  it('is enabled only by an explicit affirmative value', () => {
    expect(resolveOtpRevealInUi('true')).toBe(true)
    expect(resolveOtpRevealInUi('no')).toBe(false)
    expect(() => resolveOtpRevealInUi('sandbox')).toThrow(/Unsupported OTP_REVEAL_IN_UI/)
  })
})

describe('the deployment profile gate', () => {
  /**
   * The template ships sandbox defaults on purpose — public sign-up, a code echoed back in the
   * response, CORS open to everything — each documented as sandbox-only. Documentation is the
   * control that fails here: whoever copies this repo to run a pilot is not whoever read the
   * comment. These tests pin the mechanism that turns those notes into a build failure.
   */
  const pilot = () => ({
    profile: 'pilot' as const,
    publicSignUpEnabled: false,
    otpRevealInUi: false,
    allowedOrigin: 'https://app.example.com',
    alertEmail: 'ops@example.com',
    mfa: 'required' as const,
    threatProtection: 'audit' as const,
    retainData: true,
    autoProvisionSandboxMethod: true,
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
        otpRevealInUi: true,
        allowedOrigin: '*',
        alertEmail: undefined,
        mfa: 'off',
        threatProtection: 'off',
      }),
    ).not.toThrow()
  })

  it.each([
    ['PUBLIC_SIGNUP_ENABLED', { publicSignUpEnabled: true }],
    ['OTP_REVEAL_IN_UI', { otpRevealInUi: true }],
    ['ALLOWED_ORIGIN', { allowedOrigin: '*' }],
    ['ALERT_EMAIL', { alertEmail: undefined }],
    ['COGNITO_MFA', { mfa: 'optional' as const }],
    ['COGNITO_THREAT_PROTECTION', { threatProtection: 'off' as const }],
    ['RETAIN_DATA', { retainData: false }],
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
          otpRevealInUi: true,
          allowedOrigin: '*',
        })
        return undefined
      } catch (e) {
        return e as Error
      }
    })()

    expect(err?.message).toContain('PUBLIC_SIGNUP_ENABLED')
    expect(err?.message).toContain('OTP_REVEAL_IN_UI')
    expect(err?.message).toContain('ALLOWED_ORIGIN')
  })

  it('holds prod to everything pilot requires, plus the sandbox instrument', () => {
    const prod = { ...pilot(), profile: 'prod' as const }
    expect(() => assertDeploymentPosture(prod)).toThrow('AUTO_PROVISION_SANDBOX_METHOD')
    expect(() =>
      assertDeploymentPosture({ ...prod, autoProvisionSandboxMethod: false }),
    ).not.toThrow()
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
