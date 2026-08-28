import { BlockedError, type CheckoutReceipt, type PaymentReceipt } from '../domain'
import { sigv4PostJson } from '../adapters-aws'
import { HttpError } from '../http'

/**
 * A signed POST to another entity's private Lambda Function URL, with the AP2 error mapping applied.
 *
 * The single implementation used by both internal hops (Merchant → MPP and MPP → CP). Its job is to
 * make the network boundary invisible to the domain: a `blocked` response is re-thrown as the same
 * `BlockedError` the in-process call would have raised, so the accountability code survives the hop
 * end-to-end instead of degrading into a generic HTTP failure.
 */
export async function callInternalEntity<T>(
  url: string | undefined,
  what: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (!url) throw new HttpError(500, `${what} is not configured`)

  const res = await sigv4PostJson(url, payload)
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (data?.blocked) {
    const err = new BlockedError(String(data.code ?? 'BLOCKED'), String(data.message ?? 'blocked'))
    // The rejecting verifier signs an Error receipt and the envelope puts it on the wire (see
    // `http.ts`). Carrying it across the hop is what lets the Merchant link that receipt's hash into
    // its own Checkout Receipt — drop it here and the rejection arrives unsigned on the far side.
    if (data.receipt) err.receipt = data.receipt as PaymentReceipt | CheckoutReceipt
    throw err
  }
  if (!res.ok) {
    throw new HttpError(res.status, (data?.error as string) ?? `call to ${what} failed`)
  }

  return data as T
}
