import { describe, expect, it } from 'vitest'
import { EmptyReplyError, parseAgentCoreStream, type StreamCallbacks } from '../lib/stream-parser'

function makeCallbacks() {
  const tokens: string[] = []
  const thinking: string[] = []
  const tools: string[] = []
  const statuses: string[] = []
  const errors: Error[] = []
  let completed = 0

  const callbacks: StreamCallbacks = {
    onToken: (text) => tokens.push(text),
    onThinking: (text) => thinking.push(text),
    onToolStart: (name) => tools.push(name),
    onStatus: (status) => statuses.push(status),
    onComplete: () => {
      completed += 1
    },
    onError: (error) => errors.push(error),
  }

  return {
    callbacks,
    tokens,
    thinking,
    tools,
    statuses,
    errors,
    get text() {
      return tokens.join('')
    },
    get thinkingText() {
      return thinking.join('')
    },
    get completed() {
      return completed
    },
  }
}

/** Builds a Response-like object whose body streams `frames`, each in its own network chunk. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })

  return { body } as unknown as Response
}

const textDelta = (text: string) =>
  `data: ${JSON.stringify({
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
  })}\n\n`

const messageStop = (stopReason: string) =>
  `data: ${JSON.stringify({
    type: 'modelStreamUpdateEvent',
    event: { type: 'modelMessageStopEvent', stopReason },
  })}\n\n`

describe('parseAgentCoreStream', () => {
  it('streams visible text token by token and completes once', async () => {
    const h = makeCallbacks()

    await parseAgentCoreStream(sseResponse([textDelta('Hello '), textDelta('world')]), h.callbacks)

    expect(h.tokens).toEqual(['Hello ', 'world'])
    expect(h.completed).toBe(1)
    expect(h.errors).toEqual([])
  })

  it('routes <thinking> blocks to onThinking, even when the tags arrive split across tokens', async () => {
    const h = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([
        textDelta('<think'),
        textDelta('ing>plotting'),
        textDelta(' a course</think'),
        textDelta('ing>Ready.'),
        messageStop('endTurn'),
      ]),
      h.callbacks,
    )

    expect(h.thinkingText).toBe('plotting a course')
    expect(h.text).toBe('Ready.')
    expect(h.statuses).toContain('Thinking...')
  })

  it('reports tool calls the model requests', async () => {
    const h = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([
        `data: ${JSON.stringify({
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockStartEvent',
            start: { toolUse: { name: 'calculator' } },
          },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'afterToolCallEvent' })}\n\n`,
        messageStop('endTurn'),
      ]),
      h.callbacks,
    )

    expect(h.tools).toEqual(['calculator'])
    expect(h.statuses).toContain('Using calculator')
    expect(h.completed).toBe(1)
  })

  it('completes once when the turn ends with both a stop event and a result event', async () => {
    // Strands sends both: the model stopped, and the agent produced its result. Consumers act on
    // completion — screens hang end-of-turn work off it — so a second signal would do that work
    // twice for a single turn.
    const h = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([
        textDelta('pronto'),
        messageStop('endTurn'),
        `data: ${JSON.stringify({ type: 'agentResultEvent' })}\n\n`,
      ]),
      h.callbacks,
    )

    expect(h.completed).toBe(1)
  })

  it('ignores the [DONE] sentinel and unparsable lines rather than failing the stream', async () => {
    const h = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([textDelta('ok'), 'data: not-json\n\n', 'data: [DONE]\n\n']),
      h.callbacks,
    )

    expect(h.text).toBe('ok')
    expect(h.errors).toEqual([])
    expect(h.completed).toBe(1)
  })

  it('surfaces a failed model call instead of skipping it as lifecycle noise', async () => {
    // The shape that shipped an empty bubble: the model call fails, the event carrying the reason
    // looks like every other lifecycle event, the stream ends cleanly and `done` reports ok. The
    // message is the only place the actual cause exists, so it has to reach the caller verbatim.
    const c = makeCallbacks()
    const denied =
      'Model access is denied due to IAM user or service role is not authorized to perform the ' +
      'required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)'

    await parseAgentCoreStream(
      sseResponse([
        `data: ${JSON.stringify({ type: 'afterModelCallEvent', attemptCount: 1, error: { message: denied } })}\n\n`,
        `data: ${JSON.stringify({ type: 'afterInvocationEvent' })}\n\n`,
        'data: [DONE]\n\n',
      ]),
      c.callbacks,
    )

    expect(c.errors.map((error) => error.message)).toEqual([denied])
    expect(c.completed).toBe(1)
  })

  it('reports an error carried on any event, not only the model call', async () => {
    // A turn can fail in ways this parser has not been told about; the `error` shape is the signal.
    const c = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([
        `data: ${JSON.stringify({ type: 'afterToolCallEvent', error: { message: 'tool exploded' } })}\n\n`,
      ]),
      c.callbacks,
    )

    expect(c.errors.map((error) => error.message)).toEqual(['tool exploded'])
  })

  it('names a turn that ends without producing a reply, rather than completing silently', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(sseResponse([`data: ${JSON.stringify({ type: 'afterInvocationEvent' })}\n\n`]), c.callbacks)

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]).toBeInstanceOf(EmptyReplyError)
    expect(c.completed).toBe(1)
  })

  it('reports no empty-reply error when the turn actually replied', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(sseResponse([textDelta('hello'), messageStop('endTurn')]), c.callbacks)

    expect(c.errors).toEqual([])
    expect(c.text).toBe('hello')
  })

  it('reports a failure once, without also claiming the reply was empty', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([`data: ${JSON.stringify({ type: 'afterModelCallEvent', error: { message: 'throttled' } })}\n\n`]),
      c.callbacks,
    )

    expect(c.errors.map((error) => error.message)).toEqual(['throttled'])
  })

  it('surfaces a missing body as an error instead of hanging', async () => {
    const h = makeCallbacks()

    await parseAgentCoreStream({ body: null } as unknown as Response, h.callbacks)

    expect(h.errors).toHaveLength(1)
    expect(h.completed).toBe(0)
  })

  it('reports reader failures through onError', async () => {
    const h = makeCallbacks()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'))
      },
    })

    await parseAgentCoreStream({ body } as unknown as Response, h.callbacks)

    expect(h.errors.map((e) => e.message)).toEqual(['connection reset'])
  })
})
