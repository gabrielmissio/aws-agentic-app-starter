import { describe, expect, it, vi } from 'vitest'
import { parseAgentCoreStream, __testing, type StreamCallbacks } from '../lib/stream-parser'

const { deepFindString } = __testing

/**
 * The consent session id is what tells the UI to open the checkout gate, and it arrives inside a
 * tool result whose wrapping shape is not stable across SDK versions. When this stops matching, the
 * failure mode is that the authorization card never appears — which reads as the agent being broken
 * rather than as a parser having drifted, so the shapes are pinned here.
 */
describe('deepFindString', () => {
  it('finds a value nested at any depth', () => {
    expect(deepFindString({ a: { b: { sessionId: 'cs_1' } } }, 'sessionId')).toBe('cs_1')
    expect(deepFindString([{ x: 1 }, { sessionId: 'cs_2' }], 'sessionId')).toBe('cs_2')
  })

  it('looks inside JSON that was itself serialized into a string', () => {
    // The common shape: a tool result arrives as `content: [{ text: '{"sessionId":"..."}' }]`.
    const event = { toolResult: { content: [{ text: JSON.stringify({ sessionId: 'cs_3' }) }] } }
    expect(deepFindString(event, 'sessionId')).toBe('cs_3')
  })

  it('ignores non-string and empty values', () => {
    expect(deepFindString({ sessionId: 42 }, 'sessionId')).toBeUndefined()
    expect(deepFindString({ sessionId: '' }, 'sessionId')).toBeUndefined()
    expect(deepFindString(null, 'sessionId')).toBeUndefined()
    expect(deepFindString('plain text', 'sessionId')).toBeUndefined()
  })

  it('survives a malformed JSON string without throwing', () => {
    expect(deepFindString({ text: '{"sessionId": broken' }, 'sessionId')).toBeUndefined()
  })
})

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('') + 'data: [DONE]\n'
  return new Response(new Blob([body]).stream())
}

function callbacks(overrides: Partial<StreamCallbacks> = {}): StreamCallbacks {
  return {
    onToken: vi.fn(),
    onToolStart: vi.fn(),
    onThinking: vi.fn(),
    onStatus: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

describe('consent detection in the stream', () => {
  it('emits the session id when the consent tool finishes', async () => {
    const onConsentProposed = vi.fn()
    await parseAgentCoreStream(
      sse([
        { type: 'beforeToolCallEvent', toolUse: { name: 'initiate_consent_session' } },
        { type: 'afterToolCallEvent', toolResult: { content: [{ text: '{"sessionId":"cs_abc"}' }] } },
      ]),
      callbacks({ onConsentProposed }),
    )
    expect(onConsentProposed).toHaveBeenCalledWith('cs_abc')
  })

  it('attributes a result event that omits the tool name to the last tool started', async () => {
    const onConsentProposed = vi.fn()
    await parseAgentCoreStream(
      sse([
        {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockStartEvent',
            start: { toolUse: { name: 'initiate_consent_session' } },
          },
        },
        { type: 'toolResultEvent', result: { sessionId: 'cs_xyz' } },
      ]),
      callbacks({ onConsentProposed }),
    )
    expect(onConsentProposed).toHaveBeenCalledWith('cs_xyz')
  })

  it('ignores a session id from any other tool', async () => {
    // Only the consent tool opens a checkout. A stray `sessionId` elsewhere in the stream must not
    // put an authorization card in front of the user.
    const onConsentProposed = vi.fn()
    await parseAgentCoreStream(
      sse([
        { type: 'beforeToolCallEvent', toolUse: { name: 'search_products' } },
        { type: 'afterToolCallEvent', toolResult: { content: [{ text: '{"sessionId":"cs_no"}' }] } },
      ]),
      callbacks({ onConsentProposed }),
    )
    expect(onConsentProposed).not.toHaveBeenCalled()
  })

  it('does not fire when the consent tool returned no session id', async () => {
    const onConsentProposed = vi.fn()
    await parseAgentCoreStream(
      sse([
        { type: 'beforeToolCallEvent', toolUse: { name: 'initiate_consent_session' } },
        { type: 'afterToolCallEvent', toolResult: { content: [{ text: '{"error":"no cart"}' }] } },
      ]),
      callbacks({ onConsentProposed }),
    )
    expect(onConsentProposed).not.toHaveBeenCalled()
  })

  it('leaves an ordinary conversation untouched when no callback is given', async () => {
    const onToken = vi.fn()
    const onComplete = vi.fn()
    await parseAgentCoreStream(
      sse([
        {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'hello' },
          },
        },
        { type: 'agentResultEvent' },
      ]),
      callbacks({ onToken, onComplete }),
    )
    expect(onToken).toHaveBeenCalledWith('hello')
    expect(onComplete).toHaveBeenCalled()
  })
})
