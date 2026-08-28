import { cp, type CartMandate, type PaymentCredential } from '../domain'
import { ctx } from '../context'
import { handle, HttpError, ok, type LambdaEvent } from '../http'
import { requireCallerSub } from './require-identity'
import * as v from '../validate'

/**
 * Credential Provider Lambda.
 *
 * `list_payment_methods` and `request_payment_credential` are reachable by the agent and the BFF;
 * `redeem` is reachable only by the MPP, because the CP's Function URL grants `InvokeFunctionUrl` to
 * the MPP role alone. The op itself does not need to police that — IAM already did.
 *
 * The two caller-facing operations resolve the user from a **signed identity token**, not from a
 * body field. IAM says which *component* may call; the token says which *user* it is calling for,
 * and the agent can forge neither. `redeem` needs no token: its caller is the MPP, not a user.
 */
export const handler = (event: LambdaEvent) =>
  handle('cp', event, async ({ body }) => {
    const c = ctx()

    switch (body.op) {
      case 'list_payment_methods': {
        v.parseRequest(body, {})
        const userId = await requireCallerSub(body, 'cp')
        return ok(await cp.listPaymentMethods(c.credential, userId, c.autoProvisionSandbox))
      }

      case 'request_payment_credential': {
        const b = v.parseRequest(body, {
          journeyId: v.identifier(),
          cartMandate: v.opaque(),
          paymentMandate: v.compact(),
          paymentMethodRef: v.identifier(64),
          targetMpp: v.identifier(64),
          // Bounded on both ends: zero would issue a credential already expired, and an
          // unbounded value would widen the window a single-use credential is spendable in.
          expiresInSec: v.optional(v.integer({ min: 30, max: 3600 })),
        })
        const userId = await requireCallerSub(body, 'cp')

        // Every signature and hash link is re-verified here — nothing is taken on the caller's word.
        const credential = await cp.issueCredential(c.credential, c.signer, c.evidence, c.nonces, {
          journeyId: b.journeyId,
          userId,
          cartMandate: b.cartMandate as CartMandate,
          paymentMandate: b.paymentMandate,
          paymentMethodRef: b.paymentMethodRef,
          targetMpp: b.targetMpp,
          allowedMpps: c.allowedMpps,
          ...(b.expiresInSec === undefined ? {} : { expiresInSec: b.expiresInSec }),
        })

        return ok({
          credentialId: credential.contents.credential_id,
          expiresAt: credential.contents.expires_at,
          credential,
        })
      }

      case 'redeem': {
        const b = v.parseRequest(body, {
          credential: v.opaque(),
          callingMpp: v.identifier(64),
          journeyId: v.optional(v.identifier()),
        })
        const credential = b.credential as PaymentCredential

        const instruction = await cp.redeem(
          c.credential,
          c.signer,
          c.evidence,
          b.journeyId ?? credential.contents?.journey_id,
          credential,
          b.callingMpp,
        )
        return ok(instruction)
      }

      default:
        throw new HttpError(400, `unknown op: ${String(body.op)}`)
    }
  })
