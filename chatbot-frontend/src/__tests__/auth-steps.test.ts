import { describe, expect, it } from 'vitest'
import type { SignInOutput } from 'aws-amplify/auth'
import { routeSignIn } from '../lib/auth-steps'

/**
 * The sign-in chain.
 *
 * This is the part that locked people out. With `COGNITO_MFA=required`, every account with no
 * factor enrolled — which on the day MFA is turned on is *every* account — gets an enrollment
 * challenge instead of a session. The screen handled one challenge and showed "unsupported step"
 * for the rest, so the answer to "did we turn MFA on?" was "yes, and nobody can sign in".
 */

const labels = { issuer: 'Acme', account: 'user@example.com' }

/** A `signIn`/`confirmSignIn` result carrying one challenge. */
function challenge(step: string, extra: Record<string, unknown> = {}): SignInOutput {
  return { isSignedIn: false, nextStep: { signInStep: step, ...extra } } as unknown as SignInOutput
}

const totpSetupDetails = {
  sharedSecret: 'JBSWY3DPEHPK3PXP',
  getSetupUri: (issuer: string, account?: string) =>
    new URL(`otpauth://totp/${issuer}:${account ?? ''}?secret=JBSWY3DPEHPK3PXP&issuer=${issuer}`),
}

describe('routing a sign-in result', () => {
  it('reports a completed sign-in', () => {
    expect(routeSignIn({ isSignedIn: true } as SignInOutput, labels)).toEqual({ kind: 'signedIn' })
  })

  it('routes an admin-created user to the password change', () => {
    expect(routeSignIn(challenge('CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'), labels)).toEqual({
      kind: 'challenge',
      view: 'newPassword',
    })
  })

  it('routes a user with no factor to enrollment, with what an authenticator needs', () => {
    const routing = routeSignIn(
      challenge('CONTINUE_SIGN_IN_WITH_TOTP_SETUP', { totpSetupDetails }),
      labels,
    )

    expect(routing).toMatchObject({ kind: 'challenge', view: 'totpSetup' })
    expect(routing).toHaveProperty('totp.sharedSecret', 'JBSWY3DPEHPK3PXP')
  })

  it('labels the authenticator entry with both the issuer and the account', () => {
    // Someone enrolled in more than one environment otherwise sees identical unlabelled entries and
    // cannot tell which six digits belong to which deployment.
    const routing = routeSignIn(
      challenge('CONTINUE_SIGN_IN_WITH_TOTP_SETUP', { totpSetupDetails }),
      labels,
    )

    // Asserted on what is passed through to `getSetupUri`, not on how it escapes them — the
    // escaping is Amplify's, and pinning it here would be testing the stub above.
    const uri = (routing as { totp: { setupUri: string } }).totp.setupUri
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain('Acme')
    expect(uri).toContain('user@example.com')
  })

  it('routes an already-enrolled user straight to the code', () => {
    expect(routeSignIn(challenge('CONFIRM_SIGN_IN_WITH_TOTP_CODE'), labels)).toEqual({
      kind: 'challenge',
      view: 'totpCode',
    })
  })

  it('surfaces a step it does not implement instead of stalling on it', () => {
    // Cognito adds sign-in steps over time. A screen that ignores an unknown one leaves the user
    // looking at a form that will never proceed, with nothing on screen saying why.
    expect(routeSignIn(challenge('CONFIRM_SIGN_IN_WITH_EMAIL_CODE'), labels)).toEqual({
      kind: 'unsupported',
      step: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
    })
  })

  it('handles every challenge the configured pool can actually produce', () => {
    // The pool offers TOTP alone, so these three are the complete set — there is no MFA-selection
    // step, because Cognito only asks when more than one factor is enabled.
    const reachable = [
      'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
      'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
      'CONFIRM_SIGN_IN_WITH_TOTP_CODE',
    ]

    for (const step of reachable) {
      const routing = routeSignIn(challenge(step, { totpSetupDetails }), labels)
      expect(routing.kind, step).toBe('challenge')
    }
  })
})
