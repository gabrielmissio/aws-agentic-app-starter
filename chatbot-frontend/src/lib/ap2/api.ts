import { fetchAuthSession } from 'aws-amplify/auth'
import { readAppConfig } from '../app-config'

/**
 * Client for the AP2 checkout routes.
 *
 * Separate from `lib/api.ts`, which owns the chat transport: these are plain JSON calls to the BFF
 * with no streaming, and they exist in both agent modes. Even when the browser talks to AgentCore
 * directly for chat, the approval and settlement always go through the BFF — the whole point being
 * that the browser cannot authorize a payment on its own.
 */

const API_BASE = (readAppConfig('VITE_API_URL') ?? '/api').replace(/\/chat$/, '').replace(/\/$/, '')

/** The AP2 accountability code, when the chain itself refused. */
export class CheckoutError extends Error {
  constructor(
    /** The BFF error code, which the frontend localizes. */
    public code: string,
    /** The protocol's own code (`TAMPERED`, `OUT_OF_SCOPE`, …), when the chain refused. */
    public ap2Code?: string,
  ) {
    super(code)
    this.name = 'CheckoutError'
  }
}

/**
 * The **ID token**, because that is what this authorizer accepts.
 *
 * An access token would be the OAuth-correct credential for an API, and it is deliberately not used
 * here: a REST API `COGNITO_USER_POOLS` authorizer with no `authorizationScopes` *"treats the
 * supplied token as an identity token"* and rejects an access token outright. See the note in
 * `infra/src/stacks/bff-stack.ts` for what accepting one would actually cost.
 */
async function authHeader(): Promise<Record<string, string>> {
  const session = await fetchAuthSession({ forceRefresh: false })
  const idToken = session.tokens?.idToken?.toString()
  if (!idToken) throw new CheckoutError('noSession')
  return { Authorization: idToken, 'Content-Type': 'application/json' }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: await authHeader() })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (!res.ok) {
    throw new CheckoutError(
      typeof data.code === 'string' ? data.code : 'internal',
      typeof data.ap2Code === 'string' ? data.ap2Code : undefined,
    )
  }
  return data as T
}

// ── The approval gate ───────────────────────────────────────────────────

export interface CheckoutIntent {
  intentId: string
  summary: string
  /** The HMAC seal, echoed back on confirm so the server can prove nothing changed. */
  seal: string
  expiresAt?: string
  /** `false` puts the checkout on the one-tap path; `true` requires a code. */
  requiresStepUp?: boolean
  /** The genuine code, present only in a sandbox deployment with SMS unavailable. */
  devOtp?: string
}

/**
 * Opens the approval gate over a consent session the agent proposed.
 *
 * Returns null on failure rather than throwing: a gate that fails to open should leave the
 * conversation intact — the user can ask again — not replace the agent's reply with an error.
 */
export async function openCheckout(sessionId: string): Promise<CheckoutIntent | null> {
  try {
    return await request<CheckoutIntent>('/intent', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    })
  } catch (err) {
    console.warn('[ap2] could not open the checkout gate', err)
    return null
  }
}

export interface Receipt {
  receiptId: string
  status: string
  amount: string
  amountCents: number
  currency: string
  journeyId: string
  pspReference?: string
  /** The hash-linked artifacts the processor re-verified before settling. */
  chain?: {
    cartHash: string
    paymentMandateHash: string
    paymentCredentialHash: string
  }
}

export function confirmCheckout(
  intentId: string,
  seal: string,
  otp?: string,
): Promise<Receipt> {
  return request<Receipt>('/confirm', {
    method: 'POST',
    body: JSON.stringify({ intentId, seal, ...(otp ? { otp } : {}) }),
  })
}

export async function declineCheckout(intentId: string): Promise<void> {
  await request('/decline', { method: 'POST', body: JSON.stringify({ intentId }) })
}

// ── The Explorer ────────────────────────────────────────────────────────

export interface CartLineItem {
  label: string
  amountCents: number
}

export interface JourneySummary {
  journeyId: string
  intentId: string
  summary: string
  merchantName?: string
  items?: CartLineItem[]
  paymentMethodRef?: string
  amount: string
  amountCents: number
  currency: string
  status: 'pending' | 'settled' | 'declined'
  /**
   * Why a declined journey closed: refused outright, replaced by a newer cart, or burnt by too many
   * wrong codes. Only `superseded` gets its own display status — the other two both read as
   * "declined", which is true of each.
   */
  declineReason?: 'user' | 'superseded' | 'otpAttempts'
  requiresStepUp?: boolean
  receiptId?: string
  requestedAt: string
  expiresAt: string
}

export async function fetchJourneys(): Promise<JourneySummary[]> {
  const data = await request<{ journeys?: JourneySummary[] }>('/journeys')
  return data.journeys ?? []
}

export interface EvidenceStep {
  entity: string
  type: string
  verified: boolean | null
  signedBy?: string
  /** The canonical hash of the signed artifact — the value that chains it to the next one. */
  payloadHash?: string
  artifactId?: string
  recordedAt?: string
  expiresAt?: string
  note?: string
}

export interface EvidenceTrail {
  journeyId: string
  steps: EvidenceStep[]
  summary: { total: number; verifications: number; blocked: number; allVerified: boolean }
}

export function fetchEvidence(journeyId: string): Promise<EvidenceTrail> {
  return request<EvidenceTrail>(`/evidence/${encodeURIComponent(journeyId)}`)
}

export interface Actor {
  kid: 'merchant' | 'consent' | 'cp' | 'mpp'
  role: string
  alg: string
  /** PEM public key — what an outside party needs to verify the chain themselves. */
  publicKey: string | null
}

export async function fetchActors(): Promise<Actor[]> {
  const data = await request<{ actors?: Actor[] }>('/actors')
  return data.actors ?? []
}
