import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { APIGatewayProxyEvent } from 'aws-lambda'

/**
 * The conversation routes' authorization surface.
 *
 * `conversations.ts` covers the routing and key construction; `session.ts` covers `belongsToCaller`
 * itself. What was untested until this file is the part that matters most: that the handler *calls*
 * them, in the right order, and reaches no store when they say no. A rule that holds in isolation
 * and is never consulted protects nothing.
 *
 * Every case therefore asserts an outcome *and* what the handler did or did not send — a 404 that
 * arrives after the transcript was already read is a different bug wearing the right status code.
 */
const { memorySend, dynamoSend, MEMORY_ID, TABLE_NAME } = vi.hoisted(() => {
  // Read at module scope by the handler, so they have to exist before it is imported.
  process.env.AGENTCORE_MEMORY_ID = 'memory-under-test'
  process.env.CONVERSATION_TABLE_NAME = 'conversations-under-test'
  process.env.ALLOWED_ORIGIN = '*'

  return {
    memorySend: vi.fn(),
    dynamoSend: vi.fn(),
    MEMORY_ID: 'memory-under-test',
    TABLE_NAME: 'conversations-under-test',
  }
})

/**
 * The commands are replaced by carriers: each records the input it was built with and a `kind` the
 * fake `send` branches on. Asserting on those inputs is the point — it is how a test can tell
 * "listed the caller's own partition" from "listed the table".
 */
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {
    send = memorySend
  },
  ListEventsCommand: class {
    readonly kind = 'ListEvents'
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteEventCommand: class {
    readonly kind = 'DeleteEvent'
    constructor(readonly input: Record<string, unknown>) {}
  },
}))

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = dynamoSend
  },
  QueryCommand: class {
    readonly kind = 'Query'
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteItemCommand: class {
    readonly kind = 'DeleteItem'
    constructor(readonly input: Record<string, unknown>) {}
  },
}))

const { handler } = await import('../conversations-handler.js')
const { resolveSessionId, sessionNamespace } = await import('../session.js')

const ALICE = 'alice-sub'
const BOB = 'bob-sub'

/** Real ids from the real minting logic — a hand-written string would not survive a format change. */
const ALICE_SESSION = resolveSessionId(undefined, ALICE)
const BOB_SESSION = resolveSessionId(undefined, BOB)

type Sent = { kind: string; input: Record<string, unknown> }

const sentTo = (spy: typeof memorySend): Sent[] => spy.mock.calls.map(([command]) => command as Sent)

function request(overrides: {
  method?: string
  path?: string
  /** `null` stands for an authorizer that attached no claims — the fail-closed case. */
  sub?: string | null
}): APIGatewayProxyEvent {
  const { method = 'GET', path = '/conversations', sub = ALICE } = overrides

  return {
    httpMethod: method,
    path,
    headers: { origin: 'https://app.example.com' },
    requestContext: { authorizer: sub === null ? {} : { claims: { sub } } },
  } as unknown as APIGatewayProxyEvent
}

const body = (result: { body: string }) => JSON.parse(result.body)

beforeEach(() => {
  memorySend.mockReset()
  dynamoSend.mockReset()
  memorySend.mockResolvedValue({ events: [] })
  dynamoSend.mockResolvedValue({ Items: [] })
})

describe('the conversation routes, without a caller', () => {
  it('fails closed when the authorizer attached no claims, and reads nothing', async () => {
    // The gateway always attaches them, so their absence means the route is misconfigured or being
    // reached some other way. There is no identity to scope a read to, so no read is safe.
    const result = await handler(request({ sub: null }))

    expect(result.statusCode).toBe(401)
    expect(body(result).code).toBe('unauthenticated')
    expect(memorySend).not.toHaveBeenCalled()
    expect(dynamoSend).not.toHaveBeenCalled()
  })

  it('fails closed on a per-conversation route too, before the ownership check', async () => {
    const result = await handler(request({ path: `/conversations/${ALICE_SESSION}`, sub: null }))

    expect(result.statusCode).toBe(401)
    expect(memorySend).not.toHaveBeenCalled()
  })
})

describe('a session id that belongs to someone else', () => {
  it('is answered 404 on read, and is never fetched', async () => {
    // The whole point of `belongsToCaller`: a session id names a memory partition, so an unchecked
    // one is a path to another user's transcript. 404 rather than 403 — see the handler's note on
    // not turning the id space into an existence oracle.
    const result = await handler(request({ path: `/conversations/${BOB_SESSION}` }))

    expect(result.statusCode).toBe(404)
    expect(body(result).code).toBe('notFound')
    expect(memorySend).not.toHaveBeenCalled()
  })

  it('is answered 404 on delete, and nothing is erased', async () => {
    const result = await handler(
      request({ method: 'DELETE', path: `/conversations/${BOB_SESSION}` }),
    )

    expect(result.statusCode).toBe(404)
    expect(memorySend).not.toHaveBeenCalled()
    expect(dynamoSend).not.toHaveBeenCalled()
  })

  it('is answered 404 for a bare namespace, which would otherwise match every session', async () => {
    // Length is part of the ownership check, not a separate concern: the caller's own namespace with
    // nothing after it is a prefix for all of their conversations rather than one of them.
    const result = await handler(request({ path: `/conversations/${sessionNamespace(ALICE)}-` }))

    expect(result.statusCode).toBe(404)
    expect(memorySend).not.toHaveBeenCalled()
  })
})

describe('a conversation the caller owns', () => {
  it('is listed from the partition of the caller alone, and reads no message content', async () => {
    dynamoSend.mockResolvedValue({
      Items: [
        { sessionId: { S: ALICE_SESSION }, title: { S: 'Older' }, updatedAt: { S: '2026-09-01T00:00:00Z' } },
        { sessionId: { S: 'x'.repeat(40) }, title: { S: 'Newer' }, updatedAt: { S: '2026-09-05T00:00:00Z' } },
      ],
    })

    const result = await handler(request({ path: '/conversations' }))
    const [query] = sentTo(dynamoSend)

    expect(result.statusCode).toBe(200)
    expect(query?.kind).toBe('Query')
    expect(query?.input).toMatchObject({
      TableName: TABLE_NAME,
      ExpressionAttributeValues: { ':pk': { S: `USER#${ALICE}` } },
    })
    // Rendering the sidebar must not decrypt anybody's messages.
    expect(memorySend).not.toHaveBeenCalled()
    expect(body(result).conversations.map((c: { title: string }) => c.title)).toEqual(['Newer', 'Older'])
  })

  it('is read with the actor id of the caller, not one derived from the id it was asked for', async () => {
    // The second of two independent controls: even if the ownership check above were wrong, the
    // store is asked for this caller's actor, so it would refuse the read itself.
    memorySend.mockResolvedValue({
      events: [
        {
          eventTimestamp: new Date('2026-09-01T00:00:00Z'),
          payload: [{ conversational: { role: 'USER', content: { text: 'hello' } } }],
        },
      ],
    })

    const result = await handler(request({ path: `/conversations/${ALICE_SESSION}` }))
    const [list] = sentTo(memorySend)

    expect(result.statusCode).toBe(200)
    expect(list?.input).toMatchObject({
      memoryId: MEMORY_ID,
      actorId: sessionNamespace(ALICE),
      sessionId: ALICE_SESSION,
    })
    expect(body(result).messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('is answered 404 once its retention window has passed', async () => {
    memorySend.mockResolvedValue({ events: [] })

    const result = await handler(request({ path: `/conversations/${ALICE_SESSION}` }))

    expect(result.statusCode).toBe(404)
  })

  it('is deleted content first, index row second', async () => {
    // Interrupted the other way round, the content survives with nothing pointing at it:
    // unreachable through the UI and invisible to the person who asked for it to be gone.
    memorySend.mockResolvedValue({ events: [{ eventId: 'event-1' }] })

    const result = await handler(
      request({ method: 'DELETE', path: `/conversations/${ALICE_SESSION}` }),
    )

    expect(result.statusCode).toBe(204)
    expect(sentTo(memorySend).map((command) => command.kind)).toEqual(['ListEvents', 'DeleteEvent'])
    expect(sentTo(dynamoSend).map((command) => command.kind)).toEqual(['DeleteItem'])

    const lastErase = Math.max(...memorySend.mock.invocationCallOrder)
    expect(dynamoSend.mock.invocationCallOrder[0]).toBeGreaterThan(lastErase)
  })
})

describe('routing', () => {
  it('answers a preflight without requiring a caller', async () => {
    const result = await handler(request({ method: 'OPTIONS', sub: null }))

    expect(result.statusCode).toBe(204)
  })

  it('answers 404 for a path these routes do not serve', async () => {
    const result = await handler(request({ path: '/admin/users' }))

    expect(result.statusCode).toBe(404)
    expect(dynamoSend).not.toHaveBeenCalled()
  })

  it('turns an unexpected store failure into a 500, not a stack trace', async () => {
    dynamoSend.mockRejectedValue(new Error('DynamoDB is having a day'))

    const result = await handler(request({ path: '/conversations' }))

    expect(result.statusCode).toBe(500)
    expect(body(result).code).toBe('internal')
    expect(result.body).not.toContain('having a day')
  })
})
