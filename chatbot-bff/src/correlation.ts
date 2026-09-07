/**
 * The id that ties one conversation turn together across three runtimes.
 *
 * Without it, diagnosing a wrong answer means correlating a browser report, an API Gateway access
 * log and a container log by timestamp and hope. The browser mints an id per request, the BFF logs
 * every line under it and forwards it to AgentCore as trace context, and the agent's spans carry it.
 */
import { randomUUID } from 'node:crypto'

/** Header the browser sends it in, and the one the BFF echoes back. */
export const CORRELATION_HEADER = 'x-correlation-id'

/**
 * Bounded and character-restricted because this value is client-supplied and its destination is a
 * log line. A newline in it would let a caller forge whole log entries — the JSON-per-line format
 * that makes these logs queryable is also what makes an injected line indistinguishable from a real
 * one. Anything that does not fit is replaced rather than rejected: the id is a diagnostic aid, and
 * failing a chat request over one would be the wrong trade.
 */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{1,64}$/

export function resolveCorrelationId(
  headers: Record<string, string | undefined> | null | undefined,
  generate: () => string = randomUUID,
): string {
  const supplied = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === CORRELATION_HEADER,
  )?.[1]

  return supplied && VALID_CORRELATION_ID.test(supplied) ? supplied : generate()
}

export interface LogFields {
  correlationId: string
  /** The caller's Cognito `sub`. Never an email — the access log already carries identity. */
  actorSub?: string
  sessionId?: string
  [key: string]: unknown
}

/**
 * One structured line. The chat path used to emit bare `console.error(err)`, which is unqueryable
 * and — because an `Error` stringifies to its message — drops the id that would locate the turn.
 *
 * Message content is never a field here. What makes an incident diagnosable is knowing which turn
 * failed and where, not what was said in it; conversation content has a storage location with a
 * declared retention, and a log group is not it.
 */
export function logEvent(level: 'info' | 'error', event: string, fields: LogFields): void {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...fields })

  if (level === 'error') console.error(line)
  else console.log(line)
}

/**
 * The W3C `traceparent` describing the current Lambda segment, built from X-Ray's own header.
 *
 * Why this exists: the correlation id ties the three runtimes together by *string*, which is enough
 * to find the turn but not to draw it. The Lambda's X-Ray segment and the agent's OTel spans stay
 * two unrelated trees, so "where did the time go" has to be answered by reading two consoles and
 * comparing timestamps. `traceparent` is what makes them one trace, and AgentCore accepts it as a
 * first-class field on the invocation.
 *
 * The conversion is a reformat, not a new id. `_X_AMZN_TRACE_ID` carries
 * `Root=1-<8 hex>-<24 hex>;Parent=<16 hex>;Sampled=1`, and the root's two hex groups are exactly the
 * 32 hex characters a W3C trace id is — so the two systems describe the same trace, and dropping
 * the `1-` prefix is the whole of it.
 *
 * Returns undefined when tracing is off, when the header is absent, or when it is not the shape
 * documented above. A malformed `traceparent` is worse than none: the receiver starts a detached
 * trace rather than rejecting it, so the span goes somewhere nobody thinks to look.
 */
export function traceParentFrom(header: string | undefined): string | undefined {
  if (!header) return undefined

  const fields = new Map(
    header
      .split(';')
      .map((entry) => entry.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  )

  const root = fields.get('Root')
  const match = root && /^1-([0-9a-f]{8})-([0-9a-f]{24})$/.exec(root)
  if (!match) return undefined

  const traceId = `${match[1]}${match[2]}`
  // X-Ray's `Parent` is already a 16-hex span id. Absent — which is the usual case for the root
  // segment of a request — a zeroed id is not legal, so a span id is derived from the trace id
  // instead; it is stable per turn, which is what the receiver needs to attach to.
  const parentId = fields.get('Parent') ?? traceId.slice(0, 16)
  if (!/^[0-9a-f]{16}$/.test(parentId)) return undefined

  // `Sampled=1` becomes the sampled flag. Unsampled here means unsampled downstream, so the agent
  // does not pay to export spans for a turn X-Ray already decided not to keep.
  const flags = fields.get('Sampled') === '1' ? '01' : '00'

  return `00-${traceId}-${parentId}-${flags}`
}
