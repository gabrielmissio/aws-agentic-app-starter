import { describe, expect, it } from 'vitest'
import {
  EmptyReplyError,
  parseAgentCoreStream,
  TurnLimitError,
  type StreamCallbacks,
} from '../lib/stream-parser'

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

const agentResult = (stopReason: string) =>
  `data: ${JSON.stringify({ type: 'agentResultEvent', result: { stopReason } })}\n\n`

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

  /**
   * The worse half of the silent-failure pair. A capped turn produces text and then stops, so the
   * answer reads as finished — often mid-task, right after the model asked for a tool the loop then
   * refused to run. Nothing errors and the runtime answers 200, so without this the only record is a
   * log line in the agent's log group that the person reading the answer cannot see.
   */
  it('names a turn the agent loop cut short at a cap, keeping the text it did produce', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([
        textDelta('Step one is done, next I will'),
        // The last model call ended ordinarily; the cap lands on the *result*, which is the only
        // place a per-invocation limit surfaces.
        messageStop('toolUse'),
        agentResult('limitTurns'),
      ]),
      c.callbacks,
    )

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]).toBeInstanceOf(TurnLimitError)
    expect((c.errors[0] as TurnLimitError).stopReason).toBe('limitTurns')
    // The partial answer survives — replacing it would hide both what the agent managed to say and
    // that it stopped.
    expect(c.text).toBe('Step one is done, next I will')
    expect(c.completed).toBe(1)
  })

  // The model's own per-response ceiling, which arrives on the message stop rather than the result.
  it('names a response the model truncated at its token ceiling', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([textDelta('A very long answer that runs'), messageStop('maxTokens')]),
      c.callbacks,
    )

    expect(c.errors[0]).toBeInstanceOf(TurnLimitError)
    expect((c.errors[0] as TurnLimitError).stopReason).toBe('maxTokens')
  })

  // A cap that did not fire must stay silent, or every ordinary turn grows a warning.
  it('reports no limit error for a turn that finished on its own', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([textDelta('done'), messageStop('endTurn'), agentResult('endTurn')]),
      c.callbacks,
    )

    expect(c.errors).toEqual([])
    expect(c.completed).toBe(1)
  })

  // A reported failure is the more specific explanation, so a cap must not add a second notice.
  it('prefers a reported failure over the cap notice', async () => {
    const c = makeCallbacks()

    await parseAgentCoreStream(
      sseResponse([
        `data: ${JSON.stringify({ type: 'afterModelCallEvent', error: { message: 'model denied' } })}\n\n`,
        agentResult('limitTurns'),
      ]),
      c.callbacks,
    )

    expect(c.errors.map((error) => error.message)).toEqual(['model denied'])
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
