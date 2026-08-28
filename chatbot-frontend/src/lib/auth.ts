import { Amplify } from 'aws-amplify'
import { readAppConfig } from './app-config'

/**
 * Initializes Amplify with the Cognito user-pool config. Call once at app startup (main.tsx).
 */
export function configureAuth() {
  const userPoolId = readAppConfig('VITE_COGNITO_USER_POOL_ID')
  const userPoolClientId = readAppConfig('VITE_COGNITO_USER_POOL_CLIENT_ID')

  if (!userPoolId || !userPoolClientId) {
    console.warn('[auth] Cognito config missing — sign-in unavailable')
    return
  }

  // User pool only: no `identityPoolId`, because nothing in the browser calls an AWS API directly.
  // The app carries a Cognito token to the BFF and the BFF does the rest — so there is no reason to
  // vend a signed-in browser AWS credentials, and every reason not to.
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: { email: true },
      },
    },
  })
}

/**
 * Whether the auth screen should offer self-service sign-up.
 *
 * Mirrors `AuthStackProps.publicSignUpEnabled` in `infra/src/stacks/auth-stack.ts`. When `false`,
 * the user pool has self sign-up disabled and every account is created by an admin via
 * `admin-create-user` — the auth screen must offer sign-in only, and route the mandatory
 * first-login password change through the NEW_PASSWORD_REQUIRED challenge instead of a sign-up form.
 * Defaults to enabled: absent config should not silently lock visitors out of a demo deployment.
 */
export function isPublicSignUpEnabled(): boolean {
  return readAppConfig('VITE_PUBLIC_SIGNUP_ENABLED') !== 'false'
}
