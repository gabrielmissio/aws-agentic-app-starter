import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

/**
 * Signs (AWS SigV4, `service: 'lambda'`) and sends a JSON POST to a Lambda Function URL protected by
 * `AuthType=AWS_IAM`.
 *
 * This is what makes the internal hops (Merchant → MPP, MPP → CP) private: the URLs are reachable
 * only by an IAM identity granted `InvokeFunctionUrl` on that specific function. Credentials come
 * from the execution role via `defaultProvider()`, memoized and refreshed on expiry.
 */
let signer: SignatureV4 | undefined

function getSigner(): SignatureV4 {
  if (!signer) {
    signer = new SignatureV4({
      service: 'lambda',
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: defaultProvider(),
      sha256: Sha256,
    })
  }
  return signer
}

/**
 * How long one entity waits on another. Ten seconds against a 15-second entity Lambda and a
 * 29-second checkout Lambda, so a stuck dependency surfaces as a timeout the caller has headroom to
 * log and answer, rather than the caller being killed with nothing written down.
 *
 * No retry: every operation downstream either moves money or consumes a single-use artifact, and a
 * blind retry on an ambiguous timeout is how one authorization becomes two. Idempotency lives where
 * a retry is safe — the MPP keys on the journey — not in the transport.
 */
export const ENTITY_CALL_TIMEOUT_MS = 10_000

export async function sigv4PostJson(url: string, payload: unknown): Promise<Response> {
  const u = new URL(url)
  const body = JSON.stringify(payload)

  const request = new HttpRequest({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    // `host` is part of SignedHeaders, and fetch sends the same Host — so the signature matches.
    headers: { 'content-type': 'application/json', host: u.hostname },
    body,
  })

  const signed = await getSigner().sign(request)

  // Propagate the active X-Ray context so a whole checkout — merchant → consent → CP → MPP —
  // collapses into ONE trace. Added AFTER signing on purpose: `X-Amzn-Trace-Id` is not in
  // SignedHeaders, so it cannot invalidate the signature. A no-op outside the Lambda runtime, which
  // is the only place that env var is set.
  const headers = { ...(signed.headers as Record<string, string>) }
  const traceHeader = process.env._X_AMZN_TRACE_ID
  if (traceHeader) headers['X-Amzn-Trace-Id'] = traceHeader

  return fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(ENTITY_CALL_TIMEOUT_MS),
  })
}
