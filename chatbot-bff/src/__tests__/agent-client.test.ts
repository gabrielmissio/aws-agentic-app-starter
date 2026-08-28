/**
 * `InvokeAgentRuntimeCommand`'s response body comes back as an async-iterable `SdkStream` in
 * Node/Lambda, not the browser-style `ReadableStream` the rest of this codebase's stream-parsing
 * code is written against — a difference that only shows up once deployed. `toAsyncIterable` is the
 * normalization layer that makes both shapes work through the same downstream code.
 */
import { describe, expect, it } from 'vitest'
import { toAsyncIterable } from '../agent-client.js'

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let out = ''
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
}

describe('toAsyncIterable', () => {
  it('passes through the async-iterable SdkStream the AWS SDK returns in Node/Lambda', async () => {
    const encoder = new TextEncoder()
    const sdkStream = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode('hello ')
        yield encoder.encode('world')
      },
    }

    expect(await collect(toAsyncIterable(sdkStream))).toBe('hello world')
  })

  it('adapts a browser-style ReadableStream', async () => {
    const encoder = new TextEncoder()
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('hello '))
        controller.enqueue(encoder.encode('world'))
        controller.close()
      },
    })

    expect(await collect(toAsyncIterable(readable))).toBe('hello world')
  })

  it('rejects anything else instead of silently yielding nothing', () => {
    expect(() => toAsyncIterable(undefined)).toThrow(TypeError)
    expect(() => toAsyncIterable({})).toThrow(/Unsupported AgentCore response stream type/)
  })
})
