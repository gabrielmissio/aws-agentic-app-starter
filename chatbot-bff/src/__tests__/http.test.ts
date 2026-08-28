import { describe, expect, it } from 'vitest'
import {
  formatSseEvent,
  jsonHeaders,
  MAX_MESSAGE_LENGTH,
  resolveOrigin,
  sseHeaders,
  validateMessage,
} from '../http.js'

describe('resolveOrigin', () => {
  it('echoes the wildcard when the BFF is open to any origin', () => {
    expect(resolveOrigin('*', 'https://app.example.com')).toBe('*')
    expect(resolveOrigin('*')).toBe('*')
  })

  it('reflects the caller origin when it is on the allowlist', () => {
    expect(resolveOrigin('https://app.example.com', 'https://app.example.com')).toBe(
      'https://app.example.com',
    )
  })

  it('refuses an origin that is not on the allowlist', () => {
    // Reflecting whatever origin arrived would make configuring ALLOWED_ORIGIN a no-op. The value
    // returned here is not the calling page's origin, so the browser rejects the response — which is
    // the entire job of this header.
    expect(resolveOrigin('https://app.example.com', 'https://evil.example.com')).toBe(
      'https://app.example.com',
    )
    expect(resolveOrigin('https://app.example.com', 'null')).toBe('https://app.example.com')
    // A prefix or suffix of an allowed origin is not an allowed origin.
    expect(resolveOrigin('https://app.example.com', 'https://app.example.com.evil.test')).toBe(
      'https://app.example.com',
    )
  })

  it('accepts any origin on a comma-separated allowlist, and nothing else', () => {
    const allowed = 'https://app.example.com, https://staging.example.com'
    expect(resolveOrigin(allowed, 'https://staging.example.com')).toBe('https://staging.example.com')
    expect(resolveOrigin(allowed, 'https://app.example.com')).toBe('https://app.example.com')
    expect(resolveOrigin(allowed, 'https://other.example.com')).toBe('https://app.example.com')
  })

  it('falls back to the configured origin when the request has none', () => {
    expect(resolveOrigin('https://app.example.com')).toBe('https://app.example.com')
  })
})

describe('headers', () => {
  it('marks the SSE response as a non-buffered event stream', () => {
    const headers = sseHeaders('*')

    expect(headers['Content-Type']).toBe('text/event-stream; charset=utf-8')
    expect(headers['Cache-Control']).toBe('no-cache, no-transform')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('carries the same CORS contract on the JSON error path', () => {
    const headers = jsonHeaders('https://app.example.com', 'https://app.example.com')

    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com')
    expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS')
  })

  it('advertises GET on the admin CORS methods, on top of the chat ones', () => {
    const headers = jsonHeaders('*', undefined, 'GET, POST, OPTIONS')

    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS')
  })
})

describe('formatSseEvent', () => {
  it('frames a JSON payload as one event terminated by a blank line', () => {
    expect(formatSseEvent('chunk', { content: 'hi' })).toBe(
      'event: chunk\ndata: {"content":"hi"}\n\n',
    )
  })

  it('splits multi-line payloads across data lines so the event is not cut short', () => {
    expect(formatSseEvent('chunk', 'line one\nline two')).toBe(
      'event: chunk\ndata: line one\ndata: line two\n\n',
    )
  })
})

describe('validateMessage', () => {
  it('accepts a normal prompt', () => {
    expect(validateMessage('how many r in strawberry?')).toEqual({
      ok: true,
      message: 'how many r in strawberry?',
    })
  })

  it('rejects a missing, non-string or blank message', () => {
    expect(validateMessage(undefined).ok).toBe(false)
    expect(validateMessage(42).ok).toBe(false)
    expect(validateMessage('   ').ok).toBe(false)
  })

  // Rate limiting caps how *often* the agent is called; this caps how *much* each call costs.
  it('rejects a prompt past the ceiling', () => {
    expect(validateMessage('x'.repeat(MAX_MESSAGE_LENGTH))).toEqual({
      ok: true,
      message: 'x'.repeat(MAX_MESSAGE_LENGTH),
    })
    expect(validateMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1))).toEqual({
      ok: false,
      error: `"message" exceeds ${MAX_MESSAGE_LENGTH} characters`,
    })
  })

  it('honours an explicit ceiling', () => {
    expect(validateMessage('abcdef', 5).ok).toBe(false)
  })
})
