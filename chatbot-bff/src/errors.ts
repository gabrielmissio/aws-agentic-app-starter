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
  | 'unauthenticated'
  | 'forbidden'
  | 'notFound'
  | 'tooManyRequests'
  | 'internal'

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalidBody: 'The request body is malformed',
  invalidEmail: 'A valid "email" is required',
  invalidRole: '"role" must be "admin" or "user"',
  invalidLocale: '"locale" is not a supported language',
  emailAlreadyExists: 'That email already has an account',
  unauthenticated: 'Sign in to continue',
  forbidden: 'Admin group membership required',
  notFound: 'Not found',
  tooManyRequests: 'Too many requests, try again shortly',
  internal: 'Internal server error',
}

export interface ErrorBody {
  code: ErrorCode
  error: string
}

export function errorBody(code: ErrorCode): ErrorBody {
  return { code, error: ERROR_MESSAGES[code] }
}
