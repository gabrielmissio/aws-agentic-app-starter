/**
 * Stable error codes for the API.
 *
 * The BFF answers with a `code` plus an English `error` sentence. The code is what clients branch
 * on and localize; the sentence exists so `curl` and CloudWatch stay readable. This is what keeps
 * server-side i18n out of the picture entirely — the server never ships prose anyone must translate,
 * and adding a language touches only the frontend catalogs.
 *
 * Codes are camelCase because the frontend maps them straight onto `error.<code>` message keys.
 */
export type ErrorCode =
  | 'invalidBody'
  | 'invalidEmail'
  | 'invalidRole'
  | 'invalidLocale'
  | 'emailAlreadyExists'
  | 'forbidden'
  | 'notFound'
  | 'internal'
  // ── AP2 checkout ──────────────────────────────────────────────────────
  | 'unauthenticated'
  | 'consentSessionNotFound'
  | 'intentNotFound'
  | 'intentExpired'
  | 'intentResolved'
  | 'intentTampered'
  | 'otpRequired'
  | 'otpInvalid'
  | 'otpAttemptsExhausted'
  | 'stepUpUnavailable'
  | 'tooManyRequests'
  | 'checkoutBlocked'

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalidBody: 'The request body is malformed',
  invalidEmail: 'A valid "email" is required',
  invalidRole: '"role" must be "admin" or "user"',
  invalidLocale: '"locale" is not a supported language',
  emailAlreadyExists: 'That email already has an account',
  forbidden: 'Admin group membership required',
  notFound: 'Not found',
  internal: 'Internal server error',
  unauthenticated: 'Sign in to continue',
  consentSessionNotFound: 'That checkout is no longer available',
  intentNotFound: 'That checkout is no longer available',
  intentExpired: 'The approval window has closed',
  intentResolved: 'That checkout has already been decided',
  intentTampered: 'The approval could not be verified',
  otpRequired: 'A one-time code is required',
  otpInvalid: 'That code is not correct',
  otpAttemptsExhausted: 'Too many incorrect codes — start the checkout again',
  stepUpUnavailable: 'This checkout needs a one-time code, and this deployment cannot send one',
  tooManyRequests: 'Too many checkout requests, try again shortly',
  checkoutBlocked: 'The payment chain refused this checkout',
}

export interface ErrorBody {
  code: ErrorCode
  error: string
  /**
   * The AP2 accountability code, when the chain itself refused the checkout (`TAMPERED`, `EXPIRED`,
   * `DOUBLE_SPEND`, `OUT_OF_SCOPE`, …).
   *
   * Carried alongside the client-facing code rather than folded into it: the frontend localizes
   * `code`, while this is the protocol's own vocabulary, which the Explorer shows verbatim because
   * translating it would make the audit trail harder to compare against the spec, not easier.
   */
  ap2Code?: string
}

export function errorBody(code: ErrorCode, ap2Code?: string): ErrorBody {
  return { code, error: ERROR_MESSAGES[code], ...(ap2Code ? { ap2Code } : {}) }
}
