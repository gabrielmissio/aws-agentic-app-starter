/**
 * The identity block the chat handler prepends to a prompt before it reaches the agent.
 *
 * The only way the agent learns who is asking, built from claims the API Gateway authorizer already
 * verified — so its payment tools act for that user without any tool accepting a user id.
 *
 * The format is a contract with `agent/src/tools/ap2/caller.ts`. The two cannot import from each
 * other (the agent's Docker build context is its own directory), so both sides assert the exact wire
 * format in their tests and drift fails the build rather than silently detaching agent from caller.
 */
export interface SessionContext {
  userId: string
  email?: string
  displayName?: string
  /**
   * A short-lived, BFF-signed assertion of `userId`, forwarded by the agent on every entity call.
   * The plain `userId` above is what the agent reasons about; this is what the entities believe.
   * `agent/src/index.ts` strips the whole block before the prompt reaches the model.
   */
  identityToken?: string
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
    ...(context.identityToken ? [`identityToken: ${context.identityToken}`] : []),
    '',
    MESSAGE_HEADER,
    '',
    message,
  ].join('\n')
}
