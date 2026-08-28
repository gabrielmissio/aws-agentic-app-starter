import { createHash } from 'node:crypto'
import jcsCanonicalize from 'canonicalize'

/**
 * **RFC 8785 (JCS — JSON Canonicalization Scheme)** serialization: stable and, crucially,
 * *interoperable across implementations* (UTF-16 code-unit key ordering, ECMAScript number
 * serialization, minimal JSON escaping).
 *
 * AP2 depends on independent parties agreeing on a hash (`cart_hash`, `transaction_id`, evidence).
 * A home-grown "sort the keys and stringify" is self-consistent but not standardized — it only
 * guarantees that *this* implementation agrees with itself. JCS is what lets a separate AP2
 * implementation re-hash the same object and arrive at the same digest.
 */
export function canonicalize(value: unknown): string {
  // The package returns undefined only for `undefined` itself; signed AP2 artifacts are objects.
  const out = jcsCanonicalize(value)
  if (out === undefined) throw new Error('canonicalize: cannot canonicalize `undefined`')
  return out
}

export function sha256Hex(data: string): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex')
}

/** Canonical hash of an artifact — what is effectively signed. */
export function hashArtifact(obj: unknown): string {
  return sha256Hex(canonicalize(obj))
}

/** Truncated hash of a sensitive value for the evidence trail (e.g. a phone number, a session token). */
export function hashSecret(value: string, bytes = 24): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex').slice(0, bytes)
}

/**
 * ECDSA P-256 signature encoding bridge between ASN.1 **DER** and **JOSE raw (IEEE P1363, R‖S)**.
 *
 * AWS KMS `ECDSA_SHA_256` emits DER and its `Verify` expects DER, but a JOSE **ES256** JWS carries
 * the raw 64-byte R‖S concatenation (each component 32 bytes, big-endian, zero-padded). Without this
 * conversion a KMS-signed token would be rejected by every off-the-shelf JOSE verifier.
 *
 * Node's own EC signer is told `dsaEncoding: 'ieee-p1363'`, so it needs no conversion — only the KMS
 * adapter crosses this boundary.
 */
const P256_COMPONENT_BYTES = 32

/** DER-encoded ECDSA signature → raw 64-byte R‖S (JOSE ES256). */
export function derToJoseEs256(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error('derToJoseEs256: not a DER SEQUENCE')
  // Short-form length only — an ES256 signature body is well under 128 bytes.
  let offset = 2

  const readInt = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error('derToJoseEs256: expected INTEGER')
    let intLen = der[offset + 1] as number
    let start = offset + 2
    // A 33-byte component carries a leading 0x00 sign byte (a DER INTEGER is signed) — drop it so it
    // fits in 32. Shorter components are left-padded with zeros below.
    if (der[start] === 0x00 && intLen > P256_COMPONENT_BYTES) {
      start += 1
      intLen -= 1
    }
    const buf = Buffer.alloc(P256_COMPONENT_BYTES)
    der.copy(buf, P256_COMPONENT_BYTES - intLen, start, start + intLen)
    offset = start + intLen
    return buf
  }

  const r = readInt()
  const s = readInt()
  return Buffer.concat([r, s])
}

/** Raw 64-byte R‖S (JOSE ES256) → DER-encoded ECDSA signature (what KMS `Verify` expects). */
export function joseEs256ToDer(raw: Buffer): Buffer {
  if (raw.length !== 2 * P256_COMPONENT_BYTES) {
    throw new Error('joseEs256ToDer: expected 64-byte R‖S')
  }

  const encodeInt = (b: Buffer): Buffer => {
    // Trim leading zeros, then re-add one if the high bit is set (a DER INTEGER is signed).
    let i = 0
    while (i < b.length - 1 && b[i] === 0x00) i++
    let v = b.subarray(i)
    if ((v[0] as number) & 0x80) v = Buffer.concat([Buffer.from([0x00]), v])
    return Buffer.concat([Buffer.from([0x02, v.length]), v])
  }

  const body = Buffer.concat([
    encodeInt(raw.subarray(0, P256_COMPONENT_BYTES)),
    encodeInt(raw.subarray(P256_COMPONENT_BYTES)),
  ])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}
