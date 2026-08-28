import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import { LocalSigner } from '../domain/adapters/local-signer'
import {
  MemoryConsentRepo,
  MemoryCredentialRepo,
  MemoryEvidence,
  MemoryMerchantRepo,
  MemoryMppRepo,
  MemoryNonceRepo,
  SimulatedPsp,
} from '../domain/adapters/memory'
import * as consent from '../domain/entities/consent-mandates'
import * as cp from '../domain/entities/credential-provider'
import {
  createMerchantCart,
  initiatePayment as merchantInitiatePayment,
  MERCHANT,
} from '../domain/entities/merchant'
import { initiatePayment as mppInitiatePayment, MPP_ID } from '../domain/entities/mpp'
import {
  cartHash,
  checkoutJwtHash,
  decodeCheckoutMandate,
  decodePaymentMandate,
  receiptHash,
  verifyCheckoutMandate,
  verifyCheckoutReceipt,
  verifyPaymentMandate,
} from '../domain/mandates'
import { decodeJwtClaims, hashCanonicalB64url } from '../domain/jws'
import {
  AP2_TYPE,
  VCT,
  type Amount,
  type PaymentCredential,
  type PaymentInstrumentRef,
  type SpecMerchant,
} from '../domain/types'

/**
 * AP2 conformance, machine-checked.
 *
 * Every canonical artifact a real run of the chain emits is validated against the JSON Schemas in
 * `src/schemas/ap2/`, which were authored from the official spec models. That is the difference
 * between "AP2-conformant" and "AP2-inspired": these assertions fail if an artifact drifts from the
 * shape the spec defines, rather than leaving the claim to a README nobody re-checks.
 */
const load = (p: string): object =>
  JSON.parse(readFileSync(new URL(`../schemas/ap2/${p}`, import.meta.url), 'utf8'))

const ajv = new Ajv2020({ strict: false })
for (const s of [
  'types/amount.json',
  'types/payment_item.json',
  'payment_request.json',
  'cart_mandate.json',
  'checkout_mandate.json',
  'payment_mandate.json',
]) {
  ajv.addSchema(load(s))
}

/** Validates `value`, returning the Ajv errors as a string so a failure names the offending field. */
function schemaCheck(schemaId: string, value: unknown): true | string {
  const validate = ajv.getSchema(schemaId)
  if (!validate) throw new Error(`schema not registered: ${schemaId}`)
  return validate(value) ? true : JSON.stringify(validate.errors)
}

const USER_ID = 'user_123'

function harness() {
  const signer = new LocalSigner()
  const evidence = new MemoryEvidence()
  const merchantRepo = new MemoryMerchantRepo()
  const consentRepo = new MemoryConsentRepo()
  const credRepo = new MemoryCredentialRepo()
  const mppRepo = new MemoryMppRepo()
  const nonces = new MemoryNonceRepo()
  const psp = new SimulatedPsp()
  const redeem = (cred: PaymentCredential, callingMpp: string) =>
    cp.redeem(credRepo, signer, evidence, cred.contents.journey_id, cred, callingMpp)

  return { signer, evidence, merchantRepo, consentRepo, credRepo, mppRepo, nonces, psp, redeem }
}

type Harness = ReturnType<typeof harness>

/** Drives a journey to the two user-signed mandates. */
async function buildMandates(h: Harness, journeyId = 'j_conf') {
  await h.credRepo.putMethod(cp.makeSandboxMethod(USER_ID))
  const [method] = await cp.listPaymentMethods(h.credRepo, USER_ID)
  const ref = (method as { paymentMethodRef: string }).paymentMethodRef

  const cart = await createMerchantCart(
    h.merchantRepo,
    h.signer,
    h.evidence,
    journeyId,
    [{ productId: 'item_a', qty: 2 }],
    USER_ID,
  )
  const proof = consent.buildWebOtpConsentProof(cartHash(cart), 'cs', 'sha256:otp')
  const { checkoutMandate, paymentMandate } = await consent.emitMandates(
    h.signer,
    h.evidence,
    h.consentRepo,
    journeyId,
    cart,
    ref,
    proof,
  )

  return { cart, checkoutMandate, paymentMandate, paymentMethodRef: ref, journeyId }
}

/** Continues from `buildMandates` through the credential to a settled payment. */
async function settle(h: Harness, m: Awaited<ReturnType<typeof buildMandates>>) {
  const credential = await cp.issueCredential(h.credRepo, h.signer, h.evidence, h.nonces, {
    journeyId: m.journeyId,
    userId: USER_ID,
    cartMandate: m.cart,
    paymentMandate: m.paymentMandate,
    paymentMethodRef: m.paymentMethodRef,
    targetMpp: MPP_ID,
    allowedMpps: [MPP_ID],
  })

  const payViaMpp = (input: Parameters<typeof mppInitiatePayment>[6]) =>
    mppInitiatePayment(h.signer, h.evidence, h.redeem, h.psp, h.mppRepo, h.nonces, input)

  const result = await merchantInitiatePayment(
    h.signer,
    h.evidence,
    h.merchantRepo,
    payViaMpp,
    { journeyId: m.journeyId, checkoutMandate: m.checkoutMandate, credential },
  )

  return { credential, ...result }
}

describe('emitted artifacts validate against the AP2 JSON Schemas', () => {
  it('the Cart Mandate, with its contents and W3C PaymentRequest', async () => {
    const { cart } = await buildMandates(harness())
    expect(schemaCheck('ap2:cart_mandate', cart)).toBe(true)
  })

  it('the Payment Mandate: a verifiable SD-JWT-VC whose decoded claims are schema-valid', async () => {
    const h = harness()
    const { paymentMandate } = await buildMandates(h)
    expect(typeof paymentMandate).toBe('string')
    expect((await verifyPaymentMandate(h.signer, paymentMandate, 'cp')).ok).toBe(true)
    expect(schemaCheck('ap2:payment_mandate', decodePaymentMandate(paymentMandate))).toBe(true)
  })

  it('the Checkout Mandate: a verifiable SD-JWT-VC whose decoded claims are schema-valid', async () => {
    const h = harness()
    const { checkoutMandate } = await buildMandates(h)
    expect(typeof checkoutMandate).toBe('string')
    expect((await verifyCheckoutMandate(h.signer, checkoutMandate, 'merchant')).ok).toBe(true)
    expect(schemaCheck('ap2:checkout_mandate', decodeCheckoutMandate(checkoutMandate))).toBe(true)
  })
})

describe('the signed claims bind the chain the way the spec requires', () => {
  it('the merchant authorization binds cart_hash to the cart contents, under the right typ', async () => {
    const { cart } = await buildMandates(harness())
    const claims = decodeJwtClaims(cart.merchant_authorization)
    expect(claims?.cart_hash).toBe(hashCanonicalB64url(cart.contents))

    const header = JSON.parse(
      Buffer.from(cart.merchant_authorization.split('.')[0] as string, 'base64url').toString(),
    )
    expect(header.typ).toBe(AP2_TYPE.CartMandate)
  })

  it('the Checkout Mandate wraps the merchant checkout token and pins it by hash', async () => {
    const { cart, checkoutMandate } = await buildMandates(harness())
    const claims = decodeCheckoutMandate(checkoutMandate)
    expect(claims?.vct).toBe(VCT.CheckoutClosed)
    expect(claims?.checkout_jwt).toBe(cart.merchant_authorization)
    expect(claims?.checkout_hash).toBe(checkoutJwtHash(cart))
  })

  it('transaction_id is the hash of the signed checkout token, not of the cart contents', async () => {
    const { cart, paymentMandate } = await buildMandates(harness())
    const transactionId = decodePaymentMandate(paymentMandate)?.transaction_id
    // Hashing the token pins the exact signature instance, so a re-signed identical cart is a
    // different checkout. Hashing the contents would not — which is why this distinction is tested.
    expect(transactionId).toBe(checkoutJwtHash(cart))
    expect(transactionId).not.toBe(cartHash(cart))
  })

  it('the Payment Mandate matches the spec closed shape', async () => {
    const { paymentMandate } = await buildMandates(harness())
    const claims = decodePaymentMandate(paymentMandate) as Record<string, unknown>

    expect(claims.vct).toBe(VCT.PaymentClosed)
    // The literal value including its version suffix — the exact-match MUST is on the whole string.
    expect(claims.vct).toBe('mandate.payment.1')

    const payee = claims.payee as SpecMerchant
    expect(payee.id).toBe(MERCHANT.id)
    expect(typeof payee.name).toBe('string')

    const amount = claims.payment_amount as Amount
    expect(Number.isInteger(amount.amount)).toBe(true)
    expect(amount.currency).toBe('BRL')

    const instrument = claims.payment_instrument as PaymentInstrumentRef
    expect(instrument).toMatchObject({ type: 'card' })
    expect(typeof instrument.id).toBe('string')

    // Verified by both the CP and the MPP, hence an audience array; the nonce is per-issuance.
    expect(claims.aud).toEqual(['cp', 'mpp'])
    expect(typeof claims.nonce).toBe('string')
  })

  it('the credential and receipt authorizations name their real audiences', async () => {
    const h = harness()
    const m = await buildMandates(h, 'j_aud_conf')
    const settled = await settle(h, m)

    // The credential is verified by the MPP, and re-verified by the CP itself at redeem.
    expect(decodeJwtClaims(settled.credential.cp_authorization)?.aud).toEqual(['cp', 'mpp'])
    // Receipt recipients per the spec flows: the merchant, the shopping agent and the CP.
    expect(decodeJwtClaims(settled.paymentReceipt.mpp_authorization)?.aud).toEqual([
      'merchant',
      'agent',
      'cp',
    ])
  })
})

describe('the Merchant answers every checkout with a signed receipt', () => {
  it('issues a Checkout Receipt bound to the checkout and linked to the Payment Receipt', async () => {
    const h = harness()
    const m = await buildMandates(h, 'j_receipts')
    const settled = await settle(h, m)

    expect(settled.paymentReceipt.contents.status).toBe('Success')
    expect(settled.checkoutReceipt.contents.status).toBe('Success')
    expect(settled.checkoutReceipt.contents.checkout_hash).toBe(checkoutJwtHash(m.cart))
    expect(settled.checkoutReceipt.contents.payment_receipt_hash).toBe(
      receiptHash(settled.paymentReceipt),
    )
    expect((await verifyCheckoutReceipt(h.signer, settled.checkoutReceipt)).ok).toBe(true)
  })

  it('signs one cart per journey, so a repeated request cannot re-price it', async () => {
    const h = harness()
    const args = [h.merchantRepo, h.signer, h.evidence, 'j_once'] as const
    const first = await createMerchantCart(...args, [{ productId: 'item_a', qty: 1 }], USER_ID)
    const second = await createMerchantCart(...args, [{ productId: 'item_b', qty: 2 }], USER_ID)

    expect(second.contents.id).toBe(first.contents.id)
    expect(second.merchant_authorization).toBe(first.merchant_authorization)
  })
})

describe('sensitive data never reaches the artifacts or the evidence trail', () => {
  it('keeps PSP identifiers out of the signed mandates and the audit trail', async () => {
    const h = harness()
    const m = await buildMandates(h, 'j_leak')
    const settled = await settle(h, m)

    // The only payment identifier that may travel is the opaque reference. The PSP customer and
    // instrument refs live inside the CP and are handed to the MPP only in a redeem instruction.
    const method = await h.credRepo.getMethod(USER_ID, m.paymentMethodRef)
    const secrets = [
      (method as { pspCustomerRef: string }).pspCustomerRef,
      (method as { pspPaymentMethodRef: string }).pspPaymentMethodRef,
    ]

    const surfaces = JSON.stringify({
      cart: m.cart,
      checkoutMandate: m.checkoutMandate,
      paymentMandate: m.paymentMandate,
      credential: settled.credential,
      paymentReceipt: settled.paymentReceipt,
      checkoutReceipt: settled.checkoutReceipt,
      evidence: h.evidence.entries,
    })

    for (const secret of secrets) {
      expect(secret).toBeTruthy()
      expect(surfaces).not.toContain(secret)
    }

    // The opaque reference, by contrast, is expected to be present — that is what the agent sees.
    expect(surfaces).toContain(m.paymentMethodRef)
  })

  it('records the full serialized mandates in the trail, disclosures included', async () => {
    const h = harness()
    const m = await buildMandates(h, 'j_retain')

    // Dispute resolution needs the presentation the user actually approved, not a hash of it.
    const checkoutStep = h.evidence.entries.find((e) => e.type === 'CHECKOUT_MANDATE')
    const paymentStep = h.evidence.entries.find((e) => e.type === 'PAYMENT_MANDATE')
    expect(checkoutStep?.artifact).toBe(m.checkoutMandate)
    expect(paymentStep?.artifact).toBe(m.paymentMandate)
    expect(paymentStep?.artifact).toContain('~')
  })
})
