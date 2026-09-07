import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { APIGatewayProxyEvent } from 'aws-lambda'

/**
 * The admin routes' privilege boundary.
 *
 * `admin.ts` covers the rules — `isAdminClaims`, `parseInviteRequest`, `toUserSummary`. This covers
 * the handler that has to consult them while holding `cognito-idp:AdminCreateUser`: the one role in
 * this template that can mint an account and hand it the admin group. Every denial case asserts
 * that Cognito was never called, because a 403 returned after the user was created is not a denial.
 */
const { cognitoSend, USER_POOL_ID, ADMIN_GROUP_NAME } = vi.hoisted(() => {
  process.env.COGNITO_USER_POOL_ID = 'pool-under-test'
  process.env.ADMIN_GROUP_NAME = 'admins'
  process.env.ALLOWED_ORIGIN = '*'

  return {
    cognitoSend: vi.fn(),
    USER_POOL_ID: 'pool-under-test',
    ADMIN_GROUP_NAME: 'admins',
  }
})

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    send = cognitoSend
  },
  ListUsersCommand: class {
    readonly kind = 'ListUsers'
    constructor(readonly input: Record<string, unknown>) {}
  },
  ListUsersInGroupCommand: class {
    readonly kind = 'ListUsersInGroup'
    constructor(readonly input: Record<string, unknown>) {}
  },
  AdminCreateUserCommand: class {
    readonly kind = 'AdminCreateUser'
    constructor(readonly input: Record<string, unknown>) {}
  },
  AdminAddUserToGroupCommand: class {
    readonly kind = 'AdminAddUserToGroup'
    constructor(readonly input: Record<string, unknown>) {}
  },
  // Real classes: the handler branches on `instanceof`, so a plain object would take the wrong path.
  // They take the SDK's own `{ message, $metadata }` option shape, since that is what the call
  // sites below are typechecked against — `vi.mock` replaces the implementation, never the types.
  InvalidParameterException: class extends Error {
    constructor(options: { message?: string }) {
      super(options.message)
    }
  },
  UsernameExistsException: class extends Error {
    constructor(options: { message?: string }) {
      super(options.message)
    }
  },
}))

const cognito = await import('@aws-sdk/client-cognito-identity-provider')
const { handler } = await import('../admin-handler.js')
const { LOCALE_ATTRIBUTE } = await import('../admin.js')

type Sent = { kind: string; input: Record<string, unknown> }

const sent = (): Sent[] => cognitoSend.mock.calls.map(([command]) => command as Sent)
const sentOfKind = (kind: string) => sent().filter((command) => command.kind === kind)

function request(overrides: {
  method?: string
  path?: string
  groups?: string[]
  /** `null` stands for an authorizer that attached no claims. */
  sub?: string | null
  body?: unknown
}): APIGatewayProxyEvent {
  const { method = 'GET', path = '/admin/users', groups, sub = 'admin-sub', body } = overrides

  return {
    httpMethod: method,
    path,
    headers: { origin: 'https://app.example.com' },
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: {
      authorizer:
        sub === null
          ? {}
          : { claims: { sub, email: `${sub}@example.com`, ...(groups ? { 'cognito:groups': groups } : {}) } },
    },
  } as unknown as APIGatewayProxyEvent
}

const asAdmin = (overrides: Parameters<typeof request>[0] = {}) =>
  request({ groups: [ADMIN_GROUP_NAME], ...overrides })

const body = (result: { body: string }) => JSON.parse(result.body)

beforeEach(() => {
  cognitoSend.mockReset()
  cognitoSend.mockResolvedValue({ Users: [] })
})

describe('the privilege boundary', () => {
  it('refuses a signed-in user who is in no group, and calls Cognito for nothing', async () => {
    const result = await handler(request({ groups: undefined }))

    expect(result.statusCode).toBe(403)
    expect(body(result).code).toBe('forbidden')
    expect(cognitoSend).not.toHaveBeenCalled()
  })

  it('refuses a signed-in user who is in some other group', async () => {
    const result = await handler(request({ groups: ['auditors'] }))

    expect(result.statusCode).toBe(403)
    expect(cognitoSend).not.toHaveBeenCalled()
  })

  it('refuses a request the authorizer attached no claims to', async () => {
    const result = await handler(request({ sub: null }))

    expect(result.statusCode).toBe(403)
    expect(cognitoSend).not.toHaveBeenCalled()
  })

  it('refuses an invite from a non-admin before anything is created', async () => {
    // The consequential direction: POST is what mints an account, so the check has to come first.
    const result = await handler(
      request({ method: 'POST', groups: ['users'], body: { email: 'new@example.com', role: 'admin' } }),
    )

    expect(result.statusCode).toBe(403)
    expect(cognitoSend).not.toHaveBeenCalled()
  })
})

describe('listing users', () => {
  it('marks the members of the admin group, scoped to this pool', async () => {
    cognitoSend.mockImplementation(async (command: Sent) =>
      command.kind === 'ListUsersInGroup'
        ? { Users: [{ Username: 'boss' }] }
        : { Users: [{ Username: 'boss' }, { Username: 'nobody' }] },
    )

    const result = await handler(asAdmin())

    expect(result.statusCode).toBe(200)
    for (const command of sent()) {
      expect(command.input).toMatchObject({ UserPoolId: USER_POOL_ID })
    }
    expect(sentOfKind('ListUsersInGroup')[0]?.input).toMatchObject({ GroupName: ADMIN_GROUP_NAME })

    // The group listing is what decides the role — not anything the caller sent.
    expect(body(result).users).toEqual([
      expect.objectContaining({ username: 'boss', role: 'admin' }),
      expect.objectContaining({ username: 'nobody', role: 'user' }),
    ])
  })
})

describe('inviting a user', () => {
  const invite = { email: 'new@example.com', role: 'user', locale: 'pt-BR' }

  beforeEach(() => {
    cognitoSend.mockResolvedValue({ User: { Username: 'new@example.com' } })
  })

  it('creates the account with the invite language attached, and grants no group', async () => {
    const result = await handler(asAdmin({ method: 'POST', body: invite }))

    expect(result.statusCode).toBe(201)
    expect(sentOfKind('AdminCreateUser')[0]?.input).toMatchObject({
      UserPoolId: USER_POOL_ID,
      Username: invite.email,
      UserAttributes: expect.arrayContaining([{ Name: LOCALE_ATTRIBUTE, Value: 'pt-BR' }]),
    })
    // A plain invite must not touch group membership — that is the privileged half of this route.
    expect(sentOfKind('AdminAddUserToGroup')).toHaveLength(0)
  })

  it('adds the admin group only when the invite asks for it', async () => {
    const result = await handler(asAdmin({ method: 'POST', body: { ...invite, role: 'admin' } }))

    expect(result.statusCode).toBe(201)
    expect(sentOfKind('AdminAddUserToGroup')[0]?.input).toMatchObject({
      UserPoolId: USER_POOL_ID,
      Username: invite.email,
      GroupName: ADMIN_GROUP_NAME,
    })
  })

  it('still invites when the pool has no locale attribute, dropping only the language', async () => {
    // The email's language is a nicety; inviting someone is not.
    cognitoSend
      .mockRejectedValueOnce(
        new cognito.InvalidParameterException({
          message: `Attribute ${LOCALE_ATTRIBUTE} does not exist`,
          $metadata: {},
        }),
      )
      .mockResolvedValue({ User: { Username: invite.email } })

    const result = await handler(asAdmin({ method: 'POST', body: invite }))

    expect(result.statusCode).toBe(201)
    const attempts = sentOfKind('AdminCreateUser')
    expect(attempts).toHaveLength(2)
    expect(JSON.stringify(attempts[1]?.input)).not.toContain(LOCALE_ATTRIBUTE)
  })

  it('propagates a failure that is not about the locale attribute', async () => {
    cognitoSend.mockRejectedValue(
      new cognito.InvalidParameterException({ message: 'Invalid email domain', $metadata: {} }),
    )

    const result = await handler(asAdmin({ method: 'POST', body: invite }))

    expect(result.statusCode).toBe(500)
    expect(body(result).code).toBe('internal')
    expect(sentOfKind('AdminCreateUser')).toHaveLength(1)
  })

  it('reports an address that already has an account as a conflict, not a server error', async () => {
    cognitoSend.mockRejectedValue(
      new cognito.UsernameExistsException({ message: 'already exists', $metadata: {} }),
    )

    const result = await handler(asAdmin({ method: 'POST', body: invite }))

    expect(result.statusCode).toBe(409)
    expect(body(result).code).toBe('emailAlreadyExists')
  })

  it('rejects a malformed invite before reaching Cognito', async () => {
    const result = await handler(asAdmin({ method: 'POST', body: { email: 'not-an-address' } }))

    expect(result.statusCode).toBe(400)
    expect(body(result).code).toBe('invalidEmail')
    expect(cognitoSend).not.toHaveBeenCalled()
  })
})

describe('routing', () => {
  it('answers a preflight without requiring a caller', async () => {
    const result = await handler(request({ method: 'OPTIONS', sub: null }))

    expect(result.statusCode).toBe(204)
    expect(cognitoSend).not.toHaveBeenCalled()
  })

  it('answers 404 for a path these routes do not serve', async () => {
    const result = await handler(asAdmin({ path: '/admin/settings' }))

    expect(result.statusCode).toBe(404)
    expect(cognitoSend).not.toHaveBeenCalled()
  })
})
