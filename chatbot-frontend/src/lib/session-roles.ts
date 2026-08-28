import { fetchAuthSession } from 'aws-amplify/auth'

/**
 * Cognito group that marks an operator. Must match `ADMIN_GROUP_NAME` in
 * `infra/src/stacks/auth-stack.ts` — the group is declared there, this is the string the claim is
 * compared against here.
 */
export const ADMIN_GROUP = 'admins'

export type UserRole = 'admin' | 'user'

/**
 * Pulls `cognito:groups` out of a decoded JWT payload.
 *
 * Cognito emits this claim in the id token *and* the access token with no Lambda in the request
 * path, which is why groups beat a custom attribute here: either token answers "is this an
 * operator" without a pre-token-generation trigger on every sign-in.
 *
 * The claim is absent for users in no group, and Cognito is the only writer, but this still parses
 * defensively — it is decoding a token, not reading local state.
 */
export function readGroups(payload?: Record<string, unknown>): string[] {
  const claim = payload?.['cognito:groups']
  if (!Array.isArray(claim)) return []
  return claim.filter((group): group is string => typeof group === 'string')
}

export function isAdmin(groups: readonly string[]): boolean {
  return groups.includes(ADMIN_GROUP)
}

/**
 * Reads the caller's groups from the current session, preferring the access token because that is
 * the one a resource server (the BFF's admin routes, AgentCore) validates.
 *
 * **Display only.** A group claim read in the browser proves nothing — it decides what the UI
 * shows, never what the user is allowed to do. The BFF's admin routes re-check group membership
 * server-side on every call; nothing privileged may depend on this without that re-check.
 */
export async function fetchGroups(): Promise<string[]> {
  const session = await fetchAuthSession({ forceRefresh: false })
  const payload = session.tokens?.accessToken?.payload ?? session.tokens?.idToken?.payload
  return readGroups(payload as Record<string, unknown> | undefined)
}
