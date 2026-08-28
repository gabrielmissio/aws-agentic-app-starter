import {
  KMSClient,
  SignCommand,
  VerifyCommand,
  KMSInvalidSignatureException,
} from '@aws-sdk/client-kms'
import type { Signer } from '../domain'
import { derToJoseEs256, joseEs256ToDer } from '../domain/crypto'
import { log } from '../log'

/**
 * The deployed signer: one asymmetric EC P-256 key per entity (merchant / consent / cp / mpp), plus
 * the BFF's `identity` key, which the entities only ever verify against.
 *
 * Signs the JWS signing input with `ECDSA_SHA_256` (`MessageType: 'RAW'`, so KMS applies SHA-256
 * itself). Key ARNs come from the environment, which is what makes the per-entity IAM scoping in
 * `Ap2EntitiesStack` meaningful: an entity holds `kms:Sign` on its own key and `kms:Verify` only on
 * the keys its role actually has to check.
 *
 * ECDSA rather than a deterministic scheme because AP2 requires a non-deterministic signature for
 * the Checkout JWT; it maps to JOSE **ES256**.
 *
 * KMS emits and expects ASN.1 **DER**, while a JOSE ES256 token carries the raw 64-byte R‖S. The
 * conversion in both directions (`domain/crypto.ts`) is what keeps these tokens verifiable by any
 * off-the-shelf JOSE verifier rather than only by this codebase.
 */
const KMS_SIGNING_ALGORITHM = 'ECDSA_SHA_256'

export class KmsSigner implements Signer {
  readonly alg = 'KMS_ECDSA_SHA_256'
  private kms: KMSClient

  constructor(
    private keyArns: Record<string, string>,
    region = process.env.AWS_REGION,
  ) {
    this.kms = new KMSClient({ region })
  }

  static fromEnv(): KmsSigner {
    const req = (k: string) => {
      const v = process.env[k]
      if (!v) throw new Error(`KmsSigner: missing environment variable ${k}`)
      return v
    }
    return new KmsSigner({
      merchant: req('KMS_KEY_MERCHANT'),
      consent: req('KMS_KEY_CONSENT'),
      cp: req('KMS_KEY_CP'),
      mpp: req('KMS_KEY_MPP'),
      // The BFF's identity key. Optional here because the MPP and the Evidence Store never resolve
      // a caller and are not granted anything on it — requiring the ARN would force every function
      // to carry a key it has no relationship with. A handler that needs it and lacks it fails at
      // verification, which is the correct direction to fail in.
      ...(process.env.KMS_KEY_IDENTITY ? { identity: process.env.KMS_KEY_IDENTITY } : {}),
    })
  }

  private arn(entity: string): string {
    const a = this.keyArns[entity]
    if (!a) throw new Error(`KmsSigner: no key configured for entity '${entity}'`)
    return a
  }

  async sign(entity: string, signingInput: string): Promise<string> {
    const out = await this.kms.send(
      new SignCommand({
        KeyId: this.arn(entity),
        Message: Buffer.from(signingInput),
        MessageType: 'RAW',
        SigningAlgorithm: KMS_SIGNING_ALGORITHM,
      }),
    )
    if (!out.Signature) throw new Error('KMS Sign returned no signature')
    return derToJoseEs256(Buffer.from(out.Signature)).toString('base64')
  }

  async verify(signedBy: string, signingInput: string, signatureB64: string): Promise<boolean> {
    try {
      const out = await this.kms.send(
        new VerifyCommand({
          KeyId: this.arn(signedBy),
          Message: Buffer.from(signingInput),
          MessageType: 'RAW',
          Signature: joseEs256ToDer(Buffer.from(signatureB64, 'base64')),
          SigningAlgorithm: KMS_SIGNING_ALGORITHM,
        }),
      )
      return out.SignatureValid === true
    } catch (e) {
      // Only a genuinely invalid signature is `false`. Anything else — AccessDenied from a missing
      // `kms:Verify` grant, a deleted key, the wrong region — is a configuration fault, and
      // swallowing it as `false` would report an IAM mistake to the user as "invalid mandate".
      if (e instanceof KMSInvalidSignatureException) return false
      log.error('kms verify error', { signedBy, keyArn: this.keyArns[signedBy], err: e })
      throw e
    }
  }
}
