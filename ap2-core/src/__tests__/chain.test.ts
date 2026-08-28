import { describe, expect, it, vi } from 'vitest'
import { LocalSigner } from '../domain/adapters/local-signer'
import {
  MemoryConsentRepo,
  MemoryCredentialRepo,
  MemoryEvidence,
  MemoryMerchantRepo,
  MemoryMppRepo,
  MemoryNonceRepo,
  SimulatedPsp,
} from '../domain/adapters/memory'
import type { PspGateway } from '../domain/ports'
import * as consent from '../domain/entities/consent-mandates'
import * as cp from '../domain/entities/credential-provider'
import { MPP_ID, initiatePayment, type PaymentInput } from '../domain/entities/mpp'
import {
  createMerchantCart,
  initiatePayment as merchantInitiatePayment,
  type MerchantPaymentInput,
} from '../domain/entities/merchant'
import * as merchant from '../domain/entities/merchant'
import {
  cartHash,
  checkoutJwtHash,
  checkoutMandateHash,
  decodeCheckoutMandate,
  decodePaymentMandate,
  issueRawMandate,
  paymentMandateHash,
  verifyCartMandate,
  verifyCheckoutMandate,
  verifyCheckoutReceipt,
  verifyCredential,
  verifyPaymentMandate,
  verifyReceipt,
} from '../domain/mandates'
import { hashCanonicalB64url, signJws } from '../domain/jws'
import { BlockedError } from '../domain/sign'
import {
  AP2_TYPE,
  VCT,
  type Amount,
  type CartMandate,
  type CheckoutMandate,
  type CheckoutReceipt,
  type PaymentCredential,
  type PaymentReceipt,
} from '../domain/types'

/**
 * A mandate is a serialized SD-JWT string, so the meaningful tamper is corrupting the **issuer-JWT
 * signature** (the first `~` segment). Mutating a *disclosure* instead would only make its digest go
 * unmatched and be silently dropped — which is correct SD-JWT behavior, but not a rejection, so it
 * would not exercise the fail-closed path these tests are about.
 */
function tamperSdJwt(sdjwt: string): string {
  const parts = sdjwt.split('~')
  const seg = (parts[0] as string).split('.')
  seg[2] = [...(seg[2] as string)].reverse().join('')
  parts[0] = seg.join('.')
  return parts.join('~')
}

type EmitResult = {
  cart: CartMandate
  checkoutMandate: CheckoutMandate
  credential: PaymentCredential
}

/** The slimmed payload the Merchant forwards: token + checkout_jwt hash, never the mandates. */
function mppInput(
  journeyId: string,
  e: EmitResult,
  extra: Partial<PaymentInput> = {},
): PaymentInput {
  return {
    journeyId,
    checkoutMandate: e.checkoutMandate,
    checkoutJwtHash: checkoutJwtHash(e.cart),
    credential: e.credential,
    ...extra,
  }
}

function merchantInput(
  journeyId: string,
  e: { checkoutMandate: CheckoutMandate; credential: PaymentCredential },
): MerchantPaymentInput {
  return { journeyId, checkoutMandate: e.checkoutMandate, credential: e.credential }
}

/**
 * Awaits a call expected to be blocked and returns the typed error, so the assertions below can read
 * `code` and `receipt` without widening against the success type of the call.
 */
async function expectBlocked<R extends PaymentReceipt | CheckoutReceipt>(
  p: Promise<unknown>,
): Promise<BlockedError & { receipt: R }> {
  const err = await p.then(
    () => {
      throw new Error('expected the call to be blocked, but it resolved')
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(BlockedError)
  return err as BlockedError & { receipt: R }
}

function setup() {
  const signer = new LocalSigner()
  const evidence = new MemoryEvidence()
  const merchantRepo = new MemoryMerchantRepo()
  const consentRepo = new MemoryConsentRepo()
  const credRepo = new MemoryCredentialRepo()
  const mppRepo = new MemoryMppRepo()
  const nonces = new MemoryNonceRepo()
  const psp = new SimulatedPsp()
  const allowedMpps = [MPP_ID]
  const userId = 'user_123'
  const redeem = (cred: PaymentCredential, callingMpp: string) =>
    cp.redeem(credRepo, signer, evidence, cred.contents.journey_id, cred, callingMpp)

  return {
    signer,
    evidence,
    merchantRepo,
    consentRepo,
    credRepo,
    mppRepo,
    nonces,
    psp,
    allowedMpps,
    userId,
    redeem,
  }
}

type Ctx = ReturnType<typeof setup>

/** Drives a journey from an empty cart to an issued, single-use credential. */
async function emitUpToCredential(s: Ctx, journeyId: string) {
  await s.credRepo.putMethod(cp.makeSandboxMethod(s.userId))
  const [method] = await cp.listPaymentMethods(s.credRepo, s.userId)
  const ref = (method as { paymentMethodRef: string }).paymentMethodRef

  const cart = await createMerchantCart(
    s.merchantRepo,
    s.signer,
    s.evidence,
    journeyId,
    [
      { productId: 'item_a', qty: 1 },
      { productId: 'item_c', qty: 1 },
    ],
    s.userId,
  )

  const proof = consent.buildWebConfirmConsentProof(cartHash(cart), `session_${journeyId}`)
  const { checkoutMandate, paymentMandate } = await consent.emitMandates(
    s.signer,
    s.evidence,
    s.consentRepo,
    journeyId,
    cart,
    ref,
    proof,
  )

  const credential = await cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
    journeyId,
    userId: s.userId,
    cartMandate: cart,
    paymentMandate,
    paymentMethodRef: ref,
    targetMpp: MPP_ID,
    allowedMpps: s.allowedMpps,
  })

  return { cart, checkoutMandate, paymentMandate, credential, paymentMethodRef: ref }
}

describe('the signed AP2 chain', () => {
  it('settles a whole journey: cart → mandates → credential → signed receipt', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_ok')

    const receipt = await initiatePayment(
      s.signer,
      s.evidence,
      s.redeem,
      s.psp,
      s.mppRepo,
      s.nonces,
      mppInput('j_ok', e),
    )

    expect(receipt.contents.status).toBe('Success')
    expect(receipt.contents.cart_hash).toBe(cartHash(e.cart))
    expect(decodePaymentMandate(e.paymentMandate)?.presence).toBe('HUMAN_PRESENT')
  })

  it('blocks a checkout_jwt hash the Merchant forwarded that the mandate does not authorize', async () => {
    const s = setup()
    // The MPP receives the checkout hash from the Merchant. If it does not match the user-signed
    // Checkout Mandate, the Merchant is compromised or confused — either way, block before redeem.
    const e = await emitUpToCredential(s, 'j_tamper')

    await expect(
      initiatePayment(
        s.signer,
        s.evidence,
        s.redeem,
        s.psp,
        s.mppRepo,
        s.nonces,
        mppInput('j_tamper', e, { checkoutJwtHash: 'forged-by-the-merchant' }),
      ),
    ).rejects.toMatchObject({ code: 'TAMPERED' })
  })

  it('blocks a double spend: the same credential reused under a NEW idempotency key', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_double')
    const base = mppInput('j_double', e)

    await initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, {
      ...base,
      idempotencyKey: 'attempt-A',
    })

    await expect(
      initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, {
        ...base,
        idempotencyKey: 'attempt-B',
      }),
    ).rejects.toMatchObject({ code: 'DOUBLE_SPEND' })
  })

  it('replays the receipt on a retry with the SAME key, without a second redeem or charge', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_idem')
    const input = mppInput('j_idem', e, { idempotencyKey: 'idem-X' })

    const r1 = await initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)
    const r2 = await initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)

    expect(r2.contents.receipt_id).toBe(r1.contents.receipt_id)
    expect(s.evidence.entries.some((x) => x.type === 'PAYMENT_RECEIPT_REPLAYED')).toBe(true)
    expect(s.evidence.entries.filter((x) => x.type === 'PAYMENT_RECEIPT')).toHaveLength(1)
  })

  it('routes payment through the Merchant, which verifies the mandate before the MPP sees it', async () => {
    const s = setup()
    const payViaMpp = (input: PaymentInput) =>
      initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)

    const ok = await emitUpToCredential(s, 'j_merch_ok')
    const result = await merchantInitiatePayment(
      s.signer,
      s.evidence,
      s.merchantRepo,
      payViaMpp,
      merchantInput('j_merch_ok', ok),
    )

    expect(result.paymentReceipt.contents.status).toBe('Success')
    expect(result.checkoutReceipt.contents.status).toBe('Success')
    const merchantSteps = s.evidence.entries.filter((x) => x.entity === 'merchant')
    expect(
      merchantSteps.some((x) => x.type === 'VERIFY_CHECKOUT_MANDATE' && x.verified === true),
    ).toBe(true)
    expect(merchantSteps.some((x) => x.type === 'MERCHANT_INITIATE_PAYMENT')).toBe(true)
    expect(merchantSteps.some((x) => x.type === 'CHECKOUT_RECEIPT')).toBe(true)

    const bad = await emitUpToCredential(s, 'j_merch_tamper')
    await expect(
      merchantInitiatePayment(s.signer, s.evidence, s.merchantRepo, payViaMpp, {
        journeyId: 'j_merch_tamper',
        checkoutMandate: tamperSdJwt(bad.checkoutMandate),
        credential: bad.credential,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MANDATE' })
  })

  it('blocks a credential scoped to an MPP that is not authorized', async () => {
    const s = setup()
    await s.credRepo.putMethod(cp.makeSandboxMethod(s.userId))
    const [method] = await cp.listPaymentMethods(s.credRepo, s.userId)
    const ref = (method as { paymentMethodRef: string }).paymentMethodRef

    const cart = await createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_scope',
      [{ productId: 'item_a', qty: 1 }],
      s.userId,
    )
    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), 'session_scope')
    const { paymentMandate } = await consent.emitMandates(
      s.signer,
      s.evidence,
      s.consentRepo,
      'j_scope',
      cart,
      ref,
      proof,
    )

    await expect(
      cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
        journeyId: 'j_scope',
        userId: s.userId,
        cartMandate: cart,
        paymentMandate,
        paymentMethodRef: ref,
        targetMpp: 'mpp-rogue-999',
        allowedMpps: s.allowedMpps,
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
  })

  it('blocks a consent proof that approved a DIFFERENT cart', async () => {
    const s = setup()
    await s.credRepo.putMethod(cp.makeSandboxMethod(s.userId))
    const [method] = await cp.listPaymentMethods(s.credRepo, s.userId)
    const ref = (method as { paymentMethodRef: string }).paymentMethodRef

    // Distinct journeys, so the idempotent-cart guard does not hand back the same cart twice.
    const cartA = await createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_proof_a',
      [{ productId: 'item_a', qty: 1 }],
      s.userId,
    )
    const cartB = await createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_proof_b',
      [{ productId: 'item_b', qty: 1 }],
      s.userId,
    )
    const proofForB = consent.buildWebConfirmConsentProof(cartHash(cartB), 'session_b')

    await expect(
      consent.emitMandates(
        s.signer,
        s.evidence,
        s.consentRepo,
        'j_proof_a',
        cartA,
        ref,
        proofForB,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
  })

  it('signs the OTP step-up attestation into the mandate, and the chain still settles', async () => {
    const s = setup()
    await s.credRepo.putMethod(cp.makeSandboxMethod(s.userId))
    const [method] = await cp.listPaymentMethods(s.credRepo, s.userId)
    const ref = (method as { paymentMethodRef: string }).paymentMethodRef

    const cart = await createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_otp',
      [{ productId: 'item_a', qty: 1 }],
      s.userId,
    )
    const proof = consent.buildWebOtpConsentProof(cartHash(cart), 'cs_demo', 'sha256:otp-ref')
    const { checkoutMandate, paymentMandate } = await consent.emitMandates(
      s.signer,
      s.evidence,
      s.consentRepo,
      'j_otp',
      cart,
      ref,
      proof,
    )

    // The attestation rides SIGNED inside the SD-JWT, as a disclosable claim.
    const claims = decodePaymentMandate(paymentMandate)
    expect(claims?.presence).toBe('HUMAN_PRESENT')
    expect((claims?.consent_proof as { step_up?: unknown })?.step_up).toMatchObject({
      method: 'OTP_SMS',
      verified: true,
      ref: 'sha256:otp-ref',
    })

    const credential = await cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
      journeyId: 'j_otp',
      userId: s.userId,
      cartMandate: cart,
      paymentMandate,
      paymentMethodRef: ref,
      targetMpp: MPP_ID,
      allowedMpps: s.allowedMpps,
    })

    const receipt = await initiatePayment(
      s.signer,
      s.evidence,
      s.redeem,
      s.psp,
      s.mppRepo,
      s.nonces,
      mppInput('j_otp', { cart, checkoutMandate, credential }),
    )
    expect(receipt.contents.status).toBe('Success')
  })
})

describe('the Merchant bounds what it will sign', () => {
  const h = () => ({ repo: new MemoryMerchantRepo(), signer: new LocalSigner(), ev: new MemoryEvidence() })
  const build = (items: { productId: string; qty: number }[]) => {
    const { repo, signer, ev } = h()
    return createMerchantCart(repo, signer, ev, 'j_limits', items, 'user_limits')
  }

  it('refuses an empty cart', async () => {
    await expect(build([])).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
  })

  it('refuses more line items than it will price', async () => {
    const tooMany = Array.from({ length: merchant.MAX_CART_LINES + 1 }, () => ({
      productId: 'item_a',
      qty: 1,
    }))
    await expect(build(tooMany)).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
  })

  it('refuses a quantity above the ceiling, or one that is not a whole number', async () => {
    await expect(build([{ productId: 'item_a', qty: merchant.MAX_LINE_QTY + 1 }])).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE',
    })
    await expect(build([{ productId: 'item_a', qty: 1.5 }])).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE',
    })
  })

  it('refuses a negative quantity, which would otherwise subtract from the total', async () => {
    await expect(build([{ productId: 'item_a', qty: -5 }])).rejects.toMatchObject({
      code: 'OUT_OF_SCOPE',
    })
  })

  it('still signs a cart at exactly the ceiling', async () => {
    const cart = await build([{ productId: 'item_a', qty: merchant.MAX_LINE_QTY }])
    expect(cart.merchant_authorization).toBeTruthy()
  })
})

describe('the step-up attestation names the channel that actually delivered', () => {
  it('records a sandbox-revealed code as such, never as OTP_SMS', async () => {
    const { repo, signer, ev } = { repo: new MemoryMerchantRepo(), signer: new LocalSigner(), ev: new MemoryEvidence() }
    const cart = await createMerchantCart(repo, signer, ev, 'j_channel', [{ productId: 'item_a', qty: 1 }], 'user_channel')

    const sms = consent.buildWebOtpConsentProof(cartHash(cart), 'cs', 'ref')
    expect(sms.step_up?.method).toBe('OTP_SMS')

    const sandbox = consent.buildWebOtpConsentProof(cartHash(cart), 'cs', 'ref', 'OTP_SANDBOX_REVEALED')
    expect(sandbox.step_up?.method).toBe('OTP_SANDBOX_REVEALED')

    // The method rides into risk_data, so the audit trail carries it too.
    const { paymentMandate } = await consent.emitMandates(
      signer, ev, new MemoryConsentRepo(), 'j_channel', cart, 'pm_visa_1234', sandbox,
    )
    const claims = decodePaymentMandate(paymentMandate) as { risk_data?: { step_up_method?: string } }
    expect(claims.risk_data?.step_up_method).toBe('OTP_SANDBOX_REVEALED')
  })
})

describe('a lost idempotency race is recorded, not swallowed', () => {
  it('records PAYMENT_RECEIPT_RACE when another attempt already claimed the key', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_race')

    // The remaining race, now that the key is reserved before the redeem: this attempt's lease
    // lapsed mid-flight and another took the key over, so its receipt is signed and real but no
    // longer canonical. That interleaving cannot be produced with a second call, so the loss is
    // injected directly — what must not happen is a second receipt existing with nothing in the
    // trail saying which one a payer was shown.
    vi.spyOn(s.mppRepo, 'completeIdempotencyKey').mockResolvedValueOnce(false)

    await initiatePayment(
      s.signer,
      s.evidence,
      s.redeem,
      s.psp,
      s.mppRepo,
      s.nonces,
      mppInput('j_race', e),
    )

    expect(s.evidence.entries.some((x) => x.type === 'PAYMENT_RECEIPT_RACE')).toBe(true)
  })
})

describe('a journey belongs to the caller who opened it', () => {
  const payVia = (s: Ctx) => (input: PaymentInput) =>
    initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)

  /**
   * `journeyId` is chosen by the caller and is not a secret — it rides in URLs, logs and the
   * Explorer. The cart lookup by journey is *idempotent*, which is the sharp edge: without an owner
   * check, a second caller naming an existing journey is not refused, they are handed the first
   * caller's signed cart — its items, its total, the merchant they are buying from.
   */
  it("refuses to hand a second caller the first caller's signed cart", async () => {
    const s = setup()
    const mine = await createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_owned',
      [{ productId: 'item_a', qty: 1 }],
      'user_alice',
    )

    const attempt = createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_owned',
      [{ productId: 'item_b', qty: 1 }],
      'user_bob',
    )
    await expect(attempt).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })

    // And Alice's journey is untouched: still her cart, still the same signature.
    const stored = await s.merchantRepo.getCartByJourney('j_owned')
    expect(stored?.ownerRef).toBe('user_alice')
    expect(stored?.cart.merchant_authorization).toBe(mine.merchant_authorization)
  })

  it('still returns the same cart to the caller who opened the journey', async () => {
    const s = setup()
    const args = [s.merchantRepo, s.signer, s.evidence, 'j_idem'] as const
    const first = await createMerchantCart(...args, [{ productId: 'item_a', qty: 1 }], 'user_alice')
    const second = await createMerchantCart(...args, [{ productId: 'item_b', qty: 9 }], 'user_alice')
    // Idempotency is the behaviour being preserved, not a side effect of the ownership check.
    expect(second.contents.id).toBe(first.contents.id)
  })

  it('refuses a settlement driven by anyone but the journey owner', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_settle_owner')

    // The credential and both mandates are genuine — only the caller differs. Left unchecked this
    // matters beyond a stray charge: the MPP keys idempotency on the journey, so a stranger who
    // settles first makes the owner's own attempt replay *their* receipt.
    const err = await expectBlocked<CheckoutReceipt>(
      merchantInitiatePayment(s.signer, s.evidence, s.merchantRepo, payVia(s), {
        ...merchantInput('j_settle_owner', e),
        callerRef: 'user_intruder',
      }),
    )
    expect(err.code).toBe('INVALID_MANDATE')
    expect(err.receipt.contents.error_description).toContain('another caller')

    // The rightful owner still settles.
    const ok = await merchantInitiatePayment(s.signer, s.evidence, s.merchantRepo, payVia(s), {
      ...merchantInput('j_settle_owner', e),
      callerRef: s.userId,
    })
    expect(ok.paymentReceipt.contents.status).toBe('Success')
  })
})

describe('the payment credential is bound to its payer', () => {
  /**
   * `paymentMethodRef` is **not** unique across users — `makeSandboxMethod` hands every user the
   * same `pm_visa_1234` — so resolving it globally at redeem returns whichever row the store
   * happened to return first, and releases a stranger's PSP references to the processor. The CP
   * records the payer it verified at issuance and scopes the lookup to it.
   */
  it('resolves the instrument of the recorded payer when two users share a reference', async () => {
    const s = setup()
    // Registered first, so a global lookup would plausibly land here rather than on the real payer.
    const otherUser = 'user_other'
    await s.credRepo.putMethod(cp.makeSandboxMethod(otherUser))

    const e = await emitUpToCredential(s, 'j_payer_shared')

    const mine = await s.credRepo.getMethod(s.userId, e.paymentMethodRef)
    const theirs = await s.credRepo.getMethod(otherUser, e.paymentMethodRef)
    // Same reference, two users, different PSP identities behind it — the setup the binding guards.
    expect(theirs?.paymentMethodRef).toBe(mine?.paymentMethodRef)
    expect(theirs?.pspCustomerRef).not.toBe(mine?.pspCustomerRef)

    const instruction = await s.redeem(e.credential, MPP_ID)
    expect(instruction.pspCustomerRef).toBe(mine?.pspCustomerRef)
    expect(instruction.pspPaymentMethodRef).toBe(mine?.pspPaymentMethodRef)
    expect(instruction.pspCustomerRef).not.toBe(theirs?.pspCustomerRef)
  })

  it('keeps the payer identifier out of the credential the Merchant receives', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_payer_privacy')
    // The binding is enforced by the CP, not published: the credential travels to the Merchant, and
    // a stable user id in it would be a cross-journey identifier handed to every merchant.
    expect(JSON.stringify(e.credential)).not.toContain(s.userId)
  })

  it('refuses to redeem a credential whose payer does not own the instrument', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_payer_orphan')

    // The credential itself is untouched and verifies cleanly — only the recorded payer changes, so
    // this exercises the binding rather than the signature.
    await s.credRepo.putCredential({
      contents: e.credential.contents,
      status: 'ISSUED',
      paymentMandate: e.paymentMandate,
      payerRef: 'user_with_no_methods',
      issuanceKey: 'orphaned',
      cpAuthorization: e.credential.cp_authorization,
    })
    expect((await verifyCredential(s.signer, e.credential, 'cp')).ok).toBe(true)

    const err = await s.redeem(e.credential, MPP_ID).then(
      () => {
        throw new Error('expected the redeem to be blocked, but it resolved')
      },
      (x: unknown) => x,
    )
    expect(err).toBeInstanceOf(BlockedError)
    expect((err as BlockedError).code).toBe('UNKNOWN_METHOD')
    expect(s.evidence.entries.some((x) => x.type === 'BLOCKED_OUT_OF_SCOPE')).toBe(true)
  })
})

describe('claim validation and anti-replay', () => {
  it('replays the identical issuance request instead of minting a second credential', async () => {
    const s = setup()
    const { cart, paymentMandate, paymentMethodRef, credential } = await emitUpToCredential(
      s,
      'j_replay',
    )

    // A checkout that timed out after this step asks again with the same request. The CP consumed
    // the mandate's jti when it first answered, so without idempotent issuance this legitimate
    // retry came back as REPLAYED — a step that had *succeeded* reported to the user as an attack,
    // leaving the payment stranded between "not done" and "cannot be retried".
    const again = await cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
      journeyId: 'j_replay',
      userId: s.userId,
      cartMandate: cart,
      paymentMandate,
      paymentMethodRef,
      targetMpp: MPP_ID,
      allowedMpps: s.allowedMpps,
    })

    // The same credential, not a second spendable one — which is the property the old REPLAYED
    // block was really protecting, and the one that has to survive making retries work.
    expect(again.contents.credential_id).toBe(credential.contents.credential_id)
    expect(again.cp_authorization).toBe(credential.cp_authorization)
    expect(
      s.evidence.entries.filter((x) => x.type === 'PAYMENT_CREDENTIAL_ISSUED'),
    ).toHaveLength(1)
    expect(s.evidence.entries.some((x) => x.type === 'PAYMENT_CREDENTIAL_REPLAYED')).toBe(true)
  })

  it('still blocks a mandate re-presented as part of a DIFFERENT request', async () => {
    const s = setup()
    const { cart, paymentMandate, paymentMethodRef } = await emitUpToCredential(s, 'j_replay_diff')

    // Same mandate and same cart, different journey — so it is not the call the CP already
    // answered. Idempotency covers the whole request precisely so this misses the replay path and
    // is judged as it always was: the jti is spent, and the CP refuses.
    await expect(
      cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
        journeyId: 'j_replay_other',
        userId: s.userId,
        cartMandate: cart,
        paymentMandate,
        paymentMethodRef,
        targetMpp: MPP_ID,
        allowedMpps: s.allowedMpps,
      }),
    ).rejects.toMatchObject({ code: 'REPLAYED' })
    expect(
      s.evidence.entries.some((x) => x.entity === 'cp' && x.type === 'BLOCKED_REPLAY'),
    ).toBe(true)
  })

  it('scopes replay per verifier: the same mandate passes the CP and then the MPP', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_scope_ok')

    const receipt = await initiatePayment(
      s.signer,
      s.evidence,
      s.redeem,
      s.psp,
      s.mppRepo,
      s.nonces,
      mppInput('j_scope_ok', e),
    )

    expect(receipt.contents.status).toBe('Success')
    expect(s.evidence.entries.some((x) => x.type === 'BLOCKED_REPLAY')).toBe(false)
  })

  it('blocks an expired cart at the CP, and an expired mandate on direct verification', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const { cart, paymentMandate, paymentMethodRef } = await emitUpToCredential(s, 'j_exp')

      // +12 min: the cart (10 min) has expired; the mandate (15 min) has not.
      vi.setSystemTime(Date.now() + 12 * 60_000)
      await expect(
        cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
          journeyId: 'j_exp',
          userId: s.userId,
          cartMandate: cart,
          paymentMandate,
          paymentMethodRef,
          targetMpp: MPP_ID,
          allowedMpps: s.allowedMpps,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MANDATE' })

      // +17 min total: now the mandate itself has expired.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const v = await verifyPaymentMandate(s.signer, paymentMandate, 'cp')
      expect(v.ok).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks an artifact presented to a verifier outside its signed audience', async () => {
    const s = setup()
    const { cart, credential } = await emitUpToCredential(s, 'j_aud')

    // A Cart Mandate is addressed to consent/cp/mpp/merchant — the agent never verifies carts.
    const cartV = await verifyCartMandate(s.signer, cart, 'agent')
    expect(cartV.ok).toBe(false)
    expect(cartV.reason).toContain('aud mismatch')

    // A credential is addressed to cp/mpp — the merchant is never its audience.
    const credV = await verifyCredential(s.signer, credential, 'merchant')
    expect(credV.ok).toBe(false)
    expect(credV.reason).toContain('aud mismatch')
  })

  it('blocks type confusion: the right issuer and hash, but another artifact type', async () => {
    const s = setup()
    const { cart } = await emitUpToCredential(s, 'j_typ')

    const forged = await signJws(
      s.signer,
      'merchant',
      { iss: 'merchant', aud: ['cp'], cart_hash: hashCanonicalB64url(cart.contents) },
      AP2_TYPE.CheckoutReceipt,
    )

    const v = await verifyCartMandate(
      s.signer,
      { contents: cart.contents, merchant_authorization: forged },
      'cp',
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('typ mismatch')
  })
})

describe('vct exact-match (AP2 §Extensibility)', () => {
  const now = () => Math.floor(Date.now() / 1000)

  /** A mandate valid in every respect except its `vct`, isolating the exact-match rule. */
  const forgeMandate = (s: Ctx, vct: string) =>
    issueRawMandate(s.signer, {
      iss: 'consent',
      vct,
      aud: ['cp', 'mpp'],
      nonce: 'n',
      iat: now(),
      exp: now() + 900,
      jti: 'jti-vct',
      transaction_id: 'tx',
      presence: 'HUMAN_PRESENT',
    })

  it('accepts the exact supported vct', async () => {
    const s = setup()
    const { paymentMandate } = await emitUpToCredential(s, 'j_vct_ok')
    expect(decodePaymentMandate(paymentMandate)?.vct).toBe(VCT.PaymentClosed)
    expect((await verifyPaymentMandate(s.signer, paymentMandate, 'cp')).ok).toBe(true)
  })

  it('rejects a vct missing its version suffix', async () => {
    const s = setup()
    const v = await verifyPaymentMandate(s.signer, await forgeMandate(s, 'mandate.payment'), 'cp')
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('vct mismatch')
  })

  it('rejects an unsupported future version', async () => {
    const s = setup()
    const v = await verifyPaymentMandate(s.signer, await forgeMandate(s, 'mandate.payment.2'), 'cp')
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('vct mismatch')
  })
})

describe('the Merchant verifying the user-signed Checkout Mandate', () => {
  const payVia = (s: Ctx) => (input: PaymentInput) =>
    initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)

  it('binds the mandate to the cart, and the MPP re-verifies it in depth', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_ck_ok')

    expect(decodeCheckoutMandate(e.checkoutMandate)?.vct).toBe(VCT.CheckoutClosed)
    expect(decodeCheckoutMandate(e.checkoutMandate)?.checkout_hash).toBe(checkoutJwtHash(e.cart))
    expect((await verifyCheckoutMandate(s.signer, e.checkoutMandate, 'merchant')).ok).toBe(true)
    expect(
      s.evidence.entries.some((x) => x.entity === 'consent' && x.type === 'CHECKOUT_MANDATE'),
    ).toBe(true)

    const result = await merchantInitiatePayment(
      s.signer,
      s.evidence,
      s.merchantRepo,
      payVia(s),
      merchantInput('j_ck_ok', e),
    )
    expect(result.paymentReceipt.contents.status).toBe('Success')
    expect(
      s.evidence.entries.some(
        (x) => x.entity === 'mpp' && x.type === 'VERIFY_CHECKOUT_MANDATE' && x.verified === true,
      ),
    ).toBe(true)
  })

  it('blocks a tampered Checkout Mandate', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_ck_tamper')

    await expect(
      merchantInitiatePayment(s.signer, s.evidence, s.merchantRepo, payVia(s), {
        journeyId: 'j_ck_tamper',
        checkoutMandate: tamperSdJwt(e.checkoutMandate),
        credential: e.credential,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MANDATE' })
    expect(
      s.evidence.entries.some(
        (x) => x.entity === 'merchant' && x.type === 'BLOCKED_INVALID_MANDATE',
      ),
    ).toBe(true)
  })

  it('blocks a stale approval: the cart was re-priced after the user approved it', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_ck_stale')

    const repriced = await createMerchantCart(
      s.merchantRepo,
      s.signer,
      s.evidence,
      'j_ck_stale_v2',
      [{ productId: 'item_b', qty: 1 }],
      s.userId,
    )
    // The re-priced cart becomes the journey's latest, so the approved one is no longer current.
    await s.merchantRepo.putCart(repriced, 'j_ck_stale', s.userId)

    await expect(
      merchantInitiatePayment(
        s.signer,
        s.evidence,
        s.merchantRepo,
        payVia(s),
        merchantInput('j_ck_stale', e),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MANDATE' })
  })

  it('blocks an expired cart at payment time', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const e = await emitUpToCredential(s, 'j_ck_exp')
      // The cart (10 min) expires before the Checkout Mandate (15 min) does.
      vi.setSystemTime(Date.now() + 11 * 60_000)

      await expect(
        merchantInitiatePayment(
          s.signer,
          s.evidence,
          s.merchantRepo,
          payVia(s),
          merchantInput('j_ck_exp', e),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_MANDATE' })
    } finally {
      vi.useRealTimers()
    }
  })

  it("blocks a crossed pair: cart A's mandate presented with cart B's chain", async () => {
    const s = setup()
    const a = await emitUpToCredential(s, 'j_pair_a')
    const b = await emitUpToCredential(s, 'j_pair_b')

    await expect(
      merchantInitiatePayment(s.signer, s.evidence, s.merchantRepo, payVia(s), {
        journeyId: 'j_pair_b',
        checkoutMandate: a.checkoutMandate,
        credential: b.credential,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MANDATE' })
  })

  it('catches a mismatched mandate at the MPP even when the Merchant gate is bypassed', async () => {
    const s = setup()
    const a = await emitUpToCredential(s, 'j_mpp_a')
    const b = await emitUpToCredential(s, 'j_mpp_b')

    await expect(
      payVia(s)(
        mppInput('j_mpp_b', {
          cart: b.cart,
          checkoutMandate: a.checkoutMandate,
          credential: b.credential,
        }),
      ),
    ).rejects.toMatchObject({ code: 'TAMPERED' })
  })
})

describe('money stays in integer minor units', () => {
  it('carries an integer amount that matches the signed cart total', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_amt_ok')

    const claims = decodePaymentMandate(e.paymentMandate)
    const amount = claims?.payment_amount as Amount
    expect(Number.isInteger(amount.amount)).toBe(true)
    expect(amount.amount).toBe(
      Math.round(e.cart.contents.payment_request.details.total.amount.value * 100),
    )

    const receipt = await initiatePayment(
      s.signer,
      s.evidence,
      s.redeem,
      s.psp,
      s.mppRepo,
      s.nonces,
      mppInput('j_amt_ok', e),
    )
    expect(receipt.contents.status).toBe('Success')
  })

  it('blocks a mandate whose amount differs from the cart total', async () => {
    const s = setup()
    const { cart, paymentMandate, paymentMethodRef } = await emitUpToCredential(s, 'j_amt_bad')

    // A fully valid re-issued mandate — right signature, vct and chain link — with only the amount
    // changed, so the CP's scope check is the single thing under test.
    const good = decodePaymentMandate(paymentMandate) as Record<string, unknown>
    const tampered = await issueRawMandate(s.signer, {
      ...good,
      payment_amount: { amount: 1, currency: 'BRL' },
    })

    await expect(
      cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
        journeyId: 'j_amt_bad',
        userId: s.userId,
        cartMandate: cart,
        paymentMandate: tampered,
        paymentMethodRef,
        targetMpp: MPP_ID,
        allowedMpps: s.allowedMpps,
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
  })

  it("blocks a crossed transaction_id: cart A's mandate presented with cart B", async () => {
    const s = setup()
    const a = await emitUpToCredential(s, 'j_tx_a')
    const b = await emitUpToCredential(s, 'j_tx_b')

    await expect(
      cp.issueCredential(s.credRepo, s.signer, s.evidence, s.nonces, {
        journeyId: 'j_tx_x',
        userId: s.userId,
        cartMandate: b.cart,
        paymentMandate: a.paymentMandate,
        paymentMethodRef: a.paymentMethodRef,
        targetMpp: MPP_ID,
        allowedMpps: s.allowedMpps,
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
  })
})

describe('data minimization: the Payment Mandate never transits the Merchant', () => {
  it('forwards only the Checkout Mandate, the checkout hash and the token', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_min')

    const seen: PaymentInput[] = []
    const spyPayVia = (input: PaymentInput) => {
      seen.push(input)
      return initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)
    }

    const result = await merchantInitiatePayment(
      s.signer,
      s.evidence,
      s.merchantRepo,
      spyPayVia,
      merchantInput('j_min', e),
    )
    expect(result.paymentReceipt.contents.status).toBe('Success')
    expect(seen).toHaveLength(1)

    const forwarded = seen[0] as unknown as Record<string, unknown>
    expect(forwarded.checkoutJwtHash).toBe(checkoutJwtHash(e.cart))
    expect(forwarded.credential).toBeDefined()
    expect(forwarded.checkoutMandate).toBeDefined()
    // What the Merchant must never see: the consent proof and instrument in the Payment Mandate,
    // and the Cart Mandate it is supposed to fetch itself.
    expect('paymentMandate' in forwarded).toBe(false)
    expect('cartMandate' in forwarded).toBe(false)
  })

  it('re-verifies the CP-returned Payment Mandate AFTER the redeem', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_route')

    let captured: Awaited<ReturnType<typeof s.redeem>> | undefined
    const redeemCapture = async (cred: PaymentCredential, callingMpp: string) => {
      captured = await s.redeem(cred, callingMpp)
      return captured
    }

    const receipt = await initiatePayment(
      s.signer,
      s.evidence,
      redeemCapture,
      s.psp,
      s.mppRepo,
      s.nonces,
      mppInput('j_route', e),
    )
    expect(receipt.contents.status).toBe('Success')
    expect(decodePaymentMandate(captured?.paymentMandate ?? '')?.transaction_id).toBe(
      checkoutJwtHash(e.cart),
    )

    const seqOf = (t: string) =>
      s.evidence.entries.find((x) => x.entity === 'mpp' && x.type === t)?.seq ?? -1
    const redeemSeq =
      s.evidence.entries.find(
        (x) => x.entity === 'cp' && x.type === 'PAYMENT_CREDENTIAL_REDEEMED',
      )?.seq ?? -1
    expect(seqOf('VERIFY_PAYMENT_MANDATE')).toBeGreaterThan(redeemSeq)
  })

  it('fails closed: a rogue CP burns the credential but never reaches the PSP', async () => {
    const s = setup()
    const good = await emitUpToCredential(s, 'j_closed_good')
    const other = await emitUpToCredential(s, 'j_closed_other')
    const pspSpy = vi.spyOn(s.psp, 'authorize')

    // A compromised CP redeems the right credential but returns another checkout's mandate.
    const rogueRedeem = async (cred: PaymentCredential, callingMpp: string) => {
      const instr = await s.redeem(cred, callingMpp)
      return { ...instr, paymentMandate: other.paymentMandate }
    }

    await expect(
      initiatePayment(
        s.signer,
        s.evidence,
        rogueRedeem,
        s.psp,
        s.mppRepo,
        s.nonces,
        mppInput('j_closed_good', good),
      ),
    ).rejects.toMatchObject({ code: 'TAMPERED' })

    expect(pspSpy).not.toHaveBeenCalled()
    expect(
      s.evidence.entries.some(
        (x) => x.entity === 'cp' && x.type === 'PAYMENT_CREDENTIAL_REDEEMED',
      ),
    ).toBe(true)
    expect(
      s.evidence.entries.some((x) => x.entity === 'mpp' && x.type === 'BLOCKED_TAMPERED_CART'),
    ).toBe(true)
  })
})

describe('every terminal outcome is a signed receipt', () => {
  it('signs both receipts on success, bound to the mandates they answer', async () => {
    const s = setup()
    const payViaMpp = (input: PaymentInput) =>
      initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)

    const e = await emitUpToCredential(s, 'j_rcpt_ok')
    const result = await merchantInitiatePayment(
      s.signer,
      s.evidence,
      s.merchantRepo,
      payViaMpp,
      merchantInput('j_rcpt_ok', e),
    )

    const pr = result.paymentReceipt.contents
    expect(pr.status).toBe('Success')
    expect(pr.iss).toBe('mpp')
    expect(pr.reference).toBe(paymentMandateHash(e.paymentMandate))
    expect(pr.psp_confirmation_id).toBeTruthy()
    expect(pr.error).toBeUndefined()
    expect(Number.isInteger(pr.amount?.amount)).toBe(true)
    expect((await verifyReceipt(s.signer, result.paymentReceipt, 'merchant')).ok).toBe(true)

    const cr = result.checkoutReceipt.contents
    expect(cr.status).toBe('Success')
    expect(cr.reference).toBe(checkoutMandateHash(e.checkoutMandate))
    expect(cr.order_id).toBeTruthy()
    expect(cr.error).toBeUndefined()
    expect((await verifyCheckoutReceipt(s.signer, result.checkoutReceipt, 'agent')).ok).toBe(true)

    // Optional fields must be ABSENT, never an explicit `undefined` own-property: the DynamoDB
    // marshaller rejects undefined map values, and the in-memory adapter would hide that locally.
    expect(Object.values(pr).some((v) => v === undefined)).toBe(false)
    expect(Object.values(cr).some((v) => v === undefined)).toBe(false)
  })

  it('returns a signed Error receipt when the PSP declines, rather than throwing', async () => {
    const s = setup()
    const decliningPsp: PspGateway = {
      authorize: async () => ({ status: 'DECLINED', pspReference: 'pi_declined_001' }),
    }
    const e = await emitUpToCredential(s, 'j_rcpt_decline')

    const receipt = await initiatePayment(
      s.signer,
      s.evidence,
      s.redeem,
      decliningPsp,
      s.mppRepo,
      s.nonces,
      mppInput('j_rcpt_decline', e),
    )

    expect(receipt.contents.status).toBe('Error')
    expect(receipt.contents.psp_confirmation_id).toBeUndefined()
    expect(receipt.contents.error_description).toContain('declined')
    // A declined receipt is still signed — a decline is an outcome, not a missing artifact.
    expect((await verifyReceipt(s.signer, receipt, 'merchant')).ok).toBe(true)
  })

  it('attaches a signed Error Payment Receipt to an MPP block', async () => {
    const s = setup()
    const e = await emitUpToCredential(s, 'j_rcpt_tamper')

    const err = await expectBlocked<PaymentReceipt>(
      initiatePayment(
        s.signer,
        s.evidence,
        s.redeem,
        s.psp,
        s.mppRepo,
        s.nonces,
        mppInput('j_rcpt_tamper', e, { checkoutJwtHash: 'forged' }),
      ),
    )

    expect(err.code).toBe('TAMPERED')
    expect(err.receipt.contents.status).toBe('Error')
    expect(err.receipt.contents.error).toBe('invalid_credential')
    expect((await verifyReceipt(s.signer, err.receipt, 'merchant')).ok).toBe(true)
  })

  it('attaches a signed Error Checkout Receipt to a Merchant block', async () => {
    const s = setup()
    const payViaMpp = (input: PaymentInput) =>
      initiatePayment(s.signer, s.evidence, s.redeem, s.psp, s.mppRepo, s.nonces, input)

    const e = await emitUpToCredential(s, 'j_rcpt_merch_reject')
    const tampered = tamperSdJwt(e.checkoutMandate)

    const err = await expectBlocked<CheckoutReceipt>(
      merchantInitiatePayment(s.signer, s.evidence, s.merchantRepo, payViaMpp, {
        journeyId: 'j_rcpt_merch_reject',
        checkoutMandate: tampered,
        credential: e.credential,
      }),
    )

    expect(err.code).toBe('INVALID_MANDATE')
    expect(err.receipt.contents.status).toBe('Error')
    expect(err.receipt.contents.error).toBe('invalid_credential')
    expect(err.receipt.contents.reference).toBe(checkoutMandateHash(tampered))
    expect((await verifyCheckoutReceipt(s.signer, err.receipt, 'agent')).ok).toBe(true)
  })
})
