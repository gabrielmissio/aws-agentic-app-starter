import { describe, expect, it } from 'vitest'
import { parseAgentCoreStream, type StreamCallbacks } from '../lib/stream-parser'

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
    // completion — the chat opens the checkout gate there — and the gate mints a fresh one-time
    // code each time it is opened, so a second signal invalidates the code already on screen.
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
