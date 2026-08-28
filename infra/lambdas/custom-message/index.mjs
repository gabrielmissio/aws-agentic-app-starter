/**
 * Cognito CustomMessage trigger — the plumbing that picks a message type, resolves the app URL and
 * decides what happens when something breaks. The copy and HTML live in `email-template.mjs`.
 *
 * It sits on the critical path of `AdminCreateUser` and `SignUp`: if it throws, the operation fails
 * with it. So it keeps two properties — it returns unknown trigger sources untouched, leaving
 * forgot-password and MFA on the pool's own templates, and it wraps everything, falling through to
 * the unchanged event so the plain-text fallback goes out rather than the operation failing.
 *
 * Plain `.mjs` with no third-party imports, so it needs no build step and cannot drift from what is
 * deployed. `@aws-sdk/client-ssm` is imported lazily from the runtime's own bundled SDK.
 */
import { buildInviteMessage, buildVerificationMessage } from './email-template.mjs'

/**
 * Where the recipient's language lives. Must match `LOCALE_ATTRIBUTE` in `chatbot-bff/src/admin.ts`.
 * See the note in `auth-stack.ts` for why it is custom and why it is not named `locale`.
 */
const LOCALE_ATTRIBUTE = 'custom:inviteLocale'

/** Reads the recipient's language off the attributes Cognito hands this trigger. */
function readLocale(userAttributes) {
  const value = userAttributes?.[LOCALE_ATTRIBUTE]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Cached across warm invocations so a busy pool does not re-read SSM per email — but only a
 * resolved URL: caching a miss would keep a container sending link-less emails long after the
 * parameter exists.
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
 * `APP_URL` wins, otherwise the URL the frontend stack published to SSM — which is what breaks the
 * cycle, since that stack consumes the pool this trigger belongs to.
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
    // Expected before the frontend stack has deployed: the email goes out without a link, which
    // beats failing sign-up over a missing URL.
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
