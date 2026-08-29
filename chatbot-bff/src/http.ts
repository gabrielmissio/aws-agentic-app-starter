/**
 * CORS helpers shared by the chat handler (SSE) and the admin handler (plain JSON).
 */

const CHAT_CORS_METHODS = 'POST, OPTIONS'
/** The admin routes add a listing endpoint, so they advertise GET on top of the chat methods. */
export const ADMIN_CORS_METHODS = 'GET, POST, OPTIONS'
/** The conversation routes read and remove, and never create — no POST. */
export const CONVERSATION_CORS_METHODS = 'GET, DELETE, OPTIONS'
/**
 * `X-Correlation-Id` is here because the browser mints the id: it is what makes a user's report
 * ("it broke at 14:32") resolvable to one turn across three log groups. It must also be listed in
 * `allowHeaders` on the gateway's preflight (`infra/src/stacks/bff-stack.ts`), or the browser drops
 * the request before it is ever sent.
 */
const CORS_HEADERS = 'Content-Type, Authorization, X-Correlation-Id'

/** Echoed back so a client can show the id it should quote when reporting a problem. */
const CORS_EXPOSED_HEADERS = 'X-Correlation-Id'

/**
 * `ALLOWED_ORIGIN` is a comma-separated allowlist, or the literal `*`. A listed origin is reflected
 * back; anything else gets the first configured one, which the calling page is not, so the browser
 * refuses the response.
 *
 * Reflecting whatever arrives would make this a no-op. Not exploitable today — no
 * `Access-Control-Allow-Credentials`, and a bearer header rather than a cookie — but it becomes so
 * the moment anyone adds credentialed requests.
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
    'Access-Control-Expose-Headers': CORS_EXPOSED_HEADERS,
    'X-Content-Type-Options': 'nosniff',
  }
}

/**
 * Headers for every JSON response. `no-store` rather than `no-cache`: these responses are scoped to
 * one caller and returned from plain `GET`s, and only `no-store` forbids a browser, a proxy or a
 * `bfcache` entry from keeping one. `nosniff` because the bodies carry user-chosen text, and a
 * browser that content-sniffs a JSON body into HTML renders it.
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
    'Access-Control-Expose-Headers': CORS_EXPOSED_HEADERS,
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
 * Ceiling on a single prompt. Rate limiting caps how *often* the agent is called; this caps how
 * *much* each call costs. Raise it deliberately.
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
