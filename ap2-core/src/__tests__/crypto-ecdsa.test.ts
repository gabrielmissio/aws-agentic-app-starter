import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto'
import { derToJoseEs256, joseEs256ToDer } from '../domain/crypto'

/**
 * The ASN.1 DER ↔ JOSE raw (R‖S) bridge used by KmsSigner: AWS KMS speaks DER, a JOSE ES256 JWS carries
 * the 64-byte raw concatenation. We exercise both directions against Node's own EC signer (which can emit
 * either encoding) — this is what guarantees a KMS-produced token verifies in an off-the-shelf JOSE lib.
 */
describe('ECDSA P-256 DER ↔ JOSE (ES256) signature encoding', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const msg = Buffer.from('checkout-jwt-signing-input')

  it('DER → raw yields exactly 64 bytes and still verifies (P1363)', () => {
    // Node default for EC is DER — the same shape KMS Sign returns.
    const der = nodeSign('sha256', msg, { key: privateKey })
    const raw = derToJoseEs256(der)
    expect(raw.length).toBe(64)
    const ok = nodeVerify('sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)
    expect(ok).toBe(true)
  })

  it('raw → DER round-trips back to a KMS-verifiable signature', () => {
    const raw = nodeSign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    expect(raw.length).toBe(64)
    const der = joseEs256ToDer(raw)
    // DER ECDSA signatures are a SEQUENCE — the encoding KMS Verify expects.
    expect(der[0]).toBe(0x30)
    const ok = nodeVerify('sha256', msg, { key: publicKey }, der)
    expect(ok).toBe(true)
  })

  it('round-trips across many signatures (covers high-bit / short-component edge cases)', () => {
    for (let i = 0; i < 200; i++) {
      const der = nodeSign('sha256', Buffer.from(`m${i}`), { key: privateKey })
      const raw = derToJoseEs256(der)
      expect(raw.length).toBe(64)
      // raw → DER → verify is the KMS Verify path; both encodings must agree.
      expect(nodeVerify('sha256', Buffer.from(`m${i}`), { key: publicKey }, joseEs256ToDer(raw))).toBe(true)
    }
  })

  it('rejects malformed input', () => {
    expect(() => derToJoseEs256(Buffer.from([0x02, 0x01, 0x00]))).toThrow()
    expect(() => joseEs256ToDer(Buffer.alloc(63))).toThrow()
  })
})
