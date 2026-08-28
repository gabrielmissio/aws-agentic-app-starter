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
import { Match, Template } from 'aws-cdk-lib/assertions'
import { Ap2EntitiesStack } from '../stacks/ap2-entities-stack.js'
import { bedrockModelResources } from '../stacks/agent-stack.js'
import { AuthStack } from '../stacks/auth-stack.js'
import { BffStack } from '../stacks/bff-stack.js'
import { DataStack } from '../stacks/data-stack.js'
import { FrontendStack } from '../stacks/frontend-stack.js'
import { SecurityStack } from '../stacks/security-stack.js'

const env = { account: '123456789012', region: 'us-east-1' }
const FAKE_RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/fake-runtime-id'

/**
 * The AP2 dependencies `BffStack` needs, in one app so cross-stack references resolve. Real stacks,
 * not stubs: the grants under test are made against their actual ARNs.
 */
function ap2Dependencies(app: cdk.App) {
  const data = new DataStack(app, 'DepData', { projectName: 'test', env })
  const security = new SecurityStack(app, 'DepSecurity', { projectName: 'test', env })
  const ap2 = new Ap2EntitiesStack(app, 'DepAp2', {
    projectName: 'test',
    data,
    security,
    allowedMpps: ['mpp-sandbox-001'],
    autoProvisionSandboxMethod: true,
    env,
  })
  return {
    ap2,
    data,
    security,
    intentTtlMinutes: 5,
    otpStepUpThresholdCents: 10_000,
    otpRevealInUi: false,
  }
}

function synthAuth(props: Partial<ConstructorParameters<typeof AuthStack>[2]> = {}) {
  const app = new cdk.App()
  const stack = new AuthStack(app, 'TestAuth', { projectName: 'test', env, ...props })
  return { stack, template: Template.fromStack(stack) }
}

describe('AuthStack — the browser gets a token and nothing else', () => {
  // An Identity Pool vends AWS credentials to a signed-in browser. One whose authenticated role
  // carried `bedrock-agentcore:InvokeAgentRuntime` would let any signed-in user reach the runtime
  // directly and hand it an identity block naming *another* user. These assert absence because
  // adding a pool back is a natural thing to do by habit.
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
  } = {},
) {
  const app = new cdk.App()
  const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
  const stack = new BffStack(app, 'TestBff', {
    projectName: 'test',
    userPool: auth.userPool,
    agentRuntimeArn: FAKE_RUNTIME_ARN,
    throttle: { rateLimit: 10, burstLimit: 20 },
    ...ap2Dependencies(app),
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
      agentRuntimeArn: FAKE_RUNTIME_ARN,
      throttle: { rateLimit: 10, burstLimit: 20 },
      userRateLimit: { limit: 5, windowSeconds: 30 },
      ...ap2Dependencies(app),
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

function synthFrontend() {
  const app = new cdk.App()
  const auth = new AuthStack(app, 'TestAuth', { projectName: 'test', env })
  const bff = new BffStack(app, 'TestBff', {
    projectName: 'test',
    userPool: auth.userPool,
    agentRuntimeArn: FAKE_RUNTIME_ARN,
    throttle: { rateLimit: 10, burstLimit: 20 },
    ...ap2Dependencies(app),
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

describe('BffStack — the AP2 checkout function', () => {
  /** The AP2 routes, as (resource path part, method) pairs. */
  const AP2_ROUTES: [string, string][] = [
    ['intent', 'POST'],
    ['confirm', 'POST'],
    ['decline', 'POST'],
    ['journeys', 'GET'],
    ['actors', 'GET'],
    ['{journeyId}', 'GET'],
  ]

  it('is the only principal granted invoke on the Mandate Authority', () => {
    const { template } = synthBff()

    // This function *is* the Trusted Surface, so it is the one role AP2 allows to have mandates
    // signed. The grant living here and only here is what makes the Agent-Provider MUST hold.
    const statements = statementsForHandler(template, 'dist/ap2-handler.handler')
    const invokeUrl = statements.filter((st) => {
      const actions = Array.isArray(st.Action) ? st.Action : [st.Action]
      return actions.includes('lambda:InvokeFunctionUrl')
    })
    expect(invokeUrl.length).toBeGreaterThan(0)

    const targets = JSON.stringify(invokeUrl.map((st) => st.Resource))
    // Cross-stack, so the reference arrives as an imported output naming the source construct.
    expect(targets).toContain('ConsentDecisionFn')
    expect(targets).toContain('ConsentFn')
    expect(targets).toContain('MerchantFn')
    expect(targets).toContain('CpFn')
    // Settlement stays out of reach: only the Merchant calls the MPP.
    expect(targets).not.toContain('MppFn')
  })

  it('gates every AP2 route behind the Cognito authorizer', () => {
    const { template } = synthBff()

    // The handler fails closed without verified claims, which only holds if no route reaches it
    // unauthenticated — so a route added without an authorizer fails here, not in production.
    const resources = template.findResources('AWS::ApiGateway::Resource')
    const pathPartOf = (id: string) => resources[id]?.Properties?.PathPart as string | undefined

    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'))
    for (const [pathPart, httpMethod] of AP2_ROUTES) {
      const match = methods.find((m) => {
        const resourceId = (m.Properties.ResourceId as { Ref?: string })?.Ref
        return (
          m.Properties.HttpMethod === httpMethod &&
          resourceId !== undefined &&
          pathPartOf(resourceId) === pathPart
        )
      })
      expect(match, `${httpMethod} /${pathPart}`).toBeDefined()
      expect(match?.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS')
      expect(match?.Properties.AuthorizerId).toBeDefined()
    }
  })

  it('keeps settlement off the chat function, which relays model output', () => {
    const { template } = synthBff()

    // The separation only means anything if the chat role cannot do what the AP2 role can: read the
    // HMAC secret, publish SMS, or invoke an AP2 entity.
    const chatStatements = statementsForHandler(template, 'dist/handler.handler')
    const rendered = JSON.stringify(chatStatements)
    expect(rendered).not.toContain('secretsmanager')
    expect(rendered).not.toContain('sns:Publish')
    expect(rendered).not.toContain('lambda:InvokeFunctionUrl')

    // One KMS action, and only one: signing the caller identity it hands the agent. It must not be
    // able to sign or verify anything in the AP2 chain — a chat function that could sign a mandate
    // would be a chat function that could pay.
    const kmsActions = chatStatements
      .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter((a) => String(a).startsWith('kms:'))
    expect(kmsActions).toEqual(['kms:Sign'])
    const kmsResources = JSON.stringify(
      chatStatements
        .filter((st) => JSON.stringify(st.Action ?? '').includes('kms:'))
        .map((st) => st.Resource),
    )
    expect(kmsResources).toContain('IdentityKey')
    for (const role of ['MerchantKey', 'ConsentKey', 'CpKey', 'MppKey']) {
      expect(kmsResources).not.toContain(role)
    }
  })

  it('meters the checkout function against the per-caller quota table', () => {
    // A quota on /chat alone leaves the money-moving routes with only the account-wide stage
    // throttle, so one caller could present codes to /confirm as fast as the stage allowed.
    const { template } = synthBff()
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/ap2-handler.handler',
      Environment: {
        Variables: Match.objectLike({
          RATE_LIMIT_TABLE_NAME: Match.anyValue(),
          AP2_RATE_LIMIT: Match.anyValue(),
          AP2_RATE_LIMIT_WINDOW_SECONDS: Match.anyValue(),
        }),
      },
    })
  })

  it('gives the checkout function no way to write to the evidence log', () => {
    const { template } = synthBff()

    // The surface that displays the audit trail must not be able to alter it. Only the entities
    // append, and even they cannot amend.
    const statements = statementsForHandler(template, 'dist/ap2-handler.handler')
    const evidenceStatements = statements.filter((s) =>
      JSON.stringify(s.Resource ?? '').includes('Evidence'),
    )
    expect(evidenceStatements.length).toBeGreaterThan(0)
    for (const statement of evidenceStatements) {
      const actions = statement.Action
      expect(Array.isArray(actions) ? actions : [actions]).toEqual(['dynamodb:Query'])
    }
  })

  it('touches the AP2 keys only to publish them, and signs only its own identity key', () => {
    const { template } = synthBff()

    // Publishing the public halves lets an outside party check the chain. Sign or verify on an AP2
    // role key would make this role a participant in the trust it only exposes. Its one signing
    // grant is on the identity key, which signs no artifact — only who a call acts for.
    const statements = statementsForHandler(template, 'dist/ap2-handler.handler')
    const kmsStatements = statements.filter((s) => JSON.stringify(s.Action ?? '').includes('kms:'))
    expect(kmsStatements.length).toBeGreaterThan(0)

    for (const statement of kmsStatements) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      const resources = JSON.stringify(statement.Resource)
      if (actions.includes('kms:Sign')) {
        expect(actions).toEqual(['kms:Sign'])
        expect(resources).toContain('IdentityKey')
        for (const role of ['MerchantKey', 'ConsentKey', 'CpKey', 'MppKey']) {
          expect(resources).not.toContain(role)
        }
      } else {
        expect(actions).toEqual(['kms:GetPublicKey'])
      }
    }
  })

  it('never templates the HMAC secret value into the function environment', () => {
    const { template } = synthBff()

    // Only the ARN travels. Templating the plaintext would put the key that seals every checkout
    // into CloudFormation, the console, and every deploy log.
    const fns = Object.values(
      template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'dist/ap2-handler.handler' },
      }),
    )
    expect(fns).toHaveLength(1)

    const vars = fns[0].Properties.Environment.Variables as Record<string, unknown>
    expect(vars.HMAC_SECRET_ARN).toBeDefined()
    expect(JSON.stringify(vars.HMAC_SECRET_ARN)).toContain('Ref')
    expect(vars).not.toHaveProperty('HMAC_SECRET')
  })

  it('stays within the API Gateway buffered-integration ceiling', () => {
    const { template } = synthBff()

    // /confirm is the long pole — four KMS-signing hops — but a timeout past the gateway's hard 29s
    // would just keep billing after the caller has already been handed a 504.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'dist/ap2-handler.handler',
      Timeout: Match.exact(29),
    })
  })

  it('alarms on checkout failures, not only on chat failures', () => {
    const { template } = synthBff()
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-ap2-errors',
    })
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

// ── AP2 ──────────────────────────────────────────────────────────────────

function synthAp2(retainData = true) {
  const app = new cdk.App()
  const data = new DataStack(app, 'TestData', { projectName: 'test', retainData, env })
  const security = new SecurityStack(app, 'TestSecurity', { projectName: 'test', retainData, env })
  const entities = new Ap2EntitiesStack(app, 'TestAp2', {
    projectName: 'test',
    data,
    security,
    allowedMpps: ['mpp-sandbox-001'],
    autoProvisionSandboxMethod: true,
    env,
  })
  return {
    data: Template.fromStack(data),
    security: Template.fromStack(security),
    entities: Template.fromStack(entities),
    entitiesStack: entities,
  }
}

type PolicyStatement = { Action?: string | string[]; Resource?: string | string[] }

/** Every IAM statement in the stack, flattened out of the policies that carry them. */
function allStatements(template: Template): PolicyStatement[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) => {
    const doc = policy.Properties?.PolicyDocument as { Statement?: PolicyStatement[] }
    return doc?.Statement ?? []
  })
}

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

describe('SecurityStack — one signing key per entity', () => {
  it('creates four ECC_NIST_P256 SIGN_VERIFY keys and nothing symmetric', () => {
    const { security } = synthAp2()

    // Separate keys are the security model: each entity signs with its own, so a compromised
    // Merchant still cannot forge the user's consent. Five, not four: the fifth is the BFF's caller
    // identity key, which signs no AP2 artifact and which no entity may sign with.
    security.resourceCountIs('AWS::KMS::Key', 5)
    const keys = Object.values(security.findResources('AWS::KMS::Key'))
    expect(keys).toHaveLength(5)
    for (const key of keys) {
      expect(key.Properties.KeySpec).toBe('ECC_NIST_P256')
      // ES256's random nonce is what satisfies AP2's non-deterministic-signature requirement for
      // the Checkout JWT; a symmetric or deterministic key here would silently violate it.
      expect(key.Properties.KeyUsage).toBe('SIGN_VERIFY')
    }
  })

  it('generates the HMAC secret rather than templating a plaintext value', () => {
    const { security } = synthAp2()

    // The plaintext must never reach the template or an environment variable — only the ARN does.
    security.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ PasswordLength: 64 }),
    })
    const secrets = Object.values(security.findResources('AWS::SecretsManager::Secret'))
    for (const secret of secrets) {
      expect(secret.Properties).not.toHaveProperty('SecretString')
    }
  })

  it('retains the signing keys by default, because destroying one voids the audit trail', () => {
    expect(
      Object.values(synthAp2(true).security.findResources('AWS::KMS::Key')).every(
        (k) => k.DeletionPolicy === 'Retain',
      ),
    ).toBe(true)
    expect(
      Object.values(synthAp2(false).security.findResources('AWS::KMS::Key')).every(
        (k) => k.DeletionPolicy === 'Delete',
      ),
    ).toBe(true)
  })
})

describe('DataStack — AP2 tables', () => {
  it('provisions a table per concern, all on-demand', () => {
    const { data } = synthAp2()
    const tables = Object.values(data.findResources('AWS::DynamoDB::Table'))
    expect(tables).toHaveLength(9)
    for (const table of tables) {
      expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST')
    }
  })

  it('gives the credentials and intents tables a TTL, so consumed state prunes itself', () => {
    const { data } = synthAp2()
    // The credentials table also holds the anti-replay markers, which must expire with the tokens
    // that carried them — without a TTL they accumulate forever.
    data.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-payment-credentials',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    })
    data.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-ap2-intents',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    })
  })

  it('keys the evidence log by journey and time, the shape the trail is read in', () => {
    const { data } = synthAp2()
    data.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-evidence-log',
      KeySchema: [
        { AttributeName: 'journeyId', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    })
  })

  it('honours retainData, the same switch the user pool and frontend bucket use', () => {
    expect(
      Object.values(synthAp2(false).data.findResources('AWS::DynamoDB::Table')).every(
        (t) => t.DeletionPolicy === 'Delete',
      ),
    ).toBe(true)
  })
})

describe('caller identity is signed, and only the BFF can sign it', () => {
  /**
   * Identity is a signed artifact rather than a body field the entities believe, and the whole
   * guarantee rests on one asymmetry: the BFF holds `kms:Sign` on the identity key, the entities
   * hold verify-only, and the agent holds nothing. AP2 requires exactly this posture —
   * *"All LLMs and Agents MUST be considered potential attackers."*
   */
  it('gives no entity the ability to sign an identity', () => {
    const { entities } = synthAp2()

    for (const handler of [
      'handlers/merchant.handler',
      'handlers/consent-mandates.handler',
      'handlers/consent-decision.handler',
      'handlers/credential-provider.handler',
      'handlers/mpp.handler',
      'handlers/evidence.handler',
    ]) {
      const signsIdentity = statementsForHandler(entities, handler).some((st) => {
        const actions = Array.isArray(st.Action) ? st.Action : [st.Action]
        return actions.includes('kms:Sign') && JSON.stringify(st.Resource).includes('IdentityKey')
      })
      expect(signsIdentity, handler).toBe(false)
    }
  })

  it('lets exactly the four caller-resolving entities verify one', () => {
    const { entities } = synthAp2()

    const verifiesIdentity = (handler: string) =>
      statementsForHandler(entities, handler).some((st) => {
        const actions = Array.isArray(st.Action) ? st.Action : [st.Action]
        return actions.includes('kms:Verify') && JSON.stringify(st.Resource).includes('IdentityKey')
      })

    // These four answer "for which user?" — a journey's, a session's, a payment method's owner, and
    // the person a mandate is about to be signed for. The MPP and the Evidence Store never do, so
    // they get nothing.
    expect(verifiesIdentity('handlers/merchant.handler')).toBe(true)
    expect(verifiesIdentity('handlers/consent-mandates.handler')).toBe(true)
    expect(verifiesIdentity('handlers/credential-provider.handler')).toBe(true)
    // The Mandate Authority checks the session it is signing over belongs to the caller the token
    // names. Without this grant that check fails closed at runtime and every checkout stops — a
    // failure no unit test upstream can see, which is why it is pinned here.
    expect(verifiesIdentity('handlers/consent-decision.handler')).toBe(true)
    expect(verifiesIdentity('handlers/mpp.handler')).toBe(false)
    expect(verifiesIdentity('handlers/evidence.handler')).toBe(false)
  })

  it('puts the identity key ARN in the environment of every entity that verifies one', () => {
    const { entities } = synthAp2()
    const fns = entities.findResources('AWS::Lambda::Function')

    // `KmsSigner.fromEnv` treats the identity ARN as optional, so a function granted `kms:Verify`
    // but missing the variable constructs happily and then refuses every caller. The grant and the
    // ARN only mean something together.
    for (const handler of [
      'handlers/merchant.handler',
      'handlers/consent-mandates.handler',
      'handlers/consent-decision.handler',
      'handlers/credential-provider.handler',
    ]) {
      const fn = Object.values(fns).find(
        (f) => (f.Properties as { Handler?: string }).Handler === handler,
      )
      const env = (fn?.Properties as { Environment?: { Variables?: Record<string, unknown> } })
        ?.Environment?.Variables
      expect(env?.KMS_KEY_IDENTITY, handler).toBeDefined()
    }
  })

  it('leaves the agent stack with no grant on the identity key', () => {
    // Same reasoning as the Mandate Authority test below: `AgentStack` builds a Docker image and is
    // not synthesized here, so the guarantee is read off its source. The agent forwards the token it
    // was handed; a grant here would let it mint one for anybody.
    const source = readFileSync(new URL('../stacks/agent-stack.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('identityKey')
  })
})

describe('DataStack — recoverability', () => {
  it('enables point-in-time recovery on every table', () => {
    const { data } = synthAp2()

    // RETAIN protects against the stack being destroyed. It does nothing about the failure that
    // actually happens — a bad deploy, a wrong DeleteItem, a TTL in the wrong unit — and for the
    // evidence and mandate tables that trail *is* the product.
    const tables = Object.values(data.findResources('AWS::DynamoDB::Table'))
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      expect(
        table.Properties.PointInTimeRecoverySpecification,
        table.Properties.TableName as string,
      ).toEqual({ PointInTimeRecoveryEnabled: true })
    }
  })

  it('indexes the intents table by journey, so ownership is asked of the journey', () => {
    const { data } = synthAp2()

    // Asking "does one of my intents mention this journey?" is a question a caller can arrange the
    // answer to. Asking "whose journey is this?" needs a lookup keyed by the journey.
    data.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: Match.stringLikeRegexp('ap2-intents'),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'byJourney',
          KeySchema: Match.arrayWith([{ AttributeName: 'journeyId', KeyType: 'HASH' }]),
        }),
      ]),
    })
  })
})

describe('Ap2EntitiesStack — the Mandate Authority is a boundary, not a convention', () => {
  /**
   * AP2 [Agent Authorization §Trusted Agent Provider]: *"The Agent Provider MUST ensure that the
   * Agent is not able to access the Agent Provider signing key, **or use it without the Trusted
   * Surface**."*
   *
   * Function-URL IAM authorizes per function, never per operation, so while `submit_consent_decision`
   * shared a URL with the session operations the agent legitimately calls, every principal able to
   * open a session was also able — at the IAM layer — to have mandates signed. These assertions pin
   * the split that fixed it.
   */
  it('gives the consent session function no KMS authority whatsoever', () => {
    const { entities } = synthAp2()

    const statements = statementsForHandler(entities, 'handlers/consent-mandates.handler')
    const kmsStatements = statements.filter((st) => JSON.stringify(st.Action ?? '').includes('kms:'))
    const actions = kmsStatements.flatMap((st) =>
      Array.isArray(st.Action) ? st.Action : [st.Action],
    )

    // Read-only KMS, and only on the BFF's identity key — it resolves who opened a session and can
    // sign nothing whatsoever. The AP2 key ARNs stay in its environment because `KmsSigner.fromEnv`
    // needs all four to construct, and an ARN is not a permission.
    expect(actions).not.toContain('kms:Sign')
    expect(actions.length).toBeGreaterThan(0)
    const resources = JSON.stringify(kmsStatements.map((st) => st.Resource))
    expect(resources).toContain('IdentityKey')
    for (const role of ['MerchantKey', 'ConsentKey', 'CpKey', 'MppKey']) {
      expect(resources).not.toContain(role)
    }
  })

  it('grants kms:Sign on the Consent key to the Mandate Authority alone', () => {
    const { entities } = synthAp2()

    const signers = [
      'handlers/merchant.handler',
      'handlers/consent-mandates.handler',
      'handlers/consent-decision.handler',
      'handlers/credential-provider.handler',
      'handlers/mpp.handler',
      'handlers/evidence.handler',
    ].filter((handler) =>
      statementsForHandler(entities, handler).some((st) => {
        const actions = Array.isArray(st.Action) ? st.Action : [st.Action]
        return actions.includes('kms:Sign')
      }),
    )

    // The Merchant, CP and MPP each sign with their own key; the consent surface's signer is the
    // decision function, and the session function is absent from this list entirely.
    expect(signers).toContain('handlers/consent-decision.handler')
    expect(signers).not.toContain('handlers/consent-mandates.handler')
    expect(signers).not.toContain('handlers/evidence.handler')
  })

  it('puts the two consent operations behind two separate Function URLs', () => {
    const { entities } = synthAp2()

    const functions = entities.findResources('AWS::Lambda::Function')
    const idFor = (handler: string) =>
      Object.entries(functions).find(([, fn]) => fn.Properties.Handler === handler)?.[0]

    const sessionId = idFor('handlers/consent-mandates.handler')
    const decisionId = idFor('handlers/consent-decision.handler')
    expect(sessionId).toBeDefined()
    expect(decisionId).toBeDefined()
    expect(sessionId).not.toBe(decisionId)

    // One URL per function is what makes a per-caller grant expressible at all: with one shared
    // function there is no IAM statement that says "sessions yes, signing no".
    const urls = Object.values(entities.findResources('AWS::Lambda::Url')).map(
      (u) => (u.Properties.TargetFunctionArn as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0],
    )
    expect(urls).toContain(sessionId)
    expect(urls).toContain(decisionId)
    for (const url of Object.values(entities.findResources('AWS::Lambda::Url'))) {
      expect(url.Properties.AuthType).toBe('AWS_IAM')
    }
  })

  it('leaves the agent stack with no grant on the Mandate Authority', () => {
    // `AgentStack` is not synthesized here (see the file header — it builds a Docker image), so the
    // guarantee is asserted against its source: the property exists on the entities stack, and the
    // agent stack must never reference it. A future `consentDecisionUrl.grantInvokeUrl(runtimeRole)`
    // would reopen exactly the hole this split closed, and would fail here.
    const source = readFileSync(new URL('../stacks/agent-stack.ts', import.meta.url), 'utf8')
    expect(source).toContain('consentUrl.grantInvokeUrl')
    expect(source).not.toContain('consentDecisionUrl')
  })
})

describe('Ap2EntitiesStack — least privilege', () => {
  it('exposes every entity URL as IAM-authenticated, never public', () => {
    const { entities } = synthAp2()
    const urls = Object.values(entities.findResources('AWS::Lambda::Url'))

    // A single public URL here would expose an entity that signs with a KMS key to the internet.
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url.Properties.AuthType).toBe('AWS_IAM')
    }
  })

  it('lets only the MPP verify all four keys, and lets each entity sign with just its own', () => {
    const { entities } = synthAp2()
    const signStatements = allStatements(entities).filter((s) =>
      JSON.stringify(s.Action ?? '').includes('kms:Sign'),
    )

    // Four signing entities (the Evidence Store holds no key), each granted exactly one key ARN.
    expect(signStatements).toHaveLength(4)
    for (const statement of signStatements) {
      const resources = statement.Resource
      expect(Array.isArray(resources) ? resources : [resources]).toHaveLength(1)
    }
  })

  it('grants the Evidence Store no KMS access at all', () => {
    const { entities } = synthAp2()

    // The Evidence Store records what happened; it does not attest to anything. A signing or
    // verifying key on this role would be authority it has no reason to hold.
    const statements = statementsForHandler(entities, 'handlers/evidence.handler')
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(JSON.stringify(statement.Action ?? '')).not.toContain('kms:')
    }
  })

  it('grants the Merchant no access to the credential store', () => {
    const { entities } = synthAp2()

    // Role separation has to hold at the IAM layer too: the Merchant drives the MPP but must never
    // be able to read or redeem a credential itself.
    const statements = statementsForHandler(entities, 'handlers/merchant.handler')
    const resources = JSON.stringify(statements.map((s) => s.Resource))
    expect(resources).not.toContain('Credentials')
    expect(resources).not.toContain('PmRegistry')
  })

  it('gives entities write-only access to the evidence log, so nothing can rewrite the trail', () => {
    const { entities } = synthAp2()
    // The four verifying entities append to the trail; only the Evidence Store reads it back.
    for (const handler of [
      'handlers/merchant.handler',
      // The consent *session* function appends nothing — it signs nothing. The Mandate Authority
      // does, so it is the one carrying the consent surface's evidence grant.
      'handlers/consent-decision.handler',
      'handlers/credential-provider.handler',
      'handlers/mpp.handler',
    ]) {
      const statements = statementsForHandler(entities, handler)
      const evidenceStatements = statements.filter((s) =>
        JSON.stringify(s.Resource ?? '').includes('Evidence'),
      )
      expect(evidenceStatements).toHaveLength(1)
      // Append-only: an entity may add to the record of what it did, and cannot amend or erase it.
      // CloudFormation collapses a single-element action list to a bare string, so normalize first.
      const actions = evidenceStatements[0].Action
      expect(Array.isArray(actions) ? actions : [actions]).toEqual(['dynamodb:PutItem'])
    }
  })

  it('bounds every entity log group instead of leaving Lambda to create one that never expires', () => {
    const { entities } = synthAp2()
    const groups = Object.values(entities.findResources('AWS::Logs::LogGroup'))
    // Six: the five AP2 entities plus the Mandate Authority, the consent surface's signing half.
    expect(groups).toHaveLength(6)
    for (const group of groups) {
      expect(group.Properties.RetentionInDays).toBeGreaterThan(0)
    }
  })

  it('runs every entity on the same Node runtime the rest of the app targets', () => {
    const { entities } = synthAp2()
    const functions = Object.values(entities.findResources('AWS::Lambda::Function'))
    expect(functions).toHaveLength(6)
    for (const fn of functions) {
      expect(fn.Properties.Runtime).toBe('nodejs22.x')
    }
  })
})

describe('the pilot posture is in the template, not only in the README', () => {
  it('enrols every user in a second factor when MFA is required', () => {
    const { template } = synthAuth({ profile: 'pilot', mfa: 'required' })

    // An account here approves payments and reads a purchase history. `OPTIONAL` would mean most
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

    // The one that is not merely a default. Cognito cannot add a standard attribute to a live pool:
    // CloudFormation tries `AddCustomAttributes`, which takes custom attributes only and wants a
    // data type the CDK does not render for standard ones, and the deploy fails with "Invalid
    // AttributeDataType input". A schema that grows by default breaks every existing deployment.
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
    const arns = bedrockModelResources(scope, 'global.anthropic.claude-sonnet-4-6')

    expect(arns).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6')
    expect(arns).toContain(
      'arn:aws:bedrock:*:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6',
    )
  })

  it('names the model directly when the id is not a profile', () => {
    const arns = bedrockModelResources(scope, 'anthropic.claude-sonnet-4-6')

    expect(arns).toEqual(['arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6'])
  })

  it('never widens to every model or every Bedrock resource', () => {
    // The posture this replaced: `foundation-model/*` in every region plus `bedrock:*` in the
    // account — a budget with no ceiling and a data path with no boundary.
    for (const id of ['global.anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6']) {
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
