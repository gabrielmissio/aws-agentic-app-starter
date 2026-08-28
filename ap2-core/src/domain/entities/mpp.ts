import { randomUUID } from 'node:crypto'
import { BlockedError } from '../sign'
import {
  credentialHash,
  issueReceipt,
  paymentMandateHash,
  receiptHash,
  verifyCheckoutMandate,
  verifyCredential,
  verifyPaymentMandate,
} from '../mandates'
import type { EvidenceSink, MppRepo, NonceRepo, PspGateway, Signer } from '../ports'
import {
  toAp2ErrorCode,
  type CheckoutMandate,
  type PaymentCredential,
  type PaymentReceipt,
  type PaymentReceiptContents,
  type ReceiptStatus,
} from '../types'
import type { RedeemInstruction } from './credential-provider'

export const MPP_ID = 'mpp-sandbox-001'

/**
 * How long a reserved idempotency key is honored before another attempt may take it over.
 *
 * It has to outlast the slowest legitimate settlement — redeem at the CP, then the PSP — because a
 * takeover while the first attempt is still live is the double charge this reservation exists to
 * prevent. Erring long only delays recovery from a process that died, and that delay surfaces as a
 * refusal, which is the safe side to fail on.
 */
const KEY_LEASE_SECONDS = 300

export interface PaymentInput {
  journeyId: string
  /** The user-signed Checkout Mandate — verified by the Merchant and re-verified here. */
  checkoutMandate: CheckoutMandate
  /**
   * The spec's "token + checkout_jwt hash": the Merchant forwards only this hash, never the Cart or
   * Payment Mandate. It pins which checkout is being settled; the Payment Mandate arrives from the
   * CP at redeem time.
   */
  checkoutJwtHash: string
  credential: PaymentCredential
  /**
   * A retry with the SAME key replays the already-issued terminal receipt with no second redeem or
   * charge. Reusing the *credential* under a NEW key still fails as `DOUBLE_SPEND` at the atomic
   * redeem — the two mechanisms guard different mistakes. Callers default this to `journeyId`.
   */
  idempotencyKey?: string
}

/** The MPP redeems the credential at the CP. Injected: in-process locally, SigV4 HTTP in Lambda. */
export type RedeemFn = (
  credential: PaymentCredential,
  callingMpp: string,
) => Promise<RedeemInstruction>

/**
 * Merchant Payment Processor — the last and most thorough verifier.
 *
 * It re-checks every signature and every hash link before money moves, redeems the credential at the
 * CP, calls the PSP, and signs the Payment Receipt.
 *
 * Two properties are worth stating explicitly:
 *
 * - **Fail-closed.** The post-redeem checks run *before* the PSP call, so a chain that turns out to
 *   be inconsistent burns the single-use credential but never charges anyone.
 * - **Every terminal outcome is a signed receipt.** Success, a PSP decline, and a verification block
 *   all produce one. The block's receipt rides back on `BlockedError.receipt`, so a rejection is as
 *   auditable as a payment.
 */
export async function initiatePayment(
  signer: Signer,
  evidence: EvidenceSink,
  redeem: RedeemFn,
  psp: PspGateway,
  repo: MppRepo,
  nonces: NonceRepo,
  input: PaymentInput,
): Promise<PaymentReceipt> {
  const { journeyId, checkoutMandate, credential } = input
  const checkoutJwtHashValue = input.checkoutJwtHash
  const idempotencyKey = input.idempotencyKey ?? journeyId
  const paymentAttemptId = 'pay_' + randomUUID().slice(0, 8)

  // The spec `reference` is the hash of the Payment Mandate this receipt answers. Before the redeem
  // the MPP only holds the checkout_jwt hash, so an early rejection references that instead.
  let reference = checkoutJwtHashValue

  const buildReceipt = (
    over: Partial<PaymentReceiptContents> & { status: ReceiptStatus },
  ): PaymentReceiptContents => ({
    iss: 'mpp',
    iat: Math.floor(Date.now() / 1000),
    reference,
    payment_id: paymentAttemptId,
    receipt_id: 'rcpt_' + randomUUID().slice(0, 8),
    journey_id: journeyId,
    cart_hash: credential.contents.cart_hash,
    payment_credential_hash: credentialHash(credential),
    created_at: new Date().toISOString(),
    ...over,
  })

  // 0. Idempotency, taken BEFORE anything happens rather than written after everything did.
  //
  //    The key covers the redeem and the PSP call, which is the window that mattered: probing it
  //    read-only let two concurrent attempts both find it free, both burn a credential and both
  //    charge, and only then did one of them lose the write — a receipt race recorded after the
  //    money had already moved twice. Reserving first turns that into a refusal before the first
  //    side effect.
  const held = await repo.reserveIdempotencyKey(idempotencyKey, paymentAttemptId, KEY_LEASE_SECONDS)
  if (held?.state === 'DONE') {
    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'PAYMENT_RECEIPT_REPLAYED',
      artifactId: held.receipt.contents.receipt_id,
      payloadHash: receiptHash(held.receipt),
      signedBy: 'mpp',
      verified: true,
      note: `idempotent retry (key=${idempotencyKey}) — replayed the existing receipt`,
    })
    return held.receipt
  }
  if (held?.state === 'IN_PROGRESS') {
    // Another attempt holds the key and may be inside the PSP call right now. Nobody can say yet
    // what it produced, so the only answer that cannot duplicate a charge is "not you, not now".
    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'BLOCKED_IN_PROGRESS',
      verified: false,
      note: `idempotency key ${idempotencyKey} is held by an attempt still running`,
    })
    throw new BlockedError(
      'IN_PROGRESS',
      `a payment for idempotency key ${idempotencyKey} is already in progress`,
    )
  }

  try {
    // 1. Signatures on what the MPP actually receives: the Checkout Mandate and the credential.
    //    The Payment Mandate is not here — it arrives from the CP at step 3.
    const ckV = await verifyCheckoutMandate(signer, checkoutMandate, 'mpp')
    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'VERIFY_CHECKOUT_MANDATE',
      payloadHash: ckV.hash,
      signedBy: 'consent',
      verified: ckV.ok,
      note: ckV.reason,
    })

    const credV = await verifyCredential(signer, credential, 'mpp')
    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'VERIFY_PAYMENT_CREDENTIAL',
      payloadHash: credV.hash,
      signedBy: 'cp',
      verified: credV.ok,
      note: credV.reason,
    })

    if (!ckV.ok || !credV.ok) {
      const bad = !ckV.ok
        ? `CHECKOUT_MANDATE: ${ckV.reason}`
        : `PAYMENT_CREDENTIAL: ${credV.reason}`
      await evidence.record({
        journeyId,
        entity: 'mpp',
        type: 'BLOCKED_TAMPERED_CART',
        verified: false,
        note: bad,
      })
      throw new BlockedError('TAMPERED', `artifact failed verification: ${bad}`)
    }

    // 2. Pre-redeem linkage: the Checkout Mandate must authorize the checkout the Merchant named.
    if (ckV.checkoutHash !== checkoutJwtHashValue) {
      await evidence.record({
        journeyId,
        entity: 'mpp',
        type: 'BLOCKED_TAMPERED_CART',
        verified: false,
        note: 'Checkout Mandate does not authorize this checkout_jwt (hash mismatch)',
      })
      throw new BlockedError(
        'TAMPERED',
        'Checkout Mandate does not authorize this checkout_jwt (hash mismatch)',
      )
    }

    // 3. Redeem at the CP. The CP returns the Payment Mandate it verified at issuance.
    const instruction = await redeem(credential, MPP_ID)
    const paymentMandate = instruction.paymentMandate
    // From here on the receipt references the Payment Mandate itself.
    reference = paymentMandateHash(paymentMandate)

    // 4. Verify the CP-returned Payment Mandate: the user's signature, its vct, and its audience.
    const pmV = await verifyPaymentMandate(signer, paymentMandate, 'mpp')
    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'VERIFY_PAYMENT_MANDATE',
      payloadHash: pmV.hash,
      signedBy: 'consent',
      verified: pmV.ok,
      note: pmV.reason,
    })

    // 5. Post-redeem linkage, before the PSP: the credential was burned at step 3, so failing here
    //    costs the credential but never charges (fail-closed).
    const chainErrors: string[] = []
    if (!pmV.ok) chainErrors.push(`PAYMENT_MANDATE: ${pmV.reason}`)
    if (pmV.checkoutHash !== checkoutJwtHashValue) {
      chainErrors.push('Payment Mandate does not authorize this checkout (transaction_id mismatch)')
    }
    if (credential.contents.payment_mandate_hash !== paymentMandateHash(paymentMandate)) {
      chainErrors.push('the credential does not reference this Payment Mandate')
    }
    if (pmV.payment_amount?.amount !== instruction.amountCents) {
      chainErrors.push("Payment Mandate amount differs from the CP's redeem instruction")
    }

    if (chainErrors.length > 0) {
      await evidence.record({
        journeyId,
        entity: 'mpp',
        type: 'BLOCKED_TAMPERED_CART',
        verified: false,
        note: chainErrors.join('; '),
      })
      throw new BlockedError('TAMPERED', `inconsistent chain after redeem: ${chainErrors.join('; ')}`)
    }

    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'VERIFY_CHAIN_LINKAGE',
      verified: true,
      note: 'hash links check out (checkout_jwt → payment mandate ← credential)',
    })

    // 6. Anti-replay in the MPP's own scope.
    const replayOk = pmV.jti
      ? await nonces.consumeJti('mpp', pmV.jti, pmV.expUnix ?? Math.floor(Date.now() / 1000) + 3600)
      : false
    if (!replayOk) {
      const note = pmV.jti
        ? `Payment Mandate jti ${pmV.jti} was already consumed by the MPP`
        : 'Payment Mandate carries no jti'
      await evidence.record({
        journeyId,
        entity: 'mpp',
        type: 'BLOCKED_REPLAY',
        verified: false,
        note,
      })
      throw new BlockedError('REPLAYED', `replay blocked: ${note}`)
    }

    // 7. The PSP, in minor units.
    const pspResult = await psp.authorize({
      amountCents: instruction.amountCents,
      currency: instruction.currency,
      pspCustomerRef: instruction.pspCustomerRef,
      pspPaymentMethodRef: instruction.pspPaymentMethodRef,
      metadata: {
        journeyId,
        cartHash: credential.contents.cart_hash,
        credentialId: credential.contents.credential_id,
      },
    })

    // 8. The signed Payment Receipt. A PSP decline is an `Error` receipt but not a mandate fault, so
    //    it carries a description and no canonical error code. Both outcomes are returned (not
    //    thrown) and stored under the idempotency key.
    const authorized = pspResult.status === 'AUTHORIZED'
    const status: ReceiptStatus = authorized ? 'Success' : 'Error'
    // Only the keys for this outcome are spread in — never set an optional field to `undefined`, so
    // the signed contents stay clean and the receipt marshals cleanly into DynamoDB.
    const contents = buildReceipt({
      status,
      amount: { amount: instruction.amountCents, currency: instruction.currency },
      ...(authorized
        ? { psp_confirmation_id: pspResult.pspReference }
        : { error_description: `the PSP declined the authorization (${pspResult.pspReference})` }),
    })

    const receipt = await issueReceipt(signer, contents)
    await repo.putAttempt({
      paymentId: paymentAttemptId,
      journeyId,
      status,
      receiptId: contents.receipt_id,
    })
    // The boolean says whether this attempt still held the key it reserved. Losing it now means the
    // lease lapsed mid-flight and another attempt took the key over — the charge already happened
    // and this receipt is signed and real, but it is no longer the canonical answer for the key. It
    // must not pass in silence: only the trail can say which receipt a payer was shown.
    const stillOurs = await repo.completeIdempotencyKey(
      idempotencyKey,
      paymentAttemptId,
      receipt,
    )
    if (!stillOurs) {
      await evidence.record({
        journeyId,
        entity: 'mpp',
        type: 'PAYMENT_RECEIPT_RACE',
        artifactId: contents.receipt_id,
        payloadHash: receiptHash(receipt),
        signedBy: 'mpp',
        verified: null,
        note: `the lease on idempotency key ${idempotencyKey} lapsed and another attempt took it over`,
      })
    }
    await evidence.record({
      journeyId,
      entity: 'mpp',
      type: 'PAYMENT_RECEIPT',
      artifactId: contents.receipt_id,
      payloadHash: receiptHash(receipt),
      signedBy: 'mpp',
      verified: null,
      note: `${status} · ${(instruction.amountCents / 100).toFixed(2)} · ${pspResult.pspReference}`,
    })

    return receipt
  } catch (e) {
    // A verification rejection also produces a SIGNED Error receipt, with the canonical code mapped
    // from the block. It is recorded in the trail and attached to the error; the throw is preserved.
    if (e instanceof BlockedError) {
      const contents = buildReceipt({
        status: 'Error',
        error: toAp2ErrorCode(e.code),
        error_description: e.message,
      })
      const errorReceipt = await issueReceipt(signer, contents)
      // A block is a terminal outcome, so it settles the key it reserved. A retry then replays this
      // signed refusal instead of re-entering the chain — which matters most after the redeem, where
      // re-entering would burn a second credential to reach the same answer.
      //
      // A non-`BlockedError` deliberately does NOT settle it: an unexpected fault gives no evidence
      // about whether the PSP was reached, so the reservation is left to stand until its lease
      // lapses. Holding a key too long refuses a payment; releasing one too early repeats it.
      await repo
        .completeIdempotencyKey(idempotencyKey, paymentAttemptId, errorReceipt)
        .catch(() => undefined)
      await evidence.record({
        journeyId,
        entity: 'mpp',
        type: 'PAYMENT_RECEIPT',
        artifactId: contents.receipt_id,
        payloadHash: receiptHash(errorReceipt),
        signedBy: 'mpp',
        verified: false,
        note: `Error · ${contents.error} · ${e.code}`,
      })
      e.receipt = errorReceipt
    }
    throw e
  }
}
