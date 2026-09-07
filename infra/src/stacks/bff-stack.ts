import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
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
import { AGENT_RUNTIME_ENDPOINT, agentRuntimeName } from './agent-stack.js'
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
  /** The deployment's customer-managed key, created in `AgentStack` and shared with every store. */
  encryptionKey: kms.IKey
  /** The AgentCore Memory conversations are recorded in, read by the conversation routes. */
  memoryId: string
  memoryArn: string
  /** TTL on the conversation index. Must match the memory resource's own expiry. */
  conversationRetentionDays: number
  /** The model the agent invokes — dimensions the Bedrock throttle alarm and the dashboard. */
  modelId: string
  /** The namespace the agent's EMF metrics land in, when observability is on. Dashboard only. */
  agentMetricNamespace?: string
  /** Whether X-Ray traces the functions and the stage. Required under `pilot`/`prod`. */
  tracingEnabled?: boolean
  /** Keeps the conversation index across a stack replacement, as the user pool does. */
  retainData?: boolean
}

/**
 * The AWS account publishing the AWS Lambda Layer for OpenTelemetry. Identical in every Region.
 *
 * Note there are two ADOT layer families and this is the current one. The older `aws-otel-nodejs-*`
 * layers (account 901920570463) bundle an ADOT Collector inside the function, and AWS's own guidance
 * is that "unless you want to export the telemetry data to a non CloudWatch endpoint, [that]
 * approach is not recommended" — we export to CloudWatch. It would also contradict the agent, where
 * `otlp-sigv4.ts` exists precisely because the ADOT Collector is not supported for agent
 * observability. The tell between the two is the wrapper: `/opt/otel-handler` is the legacy layer,
 * `/opt/otel-instrument` is this one.
 */
const ADOT_LAYER_ACCOUNT = '615299751070'

/**
 * The layer version, pinned.
 *
 * A template that floats to "latest" changes what a fork deploys without the fork changing
 * anything. This will go stale — the current value for a Region is
 *
 *   aws lambda list-layer-versions --region <region> \
 *     --layer-name arn:aws:lambda:<region>:615299751070:layer:AWSOpenTelemetryDistroJs \
 *     --query 'LayerVersions[0].Version'
 *
 * and this constant is the only place it appears.
 */
const ADOT_LAYER_VERSION = '15'

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
      encryptionKey,
      memoryId,
      memoryArn,
      conversationRetentionDays,
      modelId,
      agentMetricNamespace,
      tracingEnabled = false,
      retainData = true,
    } = props

    /**
     * Applied to all three functions and to the stage. X-Ray is what turns "the answer was wrong"
     * into a request you can open: without it the browser, the BFF and the agent share only a
     * timestamp. Off by default because it is billed per trace — the gate requires it where the
     * question actually gets asked.
     */
    const tracing = tracingEnabled ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED

    /**
     * Graviton, for all three functions.
     *
     * ~20% cheaper per GB-second than x86 at equal or better performance, and AWS's recommended
     * default for new workloads. Safe here because the deployed artifact is pure JavaScript: tsup
     * bundles every dependency in and the CDK asset excludes `node_modules`, so nothing
     * architecture-specific ships. A function that later needs a native module has to revisit this.
     */
    const architecture = lambda.Architecture.ARM_64

    /**
     * OpenTelemetry auto-instrumentation for the three functions, from the AWS-managed ADOT layer.
     *
     * **Why a layer and not the X-Ray SDK.** The X-Ray SDKs entered maintenance mode in February
     * 2026 — security patches only — and AWS names OpenTelemetry as the instrumentation path. More
     * than that: the agent container is already pure OTel, so reaching for the X-Ray SDK here would
     * make one template bilingual in tracing, with two context models a fork would inherit and have
     * to unpick. See the invariant in AGENTS.md.
     *
     * What it buys, concretely: `tracing: ACTIVE` alone traces the *invocation*, so a trace map
     * shows API Gateway and Lambda and then stops — DynamoDB and Cognito are invisible and the
     * AgentCore call renders as `UnknownRemoteService`, because nothing writes the attributes that
     * name a downstream. The layer instruments the AWS SDK and supplies them.
     *
     * Gated on `tracingEnabled` alongside the active-tracing setting it belongs to: a layer
     * exporting spans while X-Ray is off would bill for telemetry the deployment declared it did
     * not want.
     */
    const adotLayer = tracingEnabled
      ? lambda.LayerVersion.fromLayerVersionArn(
          this,
          'AdotLayer',
          // This layer family is architecture-neutral — one ARN serves x86_64 and arm64.
          `arn:${this.partition}:lambda:${this.region}:${ADOT_LAYER_ACCOUNT}:layer:AWSOpenTelemetryDistroJs:${ADOT_LAYER_VERSION}`,
        )
      : undefined

    /** Applied to every function, so a new one cannot be born untraced by omission. */
    const otelEnvironment: Record<string, string> = adotLayer
      ? {
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
          // Tracing without Application Signals. The layer supports both, but Application Signals
          // is separately billed and what it buys is an SLO layer — and this template declares no
          // availability or latency target, so it stays off until someone chooses one.
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
        }
      : {}

    // ── Per-caller rate limit table ─────────────────────────────────────
    // One item per (caller, window); see chatbot-bff/src/rate-limit.ts. Disposable counters, not
    // user data, so it is destroyed regardless of RETAIN_DATA — losing it just resets every quota.
    const rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName: `${projectName}-bff-rate-limit`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
    })

    // ── Conversation index ──────────────────────────────────────────────
    // What the sidebar reads: one row per conversation, carrying its title and when it last moved.
    //
    // The conversations themselves live in AgentCore Memory. This exists so that listing them costs
    // one query and touches no message content — a privilege property as much as a performance one,
    // since the common case never decrypts a transcript. `SessionSummary` from the memory service
    // carries neither a title nor a last-updated time, which is the other half of the reason.
    const conversationTable = new dynamodb.Table(this, 'ConversationTable', {
      tableName: `${projectName}-bff-conversations`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Matched to the memory resource's `eventExpiryDuration` by `conversationRetentionDays`. An
      // index that outlives its conversations fills the sidebar with rows that open empty.
      timeToLiveAttribute: 'expiresAt',
      // Unlike the rate-limit counters, these rows are the user's own data — they name what someone
      // talked about — so they follow the same retention decision as the user pool.
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      // `RETAIN` above only governs CloudFormation: it survives a `cdk destroy`, and nothing else.
      // These two cover what it does not — a bad write, a bulk delete, or a `DeleteTable` call made
      // outside the stack. Continuous backups are billed on the size of what they protect, which for
      // an index of titles and timestamps is small; the rate-limit table above deliberately gets
      // neither, because losing disposable counters costs a reset.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: retainData,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
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
      architecture,
      tracing,
      ...(adotLayer ? { layers: [adotLayer] } : {}),
      // JSON rather than the default text. `logEvent` (chatbot-bff/src/correlation.ts) already emits
      // one JSON object per line, but Lambda's own START/END/REPORT lines and any stray `console`
      // call stayed unstructured — so a Logs Insights query filtering on a correlation id silently
      // skipped them. `loggingFormat` also makes the level a queryable field rather than a prefix.
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      environment: {
        ...otelEnvironment,
        // Names this function's node in the trace map. Without it the map falls back to a generic
        // label and two of the three functions become indistinguishable.
        OTEL_SERVICE_NAME: `${projectName}-bff`,
        ALLOWED_ORIGIN: allowedOrigin,
        AGENT_RUNTIME_ARN: agentRuntimeArn,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        RATE_LIMIT_TABLE_NAME: rateLimitTable.tableName,
        USER_RATE_LIMIT: String(userRateLimit.limit),
        USER_RATE_LIMIT_WINDOW_SECONDS: String(userRateLimit.windowSeconds),
        CONVERSATION_TABLE_NAME: conversationTable.tableName,
        CONVERSATION_RETENTION_DAYS: String(conversationRetentionDays),
      },
      logGroup: new logs.LogGroup(this, 'ChatFunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-bff`,
        // A week does not survive an incident found after a weekend.
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        encryptionKey,
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

    // ── IAM: the two tables — UpdateItem only ──────────────────────────
    // One statement, one action, two resources. `checkRateLimit` and the conversation index are both
    // conditional upserts, so naming a second table costs this role a *resource*, not a capability —
    // which is what keeps `keeps every privileged grant off the function that relays model output`
    // (stacks.test.ts) meaningful as the function grows.
    //
    // Note what is absent: no `Query`, no `GetItem`. This function writes the index and never reads
    // it. Listing and reading conversations is the conversations function's job, and only it can
    // reach the stored content.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [rateLimitTable.tableArn, conversationTable.tableArn],
      }),
    )

    // Both tables are encrypted with a customer-managed key, and DynamoDB uses it *as the caller* —
    // so a role holding `UpdateItem` and nothing else gets AccessDenied on the key, not on the
    // table, which is a confusing way to discover this. The actions mirror what CDK's own
    // `grantWriteData` pairs with a write, plus `Decrypt`: both writes here are conditional
    // (`if_not_exists`, the rate-limit check), and a condition reads the item it guards.
    encryptionKey.grantEncryptDecrypt(fn)

    // ── API Gateway REST API ───────────────────────────────────────────
    // `dataTraceEnabled` stays off: it writes request and response bodies to CloudWatch, which
    // would put whole conversations in the log group.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${projectName}-chat-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey,
    })

    const api = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: `${projectName}-chat-api`,
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        // The stage segment is the root of the trace: without it the Lambda's segment has no parent
        // and the gateway's own latency — the half a user actually feels — is invisible.
        tracingEnabled,
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
        // GET is here for the admin user listing and the conversation routes; DELETE removes one
        // conversation; the chat route is POST only.
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        // `X-Correlation-Id` must be listed or the browser drops the request at the preflight. It
        // mirrors `CORS_HEADERS` in chatbot-bff/src/http.ts, which sets the same list on responses.
        allowHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
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
      architecture,
      tracing,
      ...(adotLayer ? { layers: [adotLayer] } : {}),
      // JSON rather than the default text. `logEvent` (chatbot-bff/src/correlation.ts) already emits
      // one JSON object per line, but Lambda's own START/END/REPORT lines and any stray `console`
      // call stayed unstructured — so a Logs Insights query filtering on a correlation id silently
      // skipped them. `loggingFormat` also makes the level a queryable field rather than a prefix.
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      environment: {
        ...otelEnvironment,
        OTEL_SERVICE_NAME: `${projectName}-bff-admin`,
        ALLOWED_ORIGIN: allowedOrigin,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        ADMIN_GROUP_NAME,
      },
      logGroup: new logs.LogGroup(this, 'AdminFunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-bff-admin`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        encryptionKey,
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

    // ── Conversations function ─────────────────────────────────────────
    // A third function for the same reason there is a second one: this role can read and delete
    // stored conversation *content*, and the function that relays untrusted model output must not
    // hold that. The chat function writes the index and nothing else.
    const conversationsFn = new lambda.Function(this, 'ConversationsFunction', {
      functionName: `${projectName}-bff-conversations`,
      code: lambda.Code.fromAsset('../chatbot-bff', {
        exclude: ['node_modules', 'src', '*.ts', 'tsup.config.*', '.env*'],
      }),
      handler: 'dist/conversations-handler.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
      architecture,
      tracing,
      ...(adotLayer ? { layers: [adotLayer] } : {}),
      // JSON rather than the default text. `logEvent` (chatbot-bff/src/correlation.ts) already emits
      // one JSON object per line, but Lambda's own START/END/REPORT lines and any stray `console`
      // call stayed unstructured — so a Logs Insights query filtering on a correlation id silently
      // skipped them. `loggingFormat` also makes the level a queryable field rather than a prefix.
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      environment: {
        ...otelEnvironment,
        OTEL_SERVICE_NAME: `${projectName}-bff-conversations`,
        ALLOWED_ORIGIN: allowedOrigin,
        AGENTCORE_MEMORY_ID: memoryId,
        CONVERSATION_TABLE_NAME: conversationTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'ConversationsFunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-bff-conversations`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        encryptionKey,
      }),
    })

    // Scoped to this memory resource, and to reading and erasing — never `CreateEvent`. Recording a
    // turn is the agent's job; a route reachable from a browser must not be able to write history.
    conversationsFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:DeleteEvent',
        ],
        resources: [memoryArn],
      }),
    )

    // Query to list, DeleteItem to forget. No `UpdateItem`: this function never renames or reorders
    // a conversation, so it cannot rewrite what the sidebar says a turn was about.
    conversationsFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
        resources: [conversationTable.tableArn],
      }),
    )

    // Same reason as the chat function above, and for the memory reads as well: stored events are
    // encrypted under this key, so reading a transcript needs it too.
    encryptionKey.grantEncryptDecrypt(conversationsFn)

    // ── /conversations and /conversations/{sessionId} ──────────────────
    const conversationsIntegration = new apigateway.LambdaIntegration(conversationsFn, { proxy: true })
    const conversations = api.root.addResource('conversations')
    const conversation = conversations.addResource('{sessionId}')

    conversations.addMethod('GET', conversationsIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    })

    for (const method of ['GET', 'DELETE']) {
      conversation.addMethod(method, conversationsIntegration, {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      })
    }

    // ── Operations: alarms and a spend ceiling ──────────────────────────
    // Without these you learn the deployment is broken, or expensive, from a user or an invoice.

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${projectName}-alarms`,
      displayName: `${projectName} alarms`,
      // The alarm bodies name the function and the deployment. The key policy in `AgentStack` grants
      // `cloudwatch.amazonaws.com` what it needs to publish through this key — without that grant an
      // encrypted topic fails delivery silently, which is the worst way for an alarm to fail.
      masterKey: encryptionKey,
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
      // Every alarm above fires on an error. These four fire on the failures that return 200:
      // a conversation nobody waits for, a runtime refusing work it never reports as broken, and a
      // model call the service rejects. Nothing upstream looks wrong while any of them is happening,
      // which is exactly why they need an alarm of their own.
      new cloudwatch.Alarm(this, 'ChatFunctionLatency', {
        alarmName: `${projectName}-chat-latency`,
        alarmDescription:
          'The chat Lambda is slow. Nothing is erroring — users are abandoning the turn instead.',
        // p95, not average: an average hides the tail, and the tail is what a user experiences as
        // "it is broken". The threshold sits below the 60s function timeout so it warns rather than
        // reporting a failure that already happened.
        metric: fn.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p95' }),
        threshold: cdk.Duration.seconds(45).toMilliseconds(),
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'AgentRuntimeThrottles', {
        alarmName: `${projectName}-agent-throttles`,
        alarmDescription:
          'AgentCore is throttling invocations — the deployment is at a service quota, not broken.',
        metric: agentRuntimeMetric('Throttles', projectName, agentRuntimeArn),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'AgentRuntimeSystemErrors', {
        alarmName: `${projectName}-agent-system-errors`,
        alarmDescription:
          'AgentCore is failing server-side. The chat Lambda may still be answering 200 with a failed turn.',
        metric: agentRuntimeMetric('SystemErrors', projectName, agentRuntimeArn),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'BedrockThrottles', {
        alarmName: `${projectName}-bedrock-throttles`,
        alarmDescription:
          'Bedrock is throttling model calls — turns are failing for capacity, not for correctness.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationThrottles',
          dimensionsMap: { ModelId: modelId },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ]

    for (const alarm of alarms) {
      alarm.addAlarmAction(new cwactions.SnsAction(alarmTopic))
    }

    // ── Operations: one page to answer "is it healthy, and what is it costing" ──
    // The alarms above say something is wrong. This says what, and it is the artefact an operator
    // opens first — which is why the rows are ordered the way an incident actually unfolds: what the
    // user experienced, then which layer produced it, then what the model was doing.
    createDashboard(this, {
      projectName,
      api,
      chatFunction: fn,
      modelId,
      agentRuntimeArn,
      agentMetricNamespace,
    })

    // A budget alerts; it cannot stop spend. It also measures the WHOLE ACCOUNT, not this project,
    // despite the name: there is no `costFilters` below.
    //
    // That is the deliberate choice between two failure modes. Filtering on
    // `TagKeyValue: ['user:Project$<name>']` would scope it exactly — but a cost allocation tag has
    // to be activated in Billing by hand first, and a budget filtered on an unactivated tag tracks
    // zero and never fires. Over-alerting in a shared account is loud and fixable; a guardrail that
    // silently measures nothing is the one you find out about from the invoice.
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
    // No apostrophe: CloudFormation validates this against a pattern that permits only
    // alphanumerics and `+=:#@/-,.` plus whitespace, so a possessive fails template validation.
    description: `Edge protection for the ${projectName} API stage.`,
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

/**
 * One AgentCore runtime metric, on the dimensions AgentCore actually publishes.
 *
 * This comment used to open by asserting that AgentCore dimensions these "by the runtime's *name*,
 * not its ARN". It publishes them by both, and by the operation as well: `Name` is
 * `<runtime>::<endpoint>`, `Operation` is `InvokeAgentRuntime`, `Resource` is the runtime ARN. The
 * stack carried a single `AgentRuntimeName` dimension instead, which appears under no metric in the
 * namespace — so both agent alarms received no datapoint from the first deploy, and
 * `treatMissingData: NOT_BREACHING` held them in `OK` for the life of the deployment. An alarm that
 * is wrong and green is worse than no alarm, which is at least visibly absent.
 *
 * Worth being precise about why it survived review: nothing in a synth can catch it. The template
 * renders the wrong dimension perfectly and every test in `stacks.test.ts` agrees with it, because
 * those tests assert on what CDK rendered rather than on what CloudWatch holds. Only the account
 * knows. The settling command is
 *
 *   aws cloudwatch list-metrics --namespace AWS/Bedrock-AgentCore
 *
 * and the test that guards this now asserts the dimension *shape* AWS documents, which is the part
 * a reader can check against that output without deploying anything.
 */
function agentRuntimeMetric(
  metricName: string,
  projectName: string,
  agentRuntimeArn: string,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'AWS/Bedrock-AgentCore',
    metricName,
    // The endpoint half of `Name` and the ARN both come from `AgentStack`, so a runtime renamed
    // there moves this with it rather than leaving the alarm pointed at a name nothing publishes.
    dimensionsMap: {
      Name: `${agentRuntimeName(projectName)}::${AGENT_RUNTIME_ENDPOINT}`,
      Operation: 'InvokeAgentRuntime',
      Resource: agentRuntimeArn,
    },
    period: cdk.Duration.minutes(5),
    statistic: 'Sum',
  })
}

/**
 * Every metric name `agent/src/emf-metrics.ts` can put in the agent's namespace.
 *
 * Hand-kept, and deliberately so: the two packages cannot import each other, so this is one half of
 * a contract whose other half is the agent's own instruments — the same arrangement as the identity
 * wire format, and paired the same way, by a test on each side (`emf-metrics.test.ts` asserts what
 * the exporter produces these names from). What it buys is that `agentMetric` below takes this
 * union rather than a `string`, so charting a metric nothing publishes stops being a widget that
 * renders flat zero and becomes a compile error.
 *
 * That is not hypothetical. `GenAiServerTimeToFirstToken` was charted here for exactly as long as
 * this type did not exist; Strands emits no such instrument, and an empty widget reads as a model
 * that answers instantly. Time to first token now comes from `AWS/Bedrock`, which does publish it.
 *
 * Two of these appear only once the condition they count occurs — a tool has to fail before
 * `ToolErrorCount` exists, and a guardrail has to intervene before `GuardedCount` does. That is a
 * counter behaving correctly, not the absence this type guards against.
 */
type AgentMetricName =
  | 'GenAiAgentTokensInput'
  | 'GenAiAgentTokensOutput'
  | 'GenAiAgentModelLatency'
  | 'GenAiAgentCycleDuration'
  | 'GenAiAgentCycleCount'
  | 'GenAiAgentInvocationCount'
  | 'GenAiAgentToolCallCount'
  | 'GenAiAgentToolErrorCount'
  | 'GenAiAgentToolDuration'
  | 'GenAiAgentGuardedCount'

/**
 * The operational dashboard.
 *
 * Deliberately not a widget per metric: a page with forty graphs is one nobody reads under pressure.
 * Three rows, each answering one question, in the order an incident is actually diagnosed.
 *
 * The agent row is present only when `agentObservabilityEnabled` put those metrics there. A widget
 * charting a namespace nothing writes to renders as a flat line at zero, which reads as "the agent
 * is idle" rather than "this was never switched on" — the more dangerous of the two.
 */
function createDashboard(
  scope: Construct,
  options: {
    projectName: string
    api: apigateway.RestApi
    chatFunction: lambda.Function
    modelId: string
    agentRuntimeArn: string
    agentMetricNamespace?: string
  },
): cloudwatch.Dashboard {
  const { projectName, api, chatFunction, modelId, agentRuntimeArn, agentMetricNamespace } = options
  const period = cdk.Duration.minutes(5)

  const agentMetric = (metricName: AgentMetricName, statistic: string) =>
    new cloudwatch.Metric({
      namespace: agentMetricNamespace ?? '',
      metricName,
      dimensionsMap: { ServiceName: `${projectName}-agent` },
      period,
      statistic,
    })

  const dashboard = new cloudwatch.Dashboard(scope, 'OperationsDashboard', {
    dashboardName: `${projectName}-operations`,
    defaultInterval: cdk.Duration.hours(3),
  })

  // Row 1 — what the user got. Latency is p50 beside p95 on purpose: the gap between them is what
  // separates "everyone is waiting" from "a few turns are stuck", and those have different causes.
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      title: 'Turns — requests and failures',
      width: 12,
      left: [api.metricCount({ period }), api.metricServerError({ period })],
      right: [chatFunction.metricErrors({ period })],
    }),
    new cloudwatch.GraphWidget({
      title: 'Turn latency (p50 / p95)',
      width: 12,
      left: [
        chatFunction.metricDuration({ period, statistic: 'p50', label: 'p50' }),
        chatFunction.metricDuration({ period, statistic: 'p95', label: 'p95' }),
      ],
    }),
  )

  // Row 2 — which layer produced it. AgentCore's throttles and errors are the ones the chat Lambda
  // can answer 200 over, so a turn can fail here with nothing above it looking wrong.
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      title: 'AgentCore runtime',
      width: 12,
      left: [
        agentRuntimeMetric('Invocations', projectName, agentRuntimeArn),
        agentRuntimeMetric('Throttles', projectName, agentRuntimeArn),
        agentRuntimeMetric('SystemErrors', projectName, agentRuntimeArn),
        agentRuntimeMetric('UserErrors', projectName, agentRuntimeArn),
      ],
      // `Sessions`, not `SessionCount` — the latter is not a metric AgentCore publishes, so this
      // axis was empty for the same reason the dimension above made the whole widget empty.
      right: [agentRuntimeMetric('Sessions', projectName, agentRuntimeArn)],
    }),
    new cloudwatch.GraphWidget({
      title: 'Bedrock model',
      width: 12,
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationThrottles',
          dimensionsMap: { ModelId: modelId },
          period,
          statistic: 'Sum',
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationServerErrors',
          dimensionsMap: { ModelId: modelId },
          period,
          statistic: 'Sum',
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationLatency',
          dimensionsMap: { ModelId: modelId },
          period,
          statistic: 'p95',
        }),
        // Time to first token is what a user calls "slow" even when the total is fine, and Bedrock
        // publishes it per model. It sits here rather than in the agent row below because it is the
        // service's own measurement: charting it here means it survives `AGENT_OBSERVABILITY_ENABLED`
        // being off, and it does not depend on an instrument the agent SDK may or may not emit.
        //
        // It was previously charted below as `GenAiServerTimeToFirstToken`, from the agent's own
        // metrics — a name nothing writes. Strands emits no time-to-first-token instrument, so that
        // widget rendered empty and read as "the model answers instantly".
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'TimeToFirstToken',
          dimensionsMap: { ModelId: modelId },
          period,
          statistic: 'p95',
        }),
      ],
    }),
  )

  if (!agentMetricNamespace) return dashboard

  // Row 3 — what the model was doing. Every metric here is named by `AgentMetricName`, which is the
  // whole discipline of this row: a widget
  // charting a name nothing writes renders as a flat zero, and a flat zero reads as "quiet" rather
  // than "never wired up". Tokens are the cost line; the gap between model latency and cycle
  // duration is the loop's own overhead; tool errors are the failure that reaches the user as a
  // confident wrong answer rather than as an error; a guarded turn is the one that returns 200 with
  // content the guardrail rewrote.
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      title: 'Tokens',
      width: 6,
      left: [
        agentMetric('GenAiAgentTokensInput', 'Sum'),
        agentMetric('GenAiAgentTokensOutput', 'Sum'),
      ],
    }),
    new cloudwatch.GraphWidget({
      title: 'Model latency and loop time',
      width: 6,
      // Charted together because the distance between them is the only view of what the agent loop
      // spends outside the model — tool calls and the memory read. Time to first token used to be
      // the second series here and now sits in the Bedrock widget above, where the number is real.
      left: [
        agentMetric('GenAiAgentModelLatency', 'Average'),
        agentMetric('GenAiAgentCycleDuration', 'Average'),
      ],
    }),
    new cloudwatch.GraphWidget({
      title: 'Tool calls and errors',
      width: 6,
      left: [
        agentMetric('GenAiAgentToolCallCount', 'Sum'),
        agentMetric('GenAiAgentToolErrorCount', 'Sum'),
      ],
      right: [agentMetric('GenAiAgentToolDuration', 'Average')],
    }),
    new cloudwatch.GraphWidget({
      title: 'Turns a content control ended',
      width: 6,
      // The guardrail is the one layer that reads what is said, and until `agent/src/index.ts`
      // counted this nothing recorded that it had acted: an intervention ends the turn with a
      // normal stop reason, so it returns 200 and looks like an ordinary answer. A deployment could
      // not answer "how often did the guardrail fire this week" at all.
      left: [agentMetric('GenAiAgentGuardedCount', 'Sum')],
    }),
  )

  return dashboard
}
