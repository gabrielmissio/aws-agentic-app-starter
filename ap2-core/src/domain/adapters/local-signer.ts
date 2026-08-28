import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto'
import type { Signer } from '../ports'

/**
 * A local ECDSA P-256 / ES256 signer — real cryptography, no AWS. One in-memory key pair per entity.
 * `KmsSigner` is the deployed counterpart and signs under the same JOSE `alg`.
 *
 * Why ECDSA and not Ed25519: AP2 requires the Checkout JWT to be signed with a **non-deterministic**
 * scheme (*"a digital signature scheme (e.g. ECDSA) and not a deterministic signature (e.g.
 * Ed25519)"*), because a deterministic signature over a low-entropy cart is vulnerable to a
 * rainbow-table attack. ECDSA's random per-signature nonce satisfies that MUST, and ES256 is the
 * spec's own example.
 *
 * `dsaEncoding: 'ieee-p1363'` makes Node emit and accept the raw 64-byte R‖S that JOSE ES256 carries,
 * so this adapter needs none of the DER conversion `KmsSigner` does.
 */
export class LocalSigner implements Signer {
  readonly alg = 'ECDSA_SHA_256'
  private keys = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>()

  constructor(entities: string[] = ['merchant', 'consent', 'cp', 'mpp', 'identity']) {
    for (const e of entities) {
      this.keys.set(e, generateKeyPairSync('ec', { namedCurve: 'P-256' }))
    }
  }

  async sign(entity: string, signingInput: string): Promise<string> {
    const k = this.keys.get(entity)
    if (!k) throw new Error(`LocalSigner: no key for entity '${entity}'`)
    const sig = nodeSign('sha256', Buffer.from(signingInput), {
      key: k.privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    return sig.toString('base64')
  }

  async verify(signedBy: string, signingInput: string, signatureB64: string): Promise<boolean> {
    const k = this.keys.get(signedBy)
    if (!k) return false
    try {
      return nodeVerify(
        'sha256',
        Buffer.from(signingInput),
        { key: k.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signatureB64, 'base64'),
      )
    } catch {
      return false
    }
  }
}
