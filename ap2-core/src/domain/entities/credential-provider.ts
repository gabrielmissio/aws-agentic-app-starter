import { randomUUID } from 'node:crypto'
import { BlockedError } from '../sign'
import {
  cartHash,
  checkoutJwtHash,
  credentialHash,
  issueCredential as issueCredentialJws,
  paymentMandateHash,
  verifyCartMandate,
  verifyCredential,
  verifyPaymentMandate,
} from '../mandates'
import { hashCanonicalB64url } from '../jws'
import type { CredentialRepo, EvidenceSink, NonceRepo, RegisteredMethod, Signer } from '../ports'
import {
  centsFromAmount,
  type CartMandate,
  type PaymentCredential,
  type PaymentCredentialContents,
  type PaymentMandate,
} from '../types'

/** What the CP hands the MPP at redeem time. This is the only path PSP data ever travels. */
export interface RedeemInstruction {
  valid: true
  action: 'AUTHORIZE'
  amountCents: number
  currency: string
  pspCustomerRef: string
  pspPaymentMethodRef: string
  /**
   * The user-signed Payment Mandate the CP verified at issuance. The MPP re-verifies it after the
   * redeem, which is how the mandate reaches the MPP without ever transiting the Merchant.
   */
  paymentMandate: PaymentMandate
}

/**
 * Lists a user's payment methods as opaque references.
 *
 * `autoProvision` mints a sandbox method for a user who has none, so a first-time demo user is not
 * stuck at checkout with nothing to pay with. It is idempotent — `makeSandboxMethod` uses a fixed
 * partition key, so a concurrent first listing just rewrites the same item. The flag is injected by
 * the caller rather than read from the environment here, which keeps the domain free of config.
 */
export async function listPaymentMethods(
  repo: CredentialRepo,
  userId: string,
  autoProvision = false,
) {
  let methods = await repo.listMethods(userId)
  if (methods.length === 0 && autoProvision) {
    await repo.putMethod(makeSandboxMethod(userId))
    methods = await repo.listMethods(userId)
  }
  return methods.map((m) => ({ paymentMethodRef: m.paymentMethodRef, displayName: m.displayName }))
}

/**
 * The stable key an issuance is idempotent under: **every input of the request**, not just the
 * mandate.
 *
 * Keying on the mandate alone would be wrong in a way that is easy to miss. Idempotency answers
 * "this exact call, again"; a mandate re-presented alongside a different cart, method or journey is
 * not that call. Under the narrow key such a request would be handed the credential from the
 * original one — a refusal quietly turned into a success, and an audit trail that records a replay
 * where it should record a block. Under this key it derives a different key, misses, and meets the
 * consumed `jti` exactly as it did before idempotency existed.
 *
 * The payer is in the key for the same reason: it comes from the identity token, so two users
 * presenting the same mandate can never collide on it.
 */
function issuanceKeyFor(args: {
  journeyId: string
  userId: string
  cartMandate: CartMandate
  paymentMandate: PaymentMandate
  paymentMethodRef: string
  targetMpp: string
}): string {
  return hashCanonicalB64url({
    journeyId: args.journeyId,
    payerRef: args.userId,
    cartHash: cartHash(args.cartMandate),
    paymentMandateHash: paymentMandateHash(args.paymentMandate),
    paymentMethodRef: args.paymentMethodRef,
    targetMpp: args.targetMpp,
  })
}

/**
 * Issues an opaque, scoped, single-use Payment Credential.
 *
 * The CP is the second independent verifier in the chain: it re-checks both signatures (merchant and
 * consent), the hash linkage between them, the amount, the user's ownership of the method and the
 * target MPP. Nothing here is taken on the agent's word.
 */
export async function issueCredential(
  repo: CredentialRepo,
  signer: Signer,
  evidence: EvidenceSink,
  nonces: NonceRepo,
  args: {
    journeyId: string
    userId: string
    cartMandate: CartMandate
    paymentMandate: PaymentMandate
    paymentMethodRef: string
    targetMpp: string
    expiresInSec?: number
    allowedMpps: string[]
  },
): Promise<PaymentCredential> {
  const { journeyId, userId, cartMandate, paymentMandate, paymentMethodRef, targetMpp } = args

  // 0. Idempotent issuance.
  //
  //    A checkout that timed out after this step asks for the same credential again. Without this
  //    the retry reaches the anti-replay check below, finds the mandate's `jti` already consumed by
  //    the CP, and is refused as a replay — a *successful* step reported as an attack, with the
  //    payment either stranded or attempted twice by a user who was told it failed.
  //
  //    The key covers every input, so only a byte-identical repeat of a call the CP already answered
  //    reaches this branch — see `issuanceKeyFor`. Anything else, including the same mandate paired
  //    with a different cart, misses and is judged on its merits below. Replaying therefore needs no
  //    re-verification: the artifacts are the ones this CP verified when it minted the credential it
  //    is handing back.
  const issuanceKey = issuanceKeyFor({
    journeyId,
    userId,
    cartMandate,
    paymentMandate,
    paymentMethodRef,
    targetMpp,
  })
  const already = await repo.getCredentialByIssuanceKey(issuanceKey)
  if (
    already &&
    already.status === 'ISSUED' &&
    new Date(already.contents.expires_at).getTime() > Date.now()
  ) {
    const replayed: PaymentCredential = {
      contents: already.contents,
      cp_authorization: already.cpAuthorization,
    }
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'PAYMENT_CREDENTIAL_REPLAYED',
      artifactId: already.contents.credential_id,
      payloadHash: credentialHash(replayed),
      signedBy: 'cp',
      verified: true,
      expiresAt: already.contents.expires_at,
      note: 'idempotent retry — returned the credential already issued for this Payment Mandate',
    })
    return replayed
  }
  // A credential that is REDEEMED or expired deliberately falls through to the normal path, where
  // the anti-replay check refuses it. Re-issuing over a spent credential is a double spend, and
  // re-issuing over an expired one needs a fresh mandate, since the mandate expires with it.

  // 1. Both signatures, with their claim expectations.
  const cartV = await verifyCartMandate(signer, cartMandate, 'cp')
  await evidence.record({
    journeyId,
    entity: 'cp',
    type: 'VERIFY_CART_MANDATE',
    payloadHash: cartV.hash,
    signedBy: 'merchant',
    verified: cartV.ok,
    note: cartV.reason,
  })

  const pmV = await verifyPaymentMandate(signer, paymentMandate, 'cp')
  await evidence.record({
    journeyId,
    entity: 'cp',
    type: 'VERIFY_PAYMENT_MANDATE',
    payloadHash: pmV.hash,
    signedBy: 'consent',
    verified: pmV.ok,
    note: pmV.reason,
  })

  if (!cartV.ok || !pmV.ok) {
    const reason = !cartV.ok ? `CART_MANDATE: ${cartV.reason}` : `PAYMENT_MANDATE: ${pmV.reason}`
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_INVALID_MANDATE',
      verified: false,
      note: reason,
    })
    throw new BlockedError('INVALID_MANDATE', `invalid mandate: ${reason}`)
  }

  // 2. Linkage: this Payment Mandate must authorize THIS cart's checkout token.
  if (pmV.checkoutHash !== checkoutJwtHash(cartMandate)) {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_OUT_OF_SCOPE',
      verified: false,
      note: 'Payment Mandate does not chain to this Cart Mandate (checkout_jwt hash mismatch)',
    })
    throw new BlockedError('OUT_OF_SCOPE', 'Payment Mandate does not chain to the Cart Mandate')
  }

  // 3. Scope: amount, the user's own method, and an authorized MPP.
  const cartTotal = cartMandate.contents.payment_request.details.total.amount
  // The verified spec `payment_amount` comes back from the verifier, never read from cleartext.
  const pmAmount = pmV.payment_amount
  const method = await repo.getMethod(userId, paymentMethodRef)
  const reasons: string[] = []

  if (!method || method.status !== 'ACTIVE') reasons.push('payment method is missing or inactive')
  // Integer comparison — the mandate is already minor units, so there is no float round-trip.
  if (pmAmount?.amount !== centsFromAmount(cartTotal)) {
    reasons.push('Payment Mandate amount differs from the Cart Mandate total')
  }
  if (!args.allowedMpps.includes(targetMpp)) reasons.push(`MPP '${targetMpp}' is not authorized`)

  if (reasons.length > 0) {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_OUT_OF_SCOPE',
      verified: false,
      note: reasons.join('; '),
    })
    throw new BlockedError('OUT_OF_SCOPE', `out of scope: ${reasons.join('; ')}`)
  }

  // 4. Anti-replay, scoped to this verifier. The same mandate legitimately continues to the MPP;
  //    only a second presentation to the CP is a replay.
  const replayOk = pmV.jti
    ? await nonces.consumeJti('cp', pmV.jti, pmV.expUnix ?? Math.floor(Date.now() / 1000) + 3600)
    : false
  if (!replayOk) {
    const note = pmV.jti
      ? `Payment Mandate jti ${pmV.jti} was already consumed by the CP`
      : 'Payment Mandate carries no jti'
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_REPLAY',
      verified: false,
      note,
    })
    throw new BlockedError('REPLAYED', `replay blocked: ${note}`)
  }

  // 5. Issue the scoped, single-use credential.
  const expiresInSec = args.expiresInSec ?? 300
  const contents: PaymentCredentialContents = {
    credential_id: 'pc_' + randomUUID().slice(0, 8),
    journey_id: journeyId,
    cart_hash: cartV.hash,
    payment_mandate_hash: paymentMandateHash(paymentMandate),
    payment_method_ref: paymentMethodRef,
    merchant_id: cartMandate.contents.merchant.id,
    amount: { amount: centsFromAmount(cartTotal), currency: cartTotal.currency },
    authorized_mpp: targetMpp,
    single_use: true,
    expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    created_at: new Date().toISOString(),
  }

  const credential = await issueCredentialJws(signer, contents)
  // Persist the verified Payment Mandate with the credential so the MPP can re-verify it at redeem
  // instead of receiving it through the Merchant.
  // `payerRef` is stored, never signed into the contents: the credential reaches the Merchant, and
  // this is the binding redeem needs to resolve the instrument in the right partition.
  await repo.putCredential({
    contents,
    status: 'ISSUED',
    paymentMandate,
    payerRef: userId,
    issuanceKey,
    // Stored as signed, so a retry replays this exact authorization rather than paying for a second
    // KMS signature over the same contents.
    cpAuthorization: credential.cp_authorization,
  })
  await evidence.record({
    journeyId,
    entity: 'cp',
    type: 'PAYMENT_CREDENTIAL_ISSUED',
    artifactId: contents.credential_id,
    payloadHash: credentialHash(credential),
    signedBy: 'cp',
    verified: null,
    expiresAt: contents.expires_at,
    note: `scope ${(centsFromAmount(cartTotal) / 100).toFixed(2)} · settles via ${targetMpp} · single-use`,
  })

  return credential
}

/**
 * Redeems a credential — only the authorized MPP may call this.
 *
 * Blocks an invalid signature, an expired credential, the wrong MPP, and a double spend. The
 * `ISSUED → REDEEMED` transition is atomic, which is what makes single-use a real guarantee rather
 * than a race.
 *
 * The instrument is then resolved under the stored `payerRef`, so the PSP references released here
 * always belong to the user whose ownership the CP verified at issuance.
 */
export async function redeem(
  repo: CredentialRepo,
  signer: Signer,
  evidence: EvidenceSink,
  journeyId: string,
  credential: PaymentCredential,
  callingMpp: string,
): Promise<RedeemInstruction> {
  const v = await verifyCredential(signer, credential, 'cp')
  await evidence.record({
    journeyId,
    entity: 'cp',
    type: 'VERIFY_PAYMENT_CREDENTIAL',
    payloadHash: v.hash,
    signedBy: 'cp',
    verified: v.ok,
    note: v.reason,
  })
  if (!v.ok) throw new BlockedError('INVALID_CREDENTIAL', `invalid credential: ${v.reason}`)

  const id = credential.contents.credential_id
  const stored = await repo.getCredential(id)
  if (!stored) throw new BlockedError('UNKNOWN_CREDENTIAL', `credential ${id} is unknown`)

  if (new Date(credential.contents.expires_at).getTime() < Date.now()) {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_EXPIRED',
      artifactId: id,
      verified: false,
      note: `expired at ${credential.contents.expires_at}`,
    })
    throw new BlockedError('EXPIRED', `credential ${id} has expired`)
  }

  if (credential.contents.authorized_mpp !== callingMpp) {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_OUT_OF_SCOPE',
      artifactId: id,
      verified: false,
      note: `MPP '${callingMpp}' is not the authorized '${credential.contents.authorized_mpp}'`,
    })
    throw new BlockedError('OUT_OF_SCOPE', 'this MPP is not authorized for this credential')
  }

  const firstUse = await repo.markRedeemed(id)
  if (!firstUse) {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_DOUBLE_SPEND',
      artifactId: id,
      verified: false,
      note: 'credential was already redeemed (single-use)',
    })
    throw new BlockedError('DOUBLE_SPEND', `credential ${id} has already been redeemed`)
  }

  // The instrument is resolved inside the payer's own partition, from the binding the CP recorded at
  // issuance. `payment_method_ref` alone is not unique across users — every sandbox user gets
  // `pm_visa_1234` — so a global lookup would resolve to whichever row the table returned first and
  // release a stranger's PSP references to the processor.
  // A credential stored before the payer binding existed carries no `payerRef`. Refuse it rather
  // than falling back to a global lookup — credentials expire in minutes, so the only window this
  // affects is a deploy, and failing closed there is the whole point of the binding.
  if (!stored.payerRef) {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_OUT_OF_SCOPE',
      artifactId: id,
      verified: false,
      note: 'the stored credential carries no payer binding',
    })
    throw new BlockedError('UNKNOWN_METHOD', 'the credential carries no payer binding')
  }

  const method = await repo.getMethod(stored.payerRef, credential.contents.payment_method_ref)
  if (!method || method.status !== 'ACTIVE') {
    await evidence.record({
      journeyId,
      entity: 'cp',
      type: 'BLOCKED_OUT_OF_SCOPE',
      artifactId: id,
      verified: false,
      note: `payment method '${credential.contents.payment_method_ref}' is not an active method of the credential's payer`,
    })
    throw new BlockedError(
      'UNKNOWN_METHOD',
      'the credential does not resolve to an active payment method of its payer',
    )
  }

  await evidence.record({
    journeyId,
    entity: 'cp',
    type: 'PAYMENT_CREDENTIAL_REDEEMED',
    artifactId: id,
    verified: true,
    note: `released to ${callingMpp}`,
  })

  return {
    valid: true,
    action: 'AUTHORIZE',
    amountCents: credential.contents.amount.amount,
    currency: credential.contents.amount.currency,
    pspCustomerRef: method.pspCustomerRef,
    pspPaymentMethodRef: method.pspPaymentMethodRef,
    paymentMandate: stored.paymentMandate,
  }
}

/** A sandbox payment method. The PSP references are fake — nothing here reaches a real processor. */
export function makeSandboxMethod(userId: string): RegisteredMethod {
  return {
    userId,
    paymentMethodRef: 'pm_visa_1234',
    displayName: 'Visa ending 1234',
    pspCustomerRef: 'cus_sandbox_' + randomUUID().slice(0, 6),
    pspPaymentMethodRef: 'pm_sandbox_' + randomUUID().slice(0, 6),
    status: 'ACTIVE',
  }
}
