import { createHash, randomUUID } from 'node:crypto'

/** AgentCore rejects runtime session ids shorter than this. */
export const MIN_SESSION_ID_LENGTH = 33

/** Length, in hex characters, of the caller namespace prefixed onto every session id. */
export const SESSION_NAMESPACE_LENGTH = 16

/**
 * Joins the namespace to the random half, at exactly `SESSION_NAMESPACE_LENGTH`.
 *
 * The position matters as much as the character: `actorIdFor` in `agent/src/memory.ts` derives the
 * memory actor by slicing those first characters back off, so a separator anywhere else files the
 * turn under a different actor without failing. A hyphen rather than a colon keeps the whole id
 * inside `[a-z0-9_-]`, the class `__tests__/session.test.ts` pins — an id AgentCore rejects surfaces
 * from inside a memory write, after the model has already been billed for the turn.
 */
export const SESSION_SEPARATOR = '-'

/**
 * Derives a short, stable namespace from the caller's Cognito `sub`. A session id is a bearer token
 * for AgentCore conversation history, so prefixing every id with a hash of the caller's identity
 * stops a client constructing or replaying one that resolves to someone else's session.
 *
 * It is also what partitions conversation storage: the namespace is the AgentCore Memory `actorId`
 * every read is scoped by, and the partition key of this caller's rows in the conversation index — and
 * it is unguessable without the `sub` it hashes.
 */
export function sessionNamespace(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, SESSION_NAMESPACE_LENGTH)
}

/**
 * Whether this session id was minted for this caller. The single ownership check behind every route
 * that reads or deletes a conversation — a session id names one conversation in AgentCore Memory, so
 * an unchecked one is a path to another user's transcript.
 *
 * Length is part of the check, not a separate concern: a bare namespace with nothing after it is a
 * prefix that matches *all* of that caller's session ids rather than one of them.
 */
export function belongsToCaller(candidate: unknown, userId: string): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate.startsWith(`${sessionNamespace(userId)}${SESSION_SEPARATOR}`) &&
    candidate.length >= MIN_SESSION_ID_LENGTH
  )
}

/**
 * A client-supplied id is honored only if it belongs to the caller; anything else mints a fresh one
 * silently, since "forged" and "just expired" look the same to the client. `generate` is injectable
 * so a test need not depend on `randomUUID()`.
 */
export function resolveSessionId(
  candidate: unknown,
  userId: string,
  generate: () => string = randomUUID,
): string {
  if (belongsToCaller(candidate, userId)) return candidate

  return `${sessionNamespace(userId)}${SESSION_SEPARATOR}${generate()}`
}
