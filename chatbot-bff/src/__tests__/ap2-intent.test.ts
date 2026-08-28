import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_STEPUP_THRESHOLD_CENTS,
  canonicalIntent,
  formatAmount,
  generateOtp,
  hashOtp,
  initHmacSecret,
  MAX_OTP_ATTEMPTS,
  requiresStepUp,
  resolveAp2Route,
  resolveStepUpDelivery,
  stepUpMethodFor,
  sealIntent,
  stepUpThresholdCents,
  verifyOtp,
  verifySeal,
  type SealFields,
} from '../ap2/intent.js'

const SECRET = 'test-secret-not-a-real-one'

const fields: SealFields = {
  sessionId: 'cs_abc123',
  cartCanonicalHash: 'Zm9vYmFy',
  amountCents: 4180,
  userId: 'cognito-sub-uuid',
}

beforeAll(() => initHmacSecret(SECRET))

describe('canonicalIntent', () => {
  it('serializes the same fields identically regardless of construction order', () => {
    const reordered: SealFields = {
      userId: fields.userId,
      amountCents: fields.amountCents,
      cartCanonicalHash: fields.cartCanonicalHash,
      sessionId: fields.sessionId,
    }
    expect(canonicalIntent(reordered)).toBe(canonicalIntent(fields))
  })
})

describe('sealIntent / verifySeal', () => {
  it('accepts a seal over the exact same fields', () => {
    expect(verifySeal(fields, sealIntent(fields))).toBe(true)
  })

  it.each([
    ['amount', { amountCents: 100 }],
    ['cart', { cartCanonicalHash: 'ZGlmZmVyZW50' }],
    ['session', { sessionId: 'cs_other' }],
    ['user', { userId: 'someone-else' }],
  ])('rejects a seal replayed against a different %s', (_field, override) => {
    // This is the property the whole gate rests on: a one-time code proves someone is present, not
    // what they agreed to. Without the seal, a code minted for a small cart authorizes a large one.
    const seal = sealIntent(fields)
    expect(verifySeal({ ...fields, ...override }, seal)).toBe(false)
  })

  it('rejects a seal of the wrong length without throwing', () => {
    // A length mismatch has to short-circuit before the constant-time compare, which throws on
    // unequal buffers — and throwing would itself leak the length.
    expect(verifySeal(fields, 'short')).toBe(false)
    expect(verifySeal(fields, '')).toBe(false)
  })

  it('produces a different seal under a different key', () => {
    expect(sealIntent(fields, 'another-secret')).not.toBe(sealIntent(fields, SECRET))
  })
})

describe('one-time codes', () => {
  it('mints six digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/)
    }
  })

  it('stores a keyed hash, never the code itself', () => {
    const otp = '123456'
    const stored = hashOtp(otp, SECRET)
    expect(stored).not.toContain(otp)
    // Keyed, so the stored value is useless to anyone who can read the table but not the secret —
    // a plain digest of six digits is reversible by brute force in milliseconds.
    expect(hashOtp(otp, 'another-secret')).not.toBe(stored)
  })

  it('accepts the right code and rejects a wrong one', () => {
    const stored = hashOtp('123456')
    expect(verifyOtp('123456', stored)).toBe(true)
    expect(verifyOtp('654321', stored)).toBe(false)
    expect(verifyOtp('', stored)).toBe(false)
    expect(verifyOtp('1234567', stored)).toBe(false)
  })
})

describe('requiresStepUp', () => {
  const withThreshold = (v: string | undefined) =>
    ({ OTP_STEPUP_THRESHOLD_CENTS: v }) as NodeJS.ProcessEnv

  it('steps up at or above the threshold, and not below it', () => {
    const env = withThreshold('10000')
    expect(requiresStepUp({ amountCents: 9_999 }, env)).toBe(false)
    expect(requiresStepUp({ amountCents: 10_000 }, env)).toBe(true)
    expect(requiresStepUp({ amountCents: 10_001 }, env)).toBe(true)
  })

  it('defaults to the documented threshold when unset', () => {
    expect(stepUpThresholdCents(withThreshold(undefined))).toBe(DEFAULT_STEPUP_THRESHOLD_CENTS)
  })

  it('steps up on every payment when the threshold is zero', () => {
    expect(requiresStepUp({ amountCents: 1 }, withThreshold('0'))).toBe(true)
  })

  it('errs toward more friction on an unparseable threshold', () => {
    // The infra resolver rejects a bad value at synth, so reaching this means someone set the
    // variable on the function directly — and defaulting to "no code required" is the one direction
    // that would go unnoticed.
    expect(requiresStepUp({ amountCents: 1 }, withThreshold('lots'))).toBe(true)
  })
})

describe('resolveStepUpDelivery', () => {
  // The gap this closes: `requiresStepUp` decided a code was *needed*; nothing asked whether one
  // could be *sent*. This pool never populates `phone_number`, so `caller.phone` was undefined, the
  // SMS was never sent, and the UI opened a field nobody could fill.
  it('texts the code when the verified claims carry a phone number', () => {
    expect(resolveStepUpDelivery({ phone: '+5511999999999' }, {})).toEqual({
      smsTo: '+5511999999999',
      reveal: false,
    })
  })

  it('reveals the code when the sandbox flag is explicitly on', () => {
    expect(resolveStepUpDelivery({}, { OTP_REVEAL_IN_UI: 'true' })).toEqual({ reveal: true })
    expect(resolveStepUpDelivery({}, { OTP_REVEAL_IN_UI: 'TRUE' })).toBeNull()
    expect(resolveStepUpDelivery({}, { OTP_REVEAL_IN_UI: '1' })).toBeNull()
  })

  // The two channels must not be alternatives. SNS only delivers to sandbox-verified numbers and
  // `sendOtpSms` swallows its own failures, so an operator testing with a real phone and the reveal
  // on would get neither the SMS nor the on-screen code if the phone won.
  it('does both when both are available, rather than picking one', () => {
    expect(
      resolveStepUpDelivery({ phone: '+5511999999999' }, { OTP_REVEAL_IN_UI: 'true' }),
    ).toEqual({ smsTo: '+5511999999999', reveal: true })
  })

  it('reports no delivery when there is none — the case the gate must refuse', () => {
    expect(resolveStepUpDelivery({}, {})).toBeNull()
  })
})

describe('stepUpMethodFor', () => {
  it('records a texted code as OTP_SMS', () => {
    expect(stepUpMethodFor({ smsTo: '+5511999999999', reveal: false })).toBe('OTP_SMS')
  })

  it('records a revealed code as OTP_SANDBOX_REVEALED', () => {
    expect(stepUpMethodFor({ reveal: true })).toBe('OTP_SANDBOX_REVEALED')
  })

  it('takes the weakest channel when both applied', () => {
    // Once the code is in the response body, an SMS going out alongside does not undo that. The
    // attestation is signed into the mandate, so it must not overstate the assurance.
    expect(stepUpMethodFor({ smsTo: '+5511999999999', reveal: true })).toBe('OTP_SANDBOX_REVEALED')
  })
})

describe('MAX_OTP_ATTEMPTS', () => {
  it('is small enough to matter against a six-digit code', () => {
    // A million possibilities only bound a guess if the number of guesses is bounded too.
    expect(MAX_OTP_ATTEMPTS).toBeGreaterThan(0)
    expect(MAX_OTP_ATTEMPTS).toBeLessThanOrEqual(10)
  })
})

describe('resolveAp2Route', () => {
  it('recognizes each money-moving route by exact method and path', () => {
    expect(resolveAp2Route('POST', '/intent')).toBe('openIntent')
    expect(resolveAp2Route('POST', '/confirm')).toBe('confirm')
    expect(resolveAp2Route('POST', '/decline')).toBe('decline')
  })

  it('recognizes the read-only routes', () => {
    expect(resolveAp2Route('GET', '/journeys')).toBe('journeys')
    expect(resolveAp2Route('GET', '/actors')).toBe('actors')
    expect(resolveAp2Route('GET', '/evidence/journey_abc')).toBe('journeyEvidence')
  })

  it('tolerates a trailing slash', () => {
    expect(resolveAp2Route('POST', '/confirm/')).toBe('confirm')
    expect(resolveAp2Route('GET', '/journeys//')).toBe('journeys')
  })

  it('treats every preflight as a preflight', () => {
    expect(resolveAp2Route('OPTIONS', '/confirm')).toBe('preflight')
    expect(resolveAp2Route('OPTIONS', '/anything')).toBe('preflight')
  })

  it('refuses anything it does not recognize, rather than matching by prefix', () => {
    // A prefix match here would mean a path nobody reviewed could reach settlement.
    expect(resolveAp2Route('GET', '/confirm')).toBeNull()
    expect(resolveAp2Route('POST', '/journeys')).toBeNull()
    expect(resolveAp2Route('POST', '/confirm/extra')).toBeNull()
    expect(resolveAp2Route('GET', '/evidence/')).toBeNull()
    expect(resolveAp2Route('DELETE', '/intent')).toBeNull()
    expect(resolveAp2Route(undefined, undefined)).toBeNull()
  })
})

describe('formatAmount', () => {
  it('renders minor units with the currency', () => {
    expect(formatAmount(4180, 'BRL')).toBe('BRL 41.80')
    expect(formatAmount(0, 'USD')).toBe('USD 0.00')
  })
})
