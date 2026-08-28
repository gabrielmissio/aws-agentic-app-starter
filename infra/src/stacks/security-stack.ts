import * as cdk from 'aws-cdk-lib'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

export interface SecurityStackProps extends cdk.StackProps {
  projectName: string
  /**
   * Whether the signing keys and secrets survive a stack deletion.
   *
   * This is the sharpest instance of `RETAIN_DATA` in the app: destroying a signing key makes every
   * artifact it ever signed permanently unverifiable, so an audit trail that outlives the stack
   * becomes unreadable. Scheduled key deletion has a mandatory waiting period, which is a real cost
   * on a throwaway environment — hence the switch rather than a hardcoded choice.
   */
  retainData?: boolean
}

/**
 * The cryptographic root of the whole design: one KMS signing key per AP2 entity.
 *
 * Separate keys are the point. `Ap2EntitiesStack` grants each entity `kms:Sign` on its own key and
 * `kms:Verify` only on the keys its role must check, so "the Merchant signed this cart" is a claim
 * backed by IAM rather than by convention — a compromised Merchant still cannot forge a user's
 * consent, because it has no way to sign with the consent key.
 *
 * `ECC_NIST_P256` with `ECDSA_SHA_256` maps to JOSE **ES256**, which is non-deterministic: AP2
 * requires that for the Checkout JWT, because a deterministic signature over a low-entropy cart is
 * open to a rainbow-table attack.
 */
export class SecurityStack extends cdk.Stack {
  readonly merchantKey: kms.Key
  readonly consentKey: kms.Key
  readonly cpKey: kms.Key
  readonly mppKey: kms.Key
  /**
   * The BFF's caller-identity key — **not** an AP2 role key.
   *
   * The BFF signs a short-lived assertion of who the authenticated caller is; the Merchant, the
   * consent surface and the CP verify it and read the user out of it. Only the BFF is granted
   * `kms:Sign`, so an entity can check an identity but never mint one, and the agent is granted
   * nothing at all — it can forward the token it was handed and no other.
   */
  readonly identityKey: kms.Key
  /** Seals the checkout intents and hashes the one-time codes in the BFF. */
  readonly hmacSecret: secretsmanager.ISecret

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props)

    const { projectName, retainData = true } = props
    const removalPolicy = retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY

    const signingKey = (construct: string, alias: string, description: string) =>
      new kms.Key(this, construct, {
        alias: `${projectName}/${alias}`,
        description,
        keySpec: kms.KeySpec.ECC_NIST_P256,
        keyUsage: kms.KeyUsage.SIGN_VERIFY,
        removalPolicy,
      })

    this.merchantKey = signingKey(
      'MerchantKey',
      'merchant-signing-key',
      'AP2 Merchant Endpoint — signs the cart and the checkout receipt',
    )
    this.consentKey = signingKey(
      'ConsentKey',
      'consent-signing-key',
      'AP2 Consent & Mandates — signs the two user-authorized mandates',
    )
    this.cpKey = signingKey(
      'CpKey',
      'cp-signing-key',
      'AP2 Credential Provider — signs the scoped, single-use payment credential',
    )
    this.mppKey = signingKey(
      'MppKey',
      'mpp-signing-key',
      'AP2 Merchant Payment Processor — signs the payment receipt',
    )
    this.identityKey = signingKey(
      'IdentityKey',
      'caller-identity-key',
      'BFF caller identity — asserts which authenticated user an entity call is acting for',
    )

    // Generated on first deploy and read at Lambda cold start, so the plaintext never appears in an
    // environment variable or in the CloudFormation template — only the ARN does.
    this.hmacSecret = new secretsmanager.Secret(this, 'HmacSecret', {
      secretName: `${projectName}/ap2-hmac-secret`,
      description: 'Seals AP2 checkout intents and hashes one-time codes in the BFF',
      removalPolicy,
      generateSecretString: {
        passwordLength: 64,
        // Hex-safe: this value is only ever fed to createHmac, never parsed or embedded in a URL.
        excludePunctuation: true,
      },
    })
  }

  /**
   * Every **AP2 artifact** signing key — what the MPP needs `kms:Verify` on, since it re-checks the
   * whole chain. The identity key is deliberately absent: it signs no artifact, and the MPP resolves
   * no caller.
   */
  get signingKeys(): kms.Key[] {
    return [this.merchantKey, this.consentKey, this.cpKey, this.mppKey]
  }
}
