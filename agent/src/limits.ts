/**
 * The ceilings on one turn: how large the request may be, and how much work answering it may cost.
 *
 * The body limits are defense in depth — the BFF's `MAX_MESSAGE_LENGTH` already bounds what reaches
 * here, so they are what holds if anything invokes the runtime directly. The loop limits below are
 * not defense in depth: nothing else in this template bounds them at all.
 */

/** Character ceiling, checked after decoding — this is what actually produces the JSON error. */
export const MAX_BODY_LENGTH = Number(process.env.MAX_BODY_LENGTH ?? 20_000)

/**
 * `express.raw()`'s own limit, set above `MAX_BODY_LENGTH`'s worst-case UTF-8 cost (4 bytes/char) so
 * the character check is what rejects an oversized body. Unconfigured, express's 100kb default
 * rejects with an HTML error page rather than the JSON this endpoint's callers expect.
 */
export const MAX_BODY_BYTES = `${MAX_BODY_LENGTH * 4}b`

/**
 * Ceilings on what a **single turn** may spend.
 *
 * These bound a different axis from everything else in this template and are the only thing that
 * does. The BFF's per-caller quota bounds how *often* the agent is called and `MAX_BODY_LENGTH`
 * bounds how *large* one request is; neither says anything about how many model calls one request
 * may cause. Without a ceiling here a single request inside every other limit can drive the agent
 * loop indefinitely — and the failure is silent, because the loop is working as designed. The chat
 * Lambda's 60s timeout ends the *relay*, not the loop: the container keeps calling Bedrock and the
 * tokens are still billed.
 *
 * Strands treats an omitted cap as "no limit on that dimension", so these have to be passed
 * explicitly on every `stream()` call — see `index.ts`.
 */

/**
 * Model calls per turn, where a turn is one model call plus any tool execution that follows.
 *
 * The predictable bound, and the one to tune first. A normal exchange needs one cycle, or two or
 * three when the model calls a tool and then answers with the result; ten leaves room for a genuinely
 * multi-step task while still being a number.
 */
export const MAX_AGENT_TURNS = positiveInteger(process.env.AGENT_MAX_TURNS, 10, 'AGENT_MAX_TURNS')

/**
 * Cumulative input + output tokens across every model call in one turn — the closest thing to "what
 * this request will be billed".
 *
 * A backstop rather than the primary control, and deliberately generous: each call re-sends the
 * conversation it was given, so the counter compounds. With `MEMORY_MAX_MESSAGES` at 40 a long
 * conversation can legitimately carry tens of thousands of tokens per call, and ten of those is
 * already six figures. Set too tight, this truncates real answers; the value below is meant to catch
 * a runaway, not to trim ordinary use.
 *
 * A soft cap: the loop stops at the first turn boundary at or past the budget, so a single oversized
 * response can overshoot it. `MAX_AGENT_OUTPUT_TOKENS` is what bounds one call.
 */
export const MAX_AGENT_TOTAL_TOKENS = positiveInteger(
  process.env.AGENT_MAX_TOTAL_TOKENS,
  400_000,
  'AGENT_MAX_TOTAL_TOKENS',
)

/**
 * The hard ceiling on a *single* model response, passed to the model rather than to the loop.
 *
 * This is the one cap the loop cannot overshoot. Generous enough for a long formatted answer —
 * lowering it does not save a runaway, it truncates a legitimate reply mid-sentence.
 */
export const MAX_AGENT_OUTPUT_TOKENS = positiveInteger(
  process.env.AGENT_MAX_OUTPUT_TOKENS,
  8192,
  'AGENT_MAX_OUTPUT_TOKENS',
)

/** The per-invocation caps, in the shape `agent.stream()` takes them. */
export const agentLimits: { turns: number; totalTokens: number } = {
  turns: MAX_AGENT_TURNS,
  totalTokens: MAX_AGENT_TOTAL_TOKENS,
}

/**
 * The stop reasons that mean a cap fired rather than the model finishing.
 *
 * A turn that ends this way produces no error and returns 200, so it reads as a complete answer that
 * simply stops. `index.ts` logs it for that reason — an unexplained truncation nobody can attribute
 * is the failure mode this whole module is meant to make visible.
 */
export const LIMIT_STOP_REASONS = new Set(['limitTurns', 'limitTotalTokens', 'limitOutputTokens'])

/**
 * Falls back rather than throwing on a bad value: this runs at module load in the request path, and a
 * typo in an optional ceiling must not stop the runtime from answering at all.
 */
function positiveInteger(input: string | undefined, fallback: number, name: string): number {
  const trimmed = input?.trim()
  if (!trimmed) return fallback

  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) {
    console.error(
      JSON.stringify({ level: 'error', event: 'config.invalid', variable: name, using: fallback }),
    )
    return fallback
  }

  return value
}
