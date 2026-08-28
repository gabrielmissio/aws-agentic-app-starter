import { describe, expect, it } from 'vitest'
import { LocalSigner } from '../domain/adapters/local-signer'
import { signJws, verifyJws, decodeJwtClaims, hashCanonicalB64url, jwsAlg } from '../domain/jws'

describe('JWS over the Signer port', () => {
  it('signs and verifies a compact JWT (ES256 locally)', async () => {
    const signer = new LocalSigner(['merchant'])
    const jwt = await signJws(signer, 'merchant', { iss: 'merchant', cart_hash: 'abc' }, 'ap2.mandates.CartMandate')
    expect(jwt.split('.')).toHaveLength(3)

    const v = await verifyJws(signer, jwt)
    expect(v.ok).toBe(true)
    expect(v.header?.alg).toBe('ES256')
    expect(v.header?.kid).toBe('merchant')
    expect(v.header?.typ).toBe('ap2.mandates.CartMandate')
    expect(v.claims?.cart_hash).toBe('abc')
  })

  it('emits the signature as raw R‖S (JOSE ES256, 64 bytes — never DER)', async () => {
    const signer = new LocalSigner(['merchant'])
    const jwt = await signJws(signer, 'merchant', { cart_hash: 'abc' })
    const sig = Buffer.from(jwt.split('.')[2] as string, 'base64url')
    // DER would start with 0x30 and be ~70-72 bytes; raw P1363 is exactly 64.
    expect(sig.length).toBe(64)
  })

  it('produces a non-deterministic signature (random ECDSA nonce)', async () => {
    const signer = new LocalSigner(['merchant'])
    const claims = { iss: 'merchant', cart_hash: 'abc' }
    const a = await signJws(signer, 'merchant', claims)
    const b = await signJws(signer, 'merchant', claims)
    // Same key + same claims → identical signing input, but different signatures (non-deterministic).
    expect(a.split('.')[2]).not.toBe(b.split('.')[2])
    // Both still verify against the issuer key.
    expect((await verifyJws(signer, a)).ok).toBe(true)
    expect((await verifyJws(signer, b)).ok).toBe(true)
  })

  it('rejects a tampered payload', async () => {
    const signer = new LocalSigner(['merchant'])
    const jwt = await signJws(signer, 'merchant', { cart_hash: 'abc' })
    const [h, , s] = jwt.split('.')
    const forged = `${h}.${Buffer.from(JSON.stringify({ cart_hash: 'EVIL' })).toString('base64url')}.${s}`
    const v = await verifyJws(signer, forged)
    expect(v.ok).toBe(false)
  })

  it('rejects a signature from the wrong issuer key', async () => {
    const signer = new LocalSigner(['merchant', 'mpp'])
    const jwt = await signJws(signer, 'merchant', { x: 1 })
    // Re-label the kid to mpp without re-signing → must fail.
    const claims = jwt.split('.')[1]
    const sig = jwt.split('.')[2]
    const mppHeader = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'mpp' })).toString('base64url')
    const v = await verifyJws(signer, `${mppHeader}.${claims}.${sig}`)
    expect(v.ok).toBe(false)
  })

  it('decodeJwtClaims reads claims without verifying', async () => {
    const signer = new LocalSigner(['consent'])
    const jwt = await signJws(signer, 'consent', { transaction_data: ['h1', 'h2'], presence: 'HUMAN_PRESENT' })
    expect(decodeJwtClaims(jwt)?.presence).toBe('HUMAN_PRESENT')
  })

  it('hashCanonicalB64url is deterministic regardless of key order', () => {
    expect(hashCanonicalB64url({ a: 1, b: 2 })).toBe(hashCanonicalB64url({ b: 2, a: 1 }))
    expect(hashCanonicalB64url({ a: 1 })).not.toBe(hashCanonicalB64url({ a: 2 }))
  })

  it('maps signer alg → JOSE alg (both non-deterministic → ES256)', () => {
    expect(jwsAlg('ECDSA_SHA_256')).toBe('ES256')
    expect(jwsAlg('KMS_ECDSA_SHA_256')).toBe('ES256')
    expect(() => jwsAlg('Ed25519')).toThrow()
  })

  // Claims are validated only AFTER the signature checks out — before that, they are attacker input.
  describe('claim expectations (exp / iat / aud / typ)', () => {
    const now = () => Math.floor(Date.now() / 1000)

    it('rejects a token past its expiry, allowing for clock skew', async () => {
      const signer = new LocalSigner(['merchant'])
      const jwt = await signJws(signer, 'merchant', { exp: now() - 120 })
      expect((await verifyJws(signer, jwt)).ok).toBe(false); // exp é validado mesmo sem expect
      const jwtFresh = await signJws(signer, 'merchant', { exp: now() - 30 })
      expect((await verifyJws(signer, jwtFresh)).ok).toBe(true); // dentro do skew (60s)
    })

    it('rejects an iat in the future', async () => {
      const signer = new LocalSigner(['merchant'])
      const jwt = await signJws(signer, 'merchant', { iat: now() + 300 })
      const v = await verifyJws(signer, jwt)
      expect(v.ok).toBe(false)
      expect(v.reason).toContain('iat')
    })

    it('accepts a matching aud string or array, and rejects a verifier outside it', async () => {
      const signer = new LocalSigner(['merchant'])
      const single = await signJws(signer, 'merchant', { aud: 'cp' })
      expect((await verifyJws(signer, single, { aud: 'cp' })).ok).toBe(true)
      expect((await verifyJws(signer, single, { aud: 'mpp' })).ok).toBe(false)
      const multi = await signJws(signer, 'merchant', { aud: ['cp', 'mpp'] })
      expect((await verifyJws(signer, multi, { aud: 'mpp' })).ok).toBe(true)
      expect((await verifyJws(signer, multi, { aud: 'agent' })).ok).toBe(false)
    })

    it('requires the exact artifact typ, guarding against type confusion', async () => {
      const signer = new LocalSigner(['merchant'])
      const jwt = await signJws(signer, 'merchant', { x: 1 }, 'ap2.mandates.CartMandate')
      expect((await verifyJws(signer, jwt, { typ: 'ap2.mandates.CartMandate' })).ok).toBe(true)
      const v = await verifyJws(signer, jwt, { typ: 'ap2.mandates.PaymentMandate' })
      expect(v.ok).toBe(false)
      expect(v.reason).toContain('typ mismatch')
    })
  })
})
