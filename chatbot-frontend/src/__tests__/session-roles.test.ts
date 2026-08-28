import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_GROUP, fetchGroups, isAdmin, readGroups } from '../lib/session-roles'

const fetchAuthSession = vi.fn()

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: (...args: unknown[]) => fetchAuthSession(...args),
}))

const token = (groups?: unknown) => ({
  payload: groups === undefined ? {} : { 'cognito:groups': groups },
})

describe('readGroups', () => {
  it('reads the cognito:groups claim', () => {
    expect(readGroups({ 'cognito:groups': [ADMIN_GROUP, 'auditors'] })).toEqual([
      ADMIN_GROUP,
      'auditors',
    ])
  })

  it('returns nothing when the user belongs to no group', () => {
    // Cognito omits the claim entirely rather than emitting an empty array.
    expect(readGroups({ sub: 'abc' })).toEqual([])
    expect(readGroups(undefined)).toEqual([])
  })

  it('ignores a claim that is not an array of strings', () => {
    expect(readGroups({ 'cognito:groups': 'admins' })).toEqual([])
    expect(readGroups({ 'cognito:groups': [ADMIN_GROUP, 42, null] })).toEqual([ADMIN_GROUP])
  })
})

describe('isAdmin', () => {
  it('is true only for members of the admin group', () => {
    expect(isAdmin([ADMIN_GROUP])).toBe(true)
    expect(isAdmin(['auditors'])).toBe(false)
    expect(isAdmin([])).toBe(false)
  })
})

describe('fetchGroups', () => {
  beforeEach(() => {
    fetchAuthSession.mockReset()
  })

  it('prefers the access token — that is what a resource server validates', async () => {
    fetchAuthSession.mockResolvedValue({
      tokens: { accessToken: token([ADMIN_GROUP]), idToken: token(['auditors']) },
    })

    await expect(fetchGroups()).resolves.toEqual([ADMIN_GROUP])
  })

  it('falls back to the id token when there is no access token', async () => {
    fetchAuthSession.mockResolvedValue({ tokens: { idToken: token([ADMIN_GROUP]) } })

    await expect(fetchGroups()).resolves.toEqual([ADMIN_GROUP])
  })

  it('returns nothing when the session carries no tokens', async () => {
    fetchAuthSession.mockResolvedValue({})

    await expect(fetchGroups()).resolves.toEqual([])
  })
})
