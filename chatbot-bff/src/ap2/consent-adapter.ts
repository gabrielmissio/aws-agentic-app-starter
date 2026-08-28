import { consent as consentDomain } from 'ap2-core/domain'
import type { CartMandate, CheckoutMandate, PaymentMandate, StepUpMethod } from 'ap2-core/domain'
import type { EntityClient } from 'ap2-core/client'

/**
 * The **web channel adapter** — where a browser approval becomes an AP2 consent proof.
 *
 * This is the whole of what is channel-specific about the web flow. It turns whatever this channel
 * used to establish presence into the protocol's channel-agnostic `ConsentProof`, then calls the
 * Mandate Authority's single decision boundary to sign both mandates.
 *
 * Two risk-based variants share that one boundary: with `otpRef`, a step-up attestation is embedded
 * in the proof (the code itself never reaches the core, only a non-reversible reference to it);
 * without it, the proof records a confirm-only approval, leaving `risk_data.step_up_method` null so
 * the audit trail shows how the user actually authorized rather than implying a step-up happened.
 *
 * A second channel — a messaging flow, a voice assistant — is the symmetric mirror of this file:
 * build its own proof, call the same `submit_consent_decision`, change nothing in the core.
 */
export async function approveViaWeb(
  client: EntityClient,
  args: { sessionId: string; cartHash: string; otpRef?: string; stepUpMethod?: StepUpMethod },
): Promise<{
  cartMandate: CartMandate
  checkoutMandate: CheckoutMandate
  paymentMandate: PaymentMandate
}> {
  const consentProof = args.otpRef
    ? consentDomain.buildWebOtpConsentProof(
        args.cartHash,
        args.sessionId,
        args.otpRef,
        args.stepUpMethod ?? 'OTP_SMS',
      )
    : consentDomain.buildWebConfirmConsentProof(args.cartHash, args.sessionId)

  // The decision is once-only at the Mandate Authority: a session that is already APPROVED refuses a
  // second submit rather than minting another mandate pair. That makes a *settle retry* — the chain
  // refused, the user taps confirm again — land here as a failure even though the approval itself
  // succeeded the first time. So a rejected submit is not conclusive on its own: poll, and if the
  // mandates from that first approval are there, carry on with them.
  //
  // Re-settling with them is safe and is the designed behaviour: the credential is single-use and
  // the MPP keys idempotency on the journey, so a retry replays the terminal receipt rather than
  // charging twice.
  let submitError: unknown
  try {
    const decision = await client.submitConsentDecision({
      sessionId: args.sessionId,
      approved: true,
      consentProof,
    })
    if (decision.status !== 'APPROVED') {
      submitError = new Error(
        `the consent surface did not approve the checkout (status ${decision.status})`,
      )
    }
  } catch (err) {
    submitError = err
  }

  const polled = await client.pollConsentStatus(args.sessionId)
  if (!polled.cartMandate || !polled.checkoutMandate || !polled.paymentMandate) {
    // No mandates to fall back on, so the submit failure was real — surface it, not a confusing
    // "mandates unavailable" that hides why.
    throw submitError ?? new Error('the signed mandates were not available after approval')
  }

  return {
    cartMandate: polled.cartMandate,
    checkoutMandate: polled.checkoutMandate,
    paymentMandate: polled.paymentMandate,
  }
}
