/**
 * Pure logic for the conversation routes — routing, key construction, and projecting a stored
 * snapshot into a transcript. Split from `conversations-handler.ts` so the ownership rule and the
 * key layout are unit-testable; nothing here talks to S3, DynamoDB or Lambda's event shape.
 */
import type { UpdateItemCommandInput } from '@aws-sdk/client-dynamodb'
import { stripSessionContext } from './session-context.js'

// ── Routing ─────────────────────────────────────────────────────────────

export type ConversationsRoute =
  | { kind: 'preflight' }
  | { kind: 'list' }
  | { kind: 'get'; sessionId: string }
  | { kind: 'delete'; sessionId: string }

/**
 * Maps method and path onto a route. Parsed from the path rather than read from
 * `pathParameters` so the rule is testable without constructing a gateway event, and so a
 * misconfigured path mapping surfaces as a 404 rather than as `undefined` flowing into a key.
 */
export function resolveConversationsRoute(
  method: string | undefined,
  path: string | undefined,
): ConversationsRoute | undefined {
  if (method === 'OPTIONS') return { kind: 'preflight' }

  const segments = (path ?? '').split('/').filter(Boolean)
  if (segments[0] !== 'conversations') return undefined

  if (segments.length === 1) {
    return method === 'GET' ? { kind: 'list' } : undefined
  }

  if (segments.length !== 2) return undefined

  const sessionId = decodeURIComponent(segments[1] as string)
  if (method === 'GET') return { kind: 'get', sessionId }
  if (method === 'DELETE') return { kind: 'delete', sessionId }

  return undefined
}

// ── The conversation index ──────────────────────────────────────────────

/**
 * Keys for the index item.
 *
 * The partition key is the caller's `sub` straight from verified claims, which is what makes the
 * listing query incapable of returning someone else's conversation: there is no filter to get wrong,
 * because the wrong rows are in a different partition.
 */
export function conversationKeys(userId: string, sessionId: string): { pk: string; sk: string } {
  return { pk: `USER#${userId}`, sk: `CONV#${sessionId}` }
}

/** Longest stored conversation title. Long enough to disambiguate, short enough for a sidebar. */
export const MAX_TITLE_LENGTH = 80

/**
 * A conversation's title, derived from the first thing the user said in it.
 *
 * Derived rather than model-generated: a title costs an extra inference per conversation otherwise,
 * and this is the one string in the product where being cheap and predictable beats being clever.
 */
export function deriveTitle(message: string, maxLength: number = MAX_TITLE_LENGTH): string {
  const flattened = stripSessionContext(message).replace(/\s+/g, ' ').trim()

  if (!flattened) return 'New conversation'
  if (flattened.length <= maxLength) return flattened

  return `${flattened.slice(0, maxLength - 1).trimEnd()}…`
}

/** Default window a conversation is kept for. Overridden by `CONVERSATION_RETENTION_DAYS`. */
export const DEFAULT_RETENTION_DAYS = 30

/**
 * The single write that keeps the sidebar current, shaped here so its expressions are testable
 * without a table.
 *
 * One `UpdateItem` per turn, and deliberately the same *action* the rate-limit table already needs —
 * so the chat function gains a resource, not a capability. `if_not_exists` on the title and creation
 * time makes the first turn name the conversation and every later turn only bump its recency, which
 * is why no read is needed to decide whether this conversation is new.
 *
 * `expiresAt` is a TTL matched to the bucket's lifecycle rule. Both have to be set from the same
 * retention number or the index outlives the content it points at, and the sidebar fills with
 * conversations that open empty.
 */
export function conversationIndexUpdate(input: {
  tableName: string
  userId: string
  sessionId: string
  title: string
  retentionDays?: number
  now?: number
}): UpdateItemCommandInput {
  const { pk, sk } = conversationKeys(input.userId, input.sessionId)
  const now = new Date(input.now ?? Date.now())
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS
  const expiresAt = Math.floor(now.getTime() / 1000) + retentionDays * 24 * 60 * 60

  return {
    TableName: input.tableName,
    Key: { pk: { S: pk }, sk: { S: sk } },
    UpdateExpression: [
      'SET sessionId = :sessionId',
      'title = if_not_exists(title, :title)',
      'createdAt = if_not_exists(createdAt, :now)',
      'updatedAt = :now',
      'expiresAt = :expiresAt',
    ].join(', '),
    ExpressionAttributeValues: {
      ':sessionId': { S: input.sessionId },
      ':title': { S: input.title },
      ':now': { S: now.toISOString() },
      ':expiresAt': { N: String(expiresAt) },
    },
  }
}

/** Falls back on a bad value rather than throwing: this runs at cold start, in the chat path. */
export function resolveRetentionDays(raw: string | undefined): number {
  const days = Number(raw)
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_RETENTION_DAYS
}

export interface ConversationSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
}

/** One index row, rejecting anything that does not carry the fields the UI needs. */
export function toConversationSummary(item: Record<string, unknown>): ConversationSummary | undefined {
  const read = (name: string): string | undefined => {
    const attribute = item[name]
    if (attribute && typeof attribute === 'object' && 'S' in attribute) {
      const value = (attribute as { S?: unknown }).S
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  }

  const sessionId = read('sessionId')
  const updatedAt = read('updatedAt')
  if (!sessionId || !updatedAt) return undefined

  return {
    sessionId,
    title: read('title') ?? 'New conversation',
    createdAt: read('createdAt') ?? updatedAt,
    updatedAt,
  }
}

// ── Transcript projection ───────────────────────────────────────────────

export interface TranscriptMessage {
  role: 'user' | 'agent'
  content: string
}

/**
 * One AgentCore Memory event, in the shape this projection reads. Declared structurally rather than
 * imported from the SDK so the function stays testable against plain objects.
 */
export interface MemoryEvent {
  eventTimestamp?: Date
  payload?: unknown[]
}

/**
 * Projects stored events into the transcript the UI renders.
 *
 * Ordered by the events' own timestamps rather than by arrival: the API promises no order, and a
 * transcript assembled out of order reads as a different conversation than the one that happened.
 *
 * Only `USER` and `ASSISTANT` text appears. Tool traffic is not in the store at all — see
 * `agent/src/memory.ts` for why — so what a turn *did* is a question for its trace, and what it
 * *said* is this. The identity block is stripped defensively: the agent records the prompt already
 * unwrapped, and this keeps a record written by anything else from showing transport as content.
 */
export function toTranscript(events: MemoryEvent[] | undefined): TranscriptMessage[] {
  if (!Array.isArray(events)) return []

  return events
    .slice()
    .sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0))
    .flatMap((event) => (Array.isArray(event.payload) ? event.payload : []))
    .flatMap((entry) => {
      const turn = (entry as { conversational?: { role?: unknown; content?: unknown } })?.conversational
      if (turn?.role !== 'USER' && turn?.role !== 'ASSISTANT') return []

      const raw = (turn.content as { text?: unknown } | undefined)?.text
      if (typeof raw !== 'string') return []

      const role = turn.role === 'USER' ? 'user' : 'agent'
      const content = role === 'user' ? stripSessionContext(raw) : raw
      if (!content.trim()) return []

      return [{ role, content } as TranscriptMessage]
    })
}
