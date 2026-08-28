/**
 * Pure logic for the admin routes — claim parsing, authorization, request validation, shaping.
 *
 * Split from `admin-handler.ts` so the rules that decide *who gets in* are covered by unit tests
 * instead of only being exercised against a deployed function. Nothing here talks to Cognito or to
 * Lambda's event shape.
 */
import type { ErrorCode } from './errors.js'

/**
 * Group whose members may call these routes. Read from the environment — set to `ADMIN_GROUP_NAME`
 * from `infra/src/stacks/auth-stack.ts` by the BFF stack — with the same literal as a fallback for
 * local dev, where nothing sets it. The two must be kept in sync by hand; they cannot import from
 * each other, since `infra` and `chatbot-bff` are independent packages with separate builds.
 */
export const ADMIN_GROUP = process.env.ADMIN_GROUP_NAME ?? 'admins'

/**
 * Languages an invite email can be written in. Mirrors `SUPPORTED_LOCALES` in the frontend's i18n
 * core and the catalog in the CustomMessage trigger; the trigger falls back to the base locale, so
 * a value that slips past this list degrades to English rather than breaking the invite.
 */
export const SUPPORTED_LOCALES = ['en-US', 'pt-BR'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const BASE_LOCALE: SupportedLocale = 'en-US'

/**
 * Where the invite language is stored on the user.
 *
 * A *custom* attribute, hence the prefix: Cognito only lets standard attributes be declared when the
 * pool is created, so a pool that already has users can never gain one. Must match the
 * `customAttributes` entry in the auth stack.
 *
 * Not named `locale`: that collides with a reserved standard attribute, and the resulting schema
 * entry is indistinguishable from declaring the standard one — so `custom:locale` is never created
 * and every invite fails. See the note in `auth-stack.ts`.
 */
export const LOCALE_ATTRIBUTE = 'custom:inviteLocale'

export type UserRole = 'admin' | 'user'

export interface InviteRequest {
  email: string
  role: UserRole
  /** Written to the user's locale attribute, which is what the email trigger reads. */
  locale: SupportedLocale
}

export interface UserSummary {
  username: string
  email?: string
  /** Cognito account status, e.g. `FORCE_CHANGE_PASSWORD` until the invite is completed. */
  status?: string
  enabled: boolean
  createdAt?: string
  role: UserRole
}

/**
 * Normalizes the `cognito:groups` claim.
 *
 * API Gateway's Cognito authorizer flattens array claims into a string before handing them to the
 * integration, and the shape is not stable across API/token types — it can arrive as `"[a, b]"`,
 * as `"a,b"`, or as a genuine array. Getting this wrong fails open or fails closed depending on the
 * format, so every shape is handled explicitly.
 */
export function parseGroupsClaim(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((group): group is string => typeof group === 'string' && group.length > 0)
  }

  if (typeof raw !== 'string') return []

  return raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group.length > 0)
}

/**
 * Whether the verified claims carry admin group membership.
 *
 * The claims must come from API Gateway's authorizer context, which is populated only after the
 * token's signature, expiry and issuer have been validated. Never call this with a payload decoded
 * from a raw `Authorization` header — that is attacker-controlled.
 */
export function isAdminClaims(
  claims: Record<string, unknown> | undefined,
  adminGroup: string = ADMIN_GROUP,
): boolean {
  return parseGroupsClaim(claims?.['cognito:groups']).includes(adminGroup)
}

// Deliberately permissive: Cognito is the real validator. This exists to reject obvious typos with
// a useful message instead of surfacing an SDK exception.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode }

export function parseInviteRequest(raw: unknown): ParseResult<InviteRequest> {
  let body: unknown = raw

  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw)
    } catch {
      return { ok: false, code: 'invalidBody' }
    }
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, code: 'invalidBody' }
  }

  const { email, role, locale } = body as { email?: unknown; role?: unknown; locale?: unknown }

  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    return { ok: false, code: 'invalidEmail' }
  }

  if (role !== undefined && role !== 'admin' && role !== 'user') {
    return { ok: false, code: 'invalidRole' }
  }

  if (locale !== undefined && !SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
    return { ok: false, code: 'invalidLocale' }
  }

  return {
    ok: true,
    value: {
      email: email.trim().toLowerCase(),
      role: (role as UserRole) ?? 'user',
      locale: (locale as SupportedLocale) ?? BASE_LOCALE,
    },
  }
}

export type AdminRoute = 'listUsers' | 'inviteUser' | 'preflight'

/**
 * Maps a request onto an admin route. Returns `undefined` for anything unrecognized so the handler
 * answers 404 rather than guessing.
 */
export function resolveAdminRoute(method: string, path: string): AdminRoute | undefined {
  const normalizedPath = path.replace(/\/+$/, '') || '/'
  const normalizedMethod = method.toUpperCase()

  if (normalizedMethod === 'OPTIONS') return 'preflight'
  if (normalizedPath !== '/admin/users') return undefined

  if (normalizedMethod === 'GET') return 'listUsers'
  if (normalizedMethod === 'POST') return 'inviteUser'

  return undefined
}

interface CognitoAttribute {
  Name?: string
  Value?: string
}

interface CognitoUser {
  Username?: string
  Attributes?: CognitoAttribute[]
  UserStatus?: string
  Enabled?: boolean
  UserCreateDate?: Date | string
}

/** Flattens a Cognito user into the shape the admin panel renders. */
export function toUserSummary(
  user: CognitoUser,
  adminUsernames: ReadonlySet<string> = new Set(),
): UserSummary {
  const username = user.Username ?? ''
  const email = user.Attributes?.find((attribute) => attribute.Name === 'email')?.Value
  const createdAt =
    user.UserCreateDate instanceof Date
      ? user.UserCreateDate.toISOString()
      : typeof user.UserCreateDate === 'string'
        ? user.UserCreateDate
        : undefined

  return {
    username,
    email,
    status: user.UserStatus,
    enabled: user.Enabled ?? true,
    createdAt,
    role: adminUsernames.has(username) ? 'admin' : 'user',
  }
}

/** Who performed a privileged action, taken from gateway-verified claims. */
export interface Actor {
  sub?: string
  email?: string
}

export interface AuditRecord {
  type: 'audit'
  action: string
  actorSub: string
  actorEmail: string
  target?: string
  detail?: Record<string, unknown>
  outcome: 'success' | 'denied' | 'error'
  at: string
}

/**
 * Shapes one audit line.
 *
 * Emitted as JSON so CloudWatch Logs Insights can answer "who granted this person access, and
 * when." CloudTrail records the underlying Cognito API calls but attributes them to the Lambda's
 * execution role, not the admin who triggered them — this is the record that names the human.
 *
 * Deliberately carries no request body beyond the target email: the actor, the action and the
 * target are the audit facts, and anything more risks writing user content into logs.
 */
export function auditRecord(
  action: string,
  actor: Actor | undefined,
  outcome: AuditRecord['outcome'],
  extra: { target?: string; detail?: Record<string, unknown>; at?: () => Date } = {},
): AuditRecord {
  return {
    type: 'audit',
    action,
    // Recorded as `unknown` rather than omitted: an action with no identifiable actor is itself
    // something worth being able to search for.
    actorSub: actor?.sub ?? 'unknown',
    actorEmail: actor?.email ?? 'unknown',
    ...(extra.target ? { target: extra.target } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    outcome,
    at: (extra.at?.() ?? new Date()).toISOString(),
  }
}
