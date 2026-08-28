/**
 * Admin routes — list users and invite new ones.
 *
 * A separate Lambda from the chat handler: this one holds `cognito-idp:AdminCreate*`, and the
 * function relaying untrusted model output must not — which bounds what a compromise there reaches.
 *
 *   GET  /admin/users  → { users: UserSummary[] }
 *   POST /admin/users  → { user: UserSummary }   body: { email, role?: 'admin' | 'user', locale? }
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  InvalidParameterException,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider'
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import {
  ADMIN_GROUP,
  LOCALE_ATTRIBUTE,
  auditRecord,
  isAdminClaims,
  parseInviteRequest,
  resolveAdminRoute,
  toUserSummary,
  type Actor,
  type AuditRecord,
  type UserSummary,
} from './admin.js'
import { ADMIN_CORS_METHODS, jsonHeaders } from './http.js'
import { errorBody, type ErrorCode } from './errors.js'

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'

const cognito = new CognitoIdentityProviderClient({})

/** One line per privileged action, structured so it can be queried rather than grepped. */
function audit(record: AuditRecord) {
  console.log(JSON.stringify(record))
}

/** Cognito paginates at 60 users per page; the panel is a demo surface, so one page is enough. */
const LIST_LIMIT = 60

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin ?? event.headers?.Origin
  const headers = jsonHeaders(ALLOWED_ORIGIN, origin, ADMIN_CORS_METHODS)
  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: JSON.stringify(body),
  })
  const fail = (statusCode: number, code: ErrorCode) => respond(statusCode, errorBody(code))

  const route = resolveAdminRoute(event.httpMethod, event.path)

  if (route === 'preflight') return { statusCode: 204, headers, body: '' }
  if (!route) return fail(404, 'notFound')

  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined
  const actor: Actor = {
    sub: typeof claims?.sub === 'string' ? claims.sub : undefined,
    email: typeof claims?.email === 'string' ? claims.email : undefined,
  }

  // The gateway's authorizer has already validated signature, expiry and issuer, so these claims are
  // the verified ones. This group check is the privilege boundary; the UI's badge is cosmetic.
  if (!isAdminClaims(claims)) {
    // A denied attempt is the most interesting line in the log, not the least.
    audit(auditRecord(route, actor, 'denied'))
    return fail(403, 'forbidden')
  }

  try {
    if (route === 'listUsers') {
      const users = await listUsers()
      audit(auditRecord('listUsers', actor, 'success', { detail: { count: users.length } }))
      return respond(200, { users })
    }

    return await inviteUser(event.body, actor, respond, fail)
  } catch (err) {
    console.error('Admin handler error:', err)
    audit(auditRecord(route, actor, 'error'))
    return fail(500, 'internal')
  }
}

async function listUsers(): Promise<UserSummary[]> {
  const [all, admins] = await Promise.all([
    cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: LIST_LIMIT })),
    cognito.send(new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: ADMIN_GROUP })),
  ])

  const adminUsernames = new Set(
    (admins.Users ?? []).map((user) => user.Username).filter((name): name is string => !!name),
  )

  return (all.Users ?? [])
    .map((user) => toUserSummary(user, adminUsernames))
    .sort((a, b) => (a.email ?? a.username).localeCompare(b.email ?? b.username))
}

async function inviteUser(
  body: string | null,
  actor: Actor,
  respond: (statusCode: number, body: unknown) => APIGatewayProxyResult,
  fail: (statusCode: number, code: ErrorCode) => APIGatewayProxyResult,
): Promise<APIGatewayProxyResult> {
  const parsed = parseInviteRequest(body ?? '{}')
  if (!parsed.ok) return fail(400, parsed.code)

  const { email, role, locale } = parsed.value

  // `email_verified` is set here so the invited user can later use the forgot-password flow.
  //
  // The CustomMessage trigger reads the locale attribute to pick the email's language. It must be a
  // stored attribute, not `ClientMetadata`: `AdminCreateUser` invokes the trigger, but that trigger
  // source is documented to receive none. Storing it also survives a resent invite.
  const baseAttributes = [
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: 'true' },
  ]

  const create = (attributes: { Name: string; Value: string }[]) =>
    cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: attributes,
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    )

  try {
    let created

    try {
      created = await create([...baseAttributes, { Name: LOCALE_ATTRIBUTE, Value: locale }])
    } catch (err) {
      // The email's language is a nicety; inviting someone is not. A pool without the attribute —
      // predating it, or having declared it under a reserved name — would otherwise fail the whole
      // invite. The user is created anyway, and Cognito sends the pool's default template.
      if (!(err instanceof InvalidParameterException) || !err.message.includes(LOCALE_ATTRIBUTE)) {
        throw err
      }

      audit(
        auditRecord('inviteUser', actor, 'success', {
          target: email,
          detail: { localeAttributeMissing: LOCALE_ATTRIBUTE, emailLanguage: 'pool default' },
        }),
      )
      created = await create(baseAttributes)
    }

    if (role === 'admin') {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: created.User?.Username ?? email,
          GroupName: ADMIN_GROUP,
        }),
      )
    }

    const summary = toUserSummary(
      created.User ?? { Username: email },
      role === 'admin' ? new Set([created.User?.Username ?? email]) : new Set(),
    )

    // Granting admin is the most consequential action here, so the role is in the record rather
    // than inferred from a later group listing.
    audit(auditRecord('inviteUser', actor, 'success', { target: email, detail: { role, locale } }))

    return respond(201, { user: summary })
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      audit(auditRecord('inviteUser', actor, 'denied', { target: email }))
      return fail(409, 'emailAlreadyExists')
    }
    throw err
  }
}
