import { randomUUID } from 'node:crypto'
import { hashSecret } from '../crypto'
import { BlockedError } from '../sign'
import {
  buildStepUpConsentProof,
  type StepUpMethod,
  cartHash,
  checkoutJwtHash,
  checkoutMandateHash,
  issueCheckoutMandate,
  issuePaymentMandate,
  verifyCartMandate,
} from '../mandates'
import type { ConsentRepo, EvidenceSink, Signer } from '../ports'
import {
  centsFromAmount,
  VCT,
  type CartMandate,
  type CheckoutMandate,
  type ConsentProof,
  type PaymentMandate,
  type PaymentMandateContents,
} from '../types'

/**
 * Consent & Mandates — the trusted surface, and the only place that signs on the user's behalf.
 *
 * The `build*ConsentProof` helpers are the **channel boundary**: a channel adapter turns whatever
 * proof of presence it has into a `ConsentProof`, and the domain signs that attestation into both
 * mandates. The raw secret (an OTP code, a passkey assertion) never crosses this line — only a
 * non-reversible reference to it does. Adding a channel means adding a builder here and nothing else.
 */

/**
 * Web channel, with an OTP step-up — real human-present authorization.
 *
 * The OTP itself is verified by the BFF; the domain receives only the attestation, which then rides
 * *signed* inside both mandates.
 */
export function buildWebOtpConsentProof(
  merchantSignedCartHash: string,
  sessionToken: string,
  otpRef: string,
  method: StepUpMethod = 'OTP_SMS',
): ConsentProof {
  return buildStepUpConsentProof(merchantSignedCartHash, hashSecret(sessionToken), otpRef, method)
}

/**
 * Web channel, confirm-only — a low-risk transaction with no step-up.
 *
 * Identity is already established by the Cognito token, and the acceptance is an explicit tap on an
 * intent that is HMAC-sealed to one session, cart, amount and user. The absent `step_up` is not an
 * omission: it makes `risk_data.step_up_method` null, so the authorization method stays visible in
 * the accountability trail rather than being indistinguishable from a stepped-up approval.
 */
export function buildWebConfirmConsentProof(
  merchantSignedCartHash: string,
  sessionToken: string,
): ConsentProof {
  return {
    channel: 'WEB',
    approved_at: new Date().toISOString(),
    cart_canonical_hash: merchantSignedCartHash,
    session_token_hash: hashSecret(sessionToken),
  }
}

/** Both user-signed mandates, emitted in one approval and bound to the same cart and proof. */
export interface EmittedMandates {
  checkoutMandate: CheckoutMandate
  checkoutMandateId: string
  paymentMandate: PaymentMandate
  /** Storage id for the Payment Mandate — generated here; the spec contents carry no embedded id. */
  paymentMandateId: string
}

/**
 * Verifies the merchant-signed Cart Mandate and, in the **same** approval, emits both user-signed
 * mandates — per AP2 flows: *"the Trusted Surface signs both mandates"*.
 *
 * - **Checkout Mandate** wraps the merchant's `checkout_jwt`: direct, payment-independent evidence
 *   that the user approved *this* checkout, which the Merchant verifies itself.
 * - **Payment Mandate** carries the amount, payee and instrument reference, which the CP and MPP
 *   verify.
 *
 * Both are bound to the same `checkout_jwt` and the same consent proof, so neither can be paired
 * with a different cart later.
 */
export async function emitMandates(
  signer: Signer,
  evidence: EvidenceSink,
  repo: ConsentRepo,
  journeyId: string,
  cartMandate: CartMandate,
  paymentMethodRef: string,
  consentProof: ConsentProof,
): Promise<EmittedMandates> {
  // 1. The merchant's cart must be authentic before the user is asked to consent to it.
  const v = await verifyCartMandate(signer, cartMandate, 'consent')
  await evidence.record({
    journeyId,
    entity: 'consent',
    type: 'VERIFY_CART_MANDATE',
    payloadHash: v.hash,
    signedBy: 'merchant',
    verified: v.ok,
    note: v.reason,
  })
  if (!v.ok) {
    await evidence.record({
      journeyId,
      entity: 'consent',
      type: 'BLOCKED_TAMPERED_CART',
      verified: false,
      note: `invalid Cart Mandate: ${v.reason}`,
    })
    throw new BlockedError('TAMPERED', `invalid merchant Cart Mandate: ${v.reason}`)
  }

  const theCartHash = v.hash
  // The checkout_jwt hash is what permanently links the two mandates.
  const theCheckoutJwtHash = checkoutJwtHash(cartMandate)

  // 2. Integrity: the proof must have approved exactly this cart.
  if (consentProof.cart_canonical_hash !== theCartHash) {
    await evidence.record({
      journeyId,
      entity: 'consent',
      type: 'BLOCKED_OUT_OF_SCOPE',
      verified: false,
      note: 'the consent proof approved a different cart',
    })
    throw new BlockedError(
      'OUT_OF_SCOPE',
      'the consent proof does not match this Cart Mandate',
    )
  }

  // 3a. Checkout Mandate — the user authorizes THIS checkout.
  const checkoutMandate = await issueCheckoutMandate(signer, cartMandate, consentProof)
  const checkoutMandateId = 'ckm_' + randomUUID().slice(0, 8)
  await repo.putCheckoutMandate(checkoutMandateId, checkoutMandate)
  await evidence.record({
    journeyId,
    entity: 'consent',
    type: 'CHECKOUT_MANDATE',
    artifactId: checkoutMandateId,
    payloadHash: checkoutMandateHash(checkoutMandate),
    signedBy: 'consent',
    verified: null,
    // Retain the full serialized SD-JWT, disclosures included, for dispute resolution.
    artifact: checkoutMandate,
    note: `user authorized the checkout · checkout_hash ${theCheckoutJwtHash.slice(0, 12)}…`,
  })

  // 3b. Payment Mandate — integer minor units only; the W3C float stays in payment_request for the UI.
  const cartTotal = cartMandate.contents.payment_request.details.total.amount
  const nowUnix = Math.floor(Date.now() / 1000)
  const contents: PaymentMandateContents = {
    vct: VCT.PaymentClosed,
    transaction_id: theCheckoutJwtHash,
    payee: { id: cartMandate.contents.merchant.id, name: cartMandate.contents.merchant.name },
    payment_amount: { amount: centsFromAmount(cartTotal), currency: cartTotal.currency },
    // An opaque reference — no instrument data ever enters a mandate.
    payment_instrument: { id: paymentMethodRef, type: 'card' },
    // The spec's designated home for trusted-surface signals.
    risk_data: {
      channel: consentProof.channel,
      step_up_method: consentProof.step_up?.method ?? null,
      session_bound: !!consentProof.session_token_hash,
    },
    iat: nowUnix,
    exp: nowUnix + 900,
  }

  const paymentMandateId = 'pm_' + randomUUID().slice(0, 8)
  const paymentMandate = await issuePaymentMandate(
    signer,
    contents,
    'HUMAN_PRESENT',
    consentProof,
  )
  await repo.putMandate(paymentMandateId, paymentMandate)
  await evidence.record({
    journeyId,
    entity: 'consent',
    type: 'PAYMENT_MANDATE',
    artifactId: paymentMandateId,
    payloadHash: cartHash(cartMandate),
    signedBy: 'consent',
    verified: null,
    artifact: paymentMandate,
    note: `HUMAN_PRESENT · channel ${consentProof.channel} · step-up ${consentProof.step_up?.method ?? 'none'}`,
  })

  return { checkoutMandate, checkoutMandateId, paymentMandate, paymentMandateId }
}
