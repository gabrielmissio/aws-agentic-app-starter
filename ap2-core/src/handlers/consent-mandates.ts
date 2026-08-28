import { randomUUID } from 'node:crypto'
import type { CartMandate, ConsentSession } from '../domain'
import { ctx } from '../context'
import { handle, HttpError, ok, type LambdaEvent } from '../http'
import { requireCallerSub } from './require-identity'
import * as v from '../validate'

/**
 * Consent sessions Lambda — the session and read half of the consent surface.
 *
 * It opens a session over a signed cart, reads it back for a channel adapter, and hands the signed
 * mandates to whoever polls for them. It **holds no signing key**: `submit_consent_decision`, the
 * one operation that turns an approval into signed mandates, lives in `consent-decision.ts` on its
 * own function and its own IAM-gated Function URL, granted only to the checkout Lambda.
 *
 * That split is a specification requirement, not tidiness — see the header of `consent-decision.ts`.
 * The practical consequence for this file: the agent can call every operation here, and full control
 * of this function still mints nothing.
 */
export const handler = (event: LambdaEvent) =>
  handle('consent', event, async ({ body }) => {
    const c = ctx()

    switch (body.op) {
      case 'initiate_consent_session': {
        const b = v.parseRequest(body, {
          journeyId: v.identifier(),
          // Bounded, not described: the cart is signed, and this session stores it in DynamoDB, so
          // what matters here is that it cannot arrive larger than the item it becomes.
          cartMandate: v.opaque(),
          paymentMethodRef: v.identifier(64),
        })
        // The session's owner comes from the signed token, never from the body. `/intent` in the BFF
        // refuses a session whose `userId` is not the authenticated caller, so a session opened
        // under someone else's id would be a way to attach a checkout to another user.
        const userId = await requireCallerSub(body, 'consent')

        // The full UUID, not a 10-character prefix. A session id is a reference the checkout surface
        // and the Explorer both carry, and 10 hex characters is a space small enough to walk — the
        // ownership checks below are the lock, but a guessable id should not be what tests them.
        const sessionId = 'cs_' + randomUUID()
        const expiresAt = new Date(Date.now() + 10 * 60_000)
        const session: ConsentSession = {
          sessionId,
          journeyId: b.journeyId,
          userId,
          cartMandate: b.cartMandate as CartMandate,
          paymentMethodRef: b.paymentMethodRef,
          status: 'PENDING',
          expiresAt: expiresAt.toISOString(),
          // Pruned long after the decision window closes, not with it: the session holds the signed
          // cart the user approved, which the Explorer and a dispute both read afterwards.
          ttl: Math.floor(expiresAt.getTime() / 1000) + 30 * 24 * 60 * 60,
        }

        // Create-only: an id that somehow already exists is a collision, never a reopening.
        if (!(await c.consent.createSession(session))) {
          throw new HttpError(409, 'consent session already exists')
        }
        return ok({ sessionId, expiresAt: session.expiresAt })
      }

      case 'get_consent_session': {
        // Server-to-server only: returns the COMPLETE session, signed cart included, so a channel
        // adapter can seal an approval to the authoritative cart rather than to a client-supplied one.
        const b = v.parseRequest(body, { sessionId: v.identifier() })
        const s = await requireOwnedSession(c, body, b.sessionId)
        return ok(s)
      }

      case 'poll_consent_status': {
        const b = v.parseRequest(body, { sessionId: v.identifier() })
        const s = await requireOwnedSession(c, body, b.sessionId)
        // Returns the merchant's Cart Mandate plus both signed mandates, which is everything the
        // caller needs to drive CP → Merchant → MPP.
        const paymentMandate = s.paymentMandateId
          ? await c.consent.getMandate(s.paymentMandateId)
          : undefined
        const checkoutMandate = s.checkoutMandateId
          ? await c.consent.getCheckoutMandate(s.checkoutMandateId)
          : undefined

        return ok({
          status: s.status,
          paymentMandateId: s.paymentMandateId,
          checkoutMandateId: s.checkoutMandateId,
          cartMandate: s.cartMandate,
          checkoutMandate,
          paymentMandate,
        })
      }

      case 'get_mandate': {
        // Reached through the session that owns it, never by bare id. A mandate id is not a
        // capability: fetching one by id let any caller who could reach this function read any
        // user's signed mandate, and IAM here is granted at the function, not the object.
        const b = v.parseRequest(body, {
          sessionId: v.identifier(),
          mandateId: v.identifier(),
        })
        const s = await requireOwnedSession(c, body, b.sessionId)
        if (b.mandateId !== s.paymentMandateId && b.mandateId !== s.checkoutMandateId) {
          throw new HttpError(404, 'mandate not found for this session')
        }
        return ok(await c.consent.getMandate(b.mandateId))
      }

      default:
        throw new HttpError(400, `unknown op: ${String(body.op)}`)
    }
  })

/**
 * The session, if it exists **and** belongs to the caller the identity token names.
 *
 * Ownership was resolved only when the session was created; every read after that took the session
 * id as sufficient. It is not: the id travels through the agent, the browser and the logs, and the
 * session carries the cart, the amount and the signed mandates. The agent's IAM grant is for this
 * whole function, so an authorization check on the *object* is the only thing standing between one
 * caller and another's purchase.
 *
 * There is no fallback for a session with no owner. Sessions live minutes, so the only records
 * without one are from before this check existed, and refusing them costs a single deploy window.
 *
 * A caller who does not own the session gets the same 404 as one who named a session that does not
 * exist. The distinction is not theirs to learn: telling them apart turns this into an oracle for
 * which session ids are real.
 */
async function requireOwnedSession(
  c: ReturnType<typeof ctx>,
  body: Parameters<typeof requireCallerSub>[0],
  sessionId: string | undefined,
): Promise<ConsentSession> {
  if (!sessionId) throw new HttpError(400, 'sessionId is required')
  const sub = await requireCallerSub(body, 'consent')
  const s = await c.consent.getSession(sessionId)
  if (!s || !s.userId || s.userId !== sub) {
    throw new HttpError(404, 'consent session not found')
  }
  return s
}
