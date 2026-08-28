/**
 * Cognito CustomMessage trigger — replaces the plain-text invite and sign-up-confirmation emails
 * with the designed HTML in `email-template.mjs`, and adds a link to the app when its URL is known.
 *
 * This file is the plumbing — which message type, where the app URL comes from, what happens when
 * something breaks. The copy and the HTML live in `email-template.mjs`.
 *
 * Two properties this file must keep, because it sits on the critical path of both `AdminCreateUser`
 * and `SignUp` — if this function throws, the operation that triggered the email fails with it:
 *
 *   1. It handles only the trigger sources it knows about and returns every other one untouched, so
 *      forgot-password and MFA messages keep using the pool's own configured templates.
 *   2. Everything is wrapped: any unexpected shape or bug falls through to the event unchanged,
 *      which means the pool's plain-text fallback template goes out instead of the operation failing.
 *
 * Plain `.mjs` with no third-party imports on purpose — it needs no bundler, no dependencies and no
 * build step, so it cannot drift from what is deployed. `@aws-sdk/client-ssm` is imported lazily from
 * the Lambda Node.js 22 runtime's bundled AWS SDK v3, not from a dependency this asset ships.
 */
import { buildInviteMessage, buildVerificationMessage } from './email-template.mjs'

/**
 * Where the recipient's preferred language lives.
 *
 * Must match `LOCALE_ATTRIBUTE` in `chatbot-bff/src/admin.ts` — a *custom* attribute because
 * Cognito only lets standard attributes be declared when the pool is created, so a pool that
 * already has users can never gain one. Not named `locale`: that collides with a reserved standard
 * attribute, and the resulting schema entry is indistinguishable from declaring the standard one —
 * so `custom:locale` is never actually created and the attribute write fails. See the note in
 * `auth-stack.ts`.
 */
const LOCALE_ATTRIBUTE = 'custom:inviteLocale'

/** Reads the recipient's language off the attributes Cognito hands this trigger. */
function readLocale(userAttributes) {
  const value = userAttributes?.[LOCALE_ATTRIBUTE]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Cached across warm invocations so a busy pool does not re-read SSM per email. Only a resolved,
 * non-empty URL is cached: a miss before the frontend stack has deployed must not be remembered, or
 * the container would keep sending link-less emails long after the parameter exists.
 */
let cachedAppUrl = ''

/** Test seam — resets the module-level cache. */
export function resetAppUrlCache() {
  cachedAppUrl = ''
}

async function getSsmParameter(name) {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')
  const client = new SSMClient({})
  const result = await client.send(new GetParameterCommand({ Name: name }))

  return result.Parameter?.Value
}

/**
 * Resolves where the app lives: an explicitly configured `APP_URL` wins, otherwise the URL the
 * frontend stack published to SSM.
 *
 * SSM is what breaks the dependency cycle — the frontend stack consumes the user pool this trigger
 * belongs to, so the auth stack can never receive the CloudFront URL as a synth-time reference.
 */
export async function resolveAppUrl({ env = process.env, getParameter = getSsmParameter } = {}) {
  const explicit = env.APP_URL?.trim()
  if (explicit) return explicit

  if (cachedAppUrl) return cachedAppUrl

  const parameterName = env.APP_URL_PARAMETER?.trim()
  if (!parameterName) return ''

  try {
    const value = (await getParameter(parameterName))?.trim()
    if (value) cachedAppUrl = value
    return value ?? ''
  } catch (err) {
    // Expected before the frontend stack has deployed. The email still goes out, just without a
    // link, which beats failing sign-up or user creation over a missing URL.
    console.error('Could not read the app URL from SSM; sending without a link:', err)
    return ''
  }
}

/** Also covers a resent confirmation code — same message, same content. */
const VERIFICATION_TRIGGERS = new Set(['CustomMessage_SignUp', 'CustomMessage_ResendCode'])

export const handler = async (event) => {
  try {
    const appUrl = await resolveAppUrl()
    const appName = process.env.APP_NAME
    const locale = readLocale(event.request?.userAttributes)

    if (event?.triggerSource === 'CustomMessage_AdminCreateUser') {
      const { subject, body } = buildInviteMessage(locale, appName, appUrl)
      event.response.emailSubject = subject
      event.response.emailMessage = body
    } else if (VERIFICATION_TRIGGERS.has(event?.triggerSource)) {
      const { subject, body } = buildVerificationMessage(locale, appName, appUrl)
      event.response.emailSubject = subject
      event.response.emailMessage = body
    }
  } catch (err) {
    // Never let a copy problem block sign-up or user creation — Cognito falls back to the pool's
    // own template.
    console.error('CustomMessage trigger failed, using the default template:', err)
  }

  return event
}
