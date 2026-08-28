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
