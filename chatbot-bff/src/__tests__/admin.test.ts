import { describe, expect, it } from 'vitest'
import {
  LOCALE_ATTRIBUTE,
  auditRecord,
  isAdminClaims,
  parseGroupsClaim,
  parseInviteRequest,
  resolveAdminRoute,
  toUserSummary,
} from '../admin.js'

describe('parseGroupsClaim', () => {
  it('reads the bracketed form API Gateway produces for multiple groups', () => {
    expect(parseGroupsClaim('[admins, auditors]')).toEqual(['admins', 'auditors'])
  })

  it('reads a bare single group', () => {
    expect(parseGroupsClaim('admins')).toEqual(['admins'])
  })

  it('reads a comma-joined list without brackets', () => {
    expect(parseGroupsClaim('admins,auditors')).toEqual(['admins', 'auditors'])
  })

  it('reads a genuine array', () => {
    expect(parseGroupsClaim(['admins', 'auditors'])).toEqual(['admins', 'auditors'])
  })

  it('treats a missing or malformed claim as no groups', () => {
    expect(parseGroupsClaim(undefined)).toEqual([])
    expect(parseGroupsClaim('')).toEqual([])
    expect(parseGroupsClaim('[]')).toEqual([])
    expect(parseGroupsClaim(42)).toEqual([])
    expect(parseGroupsClaim({ admins: true })).toEqual([])
  })

  it('drops non-string entries from an array claim', () => {
    expect(parseGroupsClaim(['admins', 7, null, ''])).toEqual(['admins'])
  })
})

describe('isAdminClaims', () => {
  it('accepts a member of the admin group', () => {
    expect(isAdminClaims({ 'cognito:groups': '[admins]' })).toBe(true)
  })

  it('rejects a user in another group', () => {
    expect(isAdminClaims({ 'cognito:groups': '[auditors]' })).toBe(false)
  })

  it('rejects a user in no group', () => {
    expect(isAdminClaims({ sub: 'abc' })).toBe(false)
    expect(isAdminClaims(undefined)).toBe(false)
  })

  it('does not match a group whose name merely contains the admin group', () => {
    expect(isAdminClaims({ 'cognito:groups': '[admins-readonly]' })).toBe(false)
    expect(isAdminClaims({ 'cognito:groups': '[not-admins]' })).toBe(false)
  })
})

describe('parseInviteRequest', () => {
  it('accepts an email and defaults role and locale', () => {
    expect(parseInviteRequest({ email: 'caveman@example.com' })).toEqual({
      ok: true,
      value: { email: 'caveman@example.com', role: 'user', locale: 'en-US' },
    })
  })

  it('accepts an explicit admin role', () => {
    expect(parseInviteRequest({ email: 'boss@example.com', role: 'admin' })).toEqual({
      ok: true,
      value: { email: 'boss@example.com', role: 'admin', locale: 'en-US' },
    })
  })

  it('normalizes the email so the same person cannot be invited twice', () => {
    expect(parseInviteRequest({ email: '  CaveMan@Example.COM  ' })).toEqual({
      ok: true,
      value: { email: 'caveman@example.com', role: 'user', locale: 'en-US' },
    })
  })

  it('parses a raw JSON string body', () => {
    expect(parseInviteRequest('{"email":"caveman@example.com","role":"admin"}')).toEqual({
      ok: true,
      value: { email: 'caveman@example.com', role: 'admin', locale: 'en-US' },
    })
  })

  it('rejects an unparseable or non-object body', () => {
    expect(parseInviteRequest('not json')).toEqual({ ok: false, code: 'invalidBody' })
    expect(parseInviteRequest('null')).toEqual({ ok: false, code: 'invalidBody' })
    expect(parseInviteRequest(42)).toEqual({ ok: false, code: 'invalidBody' })
  })

  it('rejects a missing or malformed email', () => {
    expect(parseInviteRequest({})).toEqual({ ok: false, code: 'invalidEmail' })
    expect(parseInviteRequest({ email: 'caveman' })).toEqual({ ok: false, code: 'invalidEmail' })
    expect(parseInviteRequest({ email: 'cave man@example.com' })).toEqual({
      ok: false,
      code: 'invalidEmail',
    })
  })

  it('rejects a role outside the allowed set', () => {
    expect(parseInviteRequest({ email: 'caveman@example.com', role: 'superadmin' })).toEqual({
      ok: false,
      code: 'invalidRole',
    })
  })

  it('accepts a supported locale and rejects anything else', () => {
    expect(parseInviteRequest({ email: 'caveman@example.com', locale: 'pt-BR' })).toEqual({
      ok: true,
      value: { email: 'caveman@example.com', role: 'user', locale: 'pt-BR' },
    })
    expect(parseInviteRequest({ email: 'caveman@example.com', locale: 'de-DE' })).toEqual({
      ok: false,
      code: 'invalidLocale',
    })
  })
})

describe('resolveAdminRoute', () => {
  it('maps the supported methods', () => {
    expect(resolveAdminRoute('GET', '/admin/users')).toBe('listUsers')
    expect(resolveAdminRoute('POST', '/admin/users')).toBe('inviteUser')
    expect(resolveAdminRoute('OPTIONS', '/admin/users')).toBe('preflight')
  })

  it('tolerates a trailing slash and lowercase methods', () => {
    expect(resolveAdminRoute('get', '/admin/users/')).toBe('listUsers')
  })

  it('returns nothing for an unknown path or method', () => {
    expect(resolveAdminRoute('GET', '/admin')).toBeUndefined()
    expect(resolveAdminRoute('DELETE', '/admin/users')).toBeUndefined()
    expect(resolveAdminRoute('GET', '/chat')).toBeUndefined()
  })
})

describe('toUserSummary', () => {
  it('flattens the Cognito shape and resolves the role from the admin set', () => {
    const created = new Date('2026-07-30T12:00:00.000Z')

    expect(
      toUserSummary(
        {
          Username: 'e1b2c3d4',
          Attributes: [
            { Name: 'sub', Value: 'e1b2c3d4' },
            { Name: 'email', Value: 'boss@example.com' },
          ],
          UserStatus: 'CONFIRMED',
          Enabled: true,
          UserCreateDate: created,
        },
        new Set(['e1b2c3d4']),
      ),
    ).toEqual({
      username: 'e1b2c3d4',
      email: 'boss@example.com',
      status: 'CONFIRMED',
      enabled: true,
      createdAt: '2026-07-30T12:00:00.000Z',
      role: 'admin',
    })
  })

  it('defaults to a regular user and survives a sparse record', () => {
    expect(toUserSummary({ Username: 'e1b2c3d4' })).toEqual({
      username: 'e1b2c3d4',
      email: undefined,
      status: undefined,
      enabled: true,
      createdAt: undefined,
      role: 'user',
    })
  })
})

describe('auditRecord', () => {
  const at = () => new Date('2026-07-31T12:00:00.000Z')
  const actor = { sub: 'admin-sub', email: 'boss@example.com' }

  it('records who did what, to whom, and how it ended', () => {
    expect(
      auditRecord('inviteUser', actor, 'success', {
        target: 'rookie@example.com',
        detail: { role: 'admin' },
        at,
      }),
    ).toEqual({
      type: 'audit',
      action: 'inviteUser',
      actorSub: 'admin-sub',
      actorEmail: 'boss@example.com',
      target: 'rookie@example.com',
      detail: { role: 'admin' },
      outcome: 'success',
      at: '2026-07-31T12:00:00.000Z',
    })
  })

  // An action nobody can be attributed to is itself worth being able to search for.
  it('marks a missing actor rather than omitting the fields', () => {
    const record = auditRecord('listUsers', undefined, 'denied', { at })

    expect(record.actorSub).toBe('unknown')
    expect(record.actorEmail).toBe('unknown')
  })

  it('omits target and detail when there are none, so the shape stays queryable', () => {
    expect(auditRecord('listUsers', actor, 'denied', { at })).toEqual({
      type: 'audit',
      action: 'listUsers',
      actorSub: 'admin-sub',
      actorEmail: 'boss@example.com',
      outcome: 'denied',
      at: '2026-07-31T12:00:00.000Z',
    })
  })
})

describe('LOCALE_ATTRIBUTE', () => {
  it('is a custom attribute', () => {
    expect(LOCALE_ATTRIBUTE.startsWith('custom:')).toBe(true)
  })

  // CDK renders a custom attribute as a bare `{ Name, AttributeDataType }` entry with no prefix, so
  // naming one after a reserved standard attribute produces a schema entry indistinguishable from
  // declaring the standard one. Cognito then never creates `custom:<name>`, and any write to it
  // fails with "Type for attribute {custom:locale} could not be determined".
  it('is not named after a reserved Cognito standard attribute', () => {
    const reserved = [
      'address',
      'birthdate',
      'email',
      'family_name',
      'gender',
      'given_name',
      'locale',
      'middle_name',
      'name',
      'nickname',
      'phone_number',
      'picture',
      'preferred_username',
      'profile',
      'zoneinfo',
      'updated_at',
      'website',
    ]

    expect(reserved).not.toContain(LOCALE_ATTRIBUTE.replace('custom:', ''))
  })
})
