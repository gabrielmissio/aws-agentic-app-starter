import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

export interface DataStackProps extends cdk.StackProps {
  projectName: string
  /**
   * Whether these tables survive a stack deletion. Mirrors `RETAIN_DATA` everywhere else in this app:
   * the evidence log and the mandates are the audit trail for real (if sandboxed) payments, and
   * deleting them is not recoverable, while an orphaned on-demand table costs nothing at rest.
   */
  retainData?: boolean
}

/**
 * The AP2 state: one DynamoDB table per concern, all on-demand.
 *
 * A table per entity rather than one shared table with a discriminator, because the whole design
 * rests on each entity being independently scoped: `Ap2EntitiesStack` grants the Merchant no access
 * to the credential store and the CP no access to payment attempts. That separation is only
 * expressible if the resources are separate.
 */
export class DataStack extends cdk.Stack {
  readonly catalog: dynamodb.Table
  readonly carts: dynamodb.Table
  readonly consentSessions: dynamodb.Table
  readonly mandates: dynamodb.Table
  readonly pmRegistry: dynamodb.Table
  readonly credentials: dynamodb.Table
  readonly paymentAttempts: dynamodb.Table
  readonly evidence: dynamodb.Table
  /** Owned by the BFF, not by an entity: the web channel's checkout-approval state. */
  readonly intents: dynamodb.Table

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props)

    const { projectName, retainData = true } = props

    // On-demand throughout: this is bursty, low-volume traffic driven by human checkouts, and
    // provisioning capacity for it would be guessing at a number nobody can predict.
    const base = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      /**
       * Point-in-time recovery on every table, restoring to any second in the last 35 days.
       *
       * `RETAIN` protects against the stack being destroyed. It does nothing about the failure that
       * actually happens: a bad deploy, a wrong `DeleteItem`, a TTL attribute set to the wrong unit.
       * That matters more here than in a typical application, because the evidence log and the
       * mandates table *are* the product — a signature nobody can produce the artifact for proves
       * nothing, and the dispute procedure AP2 describes reads exactly those two tables.
       *
       * On-demand backups are billed for what is stored, and these tables are small; the cost is
       * negligible next to losing the trail. Enabled unconditionally rather than behind `retainData`,
       * because a throwaway demo that loses its history is just as unable to demonstrate anything.
       */
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    }
    const str = dynamodb.AttributeType.STRING

    // Physical names are prefixed with the project name so two deployments can share an account.
    this.catalog = new dynamodb.Table(this, 'Catalog', {
      tableName: `${projectName}-merchant-catalog`,
      partitionKey: { name: 'productId', type: str },
      ...base,
    })

    this.carts = new dynamodb.Table(this, 'Carts', {
      tableName: `${projectName}-merchant-carts`,
      partitionKey: { name: 'cartId', type: str },
      ...base,
    })

    // TTL set well past the 10-minute decision window: the session holds the signed cart the user
    // approved, which the Explorer and a dispute both read long afterwards.
    this.consentSessions = new dynamodb.Table(this, 'ConsentSessions', {
      tableName: `${projectName}-consent-sessions`,
      partitionKey: { name: 'sessionId', type: str },
      timeToLiveAttribute: 'ttl',
      ...base,
    })

    this.mandates = new dynamodb.Table(this, 'Mandates', {
      tableName: `${projectName}-mandates`,
      partitionKey: { name: 'mandateId', type: str },
      ...base,
    })

    this.pmRegistry = new dynamodb.Table(this, 'PmRegistry', {
      tableName: `${projectName}-payment-methods-registry`,
      partitionKey: { name: 'userId', type: str },
      sortKey: { name: 'paymentMethodRef', type: str },
      ...base,
    })

    // Also holds the anti-replay markers (`jti#<verifier>#<jti>`), which is what the TTL prunes —
    // a consumed nonce stops mattering exactly when the token that carried it expires.
    this.credentials = new dynamodb.Table(this, 'Credentials', {
      tableName: `${projectName}-payment-credentials`,
      partitionKey: { name: 'credentialId', type: str },
      timeToLiveAttribute: 'ttl',
      ...base,
    })

    this.paymentAttempts = new dynamodb.Table(this, 'PaymentAttempts', {
      tableName: `${projectName}-payment-attempts`,
      partitionKey: { name: 'paymentId', type: str },
      ...base,
    })

    // Append-only, partitioned by journey and sorted by time — the shape the trail is read in.
    this.evidence = new dynamodb.Table(this, 'Evidence', {
      tableName: `${projectName}-evidence-log`,
      partitionKey: { name: 'journeyId', type: str },
      sortKey: { name: 'sk', type: str },
      ...base,
    })

    // The BFF's checkout intents. Keyed by the consent session id, so an intent and the session it
    // gates cannot drift apart.
    this.intents = new dynamodb.Table(this, 'Intents', {
      tableName: `${projectName}-ap2-intents`,
      partitionKey: { name: 'intentId', type: str },
      timeToLiveAttribute: 'ttl',
      ...base,
    })

    // "The checkouts this person started, newest first" is the only other way this table is read,
    // and it is read on a page people open repeatedly. A filtered scan would bill for every intent
    // in the table to return one user's handful, and would get slower as the table grows.
    this.intents.addGlobalSecondaryIndex({
      indexName: 'byInitiator',
      partitionKey: { name: 'initiatedBy', type: str },
      sortKey: { name: 'requestedAt', type: str },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // "Who owns this journey?" — asked before any evidence trail is returned. Answering it from the
    // caller's own intent list would answer a different question ("does one of my intents mention
    // this journey?"), which is exactly the question a caller can arrange the answer to. A journey
    // is a tenant boundary, so it needs a lookup keyed by the journey itself.
    this.intents.addGlobalSecondaryIndex({
      indexName: 'byJourney',
      partitionKey: { name: 'journeyId', type: str },
      sortKey: { name: 'requestedAt', type: str },
      // Only what the ownership check reads. A full projection would duplicate every intent's cart
      // summary and seal into a second index for no reader.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['initiatedBy'],
    })

    new cdk.CfnOutput(this, 'EvidenceTableName', {
      value: this.evidence.tableName,
      exportName: `${projectName}-EvidenceTable`,
    })
  }
}
