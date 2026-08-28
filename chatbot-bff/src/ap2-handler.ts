/**
 * The AP2 checkout routes — the human-present half of the flow, and the only surface that can move
 * money.
 *
 *   POST /intent              open the approval gate over a consent session the agent proposed
 *   POST /confirm             verify the approval, sign both mandates, settle the chain
 *   POST /decline             close a proposed checkout without paying
 *   GET  /journeys            the caller's own checkouts
 *   GET  /evidence/{journey}  the signed accountability trail for one checkout
 *   GET  /actors              the four signing actors and their public keys
 *
 * A separate Lambda from the chat handler: this one holds the HMAC secret, `sns:Publish`,
 * `kms:GetPublicKey` and invoke rights on the AP2 entities, and the function relaying untrusted
 * model output must hold none of them.
 *
 * The agent is on the other side of the same boundary — it proposes a cart and opens a consent
 * session, and everything from the approval onward happens here, behind a code it never sees.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import {
  createEntityClient,
  DEFAULT_TARGET_MPP,
  entityErrorStatus,
  entityUrlsFromEnv,
  settleAfterConsent,
  type EntityClient,
} from 'ap2-core/client'
import { cartHash, centsFromAmount, merchant } from 'ap2-core/domain'
import { createLogger } from 'ap2-core/log'
import { getActors } from './ap2/actors.js'
import { approveViaWeb } from './ap2/consent-adapter.js'
import { getJourneyEvidence } from './ap2/evidence-store.js'
import { mintCallerToken } from './ap2/identity.js'
import {
  formatAmount,
  generateOtp,
  hashOtp,
  initHmacSecret,
  MAX_OTP_ATTEMPTS,
  requiresStepUp,
  resolveAp2Route,
  resolveStepUpDelivery,
  stepUpMethodFor,
  sealIntent,
  verifyOtp,
  verifySeal,
  type SealFields,
} from './ap2/intent.js'
import {
  consumeOtpAttempt,
  getIntent,
  journeyOwner,
  listIntentsByUser,
  markDeclined,
  markSettled,
  putIntent,
  recordSagaStep,
  type IntentRecord,
} from './ap2/intent-store.js'
import { sendOtpSms } from './ap2/otp-sns.js'
import { checkRateLimit, resolveAp2RateLimitConfig } from './rate-limit.js'
import { errorBody, type ErrorCode } from './errors.js'
import { ADMIN_CORS_METHODS, jsonHeaders } from './http.js'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'

const log = createLogger({ service: 'bff-ap2' })

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'
const TARGET_MPP = process.env.TARGET_MPP ?? DEFAULT_TARGET_MPP
const INTENT_TTL_MIN = Number(process.env.INTENT_TTL_MIN ?? 5)
// ── Per-caller quota on the mutating routes ─────────────────────────────
// Unset locally, where there is no table — the check is then skipped. Only the mutating routes are
// metered: the read routes are self-scoped, and the Explorer polls them.
const RATE_LIMIT_TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME ?? ''
const AP2_RATE_LIMIT = resolveAp2RateLimitConfig()
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
const METERED_ROUTES = new Set(['openIntent', 'confirm', 'decline'])

// ── The HMAC secret, resolved once at cold start ────────────────────────
// Only the ARN is templated into the environment; the plaintext is fetched here, so it never appears
// in CloudFormation, the console, or a `lambda get-function-configuration`.
const HMAC_SECRET_ARN = process.env.HMAC_SECRET_ARN
const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION })
let hmacReady: Promise<void> | undefined

function ensureHmacReady(): Promise<void> {
  if (!hmacReady) {
    if (!HMAC_SECRET_ARN) throw new Error('HMAC_SECRET_ARN is required')
    hmacReady = secrets
      .send(new GetSecretValueCommand({ SecretId: HMAC_SECRET_ARN }))
      .then((r) => {
        initHmacSecret(r.SecretString ?? '')
      })
      .catch((err: unknown) => {
        // Clear the memo so a transient Secrets Manager failure is retried on the next invocation
        // rather than poisoning the container for its whole life.
        hmacReady = undefined
        throw err
      })
  }
  return hmacReady
}

// ── The AP2 entity client, bound to the caller it is acting for ─────────
/**
 * A client whose every entity call carries a signed assertion of **this** caller's identity — so it
 * is per request, not per container. The mint is memoized in the closure, so a `/confirm` driving
 * CP → Merchant → MPP pays for one KMS signature rather than one per hop.
 */
function ap2(sub: string): EntityClient {
  let token: Promise<string> | undefined
  return createEntityClient(entityUrlsFromEnv(), () => (token ??= mintCallerToken(sub)))
}

/** The authenticated caller, as the gateway's Cognito authorizer verified them. */
interface Caller {
  sub: string
  phone?: string
}

/**
 * Reads the caller from the authorizer's verified claims. API Gateway injects them after validating
 * signature, expiry and issuer, so a client cannot supply them — and their absence means the route
 * is misconfigured, which is why this fails closed rather than falling back to an unbound identity.
 * `stacks.test.ts` asserts every route here carries the authorizer.
 */
function callerFrom(event: APIGatewayProxyEvent): Caller | null {
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined
  const sub = claims?.sub
  if (typeof sub !== 'string' || !sub) return null

  const phone = claims?.phone_number
  return { sub, ...(typeof phone === 'string' && phone ? { phone } : {}) }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin ?? event.headers?.Origin
  const headers = jsonHeaders(ALLOWED_ORIGIN, origin, ADMIN_CORS_METHODS)

  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: JSON.stringify(body),
  })
  const fail = (statusCode: number, code: ErrorCode, ap2Code?: string) =>
    respond(statusCode, errorBody(code, ap2Code))

  const route = resolveAp2Route(event.httpMethod, event.path)
  if (route === 'preflight') return { statusCode: 204, headers, body: '' }
  if (!route) return fail(404, 'notFound')

  const caller = callerFrom(event)
  if (!caller) return fail(401, 'unauthenticated')

  // Keyed apart from the chat quota, so a conversation cannot spend the checkout budget or the
  // reverse. Otherwise /confirm's only ceiling is the stage throttle every caller shares.
  if (RATE_LIMIT_TABLE_NAME && METERED_ROUTES.has(route)) {
    const quota = await checkRateLimit(
      dynamoClient,
      RATE_LIMIT_TABLE_NAME,
      `ap2#${caller.sub}`,
      AP2_RATE_LIMIT,
    )
    if (!quota.allowed) {
      log.warn('checkout quota exhausted', { route, sub: caller.sub })
      return fail(429, 'tooManyRequests')
    }
  }

  try {
    switch (route) {
      case 'openIntent':
        return await openIntent(event, caller, respond, fail)
      case 'confirm':
        return await confirmIntent(event, caller, respond, fail)
      case 'decline':
        return await declineIntent(event, caller, respond, fail)
      case 'journeys':
        return respond(200, { journeys: await listJourneys(caller) })
      case 'journeyEvidence':
        return await readEvidence(event, caller, respond, fail)
      case 'actors':
        return respond(200, { actors: await getActors() })
    }
  } catch (err) {
    log.error('AP2 route error', { route, sub: caller.sub, err })
    return fail(500, 'internal')
  }
}

type Respond = (statusCode: number, body: unknown) => APIGatewayProxyResult
type Fail = (statusCode: number, code: ErrorCode, ap2Code?: string) => APIGatewayProxyResult

function parseJson(body: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Opens the approval gate over a consent session the agent already proposed.
 *
 * The cart is fetched from the AP2 core rather than taken from the request: the amount a user is
 * asked to approve, and the amount the seal covers, must both come from the artifact the merchant
 * signed — never from a client that has every incentive to send a smaller number.
 */
async function openIntent(
  event: APIGatewayProxyEvent,
  caller: Caller,
  respond: Respond,
  fail: Fail,
): Promise<APIGatewayProxyResult> {
  await ensureHmacReady()

  const body = parseJson(event.body)
  const sessionId = body?.sessionId
  if (!body || typeof sessionId !== 'string' || !sessionId) return fail(400, 'invalidBody')

  // A consent session is a bearer reference to a proposed purchase, so the consent surface serves
  // it only to the user it was opened for and answers anyone else exactly as it answers a session
  // id that does not exist. Both arrive here as a 404, and both are the same answer to the caller:
  // there is no session here for you. The ownership check below still stands as a second lock, on
  // the chance that a future channel reaches this route with a session it fetched some other way.
  let session
  try {
    session = await ap2(caller.sub).getConsentSession(sessionId)
  } catch (err) {
    if (entityErrorStatus(err) === 404) return fail(404, 'consentSessionNotFound')
    throw err
  }
  if (!session) return fail(404, 'consentSessionNotFound')
  if (session.userId && session.userId !== caller.sub) return fail(403, 'forbidden')

  const cart = session.cartMandate
  const details = cart.contents.payment_request.details
  const theCartHash = cartHash(cart)
  const amountCents = centsFromAmount(details.total.amount)
  const currency = details.total.amount.currency

  const items = details.display_items.map((i) => ({
    label: i.label,
    amountCents: centsFromAmount(i.amount),
  }))
  const itemCount = details.display_items.filter(
    (i) => i.label !== merchant.DELIVERY_FEE_LABEL,
  ).length
  const summary = `${cart.contents.merchant_name} — ${itemCount} item${itemCount === 1 ? '' : 's'}, total ${formatAmount(amountCents, currency)}`

  const seal = sealIntent({
    sessionId,
    cartCanonicalHash: theCartHash,
    amountCents,
    userId: caller.sub,
  })

  const stepUp = requiresStepUp({ amountCents })

  // Fail closed. An undeliverable step-up is a dead end that looks like a gate: the card renders a
  // code field, nothing arrives, and the user cannot tell a broken deployment from a slow SMS.
  // Refusing also keeps the record honest — nothing is minted, so nothing later claims a step-up.
  const delivery = stepUp ? resolveStepUpDelivery(caller) : null
  if (stepUp && !delivery) {
    log.error('checkout requires a step-up this deployment cannot deliver', {
      sub: caller.sub,
      amountCents,
      hint: 'no phone_number claim on the caller and OTP_REVEAL_IN_UI is off',
    })
    return fail(503, 'stepUpUnavailable')
  }

  const otp = stepUp ? generateOtp() : ''

  const expiresAt = new Date(Date.now() + INTENT_TTL_MIN * 60_000)
  const record: IntentRecord = {
    intentId: sessionId,
    sessionId,
    journeyId: session.journeyId,
    initiatedBy: caller.sub,
    cartHash: theCartHash,
    amountCents,
    currency,
    paymentMethodRef: session.paymentMethodRef,
    summary,
    merchantName: cart.contents.merchant_name,
    items,
    ...(delivery ? { otpHash: hashOtp(otp), otpMethod: stepUpMethodFor(delivery) } : {}),
    requiresStepUp: stepUp,
    seal,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Kept far past the approval window: the record is what the Explorer renders afterwards, so
    // expiring it with the window would erase the history of every checkout the moment it closed.
    ttl: Math.floor(expiresAt.getTime() / 1000) + 30 * 24 * 60 * 60,
  }

  // A user has one live checkout at a time. Proposing a new cart supersedes any earlier pending
  // one, so the Explorer shows a replaced cart as replaced rather than leaving two open forever.
  // Already-expired intents are left alone — they display as expired, which is what they are.
  const now = new Date()
  for (const prev of await listIntentsByUser(caller.sub)) {
    if (prev.status !== 'pending') continue
    if (prev.intentId === record.intentId) continue
    if (new Date(prev.expiresAt) < now) continue
    await markDeclined(prev.intentId, 'superseded').catch((err: unknown) => {
      // Losing a race here means someone else already closed it, which is the desired end state.
      log.warn('could not supersede an earlier intent', { intentId: prev.intentId, err })
    })
  }

  await putIntent(record)
  // Both can fire: an operator testing with a real number often keeps the reveal on as a fallback,
  // because SNS only delivers to sandbox-verified numbers and a failure there is silent.
  if (delivery?.smsTo) await sendOtpSms(delivery.smsTo, otp, summary)

  log
    .child({ journeyId: session.journeyId, intentId: record.intentId, sub: caller.sub })
    .info('checkout gate opened', {
      amountCents,
      currency,
      itemCount,
      requiresStepUp: stepUp,
      ...(delivery ? { stepUpSms: !!delivery.smsTo, stepUpRevealed: delivery.reveal } : {}),
    })

  return respond(200, {
    intentId: record.intentId,
    summary,
    seal,
    expiresAt: record.expiresAt,
    requiresStepUp: stepUp,
    ...(delivery?.reveal ? { devOtp: otp } : {}),
  })
}

/**
 * Closes the gate: verifies the approval, has the Mandate Authority sign both mandates, and settles.
 *
 * Every check here is against server-held state. The seal is re-derived from the stored fields, and
 * the step-up decision is re-derived from the sealed amount — so a client cannot present a valid
 * seal for a cheap cart alongside a claim that this one needs no code.
 */
async function confirmIntent(
  event: APIGatewayProxyEvent,
  caller: Caller,
  respond: Respond,
  fail: Fail,
): Promise<APIGatewayProxyResult> {
  await ensureHmacReady()

  const body = parseJson(event.body)
  const intentId = body?.intentId
  const seal = body?.seal
  const otp = body?.otp
  if (!body || typeof intentId !== 'string' || typeof seal !== 'string') {
    return fail(400, 'invalidBody')
  }

  const intent = await getIntent(intentId)
  if (!intent) return fail(404, 'intentNotFound')
  if (intent.initiatedBy !== caller.sub) return fail(403, 'forbidden')

  // A confirm that already succeeded is answered, not refused. The chain blocks the second payment
  // either way, but a user whose connection dropped after the charge would otherwise be told their
  // checkout was "already resolved" and never learn which way it resolved — the exact gap that
  // sends someone to try again, or to support, over a purchase that went through.
  if (intent.status === 'settled' && intent.settlement) {
    return respond(200, settlementResponse(intent, intent.settlement))
  }
  if (intent.status !== 'pending') return fail(409, 'intentResolved')
  if (new Date(intent.expiresAt) < new Date()) return fail(410, 'intentExpired')

  const sealFields: SealFields = {
    sessionId: intent.sessionId,
    cartCanonicalHash: intent.cartHash,
    amountCents: intent.amountCents,
    userId: intent.initiatedBy,
  }
  if (!verifySeal(sealFields, seal) || seal !== intent.seal) {
    log.warn('checkout seal did not verify', { intentId, sub: caller.sub })
    return fail(401, 'intentTampered')
  }

  const stepUp = requiresStepUp({ amountCents: intent.amountCents })
  if (stepUp) {
    if (typeof otp !== 'string' || !otp) return fail(400, 'otpRequired')
    if (!intent.otpHash) return fail(401, 'otpInvalid')

    // Spend the attempt first, so a correct code on the sixth try is still refused: the budget is
    // attempts, not mistakes. Exhausting it burns the intent rather than leaving it open until the
    // window closes.
    if (!(await consumeOtpAttempt(intentId, MAX_OTP_ATTEMPTS))) {
      await markDeclined(intentId, 'otpAttempts').catch(() => {})
      log.warn('checkout burnt: too many code attempts', { intentId, sub: caller.sub })
      return fail(429, 'otpAttemptsExhausted')
    }

    if (!verifyOtp(otp, intent.otpHash)) return fail(401, 'otpInvalid')
  }

  const journeyLog = log.child({ journeyId: intent.journeyId, intentId, sub: caller.sub })

  let settlement: Awaited<ReturnType<typeof settleAfterConsent>>
  try {
    // Written before the hop, not after it: a checkout that stalls here has to leave behind which
    // step it was attempting, or a timeout is indistinguishable from never having started.
    await noteSagaStep(intentId, 'approving', journeyLog)

    // 1. The Mandate Authority signs both mandates, carrying the proof of how this was authorized.
    const { cartMandate, checkoutMandate, paymentMandate } = await approveViaWeb(ap2(caller.sub), {
      sessionId: intent.sessionId,
      cartHash: intent.cartHash,
      ...(stepUp && intent.otpHash
        ? {
            otpRef: intent.otpHash,
            // Recorded when the gate opened, from the delivery that actually applied. Never assumed:
            // a code read off the response proves presence at the API, not possession of a phone,
            // and the mandate is signed — it has to say which.
            stepUpMethod: intent.otpMethod ?? ('OTP_SMS' as const),
          }
        : {}),
    })

    await noteSagaStep(intentId, 'settling', journeyLog)

    // 2. Channel-agnostic settlement: the CP issues a single-use credential, the Merchant drives the
    //    MPP, and the MPP re-verifies the whole chain before it calls the PSP.
    //    Both hops are idempotent under a retry: the CP replays the credential already issued for
    //    this request, and the MPP replays the receipt already recorded for the journey.
    settlement = await settleAfterConsent(ap2(caller.sub), {
      journeyId: intent.journeyId,
      cartMandate,
      checkoutMandate,
      paymentMandate,
      paymentMethodRef: intent.paymentMethodRef,
      targetMpp: TARGET_MPP,
    })
  } catch (err) {
    // A refusal by the chain is an outcome, not a fault: it means a verifier found something that
    // did not hold, which is the system working. Surfacing the protocol's own code lets the UI say
    // *why* rather than showing a generic failure.
    const ap2Code = ap2CodeFrom(err)
    if (ap2Code) {
      journeyLog.warn('the chain refused the checkout', { ap2Code })
      return fail(422, 'checkoutBlocked', ap2Code)
    }
    throw err
  }

  const r = settlement.receipt.contents
  const record: NonNullable<IntentRecord['settlement']> = {
    receiptId: settlement.receiptId,
    status: settlement.status,
    amountCents: r.amount?.amount ?? intent.amountCents,
    currency: r.amount?.currency ?? intent.currency,
    ...(r.psp_confirmation_id ? { pspReference: r.psp_confirmation_id } : {}),
    cartHash: r.cart_hash,
    paymentMandateHash: r.reference,
    paymentCredentialHash: r.payment_credential_hash,
  }

  await markSettled(intentId, record).catch((err: unknown) => {
    // The payment has already happened and its receipt is signed; failing the response here would
    // tell the user their purchase did not go through when it did.
    journeyLog.error('could not mark the intent settled', { err })
  })

  journeyLog.info('checkout settled', {
    status: settlement.status,
    receiptId: settlement.receiptId,
  })

  return respond(200, settlementResponse(intent, record))
}

/**
 * The checkout response, built from the stored outcome.
 *
 * One shape for both the confirm that settled the payment and a later repeat of it — a second
 * confirm answering in a different shape than the first is a difference the client would have to
 * handle, for no reason a user would recognize.
 */
function settlementResponse(
  intent: IntentRecord,
  s: NonNullable<IntentRecord['settlement']>,
): Record<string, unknown> {
  return {
    receiptId: s.receiptId,
    status: s.status,
    amount: formatAmount(s.amountCents, s.currency),
    amountCents: s.amountCents,
    currency: s.currency,
    journeyId: intent.journeyId,
    pspReference: s.pspReference,
    // The hash-linked artifacts the MPP re-verified, so the UI can show the chain it settled.
    chain: {
      cartHash: s.cartHash,
      paymentMandateHash: s.paymentMandateHash,
      paymentCredentialHash: s.paymentCredentialHash,
    },
  }
}

/** Records the hop about to be attempted. Bookkeeping — a failure here must not fail a checkout. */
async function noteSagaStep(
  intentId: string,
  step: NonNullable<IntentRecord['sagaStep']>,
  journeyLog: ReturnType<typeof log.child>,
): Promise<void> {
  await recordSagaStep(intentId, step).catch((err: unknown) => {
    journeyLog.warn('could not record the checkout step', { step, err })
  })
}

/**
 * Extracts the AP2 accountability code from an entity-client error.
 *
 * The client flattens a blocked response into `Error('AP2 blocked: CODE — message')` so the code
 * survives the SigV4 hop; this reads it back out. Matching on the prefix rather than on a typed
 * error keeps `ap2-core/client` free of a BFF-specific error class.
 */
function ap2CodeFrom(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  return /^AP2 blocked: (\w+)/.exec(err.message)?.[1]
}

/** Closes a proposed checkout the user refused. Nothing is signed and nothing is charged. */
async function declineIntent(
  event: APIGatewayProxyEvent,
  caller: Caller,
  respond: Respond,
  fail: Fail,
): Promise<APIGatewayProxyResult> {
  const body = parseJson(event.body)
  const intentId = body?.intentId
  if (!body || typeof intentId !== 'string') return fail(400, 'invalidBody')

  const intent = await getIntent(intentId)
  if (!intent) return fail(404, 'intentNotFound')
  if (intent.initiatedBy !== caller.sub) return fail(403, 'forbidden')
  if (intent.status !== 'pending') return fail(409, 'intentResolved')

  await markDeclined(intentId, 'user')
  log
    .child({ journeyId: intent.journeyId, intentId, sub: caller.sub })
    .info('checkout declined', { reason: 'user' })

  return respond(200, { status: 'declined' })
}

/** The caller's own checkouts, newest first. */
async function listJourneys(caller: Caller) {
  const intents = await listIntentsByUser(caller.sub)
  return intents.map((i) => ({
    journeyId: i.journeyId,
    intentId: i.intentId,
    summary: i.summary,
    merchantName: i.merchantName,
    items: i.items,
    paymentMethodRef: i.paymentMethodRef,
    amount: formatAmount(i.amountCents, i.currency),
    amountCents: i.amountCents,
    currency: i.currency,
    status: i.status,
    declineReason: i.declineReason,
    requiresStepUp: i.requiresStepUp,
    receiptId: i.receiptId,
    requestedAt: i.requestedAt,
    expiresAt: i.expiresAt,
  }))
}

/**
 * The signed accountability trail for one checkout.
 *
 * Self-scoped: the caller may only read a journey they themselves initiated. The trail carries no
 * instrument or PSP data, but it does reveal what someone bought and when, which is theirs alone.
 */
async function readEvidence(
  event: APIGatewayProxyEvent,
  caller: Caller,
  respond: Respond,
  fail: Fail,
): Promise<APIGatewayProxyResult> {
  const journeyId = (
    event.pathParameters?.journeyId ??
    event.path?.split('/').pop() ??
    ''
  ).trim()
  if (!journeyId) return fail(400, 'invalidBody')

  // Asked of the journey, not "does one of my intents mention it?" — a question the caller can
  // arrange the answer to by opening an intent that names it. The Merchant refuses to reuse another
  // caller's journey; this is the second lock on that door, and the one guarding the read.
  const owner = await journeyOwner(journeyId)
  if (!owner || owner !== caller.sub) return fail(403, 'forbidden')

  const rows = await getJourneyEvidence(journeyId)
  const steps = rows.map((r) => ({
    entity: r.entity,
    type: r.type,
    verified: r.verified ?? null,
    signedBy: r.signedBy,
    payloadHash: r.payloadHash,
    artifactId: r.artifactId,
    recordedAt: r.ts,
    expiresAt: r.expiresAt,
    note: r.note,
  }))

  const verifications = steps.filter((s) => s.type.startsWith('VERIFY_'))
  const blocked = steps.filter((s) => s.type.startsWith('BLOCKED_'))

  return respond(200, {
    journeyId,
    steps,
    summary: {
      total: steps.length,
      verifications: verifications.length,
      blocked: blocked.length,
      // "Every re-verification passed and nothing was blocked" — the claim the trail exists to
      // support. It requires at least one verification, so an empty trail cannot read as verified.
      allVerified:
        blocked.length === 0 &&
        verifications.length > 0 &&
        verifications.every((v) => v.verified === true),
    },
  })
}
