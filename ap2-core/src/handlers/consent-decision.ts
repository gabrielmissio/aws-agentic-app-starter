import { randomUUID } from 'node:crypto'
import { consent, type ConsentProof, type ConsentSession } from '../domain'
import { ctx } from '../context'
import { handle, HttpError, ok, type LambdaEvent } from '../http'
import * as v from '../validate'
import { requireCallerSub } from './require-identity'

/**
 * How long a claim on a session is honored before another attempt may take it over.
 *
 * Sized against the work it covers — two KMS signatures and their evidence writes — with enough
 * headroom that a slow-but-live attempt is never overtaken. Too short duplicates the very signature
 * the claim exists to make once; too long only delays recovery from a process that died, which the
 * caller experiences as a refusal rather than as a double charge.
 */
const CLAIM_LEASE_SECONDS = 120

/**
 * Mandate Authority Lambda — **the only code in this system that can sign on the user's behalf**.
 *
 * It exists as a function of its own, separate from `consent-mandates`, to satisfy a normative
 * requirement rather than for tidiness. AP2
 * [Agent Authorization §Trusted Agent Provider](https://ap2-protocol.org/ap2/agent_authorization/):
 *
 * > *"The Agent Provider MUST ensure that the Agent is not able to access the Agent Provider signing
 * > key, **or use it without the Trusted Surface**."*
 *
 * A Lambda Function URL authorizes with IAM at the *function* granularity — it cannot scope a
 * principal to one operation. So were `submit_consent_decision` to live alongside the session
 * operations the agent legitimately calls, any principal able to open a consent session would also
 * be able, at the IAM layer, to have mandates signed. An agent toolset that merely does not expose
 * the operation is not a boundary the specification accepts: *"All LLMs and Agents MUST be
 * considered potential attackers."*
 *
 * Splitting the operation onto its own function makes the boundary structural:
 *
 * - **This** function is the only one granted `kms:Sign` on the Consent key.
 * - Its Function URL is granted to the checkout Lambda alone — the Trusted Surface that ran the
 *   step-up. The agent's execution role holds no invoke permission on it.
 * - `consent-mandates` keeps the session and read operations and holds **no signing key at all**, so
 *   full control of it still mints nothing.
 *
 * The decision itself is once-only and time-bounded, checked here rather than in the session
 * function, because this is the operation that turns an approval into signed artifacts.
 */
export const handler = (event: LambdaEvent) =>
  handle('consent', event, async ({ body, log }) => {
    if (body.op !== 'submit_consent_decision') {
      throw new HttpError(400, `unknown op: ${String(body.op)}`)
    }

    // The proof is the one nested structure worth describing: it is not signed when it arrives — it
    // is what *gets* signed, into both mandates — so nothing downstream would reject a malformed one.
    const b = v.parseRequest(body, {
      sessionId: v.identifier(),
      approved: v.flag(),
      consentProof: v.optional(
        v.group({
          // The channel is a closed set, and it is signed into `risk_data` on both mandates — an
          // unrecognized value would end up in an artifact a verifier reads as authoritative.
          channel: v.oneOf(['WEB', 'WHATSAPP_FLOW'] as const),
          approved_at: v.text({ max: 40 }),
          cart_canonical_hash: v.text({ max: 128 }),
          session_token_hash: v.optional(v.text({ max: 128 })),
          step_up: v.optional(
            v.group({
              method: v.text({ max: 32 }),
              verified: v.flag(),
              ref: v.optional(v.text({ max: 128 })),
            }),
          ),
        }),
      ),
    })

    const c = ctx()
    const s: ConsentSession | undefined = await c.consent.getSession(b.sessionId)
    if (!s) throw new HttpError(404, 'consent session not found')

    // The decision is for the session's own owner. IAM already restricts this function to the
    // checkout Lambda, and the checkout Lambda already refuses an intent it did not open — this is
    // the third lock, on the entity that actually signs. A trusted surface that signs whatever a
    // trusted caller names is one bug in that caller away from signing for the wrong person.
    const sub = await requireCallerSub(body, 'consent')
    if (!s.userId || s.userId !== sub) {
      throw new HttpError(404, 'consent session not found')
    }

    // Read-side answers, for the common case where nothing is racing: a resolved session gets a
    // clear 409 rather than a claim failure, and an expired one is refused before any lock is taken.
    // Neither is the guarantee — the conditional transitions below are — but both keep the ordinary
    // refusals legible.
    if (s.status === 'APPROVED' || s.status === 'REJECTED') {
      throw new HttpError(409, `consent session is already ${s.status}`, 'SESSION_RESOLVED')
    }
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      throw new HttpError(410, 'consent session has expired', 'SESSION_EXPIRED')
    }

    if (!b.approved) {
      // Conditional on PENDING, so a rejection cannot overwrite an approval that landed first.
      if (!(await c.consent.rejectSession(b.sessionId))) {
        throw new HttpError(409, 'consent session is no longer pending', 'SESSION_RESOLVED')
      }
      return ok({ status: 'REJECTED' })
    }
    if (!b.consentProof) throw new HttpError(400, 'consentProof is required to approve')

    // ── The claim ────────────────────────────────────────────────────────
    // Everything above is a read. This is the line that makes approval once-only: the transition to
    // PROCESSING is a conditional write, so of two confirmations arriving together exactly one gets
    // here and the other is refused. Signing before taking it — reading PENDING and trusting it —
    // is what let one cart carry two mandate pairs, two credentials and two PSP authorizations.
    const opId = randomUUID()
    const claimed = await c.consent.claimSessionForDecision(
      b.sessionId,
      opId,
      CLAIM_LEASE_SECONDS,
    )
    if (!claimed) {
      throw new HttpError(
        409,
        'another confirmation is already being processed for this session',
        'SESSION_IN_PROGRESS',
      )
    }

    // The claimed record, not the earlier read: it is the state the conditional write returned, so
    // the cart being signed is the one the session held at the instant this attempt won it.
    let emitted
    try {
      // AP2 flows: the trusted surface signs BOTH mandates in the same approval.
      emitted = await consent.emitMandates(
        c.signer,
        c.evidence,
        c.consent,
        claimed.journeyId,
        claimed.cartMandate,
        claimed.paymentMethodRef,
        b.consentProof as ConsentProof,
      )
    } catch (err) {
      // Nothing usable was produced, so hand the claim back rather than making the caller wait out
      // the lease. A tampered cart fails again immediately; a transient fault gets a clean retry.
      await c.consent.releaseSessionClaim(b.sessionId, opId)
      throw err
    }

    const { paymentMandateId, checkoutMandateId } = emitted
    const finalized = await c.consent.approveClaimedSession(b.sessionId, opId, {
      paymentMandateId,
      checkoutMandateId,
    })

    if (!finalized) {
      // The lease lapsed mid-signature and another attempt took the session over. These mandates are
      // signed and real, but they are not what the session points at — returning them would hand the
      // caller artifacts the rest of the chain will not recognize as canonical. Record them, because
      // signed artifacts that exist and are not canonical are exactly what a dispute needs to see.
      await c.evidence.record({
        journeyId: claimed.journeyId,
        entity: 'consent',
        type: 'MANDATES_ORPHANED',
        artifactId: paymentMandateId,
        verified: null,
        note: `claim ${opId} lapsed before it could finalize; another attempt owns this session`,
      })
      log.warn('consent claim lapsed before finalization', {
        sessionId: b.sessionId,
        opId,
        paymentMandateId,
        checkoutMandateId,
      })
      throw new HttpError(409, 'consent session is no longer pending', 'SESSION_RESOLVED')
    }

    return ok({ status: 'APPROVED', paymentMandateId, checkoutMandateId })
  })
