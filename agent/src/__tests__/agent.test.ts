import { describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the SDK's `Agent` that keeps the config it was constructed with.
 *
 * The SDK hands `traceAttributes` straight to a private tracer and exposes them nowhere on the
 * instance, so asserting the *value* of the version is not enough — one computed correctly and never
 * passed stamps nothing. Intercepting the constructor is what makes the wiring observable, for the
 * same reason `app.test.ts` executes `app.ts` rather than only testing `config.ts`.
 */
vi.mock('@strands-agents/sdk', async () => {
  const actual = await vi.importActual<typeof import('@strands-agents/sdk')>('@strands-agents/sdk')

  return {
    ...actual,
    Agent: class {
      readonly traceAttributes: Record<string, unknown> | undefined

      constructor(config: { traceAttributes?: Record<string, unknown> }) {
        this.traceAttributes = config.traceAttributes
      }
    },
  }
})

const { createAgent, systemPrompt, systemPromptVersion } = await import('../agent')

/**
 * What the stub above recorded. Read through a cast because `createAgent` is typed as returning the
 * SDK's `Agent`, which does not declare the property — the point of the stub is to make visible
 * something the real class keeps private.
 */
function traceAttributesOf(agent: unknown): Record<string, unknown> | undefined {
  return (agent as { traceAttributes?: Record<string, unknown> }).traceAttributes
}

/**
 * The prompt is the largest un-versioned input to a turn, and until it was stamped on a span a trace
 * could not answer "which prompt produced this answer" — so a regression reported from a pilot could
 * not be tied to a revision. The guardrail beside it is pinned to an immutable numbered version for
 * exactly that reason; these assertions are what keep the prompt from drifting back to unversioned.
 */
describe('the system prompt carries a version', () => {
  it('derives the version from the prompt itself', async () => {
    const { createHash } = await import('node:crypto')
    const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8)

    // A digest, not a hand-maintained number: a version someone has to remember to bump is a version
    // that silently stops matching the prompt.
    expect(systemPromptVersion).toMatch(/^[0-9a-f]{8}$/)
    expect(systemPromptVersion).toBe(digest(systemPrompt))
    expect(digest(`${systemPrompt} `)).not.toBe(systemPromptVersion)
  })

  /**
   * Unconditionally, and not merged in only when a caller passes request attributes: the version is a
   * property of the build rather than of the request, so there is no turn it should be missing from.
   * A directly invoked runtime carries no `session.id` and must still carry this.
   */
  it('stamps the version on every agent, with or without request attributes', () => {
    expect(traceAttributesOf(createAgent())).toEqual({
      'gen_ai.system_instructions.version': systemPromptVersion,
    })

    // The request's own attributes survive the merge — the version must not displace them.
    const withRequest = createAgent(undefined, { 'session.id': 'abc', 'correlation.id': 'xyz' })
    expect(traceAttributesOf(withRequest)).toEqual({
      'gen_ai.system_instructions.version': systemPromptVersion,
      'session.id': 'abc',
      'correlation.id': 'xyz',
    })
  })
})
