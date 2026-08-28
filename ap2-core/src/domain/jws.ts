import { createHash } from 'node:crypto'
import { canonicalize } from './crypto'
import type { Signer } from './ports'

/**
 * Compact JWS over the `Signer` port — how the merchant-signed cart, the payment credential and both
 * receipts are serialized.
 *
 * This needs no special support from the signers: a `Signer` already signs arbitrary string bytes,
 * and the JWS signing input is exactly the string `b64url(header).b64url(payload)`. Feeding that in
 * yields a standards-compliant token that any off-the-shelf JOSE verifier can check against the
 * issuer's public key.
 *
 * Both signer implementations map to JOSE **ES256**: `LocalSigner` (Node ECDSA P-256) and
 * `KmsSigner` (KMS `ECDSA_SHA_256` on an `ECC_NIST_P256` key). Both are **non-deterministic** — the
 * random ECDSA nonce is what satisfies the AP2 Checkout-JWT `MUST` (*"a digital signature scheme
 * (e.g. ECDSA) and **not** a deterministic signature (e.g. Ed25519)"*), which exists to defeat
 * rainbow-table attacks on low-entropy carts.
 */

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

/**
 * The canonical AP2 artifact hash: `base64url(SHA-256(JCS(obj)))`. Used for `cart_hash` and every
 * other content-derived chain link.
 */
export function hashCanonicalB64url(obj: unknown): string {
  return createHash('sha256').update(canonicalize(obj)).digest('base64url')
}

/**
 * Hash of a raw string — the compact token itself, not its decoded contents.
 *
 * Per spec: *"The Payment Mandate is bound to a particular Checkout using the cryptographic hash of
 * the Checkout JWT."* Hashing the token rather than the cart pins the exact signature instance
 * (`iat`/`exp`/`jti`), so a re-signed identical cart is a different checkout.
 */
export function hashRawB64url(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url')
}

/** Maps a `Signer`'s algorithm onto a JOSE `alg` header value. */
export function jwsAlg(signerAlg: string): 'ES256' {
  if (signerAlg === 'ECDSA_SHA_256' || signerAlg === 'KMS_ECDSA_SHA_256') return 'ES256'
  throw new Error(`unsupported signer alg for JWS: ${signerAlg}`)
}

export interface JwtHeader {
  alg: string
  typ: string
  kid: string
}

export type JwtClaims = Record<string, unknown>

/** Signs a compact JWS. `entity` is the issuer key id (the `kid`); `typ` defaults to `"JWT"`. */
export async function signJws(
  signer: Signer,
  entity: string,
  claims: JwtClaims,
  typ = 'JWT',
): Promise<string> {
  const header: JwtHeader = { alg: jwsAlg(signer.alg), typ, kid: entity }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  // The Signer returns base64; the JWS wire format wants base64url.
  const sigBase64 = await signer.sign(entity, signingInput)
  const sigB64url = Buffer.from(sigBase64, 'base64').toString('base64url')
  return `${signingInput}.${sigB64url}`
}

export interface JwsVerifyResult {
  ok: boolean
  reason: string
  header?: JwtHeader
  claims?: JwtClaims
}

/**
 * Claim expectations enforced **after** the signature check — AP2: *"Verification steps for dispute
 * resolution must be followed precisely."* Checking claims first would mean trusting values nobody
 * has authenticated yet.
 */
export interface JwsExpectations {
  /** The exact JOSE `typ` expected (e.g. `AP2_TYPE.CartMandate`) — the type-confusion guard. */
  typ?: string
  /** The verifier's own identity, checked against the `aud` claim (a string or an array). */
  aud?: string
  /** Clock-skew tolerance in seconds for `exp`/`iat`. */
  skewSec?: number
}

/** Verifies a compact JWS against the issuer key named by its `kid` header, then enforces `expect`. */
export async function verifyJws(
  signer: Signer,
  jwt: string,
  expect?: JwsExpectations,
): Promise<JwsVerifyResult> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed JWT (expected 3 parts)' }

  const [h, p, s] = parts as [string, string, string]
  let header: JwtHeader
  let claims: JwtClaims
  try {
    header = JSON.parse(fromB64url(h).toString('utf8')) as JwtHeader
    claims = JSON.parse(fromB64url(p).toString('utf8')) as JwtClaims
  } catch {
    return { ok: false, reason: 'invalid JWT encoding' }
  }

  if (!header.kid) return { ok: false, reason: 'JWT header is missing kid', header, claims }

  const signingInput = `${h}.${p}`
  const sigBase64 = fromB64url(s).toString('base64')
  const ok = await signer.verify(header.kid, signingInput, sigBase64)
  if (!ok) return { ok: false, reason: 'invalid signature (key mismatch)', header, claims }

  // Claims are only trustworthy now that the signature is good.
  if (expect?.typ && header.typ !== expect.typ) {
    return {
      ok: false,
      reason: `typ mismatch: expected ${expect.typ}, got ${header.typ}`,
      header,
      claims,
    }
  }

  const skew = expect?.skewSec ?? 60
  const now = Math.floor(Date.now() / 1000)

  if (typeof claims.exp === 'number' && now > claims.exp + skew) {
    return { ok: false, reason: `token expired (exp=${claims.exp})`, header, claims }
  }
  if (typeof claims.iat === 'number' && claims.iat > now + skew) {
    return { ok: false, reason: 'iat is in the future', header, claims }
  }
  if (expect?.aud) {
    const aud = claims.aud
    const match = Array.isArray(aud) ? aud.includes(expect.aud) : aud === expect.aud
    if (!match) {
      return {
        ok: false,
        reason: `aud mismatch: token is not addressed to '${expect.aud}'`,
        header,
        claims,
      }
    }
  }

  return { ok: true, reason: 'signature, claims and audience check out', header, claims }
}

/** Decodes claims WITHOUT verifying — for read-only display and inspection only. */
export function decodeJwtClaims(jwt: string): JwtClaims | undefined {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(fromB64url(parts[1] as string).toString('utf8')) as JwtClaims
  } catch {
    return undefined
  }
}
