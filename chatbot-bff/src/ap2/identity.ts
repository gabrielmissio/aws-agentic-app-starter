import { KmsSigner } from 'ap2-core/aws'
import { mintIdentityToken } from 'ap2-core/domain'

/**
 * Mints the caller identity tokens the AP2 entities verify.
 *
 * The BFF is the only component that can: it is the only one holding `kms:Sign` on the identity key,
 * and the only one that sits behind the Cognito authorizer that establishes who the caller is. The
 * entities hold `kms:Verify` and nothing more, so an entity can check an assertion but never make
 * one — the same asymmetry that keeps a compromised Merchant from forging the user's consent.
 *
 * Built lazily and cached per container: `KmsSigner` opens a KMS client, and rebuilding it per
 * request would re-resolve credentials on a path that runs on every chat turn.
 */
let signer: KmsSigner | undefined

function identitySigner(): KmsSigner {
  if (!signer) {
    const keyArn = process.env.KMS_KEY_IDENTITY
    if (!keyArn) throw new Error('KMS_KEY_IDENTITY is required to mint caller identity tokens')
    // Only the identity key: this signer must not be able to sign as an AP2 role even by accident.
    signer = new KmsSigner({ identity: keyArn })
  }
  return signer
}

/** A short-lived token asserting that `sub` is the authenticated caller. */
export function mintCallerToken(sub: string): Promise<string> {
  return mintIdentityToken(identitySigner(), sub)
}
