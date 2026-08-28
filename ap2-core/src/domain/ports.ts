import type {
  CartMandate,
  CheckoutMandate,
  PaymentCredentialContents,
  PaymentMandate,
  PaymentReceipt,
  ReceiptStatus,
} from './types'

/**
 * The hexagonal ports. The domain depends on these interfaces and never on AWS.
 *
 * Implementations: `adapters/` (in-memory + a local ES256 signer, so the whole chain runs with no
 * cloud) and `../adapters-aws/` (KMS + DynamoDB).
 */

/**
 * Signs and verifies arbitrary bytes with an entity's key. `alg` is the *signer's* algorithm name,
 * which `jwsAlg()` maps onto the JOSE header — both land on ES256, but the distinction is what tells
 * `KmsSigner` it must bridge DER↔raw R‖S where `LocalSigner` need not.
 */
export interface Signer {
  /** `'ECDSA_SHA_256'` (local) or `'KMS_ECDSA_SHA_256'` — both JOSE ES256, both non-deterministic. */
  readonly alg: string
  /** Returns the signature, base64-encoded. */
  sign(entity: string, signingInput: string): Promise<string>
  verify(signedBy: string, signingInput: string, signatureB64: string): Promise<boolean>
}

/** One append-only entry in the auditable trail. */
export interface EvidenceInput {
  journeyId: string
  entity: string
  type: string
  artifactId?: string
  payloadHash?: string
  signatureB64?: string
  signedBy?: string
  verified?: boolean | null
  note?: string
  /** Artifact expiry (ISO) — e.g. a single-use credential's TTL. Surfaced by the Explorer. */
  expiresAt?: string
  /**
   * The full serialized artifact, retained for dispute resolution. For the SD-JWT-VC mandates that
   * means the string *with* its disclosures — without them the record cannot prove what the user saw.
   */
  artifact?: string
}

/** The append-only audit trail (Evidence Store). */
export interface EvidenceSink {
  record(e: EvidenceInput): Promise<void>
}

/**
 * Anti-replay: atomically consume a `(verifier, jti)` pair, returning false if already used. Scoped
 * *per verifier*: the same mandate legitimately reaches the CP and then the MPP, so a global check
 * would break the happy path — only a second presentation to the **same** verifier is a replay.
 */
export interface NonceRepo {
  consumeJti(verifier: string, jti: string, expiresAtUnix: number): Promise<boolean>
}

// ── Merchant Endpoint ───────────────────────────────────────────────────

/**
 * A catalog item. It carries the attributes people shop by — nutrition, ETA, courier cost — because
 * the agent hands them straight to the model, which is what answers "high in protein, under 20
 * minutes" without a bespoke query API.
 */
export interface CatalogItem {
  productId: string
  name: string
  unitPriceCents: number
  /** Short human description, also matched by the merchant's free-text search. */
  description: string
  /** Free-text facets for search and ranking, e.g. `['high-protein', 'healthy', 'chicken']`. */
  tags: string[]
  /** Protein per serving, grams. */
  proteinGrams: number
  /** Energy per serving, kcal. */
  caloriesKcal: number
  /** Typical time from order to doorstep, minutes. */
  etaMinutes: number
  /** Courier fee for this item, in minor units. One order pays one delivery fee. */
  deliveryFeeCents: number
}

/**
 * A signed cart with the journey it belongs to and the caller who opened it. `ownerRef` is what makes
 * a journey a tenant boundary: `journeyId` is caller-chosen and rides in URLs and logs, and the
 * lookup is idempotent, so without an owner a second caller naming an existing journey is handed the
 * caller's signed cart.
 */
export interface StoredCart {
  cart: CartMandate
  ownerRef: string
}

export interface MerchantRepo {
  searchProducts(query: string): Promise<CatalogItem[]>
  getProduct(productId: string): Promise<CatalogItem | undefined>
  putCart(cart: CartMandate, journeyId: string, ownerRef: string): Promise<void>
  getCart(cartId: string): Promise<CartMandate | undefined>
  /** Idempotency *and* ownership: the cart for this journey, plus who the journey belongs to. */
  getCartByJourney(journeyId: string): Promise<StoredCart | undefined>
}

// ── Consent & Mandates ──────────────────────────────────────────────────

/**
 * A pending or resolved consent session.
 *
 * The Cart Mandate is the *merchant's* artifact, held here so the consent surface can show the user
 * exactly what was signed; what the user authorizes are the two mandates emitted on approval.
 */
export interface ConsentSession {
  sessionId: string
  journeyId: string
  userId: string
  cartMandate: CartMandate
  paymentMethodRef: string
  /**
   * `PROCESSING` is the claim: one operation is between "decided to sign" and "signed", and no
   * other may enter. Without it two confirmations both read `PENDING`, both sign, and one cart ends
   * up with two mandate pairs — two credentials, two authorizations, one intention.
   */
  status: 'PENDING' | 'PROCESSING' | 'APPROVED' | 'REJECTED'
  paymentMandateId?: string
  /** Set once approved: the user-signed Checkout Mandate emitted alongside the Payment Mandate. */
  checkoutMandateId?: string
  /**
   * The operation id holding the current claim. Only it may finalize the session, so a lapsed lease
   * taken over by a later attempt cannot have the earlier one write mandates over the top of it.
   */
  lockOwner?: string
  /**
   * Unix seconds the claim lapses at. A process that dies mid-signature would otherwise wedge the
   * session in `PROCESSING` forever; past this instant another attempt may take it over.
   */
  lockExpiresAt?: number
  /** ISO 8601. After this the session can no longer be approved. */
  expiresAt: string
  /** DynamoDB TTL (unix seconds), set well past `expiresAt` so the record outlives its own window. */
  ttl?: number
}

/** Both mandate ids, written onto the session in the same conditional write that approves it. */
export interface EmittedMandateIds {
  paymentMandateId: string
  checkoutMandateId: string
}

export interface ConsentRepo {
  /**
   * Create-only. Returns false when a session with this id already exists — an unconditional put
   * would let a second `initiate_consent_session` reopen a resolved session over a different cart.
   */
  createSession(s: ConsentSession): Promise<boolean>
  getSession(sessionId: string): Promise<ConsentSession | undefined>
  /**
   * Claims a session for signing: `PENDING → PROCESSING`, or a `PROCESSING` session whose lease has
   * lapsed. Returns the claimed session, or `undefined` when another operation holds it.
   *
   * This is the transition that makes approval once-only under concurrency. Everything downstream —
   * single-use credentials, per-verifier jti consumption, MPP idempotency — guards a *second
   * payment*; only this guards a second *signature*.
   */
  claimSessionForDecision(
    sessionId: string,
    opId: string,
    leaseSeconds: number,
  ): Promise<ConsentSession | undefined>
  /**
   * `PROCESSING → APPROVED`, with the mandate ids, for the holder of `opId` alone. False means the
   * claim lapsed and someone else took it over — the caller's mandates are then orphaned rather
   * than canonical, which is the outcome to log, not to overwrite.
   */
  approveClaimedSession(
    sessionId: string,
    opId: string,
    ids: EmittedMandateIds,
  ): Promise<boolean>
  /** Releases a claim back to `PENDING`, for the holder of `opId` alone. Never throws on a loss. */
  releaseSessionClaim(sessionId: string, opId: string): Promise<void>
  /** `PENDING → REJECTED`, atomically. False when the session was no longer pending. */
  rejectSession(sessionId: string): Promise<boolean>
  putMandate(id: string, mandate: PaymentMandate): Promise<void>
  getMandate(id: string): Promise<PaymentMandate | undefined>
  putCheckoutMandate(id: string, mandate: CheckoutMandate): Promise<void>
  getCheckoutMandate(id: string): Promise<CheckoutMandate | undefined>
}

// ── Credential Provider ─────────────────────────────────────────────────

export interface RegisteredMethod {
  userId: string
  /** Opaque — this is the only payment identifier the agent or the browser ever sees. */
  paymentMethodRef: string
  displayName: string
  /** Sensitive: never leaves the CP except in a redeem instruction to the MPP. */
  pspCustomerRef: string
  /** Sensitive: same treatment as `pspCustomerRef`. */
  pspPaymentMethodRef: string
  status: 'ACTIVE' | 'INACTIVE'
}

export interface StoredCredential {
  contents: PaymentCredentialContents
  status: 'ISSUED' | 'REDEEMED'
  /**
   * The payer whose instrument ownership the CP verified at issuance.
   *
   * It lives here, in the CP's own store, rather than in the signed contents: the credential travels
   * to the Merchant, and a stable user id inside it would be a cross-journey identifier handed to
   * every merchant. Redeem reads it from here to resolve the instrument inside the right partition —
   * `payment_method_ref` is not unique across users, so a global lookup releases whichever payer's
   * PSP references the store happened to return first.
   */
  payerRef: string
  /**
   * The user-signed Payment Mandate the CP verified at issuance, stored alongside the credential and
   * returned to the MPP at redeem time. This is what keeps the Merchant from ever seeing it: the
   * mandate travels agent → CP, then CP → MPP server-to-server.
   */
  paymentMandate: PaymentMandate
  /**
   * Stable over (Payment Mandate, payer, target MPP) — the same request always derives the same key.
   *
   * It is what makes issuance idempotent. Without it a checkout that timed out after the credential
   * was minted asks for a second one, the CP finds the mandate's `jti` already consumed, and a retry
   * of a *successful* step is refused as a replay.
   */
  issuanceKey: string
  /**
   * The compact JWS as it was signed. Replayed verbatim so a retry receives the credential it was
   * already issued rather than a re-signature of the same contents.
   */
  cpAuthorization: string
}

export interface CredentialRepo {
  listMethods(userId: string): Promise<RegisteredMethod[]>
  /**
   * The only method lookup, at issuance and at redeem alike. There is deliberately no
   * `findMethodByRef(ref)`: `paymentMethodRef` is not unique across users, so a global lookup
   * resolves to an arbitrary payer's instrument. See `PaymentCredentialContents.payer_ref`.
   */
  getMethod(userId: string, paymentMethodRef: string): Promise<RegisteredMethod | undefined>
  putMethod(m: RegisteredMethod): Promise<void>
  putCredential(c: StoredCredential): Promise<void>
  getCredential(credentialId: string): Promise<StoredCredential | undefined>
  /**
   * The credential already issued under this issuance key, if any. Drives the idempotent-retry path
   * in `issueCredential`, which is why it is looked up *before* the mandate's nonce is consumed.
   */
  getCredentialByIssuanceKey(issuanceKey: string): Promise<StoredCredential | undefined>
  /** Atomic single-use transition. Returns false if the credential was already `REDEEMED`. */
  markRedeemed(credentialId: string): Promise<boolean>
}

// ── Merchant Payment Processor ──────────────────────────────────────────

export interface PaymentAttempt {
  paymentId: string
  journeyId: string
  status: ReceiptStatus
  receiptId: string
}

/**
 * What an idempotency key holds: an attempt still running, or the terminal receipt it produced.
 *
 * The two are distinguishable on purpose. A retry against `DONE` replays a signed answer; a retry
 * against `IN_PROGRESS` must be refused, because the first attempt may be inside the PSP call right
 * now and nobody can yet say what it produced.
 */
export type IdempotencyState =
  | { state: 'IN_PROGRESS' }
  | { state: 'DONE'; receipt: PaymentReceipt }

export interface MppRepo {
  putAttempt(a: PaymentAttempt): Promise<void>
  getAttempt(paymentId: string): Promise<PaymentAttempt | undefined>
  /**
   * Takes the key **before** any side effect — the redeem and the PSP call both happen under it.
   *
   * Returns `undefined` when this caller won the key, or what the current holder recorded when it
   * did not. Reserving afterwards, as a write of the finished receipt, leaves the whole redeem →
   * authorize window unguarded: two concurrent attempts both find the key free, both charge, and
   * only then does one of them lose the write.
   *
   * `leaseSeconds` bounds a holder that died mid-flight; past it another attempt may take the key
   * over. Keep it comfortably longer than a checkout, since a takeover while the first attempt is
   * still running is exactly what this exists to prevent.
   */
  reserveIdempotencyKey(
    key: string,
    opId: string,
    leaseSeconds: number,
  ): Promise<IdempotencyState | undefined>
  /**
   * Records the terminal receipt against a key this caller holds. False when the lease lapsed and
   * another attempt took it over — the receipt is then still valid and signed, but no longer the
   * canonical answer for the key.
   */
  completeIdempotencyKey(key: string, opId: string, receipt: PaymentReceipt): Promise<boolean>
}

/** Authorization at the payment service provider. PSPs work in integer minor units. */
export interface PspGateway {
  authorize(input: {
    amountCents: number
    currency: string
    pspCustomerRef: string
    pspPaymentMethodRef: string
    metadata: Record<string, string>
  }): Promise<{ status: 'AUTHORIZED' | 'DECLINED'; pspReference: string }>
}
