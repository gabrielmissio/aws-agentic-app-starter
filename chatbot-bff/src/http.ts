/**
 * CORS helpers shared by the chat handler (SSE) and the admin handler (plain JSON).
 */

const CHAT_CORS_METHODS = 'POST, OPTIONS'
/** The admin routes add a listing endpoint, so they advertise GET on top of the chat methods. */
export const ADMIN_CORS_METHODS = 'GET, POST, OPTIONS'
const CORS_HEADERS = 'Content-Type, Authorization'

/**
 * Resolves `Access-Control-Allow-Origin` against the configured allowlist.
 *
 * `ALLOWED_ORIGIN` is a comma-separated list, or the literal `*`. With `*` the wildcard is echoed
 * back. Otherwise the caller's origin is reflected **only if it is on the list**; anything else gets
 * the first configured origin, which is a value the calling page is not, so the browser refuses it.
 *
 * Reflecting whatever origin arrives would make this knob a no-op. That alone is not exploitable
 * here — `Access-Control-Allow-Credentials` is never sent and the API authenticates with a bearer
 * header rather than a cookie, so a foreign page cannot make the browser attach a victim's token —
 * but it becomes exploitable the moment anyone adds credentialed requests.
 */
export function resolveOrigin(allowedOrigin: string, requestOrigin?: string): string {
  if (allowedOrigin === '*') return '*'

  const allowed = allowedOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const fallback = allowed[0] ?? allowedOrigin
  if (!requestOrigin) return fallback
  return allowed.includes(requestOrigin) ? requestOrigin : fallback
}

export function sseHeaders(allowedOrigin: string, requestOrigin?: string): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': resolveOrigin(allowedOrigin, requestOrigin),
    'Access-Control-Allow-Methods': CHAT_CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    'X-Content-Type-Options': 'nosniff',
  }
}

/**
 * Headers for every JSON response this API returns.
 *
 * `no-store` and `nosniff` are not boilerplate here. Each of these responses is scoped to one
 * caller — the admin user listing today, whatever per-user data a route returns tomorrow — and the
 * routes are plain `GET`s that a browser, a proxy or a `bfcache` entry will happily keep.
 * `no-store` is the only directive that covers all three; `no-cache` still permits storage, and
 * the SSE path uses it for a different reason (keeping a stream from being buffered).
 *
 * `nosniff` matters because the bodies are attacker-influenceable — a user list carries names and
 * email addresses people chose — and a browser that content-sniffs a JSON body it decided looks
 * like HTML renders it.
 */
export function jsonHeaders(
  allowedOrigin: string,
  requestOrigin?: string,
  methods: string = CHAT_CORS_METHODS,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': resolveOrigin(allowedOrigin, requestOrigin),
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': CORS_HEADERS,
  }
}

/**
 * Serializes one SSE event. Multi-line payloads get one `data:` line each, per the SSE spec — a raw
 * newline inside a single `data:` line would end the event early.
 */
export function formatSseEvent(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  const lines = payload.split('\n').map((line) => `data: ${line}\n`)

  return `event: ${event}\n${lines.join('')}\n`
}

/**
 * Ceiling on a single prompt, in characters.
 *
 * Rate limiting (see infra's `API_RATE_LIMIT`) caps how *often* the agent is called; this caps how
 * *much* each call costs. Without it, one authenticated client pasting a large document in a loop
 * runs up unbounded Bedrock spend with no other guardrail catching it. Generous enough for a long
 * question, small enough that abuse is bounded — raise it deliberately, not by accident.
 */
export const MAX_MESSAGE_LENGTH = 8000

/** Whether a prompt is present, a non-blank string, and within the cost ceiling. */
export function validateMessage(
  message: unknown,
  maxLength: number = MAX_MESSAGE_LENGTH,
): { ok: true; message: string } | { ok: false; error: string } {
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'Missing "message" field' }
  }

  if (message.length > maxLength) {
    return { ok: false, error: `"message" exceeds ${maxLength} characters` }
  }

  return { ok: true, message }
}
