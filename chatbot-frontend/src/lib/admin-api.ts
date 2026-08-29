/**
 * Client for the BFF admin routes.
 *
 * Sends the **id token**, matching what `/chat` does and what the gateway's Cognito authorizer
 * expects — it is also the token carrying `cognito:groups`, which the admin function re-checks.
 * Nothing here is an authorization decision: a non-admin who calls these functions directly gets a
 * 403 from the server, which is the point.
 */
import { requestJson } from './bff-client'
import type { Locale } from './i18n/core'
import type { UserRole } from './session-roles'

export { ApiError } from './bff-client'

export interface AdminUser {
  username: string
  email?: string
  status?: string
  enabled: boolean
  createdAt?: string
  role: UserRole
}

export async function listUsers(): Promise<AdminUser[]> {
  const { users } = await requestJson<{ users?: AdminUser[] }>('/admin/users')
  return users ?? []
}

/** `locale` decides the language of the invite email, not of this request. */
export async function inviteUser(
  email: string,
  role: UserRole,
  locale: Locale,
): Promise<AdminUser | undefined> {
  const { user } = await requestJson<{ user?: AdminUser }>('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, role, locale }),
  })
  return user
}
