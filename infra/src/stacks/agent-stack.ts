import * as cdk from 'aws-cdk-lib'
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore'
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets'
import * as iam from 'aws-cdk-lib/aws-iam'
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

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props)

    const { projectName, imagePlatform, runtimeEnvironment, modelId } = props

    const agentDirectory = fileURLToPath(new URL('../../../agent', import.meta.url))

    const imageAsset = new ecrassets.DockerImageAsset(this, 'AgentImage', {
      directory: agentDirectory,
      platform: imagePlatform,
    })

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
    this.runtimeStatus = runtime.attrStatus
    this.executionRoleArn = runtimeRole.roleArn
    this.imageUri = imageAsset.imageUri

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
  }
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
