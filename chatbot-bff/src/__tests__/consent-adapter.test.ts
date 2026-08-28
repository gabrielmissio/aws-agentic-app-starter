import { describe, expect, it, vi } from 'vitest'
import { approveViaWeb } from '../ap2/consent-adapter.js'
import type { EntityClient } from 'ap2-core/client'

/**
 * The web channel adapter, and the two things it must get right about a *signed* attestation:
 * which step-up method it claims, and what happens when a settle is retried.
 */
const MANDATES = {
  status: 'APPROVED',
  cartMandate: { contents: {}, merchant_authorization: 'jws' },
  checkoutMandate: 'ckm~d1~',
  paymentMandate: 'pm~d1~',
}

function client(over: Partial<EntityClient> = {}): EntityClient {
  return {
    submitConsentDecision: vi.fn().mockResolvedValue({ status: 'APPROVED' }),
    pollConsentStatus: vi.fn().mockResolvedValue(MANDATES),
    ...over,
  } as unknown as EntityClient
}

describe('approveViaWeb — the signed step-up attestation', () => {
  it('records OTP_SMS when the code was texted, which is the manual end-to-end path', async () => {
    const c = client()
    await approveViaWeb(c, { sessionId: 'cs_1', cartHash: 'h', otpRef: 'ref', stepUpMethod: 'OTP_SMS' })

    const submitted = vi.mocked(c.submitConsentDecision).mock.calls[0][0]
    expect(submitted.consentProof?.step_up).toMatchObject({ method: 'OTP_SMS', verified: true })
  })

  it('records OTP_SANDBOX_REVEALED when the code came back in the response', async () => {
    const c = client()
    await approveViaWeb(c, {
      sessionId: 'cs_1',
      cartHash: 'h',
      otpRef: 'ref',
      stepUpMethod: 'OTP_SANDBOX_REVEALED',
    })

    const submitted = vi.mocked(c.submitConsentDecision).mock.calls[0][0]
    expect(submitted.consentProof?.step_up?.method).toBe('OTP_SANDBOX_REVEALED')
  })

  it('leaves step_up absent on the one-tap path, rather than implying a step-up happened', async () => {
    const c = client()
    await approveViaWeb(c, { sessionId: 'cs_1', cartHash: 'h' })

    const submitted = vi.mocked(c.submitConsentDecision).mock.calls[0][0]
    expect(submitted.consentProof?.step_up).toBeUndefined()
  })
})

describe('approveViaWeb — retrying a settle', () => {
  it('carries on with the mandates from the first approval when a re-submit is refused', async () => {
    // The Mandate Authority now refuses a second decision on an APPROVED session. A settle retry —
    // the chain refused, the user taps confirm again — must not read that as a failed approval.
    const c = client({
      submitConsentDecision: vi.fn().mockRejectedValue(new Error('consent session is already APPROVED')),
    })

    await expect(
      approveViaWeb(c, { sessionId: 'cs_1', cartHash: 'h', otpRef: 'ref', stepUpMethod: 'OTP_SMS' }),
    ).resolves.toMatchObject({ checkoutMandate: 'ckm~d1~', paymentMandate: 'pm~d1~' })
  })

  it('surfaces the real submit failure when there are no mandates to fall back on', async () => {
    const c = client({
      submitConsentDecision: vi.fn().mockRejectedValue(new Error('AP2 blocked: TAMPERED — bad cart')),
      pollConsentStatus: vi.fn().mockResolvedValue({ status: 'PENDING' }),
    })

    // Not a generic "mandates unavailable", which would hide why the approval was refused.
    await expect(
      approveViaWeb(c, { sessionId: 'cs_1', cartHash: 'h' }),
    ).rejects.toThrow(/TAMPERED/)
  })
})
