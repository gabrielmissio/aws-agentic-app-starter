#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { AgentStack } from './stacks/agent-stack.js'
import { Ap2EntitiesStack } from './stacks/ap2-entities-stack.js'
import { AuthStack } from './stacks/auth-stack.js'
import { BffStack } from './stacks/bff-stack.js'
import { DataStack } from './stacks/data-stack.js'
import { FrontendStack } from './stacks/frontend-stack.js'
import { SecurityStack } from './stacks/security-stack.js'
import {
  assertDeploymentPosture,
  assertDeploymentTarget,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REGION,
  pickDefinedEnvironment,
  resolveAgentImagePlatform,
  resolveAlertEmail,
  resolveAllowedMpps,
  resolveAllowedOrigin,
  resolveAp2RateLimit,
  resolveApiThrottle,
  resolveAutoProvisionSandboxMethod,
  resolveBedrockModelId,
  resolveDeployProfile,
  resolveExpectedAccount,
  resolveExpectedRegion,
  resolveIntentTtlMinutes,
  resolveMfaMode,
  resolveMonthlyBudgetUsd,
  resolveOtpRevealInUi,
  resolveOtpStepUpThresholdCents,
  resolvePublicSignUpEnabled,
  resolveRetainData,
  resolveThreatProtection,
  resolveUserRateLimit,
  resolveWafEnabled,
} from './config.js'

const app = new cdk.App()

const projectName =
  app.node.tryGetContext('projectName') ?? process.env.PROJECT_NAME ?? DEFAULT_PROJECT_NAME

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

// ── AP2 ────────────────────────────────────────────────────────────────
const allowedMpps = resolveAllowedMpps(process.env.ALLOWED_MPPS)
const autoProvisionSandboxMethod = resolveAutoProvisionSandboxMethod(
  process.env.AUTO_PROVISION_SANDBOX_METHOD,
)
const otpStepUpThresholdCents = resolveOtpStepUpThresholdCents(
  process.env.OTP_STEPUP_THRESHOLD_CENTS,
)
const intentTtlMinutes = resolveIntentTtlMinutes(process.env.INTENT_TTL_MIN)
const ap2RateLimit = resolveAp2RateLimit(
  process.env.AP2_RATE_LIMIT,
  process.env.AP2_RATE_LIMIT_WINDOW_SECONDS,
)
const otpRevealInUi = resolveOtpRevealInUi(process.env.OTP_REVEAL_IN_UI)

// The gate. It runs before a single construct is instantiated, so a `pilot` or `prod` deployment
// still carrying a sandbox default fails at `cdk synth` — not at `cdk deploy`, and not in review.
// Everything it judges is resolved above; nothing below it can weaken what it checked.
assertDeploymentPosture({
  profile,
  publicSignUpEnabled,
  otpRevealInUi,
  allowedOrigin,
  alertEmail,
  mfa,
  threatProtection,
  retainData,
  autoProvisionSandboxMethod,
})

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

// ── AP2 state and signing keys ─────────────────────────────────────────
// Deployed before the entities that use them: the entity roles are granted against these ARNs, so
// the dependency runs data/security → entities and never the other way.
const dataStack = new DataStack(app, `${projectName}-data`, {
  projectName,
  retainData,
  env,
})

const securityStack = new SecurityStack(app, `${projectName}-security`, {
  projectName,
  retainData,
  env,
})

// ── AP2 entities (the five verifying Lambdas) ──────────────────────────
const ap2Stack = new Ap2EntitiesStack(app, `${projectName}-ap2`, {
  projectName,
  data: dataStack,
  security: securityStack,
  allowedMpps,
  autoProvisionSandboxMethod,
  env,
})
ap2Stack.addStackDependency(dataStack)
ap2Stack.addStackDependency(securityStack)

// ── Agent Runtime (Bedrock AgentCore + container image) ───────────────
// SigV4-only: no authorizer configuration, and nothing outside the BFF's execution role is granted
// `InvokeAgentRuntime`. The stack therefore needs nothing from the auth stack at all — see the note
// on `AgentStack` for why the browser must not have a path here.
const agentStack = new AgentStack(app, `${projectName}-agent`, {
  projectName,
  imagePlatform: agentImagePlatform,
  ap2: ap2Stack,
  // Passed through to the container as plain `environmentVariables` on the CfnRuntime, so anything
  // listed here is readable in the CloudFormation template and by any principal holding
  // `bedrock-agentcore:GetAgentRuntime`. Non-secret configuration only — a real secret belongs in
  // Secrets Manager and gets fetched at cold start, the way the BFF reads its HMAC key.
  // `BEDROCK_MODEL_ID` is set by the stack itself from `modelId`, not passed through here — the
  // role is scoped to that one model, so the value the container reads and the value IAM allows
  // have to come from the same place.
  runtimeEnvironment: pickDefinedEnvironment([]),
  modelId: resolveBedrockModelId(process.env.BEDROCK_MODEL_ID),
  env,
})
agentStack.addStackDependency(ap2Stack)

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
  ap2: ap2Stack,
  data: dataStack,
  security: securityStack,
  intentTtlMinutes,
  otpStepUpThresholdCents,
  otpRevealInUi,
  ap2RateLimit,
  wafEnabled,
  env,
})
bffStack.addStackDependency(agentStack)
bffStack.addStackDependency(ap2Stack)

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
