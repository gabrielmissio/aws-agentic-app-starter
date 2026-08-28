/**
 * Client for the BFF admin routes.
 *
 * Sends the **id token**, matching what `/chat` does and what the gateway's Cognito authorizer
 * expects — it is also the token carrying `cognito:groups`, which the admin function re-checks.
 * Nothing here is an authorization decision: a non-admin who calls these functions directly gets a
 * 403 from the server, which is the point.
 */
import { fetchAuthSession } from 'aws-amplify/auth'
import { readAppConfig } from './app-config'
import type { Locale } from './i18n/core'
import type { UserRole } from './session-roles'

const BFF_URL = readAppConfig('VITE_API_URL') ?? '/api'

export interface AdminUser {
  username: string
  email?: string
  status?: string
  enabled: boolean
  createdAt?: string
  role: UserRole
}

/**
 * Carries the server's stable error `code` alongside its English message.
 *
 * The code is what the UI localizes (see `translateErrorCode`); the message is the fallback for a
 * failure that never reached our handler — a 403 straight from the authorizer, a 502 — and
 * therefore has no code.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const session = await fetchAuthSession({ forceRefresh: false })
  // The ID token — same authorizer constraint as the chat and checkout clients.
  const idToken = session.tokens?.idToken?.toString()

  if (!idToken) {
    throw new ApiError('No valid ID token. Please sign in.', 'noSession')
  }

  const response = await fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: idToken, ...init?.headers },
  })

  // Our handler always answers JSON with `code` + `error`, but a gateway-level failure may not be
  // JSON at all — fall back to the status so the UI never renders "undefined".
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string
    error?: string
  } & T

  if (!response.ok) {
    throw new ApiError(
      payload.error ?? `Request failed (${response.status})`,
      payload.code,
      response.status,
    )
  }

  return payload
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
