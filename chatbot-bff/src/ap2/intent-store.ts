import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'

const INTENTS_TABLE = process.env.INTENTS_TABLE ?? ''
const BY_USER_INDEX = 'byInitiator'
const BY_JOURNEY_INDEX = 'byJourney'

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
  { marshallOptions: { removeUndefinedValues: true } },
)

/**
 * A checkout intent — the BFF's own state, distinct from the consent session it gates.
 *
 * It binds a one-time code to exactly one consent session and signed cart, so a code cannot be
 * replayed against a different purchase. It never stores the code itself (only a keyed hash) and
 * never stores card or PSP data: the signed cart lives in the AP2 core and is fetched fresh.
 */
export interface IntentRecord {
  /** Equal to the consent session id, so an intent and the session it gates cannot drift apart. */
  intentId: string
  sessionId: string
  journeyId: string
  /** The Cognito `sub` of whoever opened the gate. Every later step is checked against it. */
  initiatedBy: string
  cartHash: string
  amountCents: number
  currency: string
  paymentMethodRef: string
  summary: string
  merchantName: string
  /** The signed cart's line items, so the Explorer can render the cart it approved. */
  items: { label: string; amountCents: number }[]
  /** Present only when a step-up was required. Absent on the one-tap path. */
  otpHash?: string
  /**
   * The step-up method this intent's code was actually delivered under, decided when the gate
   * opened. Signed into both mandates at confirm time, so it must be the real one.
   */
  otpMethod?: 'OTP_SMS' | 'OTP_SANDBOX_REVEALED'
  /** Wrong codes presented so far. Absent until the first attempt. */
  otpAttempts?: number
  /**
   * The step-up decision recorded when the gate opened, for display only.
   *
   * Never trusted for enforcement: `/confirm` re-derives it from the sealed amount, so a client
   * cannot downgrade a high-value checkout by flipping this.
   */
  requiresStepUp: boolean
  seal: string
  status: 'pending' | 'settled' | 'declined'
  /**
   * Why a declined intent closed — a deliberate refusal reads very differently from a cart the user
   * replaced, and the Explorer should not have to guess which happened.
   */
  declineReason?: 'user' | 'superseded' | 'otpAttempts'
  requestedAt: string
  expiresAt: string
  /** DynamoDB TTL (unix seconds). Set well past `expiresAt` so the record outlives its own window. */
  ttl: number
  receiptId?: string
  /**
   * How far the checkout got, written **before** each hop rather than after it.
   *
   * A checkout is several calls across four entities, and a timeout in the middle used to leave no
   * trace of where it stopped — the user saw a failure, the chain may have signed mandates or even
   * charged, and nothing on the record said which. Written ahead of each hop, a stalled checkout
   * names the last thing that was *attempted*, which is what an operator needs in order to know
   * where to look.
   */
  sagaStep?: 'approving' | 'settling'
  /**
   * The settled outcome, kept so a repeat confirm can answer with it.
   *
   * The chain refuses a second payment, but refusing is not the same as answering: a user whose
   * connection dropped after the charge would otherwise be told their checkout was already resolved
   * and never learn that it succeeded.
   */
  settlement?: {
    receiptId: string
    status: string
    amountCents: number
    currency: string
    pspReference?: string
    cartHash?: string
    paymentMandateHash?: string
    paymentCredentialHash?: string
  }
}

function table(): string {
  if (!INTENTS_TABLE) throw new Error('INTENTS_TABLE is required')
  return INTENTS_TABLE
}

export async function putIntent(item: IntentRecord): Promise<void> {
  await dynamo.send(new PutCommand({ TableName: table(), Item: item }))
}

export async function getIntent(intentId: string): Promise<IntentRecord | undefined> {
  const res = await dynamo.send(new GetCommand({ TableName: table(), Key: { intentId } }))
  return res.Item as IntentRecord | undefined
}

/**
 * The caller's own intents, newest first.
 *
 * Backed by a GSI on `initiatedBy` rather than a filtered scan: a scan reads (and bills for) every
 * intent in the table to return one user's handful, and it degrades as the table grows — which for a
 * per-user listing on a page people open repeatedly is the wrong shape from the start.
 */
export async function listIntentsByUser(sub: string): Promise<IntentRecord[]> {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: table(),
      IndexName: BY_USER_INDEX,
      KeyConditionExpression: 'initiatedBy = :u',
      ExpressionAttributeValues: { ':u': sub },
      // The sort key is `requestedAt`, so descending gives newest first without sorting in memory.
      ScanIndexForward: false,
    }),
  )
  return (res.Items ?? []) as IntentRecord[]
}

/**
 * The caller who opened this journey, or `undefined` when nobody has.
 *
 * Keyed by the journey rather than by the caller, which is the whole point. Asking "does one of my
 * intents mention this journey?" answers a question the caller can arrange the answer to; asking
 * "whose journey is this?" cannot be arranged, because the first writer wins and every later intent
 * for the same journey is refused before it is written.
 *
 * The oldest intent is authoritative: `requestedAt` ascending, first item.
 */
export async function journeyOwner(journeyId: string): Promise<string | undefined> {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: table(),
      IndexName: BY_JOURNEY_INDEX,
      KeyConditionExpression: 'journeyId = :j',
      ExpressionAttributeValues: { ':j': journeyId },
      ScanIndexForward: true,
      Limit: 1,
    }),
  )
  return (res.Items?.[0] as { initiatedBy?: string } | undefined)?.initiatedBy
}

/**
 * Consumes one code attempt, atomically. Returns false when the intent has none left.
 *
 * The conditional `ADD` is what makes the ceiling real across concurrent requests: two confirms
 * racing each other cannot both read "4 attempts used" and both proceed. Consumed *before* the code
 * is checked rather than only on failure, so a correct code presented on the sixth try is still
 * refused — the budget is attempts, not mistakes.
 */
export async function consumeOtpAttempt(intentId: string, max: number): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: table(),
        Key: { intentId },
        UpdateExpression: 'ADD otpAttempts :one',
        ConditionExpression: 'attribute_not_exists(otpAttempts) OR otpAttempts < :max',
        ExpressionAttributeValues: { ':one': 1, ':max': max },
      }),
    )
    return true
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false
    throw err
  }
}

/**
 * Records which hop the checkout is about to attempt.
 *
 * Conditional on `pending`, so it cannot reopen the story of a checkout that already finished. Best
 * effort at the call site: this is bookkeeping for recovery, and failing a checkout over it would
 * trade a real payment for a diary entry.
 */
export async function recordSagaStep(
  intentId: string,
  step: NonNullable<IntentRecord['sagaStep']>,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: table(),
      Key: { intentId },
      UpdateExpression: 'SET sagaStep = :step, sagaStepAt = :t',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':step': step,
        ':pending': 'pending',
        ':t': new Date().toISOString(),
      },
    }),
  )
}

/**
 * Marks an intent settled, with the outcome a later confirm can be answered from.
 *
 * Conditional on it still being `pending`, so two concurrent confirms cannot both record a
 * settlement. The AP2 chain already blocks the second payment as a double spend — this keeps the
 * BFF's own view of the checkout consistent with that, and stores enough to answer a repeat
 * instead of only refusing it.
 */
export async function markSettled(
  intentId: string,
  settlement: NonNullable<IntentRecord['settlement']>,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: table(),
      Key: { intentId },
      UpdateExpression:
        'SET #s = :settled, receiptId = :r, settlement = :x, settledAt = :t REMOVE sagaStep',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':settled': 'settled',
        ':pending': 'pending',
        ':r': settlement.receiptId,
        ':x': settlement,
        ':t': new Date().toISOString(),
      },
    }),
  )
}

export async function markDeclined(
  intentId: string,
  reason: IntentRecord['declineReason'] = 'user',
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: table(),
      Key: { intentId },
      UpdateExpression: 'SET #s = :declined, declineReason = :r, declinedAt = :t',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':declined': 'declined',
        ':pending': 'pending',
        ':r': reason,
        ':t': new Date().toISOString(),
      },
    }),
  )
}
