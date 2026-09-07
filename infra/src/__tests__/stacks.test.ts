/**
 * Synthesized-template assertions for the security and correctness properties this template must not
 * lose — each names the failure it guards against.
 *
 * `AgentStack` is never *constructed* here: its `DockerImageAsset` triggers a real `docker build` at
 * synth time, which a unit-test run must not need. `BffStack` and `FrontendStack` take
 * `agentRuntimeArn` as a plain string, so a stub is enough. The module is still imported — building
 * happens on construction, not on import — so the pure parts of it, like the Bedrock ARN
 * derivation, are tested directly rather than being read off the source.
 *
 * `FrontendStack` does need `../chatbot-frontend/dist` on disk: `s3deploy.Source.asset()` reads real
 * files at synth, unlike `lambda.Code.fromAsset()`. `npm run pretest` builds it — run `npx vitest
 * run` directly and the last suite fails with `CannotFindAsset`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as cdk from 'aws-cdk-lib'
import * as kms from 'aws-cdk-lib/aws-kms'
import { Match, Template } from 'aws-cdk-lib/assertions'
import {
  bedrockModelResources,
  createObservability,
  createTelemetryDeliveries,
  governRuntimeLogGroup,
} from '../stacks/agent-stack.js'
import { AuthStack } from '../stacks/auth-stack.js'
import { BffStack } from '../stacks/bff-stack.js'
import { FrontendStack } from '../stacks/frontend-stack.js'
import type { Construct } from 'constructs'

const env = { account: '123456789012', region: 'us-east-1' }
const FAKE_RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/fake-runtime-id'
const FAKE_MEMORY_ID = 'test_conversations-abc123'
const FAKE_MEMORY_ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/${FAKE_MEMORY_ID}`
const FAKE_KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000'

/**
 * The props `BffStack` gets from `AgentStack` in the real app. Imported rather than constructed: an
 * imported key renders as a literal ARN instead of a cross-stack export, which keeps these templates
 * readable and lets an assertion name the value it expects.
 */
function upstreamProps(scope: Construct) {
  return {
    agentRuntimeArn: FAKE_RUNTIME_ARN,
    memoryId: FAKE_MEMORY_ID,
    memoryArn: FAKE_MEMORY_ARN,
    encryptionKey: kms.Key.fromKeyArn(scope, 'TestDataKey', FAKE_KEY_ARN),
    conversationRetentionDays: 30,
    modelId: 'us.anthropic.claude-sonnet-5',
  }
}

type PolicyStatement = { Action?: string | string[]; Resource?: string | string[] }

/**
 * The statements attached to the role of the function whose handler path is `handler`.
 *
 * Joined through the execution role rather than by logical-id prefix: CDK gives the function and its
 * default policy independently hashed ids, so a prefix match silently returns nothing.
 */
function statementsForHandler(template: Template, handler: string): PolicyStatement[] {
  const functions = Object.values(
    template.findResources('AWS::Lambda::Function', { Properties: { Handler: handler } }),
  )
  expect(functions).toHaveLength(1)

  const roleId = (functions[0].Properties.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0]
  const policies = template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: roleId }]) },
  })
  expect(Object.keys(policies).length).toBeGreaterThan(0)

  return Object.values(policies).flatMap((policy) => {
    const doc = policy.Properties?.PolicyDocument as { Statement?: PolicyStatement[] }
    return doc?.Statement ?? []
  })
}

function synthAuth(props: Partial<ConstructorParameters<typeof AuthStack>[2]> = {}) {
  const app = new cdk.App()
  const stack = new AuthStack(app, 'TestAuth', { projectName: 'test', env, ...props })
  return { stack, template: Template.fromStack(stack) }
}

describe('AuthStack — the browser gets a token and nothing else', () => {
  // An Identity Pool vends AWS credentials to a signed-in browser, and one whose role carried
  // `InvokeAgentRuntime` would let any user reach the runtime and name *another* in the identity
  // block. Absence is asserted because adding a pool back is a natural thing to do by habit.
  it('creates no Cognito Identity Pool', () => {
    const { template } = synthAuth()

    template.resourceCountIs('AWS::Cognito::IdentityPool', 0)
    template.resourceCountIs('AWS::Cognito::IdentityPoolRoleAttachment', 0)
  })

  it('creates no role a browser could assume through Cognito', () => {
    const { template } = synthAuth()

    // Identified by the trust policy rather than by a logical id, so a differently-named role with
    // the same federated principal is caught too.
    const federated = template.findResources('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Principal: { Federated: 'cognito-identity.amazonaws.com' } }),
          ]),
        },
      },
    })
    expect(Object.keys(federated)).toHaveLength(0)

    // And no `sts:AssumeRoleWithWebIdentity` anywhere, which is the action any such path needs.
    expect(JSON.stringify(template.toJSON())).not.toContain('sts:AssumeRoleWithWebIdentity')
  })

  it('grants InvokeAgentRuntime to nothing in this stack', () => {
    const { template } = synthAuth()

    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
    const statements = policies.flatMap(
      (p) =>
        ((p.Properties as { PolicyDocument?: { Statement?: { Action?: unknown }[] } })
          .PolicyDocument?.Statement ?? []),
    )
    const actions = statements.flatMap((st) =>
      Array.isArray(st.Action) ? st.Action : st.Action ? [st.Action] : [],
    )
    expect(actions).not.toContain('bedrock-agentcore:InvokeAgentRuntime')
  })

  it('exports no identity pool for another stack to import', () => {
    // Exports make a pool painful to remove later: CloudFormation refuses to delete one still
    // imported, and `auth` deploys first. An added pool fails here rather than at deploy time.
    const { template } = synthAuth()
    const outputs =
      (template.toJSON() as { Outputs?: Record<string, { Export?: { Name?: string } }> }).Outputs ??
      {}
    const exports = Object.values(outputs)
      .map((o) => o.Export?.Name)
      .filter((n): n is string => typeof n === 'string')

    expect(exports.some((n) => n.toLowerCase().includes('identitypool'))).toBe(false)
    expect(exports.some((n) => n.includes('AuthenticatedRole'))).toBe(false)
  })
})

describe('AuthStack — Cognito schema', () => {
  // Naming this `locale` would collide with a reserved standard attribute: CDK renders a custom
  // attribute as a bare { Name, AttributeDataType } entry with no `custom:` prefix, so it becomes
  // indistinguishable from declaring the standard one. Cognito then never creates `custom:locale`.
  it('names the locale attribute inviteLocale, not the reserved locale', () => {
    const { template } = synthAuth()
    const pool = template.findResources('AWS::Cognito::UserPool')
    const schema = Object.values(pool)[0].Properties.Schema as { Name: string }[]
    const names = schema.map((entry) => entry.Name)

    expect(names).toContain('inviteLocale')
    expect(names).not.toContain('locale')
  })
})

describe('AuthStack — publicSignUpEnabled', () => {
  it('blocks the public SignUp API when invite-only', () => {
    const { template } = synthAuth({ publicSignUpEnabled: false })

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    })
  })

  it('allows self sign-up by default', () => {
    const { template } = synthAuth()

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    })
  })
})

describe('AuthStack — retainData', () => {
  // Losing every account is not recoverable; an orphaned pool is. The default has to be Retain.
  it('retains the user pool by default', () => {
    const { template } = synthAuth()
    const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0]

    expect(pool.DeletionPolicy).toBe('Retain')
  })

  it('destroys the user pool when explicitly opted out', () => {
    const { template } = synthAuth({ retainData: false })
    const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0]

    expect(pool.DeletionPolicy).toBe('Delete')
  })
})

function synthBff(
  overrides: {
    alertEmail?: string
    monthlyBudgetUsd?: number
    allowedOrigin?: string
    wafEnabled?: boolean
    tracingEnabled?: boolean
  } = {},
) {
  const app = new cdk.App()
  const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
  const stack = new BffStack(app, 'TestBff', {
    projectName: 'test',
    userPool: auth.userPool,
    throttle: { rateLimit: 10, burstLimit: 20 },
    ...upstreamProps(auth),
    env,
    ...overrides,
  })
  return { stack, template: Template.fromStack(stack) }
}

describe('BffStack — Lambda timeouts vs the API Gateway integration ceiling', () => {
  // API Gateway's REST integration timeout is a hard 29s for a buffered response, so a longer Lambda
  // timeout only keeps billing after the gateway has returned 504 to a client that is gone.
  it('caps the buffered admin function at the 29s integration ceiling', () => {
    const { template } = synthBff()

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/admin-handler.handler',
      Timeout: 29,
    })
  })

  // The chat function streams (ResponseTransferMode.STREAM), so it isn't held to the same buffered
  // cap — API Gateway keeps the connection open as long as data keeps flowing.
  it('leaves the streaming chat function above the buffered ceiling', () => {
    const { template } = synthBff()

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/handler.handler',
      Timeout: 60,
    })
  })
})

describe('BffStack — admin IAM scope', () => {
  it('grants the admin function only the specific Cognito actions it needs, on this pool', () => {
    const { template } = synthBff()

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'cognito-idp:ListUsers',
              'cognito-idp:ListUsersInGroup',
              'cognito-idp:AdminCreateUser',
              'cognito-idp:AdminAddUserToGroup',
            ]),
          }),
        ]),
      },
    })
  })
})

describe('BffStack — allowedOrigin', () => {
  // Both the Lambdas' ALLOWED_ORIGIN env var and the API Gateway CORS config have to read this prop.
  // Hardcoding '*' in either would make configuring it a no-op — see the note in bff-stack.ts.
  it('defaults both Lambdas and the CORS preflight to the wildcard', () => {
    const { template } = synthBff()

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/handler.handler',
      Environment: { Variables: Match.objectLike({ ALLOWED_ORIGIN: '*' }) },
    })
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/admin-handler.handler',
      Environment: { Variables: Match.objectLike({ ALLOWED_ORIGIN: '*' }) },
    })
  })

  it('propagates a configured origin to both Lambdas and locks the CORS preflight to it', () => {
    const { template } = synthBff({ allowedOrigin: 'https://app.example.com' })

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/handler.handler',
      Environment: {
        Variables: Match.objectLike({ ALLOWED_ORIGIN: 'https://app.example.com' }),
      },
    })
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/admin-handler.handler',
      Environment: {
        Variables: Match.objectLike({ ALLOWED_ORIGIN: 'https://app.example.com' }),
      },
    })

    // The OPTIONS mock integration response is where CDK's CORS helper renders the allowed origin.
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      Integration: Match.objectLike({
        IntegrationResponses: Match.arrayWith([
          Match.objectLike({
            ResponseParameters: Match.objectLike({
              'method.response.header.Access-Control-Allow-Origin': "'https://app.example.com'",
            }),
          }),
        ]),
      }),
    })
  })
})

describe('BffStack — per-caller rate limit', () => {
  it('wires the default limit into the chat function and scopes IAM to UpdateItem only', () => {
    const { template } = synthBff()

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/handler.handler',
      Environment: {
        Variables: Match.objectLike({
          USER_RATE_LIMIT: '20',
          USER_RATE_LIMIT_WINDOW_SECONDS: '60',
        }),
      },
    })

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    })

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'dynamodb:UpdateItem' }),
        ]),
      },
    })
  })

  it('propagates a configured limit to the chat function', () => {
    const app = new cdk.App()
    const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
    const stack = new BffStack(app, 'TestBff', {
      projectName: 'test',
      userPool: auth.userPool,
      throttle: { rateLimit: 10, burstLimit: 20 },
      userRateLimit: { limit: 5, windowSeconds: 30 },
      ...upstreamProps(auth),
      env,
    })
    const template = Template.fromStack(stack)

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/handler.handler',
      Environment: {
        Variables: Match.objectLike({
          USER_RATE_LIMIT: '5',
          USER_RATE_LIMIT_WINDOW_SECONDS: '30',
        }),
      },
    })
  })
})

describe('BffStack — budget', () => {
  it('creates no budget when the email or the ceiling is missing', () => {
    expect(Object.keys(synthBff().template.findResources('AWS::Budgets::Budget'))).toHaveLength(0)
    expect(
      Object.keys(
        synthBff({ alertEmail: 'ops@example.com' }).template.findResources(
          'AWS::Budgets::Budget',
        ),
      ),
    ).toHaveLength(0)
  })

  it('creates a budget once both are set', () => {
    const { template } = synthBff({ alertEmail: 'ops@example.com', monthlyBudgetUsd: 200 })

    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetLimit: { Amount: 200, Unit: 'USD' } },
    })
  })
})

describe('BffStack — the evidence layer a pilot is asked for', () => {
  /**
   * Tracing is the difference between "a user says it broke" and a request an operator can open.
   * Off by default because X-Ray bills per trace and this template's promise is that an unset
   * profile costs nothing; the gate in config.ts is what makes that safe rather than the default.
   */
  it('records no traces until asked to', () => {
    const { template } = synthBff()

    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      expect(fn.Properties?.TracingConfig).toBeUndefined()
    }
    template.hasResourceProperties('AWS::ApiGateway::Stage', { TracingEnabled: false })
  })

  it('traces every function and the stage when it is', () => {
    const { template } = synthBff({ tracingEnabled: true })

    // Enumerated rather than listed by name: a fourth function added later is covered by this test
    // the day it appears, instead of silently becoming the one blind spot in a trace.
    const functions = Object.values(template.findResources('AWS::Lambda::Function'))
    expect(functions).toHaveLength(3)
    for (const fn of functions) {
      expect(fn.Properties?.TracingConfig).toEqual({ Mode: 'Active' })
    }

    // The stage segment is the root: without it the Lambda segments have no parent, and the
    // gateway's own latency — the half a user actually feels — is missing from every trace.
    template.hasResourceProperties('AWS::ApiGateway::Stage', { TracingEnabled: true })
  })

  /**
   * "Encrypted" and "encrypted under a key we control" are different answers to a pilot's security
   * review. Enumerated, because a store added later without a key is exactly the regression that
   * would otherwise go unnoticed.
   */
  it('encrypts every log group, table and topic with the deployment key', () => {
    const { template } = synthBff({ alertEmail: 'ops@example.com' })

    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'))
    expect(logGroups).toHaveLength(4)
    for (const group of logGroups) {
      expect(group.Properties?.KmsKeyId).toBe(FAKE_KEY_ARN)
    }

    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'))
    expect(tables).toHaveLength(2)
    for (const table of tables) {
      expect(table.Properties?.SSESpecification).toMatchObject({ SSEEnabled: true })
      expect(table.Properties?.SSESpecification?.KMSMasterKeyId).toBe(FAKE_KEY_ARN)
    }

    // An alarm body names the function and the deployment, so the topic is a store too.
    template.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: FAKE_KEY_ARN })
  })

  /** The index has to expire with the conversations it points at, or the sidebar fills with rows
   * that open empty. */
  it('gives the conversation index a TTL rather than letting it accumulate forever', () => {
    const { template } = synthBff()

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-bff-conversations',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    })
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/handler.handler',
      Environment: { Variables: Match.objectLike({ CONVERSATION_RETENTION_DAYS: '30' }) },
    })
  })
})

describe('BffStack — which function can read a conversation', () => {
  const actions = (statements: PolicyStatement[]) =>
    statements.flatMap((statement) =>
      typeof statement.Action === 'string' ? [statement.Action] : (statement.Action ?? []),
    )

  /**
   * The reason there is a third function at all. The chat function relays untrusted model output; if
   * it could also read stored conversations, a compromise there would reach every past turn of every
   * user rather than the one being served.
   */
  it('keeps every conversation read off the function that relays model output', () => {
    const { template } = synthBff()
    const chat = actions(statementsForHandler(template, 'dist/handler.handler'))

    expect(chat.sort()).toEqual(
      [
        'bedrock-agentcore:InvokeAgentRuntime',
        'dynamodb:UpdateItem',
        // The cost of encrypting the tables it writes, not a widening of what it can reach:
        // DynamoDB uses the customer-managed key as the caller.
        'kms:Decrypt',
        'kms:Encrypt',
        'kms:GenerateDataKey*',
        'kms:ReEncrypt*',
      ].sort(),
    )
  })

  /** The mirror: the function that can read conversations must not be able to invoke the model. */
  it('keeps the model out of reach of the function that reads conversations', () => {
    const { template } = synthBff()
    const conversations = actions(
      statementsForHandler(template, 'dist/conversations-handler.handler'),
    )

    expect(conversations.sort()).toEqual(
      [
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:DeleteEvent',
        'dynamodb:Query',
        'dynamodb:DeleteItem',
        // Stored events and the index are both encrypted under the deployment key, and both are
        // read through it by the caller.
        'kms:Decrypt',
        'kms:Encrypt',
        'kms:GenerateDataKey*',
        'kms:ReEncrypt*',
      ].sort(),
    )
  })

  /**
   * Recording a turn is the agent's job. A route reachable from a browser that could write history
   * could also forge it — and a forged transcript is worse than no transcript, because it is
   * believed.
   */
  it('lets no browser-reachable function write conversation history', () => {
    const { template } = synthBff()

    for (const handler of ['dist/handler.handler', 'dist/conversations-handler.handler', 'dist/admin-handler.handler']) {
      expect(actions(statementsForHandler(template, handler))).not.toContain(
        'bedrock-agentcore:CreateEvent',
      )
    }
  })

  /**
   * A wildcard here would let this function read and erase conversations in any memory resource and
   * any table in the account — including another deployment sharing it.
   */
  it('scopes every conversation grant to this deployment memory and table', () => {
    const { template } = synthBff()

    for (const statement of statementsForHandler(template, 'dist/conversations-handler.handler')) {
      // Resources arrive as strings, arrays, or intrinsic objects; comparing the serialized form
      // catches a wildcard in any of those shapes.
      expect(JSON.stringify(statement.Resource)).not.toContain('"*"')
    }

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/conversations-handler.handler',
      Environment: {
        Variables: Match.objectLike({
          AGENTCORE_MEMORY_ID: FAKE_MEMORY_ID,
          // A `Ref` to the table, not a literal — the name is resolved at deploy time.
          CONVERSATION_TABLE_NAME: Match.anyValue(),
        }),
      },
    })
  })
})

function synthFrontend() {
  const app = new cdk.App()
  const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
  const bff = new BffStack(app, 'TestBff', {
    projectName: 'test',
    userPool: auth.userPool,
    throttle: { rateLimit: 10, burstLimit: 20 },
    ...upstreamProps(auth),
    env,
  })
  const frontend = new FrontendStack(app, 'TestFrontend', {
    projectName: 'test',
    bffUrl: bff.apiUrl,
    cognitoUserPoolId: auth.userPool.userPoolId,
    cognitoUserPoolClientId: auth.userPoolClient.userPoolClientId,
    cognitoRegion: env.region,
    publicSignUpEnabled: true,
    env,
  })
  return { stack: frontend, template: Template.fromStack(frontend) }
}

describe('BffStack — every route is authenticated, and the chat role stays narrow', () => {
  it('gates every method on the API behind the Cognito authorizer', () => {
    const { template } = synthBff()

    // Both handlers fail closed without verified claims, which only holds if no route reaches one
    // unauthenticated. Asserted over *every* method rather than a known list, so a new route is
    // covered the day it is added. `OPTIONS` is exempt: a preflight carries no Authorization header.
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).filter(
      (m) => m.Properties.HttpMethod !== 'OPTIONS',
    )
    expect(methods.length).toBeGreaterThan(0)

    for (const method of methods) {
      expect(method.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS')
      expect(method.Properties.AuthorizerId).toBeDefined()
    }
  })

  it('keeps every privileged grant off the function that relays model output', () => {
    const { template } = synthBff()

    // The two-function split only means anything if the chat role cannot do what the admin role
    // can. This is the invariant to preserve when the template grows a route that does something
    // consequential: give it its own function, and leave this role alone.
    const chatStatements = statementsForHandler(template, 'dist/handler.handler')
    const rendered = JSON.stringify(chatStatements)

    expect(rendered).not.toContain('cognito-idp:')
    expect(rendered).not.toContain('secretsmanager')
    expect(rendered).not.toContain('sns:Publish')
    expect(rendered).not.toContain('lambda:InvokeFunctionUrl')

    // What it may do, exhaustively: invoke the one runtime, meter its own caller, and use the key
    // those tables are encrypted with. The KMS actions are not a widening of what this role can
    // reach — DynamoDB uses a customer-managed key *as the caller*, so they are the cost of
    // encrypting the two tables it already writes.
    const actions = chatStatements
      .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter((a) => typeof a === 'string' && !String(a).startsWith('logs:'))
    expect(actions.sort()).toEqual([
      'bedrock-agentcore:InvokeAgentRuntime',
      'dynamodb:UpdateItem',
      'kms:Decrypt',
      'kms:Encrypt',
      'kms:GenerateDataKey*',
      'kms:ReEncrypt*',
    ])

    // And the key it may use is *the* key. A wildcard here would reach every key in the account,
    // including ones protecting stores this function has no business decrypting.
    for (const statement of chatStatements) {
      if (!JSON.stringify(statement.Action).includes('kms:')) continue
      expect(JSON.stringify(statement.Resource)).not.toContain('"*"')
    }
  })
})

describe('FrontendStack — cache-control split', () => {
  // A BucketDeployment carries one cache-control, so `immutable, max-age=31536000` on everything
  // would include index.html — the file naming the content-hashed bundles. A browser told to keep it
  // for a year goes on requesting bundle names from a build that no longer exists.
  it('caches hashed assets forever but never the entrypoint', () => {
    const { template } = synthFrontend()

    const deployments = Object.values(
      template.findResources('Custom::CDKBucketDeployment'),
    ) as { Properties: { SystemMetadata?: { 'cache-control'?: string } } }[]
    const cacheControls = deployments
      .map((resource) => resource.Properties.SystemMetadata?.['cache-control'])
      .filter((value): value is string => Boolean(value))
      .sort()

    expect(cacheControls).toEqual(
      ['no-cache, must-revalidate', 'public, max-age=31536000, immutable'].sort(),
    )
  })
})

describe('FrontendStack — security response headers', () => {
  // Mitigating control for the SPA keeping Cognito tokens in localStorage (see the note in
  // frontend-stack.ts): a strict script-src is what stops an injected <script> from ever running
  // long enough to read them.
  it('sends a CSP that blocks inline/injected scripts, and attaches it to the distribution', () => {
    const { template } = synthFrontend()

    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy', {
      Properties: {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            ContentSecurityPolicy: Match.objectLike({
              ContentSecurityPolicy: Match.stringLikeRegexp("script-src 'self'"),
            }),
          }),
        }),
      },
    })
    const policyIds = Object.keys(policies)
    expect(policyIds).toHaveLength(1)

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: { Ref: policyIds[0] },
        }),
      }),
    })
  })
})

describe('the pilot posture is in the template, not only in the README', () => {
  it('enrols every user in a second factor when MFA is required', () => {
    const { template } = synthAuth({ profile: 'pilot', mfa: 'required' })

    // An account here reads and continues someone's conversations. `OPTIONAL` would mean most
    // people never enrol, which is the same as `OFF` with better paperwork.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      // An authenticator app, and only that. Nothing in this application collects a phone number,
      // so an SMS factor would be one no user could enroll in — while still provisioning an SNS
      // caller role and putting a dead-end branch in the sign-in journey.
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    })
    template.resourceCountIs('AWS::IAM::Role', 1) // the CustomMessage function's, not an SNS caller
  })

  it('never offers SMS as a factor, in any MFA mode', () => {
    // Nothing in this application writes a phone number, so an SMS factor is one no user could
    // enroll in — while still provisioning an SNS caller role and adding a branch to the sign-in
    // journey that dead-ends.
    for (const mfa of ['optional', 'required'] as const) {
      const { template } = synthAuth({ profile: 'pilot', mfa })
      const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0]
      const props = pool?.Properties as Record<string, unknown>

      expect(props.EnabledMfas, mfa).toEqual(['SOFTWARE_TOKEN_MFA'])
      expect(props.SmsConfiguration, mfa).toBeUndefined()
    }
  })

  it('costs nothing and changes nothing when no profile is set', () => {
    // The guarantee an operator upgrading the template needs: with no environment set, this renders
    // what it rendered before any of the pilot posture existed. Every hardening below is opt-in,
    // and each entry here is something that either bills or forces a resource change.
    const { template } = synthAuth()
    const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0]
    const props = pool?.Properties as Record<string, unknown>

    // Billed per monthly active user the moment it appears.
    expect(props.UserPoolTier).toBeUndefined()
    expect(props.UserPoolAddOns).toBeUndefined()
    // Omitted rather than written as an explicit OFF, which Cognito defaults to anyway — an
    // upgrade of the template should not show up as a change to the infrastructure.
    expect(props.MfaConfiguration).toBeUndefined()
    expect(props.SmsConfiguration).toBeUndefined()

    // Not merely a default: Cognito cannot add a standard attribute to a live pool — CloudFormation
    // tries `AddCustomAttributes` and the deploy fails with "Invalid AttributeDataType input". A
    // schema that grows by default breaks every existing deployment.
    const names = (props.Schema as { Name: string }[]).map((a) => a.Name)
    expect(names).not.toContain('phone_number')
    expect(names).toEqual(['email', 'inviteLocale'])
  })

  it('never puts a phone number in the schema, in any configuration', () => {
    // Adding a standard attribute to a live pool is not a deferred decision — Cognito refuses it and
    // CloudFormation fails the update with "Invalid AttributeDataType input". A schema that varies
    // by configuration is therefore a schema that breaks somebody's deploy.
    for (const props of [{}, { profile: 'pilot' as const, mfa: 'required' as const }]) {
      const { template } = synthAuth(props)
      const pool = Object.values(template.findResources('AWS::Cognito::UserPool'))[0]
      const names = ((pool?.Properties as { Schema: { Name: string }[] }).Schema).map((a) => a.Name)

      expect(names).toEqual(['email', 'inviteLocale'])
    }
  })

  it('raises the password floor outside a demo', () => {
    const { template } = synthAuth({ profile: 'pilot', mfa: 'required' })

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: Match.objectLike({ MinimumLength: 12, RequireSymbols: true }),
      },
    })
  })

  it('only moves the pool onto the billed feature plan when asked to', () => {
    const off = synthAuth({ profile: 'pilot', mfa: 'required' })
    off.template.hasResourceProperties(
      'AWS::Cognito::UserPool',
      Match.not(Match.objectLike({ UserPoolTier: 'PLUS' })),
    )

    const on = synthAuth({ profile: 'pilot', mfa: 'required', threatProtection: 'enforced' })
    on.template.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTier: 'PLUS' })
  })

  it('puts a web ACL in front of the API stage when the WAF is on', () => {
    const { template } = synthBff({ wafEnabled: true })

    // The layer the other controls do not cover: the stage throttle bounds the account without
    // saying who spent it, and the per-caller quota only engages after authentication.
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
    })
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1)

    const acl = Object.values(template.findResources('AWS::WAFv2::WebACL'))[0]
    const rules = (acl?.Properties as { Rules: { Name: string; Action?: unknown }[] }).Rules
    const names = rules.map((r) => r.Name)
    expect(names).toContain('AWSManagedRulesCommonRuleSet')
    expect(names).toContain('AWSManagedRulesKnownBadInputsRuleSet')
    expect(names).toContain('RateLimitPerIp')

    // Every rule blocks. A managed group left in count mode is a dashboard, and a pilot that needs
    // a dashboard needs a decision.
    const rateRule = rules.find((r) => r.Name === 'RateLimitPerIp')
    expect(rateRule?.Action).toEqual({ Block: {} })
  })

  it('adds no ACL to a demo that did not ask for one', () => {
    const { template } = synthBff()
    template.resourceCountIs('AWS::WAFv2::WebACL', 0)
  })
})

describe('the runtime is reachable over SigV4 and nothing else', () => {
  /**
   * The property the whole design rests on, and the one every other assertion here assumes: the
   * runtime carries no `authorizerConfiguration`, so it accepts signed requests alone and the BFF's
   * role — the only principal granted `InvokeAgentRuntime` — is its only caller.
   *
   * Adding a JWT authorizer would give the browser a direct path, and the identity block the agent
   * trusts is plain text: any signed-in user could then compose one naming another user's `sub`.
   * Read off the source rather than the synthesized template because constructing `AgentStack`
   * triggers a real `docker build` — see the note at the top of this file.
   */
  it('declares no authorizer configuration on the runtime', () => {
    const source = readFileSync(new URL('../stacks/agent-stack.ts', import.meta.url), 'utf8')

    // A property assignment, not the comment that explains the absence — hence the line anchor.
    expect(source).not.toMatch(/^\s*authorizerConfiguration\s*:/m)
    // The only thing that configuration can carry, in case it ever arrives spread or aliased.
    expect(source).not.toContain('customJwtAuthorizer')
  })
})

describe('the agent may invoke one model, not every model', () => {
  /**
   * `AgentStack` builds a real container image at synth, so it is not constructed here — the ARN
   * derivation is exported and tested directly, and the rest is read off the source, matching the
   * approach already used for the identity-key assertion above.
   */
  const scope = { partition: 'aws', account: '123456789012' }

  it('covers both the inference profile and the model it resolves to', () => {
    // A cross-region profile invokes the foundation model in whichever member region it routes to,
    // so a policy naming only one of the two denies every call.
    const arns = bedrockModelResources(scope, 'us.anthropic.claude-sonnet-5')

    expect(arns).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5')
    expect(arns).toContain(
      'arn:aws:bedrock:*:123456789012:inference-profile/us.anthropic.claude-sonnet-5',
    )
  })

  it('names the model directly when the id is not a profile', () => {
    const arns = bedrockModelResources(scope, 'anthropic.claude-sonnet-5')

    expect(arns).toEqual(['arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5'])
  })

  it('never widens to every model or every Bedrock resource', () => {
    // The posture this replaced: `foundation-model/*` in every region plus `bedrock:*` in the
    // account — a budget with no ceiling and a data path with no boundary.
    for (const id of ['us.anthropic.claude-sonnet-5', 'anthropic.claude-sonnet-5']) {
      for (const arn of bedrockModelResources(scope, id)) {
        expect(arn).not.toMatch(/foundation-model\/\*/)
        expect(arn).not.toMatch(/:bedrock:[^:]*:[^:]*:\*$/)
      }
    }
  })

  it('scopes the container registry and the log listing to its own resources', () => {
    const source = readFileSync(new URL('../stacks/agent-stack.ts', import.meta.url), 'utf8')

    // A wildcard ECR grant let a compromised container read every image in the account; an
    // account-wide DescribeLogGroups is a listing of every workload in it.
    expect(source).toContain('imageAsset.repository.repositoryArn')
    expect(source).not.toContain("resource: 'repository', resourceName: '*'")
    const describeBlock = source.slice(source.indexOf("sid: 'DescribeLogGroups'"))
    expect(describeBlock.slice(0, 600)).toContain('/aws/bedrock-agentcore/runtimes/*')
  })
})

/**
 * `AgentStack` itself cannot be constructed here — see the note at the top of this file — so the
 * observability wiring is synthesized on its own, into a bare stack, the same way
 * `bedrockModelResources` is exercised as a pure function.
 */
describe('AgentStack — agent telemetry', () => {
  const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-aBcDeF1234'

  function synthObservability(retentionDays = 30) {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'TestTelemetry', { env })
    const key = new kms.Key(stack, 'Key')

    const result = createObservability(stack, {
      projectName: 'test',
      encryptionKey: key,
      retentionDays,
    })

    // A concrete runtime ARN, never a wildcard — see the regression test below.
    createTelemetryDeliveries(stack, {
      projectName: 'test',
      logGroup: result.logGroup,
      runtimeArn: RUNTIME_ARN,
    })

    return { result, template: Template.fromStack(stack) }
  }

  /**
   * The destination half of the content policy. Origin-side redaction covers what the Bedrock
   * guardrail cannot reach (tool arguments and results); this covers the prompt and completion that
   * deliberately survive it, plus AgentCore's own `request_payload`, which is captured at HTTP
   * ingress where no code of ours could have masked it.
   */
  it('masks personal and credential data in the telemetry log group', () => {
    const { template } = synthObservability()

    // Two groups now: the telemetry group and the findings group its audit statement reports into.
    const telemetry = Object.values(template.findResources('AWS::Logs::LogGroup')).find((group) =>
      String((group.Properties as { LogGroupName?: string }).LogGroupName).endsWith('/test'),
    )
    const policy = JSON.stringify(telemetry?.Properties)

    for (const identifier of ['EmailAddress', 'CreditCardNumber', 'AwsSecretKey', 'CpfCode-BR']) {
      expect(policy).toContain(identifier)
    }
    // `Name` is deliberately absent — it matched prose. See the note on MASKED_IDENTIFIERS.
    expect(policy).not.toContain('data-identifier/Name')
  })

  /**
   * `RETAIN` here is a trap, not a safeguard: it applies to the rollback of the update that created
   * the group, so a deploy failing on any later resource orphans it and the next attempt dies with
   * "already exists" before doing anything. It cost one real deploy to find. Nothing is protected by
   * retaining it — the conversation itself lives in AgentCore Memory, which *is* retained.
   */
  it('lets the telemetry log group be destroyed with the stack', () => {
    const { template } = synthObservability()

    const groups = Object.values(template.findResources('AWS::Logs::LogGroup'))
    // The telemetry group and the masking-findings group; neither may outlive the stack.
    expect(groups).toHaveLength(2)
    expect((groups[0] as { DeletionPolicy?: string }).DeletionPolicy).toBe('Delete')
  })

  /**
   * A log group whose retention outlived the conversation would be a second copy of the turn under a
   * longer retention — quietly reopening the deletion promise the memory resource makes.
   */
  it('never keeps telemetry longer than the conversation it describes', () => {
    for (const days of [1, 30, 90, 365]) {
      const { template } = synthObservability(days)
      template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: days })
    }
  })

  /** A retention CloudWatch does not offer rounds up, never down. */
  it('rounds an unsupported retention up to the next supported one', () => {
    const { template } = synthObservability(45)

    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 60 })
  })

  /**
   * Without all three deliveries the corresponding panes of the GenAI Observability console are
   * blank — and a blank pane reads as "the agent did nothing", not as "nothing was delivered".
   */
  it('delivers application logs, usage logs and traces', () => {
    const { template } = synthObservability()

    template.resourceCountIs('AWS::Logs::DeliverySource', 3)
    template.resourceCountIs('AWS::Logs::Delivery', 3)
    for (const logType of ['APPLICATION_LOGS', 'USAGE_LOGS', 'TRACES']) {
      template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: logType })
    }
  })

  /**
   * The ARN the source is registered against, asserted because a wildcard here is invisible.
   *
   * This was built as `...:runtime/*` — an ARN assembled before the runtime existed, because the log
   * group and the deliveries were created by one function that ran too early to know the runtime's
   * identity. CloudFormation accepts that string, the console lists three active deliveries, and
   * nothing is ever delivered: a wildcard matches no runtime. The failure has no error and no empty
   * pane to notice, only logs that quietly stay in AgentCore's default log group, outside every
   * control this stack applies. Hence a test on the shape of the ARN rather than on its presence.
   */
  /**
   * The name, pinned because it is load-bearing in a way names usually are not.
   *
   * `resourceArn` is immutable in the CloudWatch Logs API but is not declared create-only in the
   * CloudFormation schema, where `Name` is the only create-only property. A changed ARN is therefore
   * attempted as an update and refused — "Update to existing Delivery Source with new ResourceId is
   * not allowed" — which is exactly what the wildcard fix hit on its first deploy. The name is the
   * only lever that forces a replacement, so reverting it would strand every deployment that ever
   * created these sources against a different ARN.
   */
  it('names the delivery source after the agent, which is what makes the ARN fix deployable', () => {
    const { template } = synthObservability()

    for (const source of Object.values(template.findResources('AWS::Logs::DeliverySource'))) {
      const name = (source.Properties as { Name?: string }).Name ?? ''
      expect(name).toMatch(/^test-agent-/)
      expect(name.length).toBeLessThanOrEqual(60)
    }
  })

  it('registers the delivery source against the runtime, not a wildcard', () => {
    const { template } = synthObservability()

    const sources = Object.values(template.findResources('AWS::Logs::DeliverySource'))
    expect(sources).toHaveLength(3)
    for (const source of sources) {
      const arn = (source.Properties as { ResourceArn?: string }).ResourceArn
      expect(arn).toBe(RUNTIME_ARN)
      expect(arn).not.toContain('*')
    }
  })

  /**
   * X-Ray is the destination for spans, not a log group. Naming a resource ARN alongside it is what
   * makes CloudFormation reject the delivery.
   */
  it('sends traces to X-Ray and the log types to the log group', () => {
    const { template } = synthObservability()

    const destinations = Object.values(template.findResources('AWS::Logs::DeliveryDestination'))
    const xray = destinations.filter(
      (d) => (d.Properties as { DeliveryDestinationType?: string }).DeliveryDestinationType === 'XRAY',
    )

    expect(xray).toHaveLength(1)
    expect((xray[0]?.Properties as { DestinationResourceArn?: string }).DestinationResourceArn).toBeUndefined()
  })

  /**
   * X-Ray writes spans into the log group on the agent's behalf, so the service needs the grant.
   * Without it the endpoint accepts the batch and the spans never appear — the silent failure this
   * wiring exists to avoid.
   */
  it('lets X-Ray deliver spans into the log group', () => {
    const { template } = synthObservability()

    const policy = JSON.stringify(
      Object.values(template.findResources('AWS::Logs::ResourcePolicy'))[0]?.Properties,
    )
    expect(policy).toContain('xray.amazonaws.com')
    expect(policy).toContain('logs:PutLogEvents')
    // `CreateLogStream` too, which the documentation omits: the `spans` stream does not exist until
    // the first export and X-Ray is what creates it. Without this the endpoint answers 400 and every
    // span is lost — which is exactly what the first deployment did.
    expect(policy).toContain('logs:CreateLogStream')
    // Scoped to this account, so the statement cannot be used from another one.
    expect(policy).toContain('aws:SourceAccount')
    // `logGroupArn` already ends in `:*`; a second one renders `:*:*` and matches no stream.
    expect(policy).not.toContain(':*:*')
  })
})

describe('BffStack — operational visibility', () => {
  function synthBff() {
    const app = new cdk.App()
    const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
    const stack = new BffStack(app, 'TestBff', {
      projectName: 'test',
      userPool: auth.userPool,
      throttle: { rateLimit: 10, burstLimit: 20 },
      agentMetricNamespace: 'test/Agent',
      ...upstreamProps(auth),
      env,
    })
    return Template.fromStack(stack)
  }

  /**
   * `logEvent` already emitted one JSON object per line, but Lambda's own START/END/REPORT lines and
   * any stray `console` call stayed text — so a Logs Insights query filtering on a correlation id
   * skipped them without saying so.
   */
  it('emits structured logs from every function', () => {
    const template = synthBff()

    const functions = Object.values(template.findResources('AWS::Lambda::Function'))
    expect(functions.length).toBeGreaterThanOrEqual(3)
    for (const fn of functions) {
      const config = (fn.Properties as { LoggingConfig?: { LogFormat?: string } }).LoggingConfig
      expect(config?.LogFormat).toBe('JSON')
    }
  })

  /**
   * The three original alarms all fire on an error. These fire on the failures that return 200 —
   * which is the shape an agentic turn fails in most often.
   */
  it('alarms on the failures that do not raise an error', () => {
    const template = synthBff()

    for (const alarmName of [
      'test-chat-latency',
      'test-agent-throttles',
      'test-agent-system-errors',
      'test-bedrock-throttles',
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: alarmName })
    }
  })

  /** Every alarm has to reach the topic; one that only changes colour on a page nobody has open is not an alarm. */
  it('routes every alarm to the notification topic', () => {
    const template = synthBff()

    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      expect((alarm.Properties as { AlarmActions?: unknown[] }).AlarmActions ?? []).not.toHaveLength(0)
    }
  })

  it('builds a dashboard covering the turn, the runtime and the model', () => {
    const template = synthBff()

    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1)
    const body = JSON.stringify(
      Object.values(template.findResources('AWS::CloudWatch::Dashboard'))[0]?.Properties,
    )
    expect(body).toContain('AWS/Bedrock-AgentCore')
    expect(body).toContain('AWS/Bedrock')
    // The token and tool metrics the assessment lists as absent — present once the agent exports them.
    expect(body).toContain('GenAiAgentTokensInput')
    expect(body).toContain('GenAiAgentToolErrorCount')
  })

  /**
   * A widget charting a namespace nothing writes to renders as a flat zero, which reads as "the
   * agent is idle" rather than "this was never switched on".
   */
  it('omits the agent row when the agent is not exporting metrics', () => {
    const app = new cdk.App()
    const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
    const stack = new BffStack(app, 'TestBff', {
      projectName: 'test',
      userPool: auth.userPool,
      throttle: { rateLimit: 10, burstLimit: 20 },
      ...upstreamProps(auth),
      env,
    })

    const body = JSON.stringify(
      Object.values(Template.fromStack(stack).findResources('AWS::CloudWatch::Dashboard'))[0]
        ?.Properties,
    )
    expect(body).not.toContain('GenAiAgentTokensInput')
  })
})

describe('BffStack — one telemetry model', () => {
  function synth(tracingEnabled: boolean) {
    const app = new cdk.App()
    const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
    const stack = new BffStack(app, 'TestBff', {
      projectName: 'test',
      userPool: auth.userPool,
      throttle: { rateLimit: 10, burstLimit: 20 },
      tracingEnabled,
      ...upstreamProps(auth),
      env,
    })
    return Template.fromStack(stack)
  }

  /**
   * The invariant. The X-Ray SDKs went to maintenance mode in February 2026 and the agent container
   * is already pure OTel, so instrumenting the BFF the other way would make one template bilingual
   * in tracing — two context models every fork inherits. Asserted by absence, because reaching for
   * `aws-xray-sdk-core` is the reflex this exists to prevent.
   */
  it('instruments with OpenTelemetry and nothing else', () => {
    const rendered = JSON.stringify(synth(true).toJSON())

    expect(rendered).toContain('AWSOpenTelemetryDistroJs')
    expect(rendered).not.toContain('aws-xray-sdk')
    // The legacy layer family bundles an ADOT Collector, which AWS does not recommend for a
    // CloudWatch destination and which would contradict the agent's own collectorless exporter.
    expect(rendered).not.toContain('aws-otel-nodejs')
  })

  /**
   * The wrapper is what distinguishes the two ADOT layer families, and the wrong one leaves the
   * function running and uninstrumented — a trace map identical to the broken one, with no error.
   */
  it('uses the wrapper the current layer family expects', () => {
    const template = synth(true)

    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      const environment = (fn.Properties as { Environment?: { Variables?: Record<string, string> } })
        .Environment?.Variables
      expect(environment?.AWS_LAMBDA_EXEC_WRAPPER).toBe('/opt/otel-instrument')
      // Without a service name the map cannot tell two of the three functions apart.
      expect(environment?.OTEL_SERVICE_NAME).toMatch(/^test-bff/)
    }
  })

  it('runs the functions on Graviton', () => {
    const template = synth(true)

    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      expect((fn.Properties as { Architectures?: string[] }).Architectures).toEqual(['arm64'])
    }
  })

  /** Instrumentation is billed telemetry: a deployment that declined tracing must not pay for it. */
  it('ships no layer when tracing is off', () => {
    const template = synth(false)

    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      const properties = fn.Properties as { Layers?: unknown[]; Environment?: { Variables?: Record<string, string> } }
      expect(properties.Layers ?? []).toHaveLength(0)
      expect(properties.Environment?.Variables?.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined()
    }
  })
})

/**
 * The log group AgentCore creates for the runtime, which this stack does not own but must govern.
 *
 * The container's stdout never reaches the telemetry log group: `APPLICATION_LOGS` carries the
 * AgentCore *service's* record of an invocation, not the container's process output. That output —
 * the agent's rendered reasoning and tool activity — stays in AgentCore's own log group, which the
 * service leaves with no retention, no CMK and no masking. Without these calls the content policy
 * covers the spans describing a turn and misses the plainest record of it.
 */

/** The masking document `governRuntimeLogGroup` hands to `PutDataProtectionPolicy`, parsed. */
function maskingPolicyOf(template: Template): {
  Statement: {
    Sid: string
    DataIdentifier: string[]
    Operation: { Audit?: { FindingsDestination: unknown }; Deidentify?: unknown }
  }[]
} {
  const resource = Object.values(template.findResources('Custom::AWS')).find((candidate) =>
    String((candidate.Properties as { Update?: unknown }).Update).includes('PutDataProtectionPolicy'),
  )
  if (!resource) throw new Error('no PutDataProtectionPolicy call in the template')

  const call = JSON.parse(String((resource.Properties as { Update: string }).Update))

  return JSON.parse(call.parameters.policyDocument)
}

describe('AgentStack — the runtime\'s own log group', () => {
  function synthGoverned() {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'TestGoverned', { env })
    const key = new kms.Key(stack, 'Key')

    governRuntimeLogGroup(stack, {
      projectName: 'test',
      runtimeId: 'test_agent-AbCdEf1234',
      encryptionKey: key,
      retentionDays: 30,
      findingsLogGroupName: '/aws/vendedlogs/bedrock-agentcore/test-findings',
    })

    return Template.fromStack(stack)
  }

  /** Each call is one custom resource; the four together are what "governed" means here. */
  it('applies retention, a customer key and a masking policy to it', () => {
    const calls = JSON.stringify(
      Object.values(synthGoverned().findResources('AWS::CloudFormation::CustomResource')).concat(
        Object.values(synthGoverned().findResources('Custom::AWS')),
      ),
    )

    for (const action of [
      'CreateLogGroup',
      'PutRetentionPolicy',
      'AssociateKmsKey',
      'PutDataProtectionPolicy',
    ]) {
      expect(calls).toContain(action)
    }
  })

  /**
   * The name is the runtime's id plus the endpoint, so it cannot be written down ahead of time —
   * which is also why the spans cannot be redirected here: the variables carrying this name are set
   * on the runtime that produces the id.
   */
  it('derives the log group name from the runtime rather than hard-coding one', () => {
    const calls = JSON.stringify(Object.values(synthGoverned().findResources('Custom::AWS')))

    expect(calls).toContain('/aws/bedrock-agentcore/runtimes/test_agent-AbCdEf1234-DEFAULT')
  })

  /**
   * Masking has to match the telemetry group's, or a reader finds in one group what was hidden in
   * the other. One list feeds both; this asserts the pair actually stayed together.
   */
  it('masks the same identifiers as the telemetry log group', () => {
    const runtimePolicy = JSON.stringify(Object.values(synthGoverned().findResources('Custom::AWS')))

    for (const identifier of ['EmailAddress', 'Name', 'CreditCardNumber', 'AwsSecretKey', 'CpfCode-BR']) {
      expect(runtimePolicy).toContain(identifier)
    }
  })

  /**
   * The two statements must carry identical identifier lists, and the list must stay short.
   *
   * Both halves were learned the hard way. Masking all ten managed identifiers turned ordinary prose
   * into asterisks and masked the *name* of the span attribute the GenAI console reads. The obvious
   * fix — audit widely, mask narrowly — is refused by the service: "Audit Statement and Deidentify
   * Statement must have the same Data Identifiers". So detection and masking are one decision, and
   * the only lever is which identifiers are precise enough to be worth both.
   */
  it('masks only identifiers with a verifiable structure, and audits exactly those', () => {
    const { Statement } = maskingPolicyOf(synthGoverned())
    const names = (sid: string) =>
      (Statement.find((statement) => statement.Sid === sid)?.DataIdentifier ?? []).map((arn) =>
        arn.slice(arn.lastIndexOf('/') + 1),
      )

    // The service rejects the policy outright if these differ.
    expect(names('audit')).toEqual(names('redact'))

    for (const precise of ['EmailAddress', 'CreditCardNumber', 'CpfCode-BR', 'AwsSecretKey']) {
      expect(names('redact')).toContain(precise)
    }
    // The four that matched free text and a bind address. Re-adding one re-breaks the logs.
    for (const noisy of ['Name', 'Address', 'PhoneNumber-US', 'IpAddress']) {
      expect(names('redact')).not.toContain(noisy)
    }
  })

  /**
   * The four permissions the audit destination needs, asserted because their absence reads as a
   * missing feature rather than as missing IAM.
   *
   * Sending findings to a log group makes CloudWatch Logs configure a delivery on the caller's
   * behalf, and it checks the caller for the rights to do that. Without them the whole
   * `PutDataProtectionPolicy` call fails with "Not authorized to use the audit operation in the data
   * protection policy" — no mention of IAM, of the destination, or of which action is missing.
   */
  it('grants the custom resource what the audit destination requires', () => {
    const policies = JSON.stringify(Object.values(synthGoverned().findResources('AWS::IAM::Policy')))

    for (const action of [
      'logs:CreateLogDelivery',
      'logs:PutResourcePolicy',
      'logs:DescribeResourcePolicies',
      'logs:DescribeLogGroups',
    ]) {
      expect(policies).toContain(action)
    }
  })

  /** An audit statement with no destination computes findings and drops them. */
  it('sends findings somewhere they can be read', () => {
    const { Statement } = maskingPolicyOf(synthGoverned())
    const audit = Statement.find((statement) => statement.Sid === 'audit')

    expect(audit?.Operation.Audit?.FindingsDestination).toEqual({
      CloudWatchLogs: { LogGroup: '/aws/vendedlogs/bedrock-agentcore/test-findings' },
    })
  })

  /**
   * No delete. The group belongs to AgentCore: a delete ordered before the runtime is gone is simply
   * recreated and orphaned, which is the failure this template already met once with a RETAINed log
   * group. Retention is what bounds it instead.
   */
  it('does not delete a log group it does not own', () => {
    const resources = Object.values(synthGoverned().findResources('Custom::AWS'))

    expect(JSON.stringify(resources)).not.toContain('DeleteLogGroup')
    // `Delete` is where AwsCustomResource renders an `onDelete` SDK call. Note this is not
    // `DeletionPolicy`, which every custom resource carries and which only governs the custom
    // resource itself — reading one for the other is what made the first version of this pass
    // vacuously.
    for (const resource of resources) {
      expect((resource.Properties as Record<string, unknown>).Delete).toBeUndefined()
    }
  })
})
