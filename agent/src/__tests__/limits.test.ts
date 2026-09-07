import { describe, expect, it } from 'vitest'
import {
  agentLimits,
  LIMIT_STOP_REASONS,
  MAX_AGENT_OUTPUT_TOKENS,
  MAX_AGENT_TOTAL_TOKENS,
  MAX_AGENT_TURNS,
  MAX_BODY_BYTES,
  MAX_BODY_LENGTH,
} from '../limits.js'

describe('limits', () => {
  it('defaults MAX_BODY_LENGTH to a positive number', () => {
    expect(MAX_BODY_LENGTH).toBeGreaterThan(0)
  })

  // MAX_BODY_BYTES has to clear MAX_BODY_LENGTH's worst-case UTF-8 cost (4 bytes/char), or
  // express.raw() would reject an oversized-but-legal-length body before the character check in
  // index.ts ever runs — which is exactly the silent-HTML-413 bug this pair of constants exists to
  // avoid. See the note in limits.ts.
  it('sizes the byte ceiling to never trip before the character ceiling does', () => {
    expect(MAX_BODY_BYTES).toBe(`${MAX_BODY_LENGTH * 4}b`)

    const worstCaseUtf8Bytes = MAX_BODY_LENGTH * 4
    const byteLimit = Number(MAX_BODY_BYTES.replace(/b$/, ''))
    expect(byteLimit).toBeGreaterThanOrEqual(worstCaseUtf8Bytes)
  })
})

/**
 * The agent loop is the one axis nothing else in this template bounds: the BFF's quota caps how often
 * a caller invokes the agent and MAX_BODY_LENGTH caps how large one request is, but neither says
 * anything about how many model calls one request may cause. Strands treats an omitted cap as
 * unlimited, so "we forgot to pass limits" and "we chose no limit" are the same code — which is why
 * the presence of every cap is asserted rather than left to review.
 */
describe('the agent loop is bounded', () => {
  it('caps turns and cumulative tokens, and passes both to the loop', () => {
    expect(MAX_AGENT_TURNS).toBeGreaterThan(0)
    expect(MAX_AGENT_TOTAL_TOKENS).toBeGreaterThan(0)

    // The object handed to `agent.stream()`. A cap present here and absent there bounds nothing.
    expect(agentLimits).toEqual({
      turns: MAX_AGENT_TURNS,
      totalTokens: MAX_AGENT_TOTAL_TOKENS,
    })
    for (const value of Object.values(agentLimits)) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
  })

  // `limits` is a soft cap — the loop stops at the first turn boundary at or past the budget, so one
  // oversized response can overshoot it. This is the cap that cannot be overshot, and it is set on the
  // model rather than on the loop, so a change to one must not silently drop the other.
  it('caps a single model response', () => {
    expect(MAX_AGENT_OUTPUT_TOKENS).toBeGreaterThan(0)
    expect(Number.isInteger(MAX_AGENT_OUTPUT_TOKENS)).toBe(true)
  })

  // A cap firing returns 200 with a short answer and no error, so the stop reason is the only
  // evidence it happened. Named against the SDK's `StopReason` union — a rename there must not
  // silently turn `turn.limited` into a line that is never logged.
  it('recognizes every stop reason that means a cap fired', () => {
    expect([...LIMIT_STOP_REASONS].sort()).toEqual([
      'limitOutputTokens',
      'limitTotalTokens',
      'limitTurns',
    ])
  })
})
