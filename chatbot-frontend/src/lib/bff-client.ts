/**
 * The shared half of every BFF call that is not the chat stream: the token, the correlation id, and
 * the error contract.
 *
 * Extracted because there are now three route families (admin, conversations, chat) and the parts
 * they must agree on — which token the gateway's authorizer accepts, how a server error becomes
 * something the UI can localize — are exactly the parts that are wrong when they are copied.
 */
import { fetchAuthSession } from 'aws-amplify/auth'
import { readAppConfig } from './app-config'

const BFF_URL = readAppConfig('VITE_API_URL') ?? '/api'

/**
 * Header the correlation id travels in. It is minted here, in the browser, rather than by the
 * server: the point of the id is to connect what a user saw to what the logs recorded, and only the
 * browser is present for the first half of that. The BFF echoes it back, forwards it to the agent,
 * and files it on the stored turn.
 */
export const CORRELATION_HEADER = 'X-Correlation-Id'

/** Matches the character bound the BFF enforces before this value reaches a log line. */
export function newCorrelationId(): string {
  return crypto.randomUUID()
}

/**
 * Carries the server's stable error `code` alongside its English message.
 *
 * The code is what the UI localizes (see `translateErrorCode`); the message is the fallback for a
 * failure that never reached our handler — a 403 straight from the authorizer, a 502 — and
 * therefore has no code.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    /** The id to quote when reporting this failure. Present whenever the response carried one. */
    readonly correlationId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The id token — a REST Cognito authorizer with no `authorizationScopes` refuses an access token. */
async function idToken(): Promise<string> {
  const session = await fetchAuthSession({ forceRefresh: false })
  const token = session.tokens?.idToken?.toString()

  if (!token) throw new ApiError('No valid ID token. Please sign in.', 'noSession')
  return token
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const correlationId = newCorrelationId()

  const response = await fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: await idToken(),
      [CORRELATION_HEADER]: correlationId,
      ...init?.headers,
    },
  })

  // 204 carries no body by design; asking for JSON would throw on an empty one.
  if (response.status === 204) return undefined as T

  // Our handlers always answer JSON with `code` + `error`, but a gateway-level failure may not be
  // JSON at all — fall back to the status so the UI never renders "undefined".
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string
    error?: string
  } & T

  if (!response.ok) {
    throw new ApiError(
      payload.error ?? `Request failed (${response.status})`,
      payload.code,
      response.status,
      response.headers.get(CORRELATION_HEADER) ?? correlationId,
    )
  }

  return payload
}
