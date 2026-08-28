import type { SignInOutput } from 'aws-amplify/auth'

/**
 * Sign-in as a chain of challenges, and the decision of what to show for each one.
 *
 * A sign-in is not one answer. An admin-created user with MFA required is asked for a new password,
 * and then to enroll a second factor, each as its own round trip — so the caller has to route
 * *every* result, including the one it gets back from answering a challenge, rather than assuming
 * that a successful call means a session.
 *
 * It lives here, apart from the screen that renders it, because it is the part with rules: which
 * steps are handled, what the enrollment needs, and what happens to a step nobody anticipated. The
 * component then only has to render the answer.
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
 * Decides what a sign-in result means for the screen.
 *
 * `issuer` and `account` label the entry the authenticator app shows in its list. Both matter: with
 * neither, someone who has enrolled in more than one environment sees identical unlabelled entries
 * and cannot tell which code belongs to which.
 *
 * An unrecognized step returns `unsupported` rather than being treated as a failure or, worse, as
 * nothing at all. Cognito adds sign-in steps over time, and a screen that quietly ignores one
 * leaves the user looking at a form that will never proceed.
 *
 * There is deliberately no `CONTINUE_SIGN_IN_WITH_MFA_SELECTION` branch. The pool offers TOTP alone
 * (see `infra/src/stacks/auth-stack.ts`), so Cognito never asks which factor to use — and adding a
 * selection screen would mean offering SMS, which nothing in this app can enroll anyone in.
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

    // `COGNITO_MFA=required` on a user with no factor yet. Everyone meets this once, including
    // every existing account on the day MFA is turned on — which is why it cannot be left unhandled.
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
