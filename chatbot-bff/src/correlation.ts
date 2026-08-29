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
