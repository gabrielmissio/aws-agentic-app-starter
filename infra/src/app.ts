#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { AgentStack } from './stacks/agent-stack.js'
import { AuthStack } from './stacks/auth-stack.js'
import { BffStack } from './stacks/bff-stack.js'
import { FrontendStack } from './stacks/frontend-stack.js'
import {
  assertDeploymentPosture,
  assertDeploymentTarget,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REGION,
  pickDefinedEnvironment,
  resolveAgentImagePlatform,
  resolveAlertEmail,
  resolveAllowedOrigin,
  resolveApiThrottle,
  resolveBedrockModelId,
  resolveConversationRetentionDays,
  resolveGuardrailEnabled,
  resolveAgentObservabilityEnabled,
  resolveTracingEnabled,
  resolveTransactionSearchEnabled,
  DEFAULT_CONVERSATION_RETENTION_DAYS,
  resolveDeployProfile,
  resolveExpectedAccount,
  resolveExpectedRegion,
  resolveMfaMode,
  resolveMonthlyBudgetUsd,
  resolvePublicSignUpEnabled,
  resolveRetainData,
  resolveThreatProtection,
  resolveUserRateLimit,
  resolveWafEnabled,
} from './config.js'

export const app = new cdk.App()

const projectName =
  app.node.tryGetContext('projectName') ?? process.env.PROJECT_NAME ?? DEFAULT_PROJECT_NAME

// Applied to every taggable resource in every stack, which is what makes a cost report possible:
// Cost Explorer groups by tag, and an untagged Lambda or table is spend nobody can attribute.
// One key is enough — two deployments cannot share an account and region anyway, since every
// resource name here is prefixed with PROJECT_NAME and would collide.
//
// The key must be activated as a cost allocation tag in Billing before it appears as a cost
// dimension. Note that the budget in `BffStack` does NOT filter on it — see the note there.
cdk.Tags.of(app).add('Project', projectName)

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? DEFAULT_REGION,
}

const agentImagePlatform = resolveAgentImagePlatform(
  app.node.tryGetContext('agentImagePlatform') ?? process.env.AGENT_IMAGE_PLATFORM,
)

const publicSignUpEnabled = resolvePublicSignUpEnabled(
  app.node.tryGetContext('publicSignUpEnabled') ?? process.env.PUBLIC_SIGNUP_ENABLED,
)

// ── Deployment profile ─────────────────────────────────────────────────
// What this deployment is for, which decides what the settings below are allowed to be.
const profile = resolveDeployProfile(
  app.node.tryGetContext('deployProfile') ?? process.env.DEPLOY_PROFILE,
)
const mfa = resolveMfaMode(process.env.COGNITO_MFA)
const threatProtection = resolveThreatProtection(process.env.COGNITO_THREAT_PROTECTION)
const wafEnabled = resolveWafEnabled(process.env.WAF_ENABLED)
const guardrailEnabled = resolveGuardrailEnabled(process.env.GUARDRAIL_ENABLED)
const tracingEnabled = resolveTracingEnabled(process.env.TRACING_ENABLED)
const agentObservabilityEnabled = resolveAgentObservabilityEnabled(
  process.env.AGENT_OBSERVABILITY_ENABLED,
)
const transactionSearchEnabled = resolveTransactionSearchEnabled(
  process.env.TRANSACTION_SEARCH_ENABLED,
)
// Undefined is a real state here, not a missing default: the gate refuses a `pilot`/`prod` that has
// not answered "how long do you keep what people typed". Only a sandbox falls through to the
// template's number, because a sandbox holds nothing worth a policy.
const declaredRetentionDays = resolveConversationRetentionDays(
  process.env.CONVERSATION_RETENTION_DAYS,
)

// Where this stack is allowed to land. Checked before anything is described, so a misdirected
// deploy fails at synth rather than at the CloudFormation change set.
assertDeploymentTarget({
  profile,
  account: env.account,
  region: env.region,
  expectedAccount: resolveExpectedAccount(process.env.DEPLOY_ACCOUNT),
  expectedRegion: resolveExpectedRegion(process.env.DEPLOY_REGION),
})

// ── Pilot / production guardrails ──────────────────────────────────────
const retainData = resolveRetainData(process.env.RETAIN_DATA)
const alertEmail = resolveAlertEmail(process.env.ALERT_EMAIL)
const monthlyBudgetUsd = resolveMonthlyBudgetUsd(process.env.MONTHLY_BUDGET_USD)
const throttle = resolveApiThrottle(process.env.API_RATE_LIMIT, process.env.API_BURST_LIMIT)
const allowedOrigin = resolveAllowedOrigin(process.env.ALLOWED_ORIGIN)
const userRateLimit = resolveUserRateLimit(
  process.env.USER_RATE_LIMIT,
  process.env.USER_RATE_LIMIT_WINDOW_SECONDS,
)

const appUrl = process.env.APP_URL?.trim() || undefined

// The gate. It runs before a single construct is instantiated, so a `pilot` or `prod` deployment
// still carrying a sandbox default fails at `cdk synth` — not at `cdk deploy`, and not in review.
// Everything it judges is resolved above; nothing below it can weaken what it checked.
assertDeploymentPosture({
  profile,
  publicSignUpEnabled,
  allowedOrigin,
  alertEmail,
  mfa,
  threatProtection,
  retainData,
  guardrailEnabled,
  tracingEnabled,
  agentObservabilityEnabled,
  transactionSearchEnabled,
  conversationRetentionDays: declaredRetentionDays,
})

const conversationRetentionDays = declaredRetentionDays ?? DEFAULT_CONVERSATION_RETENTION_DAYS

// ── Auth (Cognito User Pool) ───────────────────────────────────────────
const authStack = new AuthStack(app, `${projectName}-auth`, {
  projectName,
  publicSignUpEnabled,
  retainData,
  appUrl,
  profile,
  mfa,
  threatProtection,
  env,
})

// ── Agent Runtime (Bedrock AgentCore + container image) ───────────────
// SigV4-only: no authorizer configuration, and nothing outside the BFF's execution role is granted
// `InvokeAgentRuntime`. The stack therefore needs nothing from the auth stack at all — see the note
// on `AgentStack` for why the browser must not have a path here.
const agentStack = new AgentStack(app, `${projectName}-agent`, {
  projectName,
  imagePlatform: agentImagePlatform,
  // Passed through to the container as plain `environmentVariables` on the CfnRuntime, so anything
  // listed here is readable in the CloudFormation template and by any principal holding
  // `bedrock-agentcore:GetAgentRuntime`. Non-secret configuration only — a real secret belongs in
  // Secrets Manager and gets fetched at cold start.
  // `BEDROCK_MODEL_ID` is set by the stack itself from `modelId`, not passed through here — the
  // role is scoped to that one model, so the value the container reads and the value IAM allows
  // have to come from the same place.
  // Telemetry is no longer passed through here. It used to be, on the assumption that a deployment
  // brings its own OTLP collector — a model AWS has since retired for agent observability, and one
  // that left the deployed runtime silent because nothing ever set the address. `AgentStack` now
  // derives the endpoints and headers from the stack's own resources, so the log group the spans
  // land in and the log group this stack applies a retention and a data protection policy to are
  // the same log group by construction.
  runtimeEnvironment: pickDefinedEnvironment(['MEMORY_MAX_MESSAGES']),
  modelId: resolveBedrockModelId(process.env.BEDROCK_MODEL_ID),
  conversationRetentionDays,
  guardrailEnabled,
  agentObservabilityEnabled,
  retainData,
  env,
})

// ── BFF (API Gateway + Lambda) ─────────────────────────────────────────────────
const bffStack = new BffStack(app, `${projectName}-bff`, {
  projectName,
  userPool: authStack.userPool,
  agentRuntimeArn: agentStack.runtimeArn,
  throttle,
  allowedOrigin,
  userRateLimit,
  alertEmail,
  monthlyBudgetUsd,
  wafEnabled,
  encryptionKey: agentStack.encryptionKey,
  memoryId: agentStack.memoryId,
  memoryArn: agentStack.memoryArn,
  conversationRetentionDays,
  modelId: resolveBedrockModelId(process.env.BEDROCK_MODEL_ID),
  ...(agentObservabilityEnabled ? { agentMetricNamespace: `${projectName}/Agent` } : {}),
  tracingEnabled,
  retainData,
  env,
})
bffStack.addStackDependency(agentStack)

// ── Frontend (S3 + CloudFront) ─────────────────────────────────────────
// Must run AFTER auth and bff stacks so their outputs are available.
const frontendStack = new FrontendStack(app, `${projectName}-frontend`, {
  projectName,
  bffUrl: bffStack.apiUrl,
  cognitoUserPoolId: authStack.userPool.userPoolId,
  cognitoUserPoolClientId: authStack.userPoolClient.userPoolClientId,
  cognitoRegion: env.region ?? DEFAULT_REGION,
  publicSignUpEnabled,
  mfa,
  retainData,
  env,
})
frontendStack.addStackDependency(bffStack)
