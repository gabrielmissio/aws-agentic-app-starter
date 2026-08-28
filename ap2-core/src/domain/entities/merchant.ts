import { randomUUID } from 'node:crypto'
import {
  cartHash,
  checkoutJwtHash,
  checkoutMandateHash,
  decodeCheckoutMandate,
  issueCartMandate,
  issueCheckoutReceipt,
  receiptHash,
  verifyCheckoutMandate,
} from '../mandates'
import { BlockedError } from '../sign'
import type { EvidenceSink, MerchantRepo, PaymentAttempt, Signer } from '../ports'
import {
  amountFromCents,
  toAp2ErrorCode,
  type CartContents,
  type CartMandate,
  type CheckoutMandate,
  type CheckoutReceipt,
  type CheckoutReceiptContents,
  type PaymentCredential,
  type PaymentItem,
  type PaymentReceipt,
} from '../types'
import type { PaymentInput } from './mpp'

export type { PaymentInput }

/**
 * What the agent hands the **Merchant** — the user-signed Checkout Mandate plus the payment token.
 *
 * It carries neither the Cart Mandate (the Merchant holds its own, via `getCartByJourney`) nor the
 * Payment Mandate (agent → CP, returned to the MPP at redeem). Per the spec's data minimization, the
 * Merchant never sees the consent proof, the instrument, or the payer's risk signals.
 */
export interface MerchantPaymentInput {
  journeyId: string
  checkoutMandate: CheckoutMandate
  credential: PaymentCredential
  idempotencyKey?: string
  /**
   * The authenticated caller, from the signed identity token, checked against the journey's owner.
   *
   * Optional so the in-process test harness and the domain suites can drive a settlement without
   * minting a token; the Lambda handler always supplies it, and `stacks.test.ts` plus the handler
   * itself are what make that non-optional in a deployment.
   */
  callerRef?: string
}

/** Hands the payment to the MPP. Injected: in-process locally, a SigV4 HTTP client in Lambda. */
export type PayViaMppFn = (input: PaymentInput) => Promise<PaymentReceipt>

/** Queries payment status at the MPP. Same injection pattern. */
export type GetPaymentStatusFn = (paymentId: string) => Promise<PaymentAttempt | undefined>

/** The Merchant returns BOTH the MPP's Payment Receipt and its own signed Checkout Receipt. */
export interface MerchantPaymentResult {
  paymentReceipt: PaymentReceipt
  checkoutReceipt: CheckoutReceipt
}

/** Merchant identity. A real deployment would source this from the operator's own configuration. */
export const MERCHANT = { id: 'merch_tasty_go_001', name: 'TastyGo Delivery (demo)' }

/** Fallback delivery fee, used when a catalog item carries no `deliveryFeeCents` of its own. */
export const BASE_DELIVERY_FEE_CENTS = 590

/** Label of the delivery-fee line in the signed cart. Callers filter on it to count real items. */
export const DELIVERY_FEE_LABEL = 'Delivery fee'

/**
 * Ceilings on a cart request. Enforced here, not only in the agent's tool schema: the schema binds
 * what the model may ask for, this binds what the Merchant will sign. The signed total feeds the
 * step-up decision and the PSP authorization, and each line item costs a `getProduct` read.
 */
export const MAX_CART_LINES = 50
export const MAX_LINE_QTY = 99
/** Ceiling on a catalog search string. The query is free text and only ever matched in memory. */
export const MAX_SEARCH_QUERY_LENGTH = 200

const CURRENCY = 'BRL'

/** Searches the catalog. Seeded into DynamoDB in the cloud, in memory locally. */
export function searchProducts(repo: MerchantRepo, query: string) {
  return repo.searchProducts(query)
}

/**
 * Rejects an out-of-bounds cart request before anything is priced or read. A `BlockedError`, not a
 * bare throw: `OUT_OF_SCOPE` maps to a 403 in the entity envelope, so the agent gets a refusal it
 * can explain rather than a 500 it should retry.
 */
export function assertCartWithinLimits(items: { productId: string; qty: number }[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BlockedError('OUT_OF_SCOPE', 'a cart needs at least one line item')
  }
  if (items.length > MAX_CART_LINES) {
    throw new BlockedError(
      'OUT_OF_SCOPE',
      `a cart may hold at most ${MAX_CART_LINES} line items (got ${items.length})`,
    )
  }
  for (const i of items) {
    if (typeof i?.productId !== 'string' || !i.productId) {
      throw new BlockedError('OUT_OF_SCOPE', 'every line item needs a productId')
    }
    if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_LINE_QTY) {
      throw new BlockedError(
        'OUT_OF_SCOPE',
        `quantity for ${i.productId} must be a whole number between 1 and ${MAX_LINE_QTY}`,
      )
    }
  }
}

/**
 * Resolves the final cart — line items and fees — as a W3C `PaymentRequest` and **signs** it as a
 * `CartMandate`.
 *
 * Everything that affects price is collected *before* signing, which is the AP2 rule: the user must
 * be approving a total that can no longer move.
 *
 * Idempotent per journey: if a signed cart already exists for this `journeyId`, that one is returned
 * rather than signing a second, differently-hashed cart for the same checkout.
 */
export async function createMerchantCart(
  repo: MerchantRepo,
  signer: Signer,
  evidence: EvidenceSink,
  journeyId: string,
  items: { productId: string; qty: number }[],
  ownerRef: string,
): Promise<CartMandate> {
  if (!ownerRef) throw new BlockedError('OUT_OF_SCOPE', 'a journey owner is required')

  const existing = await repo.getCartByJourney(journeyId)

  // A journey belongs to the caller who opened it. `journeyId` is caller-chosen and not a secret —
  // it rides in URLs and logs — and the idempotent branch below *returns the signed cart*, so
  // without this check, naming someone else's journey reads their cart.
  if (existing && existing.ownerRef !== ownerRef) {
    await evidence.record({
      journeyId,
      entity: 'merchant',
      type: 'BLOCKED_OUT_OF_SCOPE',
      verified: false,
      note: 'journey belongs to another caller',
    })
    throw new BlockedError('OUT_OF_SCOPE', `journey ${journeyId} belongs to another caller`)
  }

  if (existing) {
    await evidence.record({
      journeyId,
      entity: 'merchant',
      type: 'CART_MANDATE_IDEMPOTENT',
      artifactId: existing.cart.contents.id,
      payloadHash: cartHash(existing.cart),
      signedBy: 'merchant',
      verified: null,
      note: `idempotent: a signed cart already exists for journey ${journeyId}`,
    })
    return existing.cart
  }

  assertCartWithinLimits(items)

  const displayItems: PaymentItem[] = []
  let subtotalCents = 0
  // One order is one courier, so it pays one delivery fee — the highest among the chosen items.
  let deliveryFeeCents = 0

  for (const i of items) {
    const c = await repo.getProduct(i.productId)
    if (!c) throw new Error(`product not found in the catalog: ${i.productId}`)
    const lineCents = i.qty * c.unitPriceCents
    subtotalCents += lineCents
    deliveryFeeCents = Math.max(deliveryFeeCents, c.deliveryFeeCents ?? BASE_DELIVERY_FEE_CENTS)
    displayItems.push({
      label: `${i.qty}× ${c.name}`,
      amount: amountFromCents(lineCents, CURRENCY),
    })
  }

  displayItems.push({
    label: DELIVERY_FEE_LABEL,
    amount: amountFromCents(deliveryFeeCents, CURRENCY),
  })
  const totalCents = subtotalCents + deliveryFeeCents

  const cartId = 'cart_' + randomUUID().slice(0, 8)
  const contents: CartContents = {
    id: cartId,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [{ supported_methods: 'basic-card' }],
      details: {
        id: cartId,
        display_items: displayItems,
        total: { label: 'Total', amount: amountFromCents(totalCents, CURRENCY) },
      },
      options: { request_shipping: false },
    },
    cart_expiry: new Date(Date.now() + 10 * 60_000).toISOString(),
    merchant: { id: MERCHANT.id, name: MERCHANT.name },
    merchant_name: MERCHANT.name,
  }

  const cartMandate = await issueCartMandate(signer, contents)
  await repo.putCart(cartMandate, journeyId, ownerRef)
  await evidence.record({
    journeyId,
    entity: 'merchant',
    type: 'CART_MANDATE',
    artifactId: cartId,
    payloadHash: cartHash(cartMandate),
    signedBy: 'merchant',
    verified: null,
    note: `total ${(totalCents / 100).toFixed(2)} ${CURRENCY} · ${items.length} item${items.length === 1 ? '' : 's'}`,
  })

  return cartMandate
}

/**
 * The Merchant starts the payment with the MPP. In AP2 it is the Merchant, never the agent, that
 * drives the MPP — which is why the agent has no tool pointing at it.
 *
 * Before forwarding, it verifies the user-signed **Checkout Mandate**, that its `checkout_hash`
 * matches the **latest** cart for the journey, and that the cart has not expired — the freshness
 * check is what blocks a re-priced-then-replayed approval. It then forwards only the spec's
 * "token + checkout_jwt hash". Either outcome returns a signed Checkout Receipt.
 */
export async function initiatePayment(
  signer: Signer,
  evidence: EvidenceSink,
  repo: MerchantRepo,
  payViaMpp: PayViaMppFn,
  input: MerchantPaymentInput,
): Promise<MerchantPaymentResult> {
  // The spec `reference` for a Checkout Receipt is the hash of the Checkout Mandate it answers.
  const reference = checkoutMandateHash(input.checkoutMandate)

  const buildCheckoutReceipt = (
    over: Partial<CheckoutReceiptContents> & {
      status: CheckoutReceiptContents['status']
      checkout_hash: string
    },
  ): CheckoutReceiptContents => ({
    iss: 'merchant',
    iat: Math.floor(Date.now() / 1000),
    reference,
    receipt_id: 'crcpt_' + randomUUID().slice(0, 8),
    journey_id: input.journeyId,
    merchant_id: MERCHANT.id,
    created_at: new Date().toISOString(),
    ...over,
  })

  const recordCheckoutReceipt = (r: CheckoutReceipt) =>
    evidence.record({
      journeyId: input.journeyId,
      entity: 'merchant',
      type: 'CHECKOUT_RECEIPT',
      artifactId: r.contents.receipt_id,
      payloadHash: r.contents.checkout_hash,
      signedBy: 'merchant',
      verified: r.contents.status === 'Success' ? null : false,
      note: `merchant-signed Checkout Receipt: ${r.contents.status}${r.contents.error ? ` (${r.contents.error})` : ''}`,
    })

  const ckV = await verifyCheckoutMandate(signer, input.checkoutMandate, 'merchant')
  // On a verification failure the mandate's own `checkout_hash` is decoded (unverified) purely so the
  // rejection receipt still records which checkout was presented.
  const ckHash =
    ckV.checkoutHash ??
    (decodeCheckoutMandate(input.checkoutMandate)?.checkout_hash as string | undefined) ??
    ''

  // The Cart Mandate is the Merchant's own artifact — fetched here, never accepted from the agent.
  const stored = await repo.getCartByJourney(input.journeyId)
  const latest = stored?.cart
  // The journey's owner settles it, nobody else. Otherwise a second caller drives someone else's
  // journey to settlement, and the MPP's journey-keyed idempotency replays that receipt to the owner.
  const ownJourney = !!stored && (!input.callerRef || stored.ownerRef === input.callerRef)
  const fresh = !!latest && checkoutJwtHash(latest) === ckHash
  const notExpired = !!latest && new Date(latest.contents.cart_expiry).getTime() > Date.now()

  await evidence.record({
    journeyId: input.journeyId,
    entity: 'merchant',
    type: 'VERIFY_CHECKOUT_MANDATE',
    payloadHash: ckV.hash,
    signedBy: 'consent',
    verified: ckV.ok && ownJourney && fresh && notExpired,
    note: ckV.ok
      ? `own=${ownJourney} fresh=${fresh} notExpired=${notExpired}`
      : ckV.reason,
  })

  if (!ckV.ok || !ownJourney || !fresh || !notExpired) {
    const why = !ckV.ok
      ? ckV.reason
      : !ownJourney
        ? 'this journey belongs to another caller'
        : !fresh
          ? 'checkout_hash does not match the latest checkout_jwt for this journey'
          : 'the cart has expired'

    await evidence.record({
      journeyId: input.journeyId,
      entity: 'merchant',
      type: 'BLOCKED_INVALID_MANDATE',
      verified: false,
      note: why,
    })

    // A rejected Checkout Mandate still returns a signed Checkout Receipt.
    const rejectReceipt = await issueCheckoutReceipt(
      signer,
      buildCheckoutReceipt({
        status: 'Error',
        error: toAp2ErrorCode('INVALID_MANDATE'),
        error_description: why,
        checkout_hash: ckHash,
      }),
    )
    await recordCheckoutReceipt(rejectReceipt)

    const err = new BlockedError('INVALID_MANDATE', `invalid Checkout Mandate: ${why}`)
    err.receipt = rejectReceipt
    throw err
  }

  // `latest` is the verified, fresh, caller-owned cart guarded above. Its checkout_jwt hash is the
  // only checkout reference the MPP needs.
  const verifiedCart = latest as CartMandate
  const checkoutJwtHashValue = checkoutJwtHash(verifiedCart)

  await evidence.record({
    journeyId: input.journeyId,
    entity: 'merchant',
    type: 'MERCHANT_INITIATE_PAYMENT',
    payloadHash: cartHash(verifiedCart),
    verified: null,
    note: 'Checkout Mandate verified; starting payment with the MPP (token + checkout_jwt hash)',
  })

  let paymentReceipt: PaymentReceipt
  try {
    paymentReceipt = await payViaMpp({
      journeyId: input.journeyId,
      checkoutMandate: input.checkoutMandate,
      checkoutJwtHash: checkoutJwtHashValue,
      credential: input.credential,
      idempotencyKey: input.idempotencyKey,
    })
  } catch (e) {
    // The MPP rejected the chain — the Merchant still returns a signed Error Checkout Receipt,
    // linking the MPP's own Error Payment Receipt when it issued one.
    if (e instanceof BlockedError) {
      const rejectReceipt = await issueCheckoutReceipt(
        signer,
        buildCheckoutReceipt({
          status: 'Error',
          error: toAp2ErrorCode(e.code),
          error_description: e.message,
          checkout_hash: checkoutJwtHashValue,
          ...(e.receipt ? { payment_receipt_hash: receiptHash(e.receipt as PaymentReceipt) } : {}),
        }),
      )
      await recordCheckoutReceipt(rejectReceipt)
      e.receipt = rejectReceipt
    }
    throw e
  }

  const settled = paymentReceipt.contents.status === 'Success'
  const checkoutReceipt = await issueCheckoutReceipt(
    signer,
    buildCheckoutReceipt({
      status: settled ? 'Success' : 'Error',
      ...(settled
        ? { order_id: 'order_' + randomUUID().slice(0, 8) }
        : {
            error: 'invalid_credential' as const,
            error_description: 'the payment was not authorized by the PSP',
          }),
      checkout_hash: checkoutJwtHashValue,
      payment_receipt_hash: receiptHash(paymentReceipt),
    }),
  )
  await recordCheckoutReceipt(checkoutReceipt)

  return { paymentReceipt, checkoutReceipt }
}

/** Payment status — the Merchant forwards the question to the MPP. */
export function getPaymentStatus(
  getStatus: GetPaymentStatusFn,
  paymentId: string,
): Promise<PaymentAttempt | undefined> {
  return getStatus(paymentId)
}
