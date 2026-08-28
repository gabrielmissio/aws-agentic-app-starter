import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import { appUrlParameterName } from './frontend-stack.js'
import type { DeployProfile, MfaMode, ThreatProtectionMode } from '../config.js'

export interface AuthStackProps extends cdk.StackProps {
  projectName: string
  /**
   * Whether visitors can create their own account. `false` disables self sign-up at the pool level,
   * blocking the public `SignUp` API rather than just the UI — see `infra/README.md` for the
   * operator flow that replaces it.
   */
  publicSignUpEnabled?: boolean
  /** Whether the user pool survives a stack deletion. Retained by default: losing every account is
   * not recoverable, an orphaned pool is. */
  retainData?: boolean
  /**
   * Canonical app URL, linked from the invite and confirmation emails. Optional: unset, the trigger
   * reads the CloudFront URL the frontend stack publishes to SSM, so a fresh `cdk deploy --all`
   * produces linked emails with no manual step. Set it once there is a real domain; it wins.
   */
  appUrl?: string
  /**
   * What this deployment is for. Drives the password policy and the account-recovery posture; the
   * profile gate in `app.ts` has already refused the combinations that must not reach a pilot.
   */
  profile?: DeployProfile
  /**
   * Second-factor posture. `required` enrolls every user; `optional` leaves it to them, which for a
   * system holding real conversations means most of them will not.
   */
  mfa?: MfaMode
  /**
   * Cognito threat protection. Anything but `off` moves the pool to the **Plus** feature plan, which
   * is billed per monthly active user — the reason this is explicit rather than simply on.
   */
  threatProtection?: ThreatProtectionMode
}

/**
 * Cognito group whose members the frontend and BFF treat as operators. Both sides match it exactly —
 * the frontend for an Admin badge, the BFF's admin routes to allow the call.
 */
export const ADMIN_GROUP_NAME = 'admins'

/** `MfaMode` as the pool understands it. Kept here so the config vocabulary stays CDK-free. */
const MFA_BY_MODE: Record<MfaMode, cognito.Mfa> = {
  off: cognito.Mfa.OFF,
  optional: cognito.Mfa.OPTIONAL,
  required: cognito.Mfa.REQUIRED,
}

/**
 * The Cognito User Pool behind the browser session. The browser signs in, gets an id token, and
 * sends it to the BFF, where the gateway authorizer validates it and every route reads its caller
 * from the verified claims.
 *
 * **There is no Identity Pool here, deliberately.** The browser gets a token and no AWS credentials.
 * A pool would vend credentials that let the browser reach the runtime directly and compose the
 * identity block the agent trusts, and every policy on its authenticated role is granted to anyone
 * who can sign in. `stacks.test.ts` asserts the absence, because adding one back is easy to do by
 * habit. A future browser-side AWS call belongs in the stack that needs it, scoped to that one API.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool
  public readonly userPoolClient: cognito.UserPoolClient

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props)

    const {
      projectName,
      publicSignUpEnabled = true,
      retainData = true,
      appUrl,
      profile = 'demo',
      mfa = 'off',
      threatProtection = 'off',
    } = props

    const hardened = profile !== 'demo'

    // ── User Pool ──────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${projectName}-users`,
      selfSignUpEnabled: publicSignUpEnabled,
      signInAliases: { email: true },
      autoVerify: { email: true },
      /**
       * Email alone. No `phone_number`: nothing here writes one, so it would be a slot with no
       * writer — and it cannot be added later, since Cognito accepts only *custom* attributes on a
       * live pool and fails the whole update with "Invalid AttributeDataType input" otherwise.
       * Hence no SMS channel anywhere in this deployment, and an authenticator app as the factor.
       */
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      // Read by the CustomMessage trigger to pick the email's language.
      //
      // It must NOT be named `locale`: CDK renders a custom attribute without the `custom:` prefix,
      // so a reserved standard name is indistinguishable from declaring the standard one — Cognito
      // then never creates it and every write fails at runtime. Also a one-way door: a custom
      // attribute cannot be removed from a pool's schema.
      customAttributes: {
        inviteLocale: new cognito.StringAttribute({ mutable: true }),
      },
      // Plain-text fallbacks, sent if the CustomMessage trigger declines or fails. Both apply
      // regardless of `publicSignUpEnabled`: an admin can always invite, and `userVerification`
      // simply goes unused when self sign-up is off.
      userInvitation: {
        emailSubject: `Your ${projectName} access`,
        emailBody: [
          'Hello {username},',
          '',
          'An administrator created an account for you. Use this temporary password to sign in:',
          '',
          '{####}',
          '',
          'You will be asked to choose your own password the first time you sign in.',
        ].join('<br/>'),
      },
      userVerification: {
        emailSubject: `Confirm your ${projectName} account`,
        emailBody: [
          'Confirm your email to finish creating your account.',
          '',
          'Verification code: {####}',
        ].join('<br/>'),
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      /**
       * An authenticator app, and only that. `SMS_MFA` is not offered because no phone number is
       * ever collected (see the schema above), so it would be a factor nobody could enroll in —
       * while still making CDK provision an unused SNS caller role and adding a dead-end branch to
       * the sign-in journey.
       *
       * Omitted entirely when `off` rather than written as an explicit `OFF`, so a deployment that
       * sets nothing renders the same template it did before this option existed.
       */
      ...(mfa === 'off' ? {} : { mfa: MFA_BY_MODE[mfa], mfaSecondFactor: { sms: false, otp: true } }),
      /** Twelve with a symbol outside a demo; Cognito's own default is eight with no symbol. */
      passwordPolicy: {
        minLength: hardened ? 12 : 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: hardened,
      },
      /**
       * Off by default because it is billed: any other mode moves the pool onto the Plus feature
       * plan, priced per monthly active user. The profile gate refuses `off` for a pilot, so the
       * cost is a decision rather than a side effect.
       */
      ...(threatProtection === 'off'
        ? {}
        : {
            featurePlan: cognito.FeaturePlan.PLUS,
            standardThreatProtectionMode:
              threatProtection === 'enforced'
                ? cognito.StandardThreatProtectionMode.FULL_FUNCTION
                : cognito.StandardThreatProtectionMode.AUDIT_ONLY,
          }),
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // The pool holds every account: `cdk destroy`, or a replacement-forcing property change,
      // takes them all with it.
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ── HTML invite & verification emails ────────────────────────────────
    // Rewrites the two emails above as HTML. It sits on the critical path of `AdminCreateUser` and
    // `SignUp`, which is why it swallows its own failures and lets the plain text go out instead.
    const appUrlParameter = appUrlParameterName(projectName)

    const customMessageFn = new lambda.Function(this, 'CustomMessageFunction', {
      functionName: `${projectName}-custom-message`,
      code: lambda.Code.fromAsset('lambdas/custom-message'),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      environment: {
        APP_NAME: projectName,
        // Empty unless configured; the trigger then falls back to the SSM parameter below.
        APP_URL: appUrl ?? '',
        APP_URL_PARAMETER: appUrlParameter,
      },
      logGroup: new logs.LogGroup(this, 'CustomMessageFunctionLogs', {
        logGroupName: `/aws/lambda/${projectName}-custom-message`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Granted by ARN rather than by importing the parameter construct: the parameter is created by
    // the frontend stack, and importing it would reintroduce the very dependency SSM exists to break.
    customMessageFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Arn.format(
            { service: 'ssm', resource: 'parameter', resourceName: appUrlParameter.slice(1) },
            this,
          ),
        ],
      }),
    )

    this.userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_MESSAGE, customMessageFn)


    // ── Groups (roles) ─────────────────────────────────────────────────
    // Membership arrives as the `cognito:groups` claim on both tokens, with no Lambda in the
    // request path — unlike a pre-token-generation trigger, which bills on every issuance.
    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP_NAME,
      description: 'Operators. Membership is granted via the admin panel or `admin-add-user-to-group`.',
      precedence: 0,
    })

    // ── User Pool Client (for frontend SPA) ────────────────────────────
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${projectName}-web-client`,
      authFlows: {
        userSrp: true,        // Secure Remote Password (Amplify default)
        userPassword: false,   // Disallow plain-text password auth
      },
      generateSecret: false,   // SPAs cannot hold a secret
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    })

    // ── Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${projectName}-UserPoolId`,
    })

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${projectName}-UserPoolClientId`,
    })

    new cdk.CfnOutput(this, 'AdminGroupName', {
      value: ADMIN_GROUP_NAME,
      exportName: `${projectName}-AdminGroupName`,
    })

    new cdk.CfnOutput(this, 'CognitoRegion', {
      value: this.region,
      exportName: `${projectName}-CognitoRegion`,
    })
  }
}
