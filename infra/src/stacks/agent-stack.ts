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
 * The runtime carries **no authorizer configuration**, which is what makes it SigV4-only: the sole
 * caller is the BFF's chat function, holding `bedrock-agentcore:InvokeAgentRuntime` on this one ARN
 * (see `BffStack`). No browser can reach it.
 *
 * That is a security boundary, not a deployment preference. The agent learns who is asking from an
 * identity block the BFF prepends to the prompt, built from claims the API Gateway Cognito
 * authorizer already verified. A block is only as trustworthy as the transport that carried it — so
 * the transport has to be one nothing but the BFF can speak.
 *
 * Adding a Cognito JWT authorizer here would let the browser call the runtime directly, which makes
 * the identity block client-supplied text: any signed-in user could name another user's `sub` and
 * have the agent's tools act for them. Do not add one unless the block becomes a signed token the
 * runtime itself verifies.
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
          // The asset's own repository. A wildcard here let a compromised container read every
          // image in the account — a fast way to enumerate what else the organization builds, and
          // to pull layers that were never meant to be readable from this workload.
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
          // Its own log groups. Account-wide `DescribeLogGroups` is a listing of every workload in
          // the account, which is reconnaissance handed to whatever runs in the container.
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
          // The model this agent is configured to use, and nothing else.
          //
          // `foundation-model/*` in every region, plus `bedrock:*` in this account, is a budget with
          // no ceiling and a data path with no boundary: a compromised container could invoke any
          // model in any region — including regions the deployment was never reviewed for, which is
          // a data-residency problem as much as a cost one.
          //
          // A cross-region inference profile fans out to the foundation model in each of its member
          // regions, so both ARN shapes are needed: the profile the caller names, and the model the
          // profile resolves to. The foundation-model ARN is account-less by AWS's own convention.
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

    // A tool that reaches a backend signs its own request with this role's credentials, so the
    // grant goes here — e.g. `someLambda.grantInvoke(runtimeRole)` or a Function URL's
    // `grantInvokeUrl(runtimeRole)`. Keeping the grant on the *runtime* role rather than on a
    // shared one is what bounds what a compromised container can reach.

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
        // Explicit, so the container runs the model its role is scoped to rather than falling back
        // to its own default and being denied by IAM.
        BEDROCK_MODEL_ID: modelId,
        // Anything a tool needs to find its backend goes here — a Function URL, a table name. The
        // agent should register such a tool only when its configuration is present, so an
        // unconfigured deployment offers no tool rather than one that fails on every call.
        ...runtimeEnvironment,
      }),
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 900,
        maxLifetime: 14400,
      },
      // No `authorizerConfiguration`, deliberately — see the note on the class above: without one
      // the runtime accepts SigV4 only, so the BFF's execution role is its single caller and a
      // browser has no path to it at all.
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
 * The ARNs that invoking one Bedrock model actually requires.
 *
 * Two shapes, because a cross-region inference profile is not the model. Naming a profile
 * (`global.…`, `us.…`) invokes it, and the profile in turn invokes the foundation model in whichever
 * member region it routes to — so a policy listing only one of the two denies every call.
 *
 * The region stays wildcarded for exactly that reason: the routing decides it, and a cross-region
 * profile that could only reach one region is not one. What is pinned is the part that matters —
 * *which model*, rather than every model Bedrock offers.
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
