/**
 * Ceilings on a single `/invocations` body.
 *
 * Defense in depth, not the primary guardrail: the BFF's own `MAX_MESSAGE_LENGTH` (see
 * `chatbot-bff/src/http.ts`) already bounds what reaches here, and the BFF is the runtime's only
 * caller. This is the ceiling that holds if anything ever invokes the runtime directly.
 */

/** Character ceiling, checked after decoding — this is what actually produces the JSON error. */
export const MAX_BODY_LENGTH = Number(process.env.MAX_BODY_LENGTH ?? 20_000)

/**
 * Byte ceiling for `express.raw()`'s own `limit` option, set above `MAX_BODY_LENGTH`'s worst-case
 * UTF-8 cost (4 bytes/char) so the character check above is what rejects an oversized body, not
 * `express.raw()` itself. Left unconfigured, that default (100kb) would reject silently with an
 * HTML error page — not the JSON this endpoint's callers expect — for any body over ~25k characters,
 * well below a legitimate long prompt.
 */
export const MAX_BODY_BYTES = `${MAX_BODY_LENGTH * 4}b`
