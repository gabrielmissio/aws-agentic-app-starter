import { randomUUID } from 'node:crypto'
import * as strands from '@strands-agents/sdk'
import { z } from 'zod'
import { currentCaller } from './caller'
import { Ap2BlockedError, callEntity, entityUrlsFromEnv, type EntityUrls } from './entity-client'

/**
 * The agent's **propose-only** AP2 toolset.
 *
 * Four tools, and the omissions are the design. The agent can browse, ask the Merchant to sign a
 * cart, list opaque payment references, and open a consent session — and that is all. Signing the
 * mandates, issuing a credential and settling happen in the BFF, behind an approval the agent never
 * sees. It is not that the agent is instructed not to move money; it has no tool that could.
 *
 * Identity never appears as a tool parameter. It is read from the request-scoped caller the BFF
 * vouched for, so a prompt cannot talk the agent into acting for someone else — see `caller.ts`.
 */

/**
 * Structurally identical to the SDK's un-exported `JSONValue`. Annotating each callback's return
 * with it makes TypeScript check every `return` independently, instead of widening the
 * success-or-error union into a shape the SDK's index signature rejects.
 */
type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

const money = (cents: number, currency = 'BRL'): string => `${currency} ${(cents / 100).toFixed(2)}`

/**
 * The signed cart, held server-side, keyed by **caller and** journey id.
 *
 * It never round-trips through the model: a signed artifact is large, and any reformatting by an LLM
 * would invalidate the signature it exists to carry. `create_merchant_cart` stores it here and
 * `initiate_consent_session` reads it back, both within one turn in one process.
 *
 * The caller is half the key, not bookkeeping. This map lives on a warm container that serves every
 * user in turn, and `journeyId` is chosen by the caller — so keyed on the journey alone, a second
 * user naming a journey they had heard of would be handed the first user's signed cart and could
 * open a consent session over it. The Merchant refuses to reuse another caller's journey and the
 * consent surface binds the session to the token's subject; this closes the same door one layer
 * earlier, inside the process where the two tools hand off to each other.
 */
const signedCarts = new Map<string, unknown>()
/** Bounds memory on a long-lived warm container; a cart outlives its turn by minutes at most. */
const MAX_REMEMBERED_CARTS = 200

/** `sub:journeyId`. The subject comes from the BFF-signed token, never from a tool argument. */
function cartKey(userId: string, journeyId: string): string {
  return `${userId}:${journeyId}`
}

function rememberCart(userId: string, journeyId: string, cart: unknown): void {
  signedCarts.set(cartKey(userId, journeyId), cart)
  if (signedCarts.size > MAX_REMEMBERED_CARTS) {
    const oldest = signedCarts.keys().next().value
    if (oldest !== undefined) signedCarts.delete(oldest)
  }
}

/** Renders a failure for the model: a chain refusal reads differently from a fault. */
function toolError(err: unknown): Json {
  if (err instanceof Ap2BlockedError) {
    return {
      error: `The payment chain refused this step (${err.code}). Explain this to the user; do not retry.`,
      ap2Code: err.code,
    }
  }
  return { error: err instanceof Error ? err.message : String(err) }
}

/**
 * The identity the BFF verified, or an explanation the model can relay.
 *
 * Every invocation of a correctly deployed runtime carries one: the BFF is the only caller, and it
 * always prepends the block. A turn without one therefore means the runtime was reached some other
 * way, which is exactly when these tools must not act for anyone. Browsing still works; only the
 * steps that act *for* a person are withheld.
 */
function requireCaller(): { userId: string } | { error: string } {
  const caller = currentCaller()
  if (!caller) {
    return {
      error:
        'This session carries no server-verified identity, so payment steps are unavailable here. ' +
        'Tell the user you can still browse and build a cart, but that completing a purchase is ' +
        'not possible in this session. Do not ask them to sign in again — they are.',
    }
  }
  return { userId: caller.userId }
}

interface CatalogProduct {
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

interface SignedCart {
  contents: {
    merchant_name: string
    payment_request: {
      details: {
        display_items: { label: string; amount: { value: number; currency: string } }[]
        total: { amount: { value: number; currency: string } }
      }
    }
  }
}

const toCents = (amount: { value: number }) => Math.round(amount.value * 100)

export function createAp2Tools(urls: EntityUrls) {
  const searchProducts = strands.tool({
    name: 'search_products',
    description:
      'Search the menu by free text. Returns dishes with productId, name, description, tags, ' +
      'price, protein (g), calories (kcal), ETA in minutes and delivery fee. Search broad single ' +
      'concepts ("protein", "salad", "vegan") and then filter and rank the results yourself — the ' +
      'numeric narrowing a query cannot express ("high protein AND under 20 minutes") is your job, ' +
      'and every field you need for it is in the result.',
    inputSchema: z.object({
      query: z.string().describe('Free-text menu search, e.g. "protein", "burger", "vegan"'),
    }),
    async callback({ query }): Promise<Json> {
      try {
        const products = await callEntity<CatalogProduct[]>(urls.merchantUrl, {
          op: 'search_products',
          query,
        })
        return {
          count: products.length,
          products: products.map((p) => ({
            productId: p.productId,
            name: p.name,
            description: p.description ?? null,
            tags: p.tags ?? [],
            price: money(p.unitPriceCents),
            unitPriceCents: p.unitPriceCents,
            proteinGrams: p.proteinGrams ?? null,
            caloriesKcal: p.caloriesKcal ?? null,
            etaMinutes: p.etaMinutes ?? null,
            deliveryFee: p.deliveryFeeCents != null ? money(p.deliveryFeeCents) : null,
          })),
        }
      } catch (err) {
        return toolError(err)
      }
    },
  })

  const createMerchantCart = strands.tool({
    name: 'create_merchant_cart',
    description:
      'Ask the Merchant to build and CRYPTOGRAPHICALLY SIGN the final cart — line items, fees and ' +
      'total. Call this once the user has chosen what they want. Returns a journeyId identifying ' +
      'this one checkout, plus the signed cart summary. Omit journeyId to start a new checkout; ' +
      'reuse it only within the same one.',
    inputSchema: z.object({
      journeyId: z
        .string()
        .optional()
        .describe('Reuse an existing journeyId, or omit to start a new checkout'),
      items: z
        .array(z.object({ productId: z.string(), qty: z.number().int().positive() }))
        .min(1)
        .describe('The items to buy, with the exact quantities the user asked for'),
    }),
    async callback({ journeyId, items }): Promise<Json> {
      // The signed cart is cached under this caller, so who they are has to be established before
      // one is fetched — and declining here reads better than an entity 401 relayed to the model.
      const caller = requireCaller()
      if ('error' in caller) return caller
      try {
        const jid = journeyId && journeyId.length > 0 ? journeyId : 'journey_' + randomUUID().slice(0, 8)
        const { cartMandate } = await callEntity<{ cartMandate: SignedCart }>(urls.merchantUrl, {
          op: 'create_merchant_cart',
          journeyId: jid,
          items,
        })
        rememberCart(caller.userId, jid, cartMandate)

        const details = cartMandate.contents.payment_request.details
        const currency = details.total.amount.currency
        return {
          journeyId: jid,
          merchant: cartMandate.contents.merchant_name,
          currency,
          items: details.display_items.map((i) => ({
            label: i.label,
            amount: money(toCents(i.amount), currency),
          })),
          total: money(toCents(details.total.amount), currency),
        }
      } catch (err) {
        return toolError(err)
      }
    },
  })

  const listPaymentMethods = strands.tool({
    name: 'list_payment_methods',
    description:
      "List the signed-in user's saved payment methods. You only ever receive OPAQUE references — " +
      'never card numbers, CVVs or processor data, by design. Takes no arguments: the user is ' +
      'whoever is signed in to this session.',
    inputSchema: z.object({}),
    async callback(): Promise<Json> {
      const caller = requireCaller()
      if ('error' in caller) return caller
      try {
        const methods = await callEntity<{ paymentMethodRef: string; displayName: string }[]>(
          urls.cpUrl,
          // No userId: the CP reads it from the signed identity token `callEntity` attaches.
          { op: 'list_payment_methods' },
        )
        return { methods: methods.map((m) => ({ ...m })) }
      } catch (err) {
        return toolError(err)
      }
    },
  })

  const initiateConsentSession = strands.tool({
    name: 'initiate_consent_session',
    description:
      'Open a consent session over the SIGNED cart so the user can authorize it. Call this in the ' +
      'SAME turn as create_merchant_cart and list_payment_methods — do NOT ask the user to confirm ' +
      'first, because opening this session IS the confirmation step: the app then shows them an ' +
      'authorization card. After calling, present the cart as a Markdown table and tell the user to ' +
      'authorize on screen. Never ask for, read, or repeat an authorization code.',
    inputSchema: z.object({
      journeyId: z.string().describe('The journeyId returned by create_merchant_cart'),
      paymentMethodRef: z.string().describe('The chosen paymentMethodRef from list_payment_methods'),
    }),
    async callback({ journeyId, paymentMethodRef }): Promise<Json> {
      const caller = requireCaller()
      if ('error' in caller) return caller

      // Keyed to this caller: a journeyId belonging to someone else simply is not in this map, so
      // the tool declines rather than opening a consent session over a stranger's signed cart.
      const cart = signedCarts.get(cartKey(caller.userId, journeyId))
      if (!cart) {
        return { error: 'No signed cart for that journeyId — call create_merchant_cart first.' }
      }

      try {
        const { sessionId, expiresAt } = await callEntity<{
          sessionId: string
          expiresAt: string
        }>(urls.consentUrl, {
          op: 'initiate_consent_session',
          journeyId,
          // No userId: the consent surface reads the session's owner from the identity token.
          cartMandate: cart,
          paymentMethodRef,
        })

        const details = (cart as SignedCart).contents.payment_request.details
        const currency = details.total.amount.currency
        return {
          sessionId,
          status: 'AWAITING_AUTHORIZATION',
          total: money(toCents(details.total.amount), currency),
          currency,
          expiresAt,
          message:
            'The authorization step is open. Present the cart as a Markdown table and tell the ' +
            'user to authorize on screen. Do not collect any code yourself.',
        }
      } catch (err) {
        return toolError(err)
      }
    },
  })

  return [searchProducts, createMerchantCart, listPaymentMethods, initiateConsentSession]
}

/**
 * The AP2 toolset when the entity URLs are configured, or an empty list when they are not.
 *
 * A local run with no AWS behind it simply does not offer these tools, rather than offering ones
 * that fail on every call.
 */
export function ap2Tools(env: NodeJS.ProcessEnv = process.env) {
  const urls = entityUrlsFromEnv(env)
  return urls ? createAp2Tools(urls) : []
}
