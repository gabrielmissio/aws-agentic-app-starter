import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms'
import { createLogger } from 'ap2-core/log'

const log = createLogger({ service: 'bff' })
const kms = new KMSClient({})

/**
 * One of the four signing actors whose signatures form the accountability chain.
 *
 * `kid` is the identity that appears in every JWS header the actor produces, so the public key
 * returned here is exactly what an outside party needs to verify those tokens themselves — which is
 * the point of exposing this at all: an audit trail nobody can independently check is a log, not
 * evidence.
 */
export interface Actor {
  kid: 'merchant' | 'consent' | 'cp' | 'mpp'
  role: string
  alg: string
  /** PEM-encoded public key, or null when the key ARN is not configured or unreadable. */
  publicKey: string | null
}

const ACTOR_KEYS: { kid: Actor['kid']; role: string; envVar: string }[] = [
  { kid: 'merchant', role: 'Merchant Endpoint', envVar: 'KMS_KEY_MERCHANT' },
  { kid: 'consent', role: 'Consent & Mandate Authority', envVar: 'KMS_KEY_CONSENT' },
  { kid: 'cp', role: 'Credential Provider', envVar: 'KMS_KEY_CP' },
  { kid: 'mpp', role: 'Merchant Payment Processor', envVar: 'KMS_KEY_MPP' },
]

/** DER-encoded SubjectPublicKeyInfo → PEM, the form every JOSE library accepts. */
function derToPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`
}

/**
 * Cached for the container's lifetime.
 *
 * KMS public keys do not rotate — an asymmetric key's material is fixed for its whole life — so
 * re-fetching on every request would be four network calls to learn something that cannot have
 * changed.
 */
let cached: Actor[] | undefined

export async function getActors(): Promise<Actor[]> {
  if (cached) return cached

  cached = await Promise.all(
    ACTOR_KEYS.map(async ({ kid, role, envVar }) => {
      const keyId = process.env[envVar]
      if (!keyId) return { kid, role, alg: 'ES256', publicKey: null }

      try {
        const res = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }))
        return {
          kid,
          role,
          alg: 'ES256 (KMS ECDSA_SHA_256)',
          publicKey: res.PublicKey ? derToPem(res.PublicKey) : null,
        }
      } catch (err) {
        // A missing key should degrade the Explorer's actors page, not fail it: the rest of the
        // trail is still readable and still verifiable by anyone who has the key another way.
        log.warn('actor public key unavailable', { kid, err })
        return { kid, role, alg: 'ES256 (KMS ECDSA_SHA_256)', publicKey: null }
      }
    }),
  )

  return cached
}
