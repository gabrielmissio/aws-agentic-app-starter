import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { currentCaller } from './caller'

/**
 * A minimal SigV4 client for the AP2 entity Function URLs.
 *
 * Self-contained rather than importing `ap2-core/client`: the agent image's Docker build context is
 * this package's own directory, so a `file:../ap2-core` dependency does not resolve at image build
 * time. It also matches the design — a propose-only agent calls four operations and reads JSON back,
 * and has no business carrying the signing and verification domain.
 */

export interface EntityUrls {
  merchantUrl: string
  consentUrl: string
  cpUrl: string
}

/**
 * The entity URLs, or `null` when unconfigured — which is what lets the AP2 tools be conditionally
 * registered, so a local run with no AWS offers none rather than tools that fail on every call.
 */
export function entityUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): EntityUrls | null {
  const { MERCHANT_URL, CONSENT_URL, CP_URL } = env
  if (!MERCHANT_URL || !CONSENT_URL || !CP_URL) return null
  return { merchantUrl: MERCHANT_URL, consentUrl: CONSENT_URL, cpUrl: CP_URL }
}

/** Built once: `defaultProvider()` memoizes and refreshes credentials, so rebuilding it per call
 * would re-resolve them on every tool invocation. */
let signer: SignatureV4 | undefined

function getSigner(): SignatureV4 {
  if (!signer) {
    signer = new SignatureV4({
      service: 'lambda',
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: defaultProvider(),
      sha256: Sha256,
    })
  }
  return signer
}

/**
 * A blocked AP2 operation — the chain refused, accountability code intact. Distinct from a transport
 * failure because they mean opposite things to the agent: a block is the system working and should
 * be explained, a transport failure is a fault.
 */
/** How long the agent waits on an entity before giving up. Matches `ap2-core`'s own ceiling. */
export const ENTITY_CALL_TIMEOUT_MS = 10_000

export class Ap2BlockedError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'Ap2BlockedError'
  }
}

/**
 * Signs and sends one JSON POST to an entity's IAM-authenticated Function URL.
 *
 * Two credentials ride along, answering different questions. **SigV4** proves *which component* is
 * calling: the agent's execution role, granted invoke on this specific function. **`identityToken`**
 * proves *which user* it calls for: a short-lived JWS the BFF signed with a KMS key the agent cannot
 * reach, taken verbatim from the request's caller context.
 *
 * The agent can neither mint nor alter the token, and holds only the one for the turn it is serving.
 * An entity needing a user refuses a call without it — there is no `userId` field to fall back to.
 */
export async function callEntity<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const u = new URL(url)
  const identityToken = currentCaller()?.identityToken
  const body = JSON.stringify(identityToken ? { ...payload, identityToken } : payload)

  const request = new HttpRequest({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    // `host` is signed, and fetch sends the same value, so the signature matches on arrival.
    headers: { 'content-type': 'application/json', host: u.hostname },
    body,
  })

  const signed = await getSigner().sign(request)
  const res = await fetch(url, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
    // A stuck entity must not hold the agent open until AgentCore kills it. No retry: these calls
    // sign nothing, but a blind retry on an ambiguous timeout is a habit payments do not survive.
    signal: AbortSignal.timeout(ENTITY_CALL_TIMEOUT_MS),
  })

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (data?.blocked) {
    throw new Ap2BlockedError(String(data.code ?? 'BLOCKED'), String(data.message ?? 'blocked'))
  }
  if (!res.ok) {
    throw new Error((data?.error as string) ?? `entity call failed (${res.status})`)
  }

  return data as T
}
