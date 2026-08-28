/**
 * Pure logic for the AP2 checkout gate: sealing an approval, minting and checking a one-time code,
 * deciding when a step-up is required, and routing. Nothing here touches AWS or Lambda's event
 * shape, so the rules that decide whether money moves are unit-tested rather than only deployed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The HMAC key, resolved once at cold start from Secrets Manager. Module-level so intermediate
 * signatures do not carry a key they never use; the cost is that it must be initialized before first
 * use, which `getSecret` enforces by throwing rather than signing with an empty key.
 */
let hmacSecret = ''

export function initHmacSecret(value: string): void {
  if (!value) throw new Error('initHmacSecret: the secret must not be empty')
  hmacSecret = value
}

function getSecret(override?: string): string {
  const s = override ?? hmacSecret
  if (!s) {
    throw new Error('the HMAC secret is not initialized — initHmacSecret() must run at cold start')
  }
  return s
}

/** The fields an approval is sealed to. Changing any of them invalidates the seal. */
export interface SealFields {
  sessionId: string
  cartCanonicalHash: string
  amountCents: number
  userId: string
}

/** Deterministic serialization of the sealed fields: keys sorted, so construction order cannot
 * change the seal. */
export function canonicalIntent(fields: SealFields): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
  )
}

/**
 * Seals an intent: HMAC-SHA256 over the canonical fields, binding a one-time code to exactly one
 * session, cart, amount and user. Without it a code minted for a R$20 cart authorizes a R$2,000 one
 * — a code proves someone is present, not what they agreed to.
 */
export function sealIntent(fields: SealFields, secret?: string): string {
  return createHmac('sha256', getSecret(secret)).update(canonicalIntent(fields)).digest('hex')
}

/** Constant-time comparison of a presented seal against the expected one. */
export function verifySeal(fields: SealFields, provided: string, secret?: string): boolean {
  const expected = sealIntent(fields, secret)
  // `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal — so the
  // lengths are compared first and a mismatch short-circuits before the buffers are built.
  if (expected.length !== provided.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}

/** A cryptographically random 6-digit one-time code. */
export function generateOtp(): string {
  return String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0')
}

/**
 * Hashes a one-time code for storage. HMAC rather than a bare digest: a 6-digit code has a million
 * possibilities, so a plain SHA-256 is reversible by anyone who can read the table.
 */
export function hashOtp(otp: string, secret?: string): string {
  return createHmac('sha256', getSecret(secret)).update(otp).digest('hex')
}

/** Constant-time check of a presented code against its stored hash. */
export function verifyOtp(otp: string, storedHash: string, secret?: string): boolean {
  const expected = hashOtp(otp, secret)
  if (expected.length !== storedHash.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(storedHash))
}

// ── Risk policy ─────────────────────────────────────────────────────────

/** The default step-up threshold, in minor units. Mirrors the infra resolver's default. */
export const DEFAULT_STEPUP_THRESHOLD_CENTS = 10_000

/** The configured step-up threshold, in minor units. Read per call so a test can vary it. */
export function stepUpThresholdCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OTP_STEPUP_THRESHOLD_CENTS ?? DEFAULT_STEPUP_THRESHOLD_CENTS)
  // Unparseable falls back to zero — "always step up", the safe direction. The infra resolver
  // rejects bad values at synth time, so reaching this branch means someone set the var by hand.
  return Number.isFinite(raw) ? raw : 0
}

/** Signals the step-up decision is made from. Extend this rather than the callers. */
export interface RiskInput {
  amountCents: number
}

/**
 * Whether this checkout needs a one-time code. Evaluated when the gate opens and **re-evaluated from
 * the sealed amount** when it closes, so a client cannot downgrade a high-value cart by flipping a
 * flag. A threshold of zero or less means every payment steps up.
 */
export function requiresStepUp(input: RiskInput, env: NodeJS.ProcessEnv = process.env): boolean {
  const threshold = stepUpThresholdCents(env)
  if (threshold <= 0) return true
  return input.amountCents >= threshold
}

/**
 * How many wrong codes an approval survives before it is burnt. The TTL and the gateway throttle
 * bound how many guesses fit in the window, but neither limits *attempts* — a wrong code leaves the
 * intent `pending`. Five is enough for fat fingers and far short of useful.
 */
export const MAX_OTP_ATTEMPTS = 5

/**
 * How a one-time code can reach this caller, or `null` when it cannot. `requiresStepUp` decides
 * whether a code is *needed*; this decides whether one can be *sent*. Cognito emits `phone_number`
 * only when the user has one and nothing here sets it, so on a default deployment the sandbox reveal
 * is the only channel — without this check the UI opens a code field nobody can fill.
 *
 * The two deliveries are **independent, not alternatives**: SNS reaches only sandbox-verified
 * numbers and `sendOtpSms` swallows its own errors, so an operator testing with a real phone wants
 * the on-screen code as a fallback. Making them exclusive yields a checkout with no code at all.
 */
export interface StepUpDelivery {
  /** Number to text the code to. Absent when the caller has no phone claim. */
  smsTo?: string
  /** Return the real code in the response body. Gated on an exact `'true'`, read per call. */
  reveal: boolean
}

export function resolveStepUpDelivery(
  caller: { phone?: string },
  env: NodeJS.ProcessEnv = process.env,
): StepUpDelivery | null {
  const reveal = env.OTP_REVEAL_IN_UI === 'true'
  if (!caller.phone && !reveal) return null
  return { ...(caller.phone ? { smsTo: caller.phone } : {}), reveal }
}

/**
 * Which step-up method the signed mandate records: the **weakest** channel that carried the code,
 * not the strongest. Once it is in the response body anyone who can read that has it, and an SMS
 * alongside does not undo that — so the attestation says `OTP_SANDBOX_REVEALED`.
 */
export function stepUpMethodFor(
  delivery: StepUpDelivery,
): 'OTP_SMS' | 'OTP_SANDBOX_REVEALED' {
  return delivery.reveal ? 'OTP_SANDBOX_REVEALED' : 'OTP_SMS'
}

// ── Routing ─────────────────────────────────────────────────────────────

export type Ap2Route =
  | 'preflight'
  | 'openIntent'
  | 'confirm'
  | 'decline'
  | 'journeys'
  | 'journeyEvidence'
  | 'actors'

/**
 * Resolves an AP2 route, or `null` for anything unrecognized. A closed set matched exactly rather
 * than prefix tests through the handler, so "which requests reach settlement" is readable in one
 * place and assertable in a test.
 */
export function resolveAp2Route(method: string | undefined, rawPath: string | undefined): Ap2Route | null {
  if (method === 'OPTIONS') return 'preflight'

  const path = (rawPath ?? '').replace(/\/+$/, '') || '/'

  if (method === 'POST') {
    if (path === '/intent') return 'openIntent'
    if (path === '/confirm') return 'confirm'
    if (path === '/decline') return 'decline'
    return null
  }

  if (method === 'GET') {
    if (path === '/journeys') return 'journeys'
    if (path === '/actors') return 'actors'
    if (path.startsWith('/evidence/') && path.slice('/evidence/'.length).length > 0) {
      return 'journeyEvidence'
    }
  }

  return null
}

/** Formats minor units for display, e.g. `BRL 41.80`. */
export function formatAmount(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`
}
