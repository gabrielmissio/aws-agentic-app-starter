import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSigner } from '../domain/adapters/local-signer'
import {
  MemoryConsentRepo,
  MemoryCredentialRepo,
  MemoryEvidence,
  MemoryMerchantRepo,
  MemoryMppRepo,
  MemoryNonceRepo,
} from '../domain/adapters/memory'
import * as consent from '../domain/entities/consent-mandates'
import * as cp from '../domain/entities/credential-provider'
import { createMerchantCart } from '../domain/entities/merchant'
import { MPP_ID, initiatePayment } from '../domain/entities/mpp'
import { cartHash, checkoutJwtHash } from '../domain/mandates'
import { mintIdentityToken } from '../domain/identity'
import { BlockedError } from '../domain/sign'
import type { Ctx } from '../context'
import type { PspGateway, Signer } from '../domain/ports'
import type { LambdaEvent, LambdaResult } from '../http'
import { setLogLevel } from '../log'

/**
 * Concurrency, as a property rather than a description.
 *
 * Every guarantee in this file is about what happens when two requests overlap, and none of them can
 * be observed by calling once. The shape is the same throughout: make the slow part *actually* slow,
 * fire the requests together, and count the side effects that were supposed to happen once.
 *
 * Sequential versions of these tests pass against the broken code — which is precisely why the bug
 * survived a suite of 111 of them. A read-then-write reads `PENDING`, signs, and writes `APPROVED`;
 * do that twice in a row and the second is correctly refused. Do it twice at once and both read
 * `PENDING`.
 *
 * The in-memory adapters make the transitions atomic the way DynamoDB's conditional writes do in
 * the deployed stack. What these tests pin down is the layer above that: that the handler and the
 * MPP *take* the guard before they do the thing it guards, which is what neither of them did.
 */

const USER = 'user_concurrent'
const OTHER_USER = 'user_bystander'

/** Adds a real delay to signing, so two requests are genuinely in flight at the same time. */
class SlowSigner implements Signer {
  readonly alg: string
  constructor(
    private inner: Signer,
    private delayMs: number,
  ) {
    this.alg = inner.alg
  }
  async sign(entity: string, signingInput: string): Promise<string> {
    await new Promise((r) => setTimeout(r, this.delayMs))
    return this.inner.sign(entity, signingInput)
  }
  verify(signedBy: string, signingInput: string, signatureB64: string): Promise<boolean> {
    return this.inner.verify(signedBy, signingInput, signatureB64)
  }
}

/** A PSP that counts authorizations and takes its time over each one. */
class CountingPsp implements PspGateway {
  calls = 0
  constructor(private delayMs = 0) {}
  async authorize() {
    this.calls += 1
    await new Promise((r) => setTimeout(r, this.delayMs))
    return { status: 'AUTHORIZED' as const, pspReference: `pi_test_${this.calls}` }
  }
}

interface Harness extends Ctx {
  base: LocalSigner
  evidence: MemoryEvidence
  consent: MemoryConsentRepo
  credential: MemoryCredentialRepo
  mpp: MemoryMppRepo
  psp: CountingPsp
}

function harness(opts: { signDelayMs?: number; pspDelayMs?: number } = {}): Harness {
  const base = new LocalSigner()
  const psp = new CountingPsp(opts.pspDelayMs ?? 0)
  return {
    base,
    signer: opts.signDelayMs ? new SlowSigner(base, opts.signDelayMs) : base,
    evidence: new MemoryEvidence(),
    merchant: new MemoryMerchantRepo(),
    consent: new MemoryConsentRepo(),
    credential: new MemoryCredentialRepo(),
    mpp: new MemoryMppRepo(),
    nonces: new MemoryNonceRepo(),
    psp,
    allowedMpps: [MPP_ID],
    autoProvisionSandbox: false,
  }
}

// The handlers reach their ports through `ctx()`. Pointing it at the in-memory harness is what lets
// the *handler* be exercised — the claim it takes lives there, not in the domain function it calls.
let current: Harness
vi.mock('../context', () => ({ ctx: () => current }))

const evt = (body: unknown): LambdaEvent => ({ body: JSON.stringify(body) })
const parse = (r: LambdaResult) => JSON.parse(r.body) as Record<string, unknown>

/** Opens a consent session over a freshly signed cart, as the agent would. */
async function openSession(h: Harness, journeyId: string, userId = USER) {
  const { handler } = await import('../handlers/consent-mandates')
  await h.credential.putMethod(cp.makeSandboxMethod(userId))
  const cart = await createMerchantCart(
    h.merchant,
    h.base,
    h.evidence,
    journeyId,
    [{ productId: 'item_a', qty: 1 }],
    userId,
  )
  const identityToken = await mintIdentityToken(h.base, userId)
  const res = await handler(
    evt({
      op: 'initiate_consent_session',
      journeyId,
      cartMandate: cart,
      paymentMethodRef: 'pm_visa_1234',
      identityToken,
    }),
  )
  const { sessionId } = parse(res) as { sessionId: string }
  return { sessionId, cart, identityToken }
}

describe('one approval signs one pair of mandates, however many confirmations arrive', () => {
  beforeEach(() => setLogLevel('ERROR'))

  it('admits exactly one of ten simultaneous confirmations', async () => {
    // Signing is made slow on purpose. Without the delay the first confirmation finishes before the
    // second is scheduled and the race never occurs — a green test over a broken guarantee.
    current = harness({ signDelayMs: 25 })
    const h = current
    const { sessionId, cart, identityToken } = await openSession(h, 'j_race_consent')
    const { handler } = await import('../handlers/consent-decision')

    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), sessionId)
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        handler(evt({ op: 'submit_consent_decision', sessionId, approved: true, consentProof: proof, identityToken })),
      ),
    )

    const approved = results.filter((r) => r.statusCode === 200)
    expect(approved).toHaveLength(1)
    // The other nine are told why, and told the same thing: someone else has this session.
    for (const r of results.filter((r) => r.statusCode !== 200)) {
      expect(r.statusCode).toBe(409)
      expect(parse(r).code).toMatch(/SESSION_IN_PROGRESS|SESSION_RESOLVED/)
    }

    // The count that matters. Nine refusals with two mandate pairs in the store would still be two
    // spendable authorizations over one cart.
    const signed = h.evidence.entries.filter((e) => e.type === 'PAYMENT_MANDATE')
    expect(signed).toHaveLength(1)
    expect(h.evidence.entries.filter((e) => e.type === 'CHECKOUT_MANDATE')).toHaveLength(1)

    const session = await h.consent.getSession(sessionId)
    expect(session?.status).toBe('APPROVED')
    expect(session?.paymentMandateId).toBe((parse(approved[0] as LambdaResult) as { paymentMandateId: string }).paymentMandateId)
    // The claim is cleared on the way out, so nothing is left holding a lock on a finished session.
    expect(session?.lockOwner).toBeUndefined()
  })

  it('releases the claim when signing fails, so an honest retry is not locked out', async () => {
    current = harness()
    const h = current
    const { sessionId, identityToken } = await openSession(h, 'j_release')
    const { handler } = await import('../handlers/consent-decision')

    // A proof over a different cart: the domain refuses it after the claim has been taken.
    const wrong = consent.buildWebConfirmConsentProof('not-this-cart-hash', sessionId)
    const refused = await handler(
      evt({ op: 'submit_consent_decision', sessionId, approved: true, consentProof: wrong, identityToken }),
    )
    expect(parse(refused).blocked).toBe(true)

    // Left in PROCESSING, the user would be locked out for the whole lease over a mistake that
    // signed nothing — so the claim goes back rather than being waited out.
    expect((await h.consent.getSession(sessionId))?.status).toBe('PENDING')
  })

  it('refuses a second decision once the session is resolved', async () => {
    current = harness()
    const h = current
    const { sessionId, cart, identityToken } = await openSession(h, 'j_sequential')
    const { handler } = await import('../handlers/consent-decision')
    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), sessionId)
    const decide = () =>
      handler(evt({ op: 'submit_consent_decision', sessionId, approved: true, consentProof: proof, identityToken }))

    expect((await decide()).statusCode).toBe(200)
    const second = await decide()
    expect(second.statusCode).toBe(409)
    expect(parse(second).code).toBe('SESSION_RESOLVED')
    expect(h.evidence.entries.filter((e) => e.type === 'PAYMENT_MANDATE')).toHaveLength(1)
  })

  it('cannot be approved and rejected at once', async () => {
    current = harness({ signDelayMs: 25 })
    const h = current
    const { sessionId, cart, identityToken } = await openSession(h, 'j_split')
    const { handler } = await import('../handlers/consent-decision')
    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), sessionId)

    const [approve, reject] = await Promise.all([
      handler(evt({ op: 'submit_consent_decision', sessionId, approved: true, consentProof: proof, identityToken })),
      handler(evt({ op: 'submit_consent_decision', sessionId, approved: false, identityToken })),
    ])

    // Whichever lands first wins outright; the session ends in exactly one of the two states, and a
    // rejection never lands on top of mandates that were already signed.
    const codes = [approve.statusCode, reject.statusCode].sort()
    expect(codes).toEqual([200, 409])
    const status = (await h.consent.getSession(sessionId))?.status
    expect(['APPROVED', 'REJECTED']).toContain(status)
    if (status === 'REJECTED') {
      expect(h.evidence.entries.filter((e) => e.type === 'PAYMENT_MANDATE')).toHaveLength(0)
    }
  })
})

describe('one intention reaches the processor once', () => {
  beforeEach(() => setLogLevel('ERROR'))

  /** Drives a journey to an issued credential, entirely through the domain. */
  async function upToCredential(h: Harness, journeyId: string) {
    await h.credential.putMethod(cp.makeSandboxMethod(USER))
    const cart = await createMerchantCart(
      h.merchant,
      h.base,
      h.evidence,
      journeyId,
      [{ productId: 'item_a', qty: 1 }],
      USER,
    )
    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), `s_${journeyId}`)
    const { checkoutMandate, paymentMandate } = await consent.emitMandates(
      h.base,
      h.evidence,
      h.consent,
      journeyId,
      cart,
      'pm_visa_1234',
      proof,
    )
    const credential = await cp.issueCredential(h.credential, h.base, h.evidence, h.nonces, {
      journeyId,
      userId: USER,
      cartMandate: cart,
      paymentMandate,
      paymentMethodRef: 'pm_visa_1234',
      targetMpp: MPP_ID,
      allowedMpps: h.allowedMpps,
    })
    return { cart, checkoutMandate, credential }
  }

  it('authorizes once when two payments for the same journey overlap', async () => {
    // The PSP is slow, so both attempts are inside `initiatePayment` at the same time. Probing the
    // idempotency key read-only, as this used to, means both find it free and both charge.
    current = harness({ pspDelayMs: 40 })
    const h = current
    const e = await upToCredential(h, 'j_double_charge')
    const redeem = (c: Parameters<typeof cp.redeem>[4], mpp: string) =>
      cp.redeem(h.credential, h.base, h.evidence, 'j_double_charge', c, mpp)

    const pay = () =>
      initiatePayment(h.base, h.evidence, redeem, h.psp, h.mpp, h.nonces, {
        journeyId: 'j_double_charge',
        checkoutMandate: e.checkoutMandate,
        checkoutJwtHash: checkoutJwtHash(e.cart),
        credential: e.credential,
      })

    const outcomes = await Promise.allSettled([pay(), pay(), pay()])

    // The number this whole mechanism exists to hold at one.
    expect(h.psp.calls).toBe(1)
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)

    for (const o of outcomes.filter((x) => x.status === 'rejected')) {
      const err = (o as PromiseRejectedResult).reason as BlockedError
      expect(err).toBeInstanceOf(BlockedError)
      expect(err.code).toBe('IN_PROGRESS')
    }
    expect(h.evidence.entries.some((x) => x.type === 'BLOCKED_IN_PROGRESS')).toBe(true)
  })

  it('authorizes once even when the journey carries two independently signed mandate pairs', async () => {
    // The actual shape of the critical defect, reproduced end to end.
    //
    // The consent lock above stops a journey from ever reaching this state now, so the two mandate
    // pairs are emitted directly against the repo — which is precisely what the unguarded handler
    // produced. Two pairs mean two credentials, and two credentials are two *different* single-use
    // artifacts: the atomic redeem that saves the previous test cannot see them as the same spend.
    // Only the idempotency key, taken before the PSP call, stands between them and two charges.
    current = harness({ pspDelayMs: 40 })
    const h = current
    const journeyId = 'j_two_pairs'
    await h.credential.putMethod(cp.makeSandboxMethod(USER))
    const cart = await createMerchantCart(
      h.merchant,
      h.base,
      h.evidence,
      journeyId,
      [{ productId: 'item_a', qty: 1 }],
      USER,
    )

    const pairs = []
    for (const n of [1, 2]) {
      const proof = consent.buildWebConfirmConsentProof(cartHash(cart), `s_${journeyId}_${n}`)
      const { checkoutMandate, paymentMandate } = await consent.emitMandates(
        h.base,
        h.evidence,
        h.consent,
        journeyId,
        cart,
        'pm_visa_1234',
        proof,
      )
      const credential = await cp.issueCredential(h.credential, h.base, h.evidence, h.nonces, {
        journeyId,
        userId: USER,
        cartMandate: cart,
        paymentMandate,
        paymentMethodRef: 'pm_visa_1234',
        targetMpp: MPP_ID,
        allowedMpps: h.allowedMpps,
      })
      pairs.push({ checkoutMandate, credential })
    }
    // Two genuinely distinct credentials — the premise of the double charge.
    const [first, second] = pairs
    expect(first?.credential.contents.credential_id).not.toBe(
      second?.credential.contents.credential_id,
    )

    const redeem = (c: Parameters<typeof cp.redeem>[4], mpp: string) =>
      cp.redeem(h.credential, h.base, h.evidence, journeyId, c, mpp)
    const outcomes = await Promise.allSettled(
      pairs.map((p) =>
        initiatePayment(h.base, h.evidence, redeem, h.psp, h.mpp, h.nonces, {
          journeyId,
          checkoutMandate: p.checkoutMandate,
          checkoutJwtHash: checkoutJwtHash(cart),
          credential: p.credential,
        }),
      ),
    )

    // One authorization for one intention, even with two valid ways to ask for it.
    expect(h.psp.calls).toBe(1)
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as BlockedError).code).toBe('IN_PROGRESS')
  })

  it('replays the receipt for a retry that arrives after the first attempt finished', async () => {
    current = harness()
    const h = current
    const e = await upToCredential(h, 'j_retry')
    const redeem = (c: Parameters<typeof cp.redeem>[4], mpp: string) =>
      cp.redeem(h.credential, h.base, h.evidence, 'j_retry', c, mpp)
    const pay = () =>
      initiatePayment(h.base, h.evidence, redeem, h.psp, h.mpp, h.nonces, {
        journeyId: 'j_retry',
        checkoutMandate: e.checkoutMandate,
        checkoutJwtHash: checkoutJwtHash(e.cart),
        credential: e.credential,
      })

    const first = await pay()
    const second = await pay()

    // Same signed receipt, one charge: a sequential retry is answered, not refused, which is what
    // keeps a dropped connection from looking like a failed purchase.
    expect(second.contents.receipt_id).toBe(first.contents.receipt_id)
    expect(h.psp.calls).toBe(1)
    expect(h.evidence.entries.some((x) => x.type === 'PAYMENT_RECEIPT_REPLAYED')).toBe(true)
  })

  it('settles the key on a refusal, so a retry replays the block instead of re-entering the chain', async () => {
    current = harness()
    const h = current
    const e = await upToCredential(h, 'j_blocked')
    const redeem = (c: Parameters<typeof cp.redeem>[4], mpp: string) =>
      cp.redeem(h.credential, h.base, h.evidence, 'j_blocked', c, mpp)
    // A checkout hash the Checkout Mandate does not authorize: refused before the redeem.
    const pay = () =>
      initiatePayment(h.base, h.evidence, redeem, h.psp, h.mpp, h.nonces, {
        journeyId: 'j_blocked',
        checkoutMandate: e.checkoutMandate,
        checkoutJwtHash: 'not-the-hash-this-mandate-authorizes',
        credential: e.credential,
      })

    await expect(pay()).rejects.toBeInstanceOf(BlockedError)
    const replay = await pay()

    // The second call gets the signed Error receipt from the first rather than burning another
    // credential to reach the same answer.
    expect(replay.contents.status).toBe('Error')
    expect(h.psp.calls).toBe(0)
  })
})

describe('a consent session is readable only by the caller it belongs to', () => {
  beforeEach(() => setLogLevel('ERROR'))

  it('refuses every read operation to a caller who is not the owner', async () => {
    current = harness()
    const h = current
    const { sessionId, cart, identityToken } = await openSession(h, 'j_owner')
    const { handler } = await import('../handlers/consent-mandates')

    // Approve first, so there are real mandates behind the session — a read that returns nothing is
    // not evidence of an ownership check.
    const decision = await import('../handlers/consent-decision')
    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), sessionId)
    const approved = parse(
      await decision.handler(
        evt({ op: 'submit_consent_decision', sessionId, approved: true, consentProof: proof, identityToken }),
      ),
    ) as { paymentMandateId: string }

    const intruderToken = await mintIdentityToken(h.base, OTHER_USER)
    const ops = [
      { op: 'get_consent_session', sessionId },
      { op: 'poll_consent_status', sessionId },
      { op: 'get_mandate', sessionId, mandateId: approved.paymentMandateId },
    ]

    for (const op of ops) {
      const res = await handler(evt({ ...op, identityToken: intruderToken }))
      // 404, not 403: telling a stranger that a session exists but is not theirs turns this into an
      // oracle for which session ids are real.
      expect(res.statusCode, `${op.op} must refuse a non-owner`).toBe(404)
      expect(JSON.stringify(parse(res))).not.toContain('item_a')

      // The same call, with the owner's token, works — otherwise the refusal above proves nothing.
      const owner = await handler(evt({ ...op, identityToken }))
      expect(owner.statusCode, `${op.op} must serve the owner`).toBe(200)
    }
  })

  it('refuses every read operation to a caller with no identity at all', async () => {
    current = harness()
    const h = current
    const { sessionId } = await openSession(h, 'j_anon')
    const { handler } = await import('../handlers/consent-mandates')

    for (const op of ['get_consent_session', 'poll_consent_status']) {
      const res = await handler(evt({ op, sessionId }))
      expect(res.statusCode, `${op} must refuse an unidentified caller`).toBe(401)
    }
  })

  it('refuses a decision submitted for someone else’s session', async () => {
    current = harness()
    const h = current
    const { sessionId, cart } = await openSession(h, 'j_decision_owner')
    const { handler } = await import('../handlers/consent-decision')

    const intruderToken = await mintIdentityToken(h.base, OTHER_USER)
    const proof = consent.buildWebConfirmConsentProof(cartHash(cart), sessionId)
    const res = await handler(
      evt({ op: 'submit_consent_decision', sessionId, approved: true, consentProof: proof, identityToken: intruderToken }),
    )

    expect(res.statusCode).toBe(404)
    expect(h.evidence.entries.filter((e) => e.type === 'PAYMENT_MANDATE')).toHaveLength(0)
  })

  it('will not hand back a mandate that belongs to another session', async () => {
    current = harness()
    const h = current
    const mine = await openSession(h, 'j_mandate_mine')
    const theirs = await openSession(h, 'j_mandate_theirs', OTHER_USER)
    const decision = await import('../handlers/consent-decision')
    const { handler } = await import('../handlers/consent-mandates')

    const theirProof = consent.buildWebConfirmConsentProof(cartHash(theirs.cart), theirs.sessionId)
    const theirMandate = parse(
      await decision.handler(
        evt({
          op: 'submit_consent_decision',
          sessionId: theirs.sessionId,
          approved: true,
          consentProof: theirProof,
          identityToken: theirs.identityToken,
        }),
      ),
    ) as { paymentMandateId: string }

    // Owning *a* session is not owning *this* mandate. Reaching a mandate through a session the
    // caller does own is the whole point of routing the read through one.
    const res = await handler(
      evt({
        op: 'get_mandate',
        sessionId: mine.sessionId,
        mandateId: theirMandate.paymentMandateId,
        identityToken: mine.identityToken,
      }),
    )
    expect(res.statusCode).toBe(404)
  })
})
