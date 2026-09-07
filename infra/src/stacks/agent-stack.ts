import * as cdk from 'aws-cdk-lib'
import * as bedrock from 'aws-cdk-lib/aws-bedrock'
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore'
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import { fileURLToPath } from 'node:url'

export interface AgentStackProps extends cdk.StackProps {
  projectName: string
  imagePlatform?: ecrassets.Platform
  runtimeEnvironment?: Record<string, string>
  /**
   * The Bedrock model the agent may invoke — injected into the container *and* the one model its
   * execution role is scoped to, so the permission and the configuration cannot disagree.
   */
  modelId: string
  /** How long a recorded conversation is kept, in days. Enforced by the memory resource itself. */
  conversationRetentionDays: number
  /** Whether a Bedrock guardrail filters model input and output. Required under `pilot`/`prod`. */
  guardrailEnabled?: boolean
  /**
   * Whether the container exports spans and token metrics to CloudWatch, and whether this stack
   * creates the log group and deliveries they land in. Required under `pilot`/`prod`.
   */
  agentObservabilityEnabled?: boolean
  /** Keeps the key and the conversations it protects across a stack replacement. */
  retainData?: boolean
}

function compactEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value && value.trim().length > 0),
  ) as Record<string, string>
}

/**
 * The agent container and its Bedrock AgentCore runtime.
 *
 * The runtime carries **no authorizer configuration**, which makes it SigV4-only: the BFF's chat
 * function is the sole holder of `InvokeAgentRuntime` on this ARN, so no browser can reach it.
 *
 * That is a security boundary. The agent learns who is asking from a plain-text identity block the
 * BFF prepends to the prompt, which is only as trustworthy as the transport that carried it. A
 * Cognito JWT authorizer here would let the browser call the runtime directly, making that block
 * client-supplied text — any signed-in user could name another user's `sub`. Do not add one unless
 * the block becomes a signed token the runtime itself verifies.
 */
export class AgentStack extends cdk.Stack {
  public readonly runtimeArn: string
  public readonly runtimeId: string
  public readonly runtimeStatus: string
  public readonly executionRoleArn: string
  public readonly imageUri: string
  /** The AgentCore Memory conversations are recorded in. Read by the BFF's conversation routes. */
  public readonly memoryId: string
  public readonly memoryArn: string
  /** The deployment's customer-managed key. Shared with `BffStack` for its logs, tables and topic. */
  public readonly encryptionKey: kms.Key

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props)

    const {
      projectName,
      imagePlatform,
      runtimeEnvironment,
      modelId,
      conversationRetentionDays,
      guardrailEnabled = false,
      agentObservabilityEnabled = false,
      retainData = true,
    } = props

    const agentDirectory = fileURLToPath(new URL('../../../agent', import.meta.url))

    const imageAsset = new ecrassets.DockerImageAsset(this, 'AgentImage', {
      directory: agentDirectory,
      platform: imagePlatform,
    })

    // ── Encryption key ─────────────────────────────────────────────────
    // One customer-managed key for everything this deployment stores: conversations here, and the
    // log groups, tables and alarm topic in `BffStack`. AWS-owned keys encrypt at rest too — what a
    // CMK adds is that the grants are visible, auditable in CloudTrail by key, and revocable, which
    // is the difference between "encrypted" and "encrypted under a key we control" that a pilot's
    // security review asks about.
    //
    // Deliberately one key rather than one per service: an operator who has to reason about which
    // key protects what will get it wrong, and the blast radius of the key is the deployment anyway.
    const encryptionKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${projectName}`,
      description: `Encrypts conversations, logs and tables for ${projectName}.`,
      enableKeyRotation: true,
      // A destroyed key makes every ciphertext under it permanently unreadable, so it outlives the
      // stack by the same rule the user pool does. The pending window is the last chance to stop a
      // deletion that took the conversations with it.
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(30),
    })

    // CloudWatch Logs encrypts through the key on the caller's behalf, so the *service* needs the
    // grant, not the role writing the log. The encryption-context condition scopes it to log groups
    // in this account: without it, the statement lets the Logs service decrypt anything under this
    // key for any log group anywhere.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    )

    // An alarm publishing to an encrypted topic is CloudWatch calling KMS, not the alarm's owner —
    // without this the alarm silently fails to deliver, which is the worst way for an alarm to fail.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAlarmsToPublishToEncryptedTopic',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
          new iam.ServicePrincipal('sns.amazonaws.com'),
        ],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    )

    // AgentCore Memory encrypts stored events with this key as the service, on behalf of whoever
    // wrote them.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAgentCoreMemory',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com')],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    )

    // ── Content guardrail ──────────────────────────────────────────────
    const guardrail = guardrailEnabled
      ? createGuardrail(this, projectName, encryptionKey)
      : undefined

    // ── Conversation memory ────────────────────────────────────────────
    // AgentCore Memory rather than a bucket of our own: retention and encryption become properties
    // of a managed resource instead of a lifecycle rule and a key policy this template has to keep
    // correct. `eventExpiryDuration` is the retention policy — the one number a pilot is asked for,
    // enforced by the service rather than by a job that might not run.
    //
    // Isolation is by `actorId`, which the runtime derives from the caller namespace the BFF
    // prefixes onto every session id. Every read names one, so a leaked session id alone reaches
    // nothing (see `agent/src/memory.ts`).
    const memory = new bedrockagentcore.CfnMemory(this, 'ConversationMemory', {
      name: `${projectName.replaceAll('-', '_')}_conversations`,
      description: `Conversation history for ${projectName}.`,
      eventExpiryDuration: conversationRetentionDays,
      encryptionKeyArn: encryptionKey.keyArn,
      tags: { Project: projectName },
    })
    memory.applyRemovalPolicy(retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY)

    const memoryArn = cdk.Stack.of(this).formatArn({
      service: 'bedrock-agentcore',
      resource: 'memory',
      resourceName: memory.attrMemoryId,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    })

    // ── Observability ──────────────────────────────────────────────────
    // One log group holds everything this agent emits: the container's stdout, the spans it exports,
    // the EMF records its metrics arrive as, and AgentCore's own application and usage logs. That is
    // deliberate and it is what makes the content policy enforceable — a retention, this
    // deployment's CMK and a data protection policy are properties of a log group, and spans left in
    // the account-shared `aws/spans` group would have none of the three.
    //
    // Nothing here creates CloudWatch Transaction Search. It is account-and-Region-wide state other
    // workloads depend on, so a `cdk destroy` of this stack must not switch off their telemetry;
    // `infra/src/config.ts` requires an acknowledgement that it is on instead, because without it
    // spans are accepted and then silently discarded.
    const observability = agentObservabilityEnabled
      ? createObservability(this, {
          projectName,
          encryptionKey,
          retentionDays: conversationRetentionDays,
        })
      : undefined

    const runtimeExecutionPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'EcrImageAccess',
          effect: iam.Effect.ALLOW,
          actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
          // The asset's own repository. A wildcard would let a compromised container enumerate and
          // pull every other image in the account.
          resources: [imageAsset.repository.repositoryArn],
        }),
        new iam.PolicyStatement({
          sid: 'EcrTokenAccess',
          effect: iam.Effect.ALLOW,
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'RuntimeLogs',
          effect: iam.Effect.ALLOW,
          actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: '/aws/bedrock-agentcore/runtimes/*',
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
        new iam.PolicyStatement({
          sid: 'DescribeLogGroups',
          effect: iam.Effect.ALLOW,
          actions: ['logs:DescribeLogGroups'],
          // Its own log groups: account-wide `DescribeLogGroups` lists every workload in the account.
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: '/aws/bedrock-agentcore/runtimes/*',
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
        new iam.PolicyStatement({
          sid: 'WriteRuntimeLogs',
          effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: '/aws/bedrock-agentcore/runtimes/*:log-stream:*',
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
        new iam.PolicyStatement({
          sid: 'RuntimeTracing',
          effect: iam.Effect.ALLOW,
          actions: [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'xray:GetSamplingRules',
            'xray:GetSamplingTargets',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'RuntimeMetrics',
          effect: iam.Effect.ALLOW,
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'cloudwatch:namespace': 'bedrock-agentcore',
            },
          },
        }),
        ...(observability
          ? [
              // The agent's own metrics do not go through `PutMetricData` at all. They are written as
              // EMF log events and CloudWatch Logs derives the metrics from them, so the only
              // permission involved is writing to this one log group — a narrower grant than
              // `PutMetricData`, which cannot be scoped to a resource.
              new iam.PolicyStatement({
                sid: 'WriteAgentTelemetry',
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
                resources: [observability.logGroup.logGroupArn],
              }),
              // AgentCore uses this to let X-Ray deliver spans into the agent's own log group rather
              // than the shared one. Scoped to that group: `PutResourcePolicy` is account-level in
              // its blast radius if the resource is left open.
              new iam.PolicyStatement({
                sid: 'AllowSpanDeliveryToOwnLogGroup',
                effect: iam.Effect.ALLOW,
                actions: ['logs:PutResourcePolicy'],
                resources: [observability.logGroup.logGroupArn],
              }),
            ]
          : []),
        new iam.PolicyStatement({
          sid: 'ConversationMemoryAccess',
          effect: iam.Effect.ALLOW,
          // Write a turn and read the ones before it. No `DeleteEvent`: erasing a conversation is a
          // user's decision, taken through the BFF's conversation route, and the container that
          // relays model output has no business being able to destroy the record of what it said.
          actions: [
            'bedrock-agentcore:CreateEvent',
            'bedrock-agentcore:ListEvents',
            'bedrock-agentcore:GetEvent',
          ],
          resources: [memoryArn],
        }),
        ...(guardrail
          ? [
              new iam.PolicyStatement({
                sid: 'ApplyGuardrail',
                effect: iam.Effect.ALLOW,
                // Scoped to this guardrail. A wildcard would let the container name any guardrail in
                // the account, including one with every filter disabled.
                actions: ['bedrock:ApplyGuardrail'],
                resources: [guardrail.guardrailArn],
              }),
            ]
          : []),
        new iam.PolicyStatement({
          sid: 'BedrockModelAccess',
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          // This model and nothing else. A wildcard is a budget with no ceiling and a data path
          // with no boundary — any model in any region, including ones never reviewed for this
          // deployment, which is a data-residency problem as much as a cost one.
          resources: bedrockModelResources(this, modelId),
        }),
      ],
    })

    const runtimeRole = new iam.Role(this, 'RuntimeExecutionRole', {
      roleName: `${projectName}-agentcore-runtime-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
          ArnLike: {
            'aws:SourceArn': cdk.Stack.of(this).formatArn({
              service: 'bedrock-agentcore',
              resource: '*',
            }),
          },
        },
      }),
      description: 'Execution role for the Bedrock AgentCore runtime.',
      inlinePolicies: {
        RuntimeExecutionPolicy: runtimeExecutionPolicy,
      },
    })

    // Events in the memory resource are encrypted under this key, and AgentCore uses it on the
    // caller's behalf — so writing or replaying a turn needs the key as well as the memory ARN.
    encryptionKey.grantEncryptDecrypt(runtimeRole)

    // A tool that reaches a backend signs with this role's credentials, so its grant goes here —
    // `someLambda.grantInvoke(runtimeRole)`, or `grantInvokeUrl`. Keeping it on the runtime role is
    // what bounds what a compromised container can reach.

    const runtime = new bedrockagentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: projectName.replaceAll('-', '_'),
      description: `AgentCore runtime for ${projectName}`,
      roleArn: runtimeRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: imageAsset.imageUri,
        },
      },
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      protocolConfiguration: 'HTTP',
      environmentVariables: compactEnvironment({
        AWS_REGION: this.region,
        PORT: '8080',
        // Explicit, so the container cannot fall back to a default its role would deny.
        BEDROCK_MODEL_ID: modelId,
        // Unset, the runtime answers every turn without history and records nothing — which is what
        // makes local development work without a managed resource, and what a misconfigured
        // deployment degrades to rather than failing closed on.
        AGENTCORE_MEMORY_ID: memory.attrMemoryId,
        // Both, or neither: `agent/src/agent.ts` treats a half-configured pair as no guardrail, so a
        // version that failed to resolve cannot leave the model unfiltered while looking configured.
        ...(guardrail
          ? {
              BEDROCK_GUARDRAIL_ID: guardrail.guardrailId,
              BEDROCK_GUARDRAIL_VERSION: guardrail.guardrailVersion,
            }
          : {}),
        OTEL_SERVICE_NAME: `${projectName}-agent`,
        // Telemetry is derived from this stack's own resources, never passed through from `.env`.
        // The log group the spans are directed to and the log group carrying the retention, the CMK
        // and the data protection policy are therefore the same log group by construction, rather
        // than by two settings that have to agree.
        ...(observability
          ? {
              AGENT_OBSERVABILITY_ENABLED: 'true',
              // Without these two headers the endpoint files spans under the account-shared
              // `aws/spans`, where none of this deployment's controls reach them.
              OTEL_EXPORTER_OTLP_TRACES_HEADERS: `x-aws-log-group=${observability.logGroup.logGroupName},x-aws-log-stream=spans`,
              AGENT_METRICS_LOG_GROUP: observability.logGroup.logGroupName,
              AGENT_METRICS_NAMESPACE: observability.metricNamespace,
              // `aws.log.group.names` is what correlates a trace with the log lines written beside
              // it, so a span in the console offers the surrounding logs instead of a timestamp.
              OTEL_RESOURCE_ATTRIBUTES: `service.name=${projectName}-agent,aws.log.group.names=${observability.logGroup.logGroupName}`,
            }
          : {}),
        // Anything a tool needs to find its backend goes here — a Function URL, a table name. The
        // agent should register such a tool only when its configuration is present.
        ...runtimeEnvironment,
      }),
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 900,
        maxLifetime: 14400,
      },
      // No `authorizerConfiguration`, deliberately — see the note on the class above.
      tags: {
        Project: projectName,
      },
    })

    this.runtimeArn = runtime.attrAgentRuntimeArn
    this.runtimeId = runtime.attrAgentRuntimeId

    // Here, and not beside the log group, because a delivery source names the runtime by ARN — see
    // the note on the function. Everything above this line only needed the log group's *name*, which
    // is ours to choose; this needs the runtime's identity, which AgentCore assigns.
    if (observability) {
      createTelemetryDeliveries(this, {
        projectName,
        logGroup: observability.logGroup,
        runtimeArn: runtime.attrAgentRuntimeArn,
      })
    }
    this.runtimeStatus = runtime.attrStatus
    this.executionRoleArn = runtimeRole.roleArn
    this.imageUri = imageAsset.imageUri
    this.memoryId = memory.attrMemoryId
    this.memoryArn = memoryArn
    this.encryptionKey = encryptionKey

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: this.runtimeArn,
      exportName: `${projectName}-AgentRuntimeArn`,
    })

    new cdk.CfnOutput(this, 'AgentRuntimeId', {
      value: this.runtimeId,
      exportName: `${projectName}-AgentRuntimeId`,
    })

    new cdk.CfnOutput(this, 'AgentRuntimeStatus', {
      value: this.runtimeStatus,
      exportName: `${projectName}-AgentRuntimeStatus`,
    })

    new cdk.CfnOutput(this, 'AgentRuntimeExecutionRoleArn', {
      value: this.executionRoleArn,
      exportName: `${projectName}-AgentRuntimeExecutionRoleArn`,
    })

    new cdk.CfnOutput(this, 'AgentImageUri', {
      value: this.imageUri,
      exportName: `${projectName}-AgentImageUri`,
    })

    new cdk.CfnOutput(this, 'ConversationMemoryId', {
      value: this.memoryId,
      exportName: `${projectName}-ConversationMemoryId`,
    })

    new cdk.CfnOutput(this, 'ConversationRetentionDays', {
      value: String(conversationRetentionDays),
      description: 'How long a recorded conversation is kept before the service expires it.',
    })

    new cdk.CfnOutput(this, 'DataKeyArn', {
      value: encryptionKey.keyArn,
      exportName: `${projectName}-DataKeyArn`,
    })
  }
}

/**
 * The content guardrail — the only layer here that reads what is said rather than who said it.
 *
 * Three policies, each answering a different question a pilot gets asked:
 *
 * - **Content filters** for the categories a deployment is expected to refuse outright.
 * - **`PROMPT_ATTACK`**, which is what recognizes a user talking the model out of its instructions.
 *   It is input-only by design: `outputStrength` must be `NONE`, because there is no such thing as
 *   an injection in the model's own answer, and setting it is a deploy-time error.
 * - **PII detection**, set to `ANONYMIZE` rather than `BLOCK`. Blocking would refuse the turn
 *   outright the moment someone types their own email address, which is a support ticket, not
 *   protection. Anonymizing lets the conversation continue while keeping the identifier out of what
 *   is sent onward and out of what gets recorded — `agent/src/agent.ts` persists the redacted
 *   message, not the original.
 *
 * Every strength and action here is a starting point a real deployment should revisit against its
 * own risk register. What the template guarantees is that the decision exists and is enforced.
 */
function createGuardrail(
  scope: Construct,
  projectName: string,
  encryptionKey: kms.IKey,
): { guardrailId: string; guardrailArn: string; guardrailVersion: string } {
  const filter = (type: string, strength: string) => ({
    type,
    inputStrength: strength,
    outputStrength: strength,
  })

  const guardrail = new bedrock.CfnGuardrail(scope, 'ContentGuardrail', {
    name: `${projectName}-guardrail`,
    description: `Content, prompt-attack and PII policy for ${projectName}.`,
    // Written for the person who hits it, not for a log: a filter that fires reads as a refusal the
    // user can act on rather than as an error they will report as a bug.
    blockedInputMessaging:
      'I can\'t help with that request. Try rephrasing it, or ask me something else.',
    blockedOutputsMessaging:
      'I started an answer I can\'t share. Ask me a different way and I\'ll try again.',
    kmsKeyArn: encryptionKey.keyArn,
    contentPolicyConfig: {
      filtersConfig: [
        filter('SEXUAL', 'HIGH'),
        filter('VIOLENCE', 'HIGH'),
        filter('HATE', 'HIGH'),
        filter('INSULTS', 'MEDIUM'),
        filter('MISCONDUCT', 'MEDIUM'),
        // Input-only, and not a mistake: see the note above.
        { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
      ],
    },
    sensitiveInformationPolicyConfig: {
      piiEntitiesConfig: [
        'EMAIL',
        'PHONE',
        'NAME',
        'ADDRESS',
        'CREDIT_DEBIT_CARD_NUMBER',
        'US_SOCIAL_SECURITY_NUMBER',
        'PASSWORD',
        'AWS_ACCESS_KEY',
        'AWS_SECRET_KEY',
      ].map((type) => ({ type, action: 'ANONYMIZE' })),
    },
  })

  /**
   * A numbered version, because the runtime is configured with one and `DRAFT` is a moving target:
   * an edit to the guardrail would change what the deployed agent enforces with no deployment and no
   * record of the change.
   *
   * The version is immutable, so a change to any policy above has to mint a new one. `logicalId`
   * carries a hash of the configuration for exactly that reason — without it CloudFormation would
   * update this resource in place, which the API refuses, and the deploy would fail with an error
   * that says nothing about why.
   */
  const version = new bedrock.CfnGuardrailVersion(scope, 'ContentGuardrailVersion', {
    guardrailIdentifier: guardrail.attrGuardrailId,
    description: 'Pinned by the agent runtime.',
  })
  version.overrideLogicalId(
    `ContentGuardrailVersion${cdk.Names.uniqueId(guardrail).slice(-8)}${hashOf(
      JSON.stringify(guardrail.contentPolicyConfig) + JSON.stringify(guardrail.sensitiveInformationPolicyConfig),
    )}`,
  )

  return {
    guardrailId: guardrail.attrGuardrailId,
    guardrailArn: guardrail.attrGuardrailArn,
    guardrailVersion: version.attrVersion,
  }
}

/** Eight hex characters of a stable digest — enough to make a logical id move when the policy does. */
function hashOf(input: string): string {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * The ARNs invoking one Bedrock model actually requires — two shapes, because a cross-region
 * inference profile is not the model. Naming a profile invokes it, and the profile invokes the
 * foundation model in whichever member region it routes to, so listing only one denies every call.
 * The region stays wildcarded because the routing decides it; what is pinned is *which model*.
 */
export function bedrockModelResources(
  scope: { partition: string; account: string },
  modelId: string,
): string[] {
  const [prefix, ...rest] = modelId.split('.')
  const isInferenceProfile =
    rest.length > 0 && ['global', 'us', 'eu', 'apac'].includes(prefix as string)
  const foundationModelId = isInferenceProfile ? rest.join('.') : modelId

  return [
    // Foundation-model ARNs carry no account: the model is AWS's, not the caller's.
    `arn:${scope.partition}:bedrock:*::foundation-model/${foundationModelId}`,
    ...(isInferenceProfile
      ? [`arn:${scope.partition}:bedrock:*:${scope.account}:inference-profile/${modelId}`]
      : []),
  ]
}

/**
 * The log group every signal from this agent lands in, and the deliveries that route them there.
 *
 * Four producers write here, which is the point: the container's stdout, the spans the container
 * exports over OTLP, the EMF records its metrics arrive as, and AgentCore's own application and
 * usage logs. Retention, encryption and masking are properties of a log group, so consolidating is
 * what lets one decision cover all four.
 */
export function createObservability(
  scope: Construct,
  options: {
    projectName: string
    encryptionKey: kms.IKey
    retentionDays: number
  },
): { logGroup: logs.LogGroup; metricNamespace: string } {
  const { projectName, encryptionKey, retentionDays } = options
  const stack = cdk.Stack.of(scope)

  /**
   * The destination half of the content policy.
   *
   * `span-redaction.ts` removes at the source what the Bedrock guardrail provably cannot reach — tool
   * arguments and tool results, where `get_signed_in_user` returns the caller's email. The model
   * prompt and completion deliberately survive that, because a trace that cannot reconstruct the
   * decision is the anti-pattern Well-Architected's Agentic AI Lens names. This is what covers them:
   * CloudWatch Logs detects these types and masks them, so a reader sees asterisks. Recovering the
   * original needs `logs:Unmask`, which nothing in this template grants to anyone — it is a
   * break-glass an operator has to add deliberately, and one CloudTrail records the use of.
   *
   * The same policy covers AgentCore's own `APPLICATION_LOGS`, whose `request_payload` carries the
   * identity block the BFF prepends. That payload is captured at HTTP ingress, before the container
   * runs, so no code of ours could have masked it at the source.
   */
  const dataProtectionPolicy = new logs.DataProtectionPolicy({
    name: `${projectName}-agent-masking`,
    description: 'Masks personal and credential data in agent telemetry.',
    identifiers: [
      logs.DataIdentifier.EMAILADDRESS,
      logs.DataIdentifier.NAME,
      logs.DataIdentifier.ADDRESS,
      logs.DataIdentifier.PHONENUMBER_US,
      logs.DataIdentifier.CREDITCARDNUMBER,
      logs.DataIdentifier.SSN_US,
      logs.DataIdentifier.CPFCODE_BR,
      logs.DataIdentifier.AWSSECRETKEY,
      logs.DataIdentifier.OPENSSHPRIVATEKEY,
      logs.DataIdentifier.IPADDRESS,
    ],
  })

  const logGroup = new logs.LogGroup(scope, 'AgentTelemetryLogs', {
    logGroupName: `/aws/vendedlogs/bedrock-agentcore/${projectName}`,
    // Matched to how long a conversation is kept, not to a number of its own. Telemetry describing a
    // turn that outlived the turn is a second copy of it under a different retention — and a longer
    // one here would quietly reopen the deletion promise the memory resource makes.
    retention: nearestRetention(retentionDays),
    encryptionKey,
    dataProtectionPolicy,
    // `DESTROY`, like every other log group in this template, and deliberately not `RETAIN`.
    //
    // `RETAIN` also applies to the rollback of the update that *created* the group: a deploy that
    // gets this far and then fails on anything later leaves the group orphaned in the account, no
    // longer tracked by the stack — and the next attempt fails with "already exists" before it does
    // anything else. For a template, that is a trap set for every fork's first deploy of this
    // feature, and clearing it needs a manual delete nobody expects to be asked for.
    //
    // Nothing is protected by retaining it. What is retained under `retainData` is the conversation
    // itself, in AgentCore Memory; this group holds telemetry *describing* turns, already bounded by
    // the retention above and already masked by the policy below it.
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  })

  // X-Ray writes the spans into the log group on the agent's behalf, so the *service* needs the
  // grant. Without it the endpoint answers 400 and the spans never appear.
  //
  // `CreateLogStream` as well as `PutLogEvents`, and the documentation does not say so: it states
  // the policy "must allow X-Ray (xray.amazonaws.com) to call logs:PutLogEvents on that log group"
  // and stops there. The `spans` stream does not exist until the first export, and X-Ray creates it
  // — so `PutLogEvents` alone fails with "Caller is not authorized to call [logs:CreateLogStream]".
  new logs.CfnResourcePolicy(scope, 'SpanDeliveryPolicy', {
    policyName: `${projectName}-xray-span-delivery`,
    policyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'TransactionSearchXRayAccess',
          Effect: 'Allow',
          Principal: { Service: 'xray.amazonaws.com' },
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          // `logGroupArn` already ends in `:*`, which covers the streams. Appending another — as
          // this did — renders `...:*:*` and matches nothing.
          Resource: [logGroup.logGroupArn],
          Condition: {
            ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:xray:${stack.region}:${stack.account}:*` },
            StringEquals: { 'aws:SourceAccount': stack.account },
          },
        },
      ],
    }),
  })

  return { logGroup, metricNamespace: `${projectName}/Agent` }
}

/**
 * Joins AgentCore's own signals to the telemetry log group.
 *
 * Separate from `createObservability`, and called after the runtime exists, because the delivery
 * source names the runtime by ARN — and the ARN is only knowable once CloudFormation has created it.
 * This used to be one function, which forced the source to be registered against a wildcard
 * (`...:runtime/*`) built before the runtime. CloudFormation accepted it and the console reported
 * three active deliveries, but a wildcard matches no runtime: `APPLICATION_LOGS` and `USAGE_LOGS`
 * delivered nothing, ever, and the agent's logs stayed in the log group AgentCore creates by
 * default — the one with no retention, no CMK and no data protection policy. The split is what lets
 * the source name the runtime it actually describes.
 */
export function createTelemetryDeliveries(
  scope: Construct,
  options: { projectName: string; logGroup: logs.LogGroup; runtimeArn: string },
): void {
  const { projectName, logGroup, runtimeArn } = options

  // AgentCore's own signals reach CloudWatch through vended-log delivery rather than by the runtime
  // writing them, so each needs a source, a destination and a delivery joining the two. Without
  // these three, the corresponding panes of the GenAI Observability console are simply blank.
  //
  // `TRACES` goes to X-Ray rather than to a log group: that is where the service files a span, and
  // Transaction Search is what puts it back in CloudWatch as a structured log.
  const deliveries: { logType: string; destinationType: 'CWL' | 'XRAY' }[] = [
    { logType: 'APPLICATION_LOGS', destinationType: 'CWL' },
    { logType: 'USAGE_LOGS', destinationType: 'CWL' },
    { logType: 'TRACES', destinationType: 'XRAY' },
  ]

  for (const { logType, destinationType } of deliveries) {
    const slug = logType.toLowerCase().replace(/_/g, '-')

    const source = new logs.CfnDeliverySource(scope, `AgentDeliverySource${logType}`, {
      name: `${projectName}-${slug}`,
      logType,
      resourceArn: runtimeArn,
    })

    const destination = new logs.CfnDeliveryDestination(scope, `AgentDeliveryDestination${logType}`, {
      name: `${projectName}-${slug}`,
      deliveryDestinationType: destinationType,
      // X-Ray as a destination names no resource — the service is the destination. Passing a log
      // group ARN alongside it is what makes CloudFormation reject the delivery.
      ...(destinationType === 'CWL' ? { destinationResourceArn: logGroup.logGroupArn } : {}),
    })

    const delivery = new logs.CfnDelivery(scope, `AgentDelivery${logType}`, {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
    })
    // A delivery names its source and destination by name and ARN, which CloudFormation cannot see
    // as a dependency — without these it may try to create the delivery first and fail.
    delivery.addResourceDependency(source)
    delivery.addResourceDependency(destination)
  }
}

/**
 * The shortest CloudWatch retention that is at least `days`.
 *
 * CloudWatch accepts a fixed set of values, and a conversation retention of, say, 45 days is not one
 * of them. Rounding *up* rather than down so telemetry never outlives less than the conversation it
 * describes — the opposite would create a window where a turn is deleted while its trace is not.
 */
export function nearestRetention(days: number): logs.RetentionDays {
  const allowed = Object.values(logs.RetentionDays).filter(
    (value): value is number => typeof value === 'number',
  )

  const match = allowed.sort((a, b) => a - b).find((value) => value >= days)

  return (match ?? logs.RetentionDays.TEN_YEARS) as logs.RetentionDays
}
