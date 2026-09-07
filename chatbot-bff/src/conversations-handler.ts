/**
 * Conversation routes — list, read and delete a signed-in user's own conversations.
 *
 *   GET    /conversations       → { conversations: ConversationSummary[] }
 *   GET    /conversations/{id}  → { sessionId, messages: TranscriptMessage[] }
 *   DELETE /conversations/{id}  → 204
 *
 * A third Lambda rather than three more routes on the chat one, for the reason the admin function
 * exists: this role can read and delete stored conversation *content*, and the function that relays
 * untrusted model output must not hold that. `stacks.test.ts` asserts the chat role's action set
 * exhaustively, so the separation is enforced rather than remembered.
 *
 * Every route is scoped to the caller by `belongsToCaller`: a session id names one conversation in
 * AgentCore Memory, so an id that is not the caller's is a path to someone else's transcript.
 */
import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  ListEventsCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { DeleteItemCommand, DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import { auditRecord, type Actor } from './admin.js'
import {
  conversationKeys,
  resolveConversationsRoute,
  toConversationSummary,
  toTranscript,
  type ConversationSummary,
  type MemoryEvent,
} from './conversations.js'
import { errorBody, type ErrorCode } from './errors.js'
import { CONVERSATION_CORS_METHODS, jsonHeaders } from './http.js'
import { belongsToCaller, sessionNamespace } from './session.js'

const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID ?? ''
const TABLE_NAME = process.env.CONVERSATION_TABLE_NAME ?? ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'

const memory = new BedrockAgentCoreClient({})
const dynamo = new DynamoDBClient({})

/** A sidebar, not an archive browser. Raising this is a UI decision before it is a limits one. */
const LIST_LIMIT = 100

/** Events fetched per page when reading or clearing a conversation. */
const EVENT_PAGE_SIZE = 100

function audit(record: ReturnType<typeof auditRecord>) {
  console.log(JSON.stringify(record))
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin ?? event.headers?.Origin
  const headers = jsonHeaders(ALLOWED_ORIGIN, origin, CONVERSATION_CORS_METHODS)
  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
  })
  const fail = (statusCode: number, code: ErrorCode) => respond(statusCode, errorBody(code))

  const route = resolveConversationsRoute(event.httpMethod, event.path)
  if (!route) return fail(404, 'notFound')
  if (route.kind === 'preflight') return { statusCode: 204, headers, body: '' }

  // The gateway's Cognito authorizer has already validated signature, expiry and issuer. Its absence
  // means the route is misconfigured or being reached some other way — either way there is no
  // identity to scope a read to, and no read is safe without one.
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined
  const userId = typeof claims?.sub === 'string' ? claims.sub : undefined
  if (!userId) return fail(401, 'unauthenticated')

  const actor: Actor = {
    sub: userId,
    ...(typeof claims?.email === 'string' ? { email: claims.email } : {}),
  }

  try {
    if (route.kind === 'list') return respond(200, { conversations: await listConversations(userId) })

    // `notFound`, not `forbidden`. Answering "that exists but is not yours" turns the id space into
    // an oracle for which conversations exist; the caller cannot tell the two cases apart, and for
    // a caller acting in good faith they are the same case.
    if (!belongsToCaller(route.sessionId, userId)) return fail(404, 'notFound')

    if (route.kind === 'get') {
      const events = await readEvents(userId, route.sessionId, true)
      // No events is a conversation whose retention window has passed — a normal outcome, since the
      // index row's TTL and the memory resource's expiry are two clocks that can disagree by a
      // moment. The caller is told the same thing as for an id that never existed.
      if (events.length === 0) return fail(404, 'notFound')

      return respond(200, { sessionId: route.sessionId, messages: toTranscript(events) })
    }

    await deleteConversation(userId, route.sessionId)
    // Deleting is the one irreversible thing these routes do, so it is the one that leaves a record
    // naming the human. The id is the target; no conversation content is written to the log.
    audit(auditRecord('deleteConversation', actor, 'success', { target: route.sessionId }))

    return respond(204, undefined)
  } catch (err) {
    console.error('Conversations handler error:', err)
    audit(auditRecord(route.kind, actor, 'error'))

    return fail(500, 'internal')
  }
}

/**
 * The listing reads the index, never the conversations themselves.
 *
 * That is a privilege property, not only a performance one: rendering the sidebar touches no message
 * content, so the common case never decrypts a transcript. The partition key is the caller's `sub`,
 * so there is no ownership filter here to get wrong.
 */
async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const { pk } = conversationKeys(userId, '')

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: pk } },
      Limit: LIST_LIMIT,
    }),
  )

  return (result.Items ?? [])
    .map(toConversationSummary)
    .filter((summary): summary is ConversationSummary => summary !== undefined)
    // Sorted here rather than by the table: the sort key is the session id, because that is what
    // makes a single conversation addressable. Recency is a property of at most LIST_LIMIT rows.
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Every stored event for one conversation.
 *
 * `actorId` is passed on every call — it is not derived from the session id here but from the
 * caller's own `sub`, so the store itself refuses a read for a conversation belonging to someone
 * else even if the ownership check above were somehow wrong. Two independent controls, not one.
 */
async function readEvents(
  userId: string,
  sessionId: string,
  includePayloads: boolean,
): Promise<MemoryEvent[]> {
  const events: MemoryEvent[] = []
  let nextToken: string | undefined

  do {
    const page = await memory.send(
      new ListEventsCommand({
        memoryId: MEMORY_ID,
        actorId: sessionNamespace(userId),
        sessionId,
        includePayloads,
        maxResults: EVENT_PAGE_SIZE,
        nextToken,
      }),
    )

    events.push(...(page.events ?? []))
    nextToken = page.nextToken
  } while (nextToken)

  return events
}

/**
 * Removes the conversation content first, then the index row.
 *
 * That order is deliberate. Interrupted the other way around, the content would survive with nothing
 * pointing at it — unreachable through the UI and invisible to the person who asked for it to be
 * gone, which is the failure mode a deletion request exists to prevent. This way an interruption
 * leaves a row whose content is already deleted, and the route answers `notFound` for it.
 *
 * Events are deleted one at a time because that is the only granularity the API offers. A very long
 * conversation therefore costs one call per turn; the alternative — letting retention expire it —
 * is not a deletion the user asked for.
 */
async function deleteConversation(userId: string, sessionId: string): Promise<void> {
  const actorId = sessionNamespace(userId)
  const events = await readEvents(userId, sessionId, false)

  for (const event of events as { eventId?: string }[]) {
    if (!event.eventId) continue

    await memory.send(
      new DeleteEventCommand({ memoryId: MEMORY_ID, actorId, sessionId, eventId: event.eventId }),
    )
  }

  await dynamo.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: (({ pk, sk }) => ({ pk: { S: pk }, sk: { S: sk } }))(
        conversationKeys(userId, sessionId),
      ),
    }),
  )
}
