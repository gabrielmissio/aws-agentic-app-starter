import { describe, expect, it } from 'vitest'
import { CORRELATION_HEADER, resolveCorrelationId } from '../correlation.js'

describe('resolveCorrelationId', () => {
  const generate = () => 'generated'

  it('honors the id the browser minted, so both ends name the turn the same way', () => {
    expect(resolveCorrelationId({ [CORRELATION_HEADER]: 'abc-123' }, generate)).toBe('abc-123')
  })

  // API Gateway does not normalize header casing, and neither do browsers.
  it('finds the header whatever case it arrives in', () => {
    expect(resolveCorrelationId({ 'X-Correlation-Id': 'abc-123' }, generate)).toBe('abc-123')
  })

  /**
   * The destination of this value is a JSON-per-line log. A newline in it would let a caller write
   * whole log entries that are indistinguishable from real ones — including a forged audit line.
   */
  it('refuses an id carrying a newline rather than logging it', () => {
    const forged = 'abc\n{"level":"info","event":"audit","outcome":"success"}'

    expect(resolveCorrelationId({ [CORRELATION_HEADER]: forged }, generate)).toBe('generated')
  })

  it.each([
    ['a control character', 'abc\r123'],
    ['a quote that would break the JSON line', 'abc"123'],
    ['something longer than the bound', 'a'.repeat(65)],
    ['an empty value', ''],
  ])('replaces %s with a fresh id', (_label, supplied) => {
    expect(resolveCorrelationId({ [CORRELATION_HEADER]: supplied }, generate)).toBe('generated')
  })

  it('generates when the client sent none', () => {
    expect(resolveCorrelationId({}, generate)).toBe('generated')
    expect(resolveCorrelationId(undefined, generate)).toBe('generated')
  })
})
