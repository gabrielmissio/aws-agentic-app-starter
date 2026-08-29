/**
 * The identity block prepended to a prompt: the only way the agent learns who is asking, built from
 * claims the gateway authorizer already verified.
 *
 * The format is a contract with `agent/src/caller.ts`. The two cannot import from each other — the
 * agent's Docker build context is its own directory — so both assert the literal wire format in
 * their tests, and drift fails the build rather than silently detaching agent from caller.
 */
export interface SessionContext {
  userId: string
  email?: string
  displayName?: string
}

export const CONTEXT_HEADER = '[Session context — verified]'
export const MESSAGE_HEADER = '[User message]'

/**
 * Wraps `message` with the verified identity. The user's text always lands after `[User message]`
 * and the parser treats everything past that marker as text, so typing the header into a message
 * cannot introduce a second identity ahead of the real one.
 */
export function withSessionContext(context: SessionContext, message: string): string {
  return [
    CONTEXT_HEADER,
    `userId: ${context.userId}`,
    ...(context.email ? [`email: ${context.email}`] : []),
    ...(context.displayName ? [`displayName: ${context.displayName}`] : []),
    '',
    MESSAGE_HEADER,
    '',
    message,
  ].join('\n')
}

/**
 * Removes the identity block, recovering the text the user actually typed.
 *
 * The wrapped form is what gets persisted to the session snapshot, so every path that replays a
 * stored conversation — the transcript route, a conversation title — has to undo it. Kept beside
 * `withSessionContext` so the pair cannot drift: a change to the wire format breaks both at once,
 * which is the only way it stays safe to change.
 *
 * A message that carries no block is returned untouched, which covers a turn recorded before this
 * existed and a runtime invoked directly.
 */
export function stripSessionContext(text: string): string {
  if (!text.startsWith(CONTEXT_HEADER)) return text

  const messageAt = text.indexOf(MESSAGE_HEADER)
  if (messageAt === -1) return text

  return text.slice(messageAt + MESSAGE_HEADER.length).replace(/^\n+/, '')
}
