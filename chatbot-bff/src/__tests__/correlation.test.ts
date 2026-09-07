import { describe, expect, it } from 'vitest'
import { CORRELATION_HEADER, resolveCorrelationId, traceParentFrom } from '../correlation.js'

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

describe('traceParentFrom', () => {
  /**
   * The conversion is a reformat, not a new id: X-Ray's root carries the same 32 hex characters a
   * W3C trace id does. That is what makes the Lambda segment and the agent's spans one trace rather
   * than two trees sharing a correlation id.
   */
  it('reformats an X-Ray root into a W3C traceparent', () => {
    expect(
      traceParentFrom('Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1'),
    ).toBe('00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01')
  })

  /** Unsampled here means unsampled downstream, so the agent does not pay to export a discarded turn. */
  it('carries the sampling decision through', () => {
    expect(
      traceParentFrom('Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=0'),
    ).toMatch(/-00$/)
  })

  /** A root segment usually has no `Parent`, and an all-zero span id is not legal. */
  it('derives a span id when X-Ray supplies no parent', () => {
    const result = traceParentFrom('Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1')

    expect(result).toBe('00-5759e988bd862e3fe1be46a994272793-5759e988bd862e3f-01')
  })

  /**
   * A malformed traceparent is worse than none: the receiver starts a detached trace instead of
   * rejecting it, so the span lands somewhere nobody thinks to look.
   */
  it('yields nothing rather than a malformed header', () => {
    expect(traceParentFrom(undefined)).toBeUndefined()
    expect(traceParentFrom('')).toBeUndefined()
    expect(traceParentFrom('Root=not-a-trace-id')).toBeUndefined()
    expect(traceParentFrom('Root=1-5759e988-tooshort;Sampled=1')).toBeUndefined()
    expect(traceParentFrom('Parent=53995c3f42cd8ad8')).toBeUndefined()
  })
})
