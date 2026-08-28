import { describe, expect, it } from 'vitest'
import { LocalSigner } from '../domain/adapters/local-signer'
import {
  MemoryConsentRepo,
  MemoryEvidence,
  MemoryMerchantRepo,
} from '../domain/adapters/memory'
import * as consent from '../domain/entities/consent-mandates'
import { createMerchantCart } from '../domain/entities/merchant'
import {
  cartHash,
  decodePaymentMandate,
  issueRawMandate,
  paymentMandateHash,
  sdjwtFor,
  verifyPaymentMandate,
} from '../domain/mandates'
import { SALT_HEX_CHARS } from '../domain/sdjwt'
import { VCT } from '../domain/types'

/** Every journey in this file belongs to the same test caller. */
const USER = 'user_sdjwt'

/**
 * The user-signed mandates serialize as SD-JWT-VCs (RFC 9901) — salted digests plus selective
 * disclosure — over the same `Signer` port everything else uses.
 *
 * These tests pin the four properties the spec actually leans on: a verifier can be shown less than
 * the full mandate, a forged disclosure cannot be smuggled past that, salts carry real entropy, and
 * the issuer signature is non-deterministic.
 */
async function aPaymentMandate(): Promise<{ signer: LocalSigner; paymentMandate: string }> {
  const signer = new LocalSigner()
  const evidence = new MemoryEvidence()
  const merchantRepo = new MemoryMerchantRepo()
  const consentRepo = new MemoryConsentRepo()
  const cart = await createMerchantCart(merchantRepo, signer, evidence, 'j_sd', [{ productId: 'item_a', qty: 1 }], USER)
  const proof = consent.buildWebOtpConsentProof(cartHash(cart), 'cs', 'sha256:otp')
  const { paymentMandate } = await consent.emitMandates(signer, evidence, consentRepo, 'j_sd', cart, 'pm_visa_1234', proof)
  return { signer, paymentMandate }
}

describe('SD-JWT-VC serialization of the user-signed mandates', () => {
  it('serializes as issuer-jwt plus disclosures, with the vct left visible', async () => {
    const signer = new LocalSigner()
    const evidence = new MemoryEvidence()
    const merchantRepo = new MemoryMerchantRepo()
    const consentRepo = new MemoryConsentRepo()
    const cart = await createMerchantCart(merchantRepo, signer, evidence, 'j_fmt', [{ productId: 'item_a', qty: 1 }], USER)
    const proof = consent.buildWebOtpConsentProof(cartHash(cart), 'cs', 'sha256:otp')
    const { paymentMandate } = await consent.emitMandates(signer, evidence, consentRepo, 'j_fmt', cart, 'pm_visa_1234', proof)

    expect(typeof paymentMandate).toBe('string')
    expect(paymentMandate.includes('~')).toBe(true); // has disclosures
    // header is the SD-JWT-VC media type + the issuer kid
    const header = JSON.parse(Buffer.from(paymentMandate.split('.')[0] as string, 'base64url').toString())
    expect(header.typ).toBe('dc+sd-jwt')
    expect(header.kid).toBe('consent')
    // verifiable by the SD-JWT instance over our Signer
    const res = await sdjwtFor(signer).verify(paymentMandate)
    expect(res.payload.vct).toBe(VCT.PaymentClosed)
  })

  it('withholds the disclosable claims when presented with none, keeping the visible ones', async () => {
    const signer = new LocalSigner()
    const evidence = new MemoryEvidence()
    const merchantRepo = new MemoryMerchantRepo()
    const consentRepo = new MemoryConsentRepo()
    const cart = await createMerchantCart(merchantRepo, signer, evidence, 'j_min', [{ productId: 'item_a', qty: 1 }], USER)
    const proof = consent.buildWebOtpConsentProof(cartHash(cart), 'cs', 'sha256:otp')
    const { paymentMandate } = await consent.emitMandates(signer, evidence, consentRepo, 'j_min', cart, 'pm_visa_1234', proof)

    // The full form carries the disclosures.
    const full = decodePaymentMandate(paymentMandate) as Record<string, unknown>
    expect(full.payment_instrument).toBeDefined()
    expect(full.risk_data).toBeDefined()

    // Presented with no disclosures revealed — the data-minimized form.
    const minimized = await sdjwtFor(signer).present(paymentMandate, {})
    const v = await verifyPaymentMandate(signer, minimized, 'cp')
    expect(v.ok).toBe(true); // still a valid mandate
    expect(v.payment_instrument).toBeUndefined(); // disclosure withheld
    // The always-visible claims survive minimization — the verifier still needs them to scope.
    expect(v.checkoutHash).toBe(full.transaction_id)
    expect(v.payment_amount).toEqual(full.payment_amount)
    const decMin = decodePaymentMandate(minimized) as Record<string, unknown>
    expect(decMin.payment_instrument).toBeUndefined()
    expect(decMin.risk_data).toBeUndefined()
    expect(decMin.vct).toBe(VCT.PaymentClosed)
  })

  it('rejects the whole presentation when a disclosure has been forged', async () => {
    const signer = new LocalSigner()
    const now = Math.floor(Date.now() / 1000)
    const mandate = await issueRawMandate(
      signer,
      {
        vct: VCT.PaymentClosed,
        iss: 'consent',
        aud: ['cp', 'mpp'],
        iat: now,
        exp: now + 900,
        payment_instrument: { id: 'pm_real', type: 'card' },
      },
      ['payment_instrument'],
    )

    // Rewrite the disclosure blob ([salt, key, value]) so its digest no longer matches any entry in
    // `_sd`. The issuer JWT is untouched, so its signature still verifies on its own.
    const parts = mandate.split('~')
    const idx = parts.findIndex((p, i) => i > 0 && p && !p.includes('.'))
    const dis = JSON.parse(Buffer.from(parts[idx] as string, 'base64url').toString())
    dis[2] = { id: 'pm_HACKED', type: 'card' }
    parts[idx] = Buffer.from(JSON.stringify(dis)).toString('base64url')

    const v = await verifyPaymentMandate(signer, parts.join('~'), 'cp')
    // Fail-closed: an unreferenced disclosure invalidates the presentation outright, rather than
    // being quietly ignored. Either way the forged value is unreachable, but rejecting is the
    // stronger guarantee — a verifier can never act on a mandate that was tampered with at all.
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('Unreferenced disclosure')
    expect(v.payment_instrument).toBeUndefined()
  })

  it('tampering the issuer-JWT signature fails verification (fail-closed)', async () => {
    const { signer, paymentMandate: mandate } = await aPaymentMandate()
    const parts = mandate.split('~')
    const seg = (parts[0] as string).split('.')
    seg[2] = [...(seg[2] as string)].reverse().join(''); // corrupt the consent signature
    parts[0] = seg.join('.')
    const v = await verifyPaymentMandate(signer, parts.join('~'), 'cp')
    expect(v.ok).toBe(false)
  })

  it('produces different serializations for identical contents, both valid', async () => {
    const signer = new LocalSigner()
    const claims = {
      vct: VCT.PaymentClosed,
      iss: 'consent',
      aud: ['cp', 'mpp'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
      transaction_id: 'tx',
      payment_instrument: { id: 'pm', type: 'card' },
    }
    const a = await issueRawMandate(signer, { ...claims }, ['payment_instrument'])
    const b = await issueRawMandate(signer, { ...claims }, ['payment_instrument'])
    // RFC 9901 §9.1 requires salts of sufficient entropy, so the digests differ; ES256's random
    // nonce makes the signatures differ too.
    expect(a).not.toBe(b)
    expect(a.split('~')[0]).not.toBe(b.split('~')[0]); // issuer JWTs differ (digests + signature)
    expect(paymentMandateHash(a)).not.toBe(paymentMandateHash(b))
    // Both are nonetheless independently valid.
    expect((await verifyPaymentMandate(signer, a, 'cp')).ok).toBe(true)
    expect((await verifyPaymentMandate(signer, b, 'cp')).ok).toBe(true)
  })

  it('salts every disclosure with 128 bits, the RFC 9901 recommended minimum', async () => {
    const { paymentMandate } = await aPaymentMandate()

    // AP2 §Security and privacy makes this a MUST — *"a salt with sufficient entropy to prevent
    // guessing"*, citing RFC 9901, whose §9.3 recommends 128 bits minimum. The number is asserted
    // rather than the intent, because the library's default is 64: `@sd-jwt/core` asks for 16
    // *characters* and `@sd-jwt/crypto-nodejs` truncates 16 random bytes to 16 hex chars, discarding
    // half the entropy. A dependency bump that reinstates the default would be silent otherwise.
    const disclosures = paymentMandate
      .split('~')
      .slice(1)
      .filter((part) => part && !part.includes('.'))
    expect(disclosures.length).toBeGreaterThan(0)

    const salts = new Set<string>()
    for (const part of disclosures) {
      const [salt] = JSON.parse(Buffer.from(part, 'base64url').toString()) as [string, string, unknown]
      expect(salt).toMatch(/^[0-9a-f]+$/)
      expect(salt).toHaveLength(SALT_HEX_CHARS)
      expect(salt.length * 4).toBe(128)
      salts.add(salt)
    }
    // RFC 9901: *"A new salt MUST be chosen for each claim independently of other salts."*
    expect(salts.size).toBe(disclosures.length)
  })

  it('enforces aud and vct on the SD-JWT payload', async () => {
    const { signer, paymentMandate: mandate } = await aPaymentMandate()
    // The Merchant is never an audience of the Payment Mandate.
    const audV = await verifyPaymentMandate(signer, mandate, 'merchant')
    expect(audV.ok).toBe(false)
    expect(audV.reason).toContain('aud mismatch')
    // A future version fails the exact-match MUST.
    const wrongVct = await issueRawMandate(signer, {
      vct: 'mandate.payment.2', iss: 'consent', aud: ['cp', 'mpp'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900,
    })
    const vctV = await verifyPaymentMandate(signer, wrongVct, 'cp')
    expect(vctV.ok).toBe(false)
    expect(vctV.reason).toContain('vct mismatch')
  })
})
