/**
 * The canonical AP2 data model — the shapes the AP2 specification and its reference SDK define.
 *
 * Ported from the reference implementation at github.com/google-agentic-commerce/AP2
 * (`code/sdk/python/ap2/models/{mandate,payment_request}.py`).
 *
 * Two serializations coexist, matching the spec's own tables: the Cart Mandate, Payment Credential
 * and both Receipts are **compact JWS** (see `jws.ts`), while the two **user-signed** mandates
 * (Checkout, Payment) are **SD-JWT-VCs** (see `sdjwt.ts`). Every authorization carries the canonical
 * hashes that chain one artifact to the next.
 */

// ── W3C Payment Request API objects (AP2 reuses these) ──────────────────
// https://www.w3.org/TR/payment-request/

/**
 * A monetary amount as the W3C model defines it — a float.
 *
 * This type survives in exactly one place: inside `payment_request`, which is what the UI renders.
 * Every *signed* artifact carries the spec's integer-minor-unit `Amount` below instead, so no float
 * round-trip can ever change what a signature covers. Always derive the value from integer cents
 * via `amountFromCents`.
 */
export interface PaymentCurrencyAmount {
  /** ISO-4217, e.g. "BRL". */
  currency: string
  value: number
}

export interface PaymentItem {
  label: string
  amount: PaymentCurrencyAmount
  pending?: boolean
  /** Days; the AP2 default is 30. */
  refund_period?: number
}

export interface PaymentMethodData {
  supported_methods: string
  data?: Record<string, unknown>
}

export interface PaymentShippingOption {
  id: string
  label: string
  amount: PaymentCurrencyAmount
  selected?: boolean
}

export interface PaymentOptions {
  request_payer_name?: boolean
  request_payer_email?: boolean
  request_payer_phone?: boolean
  request_shipping?: boolean
  shipping_type?: string
}

export interface PaymentDetailsInit {
  id: string
  display_items: PaymentItem[]
  shipping_options?: PaymentShippingOption[]
  total: PaymentItem
}

export interface ContactAddress {
  recipient?: string
  country?: string
  address_line?: string[]
  city?: string
  postal_code?: string
}

export interface PaymentRequest {
  method_data: PaymentMethodData[]
  details: PaymentDetailsInit
  options?: PaymentOptions
  shipping_address?: ContactAddress
}

// ── AP2 spec common types (integer minor units) ─────────────────────────
// Source: AP2 specification §Common Types. These are the canonical shapes the user-signed mandates
// carry — distinct from the W3C floats above, which stay inside `payment_request` only.

/** Spec `Amount` — integer **minor units** (cents), NOT the W3C float `PaymentCurrencyAmount`. */
export interface Amount {
  /** Integer minor units. */
  amount: number
  /** ISO-4217. */
  currency: string
}

/** Spec `Merchant` — a real identity with a stable `id` (the W3C model only carried a free-text name). */
export interface SpecMerchant {
  id: string
  name: string
  website?: string
}

/** Spec `PaymentInstrument` reference — the `{ id, type }` extension point, e.g. `{ id: ref, type: 'card' }`. */
export interface PaymentInstrumentRef {
  id: string
  type: string
  description?: string
}

// ── AP2 mandates ────────────────────────────────────────────────────────

/** Type identifiers (the AP2 spec's data keys, used as the JOSE `typ` header). */
export const AP2_TYPE = {
  IntentMandate: 'ap2.mandates.IntentMandate',
  CartMandate: 'ap2.mandates.CartMandate',
  CheckoutMandate: 'ap2.mandates.CheckoutMandate',
  PaymentMandate: 'ap2.mandates.PaymentMandate',
  CheckoutReceipt: 'ap2.CheckoutReceipt',
  /** This repo's processing artifact, issued by the Credential Provider. */
  PaymentCredential: 'ap2.PaymentCredential',
  /** This repo's processing artifact, issued by the MPP. */
  PaymentReceipt: 'ap2.PaymentReceipt',
} as const

/**
 * Spec `vct` (Verifiable Credential Type) values for the two user-signed mandates.
 *
 * AP2 §Extensibility: *"Implementations MUST match the exact `vct` string, including the version
 * suffix."* Matching is literal string equality, so a future `mandate.payment.2` fails until it is
 * explicitly supported — that is the point, not an oversight. Distinct from the JOSE `typ` header in
 * `AP2_TYPE`: `vct` is a signed claim, `typ` is the envelope type.
 *
 * The `*Open` forms belong to the autonomous-mode framework, which this blueprint does not emit.
 */
export const VCT = {
  CheckoutClosed: 'mandate.checkout.1',
  CheckoutOpen: 'mandate.checkout.open.1',
  PaymentClosed: 'mandate.payment.1',
  PaymentOpen: 'mandate.payment.open.1',
} as const

/** The user's purchase intent (human-present fields). The human-not-present flow is out of scope. */
export interface IntentMandate {
  user_cart_confirmation_required: boolean
  natural_language_description: string
  merchants?: string[]
  skus?: string[]
  requires_refundability?: boolean
  /** ISO 8601. */
  intent_expiry: string
}

/** The detailed contents of a cart — signed by the merchant to produce a `CartMandate`. */
export interface CartContents {
  id: string
  user_cart_confirmation_required: boolean
  payment_request: PaymentRequest
  /** ISO 8601. */
  cart_expiry: string
  /** Spec `Merchant` identity — the Payment Mandate's `payee` derives from this. */
  merchant: SpecMerchant
  /** Display alias for the chat and Explorer surfaces (always equal to `merchant.name`). */
  merchant_name: string
}

/**
 * A cart whose contents the merchant has signed.
 *
 * `merchant_authorization` is a compact JWS whose `cart_hash` claim is
 * `hashCanonicalB64url(contents)` — verifying means checking the signature *and* recomputing that
 * hash, so a re-priced cart cannot masquerade as the one the user saw.
 */
export interface CartMandate {
  contents: CartContents
  /** Compact JWS. */
  merchant_authorization: string
}

/**
 * The step-up attestation embedded into the mandates' signed claims.
 *
 * This is the bridge between a channel's proof of presence (an SMS OTP today, a passkey later) and
 * the AP2 consent surface: the raw secret never reaches the domain, only this non-reversible record
 * that a specific human approved a specific cart at a specific time.
 */
export interface ConsentProof {
  channel: 'WEB' | 'WHATSAPP_FLOW'
  approved_at: string
  cart_canonical_hash: string
  session_token_hash?: string
  step_up?: { method: string; verified: boolean; ref?: string }
}

/**
 * The user-authorized **Checkout Mandate** (AP2 `checkout_mandate.md` §Closed).
 *
 * It wraps the merchant-signed checkout token and is signed by the user's consent surface, giving
 * the Merchant direct, payment-independent evidence that the user approved *this* cart.
 *
 * The mandate **is** the serialized SD-JWT-VC string (`<issuer-jwt>~<disclosure>~…`) — there is no
 * separate `{ contents, authorization }` envelope. `checkout_jwt` and `consent_proof` are
 * disclosable; `vct` and `checkout_hash` stay visible. `CheckoutMandateContents` below is the
 * decoded-claim shape used for display and schema validation.
 */
export type CheckoutMandate = string

export interface CheckoutMandateContents {
  vct: typeof VCT.CheckoutClosed
  /** The merchant-signed checkout token — literally `CartMandate.merchant_authorization`. */
  checkout_jwt: string
  /** base64url SHA-256 of `checkout_jwt` — the same hash function as every other chain link. */
  checkout_hash: string
  iat: number
  exp: number
}

/**
 * Closed Payment Mandate contents — AP2 `payment_mandate.md` §Closed.
 *
 * The storage id is generated separately (returned by `emitMandates`): the spec identifies a mandate
 * by its hash, not by an embedded id.
 */
export interface PaymentMandateContents {
  vct: typeof VCT.PaymentClosed
  /** base64url SHA-256 of the `checkout_jwt` — the link binding this mandate to one checkout. */
  transaction_id: string
  payee: SpecMerchant
  /** Integer minor units. */
  payment_amount: Amount
  /** `{ id: paymentMethodRef, type: 'card' }` — an opaque reference, never instrument data. */
  payment_instrument: PaymentInstrumentRef
  /** Trusted-surface risk signals (channel, step-up method, session binding). */
  risk_data?: Record<string, unknown>
  iat: number
  exp: number
}

/**
 * The user's instructions and authorization for payment.
 *
 * Like the Checkout Mandate, this **is** the serialized SD-JWT-VC string. `payment_instrument`,
 * `risk_data` and `consent_proof` are disclosable; `vct`, `transaction_id`, `payee` and
 * `payment_amount` stay visible, because the CP and MPP need them to scope and chain the payment.
 */
export type PaymentMandate = string

// ── This repo's processing artifacts (CP credential, MPP receipt) ───────
// Not AP2 mandates, but modeled the same way: contents plus a JWS authorization over their hash.

export interface PaymentCredentialContents {
  credential_id: string
  journey_id: string
  /**
   * No payer identifier. The credential reaches the Merchant, so carrying a stable user id here
   * would hand every merchant a cross-journey identifier for the shopper. The payer binding the CP
   * enforces at redeem lives in its own store instead — `StoredCredential.payerRef`.
   */
  cart_hash: string
  payment_mandate_hash: string
  payment_method_ref: string
  merchant_id: string
  /** Spec `Amount` — integer minor units. */
  amount: Amount
  authorized_mpp: string
  single_use: true
  expires_at: string
  created_at: string
}

export interface PaymentCredential {
  contents: PaymentCredentialContents
  /** Compact JWS. */
  cp_authorization: string
}

/**
 * AP2 Mandate-Receipt framework (Agent Authorization §Mandate Receipt).
 *
 * Every terminal outcome — success *or* rejection — is a verifier-signed receipt carrying `status`,
 * `iss`, `iat` and a `reference` (the base64url hash of the mandate it answers). Rejections also
 * carry a canonical `error` code plus an operator-facing `error_description`.
 */
export type ReceiptStatus = 'Success' | 'Error'

/** The four canonical AP2 Mandate-Receipt error codes. */
export type Ap2ErrorCode =
  | 'invalid_credential'
  | 'unresolved_constraint'
  | 'invalid_mandate'
  | 'mandates_not_supported'

/**
 * Maps this repo's internal `BlockedError` codes onto the four canonical AP2 error codes.
 *
 * Terminal verification failures (bad signature, broken chain, expiry, replay) are
 * `invalid_credential`; a structurally valid artifact that simply does not authorize *this* action
 * is `invalid_mandate`. `unresolved_constraint` and `mandates_not_supported` activate with the
 * autonomous-mode framework, which this blueprint does not implement.
 */
export const ERROR_CODE_MAP: Record<string, Ap2ErrorCode> = {
  TAMPERED: 'invalid_credential',
  INVALID_MANDATE: 'invalid_credential',
  INVALID_CREDENTIAL: 'invalid_credential',
  UNKNOWN_CREDENTIAL: 'invalid_credential',
  UNKNOWN_METHOD: 'invalid_credential',
  EXPIRED: 'invalid_credential',
  REPLAYED: 'invalid_credential',
  OUT_OF_SCOPE: 'invalid_mandate',
  DOUBLE_SPEND: 'invalid_mandate',
}

/** A `BlockedError.code` mapped to its canonical AP2 error code (defaults to `invalid_credential`). */
export function toAp2ErrorCode(blockedCode: string): Ap2ErrorCode {
  return ERROR_CODE_MAP[blockedCode] ?? 'invalid_credential'
}

export interface PaymentReceiptContents {
  status: ReceiptStatus
  iss: 'mpp'
  /** Unix seconds. */
  iat: number
  /** Spec binding: the base64url hash of the Payment Mandate this receipt answers. */
  reference: string
  /** The payment attempt (`pay_*`). */
  payment_id: string
  /** Present only on `Success`. */
  psp_confirmation_id?: string
  /** Present only on `Error`. */
  error?: Ap2ErrorCode
  /** Present only on `Error` — operator detail (the block's message, or the PSP decline reason). */
  error_description?: string
  /** User-facing receipt id (`rcpt_*`). The spec allows receipts to carry extra properties. */
  receipt_id: string
  journey_id: string
  /** Integer minor units. Absent when the chain was rejected before the credential was redeemed. */
  amount?: Amount
  cart_hash: string
  payment_credential_hash: string
  /** ISO 8601. */
  created_at: string
}

export interface PaymentReceipt {
  contents: PaymentReceiptContents
  /** Compact JWS. */
  mpp_authorization: string
}

/**
 * The Merchant-signed Checkout Receipt (AP2 §Checkout Receipt).
 *
 * Per spec: *"Once the Merchant has accepted or rejected the Checkout Mandate, it MUST return a
 * Checkout Receipt."* — so this is issued on rejection too, not only on a completed purchase.
 */
export interface CheckoutReceiptContents {
  status: ReceiptStatus
  iss: 'merchant'
  /** Unix seconds. */
  iat: number
  /** Spec binding: the base64url hash of the Checkout Mandate this receipt answers. */
  reference: string
  /** Present only on `Success`. */
  order_id?: string
  /** Present only on `Error`. */
  error?: Ap2ErrorCode
  /** Present only on `Error`. */
  error_description?: string
  /** `crcpt_*`. */
  receipt_id: string
  journey_id: string
  /** base64url SHA-256 of the `merchant_authorization` (the checkout JWT). */
  checkout_hash: string
  /** Hash of the MPP-signed Payment Receipt. Absent when the chain was rejected before the MPP ran. */
  payment_receipt_hash?: string
  merchant_id: string
  /** ISO 8601. */
  created_at: string
}

export interface CheckoutReceipt {
  contents: CheckoutReceiptContents
  /** Compact JWS, merchant-signed. */
  merchant_receipt_authorization: string
}

// ── Money helpers ───────────────────────────────────────────────────────
// Compute in integer minor units; render the W3C float only at the presentation boundary.

export function amountFromCents(cents: number, currency: string): PaymentCurrencyAmount {
  return { currency, value: cents / 100 }
}

export function centsFromAmount(a: PaymentCurrencyAmount): number {
  return Math.round(a.value * 100)
}

/**
 * The signing key ids — each maps to exactly one KMS key.
 *
 * The four AP2 roles sign artifacts. `identity` is not an AP2 role: it is the BFF's own key, used
 * only to assert who the authenticated caller is, and no entity holds `kms:Sign` on it. See
 * `domain/identity.ts`.
 */
export type SigningEntity = 'merchant' | 'consent' | 'cp' | 'mpp' | 'identity'
