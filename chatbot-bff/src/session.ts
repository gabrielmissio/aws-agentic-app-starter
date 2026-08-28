import { createHash, randomUUID } from 'node:crypto'

/** AgentCore rejects runtime session ids shorter than this. */
export const MIN_SESSION_ID_LENGTH = 33

/** Length, in hex characters, of the caller namespace prefixed onto every session id. */
export const SESSION_NAMESPACE_LENGTH = 16

/**
 * Derives a short, stable namespace from the caller's Cognito `sub`. A session id is a bearer token
 * for AgentCore conversation history, so prefixing every id with a hash of the caller's identity
 * stops a client constructing or replaying one that resolves to someone else's session.
 */
export function sessionNamespace(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, SESSION_NAMESPACE_LENGTH)
}

/**
 * Resolves the session id for a request. A client-supplied id is honored only if it carries the
 * caller's namespace and clears AgentCore's minimum length; anything else mints a fresh one
 * silently, since "forged" and "just expired" are indistinguishable to the client either way.
 *
 * `generate` is injectable so a test can assert a fresh id without depending on `randomUUID()`.
 */
export function resolveSessionId(
  candidate: unknown,
  userId: string,
  generate: () => string = randomUUID,
): string {
  const prefix = `${sessionNamespace(userId)}:`

  if (
    typeof candidate === 'string' &&
    candidate.startsWith(prefix) &&
    candidate.length >= MIN_SESSION_ID_LENGTH
  ) {
    return candidate
  }

  return `${prefix}${generate()}`
}
