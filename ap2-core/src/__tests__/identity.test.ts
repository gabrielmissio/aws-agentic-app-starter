import { describe, expect, it, vi } from 'vitest'
import { LocalSigner } from '../domain/adapters/local-signer'
import {
  IDENTITY_KID,
  IDENTITY_TYP,
  mintIdentityToken,
  verifyIdentityToken,
} from '../domain/identity'
import { signJws } from '../domain/jws'

/**
 * Caller identity as a signed artifact.
 *
 * An entity that learned who was calling from a `userId` field in the request body would let the
 * caller govern the Credential Provider's answer to *"list this user's payment methods"* — and the
 * agent is one of those callers. AP2 is explicit that this cannot be the arrangement: *"All LLMs and
 * Agents MUST be considered potential attackers."*
 *
 * These tests pin the properties that make the token evidence rather than an assertion.
 */
describe('the caller identity token', () => {
  it('round-trips the authenticated subject', async () => {
    const signer = new LocalSigner()
    const token = await mintIdentityToken(signer, 'cognito-sub-abc')

    for (const verifier of ['merchant', 'consent', 'cp'] as const) {
      const check = await verifyIdentityToken(signer, token, verifier)
      expect(check.ok).toBe(true)
      expect(check.sub).toBe('cognito-sub-abc')
    }
  })

  it('refuses a missing token rather than falling back to anything', async () => {
    const signer = new LocalSigner()
    const check = await verifyIdentityToken(signer, undefined, 'cp')
    expect(check.ok).toBe(false)
    expect(check.sub).toBeUndefined()
  })

  it('refuses a token signed by an AP2 role key', async () => {
    const signer = new LocalSigner()

    // The merchant holds a legitimate signing key and signs artifacts all day. Without the kid pin,
    // anything it signs in the right shape would authenticate any user it names.
    const forged = await signJws(
      signer,
      'merchant',
      {
        iss: 'bff',
        sub: 'victim-sub',
        aud: ['merchant', 'consent', 'cp'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      IDENTITY_TYP,
    )

    const check = await verifyIdentityToken(signer, forged, 'cp')
    expect(check.ok).toBe(false)
    expect(check.sub).toBeUndefined()
  })

  it('refuses a token whose typ is another artifact', async () => {
    const signer = new LocalSigner()
    const wrongTyp = await signJws(
      signer,
      IDENTITY_KID,
      {
        iss: 'bff',
        sub: 'someone',
        aud: ['cp'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      'ap2.mandates.CartMandate',
    )
    expect((await verifyIdentityToken(signer, wrongTyp, 'cp')).ok).toBe(false)
  })

  it('refuses a token addressed to a different verifier', async () => {
    const signer = new LocalSigner()
    const narrow = await signJws(
      signer,
      IDENTITY_KID,
      {
        iss: 'bff',
        sub: 'someone',
        aud: ['merchant'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      IDENTITY_TYP,
    )
    expect((await verifyIdentityToken(signer, narrow, 'merchant')).ok).toBe(true)
    expect((await verifyIdentityToken(signer, narrow, 'cp')).ok).toBe(false)
  })

  it('expires, so a token recovered from a log is almost always already dead', async () => {
    const signer = new LocalSigner()
    const token = await mintIdentityToken(signer, 'sub-ttl', 60)
    expect((await verifyIdentityToken(signer, token, 'cp')).ok).toBe(true)

    // Past the token's own lifetime *and* the verifier's clock-skew allowance.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 200_000)
      expect((await verifyIdentityToken(signer, token, 'cp')).ok).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a token whose claims were edited after signing', async () => {
    const signer = new LocalSigner()
    const token = await mintIdentityToken(signer, 'real-sub')

    const [h, p, s] = token.split('.') as [string, string, string]
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>
    claims.sub = 'victim-sub'
    const tampered = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`

    expect((await verifyIdentityToken(signer, tampered, 'cp')).ok).toBe(false)
  })
})
