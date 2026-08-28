/**
 * Structured logger for the AP2 surfaces — one JSON object per line, so CloudWatch Logs Insights can
 * query by field instead of by regex.
 *
 * Shared by the entity Lambdas and the BFF's AP2 handler, with zero dependencies so neither drags a
 * logging framework into a cold start. Three properties matter:
 *
 *  - **One correlation key.** `log.child({ journeyId })` binds it once and every later line carries
 *    it, so a checkout reconstructs with `filter journeyId = "..."` across all four entities.
 *  - **Redaction is a hard rule.** Secrets are masked even at DEBUG, on a denylist that recurses
 *    into nested fields. The call site never decides — the only way such a rule survives.
 *  - **Level-gated before serialization**, so a DEBUG line in a hot path costs a comparison.
 *
 * @example
 *   const log = createLogger({ service: 'merchant' })
 *   log.child({ journeyId }).info('cart signed', { amountCents, currency })
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
export type LogFields = Record<string, unknown>

const LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }

function thresholdFromEnv(): number {
  const raw = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()
  return LEVELS[raw as LogLevel] ?? LEVELS.INFO
}

let threshold = thresholdFromEnv()

/** Overrides the active level at runtime. Used by tests; `LOG_LEVEL` governs otherwise. */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level]
}

// ── Redaction ───────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]'
const DEPTH_LIMIT = 6
/** Stack frames kept above DEBUG — enough to locate a throw without flooding the line. */
const STACK_FRAME_LIMIT = 8

function boundStack(stack: string | undefined): string | undefined {
  return stack?.split('\n').slice(0, STACK_FRAME_LIMIT).join('\n')
}

/**
 * Case-insensitive substring match on the field KEY. Conservative, but it covers the whole secret
 * surface this stack touches: one-time codes, the HMAC seal, bearer tokens, private/API keys, and
 * cardholder data.
 *
 * Signed AP2 artifacts (`cartMandate`, `paymentMandate`, the credential object) are deliberately
 * absent: they are hashes and signatures, not secrets, and they are exactly what you need to be able
 * to query when reconstructing a disputed checkout.
 */
const SENSITIVE_KEY =
  /otp|hmac|seal|secret|passwd|password|authorization|bearer|token|private[_-]?key|api[_-]?key|\bpan\b|card[_-]?number|cardnumber|\bcvv\b|\bcvc\b/i

/**
 * Sandbox-only escape hatch that surfaces the OTP in logs, for testing without SMS delivery (the SNS
 * sandbox only reaches verified numbers). Never set this in a real environment.
 */
const LOG_OTP_INSECURE = process.env.LOG_OTP_INSECURE === 'true'

function isSensitiveKey(key: string): boolean {
  if (LOG_OTP_INSECURE && key.toLowerCase() === 'otp') return false
  return SENSITIVE_KEY.test(key)
}

/** Deep-copies `value`, masking sensitive keys and serializing Errors. Bounded depth guards cycles. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > DEPTH_LIMIT) return '[depth-limit]'

  if (value instanceof Error) {
    // The single place an Error becomes a log field. A bounded stack rides along above DEBUG —
    // stacks carry frames and file:line, never argument values, so a few frames are safe and make a
    // throw diagnosable without redeploying at DEBUG. The full stack stays a DEBUG opt-in.
    const stack = threshold <= LEVELS.DEBUG ? value.stack : boundStack(value.stack)
    return stack
      ? { name: value.name, message: value.message, stack }
      : { name: value.name, message: value.message }
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1)
    }
    return out
  }

  return value
}

// ── Emit ────────────────────────────────────────────────────────────────

function emit(level: LogLevel, msg: string, bound: LogFields, fields?: LogFields): void {
  if (LEVELS[level] < threshold) return

  const record = { ts: new Date().toISOString(), level, msg, ...bound, ...fields }
  const safe = redact(record) as Record<string, unknown>

  let line: string
  try {
    line = JSON.stringify(safe)
  } catch {
    // Unserializable fields (a cycle, a BigInt) must never crash a request path.
    line = JSON.stringify({ ts: record.ts, level, msg, logError: 'unserializable fields' })
  }

  // WARN and above go to stderr. Both streams land in the same log group, but keeping them
  // separable matches console semantics and local-dev expectations.
  if (LEVELS[level] >= LEVELS.WARN) process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

// ── Public API ──────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Returns a logger that stamps `bound` on every line — bind correlation keys here. */
  child(bound: LogFields): Logger
}

function make(bound: LogFields): Logger {
  return {
    debug: (m, f) => emit('DEBUG', m, bound, f),
    info: (m, f) => emit('INFO', m, bound, f),
    warn: (m, f) => emit('WARN', m, bound, f),
    error: (m, f) => emit('ERROR', m, bound, f),
    child: (extra) => make({ ...bound, ...extra }),
  }
}

/** Creates a logger with a fixed set of bound fields, e.g. `{ service: 'bff' }`. */
export function createLogger(bound: LogFields = {}): Logger {
  return make(bound)
}

/** Root logger. Prefer `createLogger({ service })` per surface and `.child({ journeyId })` per request. */
export const log: Logger = make({})
