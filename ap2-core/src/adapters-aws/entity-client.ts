import { sigv4PostJson } from './sigv4'
import type {
  CartMandate,
  CheckoutMandate,
  CheckoutReceipt,
  ConsentProof,
  ConsentSession,
  MerchantPaymentInput,
  PaymentCredential,
  PaymentMandate,
  PaymentReceipt,
} from '../domain'

/**
 * SigV4 client for the AP2 entities — one call is one signed POST to an entity's Lambda Function URL
 * (`AuthType=AWS_IAM`).
 *
 * Shared by the BFF's AP2 handler and by any future channel adapter, so the entity contract is
 * expressed in exactly one place. Every method returns the **canonical** artifacts, never a
 * flattened view of them: the whole point is that the signatures survive the hop.
 */
export interface EntityUrls {
  merchantUrl: string
  /** Consent **sessions**: open, read, poll. Callable by the agent; signs nothing. */
  consentUrl: string
  /**
   * The Mandate Authority — `submit_consent_decision`, and nothing else.
   *
   * A separate URL on a separate function because Function-URL IAM cannot scope a principal to one
   * operation: while this shared the consent URL, anything allowed to open a session was also
   * allowed, at the IAM layer, to have mandates signed. Only the checkout Lambda holds invoke here.
   */
  consentDecisionUrl: string
  cpUrl: string
}

/** The MPP a credential is scoped to. MUST match `ALLOWED_MPPS` on the MPP Lambda. */
export const DEFAULT_TARGET_MPP = 'mpp-sandbox-001'

export interface CatalogProduct {
  productId: string
  name: string
  unitPriceCents: number
  description?: string
  tags?: string[]
  proteinGrams?: number
  caloriesKcal?: number
  etaMinutes?: number
  deliveryFeeCents?: number
}

export interface PaymentMethod {
  paymentMethodRef: string
  displayName: string
}

export interface ConsentDecisionResult {
  status: string
  paymentMandateId?: string
  checkoutMandateId?: string
}

export interface ConsentStatusResult {
  status: string
  paymentMandateId?: string
  checkoutMandateId?: string
  cartMandate?: CartMandate
  checkoutMandate?: CheckoutMandate
  paymentMandate?: PaymentMandate
}

export interface PaymentResult {
  status: string
  receiptId: string
  paymentId?: string
  receipt: PaymentReceipt
  checkoutReceipt?: CheckoutReceipt
}

export interface EntityClient {
  searchProducts(query: string): Promise<CatalogProduct[]>
  createMerchantCart(
    journeyId: string,
    items: { productId: string; qty: number }[],
  ): Promise<{ cartMandate: CartMandate; journeyId: string }>
  /** The user comes from the identity token, never from an argument — see `domain/identity.ts`. */
  listPaymentMethods(): Promise<PaymentMethod[]>
  initiateConsentSession(args: {
    journeyId: string
    cartMandate: CartMandate
    paymentMethodRef: string
  }): Promise<{ sessionId: string; expiresAt: string }>
  getConsentSession(sessionId: string): Promise<ConsentSession>
  submitConsentDecision(args: {
    sessionId: string
    approved: boolean
    consentProof?: ConsentProof
  }): Promise<ConsentDecisionResult>
  pollConsentStatus(sessionId: string): Promise<ConsentStatusResult>
  requestPaymentCredential(args: {
    journeyId: string
    cartMandate: CartMandate
    paymentMandate: PaymentMandate
    paymentMethodRef: string
    targetMpp: string
  }): Promise<PaymentCredential>
  initiatePayment(input: MerchantPaymentInput): Promise<PaymentResult>
}

/**
 * Supplies the caller identity token for the request being served.
 *
 * A function rather than a value because the client is built once per container while the token is
 * per-caller and short-lived. Returning `undefined` produces a call with no identity, which the
 * entities refuse with 401 — there is deliberately no way to send a `userId` instead.
 */
export type IdentityTokenProvider = () => Promise<string | undefined> | string | undefined

export function createEntityClient(
  urls: EntityUrls,
  identity?: IdentityTokenProvider,
): EntityClient {
  const { merchantUrl, consentUrl, consentDecisionUrl, cpUrl } = urls
  const post = <T,>(url: string, payload: Record<string, unknown>) =>
    postSigned<T>(url, payload, identity)

  return {
    searchProducts: (query) => post(merchantUrl, { op: 'search_products', query }),
    createMerchantCart: (journeyId, items) =>
      post(merchantUrl, { op: 'create_merchant_cart', journeyId, items }),
    listPaymentMethods: () => post(cpUrl, { op: 'list_payment_methods' }),
    initiateConsentSession: (args) => post(consentUrl, { op: 'initiate_consent_session', ...args }),
    getConsentSession: (sessionId) => post(consentUrl, { op: 'get_consent_session', sessionId }),
    submitConsentDecision: (args) =>
      post(consentDecisionUrl, { op: 'submit_consent_decision', ...args }),
    pollConsentStatus: (sessionId) => post(consentUrl, { op: 'poll_consent_status', sessionId }),
    requestPaymentCredential: async (args) => {
      const res = await post<{ credential: PaymentCredential }>(cpUrl, {
        op: 'request_payment_credential',
        ...args,
      })
      return res.credential
    },
    initiatePayment: (input) => post(merchantUrl, { op: 'initiate_payment', ...input }),
  }
}

export interface SettleArgs {
  journeyId: string
  cartMandate: CartMandate
  checkoutMandate: CheckoutMandate
  paymentMandate: PaymentMandate
  paymentMethodRef: string
  targetMpp?: string
}

/**
 * Post-consent settlement — **channel-agnostic**.
 *
 * Once the consent surface has signed both mandates, this closes the chain: the CP issues a
 * single-use credential, then the Merchant drives the MPP (which re-verifies everything and settles
 * at the PSP). A WhatsApp or voice adapter would call this exact function; only the step that
 * produces the consent proof differs per channel.
 */
export async function settleAfterConsent(
  client: EntityClient,
  args: SettleArgs,
): Promise<{ credential: PaymentCredential } & PaymentResult> {
  const credential = await client.requestPaymentCredential({
    journeyId: args.journeyId,
    cartMandate: args.cartMandate,
    paymentMandate: args.paymentMandate,
    paymentMethodRef: args.paymentMethodRef,
    targetMpp: args.targetMpp ?? DEFAULT_TARGET_MPP,
  })

  // The Merchant call carries only the Checkout Mandate and the token. The Cart and Payment Mandates
  // were consumed by the CP above and deliberately never reach the Merchant.
  const payment = await client.initiatePayment({
    journeyId: args.journeyId,
    checkoutMandate: args.checkoutMandate,
    credential,
  })

  return { credential, ...payment }
}

/** Reads the entity URLs from the environment. The entities stack exports them as stack outputs. */
export function entityUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): EntityUrls {
  const req = (name: string): string => {
    const v = env[name]
    if (!v) throw new Error(`${name} is required (the AP2 entities stack exports it as an output)`)
    return v
  }
  return {
    merchantUrl: req('MERCHANT_URL'),
    consentUrl: req('CONSENT_URL'),
    consentDecisionUrl: req('CONSENT_DECISION_URL'),
    cpUrl: req('CP_URL'),
  }
}

/**
 * Signed POST to an entity URL, carrying the caller identity token when one is available.
 *
 * SigV4 authenticates the *component* making the call; `identityToken` authenticates the *user* it
 * is calling for. Both are needed, and neither substitutes for the other.
 *
 * A `blocked: true` body is an AP2 accountability outcome, not a transport failure — it is re-thrown
 * with its code intact so the caller can distinguish "the chain refused this" from "the call failed".
 */
async function postSigned<T>(
  url: string,
  payload: Record<string, unknown>,
  identity?: IdentityTokenProvider,
): Promise<T> {
  const identityToken = await identity?.()
  const res = await sigv4PostJson(url, identityToken ? { ...payload, identityToken } : payload)
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (data?.blocked) throw new Error(`AP2 blocked: ${data.code} — ${data.message}`)
  if (!res.ok) {
    // The status rides along, so a caller can tell "the entity refused this request" from "the call
    // failed". Without it a 404 from an entity is indistinguishable from a network fault, and the
    // only honest answer left to give a user is a 500 — for something that was not an error.
    throw Object.assign(
      new Error((data?.error as string) ?? `entity call failed (${res.status})`),
      { status: res.status },
    )
  }
  return data as T
}

/** The HTTP status an entity refused with, when the failure came from an entity at all. */
export function entityErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}
