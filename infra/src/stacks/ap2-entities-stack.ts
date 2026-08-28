import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import type { DataStack } from './data-stack.js'
import type { SecurityStack } from './security-stack.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/** tsup output — one self-contained `.mjs` bundle per entity, built by `build:dependencies`. */
const AP2_CORE_DIST = path.resolve(here, '../../../ap2-core/dist')

export interface Ap2EntitiesStackProps extends cdk.StackProps {
  projectName: string
  data: DataStack
  security: SecurityStack
  /** MPP identities the CP will scope a credential to. */
  allowedMpps: string[]
  /** Mint a sandbox payment method for a user who has none, on first listing. */
  autoProvisionSandboxMethod: boolean
}

/**
 * The five AP2 entities, one Lambda each: Merchant Endpoint, Consent & Mandates, Credential
 * Provider, Merchant Payment Processor, Evidence Store.
 *
 * The separation is the security model. Each function signs with its own KMS key, verifies only the
 * keys its role must check, and reaches only the tables it owns, so compromising one entity forges
 * no other signature and reads no other state.
 *
 * Endpoints are Function URLs with `AuthType=AWS_IAM`, reachable only by a SigV4 identity granted
 * invoke on that specific function. The MPP is **not** exposed to the agent: in AP2 the Merchant
 * drives the MPP.
 *
 * The consent surface is **two** functions for the same reason — Function-URL IAM cannot scope a
 * principal to one operation, so `submit_consent_decision` lives on its own function, holds the only
 * `kms:Sign` grant on the Consent key, and is invokable only by the checkout Lambda that ran the
 * step-up. AP2 makes it a MUST: *"The Agent Provider MUST ensure that the Agent is not able to
 * access the Agent Provider signing key, or use it without the Trusted Surface."*
 */
export class Ap2EntitiesStack extends cdk.Stack {
  readonly merchantFn: lambda.Function
  readonly consentFn: lambda.Function
  /** The Mandate Authority — the only function holding `kms:Sign` on the Consent key. */
  readonly consentDecisionFn: lambda.Function
  readonly cpFn: lambda.Function
  readonly mppFn: lambda.Function
  readonly evidenceFn: lambda.Function
  /** The URLs the agent and the BFF call. Granted per-caller by the stacks that need them. */
  readonly merchantUrl: lambda.FunctionUrl
  readonly consentUrl: lambda.FunctionUrl
  /** Granted to the checkout Lambda alone. The agent's role never receives invoke on this. */
  readonly consentDecisionUrl: lambda.FunctionUrl
  readonly cpUrl: lambda.FunctionUrl

  constructor(scope: Construct, id: string, props: Ap2EntitiesStackProps) {
    super(scope, id, props)

    const { projectName, data, security, allowedMpps, autoProvisionSandboxMethod } = props

    const code = lambda.Code.fromAsset(AP2_CORE_DIST)
    const keyArns = {
      KMS_KEY_MERCHANT: security.merchantKey.keyArn,
      KMS_KEY_CONSENT: security.consentKey.keyArn,
      KMS_KEY_CP: security.cpKey.keyArn,
      KMS_KEY_MPP: security.mppKey.keyArn,
    }
    /**
     * The BFF's identity key, for the four entities that resolve a caller. Only the ARN and only
     * `kms:Verify` — an entity checks who is calling and can never assert it. The MPP and the
     * Evidence Store get neither: neither has a user to resolve.
     */
    const identityEnv = { KMS_KEY_IDENTITY: security.identityKey.keyArn }
    const evidenceEnv = { TABLE_EVIDENCE: data.evidence.tableName }

    /**
     * Explicit per entity: without one Lambda creates its own with "never expire" retention and
     * leaves it behind on `cdk destroy`.
     */
    const entityFunction = (
      construct: string,
      handlerFile: string,
      environment: Record<string, string>,
    ) => {
      const functionName = `${projectName}-ap2-${handlerFile}`
      return new lambda.Function(this, construct, {
        functionName,
        code,
        handler: `handlers/${handlerFile}.handler`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        // Inside the API Gateway integration ceiling, and generous for a KMS sign plus a couple of
        // DynamoDB round trips. Longer would only mean paying for a hung call.
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment,
        // The SigV4 client forwards the trace header, so one checkout is one trace across
        // merchant → consent → CP → MPP rather than four disconnected segments.
        tracing: lambda.Tracing.ACTIVE,
        logGroup: new logs.LogGroup(this, `${construct}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      })
    }

    /**
     * Granted through the *function's* identity policy, not the key's or table's resource policy.
     * `key.grant()` and `table.grantReadWriteData()` write the role into the resource's policy, which
     * lives in the security/data stack — making those depend on this one, which already depends on
     * them. Identity grants avoid the cycle, and the resources' default policies delegate to account
     * IAM, so they are equally effective.
     */
    const grantKms = (fn: lambda.Function, key: kms.IKey, actions: string[]) =>
      fn.addToRolePolicy(new iam.PolicyStatement({ actions, resources: [key.keyArn] }))

    const grantDdb = (fn: lambda.Function, table: dynamodb.ITable, actions: string[]) =>
      fn.addToRolePolicy(new iam.PolicyStatement({ actions, resources: [table.tableArn] }))

    const DDB_READ = [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:ConditionCheckItem',
      'dynamodb:DescribeTable',
    ]
    const DDB_WRITE = [
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:BatchWriteItem',
    ]
    const DDB_RW = [...DDB_READ, ...DDB_WRITE]
    /**
     * Append-only, and the grant says so: an entity adds to the record of what it did and cannot
     * amend or erase it. `DDB_WRITE` would hand every entity `UpdateItem` and `DeleteItem` on the
     * audit log — the one authority an audit log must withhold.
     */
    const DDB_APPEND = ['dynamodb:PutItem']
    const SIGN = ['kms:Sign', 'kms:GetPublicKey']
    const VERIFY = ['kms:Verify', 'kms:GetPublicKey']

    // ── Merchant Endpoint ───────────────────────────────────────────────
    this.merchantFn = entityFunction('MerchantFn', 'merchant', {
      ...keyArns,
      ...identityEnv,
      ...evidenceEnv,
      TABLE_CATALOG: data.catalog.tableName,
      TABLE_CARTS: data.carts.tableName,
    })
    grantKms(this.merchantFn, security.merchantKey, SIGN)
    // The Merchant verifies the user's Checkout Mandate itself before completing a checkout.
    grantKms(this.merchantFn, security.consentKey, VERIFY)
    // And verifies who is calling: a journey belongs to the caller who opened it.
    grantKms(this.merchantFn, security.identityKey, VERIFY)
    grantDdb(this.merchantFn, data.catalog, DDB_RW)
    grantDdb(this.merchantFn, data.carts, DDB_RW)
    grantDdb(this.merchantFn, data.evidence, DDB_APPEND)

    // ── Consent sessions (no signing key) ───────────────────────────────
    // The half the agent calls: open a session, read it, poll for the signed mandates. The key ARNs
    // are still in the environment because `KmsSigner.fromEnv` requires all four to construct — but
    // an ARN is not a permission, and this role is granted no KMS action whatsoever. Full control of
    // this function mints nothing.
    this.consentFn = entityFunction('ConsentFn', 'consent-mandates', {
      ...keyArns,
      ...identityEnv,
      ...evidenceEnv,
      TABLE_CONSENT_SESSIONS: data.consentSessions.tableName,
      TABLE_MANDATES: data.mandates.tableName,
    })
    // `initiate_consent_session` records the session's owner from the signed identity token.
    grantKms(this.consentFn, security.identityKey, VERIFY)
    grantDdb(this.consentFn, data.consentSessions, DDB_RW)
    // Reads mandates back for `poll_consent_status` and `get_mandate`; it writes none.
    grantDdb(this.consentFn, data.mandates, DDB_READ)

    // ── Mandate Authority (the only holder of kms:Sign on the Consent key) ──
    this.consentDecisionFn = entityFunction('ConsentDecisionFn', 'consent-decision', {
      ...keyArns,
      ...identityEnv,
      ...evidenceEnv,
      TABLE_CONSENT_SESSIONS: data.consentSessions.tableName,
      TABLE_MANDATES: data.mandates.tableName,
    })
    grantKms(this.consentDecisionFn, security.consentKey, SIGN)
    // It signs for a user, so it checks that the session it is signing over is that user's own.
    // IAM already limits this URL to the checkout Lambda; this is the check on *which* person the
    // signature is for, which no amount of trust in the caller can supply.
    grantKms(this.consentDecisionFn, security.identityKey, VERIFY)
    // Verifies the merchant's cart before signing the user's approval of it.
    grantKms(this.consentDecisionFn, security.merchantKey, VERIFY)
    grantDdb(this.consentDecisionFn, data.consentSessions, DDB_RW)
    grantDdb(this.consentDecisionFn, data.mandates, DDB_RW)
    grantDdb(this.consentDecisionFn, data.evidence, DDB_APPEND)

    // ── Credential Provider ─────────────────────────────────────────────
    this.cpFn = entityFunction('CpFn', 'credential-provider', {
      ...keyArns,
      ...identityEnv,
      ...evidenceEnv,
      TABLE_PM_REGISTRY: data.pmRegistry.tableName,
      TABLE_CREDENTIALS: data.credentials.tableName,
      AUTO_PROVISION_SANDBOX_METHOD: String(autoProvisionSandboxMethod),
    })
    // Signs credentials, and re-verifies its own at redeem time.
    grantKms(this.cpFn, security.cpKey, [...SIGN, 'kms:Verify'])
    grantKms(this.cpFn, security.merchantKey, VERIFY)
    grantKms(this.cpFn, security.consentKey, VERIFY)
    // Resolves whose payment methods it is listing, and whose credential it is issuing.
    grantKms(this.cpFn, security.identityKey, VERIFY)
    grantDdb(this.cpFn, data.pmRegistry, DDB_RW)
    grantDdb(this.cpFn, data.credentials, DDB_RW)
    grantDdb(this.cpFn, data.evidence, DDB_APPEND)

    // ── Merchant Payment Processor ──────────────────────────────────────
    this.mppFn = entityFunction('MppFn', 'mpp', {
      ...keyArns,
      ...evidenceEnv,
      TABLE_PAYMENT_ATTEMPTS: data.paymentAttempts.tableName,
      // The anti-replay markers live in the credentials table (`jti#<verifier>#<jti>`), so the MPP
      // needs it too — see DynamoNonceRepo for why that beats a table of its own.
      TABLE_CREDENTIALS: data.credentials.tableName,
      ALLOWED_MPPS: allowedMpps.join(','),
    })
    grantKms(this.mppFn, security.mppKey, SIGN)
    // The MPP is the last verifier before money moves, so it must be able to check every signature
    // in the chain — this is the one role that legitimately verifies all four keys.
    for (const key of security.signingKeys) grantKms(this.mppFn, key, VERIFY)
    grantDdb(this.mppFn, data.paymentAttempts, DDB_RW)
    grantDdb(this.mppFn, data.credentials, DDB_RW)
    grantDdb(this.mppFn, data.evidence, DDB_APPEND)

    // ── Evidence Store ──────────────────────────────────────────────────
    // The only function that holds no signing key: it records what happened, it does not attest.
    this.evidenceFn = entityFunction('EvidenceFn', 'evidence', { ...evidenceEnv })
    // Reads the trail back and appends to it — but, like every other entity, cannot rewrite it.
    grantDdb(this.evidenceFn, data.evidence, [...DDB_READ, ...DDB_APPEND])

    // ── Internal hops (IAM-authenticated Function URLs) ──────────────────
    // The CP is invoked by the MPP at redeem, preserving "the CP governs its own redeem".
    this.cpUrl = this.cpFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM })
    this.mppFn.addEnvironment('CP_ENDPOINT', this.cpUrl.url)
    this.cpUrl.grantInvokeUrl(this.mppFn)

    // The MPP is invoked by the Merchant, and by nothing else — the agent has no path to it at all.
    const mppUrl = this.mppFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM })
    this.merchantFn.addEnvironment('MPP_ENDPOINT', mppUrl.url)
    mppUrl.grantInvokeUrl(this.merchantFn)

    // ── Caller-facing tool URLs ─────────────────────────────────────────
    // Exposed as props so the agent and BFF stacks grant invoke on exactly the ones they use.
    this.merchantUrl = this.merchantFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })
    this.consentUrl = this.consentFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })
    this.consentDecisionUrl = this.consentDecisionFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })

    new cdk.CfnOutput(this, 'MerchantUrl', {
      value: this.merchantUrl.url,
      exportName: `${projectName}-Ap2MerchantUrl`,
    })
    new cdk.CfnOutput(this, 'ConsentUrl', {
      value: this.consentUrl.url,
      exportName: `${projectName}-Ap2ConsentUrl`,
    })
    new cdk.CfnOutput(this, 'ConsentDecisionUrl', {
      value: this.consentDecisionUrl.url,
      exportName: `${projectName}-Ap2ConsentDecisionUrl`,
    })
    new cdk.CfnOutput(this, 'CpUrl', {
      value: this.cpUrl.url,
      exportName: `${projectName}-Ap2CpUrl`,
    })
  }
}
