import { randomUUID } from 'node:crypto'
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc'
import { digest, generateSalt } from '@sd-jwt/crypto-nodejs'
import type { DisclosureFrame } from '@sd-jwt/types'
import { hashRawB64url, type JwtClaims } from './jws'
import type { Signer } from './ports'
import {
  VCT,
  type Amount,
  type CartMandate,
  type ConsentProof,
  type PaymentInstrumentRef,
  type PaymentMandateContents,
  type SpecMerchant,
} from './types'

/**
 * SD-JWT-VC serialization for the two **user-signed** mandates.
 *
 * The AP2 VC profile requires the Checkout and Payment Mandates to be SD-JWT-VCs (RFC 9901 salted
 * digests + selective disclosure), not the compact JWS used for the cart, credential and receipts. A
 * mandate collapses to the serialized string (`<issuer-jwt>~<disclosure>~…`) with no separate
 * `{ contents, authorization }` envelope — the disclosures are authoritative.
 *
 * Selective disclosure lets each verifier see only what its role needs: the CP and MPP read amount
 * and payee from visible claims, while the instrument reference, risk signals and consent proof ride
 * as withholdable disclosures.
 *
 * Both mandates are issued by the `consent` key. Holder binding (KB-JWT / `cnf`) is out of scope —
 * it needs a user-held key this stack does not have; see `docs/ap2-conformance.md`.
 */

const unix = (plusSec = 0) => Math.floor(Date.now() / 1000) + plusSec

/**
 * Disclosure salt length, in hex characters. 32 hex = **128 bits**.
 *
 * AP2 §Security and privacy: *"Digests in SD-JWTs MUST include a salt with sufficient entropy to
 * prevent guessing"*, mitigating rainbow-table attacks *"per RFC9901"*. RFC 9901 §9.3 puts a number
 * on it: *"The RECOMMENDED minimum length of the randomly generated portion of the salt is 128
 * bits."*
 *
 * This must be passed explicitly, because the default is half that. `@sd-jwt/core` calls
 * `saltGenerator(16)` meaning 16 *characters*, and `@sd-jwt/crypto-nodejs` implements it as
 * `randomBytes(length).toString('hex').substring(0, length)` — it draws 128 bits of randomness and
 * then throws half of it away in the `substring`. Taking the library's default silently yields
 * 64-bit salts. `sdjwt.test.ts` asserts the emitted length so a dependency bump cannot regress it.
 */
export const SALT_HEX_CHARS = 32

/**
 * Builds an `SDJwtVcInstance` over the `Signer` port.
 *
 * The library's signer callback wants a base64url signature over the signing-input string while
 * `Signer.sign` returns base64, so the two are converted at this boundary. Exported so tests can
 * issue arbitrary SD-JWTs when forging negative cases.
 */
export function sdjwtFor(signer: Signer): SDJwtVcInstance {
  return new SDJwtVcInstance({
    signer: async (data: string) =>
      Buffer.from(await signer.sign('consent', data), 'base64').toString('base64url'),
    verifier: async (data: string, sig: string) =>
      signer.verify('consent', data, Buffer.from(sig, 'base64url').toString('base64')),
    signAlg: 'ES256',
    hasher: digest,
    hashAlg: 'sha-256',
    // The library passes its own length here; ignore it and take the RFC-recommended one.
    saltGenerator: () => generateSalt(SALT_HEX_CHARS),
  })
}

/**
 * Low-level issuance: signs an SD-JWT (`kid: consent`) over arbitrary claims, turning the `disclose`
 * keys into disclosures. The two `issue*` helpers below build on this; tests use it directly to
 * forge negative cases (a wrong `vct`, a tampered amount) without re-deriving the frame types.
 */
export async function issueRawMandate(
  signer: Signer,
  claims: Record<string, unknown>,
  disclose: string[] = [],
): Promise<string> {
  const frame = { _sd: disclose } as DisclosureFrame<Record<string, unknown>>
  return sdjwtFor(signer).issue(claims as { vct: string } & Record<string, unknown>, frame, {
    header: { kid: 'consent' },
  })
}

// ── Chain-link hashes (stable across presentations) ─────────────────────

/** The issuer-signed JWT segment — invariant when disclosures are dropped, so its hash is a stable id. */
export const issuerJwtSegment = (sdjwt: string): string => sdjwt.split('~')[0] ?? sdjwt

/**
 * Canonical hash of a mandate: base64url SHA-256 of its **issuer-JWT segment**.
 *
 * Hashing the whole serialization would break the moment a holder withheld a disclosure, since the
 * CP→MPP `payment_mandate_hash` binding and the receipt `reference` must survive exactly that.
 */
export const checkoutMandateHash = (cm: string): string => hashRawB64url(issuerJwtSegment(cm))
export const paymentMandateHash = (pm: string): string => hashRawB64url(issuerJwtSegment(pm))

// ── Decode (no signature check — display and inspection only) ───────────

/**
 * Decodes an SD-JWT's claims WITHOUT verifying: the issuer-JWT payload (minus the `_sd`/`_sd_alg`
 * machinery) merged with whichever disclosures are present. For the Explorer and other read-only
 * surfaces. A trailing KB-JWT, if one is ever added, is skipped.
 */
export function decodeMandateClaims(sdjwt: string): JwtClaims | undefined {
  try {
    const [issuer, ...rest] = sdjwt.split('~')
    const payloadB64 = (issuer ?? '').split('.')[1]
    if (!payloadB64) return undefined

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const claims: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload)) {
      if (k !== '_sd' && k !== '_sd_alg') claims[k] = v
    }

    for (const part of rest) {
      // An empty trailer or a KB-JWT (which has dots) — neither is a disclosure.
      if (!part || part.includes('.')) continue
      try {
        const arr: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
        if (Array.isArray(arr) && arr.length >= 3) claims[arr[1] as string] = arr[2]
      } catch {
        // A malformed disclosure is dropped rather than failing the whole decode: this is a display
        // path, and the verifying paths never rely on it.
      }
    }

    return claims
  } catch {
    return undefined
  }
}

export const decodeCheckoutMandate = decodeMandateClaims
export const decodePaymentMandate = decodeMandateClaims

// ── Issue ───────────────────────────────────────────────────────────────

/**
 * AP2 `checkout_mandate.md` §Closed: the user authorizes THIS checkout by signing
 * `{ vct, checkout_jwt, checkout_hash }`.
 *
 * `checkout_jwt` and `consent_proof` are **disclosable**; `vct` and `checkout_hash` stay visible,
 * because `checkout_hash` is what the Merchant checks for freshness against its own latest cart.
 */
export async function issueCheckoutMandate(
  signer: Signer,
  cartMandate: CartMandate,
  proof: ConsentProof,
): Promise<string> {
  const checkout_jwt = cartMandate.merchant_authorization
  const checkout_hash = hashRawB64url(checkout_jwt)
  const now = unix()

  const claims = {
    vct: VCT.CheckoutClosed,
    checkout_jwt,
    checkout_hash,
    iss: 'consent',
    // Verified by the Merchant (its primary duty) and re-verified by the MPP (defense in depth).
    aud: ['merchant', 'mpp'],
    iat: now,
    exp: now + 900,
    jti: randomUUID(),
    nonce: randomUUID(),
    consent_proof: proof,
  }

  return issueRawMandate(signer, claims, ['checkout_jwt', 'consent_proof'])
}

/**
 * AP2 `payment_mandate.md` §Closed.
 *
 * As an SD-JWT-VC the spec contents collapse into the signed payload directly — there is no bridge
 * hash claim, because the SD-JWT signs every field itself. `payment_instrument`, `risk_data` and
 * `consent_proof` are **disclosable**; `vct`, `transaction_id`, `payee` and `payment_amount` stay
 * visible, since the CP and MPP need them to scope and chain the payment.
 */
export async function issuePaymentMandate(
  signer: Signer,
  contents: PaymentMandateContents,
  presence: 'HUMAN_PRESENT' | 'HUMAN_NOT_PRESENT',
  proof: ConsentProof,
): Promise<string> {
  const claims: Record<string, unknown> = {
    vct: contents.vct,
    transaction_id: contents.transaction_id,
    payee: contents.payee,
    payment_amount: contents.payment_amount,
    payment_instrument: contents.payment_instrument,
    ...(contents.risk_data ? { risk_data: contents.risk_data } : {}),
    iss: 'consent',
    // Verified by both the CP (at issuance) and the MPP (post-redeem) — hence an audience array.
    aud: ['cp', 'mpp'],
    iat: contents.iat,
    exp: contents.exp,
    jti: randomUUID(),
    nonce: randomUUID(),
    presence,
    consent_proof: proof,
  }

  const disclose = ['payment_instrument', 'risk_data', 'consent_proof'].filter((k) => k in claims)
  return issueRawMandate(signer, claims, disclose)
}

// ── Verify ──────────────────────────────────────────────────────────────

/** Outcome of verifying a Checkout Mandate. */
export interface CheckoutMandateCheck {
  ok: boolean
  reason: string
  hash: string
  checkoutHash?: string
  jti?: string
  expUnix?: number
}

/** Outcome of verifying a Payment Mandate, carrying the claims its verifiers scope against. */
export interface PaymentMandateCheck {
  ok: boolean
  reason: string
  hash: string
  checkoutHash?: string
  presence?: string
  jti?: string
  expUnix?: number
  payment_amount?: Amount
  payee?: SpecMerchant
  payment_instrument?: PaymentInstrumentRef
}

/** Verifies the issuer signature, the disclosure digests and (library-enforced) expiry. */
async function verifyToPayload(
  signer: Signer,
  sdjwt: string,
): Promise<
  { ok: true; payload: Record<string, unknown>; kid?: string } | { ok: false; reason: string }
> {
  const inst = sdjwtFor(signer)
  try {
    const res = await inst.verify(sdjwt)
    const dec = await inst.decode(sdjwt)
    return {
      ok: true,
      payload: res.payload as Record<string, unknown>,
      kid: dec.jwt?.header?.kid as string | undefined,
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'SD-JWT verification failed' }
  }
}

function audOk(aud: unknown, verifier: string): boolean {
  return Array.isArray(aud) ? aud.includes(verifier) : aud === verifier
}

/** Verifies a Checkout Mandate: signature, digests and expiry, then kid, vct, aud and the binding. */
export async function verifyCheckoutMandate(
  signer: Signer,
  cm: string,
  verifier: string,
): Promise<CheckoutMandateCheck> {
  const hash = checkoutMandateHash(cm)
  const v = await verifyToPayload(signer, cm)
  if (!v.ok) return { ok: false, reason: v.reason, hash }

  const { payload, kid } = v
  if (kid !== 'consent') {
    return { ok: false, reason: 'Checkout Mandate was not signed by the consent surface', hash }
  }
  if (payload.vct !== VCT.CheckoutClosed) {
    return {
      ok: false,
      reason: `vct mismatch: expected ${VCT.CheckoutClosed}, got ${String(payload.vct)}`,
      hash,
    }
  }
  if (!audOk(payload.aud, verifier)) {
    return { ok: false, reason: `aud mismatch: not addressed to '${verifier}'`, hash }
  }

  // When the checkout_jwt disclosure is present, checkout_hash MUST be its hash — that catches a
  // tampered wrapped token. The visible checkout_hash is what the Merchant checks for freshness.
  const checkoutJwt = payload.checkout_jwt as string | undefined
  const checkoutHash = payload.checkout_hash as string | undefined
  if (typeof checkoutJwt === 'string' && checkoutHash !== hashRawB64url(checkoutJwt)) {
    return { ok: false, reason: 'checkout_hash does not match the wrapped checkout_jwt', hash }
  }

  return {
    ok: true,
    reason: 'SD-JWT, claims, vct and checkout_hash all check out',
    hash,
    checkoutHash,
    jti: payload.jti as string | undefined,
    expUnix: payload.exp as number | undefined,
  }
}

/** Verifies a Payment Mandate: signature, digests and expiry, then kid, exact-match vct, and aud. */
export async function verifyPaymentMandate(
  signer: Signer,
  pm: string,
  verifier: string,
): Promise<PaymentMandateCheck> {
  const hash = paymentMandateHash(pm)
  const v = await verifyToPayload(signer, pm)
  if (!v.ok) return { ok: false, reason: v.reason, hash }

  const { payload, kid } = v
  if (kid !== 'consent') {
    return { ok: false, reason: 'Payment Mandate was not signed by the consent surface', hash }
  }
  // AP2 §Extensibility is a literal MUST: exact-match the vct including its version suffix.
  if (payload.vct !== VCT.PaymentClosed) {
    return {
      ok: false,
      reason: `vct mismatch: expected ${VCT.PaymentClosed}, got ${String(payload.vct)}`,
      hash,
    }
  }
  if (!audOk(payload.aud, verifier)) {
    return { ok: false, reason: `aud mismatch: not addressed to '${verifier}'`, hash }
  }

  return {
    ok: true,
    reason: 'SD-JWT, claims and vct all check out',
    hash,
    // The checkout link is the visible `transaction_id` claim, bound by the issuer signature.
    checkoutHash: payload.transaction_id as string | undefined,
    presence: payload.presence as string | undefined,
    jti: payload.jti as string | undefined,
    expUnix: payload.exp as number | undefined,
    payment_amount: payload.payment_amount as Amount | undefined,
    payee: payload.payee as SpecMerchant | undefined,
    payment_instrument: payload.payment_instrument as PaymentInstrumentRef | undefined,
  }
}
