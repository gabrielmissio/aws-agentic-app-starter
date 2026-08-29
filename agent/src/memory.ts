/**
 * Where a conversation lives between turns: AgentCore Memory.
 *
 * The template used to keep history in a `Map` on the container, which meant it was lost on every
 * restart, unshared across replicas, and — the part that blocks a regulated pilot — unable to answer
 * "what did the agent actually reply". A managed memory store answers that, and makes the two
 * properties a pilot is asked to evidence into service configuration rather than code we maintain:
 * encryption uses the deployment's CMK, and retention is `eventExpiryDuration` on the resource
 * (`infra/src/stacks/agent-stack.ts`).
 *
 * Isolation comes from `actorId`. Every read names one, so a leaked session id alone reaches nothing
 * — which is a stronger boundary than a store where the session id is the only key.
 */
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  type Event,
} from '@aws-sdk/client-bedrock-agentcore'
import { Message } from '@strands-agents/sdk'

/** Set by the agent stack. Unset only in local development, where turns are not persisted. */
const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID?.trim()

/** Whether conversations survive a container restart — false only in local development. */
export const isDurable = Boolean(MEMORY_ID)

/**
 * Length of the caller namespace the BFF prefixes onto every session id, and therefore the actor
 * this conversation belongs to.
 *
 * A contract with `chatbot-bff/src/session.ts`, restated rather than imported: the two packages
 * cannot import from each other, since the agent's Docker build context is its own directory. Both
 * assert the value, so drift fails a build instead of filing a turn under the wrong actor.
 *
 * Deriving the actor from the session id rather than from the caller's `sub` is deliberate. The
 * namespace is already a hash of that `sub`, so nothing here has to re-implement the hashing, and no
 * user identifier is written into a second service.
 */
export const ACTOR_ID_LENGTH = 16

export function actorIdFor(sessionId: string): string {
  return sessionId.slice(0, ACTOR_ID_LENGTH)
}

/**
 * How many past messages are replayed into a new turn.
 *
 * Every turn re-sends the whole context it is given, so an uncapped history makes the cost of a long
 * conversation grow with the square of its length. This bounds that. It is a ceiling, not a
 * summarizer: past this point the oldest turns stop being visible to the model, while remaining in
 * the memory store and in the transcript the user can still read.
 */
const MAX_REPLAYED_MESSAGES = Number(process.env.MEMORY_MAX_MESSAGES ?? 40)

/** Only what the two parties said. See `recordTurn` for why tool traffic is not stored here. */
type StoredRole = 'USER' | 'ASSISTANT'

const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || 'us-east-1' })

/**
 * The conversation so far, as Strands messages.
 *
 * Events are sorted by their own timestamp rather than trusted to arrive in order: the API does not
 * promise one, and a history assembled in the wrong order is worse than none — the model answers a
 * question it was asked three turns ago.
 */
export async function loadHistory(sessionId: string): Promise<Message[] | undefined> {
  if (!MEMORY_ID) return undefined

  const actorId = actorIdFor(sessionId)
  const events: Event[] = []
  let nextToken: string | undefined

  do {
    const page = await client.send(
      new ListEventsCommand({
        memoryId: MEMORY_ID,
        sessionId,
        actorId,
        includePayloads: true,
        maxResults: 100,
        nextToken,
      }),
    )

    events.push(...(page.events ?? []))
    nextToken = page.nextToken
  } while (nextToken && events.length < MAX_REPLAYED_MESSAGES * 2)

  const messages = events
    .slice()
    .sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0))
    .flatMap((event) => event.payload ?? [])
    .flatMap((payload) => {
      const turn = 'conversational' in payload ? payload.conversational : undefined
      const text = turn?.content && 'text' in turn.content ? turn.content.text : undefined
      if (!text || (turn?.role !== 'USER' && turn?.role !== 'ASSISTANT')) return []

      return [Message.fromJSON({ role: turn.role === 'USER' ? 'user' : 'assistant', content: [{ text }] })]
    })
    .slice(-MAX_REPLAYED_MESSAGES)

  // An empty history and no history are the same thing to the caller, and `undefined` is what the
  // Agent expects for "start fresh".
  return messages.length > 0 ? messages : undefined
}

export interface TurnToRecord {
  role: StoredRole
  text: string
}

/**
 * Files one exchange as a single event.
 *
 * One event per turn rather than one per message, so the user's question and the answer to it can
 * never be separated by a partial write or reordered against each other.
 *
 * **Only the two sides' text is stored.** Tool calls and their results are deliberately absent: a
 * `toolUse` block replayed without the `toolResult` that answered it is a message Bedrock rejects,
 * and reconstructing valid pairs from a store is a way to break a conversation that has nothing to
 * do with what the store is for. What the agent did to produce an answer is a question for the
 * traces and metrics (`telemetry.ts`); what it said is this.
 */
export async function recordTurn(
  sessionId: string,
  turns: TurnToRecord[],
  metadata?: { correlationId?: string },
): Promise<void> {
  if (!MEMORY_ID) return

  const payload = turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({ conversational: { role: turn.role, content: { text: turn.text } } }))

  if (payload.length === 0) return

  await client.send(
    new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId: actorIdFor(sessionId),
      sessionId,
      eventTimestamp: new Date(),
      payload,
      // Carries the BFF's correlation id onto the stored turn, so an operator holding the id a user
      // quoted can find the exact exchange without searching by timestamp.
      ...(metadata?.correlationId
        ? { metadata: { correlationId: { stringValue: metadata.correlationId } } }
        : {}),
    }),
  )
}
