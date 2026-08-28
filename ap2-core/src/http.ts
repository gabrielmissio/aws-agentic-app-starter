import { BlockedError } from './domain'
import { createLogger, type LogFields, type Logger } from './log'

/**
 * The shared request envelope for the five entity Lambdas: parse the body once, bind a request
 * logger, and translate every failure mode into a coherent response.
 */

export interface LambdaEvent {
  body?: string | null
  rawPath?: string
  requestContext?: { http?: { method?: string }; routeKey?: string }
  pathParameters?: Record<string, string> | null
  headers?: Record<string, string | undefined>
}

export interface LambdaResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

/** The parsed request body. Handlers narrow it themselves; the envelope only parses JSON. */
export type RequestBody = Record<string, unknown>

/** What every entity handler receives: the raw event, the parsed body, and a bound logger. */
export interface HandlerInput {
  event: LambdaEvent
  body: RequestBody
  log: Logger
}

/**
 * The five AP2 entity roles — the `service` tag on every log line. A closed union, so a typo at a
 * `handle()` call site is a compile error rather than a mislabelled log line found mid-incident.
 */
export type EntityService = 'merchant' | 'consent' | 'cp' | 'mpp' | 'evidence'

export function ok(data: unknown, statusCode = 200): LambdaResult {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      // Every entity response is a signed artifact, a mandate, or a refusal scoped to one caller.
      // These are server-to-server over Function URLs, so a browser cache is not the risk — an
      // intermediary that retains one is, and `no-store` is the only directive that forbids it.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(data),
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Maps an accountability code onto an HTTP status.
 *
 * The distinctions matter to a caller: 422 means the artifact itself did not hold up, 409 means it
 * was valid but no longer usable, 403 means it was valid but does not authorize this, and 404 means
 * it refers to something unknown.
 */
const BLOCK_STATUS: Record<string, number> = {
  TAMPERED: 422,
  EXPIRED: 409,
  DOUBLE_SPEND: 409,
  REPLAYED: 409,
  // Valid, but not usable *right now*: another attempt holds the idempotency key. 409 rather than
  // 422, because nothing about the artifacts is wrong — the caller is simply second.
  IN_PROGRESS: 409,
  OUT_OF_SCOPE: 403,
  INVALID_MANDATE: 422,
  INVALID_CREDENTIAL: 422,
  UNKNOWN_CREDENTIAL: 404,
  UNKNOWN_METHOD: 404,
}

/**
 * The active X-Ray trace id, from the runtime's `_X_AMZN_TRACE_ID` (`Root=1-…;Parent=…;Sampled=1`).
 * Logging `Root` pivots between a trace and its logs without bundling the X-Ray SDK. No-op locally.
 */
function currentTraceId(): string | undefined {
  return process.env._X_AMZN_TRACE_ID?.match(/Root=([^;]+)/)?.[1]
}

/** Best-effort correlation fields stamped on every request log line. */
function requestBindings(body: RequestBody): LogFields {
  const out: LogFields = {}
  const traceId = currentTraceId()
  if (traceId) out.traceId = traceId
  if (typeof body.op === 'string') out.op = body.op
  if (typeof body.journeyId === 'string') out.journeyId = body.journeyId
  return out
}

/**
 * Wraps one entity handler.
 *
 * The body is parsed once and the same logger is used by both the success path and the `catch`, so
 * an unexpected error always carries service, journey, op and trace — the alternative is a bare
 * stack trace with no way to tell which checkout it belonged to.
 */
export async function handle(
  service: EntityService,
  event: LambdaEvent,
  fn: (input: HandlerInput) => Promise<LambdaResult>,
): Promise<LambdaResult> {
  let body: RequestBody = {}
  let badJson = false

  if (event.body) {
    try {
      body = JSON.parse(event.body) as RequestBody
    } catch {
      badJson = true
    }
  }

  const log = createLogger({ service }).child(requestBindings(body))
  const start = Date.now()

  try {
    if (badJson) throw new HttpError(400, 'invalid JSON body')
    const res = await fn({ event, body, log })
    log.info('request', { status: res.statusCode, durationMs: Date.now() - start })
    return res
  } catch (err) {
    const durationMs = Date.now() - start

    if (err instanceof BlockedError) {
      // A block is an accountability OUTCOME, not a server fault: warn, so a refused checkout is
      // reconstructable from logs, but do not page anyone over the system working as designed.
      // The verifier's signed Error receipt travels back alongside it.
      const res = ok(
        {
          blocked: true,
          code: err.code,
          message: err.message,
          ...(err.receipt ? { receipt: err.receipt } : {}),
        },
        BLOCK_STATUS[err.code] ?? 403,
      )
      log.warn('blocked', {
        code: err.code,
        message: err.message,
        status: res.statusCode,
        durationMs,
      })
      return res
    }

    if (err instanceof HttpError) {
      const res = ok({ error: err.message, code: err.code }, err.status)
      log.info('request', { status: res.statusCode, durationMs, code: err.code })
      return res
    }

    // An unexpected fault. The logger attaches a bounded stack, so the throw is diagnosable straight
    // from the line — no redeploy at DEBUG. Redaction still applies to everything it carries.
    log.error('unexpected handler error', { err, status: 500, durationMs })
    return ok({ error: 'internal error' }, 500)
  }
}
