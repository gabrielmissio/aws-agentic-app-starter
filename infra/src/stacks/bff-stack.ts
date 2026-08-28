import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as budgets from 'aws-cdk-lib/aws-budgets'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'
import { ADMIN_GROUP_NAME } from './auth-stack.js'
import type { Ap2EntitiesStack } from './ap2-entities-stack.js'
import type { DataStack } from './data-stack.js'
import type { SecurityStack } from './security-stack.js'
import {
  DEFAULT_AP2_RATE_LIMIT,
  DEFAULT_USER_RATE_LIMIT,
  type ApiThrottle,
  type UserRateLimit,
} from '../config.js'

export interface BffStackProps extends cdk.StackProps {
  projectName: string
  userPool: cognito.UserPool
  agentRuntimeArn: string
  /** Caps requests/second on the API stage. Every request that gets through costs Bedrock tokens. */
  throttle: ApiThrottle
  /**
   * Browser origin allowed to call this API — both on the CORS preflight and on every response
   * header the Lambdas set. Defaults to `*` (see `resolveAllowedOrigin` in `config.ts` for why).
   */
  allowedOrigin?: string
  /**
   * Caps how often one signed-in caller can hit `/chat`, independent of `throttle` above (which
   * caps the whole account). Defaults to `DEFAULT_USER_RATE_LIMIT`.
   */
  userRateLimit?: UserRateLimit
  /** Subscribed to alarms and to the budget. The alarms exist either way. */
  alertEmail?: string
  /** Monthly USD ceiling that triggers a budget notification. Omitted disables the budget. */
  monthlyBudgetUsd?: number
  /** The AP2 entities, for the Function URLs the checkout handler calls. */
  ap2: Ap2EntitiesStack
  /** The intents and evidence tables the checkout handler reads and writes. */
  data: DataStack
  /** The HMAC secret and the signing keys whose public halves the Explorer surfaces. */
  security: SecurityStack
  /**
   * How long a user has to authorize a proposed checkout, in minutes. Bounds the window in which a
   * signed cart, a sealed intent and a one-time code are all simultaneously valid.
   */
  intentTtlMinutes: number
  /** Cart total, in minor units, at or above which checkout requires a one-time code. */
  otpStepUpThresholdCents: number
  /**
   * Requests one signed-in caller gets on the money-moving routes per window. Separate from
   * `userRateLimit`, which meters `/chat`: a conversation must not be able to spend the checkout
   * budget, or the reverse.
   */
  ap2RateLimit?: UserRateLimit
  /** Sandbox only: return the real one-time code in the response so the UI can display it. */
  otpRevealInUi: boolean
  /**
   * Whether a WAF web ACL fronts the API stage. Opt-in via `WAF_ENABLED` in every profile — see
   * `resolveWafEnabled` for why it is a recommendation rather than a gate.
   */
  wafEnabled?: boolean
}

export class BffStack extends cdk.Stack {
  /** The /chat endpoint URL — consumed by FrontendStack for env-var injection */
  public readonly apiUrl: string

  constructor(scope: Construct, id: string, props: BffStackProps) {
    super(scope, id, props)

    const {
      projectName,
      userPool,
      agentRuntimeArn,
      throttle,
      allowedOrigin = '*',
      userRateLimit = DEFAULT_USER_RATE_LIMIT,
      alertEmail,
      monthlyBudgetUsd,
      ap2,
      data,
      security,
      intentTtlMinutes,
      otpStepUpThresholdCents,
      otpRevealInUi,
      ap2RateLimit = DEFAULT_AP2_RATE_LIMIT,
      wafEnabled = false,
    } = props

    // ── Per-caller rate limit table ─────────────────────────────────────
    // One item per (caller, window); see chatbot-bff/src/rate-limit.ts. Disposable counters, not
    // user data, so it is destroyed regardless of RETAIN_DATA — losing it just resets every quota.
    const rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName: `${projectName}-bff-rate-limit`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // ── Lambda function ────────────────────────────────────────────────
    const fn = new lambda.Function(this, 'ChatFunction', {
      functionName: `${projectName}-bff`,
      // Pre-built by `npm run build` in chatbot-bff/
      code: lambda.Code.fromAsset('../chatbot-bff', {
        exclude: ['node_modules', 'src', '*.ts', 'tsup.config.*', '.env*'],
      }),
      handler: 'dist/handler.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      architecture: lambda.Architecture.X86_64,
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
        AGENT_RUNTIME_ARN: agentRuntimeArn,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        RATE_LIMIT_TABLE_NAME: rateLimitTable.tableName,
        USER_RATE_LIMIT: String(userRateLimit.limit),
        USER_RATE_LIMIT_WINDOW_SECONDS: String(userRateLimit.windowSeconds),
        // Mints the caller identity token the agent forwards to the AP2 entities.
        KMS_KEY_IDENTITY: security.identityKey.keyArn,
      },
      logGroup: new logs.LogGroup(this, 'ChatFunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-bff`,
        // A week does not survive an incident found after a weekend.
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // ── IAM: allow invoking AgentCore ──────────────────────────────────
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [agentRuntimeArn, `${agentRuntimeArn}/runtime-endpoint/*`],
      }),
    )

    // ── IAM: rate-limit table — UpdateItem only, that's the only operation checkRateLimit needs ──
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [rateLimitTable.tableArn],
      }),
    )

    // ── IAM: the caller identity key — Sign, and only on that key ──────
    // The two BFF functions that speak for a user are the deployment's only `kms:Sign` holders here;
    // entities get `kms:Verify`, the agent nothing. That asymmetry is what makes an identity token
    // evidence rather than an assertion.
    const grantMintIdentity = (target: lambda.Function) =>
      target.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['kms:Sign'],
          resources: [security.identityKey.keyArn],
        }),
      )
    grantMintIdentity(fn)

    // ── API Gateway REST API ───────────────────────────────────────────
    // Access logs cover reach; the admin function's own audit lines cover intent. `dataTraceEnabled`
    // stays off: it writes request and response bodies to CloudWatch, leaking whole conversations.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${projectName}-chat-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    const api = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: `${projectName}-chat-api`,
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        // Without this the stage inherits the account default (10k rps), which is not a limit so
        // much as an invitation — every request that gets through costs Bedrock tokens.
        throttlingRateLimit: throttle.rateLimit,
        throttlingBurstLimit: throttle.burstLimit,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        // Identity and outcome, no payload.
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            at: apigateway.AccessLogField.contextRequestTime(),
            method: apigateway.AccessLogField.contextHttpMethod(),
            path: apigateway.AccessLogField.contextResourcePath(),
            status: apigateway.AccessLogField.contextStatus(),
            latencyMs: apigateway.AccessLogField.contextResponseLatency(),
            sourceIp: apigateway.AccessLogField.contextIdentitySourceIp(),
            actorSub: apigateway.AccessLogField.contextAuthorizerClaims('sub'),
          }),
        ),
      },
      defaultCorsPreflightOptions: {
        // Mirrors ALLOWED_ORIGIN on the Lambdas above — a specific origin here without a matching
        // env var (or vice versa) would pass preflight but fail on the actual response, or the
        // reverse. Both read from the same `allowedOrigin` prop so they can't drift.
        allowOrigins: allowedOrigin === '*' ? apigateway.Cors.ALL_ORIGINS : [allowedOrigin],
        // GET is here for the admin user listing; the chat route is POST only.
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    })

    // ── Cognito authorizer ─────────────────────────────────────────────
    /**
     * Declaring no `authorizationScopes` is what makes this an **ID token** authorizer: without
     * scopes API Gateway reads the credential as an identity token and rejects an access token
     * outright ([docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html)).
     * The frontend sends the ID token for that reason.
     *
     * Accepting the OAuth-correct access token instead would need a resource server with a custom
     * scope on every method, and SRP sign-in only ever issues `aws.cognito.signin.user.admin` — so
     * the scope would come from a pre-token-generation trigger, making every API call depend on a
     * Lambda succeeding. The replay exposure that OAuth rule guards against does not arise here
     * anyway: one pool, one client, one consumer. Use a Lambda authorizer if that stops being true.
     */
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: `${projectName}-cognito-authorizer`,
      identitySource: 'method.request.header.Authorization',
    })

    // ── Lambda integration with response streaming ─────────────────────
    // `streamifyResponse` requires InvokeWithResponseStream permission.
    fn.addPermission('ApiGwInvokeStream', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeWithResponseStream',
      sourceArn: api.arnForExecuteApi('POST', '/chat', 'prod'),
    })

    const integration = new apigateway.LambdaIntegration(fn, {
      proxy: true,
      responseTransferMode: apigateway.ResponseTransferMode.STREAM, // IMPORTANT: Sets stream mode
    })

    // ── POST /chat ─────────────────────────────────────────────────────
    const chatResource = api.root.addResource('chat')
    chatResource.addMethod('POST', integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    })

    // ── Admin function ─────────────────────────────────────────────────
    // A second function, not more routes on the chat one: this role carries
    // `cognito-idp:AdminCreate*`, and the function relaying model output must not.
    const adminFn = new lambda.Function(this, 'AdminFunction', {
      functionName: `${projectName}-bff-admin`,
      code: lambda.Code.fromAsset('../chatbot-bff', {
        exclude: ['node_modules', 'src', '*.ts', 'tsup.config.*', '.env*'],
      }),
      handler: 'dist/admin-handler.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // API Gateway's REST integration ceiling is a hard 29s for a buffered response, so a longer
      // Lambda timeout only keeps billing after the gateway has returned 504. The chat function
      // stays at 60s because it streams, which is not held to the buffered cap.
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
      architecture: lambda.Architecture.X86_64,
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        ADMIN_GROUP_NAME,
      },
      logGroup: new logs.LogGroup(this, 'AdminFunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-bff-admin`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Scoped to this pool, and to the specific actions the two routes need — no blanket
    // `cognito-idp:*`, which would also grant deleting users and rewriting the pool's policies.
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:ListUsersInGroup',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminAddUserToGroup',
        ],
        resources: [userPool.userPoolArn],
      }),
    )

    // ── /admin/users ───────────────────────────────────────────────────
    // Same Cognito authorizer as /chat, so the gateway still validates the token's signature,
    // expiry and issuer. Membership in the admin group is enforced inside the function, which is
    // safe to centralize there because this function serves admin routes and nothing else.
    const adminIntegration = new apigateway.LambdaIntegration(adminFn, { proxy: true })
    const adminUsers = api.root.addResource('admin').addResource('users')

    for (const method of ['GET', 'POST']) {
      adminUsers.addMethod(method, adminIntegration, {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      })
    }

    // ── AP2 checkout function ──────────────────────────────────────────
    // A third function, same reason sharpened: this is the only role holding the HMAC secret,
    // `sns:Publish` and invoke rights on the AP2 entities. Keeping those off the chat role is what
    // makes "the agent cannot move money" structural rather than a matter of prompt discipline.
    const ap2Fn = new lambda.Function(this, 'Ap2Function', {
      functionName: `${projectName}-bff-ap2`,
      code: lambda.Code.fromAsset('../chatbot-bff', {
        exclude: ['node_modules', 'src', '*.ts', 'tsup.config.*', '.env*'],
      }),
      handler: 'dist/ap2-handler.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Same buffered-integration ceiling as the admin function. `/confirm` is the long pole:
      // two mandates, a credential, and the MPP's re-verification — four KMS-signing hops.
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      architecture: lambda.Architecture.X86_64,
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        MERCHANT_URL: ap2.merchantUrl.url,
        CONSENT_URL: ap2.consentUrl.url,
        CONSENT_DECISION_URL: ap2.consentDecisionUrl.url,
        CP_URL: ap2.cpUrl.url,
        INTENTS_TABLE: data.intents.tableName,
        EVIDENCE_TABLE: data.evidence.tableName,
        // Only the ARN — the plaintext is fetched at cold start and never enters the template.
        HMAC_SECRET_ARN: security.hmacSecret.secretArn,
        INTENT_TTL_MIN: String(intentTtlMinutes),
        OTP_STEPUP_THRESHOLD_CENTS: String(otpStepUpThresholdCents),
        OTP_REVEAL_IN_UI: String(otpRevealInUi),
        // Metered under an `ap2#` key prefix, so this quota is independent of the chat one.
        RATE_LIMIT_TABLE_NAME: rateLimitTable.tableName,
        AP2_RATE_LIMIT: String(ap2RateLimit.limit),
        AP2_RATE_LIMIT_WINDOW_SECONDS: String(ap2RateLimit.windowSeconds),
        // Read to surface each actor's public key, so an outside party can verify the chain itself.
        KMS_KEY_MERCHANT: security.merchantKey.keyArn,
        KMS_KEY_CONSENT: security.consentKey.keyArn,
        KMS_KEY_CP: security.cpKey.keyArn,
        KMS_KEY_MPP: security.mppKey.keyArn,
        // Signed, not read: this function mints the caller identity the entities verify.
        KMS_KEY_IDENTITY: security.identityKey.keyArn,
      },
      logGroup: new logs.LogGroup(this, 'Ap2FunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-bff-ap2`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    security.hmacSecret.grantRead(ap2Fn)

    // UpdateItem only — the same narrow grant the chat function gets, for the same reason: that is
    // the single operation the conditional check-and-increment needs.
    ap2Fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [rateLimitTable.tableArn],
      }),
    )

    // The entities this function drives. The MPP is absent on purpose: only the Merchant calls it,
    // so nothing outside the entity stack has a path to settlement.
    ap2.merchantUrl.grantInvokeUrl(ap2Fn)
    ap2.consentUrl.grantInvokeUrl(ap2Fn)
    ap2.cpUrl.grantInvokeUrl(ap2Fn)

    grantMintIdentity(ap2Fn)

    // This function **is** the Trusted Surface, so it is the only principal granted invoke on the
    // Mandate Authority. The grant appears here and nowhere else — the agent stack has no equivalent
    // line — which is what makes the AP2 Agent-Provider MUST hold at the IAM layer.
    ap2.consentDecisionUrl.grantInvokeUrl(ap2Fn)

    // Public keys only: `kms:GetPublicKey` can neither sign nor verify, it just publishes what an
    // outside party needs to check the chain itself.
    ap2Fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:GetPublicKey'],
        resources: [
          security.merchantKey.keyArn,
          security.consentKey.keyArn,
          security.cpKey.keyArn,
          security.mppKey.keyArn,
        ],
      }),
    )

    // The intents table, including its by-initiator index — the checkout gate's own state.
    ap2Fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [data.intents.tableArn, `${data.intents.tableArn}/index/*`],
      }),
    )

    // Read-only on the evidence log: the surface that displays the audit trail must not alter it.
    ap2Fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [data.evidence.tableArn],
      }),
    )

    // Direct SMS takes a phone number rather than a topic ARN, and AWS documents no resource to
    // scope it to — so this is one grant that genuinely cannot be narrowed further.
    ap2Fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: ['*'],
      }),
    )

    // ── AP2 routes ─────────────────────────────────────────────────────
    // The handler reads its caller from the authorizer's verified claims and fails closed without
    // them, so every route needs one. `stacks.test.ts` asserts none can be added without.
    const ap2Integration = new apigateway.LambdaIntegration(ap2Fn, { proxy: true })
    const ap2Method = (resource: apigateway.IResource, method: string) =>
      resource.addMethod(method, ap2Integration, {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      })

    ap2Method(api.root.addResource('intent'), 'POST')
    ap2Method(api.root.addResource('confirm'), 'POST')
    ap2Method(api.root.addResource('decline'), 'POST')
    ap2Method(api.root.addResource('journeys'), 'GET')
    ap2Method(api.root.addResource('actors'), 'GET')
    ap2Method(api.root.addResource('evidence').addResource('{journeyId}'), 'GET')

    // ── Operations: alarms and a spend ceiling ──────────────────────────
    // Without these you learn the deployment is broken, or expensive, from a user or an invoice.
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${projectName}-alarms`,
      displayName: `${projectName} alarms`,
    })

    if (alertEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail))
    }

    const alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, 'ChatFunctionErrors', {
        alarmName: `${projectName}-chat-errors`,
        alarmDescription: 'The chat Lambda is failing — users see a broken conversation.',
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'AdminFunctionErrors', {
        alarmName: `${projectName}-admin-errors`,
        alarmDescription: 'The admin Lambda is failing — invites and the user list are broken.',
        metric: adminFn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'Ap2FunctionErrors', {
        alarmName: `${projectName}-ap2-errors`,
        alarmDescription: 'The checkout Lambda is failing — payments cannot be authorized.',
        metric: ap2Fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'ApiServerErrors', {
        alarmName: `${projectName}-api-5xx`,
        alarmDescription: 'The API is returning 5XX — the failure is at or before the integration.',
        metric: api.metricServerError({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ]

    for (const alarm of alarms) {
      alarm.addAlarmAction(new cwactions.SnsAction(alarmTopic))
    }

    // A budget alerts; it cannot stop spend. It exists so a runaway loop is noticed in hours rather
    // than on the invoice. Account-wide by nature, so it needs an address to notify.
    if (monthlyBudgetUsd && alertEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `${projectName}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        })),
      })
    }

    // ── WAF ────────────────────────────────────────────────────────────
    if (wafEnabled) attachWebAcl(this, projectName, api)

    this.apiUrl = api.url

    // ── Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}chat`,
      exportName: `${projectName}-BffUrl`,
    })
  }
}

/**
 * A regional web ACL on the API stage.
 *
 * This is the layer the existing controls do not cover. The stage throttle bounds the whole account
 * and says nothing about who is spending it; the per-caller quota is keyed on an authenticated
 * `sub`, so it only engages *after* a request has been authenticated — and an unauthenticated flood,
 * a scripted sign-up run, or an L7 payload never gets that far. CORS is not a control at all: it
 * asks the browser to cooperate.
 *
 * Three managed groups and one rate rule, all in `count` for nothing — every rule blocks. A managed
 * rule group in count mode is a dashboard, and a pilot that needs a dashboard needs a decision.
 */
function attachWebAcl(scope: Construct, projectName: string, api: apigateway.RestApi): void {
  const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
    name,
    priority,
    statement: {
      managedRuleGroupStatement: { vendorName: 'AWS', name },
    },
    overrideAction: { none: {} },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: name,
    },
  })

  const acl = new wafv2.CfnWebACL(scope, 'ApiWebAcl', {
    name: `${projectName}-api-acl`,
    description: `Edge protection for ${projectName}'s API stage.`,
    // REGIONAL, not CLOUDFRONT: the ACL is associated with an API Gateway stage. A CloudFront-scoped
    // ACL must live in us-east-1 and would protect the SPA distribution, which is a different door.
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `${projectName}-api-acl`,
    },
    rules: [
      managed('AWSManagedRulesAmazonIpReputationList', 10),
      managed('AWSManagedRulesKnownBadInputsRuleSet', 20),
      managed('AWSManagedRulesCommonRuleSet', 30),
      {
        /**
         * The ceiling a per-caller quota cannot express: requests from one IP, counted before
         * anyone is authenticated. It is what bounds automated sign-up and unauthenticated probing,
         * both of which cost money here — one through Cognito, the other through the stage.
         *
         * Deliberately loose. A shared NAT puts a whole office behind one address, and the tighter
         * per-`sub` quotas are still underneath; this catches a script, not a busy user.
         */
        name: 'RateLimitPerIp',
        priority: 40,
        statement: {
          rateBasedStatement: { limit: 1000, aggregateKeyType: 'IP' },
        },
        action: { block: {} },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'RateLimitPerIp',
        },
      },
    ],
  })

  const association = new wafv2.CfnWebACLAssociation(scope, 'ApiWebAclAssociation', {
    resourceArn: api.deploymentStage.stageArn,
    webAclArn: acl.attrArn,
  })
  // The stage must exist before anything can be associated with it; CloudFormation does not infer
  // that from `stageArn` alone, which is a token it can resolve either way.
  association.node.addDependency(api.deploymentStage)
}
