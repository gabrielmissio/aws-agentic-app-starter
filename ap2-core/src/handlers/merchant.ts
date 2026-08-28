import { randomUUID } from 'node:crypto'
import { merchant, type PaymentAttempt, type PaymentReceipt } from '../domain'
import type { PaymentCredential, PaymentInput } from '../domain'
import { ctx } from '../context'
import { callInternalEntity } from './internal-call'
import { handle, HttpError, ok, type LambdaEvent } from '../http'
import { requireCallerSub } from './require-identity'
import * as v from '../validate'

/**
 * Merchant Endpoint Lambda.
 *
 * Two of its four operations are agent-facing tools (`search_products`, `create_merchant_cart`); the
 * other two exist because in AP2 it is the **Merchant**, not the agent, that drives the MPP. The
 * agent has no route to the MPP at all — that separation is the whole reason these two ops live here
 * rather than being exposed directly.
 *
 * `create_merchant_cart` and `initiate_payment` resolve the caller from a signed identity token,
 * because a journey belongs to whoever opened it. `journeyId` is caller-chosen and is not a secret —
 * it appears in URLs, logs and the Explorer — and the cart lookup by journey is idempotent, so
 * without an owner check, naming someone else's journey returns *their* signed cart. `search_products`
 * needs no token: the catalog is the same for everyone.
 */
export const handler = (event: LambdaEvent) =>
  handle('merchant', event, async ({ body }) => {
    const c = ctx()

    switch (body.op) {
      case 'search_products': {
        // Free text, so it gets a length ceiling rather than a character allowlist — the query is
        // matched in memory and never becomes a key. `min: 0` because an empty query is "the menu".
        const b = v.parseRequest(body, {
          query: v.optional(v.text({ min: 0, max: merchant.MAX_SEARCH_QUERY_LENGTH })),
        })
        return ok(await merchant.searchProducts(c.merchant, b.query ?? ''))
      }

      case 'create_merchant_cart': {
        const b = v.parseRequest(body, {
          journeyId: v.optional(v.identifier()),
          items: v.list(
            v.group({
              productId: v.identifier(64),
              // The same ceilings `assertCartWithinLimits` enforces, applied at the door so a
              // 10,000-line body is refused before it is parsed into objects and priced.
              qty: v.integer({ min: 1, max: merchant.MAX_LINE_QTY }),
            }),
            { max: merchant.MAX_CART_LINES },
          ),
        })
        const ownerRef = await requireCallerSub(body, 'merchant')
        const journeyId = b.journeyId ?? 'journey_' + randomUUID().slice(0, 8)
        const cart = await merchant.createMerchantCart(
          c.merchant,
          c.signer,
          c.evidence,
          journeyId,
          b.items,
          ownerRef,
        )
        return ok({ cartMandate: cart, journeyId })
      }

      case 'initiate_payment': {
        const b = v.parseRequest(body, {
          journeyId: v.identifier(),
          checkoutMandate: v.compact(),
          credential: v.opaque(),
          idempotencyKey: v.optional(v.identifier()),
        })
        const callerRef = await requireCallerSub(body, 'merchant')

        const result = await merchant.initiatePayment(
          c.signer,
          c.evidence,
          c.merchant,
          payViaMpp,
          {
            journeyId: b.journeyId,
            callerRef,
            // One journey is one payment, so the journey id is the natural idempotency key: a retry
            // replays the receipt, while reusing the credential in a NEW journey is a double spend.
            idempotencyKey: b.idempotencyKey ?? b.journeyId,
            checkoutMandate: b.checkoutMandate,
            credential: b.credential as PaymentCredential,
          },
        )

        return ok({
          paymentId: result.paymentReceipt.contents.payment_id,
          status: result.paymentReceipt.contents.status,
          receiptId: result.paymentReceipt.contents.receipt_id,
          receipt: result.paymentReceipt,
          checkoutReceipt: result.checkoutReceipt,
        })
      }

      case 'get_payment_status': {
        const b = v.parseRequest(body, { paymentId: v.identifier() })
        const a = await merchant.getPaymentStatus(getStatusViaMpp, b.paymentId)
        if (!a) throw new HttpError(404, 'payment not found')
        return ok(a)
      }

      default:
        throw new HttpError(400, `unknown op: ${String(body.op)}`)
    }
  })

/** Merchant → MPP: a SigV4-signed POST to the MPP's private Function URL. */
async function payViaMpp(input: PaymentInput): Promise<PaymentReceipt> {
  const data = await callInternalEntity<{ receipt: PaymentReceipt }>(
    process.env.MPP_ENDPOINT,
    'MPP_ENDPOINT',
    { op: 'initiate_payment', ...input },
  )
  return data.receipt
}

function getStatusViaMpp(paymentId: string): Promise<PaymentAttempt | undefined> {
  return callInternalEntity<PaymentAttempt | undefined>(
    process.env.MPP_ENDPOINT,
    'MPP_ENDPOINT',
    { op: 'get_payment_status', paymentId },
  )
}
