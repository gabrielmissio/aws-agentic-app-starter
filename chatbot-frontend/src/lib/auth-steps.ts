import type { SignInOutput } from 'aws-amplify/auth'

/**
 * Sign-in as a chain of challenges. It is not one answer: an admin-created user with MFA required
 * is asked for a new password and then to enroll a factor, each its own round trip — so the caller
 * routes *every* result, including the one returned from answering a challenge.
 */

/** The views that answer a challenge. `signIn` and `signUp` are entry points, not challenges. */
export type ChallengeView = 'newPassword' | 'totpSetup' | 'totpCode'

/** What an authenticator app needs to enroll: a key to store, and a link that stores it for you. */
export interface TotpSetup {
  sharedSecret: string
  /** The `otpauth://` URI an authenticator opens directly. */
  setupUri: string
}

export type SignInRouting =
  | { kind: 'signedIn' }
  | { kind: 'challenge'; view: ChallengeView; totp?: TotpSetup }
  /** A step this build does not implement. Surfaced, never swallowed — see below. */
  | { kind: 'unsupported'; step: string }

/**
 * What a sign-in result means for the screen. `issuer` and `account` label the authenticator app's
 * list entry — without them, someone enrolled in two environments cannot tell the codes apart.
 *
 * An unrecognized step returns `unsupported` rather than being swallowed: Cognito adds steps over
 * time, and ignoring one leaves the user at a form that will never proceed. There is deliberately no
 * `MFA_SELECTION` branch — the pool offers TOTP alone, so Cognito never asks which factor to use.
 */
export function routeSignIn(
  result: SignInOutput,
  labels: { issuer: string; account: string },
): SignInRouting {
  if (result.isSignedIn) return { kind: 'signedIn' }

  const step = result.nextStep

  switch (step.signInStep) {
    // An admin-created user's temporary password. Reachable whether or not public sign-up is on,
    // since an admin can always create a user directly.
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
      return { kind: 'challenge', view: 'newPassword' }

    // `COGNITO_MFA=required` with no factor yet — every existing account meets this the day MFA
    // is turned on, which is why it cannot be left unhandled.
    case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
      return {
        kind: 'challenge',
        view: 'totpSetup',
        totp: {
          sharedSecret: step.totpSetupDetails.sharedSecret,
          setupUri: step.totpSetupDetails.getSetupUri(labels.issuer, labels.account).toString(),
        },
      }

    // Already enrolled: just the code.
    case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
      return { kind: 'challenge', view: 'totpCode' }

    default:
      return { kind: 'unsupported', step: step.signInStep }
  }
}
