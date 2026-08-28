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
import { DEFAULT_USER_RATE_LIMIT, type ApiThrottle, type UserRateLimit } from '../config.js'

export interface BffStackProps extends cdk.StackProps {
  projectName: string
  userPool: cognito.UserPool
  agentRuntimeArn: string
  /** Caps requests/second on the API stage. Every request that gets through costs Bedrock tokens. */
  throttle: ApiThrottle
  /** Browser origin allowed to call this API, on the preflight and on every response header. */
  allowedOrigin?: string
  /** Caps one signed-in caller on `/chat`, independent of `throttle`, which caps the account. */
  userRateLimit?: UserRateLimit
  /** Subscribed to alarms and to the budget. The alarms exist either way. */
  alertEmail?: string
  /** Monthly USD ceiling that triggers a budget notification. Omitted disables the budget. */
  monthlyBudgetUsd?: number
  /** Whether a WAF web ACL fronts the API stage. Opt-in in every profile. */
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

    // ── API Gateway REST API ───────────────────────────────────────────
    // `dataTraceEnabled` stays off: it writes request and response bodies to CloudWatch, which
    // would put whole conversations in the log group.
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
        // Without this the stage inherits the account's 10k rps, and every request costs tokens.
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
        // Both this and the Lambdas' ALLOWED_ORIGIN read the same prop, so they cannot drift into
        // a preflight that passes and a response that fails, or the reverse.
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
     * ([docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html)).
     * The frontend sends the ID token for that reason.
     *
     * Accepting the OAuth-correct access token would need a resource server with a custom scope on
     * every method, and SRP sign-in only issues `aws.cognito.signin.user.admin` — so the scope would
     * come from a pre-token-generation trigger, putting a Lambda on every API call. The replay
     * exposure that OAuth rule guards against does not arise here: one pool, one client, one
     * consumer. Use a Lambda authorizer if that stops being true.
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
    // `cognito-idp:AdminCreate*`, and the function relaying model output must not. That is the
    // shape to copy when this template grows a route that can do something consequential.
    const adminFn = new lambda.Function(this, 'AdminFunction', {
      functionName: `${projectName}-bff-admin`,
      code: lambda.Code.fromAsset('../chatbot-bff', {
        exclude: ['node_modules', 'src', '*.ts', 'tsup.config.*', '.env*'],
      }),
      handler: 'dist/admin-handler.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // The REST integration ceiling is a hard 29s for a buffered response; longer only keeps
      // billing after the gateway has returned 504. The chat function streams, so it is exempt.
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
    // Same authorizer as /chat, so the gateway still validates the token. Group membership is
    // enforced inside the function, safe to centralize because it serves admin routes and nothing else.
    const adminIntegration = new apigateway.LambdaIntegration(adminFn, { proxy: true })
    const adminUsers = api.root.addResource('admin').addResource('users')

    for (const method of ['GET', 'POST']) {
      adminUsers.addMethod(method, adminIntegration, {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      })
    }

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

    // A budget alerts; it cannot stop spend. Account-wide by nature, so it needs an address.
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
 * A regional web ACL on the API stage — the only layer that filters *before* authentication. The
 * stage throttle says nothing about who is spending it, and the per-caller quota is keyed on an
 * authenticated `sub`, so an unauthenticated flood or a scripted sign-up run never reaches either.
 *
 * Every rule blocks; none is in `count` mode. A managed rule group in count mode is a dashboard.
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
         * Requests from one IP, counted before anyone is authenticated — what bounds automated
         * sign-up and unauthenticated probing. Deliberately loose: a shared NAT puts a whole office
         * behind one address, and the per-`sub` quotas are still underneath.
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
  // CloudFormation cannot infer the ordering from `stageArn`, which is a token either way.
  association.node.addDependency(api.deploymentStage)
}
