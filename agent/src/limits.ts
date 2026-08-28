/**
 * Ceilings on a single `/invocations` body. Defense in depth: the BFF's `MAX_MESSAGE_LENGTH` already
 * bounds what reaches here, so this is the ceiling that holds if anything invokes the runtime directly.
 */

/** Character ceiling, checked after decoding — this is what actually produces the JSON error. */
export const MAX_BODY_LENGTH = Number(process.env.MAX_BODY_LENGTH ?? 20_000)

/**
 * `express.raw()`'s own limit, set above `MAX_BODY_LENGTH`'s worst-case UTF-8 cost (4 bytes/char) so
 * the character check is what rejects an oversized body. Unconfigured, express's 100kb default
 * rejects with an HTML error page rather than the JSON this endpoint's callers expect.
 */
export const MAX_BODY_BYTES = `${MAX_BODY_LENGTH * 4}b`
