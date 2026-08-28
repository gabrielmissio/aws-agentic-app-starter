import { mpp, type PaymentCredential, type RedeemInstruction } from '../domain'
import { ctx } from '../context'
import { callInternalEntity } from './internal-call'
import { handle, HttpError, ok, type LambdaEvent } from '../http'
import * as v from '../validate'

/**
 * Merchant Payment Processor Lambda.
 *
 * Called by the **Merchant**, never by the agent — its Function URL is granted to the merchant role
 * only. It verifies the entire chain, redeems the credential at the CP, calls the PSP and signs the
 * receipt.
 */
export const handler = (event: LambdaEvent) =>
  handle('mpp', event, async ({ body }) => {
    const c = ctx()

    switch (body.op) {
      case 'initiate_payment': {
        const b = v.parseRequest(body, {
          journeyId: v.identifier(),
          checkoutMandate: v.compact(),
          checkoutJwtHash: v.text({ max: 128 }),
          credential: v.opaque(),
          // The key the reservation is taken under, so it bounds a DynamoDB partition key.
          idempotencyKey: v.optional(v.identifier()),
        })

        const receipt = await mpp.initiatePayment(
          c.signer,
          c.evidence,
          redeemViaCp,
          c.psp,
          c.mpp,
          c.nonces,
          {
            journeyId: b.journeyId,
            idempotencyKey: b.idempotencyKey ?? b.journeyId,
            checkoutMandate: b.checkoutMandate,
            checkoutJwtHash: b.checkoutJwtHash,
            credential: b.credential as PaymentCredential,
          },
        )

        return ok({
          paymentId: receipt.contents.payment_id,
          status: receipt.contents.status,
          receiptId: receipt.contents.receipt_id,
          receipt,
        })
      }

      case 'get_payment_status': {
        const b = v.parseRequest(body, { paymentId: v.identifier() })
        const a = await c.mpp.getAttempt(b.paymentId)
        if (!a) throw new HttpError(404, 'payment not found')
        return ok(a)
      }

      default:
        throw new HttpError(400, `unknown op: ${String(body.op)}`)
    }
  })

/**
 * MPP → CP redeem, over the CP's private Function URL.
 *
 * Kept as a network call rather than an in-process one even though both could live in the same
 * Lambda: the CP governing its own redeem is a trust boundary, and collapsing it would mean the
 * process that calls the PSP is also the process that decides a credential is still valid.
 */
async function redeemViaCp(
  credential: PaymentCredential,
  callingMpp: string,
): Promise<RedeemInstruction> {
  return callInternalEntity<RedeemInstruction>(process.env.CP_ENDPOINT, 'CP_ENDPOINT', {
    op: 'redeem',
    credential,
    callingMpp,
  })
}
