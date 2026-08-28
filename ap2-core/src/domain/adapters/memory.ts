import type {
  CatalogItem,
  ConsentRepo,
  ConsentSession,
  CredentialRepo,
  EmittedMandateIds,
  IdempotencyState,
  EvidenceInput,
  EvidenceSink,
  MerchantRepo,
  MppRepo,
  NonceRepo,
  PaymentAttempt,
  PspGateway,
  RegisteredMethod,
  StoredCredential,
} from '../ports'
import type { CartMandate, CheckoutMandate, PaymentMandate, PaymentReceipt } from '../types'

/**
 * The seed catalog — a food-delivery menu. The infrastructure replicates it into the DynamoDB
 * catalog table (`ap2-core`'s `seed.ts`).
 *
 * Each item carries the attributes people actually shop by — protein, calories, ETA and delivery fee
 * — so the agent can answer "something high in protein that arrives within 20 minutes" by reasoning
 * over the search results rather than needing a bespoke query API.
 *
 * The variety is deliberate: `item_a` and `item_b` are the only "high protein AND fast (≤ 20 min)"
 * pair, which gives the model an unambiguous best answer to that combined constraint. The
 * `productId`s are stable handles used by the tests — renaming them breaks those, and a search for
 * "item" is what returns everything. Every price sits well under the sandbox PSP's decline ceiling.
 */
export const SEED_CATALOG: CatalogItem[] = [
  {
    productId: 'item_a',
    name: 'Grilled Chicken Bowl',
    description: 'Char-grilled chicken breast over brown rice, black beans and greens.',
    tags: ['high-protein', 'healthy', 'fitness', 'chicken', 'bowl', 'gluten-free'],
    unitPriceCents: 3490,
    proteinGrams: 42,
    caloriesKcal: 520,
    etaMinutes: 18,
    deliveryFeeCents: 690,
  },
  {
    productId: 'item_b',
    name: 'Protein Power Wrap',
    description: 'Grilled steak, egg and cheese in a whole-wheat wrap. Built for macros.',
    tags: ['high-protein', 'fitness', 'beef', 'wrap', 'quick'],
    unitPriceCents: 2890,
    proteinGrams: 38,
    caloriesKcal: 610,
    etaMinutes: 15,
    deliveryFeeCents: 590,
  },
  {
    productId: 'item_c',
    name: 'Salmon Poke Bowl',
    description: 'Fresh salmon, edamame, avocado and sushi rice with sesame dressing.',
    tags: ['high-protein', 'healthy', 'fish', 'bowl', 'omega-3'],
    unitPriceCents: 4290,
    proteinGrams: 33,
    caloriesKcal: 480,
    etaMinutes: 28,
    deliveryFeeCents: 890,
  },
  {
    productId: 'item_d',
    name: 'Double Smash Burger',
    description: 'Two smashed beef patties, cheddar and house sauce on a brioche bun.',
    tags: ['protein', 'beef', 'burger', 'comfort', 'indulgent'],
    unitPriceCents: 3690,
    proteinGrams: 35,
    caloriesKcal: 890,
    etaMinutes: 30,
    deliveryFeeCents: 790,
  },
  {
    productId: 'item_e',
    name: 'Margherita Pizza',
    description: 'Wood-fired pizza with San Marzano tomato, mozzarella and basil.',
    tags: ['vegetarian', 'pizza', 'italian', 'shareable'],
    unitPriceCents: 4500,
    proteinGrams: 18,
    caloriesKcal: 760,
    etaMinutes: 35,
    deliveryFeeCents: 790,
  },
  {
    productId: 'item_f',
    name: 'Caesar Salad',
    description: 'Crisp romaine, parmesan and croutons with classic Caesar dressing.',
    tags: ['healthy', 'salad', 'light', 'vegetarian', 'quick'],
    unitPriceCents: 2490,
    proteinGrams: 12,
    caloriesKcal: 320,
    etaMinutes: 16,
    deliveryFeeCents: 590,
  },
  {
    productId: 'item_g',
    name: 'Veggie Buddha Bowl',
    description: 'Roasted chickpeas, quinoa, sweet potato and tahini over leafy greens.',
    tags: ['vegan', 'healthy', 'bowl', 'plant-based', 'gluten-free'],
    unitPriceCents: 2990,
    proteinGrams: 15,
    caloriesKcal: 540,
    etaMinutes: 20,
    deliveryFeeCents: 690,
  },
  {
    productId: 'item_h',
    name: 'Chocolate Brownie',
    description: 'Warm fudgy brownie with a molten chocolate center.',
    tags: ['dessert', 'chocolate', 'sweet', 'treat'],
    unitPriceCents: 1690,
    proteinGrams: 6,
    caloriesKcal: 410,
    etaMinutes: 12,
    deliveryFeeCents: 490,
  },
]

/**
 * Free-text catalog matching: tokenize the query and match if ANY token is a substring of the id,
 * name, description or tags. An empty query returns everything ("show me the menu").
 *
 * The numeric narrowing ("protein ≥ X", "ETA ≤ 20") is deliberately *not* done here — the agent
 * receives those fields in the result and reasons over them, which is far more flexible than
 * encoding every possible filter into a query language.
 */
export function catalogMatches(item: CatalogItem, query: string): boolean {
  const haystack = [item.productId, item.name, item.description, ...item.tags]
    .join(' ')
    .toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.length === 0 || tokens.some((t) => haystack.includes(t))
}

export class MemoryEvidence implements EvidenceSink {
  entries: (EvidenceInput & { seq: number; ts: string })[] = []
  private seq = 0

  async record(e: EvidenceInput): Promise<void> {
    this.entries.push({ seq: ++this.seq, ts: new Date().toISOString(), ...e })
  }

  byJourney(journeyId: string) {
    return this.entries.filter((e) => e.journeyId === journeyId)
  }
}

export class MemoryMerchantRepo implements MerchantRepo {
  private carts = new Map<string, CartMandate>()
  /** journeyId → { cartId, ownerRef }, mirroring the DynamoDB adapter's journey index. */
  private journeyCarts = new Map<string, { cartId: string; ownerRef: string }>()

  constructor(private catalog: CatalogItem[] = SEED_CATALOG) {}

  async searchProducts(query: string): Promise<CatalogItem[]> {
    return this.catalog.filter((p) => catalogMatches(p, query))
  }

  async getProduct(productId: string) {
    return this.catalog.find((p) => p.productId === productId)
  }

  async putCart(cart: CartMandate, journeyId: string, ownerRef: string) {
    this.carts.set(cart.contents.id, cart)
    this.journeyCarts.set(journeyId, { cartId: cart.contents.id, ownerRef })
  }

  async getCart(cartId: string) {
    return this.carts.get(cartId)
  }

  async getCartByJourney(journeyId: string) {
    const entry = this.journeyCarts.get(journeyId)
    if (!entry) return undefined
    const cart = this.carts.get(entry.cartId)
    return cart ? { cart, ownerRef: entry.ownerRef } : undefined
  }
}

/** Drops the claim fields, mirroring the `REMOVE lockOwner, lockExpiresAt` the DynamoDB adapter does. */
function withoutClaim(s: ConsentSession): ConsentSession {
  const copy = { ...s }
  delete copy.lockOwner
  delete copy.lockExpiresAt
  return copy
}

export class MemoryConsentRepo implements ConsentRepo {
  private sessions = new Map<string, ConsentSession>()
  private mandates = new Map<string, PaymentMandate>()
  private checkoutMandates = new Map<string, CheckoutMandate>()

  async createSession(s: ConsentSession) {
    if (this.sessions.has(s.sessionId)) return false
    this.sessions.set(s.sessionId, s)
    return true
  }
  async getSession(sessionId: string) {
    return this.sessions.get(sessionId)
  }

  /**
   * The in-memory mirror of the conditional `UpdateItem` in `DynamoConsentRepo`.
   *
   * Node runs one turn of the event loop at a time, so a read-then-write here is atomic in a way it
   * emphatically is not against DynamoDB. It still has to be written as a single synchronous
   * transition with no `await` between the check and the write, because that is the property the
   * concurrency tests exercise — an `await` in the middle would make the local suite pass a shape
   * the cloud adapter would fail.
   */
  async claimSessionForDecision(sessionId: string, opId: string, leaseSeconds: number) {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const now = Math.floor(Date.now() / 1000)
    const claimable =
      s.status === 'PENDING' ||
      (s.status === 'PROCESSING' && (s.lockExpiresAt ?? 0) < now)
    if (!claimable) return undefined

    const claimed: ConsentSession = {
      ...s,
      status: 'PROCESSING',
      lockOwner: opId,
      lockExpiresAt: now + leaseSeconds,
    }
    this.sessions.set(sessionId, claimed)
    return claimed
  }

  async approveClaimedSession(sessionId: string, opId: string, ids: EmittedMandateIds) {
    const s = this.sessions.get(sessionId)
    if (!s || s.status !== 'PROCESSING' || s.lockOwner !== opId) return false
    this.sessions.set(sessionId, { ...withoutClaim(s), status: 'APPROVED', ...ids })
    return true
  }

  async releaseSessionClaim(sessionId: string, opId: string) {
    const s = this.sessions.get(sessionId)
    if (!s || s.status !== 'PROCESSING' || s.lockOwner !== opId) return
    this.sessions.set(sessionId, { ...withoutClaim(s), status: 'PENDING' })
  }

  async rejectSession(sessionId: string) {
    const s = this.sessions.get(sessionId)
    if (!s || s.status !== 'PENDING') return false
    this.sessions.set(sessionId, { ...s, status: 'REJECTED' })
    return true
  }
  async putMandate(id: string, mandate: PaymentMandate) {
    this.mandates.set(id, mandate)
  }
  async getMandate(id: string) {
    return this.mandates.get(id)
  }
  async putCheckoutMandate(id: string, mandate: CheckoutMandate) {
    this.checkoutMandates.set(id, mandate)
  }
  async getCheckoutMandate(id: string) {
    return this.checkoutMandates.get(id)
  }
}

export class MemoryCredentialRepo implements CredentialRepo {
  private methods = new Map<string, RegisteredMethod>()
  private credentials = new Map<string, StoredCredential>()
  /** issuanceKey → credentialId, mirroring the pointer item the DynamoDB adapter writes. */
  private byIssuanceKey = new Map<string, string>()

  async listMethods(userId: string) {
    return [...this.methods.values()].filter((m) => m.userId === userId)
  }
  async getMethod(userId: string, ref: string) {
    return this.methods.get(`${userId}#${ref}`)
  }
  async putMethod(m: RegisteredMethod) {
    this.methods.set(`${m.userId}#${m.paymentMethodRef}`, m)
  }
  async putCredential(c: StoredCredential) {
    this.credentials.set(c.contents.credential_id, c)
    // First issuance owns the key: a later one must not repoint it, or a retry would be handed the
    // newer credential while the older one is still spendable.
    if (!this.byIssuanceKey.has(c.issuanceKey)) {
      this.byIssuanceKey.set(c.issuanceKey, c.contents.credential_id)
    }
  }
  async getCredential(id: string) {
    return this.credentials.get(id)
  }
  async getCredentialByIssuanceKey(issuanceKey: string) {
    const id = this.byIssuanceKey.get(issuanceKey)
    return id ? this.credentials.get(id) : undefined
  }

  /** Single-use, atomically: false once the credential has already moved to `REDEEMED`. */
  async markRedeemed(id: string): Promise<boolean> {
    const c = this.credentials.get(id)
    if (!c || c.status === 'REDEEMED') return false
    c.status = 'REDEEMED'
    return true
  }
}

export class MemoryMppRepo implements MppRepo {
  private attempts = new Map<string, PaymentAttempt>()
  private keys = new Map<string, IdempotencyState & { owner: string; leaseExpiresAt: number }>()

  async putAttempt(a: PaymentAttempt) {
    this.attempts.set(a.paymentId, a)
  }
  async getAttempt(paymentId: string) {
    return this.attempts.get(paymentId)
  }

  /** Mirrors the conditional `PutItem` in `DynamoMppRepo` — see the note on `claimSessionForDecision`. */
  async reserveIdempotencyKey(key: string, opId: string, leaseSeconds: number) {
    const now = Math.floor(Date.now() / 1000)
    const held = this.keys.get(key)
    if (held && (held.state === 'DONE' || held.leaseExpiresAt >= now)) {
      return held.state === 'DONE' ? { state: 'DONE' as const, receipt: held.receipt } : { state: 'IN_PROGRESS' as const }
    }
    this.keys.set(key, { state: 'IN_PROGRESS', owner: opId, leaseExpiresAt: now + leaseSeconds })
    return undefined
  }

  async completeIdempotencyKey(key: string, opId: string, receipt: PaymentReceipt) {
    const held = this.keys.get(key)
    if (!held || held.state !== 'IN_PROGRESS' || held.owner !== opId) return false
    this.keys.set(key, { state: 'DONE', receipt, owner: opId, leaseExpiresAt: 0 })
    return true
  }
}

export class MemoryNonceRepo implements NonceRepo {
  /** `verifier:jti` → expiry (unix). Evicted lazily on access, mirroring DynamoDB's TTL. */
  private consumed = new Map<string, number>()

  async consumeJti(verifier: string, jti: string, expiresAtUnix: number): Promise<boolean> {
    const key = `${verifier}:${jti}`
    const now = Math.floor(Date.now() / 1000)
    const existing = this.consumed.get(key)
    if (existing !== undefined && existing >= now) return false
    this.consumed.set(key, expiresAtUnix)
    return true
  }
}

/**
 * A simulated PSP. Authorizes anything at or below the ceiling and declines above it, which is what
 * makes the decline path testable without a network call. Swapping in a real processor is a change
 * behind the `PspGateway` port and nowhere else.
 */
export class SimulatedPsp implements PspGateway {
  /** Amounts above this decline. Well above every seeded catalog price. */
  static readonly DECLINE_ABOVE_CENTS = 100_000

  async authorize(input: { amountCents: number }) {
    const status =
      input.amountCents <= SimulatedPsp.DECLINE_ABOVE_CENTS
        ? ('AUTHORIZED' as const)
        : ('DECLINED' as const)
    return { status, pspReference: 'pi_sandbox_' + Math.random().toString(16).slice(2, 12) }
  }
}
