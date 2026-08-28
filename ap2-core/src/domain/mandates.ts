import { randomUUID } from 'node:crypto'
import { signJws, verifyJws, hashCanonicalB64url, hashRawB64url } from './jws'
import type { Signer } from './ports'
import {
  AP2_TYPE,
  type CartContents,
  type CartMandate,
  type CheckoutReceipt,
  type CheckoutReceiptContents,
  type ConsentProof,
  type PaymentCredential,
  type PaymentCredentialContents,
  type PaymentReceipt,
  type PaymentReceiptContents,
} from './types'

/**
 * The canonical AP2 artifact layer: each artifact is `{ <contents>, <entity>_authorization }`, where
 * the authorization is a compact JWS whose claims carry the hashes that chain the artifacts.
 * Verifying always means both halves — check the signature AND recompute the content hash.
 *
 * The two **user-signed** mandates are SD-JWT-VCs and live in `sdjwt.ts`; they are re-exported here
 * so every call site has one import for "the AP2 artifact layer".
 */

export {
  issueCheckoutMandate,
  verifyCheckoutMandate,
  issuePaymentMandate,
  verifyPaymentMandate,
  checkoutMandateHash,
  paymentMandateHash,
  decodeCheckoutMandate,
  decodePaymentMandate,
  decodeMandateClaims,
  issueRawMandate,
  sdjwtFor,
  type CheckoutMandateCheck,
  type PaymentMandateCheck,
} from './sdjwt'

const unix = (plusSec = 0) => Math.floor(Date.now() / 1000) + plusSec
const jti = () => randomUUID()
const expFromIso = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

/** The result of verifying an artifact: an outcome for the evidence trail plus the recomputed hash. */
export interface ArtifactCheck {
  ok: boolean
  reason: string
  hash: string
}

// ── Canonical artifact hashes (the chain links) ─────────────────────────

export const cartHash = (cm: CartMandate): string => hashCanonicalB64url(cm.contents)

/**
 * AP2 §Specification: *"The Payment Mandate is bound to a particular Checkout using the
 * cryptographic hash of the Checkout JWT."*
 *
 * This hashes the *signed token*, not the `CartContents`, which pins the exact signature instance
 * (`iat`/`exp`/`jti`) — the spec's own phrasing is that the `checkout_jwt` hash "permanently links
 * the Mandates".
 */
export const checkoutJwtHash = (cm: CartMandate): string => hashRawB64url(cm.merchant_authorization)

export const credentialHash = (c: PaymentCredential): string => hashCanonicalB64url(c.contents)
export const receiptHash = (r: PaymentReceipt): string => hashCanonicalB64url(r.contents)
export const checkoutReceiptHash = (r: CheckoutReceipt): string => hashCanonicalB64url(r.contents)

// ── Cart Mandate (merchant-signed) ──────────────────────────────────────

export async function issueCartMandate(
  signer: Signer,
  contents: CartContents,
): Promise<CartMandate> {
  const cart_hash = hashCanonicalB64url(contents)
  const merchant_authorization = await signJws(
    signer,
    'merchant',
    {
      iss: 'merchant',
      sub: contents.id,
      // Every chain participant independently re-verifies the merchant's cart.
      aud: ['consent', 'cp', 'mpp', 'merchant'],
      iat: unix(),
      exp: expFromIso(contents.cart_expiry),
      jti: jti(),
      cart_hash,
    },
    AP2_TYPE.CartMandate,
  )
  return { contents, merchant_authorization }
}

export async function verifyCartMandate(
  signer: Signer,
  cm: CartMandate,
  verifier: string,
): Promise<ArtifactCheck> {
  const hash = hashCanonicalB64url(cm.contents)
  const v = await verifyJws(signer, cm.merchant_authorization, {
    typ: AP2_TYPE.CartMandate,
    aud: verifier,
  })
  if (!v.ok) return { ok: false, reason: v.reason, hash }
  if (v.header?.kid !== 'merchant') {
    return { ok: false, reason: 'Cart Mandate was not signed by the merchant', hash }
  }
  if (v.claims?.cart_hash !== hash) {
    return { ok: false, reason: 'cart_hash does not match the cart contents', hash }
  }
  return { ok: true, reason: 'signature, claims and cart_hash all check out', hash }
}

// ── Consent proofs (the channel boundary) ───────────────────────────────

/**
 * How the channel proved the user was present. Rides *signed* inside both mandates, so it has to
 * name what actually happened rather than what the flow is nominally for: a code read off the API
 * response in a sandbox is not evidence of possessing a phone, and a mandate that says `OTP_SMS`
 * when nothing was sent makes the audit trail assert something untrue.
 */
export type StepUpMethod = 'OTP_SMS' | 'OTP_SANDBOX_REVEALED'

/** A `ConsentProof` for a channel that performed a step-up (an OTP today, a passkey later). */
export function buildStepUpConsentProof(
  cartCanonicalHash: string,
  sessionTokenHash: string,
  otpRef: string,
  method: StepUpMethod,
): ConsentProof {
  return {
    channel: 'WEB',
    approved_at: new Date().toISOString(),
    cart_canonical_hash: cartCanonicalHash,
    session_token_hash: sessionTokenHash,
    step_up: { method, verified: true, ref: otpRef },
  }
}

// ── Payment Credential (CP-signed) ──────────────────────────────────────

export async function issueCredential(
  signer: Signer,
  contents: PaymentCredentialContents,
): Promise<PaymentCredential> {
  const credential_hash = hashCanonicalB64url(contents)
  const cp_authorization = await signJws(
    signer,
    'cp',
    {
      iss: 'cp',
      // Verified by the MPP, and by the CP itself at redeem time.
      aud: ['cp', 'mpp'],
      iat: unix(),
      exp: expFromIso(contents.expires_at),
      jti: jti(),
      credential_hash,
      cart_hash: contents.cart_hash,
      payment_mandate_hash: contents.payment_mandate_hash,
      authorized_mpp: contents.authorized_mpp,
    },
    AP2_TYPE.PaymentCredential,
  )
  return { contents, cp_authorization }
}

export async function verifyCredential(
  signer: Signer,
  c: PaymentCredential,
  verifier: string,
): Promise<ArtifactCheck> {
  const hash = hashCanonicalB64url(c.contents)
  const v = await verifyJws(signer, c.cp_authorization, {
    typ: AP2_TYPE.PaymentCredential,
    aud: verifier,
  })
  if (!v.ok) return { ok: false, reason: v.reason, hash }
  if (v.header?.kid !== 'cp') {
    return { ok: false, reason: 'credential was not signed by the credential provider', hash }
  }
  if (v.claims?.credential_hash !== hash) {
    return { ok: false, reason: 'credential_hash does not match the credential contents', hash }
  }
  return { ok: true, reason: 'signature, claims and credential_hash all check out', hash }
}

// ── Payment Receipt (MPP-signed) ────────────────────────────────────────

export async function issueReceipt(
  signer: Signer,
  contents: PaymentReceiptContents,
): Promise<PaymentReceipt> {
  const receipt_hash = hashCanonicalB64url(contents)
  const mpp_authorization = await signJws(
    signer,
    'mpp',
    {
      iss: 'mpp',
      // The receipt recipients the spec names: the merchant, the shopping agent and the CP.
      aud: ['merchant', 'agent', 'cp'],
      iat: unix(),
      jti: jti(),
      receipt_hash,
      // AP2 §Mandate Receipt: the signed result plus its binding to the mandate it answers.
      reference: contents.reference,
      status: contents.status,
    },
    AP2_TYPE.PaymentReceipt,
  )
  return { contents, mpp_authorization }
}

export async function verifyReceipt(
  signer: Signer,
  r: PaymentReceipt,
  verifier = 'merchant',
): Promise<ArtifactCheck> {
  const hash = hashCanonicalB64url(r.contents)
  const v = await verifyJws(signer, r.mpp_authorization, {
    typ: AP2_TYPE.PaymentReceipt,
    aud: verifier,
  })
  if (!v.ok) return { ok: false, reason: v.reason, hash }
  if (v.header?.kid !== 'mpp') {
    return { ok: false, reason: 'receipt was not signed by the MPP', hash }
  }
  if (v.claims?.receipt_hash !== hash) {
    return { ok: false, reason: 'receipt_hash does not match the receipt contents', hash }
  }
  return { ok: true, reason: 'signature, claims and receipt_hash all check out', hash }
}

// ── Checkout Receipt (merchant-signed) ──────────────────────────────────

export async function issueCheckoutReceipt(
  signer: Signer,
  contents: CheckoutReceiptContents,
): Promise<CheckoutReceipt> {
  const receipt_hash = hashCanonicalB64url(contents)
  const merchant_receipt_authorization = await signJws(
    signer,
    'merchant',
    {
      iss: 'merchant',
      aud: 'agent',
      iat: unix(),
      jti: jti(),
      receipt_hash,
      reference: contents.reference,
      status: contents.status,
    },
    AP2_TYPE.CheckoutReceipt,
  )
  return { contents, merchant_receipt_authorization }
}

export async function verifyCheckoutReceipt(
  signer: Signer,
  r: CheckoutReceipt,
  verifier = 'agent',
): Promise<ArtifactCheck> {
  const hash = hashCanonicalB64url(r.contents)
  const v = await verifyJws(signer, r.merchant_receipt_authorization, {
    typ: AP2_TYPE.CheckoutReceipt,
    aud: verifier,
  })
  if (!v.ok) return { ok: false, reason: v.reason, hash }
  if (v.header?.kid !== 'merchant') {
    return { ok: false, reason: 'checkout receipt was not signed by the merchant', hash }
  }
  if (v.claims?.receipt_hash !== hash) {
    return { ok: false, reason: 'receipt_hash does not match the receipt contents', hash }
  }
  return { ok: true, reason: 'signature, claims and receipt_hash all check out', hash }
}
