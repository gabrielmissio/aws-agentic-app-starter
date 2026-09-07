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
import { bedrockModelResources } from '../stacks/agent-stack.js'
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
