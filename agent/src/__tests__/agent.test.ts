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
      readonly printer: unknown

      constructor(config: { traceAttributes?: Record<string, unknown>; printer?: unknown }) {
        this.traceAttributes = config.traceAttributes
        // Captured as given, not defaulted, so the test can tell "passed false" apart from "not
        // passed at all" — which is the whole difference this file is asserting.
        this.printer = config.printer
      }
    },
  }
})

const { createAgent, GUARDED_STOP_REASONS, systemPrompt, systemPromptVersion } = await import('../agent')

/**
 * What the stub above recorded. Read through a cast because `createAgent` is typed as returning the
 * SDK's `Agent`, which does not declare the property — the point of the stub is to make visible
 * something the real class keeps private.
 */
function traceAttributesOf(agent: unknown): Record<string, unknown> | undefined {
  return (agent as { traceAttributes?: Record<string, unknown> }).traceAttributes
}

/** Likewise for the printer setting, which the real class also keeps to itself. */
function printerOf(agent: unknown): unknown {
  return (agent as { printer?: unknown }).printer
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

/**
 * The SDK writes the model's answer to `process.stdout` unless told not to, and under AgentCore
 * stdout is the runtime's log group. That default put every reply — and every reasoning block, which
 * the user never sees — into CloudWatch Logs verbatim, contradicting the rule `correlation.ts`
 * states for the BFF and the redaction `span-redaction.ts` performs for the spans.
 *
 * Asserted rather than trusted because it is an *absence*: the config key simply not being there is
 * what reintroduces the leak, and that is invisible in review.
 */
describe('the agent does not print the conversation to stdout', () => {
  it('disables the SDK printer explicitly', () => {
    expect(printerOf(createAgent())).toBe(false)
  })

  /** Including on the path a request takes, which is the one that actually carries a conversation. */
  it('disables it on an agent built for a request', () => {
    expect(printerOf(createAgent(undefined, { 'session.id': 'abc' }))).toBe(false)
  })
})

/**
 * A guardrail intervention ends the turn with an ordinary stop reason on a 200 response, so nothing
 * about the transport says it happened. `index.ts` reads this set to log and count it.
 *
 * The SDK's `StopReason` union ends in `(string & {})`, so no type check can hold these spellings to
 * the SDK's — which is exactly why they live in one exported constant. This test is what makes an
 * edit to that constant deliberate; an SDK upgrade still has to be checked by hand.
 */
describe('the stop reasons a content control ends a turn with', () => {
  it('names the guardrail and the model filter, and nothing else', () => {
    expect([...GUARDED_STOP_REASONS].sort()).toEqual(['contentFiltered', 'guardrailIntervened'])
  })

  /**
   * The two sets drive different log events and different remedies — a cap is a configuration
   * decision, an intervention is content. An overlap would file one as the other.
   */
  it('shares nothing with the reasons a cap fired', async () => {
    const { LIMIT_STOP_REASONS } = await import('../limits')

    for (const reason of GUARDED_STOP_REASONS) {
      expect(LIMIT_STOP_REASONS.has(reason)).toBe(false)
    }
  })
})
