import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { catalogMatches } from '../domain'
import type {
  CatalogItem,
  ConsentRepo,
  ConsentSession,
  CredentialRepo,
  EmittedMandateIds,
  MerchantRepo,
  MppRepo,
  NonceRepo,
  PaymentAttempt,
  RegisteredMethod,
  StoredCredential,
} from '../domain'
import type { CartMandate, CheckoutMandate, PaymentMandate, PaymentReceipt } from '../domain'

/**
 * `removeUndefinedValues` is required, not cosmetic: spec receipts carry fields set on only one
 * outcome (`psp_confirmation_id` on success, `error` on failure, `order_id` on an accepted
 * checkout), and the marshaller rejects `undefined` map values outright. Dropping them also matches
 * JSON and JCS, which already omit undefined — so a round-trip through DynamoDB cannot change a
 * canonical hash.
 */
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
})

/** Table names come from the environment; `Ap2EntitiesStack` injects only the ones each entity needs. */
const T = {
  catalog: () => env('TABLE_CATALOG'),
  carts: () => env('TABLE_CARTS'),
  sessions: () => env('TABLE_CONSENT_SESSIONS'),
  mandates: () => env('TABLE_MANDATES'),
  methods: () => env('TABLE_PM_REGISTRY'),
  credentials: () => env('TABLE_CREDENTIALS'),
  attempts: () => env('TABLE_PAYMENT_ATTEMPTS'),
}

function env(k: string): string {
  const v = process.env[k]
  if (!v) throw new Error(`DynamoDB adapter: missing environment variable ${k}`)
  return v
}

/** True when a conditional write lost its race — the expected outcome, not an error to propagate. */
function isConditionalFailure(e: unknown): boolean {
  return e instanceof ConditionalCheckFailedException
}

export class DynamoMerchantRepo implements MerchantRepo {
  async searchProducts(query: string): Promise<CatalogItem[]> {
    // Scan + in-memory filter. Correct for a demo catalog of a few items; a production catalog wants
    // a search index, and the `catalogMatches` predicate is shared with the in-memory adapter so
    // both behave identically.
    const out = await doc.send(new ScanCommand({ TableName: T.catalog() }))
    return (out.Items ?? []).map((i) => i as CatalogItem).filter((p) => catalogMatches(p, query))
  }

  async getProduct(productId: string) {
    const out = await doc.send(new GetCommand({ TableName: T.catalog(), Key: { productId } }))
    return out.Item as CatalogItem | undefined
  }

  async putCart(cart: CartMandate, journeyId: string, ownerRef: string) {
    // Stored by cartId and stamped with journeyId and its owner, so the idempotent lookup below can
    // find it *and* tell whether the caller asking for it is the one who opened the journey.
    await doc.send(
      new PutCommand({
        TableName: T.carts(),
        Item: { cartId: cart.contents.id, journeyId, ownerRef, cart },
      }),
    )
  }

  async getCart(cartId: string) {
    const out = await doc.send(new GetCommand({ TableName: T.carts(), Key: { cartId } }))
    return out.Item?.cart as CartMandate | undefined
  }

  async getCartByJourney(journeyId: string) {
    // A scan with a filter, for the same demo-scale reason as the catalog above. A production
    // deployment wants a GSI on `journeyId`.
    const out = await doc.send(
      new ScanCommand({
        TableName: T.carts(),
        FilterExpression: 'journeyId = :j',
        ExpressionAttributeValues: { ':j': journeyId },
      }),
    )
    const item = out.Items?.[0] as { cart?: CartMandate; ownerRef?: string } | undefined
    if (!item?.cart) return undefined
    // A cart written before journeys had owners has no `ownerRef`. An empty string matches no
    // caller, so such a journey is refused rather than silently reopened to anyone — carts expire
    // in ten minutes, so the affected window is one deploy.
    return { cart: item.cart, ownerRef: item.ownerRef ?? '' }
  }
}

export class DynamoConsentRepo implements ConsentRepo {
  async createSession(s: ConsentSession): Promise<boolean> {
    try {
      await doc.send(
        new PutCommand({
          TableName: T.sessions(),
          Item: s,
          ConditionExpression: 'attribute_not_exists(sessionId)',
        }),
      )
      return true
    } catch (e) {
      if (isConditionalFailure(e)) return false
      throw e
    }
  }

  async getSession(sessionId: string) {
    const out = await doc.send(new GetCommand({ TableName: T.sessions(), Key: { sessionId } }))
    return out.Item as ConsentSession | undefined
  }

  /**
   * The claim, as one conditional `UpdateItem`.
   *
   * The condition is the whole mechanism: `PENDING`, or a `PROCESSING` whose lease has lapsed.
   * DynamoDB evaluates it against the item at write time, so of two confirmations arriving together
   * exactly one transitions and the other gets `ConditionalCheckFailed` — the outcome a
   * read-then-write in the handler cannot produce, because between its read and its write the other
   * request has already read the same `PENDING`.
   *
   * `lockExpiresAt` missing on a `PROCESSING` item makes the comparison false, so a malformed lock
   * is never taken over. That is the safe direction: a wedged session refuses payment, it does not
   * duplicate one.
   */
  async claimSessionForDecision(sessionId: string, opId: string, leaseSeconds: number) {
    const now = Math.floor(Date.now() / 1000)
    try {
      const out = await doc.send(
        new UpdateCommand({
          TableName: T.sessions(),
          Key: { sessionId },
          UpdateExpression: 'SET #s = :processing, lockOwner = :op, lockExpiresAt = :lease',
          ConditionExpression:
            'attribute_exists(sessionId) AND (#s = :pending OR (#s = :processing AND lockExpiresAt < :now))',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':processing': 'PROCESSING',
            ':pending': 'PENDING',
            ':op': opId,
            ':lease': now + leaseSeconds,
            ':now': now,
          },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return out.Attributes as ConsentSession
    } catch (e) {
      if (isConditionalFailure(e)) return undefined
      throw e
    }
  }

  /**
   * `PROCESSING → APPROVED` for the claim holder alone.
   *
   * `lockOwner = :op` is what makes a lease takeover safe. Without it, an attempt whose lease
   * lapsed mid-signature could still land its mandate ids on a session a second attempt has since
   * claimed and approved — two mandate pairs exist and the session names the wrong one.
   */
  async approveClaimedSession(sessionId: string, opId: string, ids: EmittedMandateIds) {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: T.sessions(),
          Key: { sessionId },
          UpdateExpression:
            'SET #s = :approved, paymentMandateId = :pm, checkoutMandateId = :ckm REMOVE lockOwner, lockExpiresAt',
          ConditionExpression: '#s = :processing AND lockOwner = :op',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':approved': 'APPROVED',
            ':processing': 'PROCESSING',
            ':op': opId,
            ':pm': ids.paymentMandateId,
            ':ckm': ids.checkoutMandateId,
          },
        }),
      )
      return true
    } catch (e) {
      if (isConditionalFailure(e)) return false
      throw e
    }
  }

  /**
   * Hands the claim back after a failure that signed nothing, so a legitimate retry does not have to
   * wait out the lease. Losing the condition means the lease already lapsed and someone else holds
   * it — there is nothing to release and nothing to report.
   */
  async releaseSessionClaim(sessionId: string, opId: string) {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: T.sessions(),
          Key: { sessionId },
          UpdateExpression: 'SET #s = :pending REMOVE lockOwner, lockExpiresAt',
          ConditionExpression: '#s = :processing AND lockOwner = :op',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING',
            ':processing': 'PROCESSING',
            ':op': opId,
          },
        }),
      )
    } catch (e) {
      if (!isConditionalFailure(e)) throw e
    }
  }

  async rejectSession(sessionId: string) {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: T.sessions(),
          Key: { sessionId },
          UpdateExpression: 'SET #s = :rejected',
          ConditionExpression: '#s = :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':rejected': 'REJECTED', ':pending': 'PENDING' },
        }),
      )
      return true
    } catch (e) {
      if (isConditionalFailure(e)) return false
      throw e
    }
  }

  async putMandate(id: string, mandate: PaymentMandate) {
    await doc.send(new PutCommand({ TableName: T.mandates(), Item: { mandateId: id, mandate } }))
  }

  async getMandate(id: string) {
    const out = await doc.send(new GetCommand({ TableName: T.mandates(), Key: { mandateId: id } }))
    return out.Item?.mandate as PaymentMandate | undefined
  }

  // The Checkout Mandate shares the mandates table under a `CKM#` key prefix rather than taking a
  // second table: the two are written and read together, always by id, and never scanned.
  async putCheckoutMandate(id: string, mandate: CheckoutMandate) {
    await doc.send(
      new PutCommand({ TableName: T.mandates(), Item: { mandateId: `CKM#${id}`, mandate } }),
    )
  }

  async getCheckoutMandate(id: string) {
    const out = await doc.send(
      new GetCommand({ TableName: T.mandates(), Key: { mandateId: `CKM#${id}` } }),
    )
    return out.Item?.mandate as CheckoutMandate | undefined
  }
}

export class DynamoCredentialRepo implements CredentialRepo {
  async listMethods(userId: string) {
    const out = await doc.send(
      new QueryCommand({
        TableName: T.methods(),
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
      }),
    )
    return (out.Items ?? []) as RegisteredMethod[]
  }

  async getMethod(userId: string, paymentMethodRef: string) {
    const out = await doc.send(
      new GetCommand({ TableName: T.methods(), Key: { userId, paymentMethodRef } }),
    )
    return out.Item as RegisteredMethod | undefined
  }

  async putMethod(m: RegisteredMethod) {
    await doc.send(new PutCommand({ TableName: T.methods(), Item: m }))
  }

  /**
   * Writes the credential, then a pointer item keyed by its issuance key.
   *
   * The pointer is a synthetic row in the same table — `issue#<key>`, the pattern the nonce and
   * idempotency rows already use — rather than a GSI, so idempotent issuance needs no table change.
   * It is conditional on `attribute_not_exists`: the first issuance for a mandate owns the key, and
   * a later one cannot repoint it at a fresher credential while the first is still spendable.
   */
  async putCredential(c: StoredCredential) {
    await doc.send(
      new PutCommand({
        TableName: T.credentials(),
        Item: { credentialId: c.contents.credential_id, ...c },
      }),
    )
    try {
      await doc.send(
        new PutCommand({
          TableName: T.credentials(),
          Item: {
            credentialId: `issue#${c.issuanceKey}`,
            kind: 'ISSUANCE_KEY',
            pointsTo: c.contents.credential_id,
            ttl: Math.floor(new Date(c.contents.expires_at).getTime() / 1000) + 24 * 60 * 60,
          },
          ConditionExpression: 'attribute_not_exists(credentialId)',
        }),
      )
    } catch (e) {
      if (!isConditionalFailure(e)) throw e
    }
  }

  async getCredential(id: string) {
    const out = await doc.send(
      new GetCommand({ TableName: T.credentials(), Key: { credentialId: id } }),
    )
    if (!out.Item) return undefined
    // The stored Payment Mandate rides back with the credential — the MPP re-verifies it at redeem —
    // and so does `payerRef`, which scopes the instrument lookup to the payer the CP verified.
    return {
      contents: out.Item.contents,
      status: out.Item.status,
      paymentMandate: out.Item.paymentMandate,
      payerRef: out.Item.payerRef,
      issuanceKey: out.Item.issuanceKey,
      cpAuthorization: out.Item.cpAuthorization,
    } as StoredCredential
  }

  async getCredentialByIssuanceKey(issuanceKey: string) {
    const pointer = await doc.send(
      new GetCommand({ TableName: T.credentials(), Key: { credentialId: `issue#${issuanceKey}` } }),
    )
    const id = pointer.Item?.pointsTo as string | undefined
    return id ? await this.getCredential(id) : undefined
  }

  /**
   * Single-use, enforced by the database rather than by a read-then-write in application code: the
   * conditional update only succeeds from `ISSUED`, so two concurrent redeems cannot both win.
   */
  async markRedeemed(id: string): Promise<boolean> {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: T.credentials(),
          Key: { credentialId: id },
          UpdateExpression: 'SET #s = :redeemed',
          ConditionExpression: '#s = :issued',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':redeemed': 'REDEEMED', ':issued': 'ISSUED' },
        }),
      )
      return true
    } catch (e) {
      if (isConditionalFailure(e)) return false
      throw e
    }
  }
}

/**
 * Anti-replay as a synthetic item in the credentials table, keyed `jti#<verifier>#<jti>`.
 *
 * No collision with real credential ids (which are `pc_*`) and no extra table to provision. `ttl` is
 * the token's own expiry, so DynamoDB's TTL prunes consumed nonces exactly when they stop mattering.
 */
export class DynamoNonceRepo implements NonceRepo {
  async consumeJti(verifier: string, jti: string, expiresAtUnix: number): Promise<boolean> {
    try {
      await doc.send(
        new PutCommand({
          TableName: T.credentials(),
          Item: { credentialId: `jti#${verifier}#${jti}`, kind: 'CONSUMED_JTI', ttl: expiresAtUnix },
          ConditionExpression: 'attribute_not_exists(credentialId)',
        }),
      )
      return true
    } catch (e) {
      if (isConditionalFailure(e)) return false
      throw e
    }
  }
}

export class DynamoMppRepo implements MppRepo {
  async putAttempt(a: PaymentAttempt) {
    await doc.send(new PutCommand({ TableName: T.attempts(), Item: a }))
  }

  async getAttempt(paymentId: string) {
    const out = await doc.send(new GetCommand({ TableName: T.attempts(), Key: { paymentId } }))
    return out.Item as PaymentAttempt | undefined
  }

  // Idempotency as a synthetic item in the attempts table, keyed `idem#<key>` — same reasoning as
  // the nonce repo above: no collision with real payment ids (`pay_*`), no extra table.

  /**
   * Takes the key with a conditional `PutItem` before the MPP redeems or charges anything.
   *
   * The condition admits a free key or one whose holder's lease has lapsed. Losing it is not an
   * error — it is the answer — so the item is read back and returned, which is what lets the caller
   * tell "already finished, here is the receipt" from "still running, do not start a second one".
   */
  async reserveIdempotencyKey(key: string, opId: string, leaseSeconds: number) {
    const now = Math.floor(Date.now() / 1000)
    try {
      await doc.send(
        new PutCommand({
          TableName: T.attempts(),
          Item: {
            paymentId: `idem#${key}`,
            kind: 'IDEMPOTENCY',
            st: 'IN_PROGRESS',
            ow: opId,
            leaseExpiresAt: now + leaseSeconds,
            ts: new Date().toISOString(),
          },
          ConditionExpression:
            'attribute_not_exists(paymentId) OR (st = :inprogress AND leaseExpiresAt < :now)',
          ExpressionAttributeValues: { ':inprogress': 'IN_PROGRESS', ':now': now },
        }),
      )
      return undefined
    } catch (e) {
      if (!isConditionalFailure(e)) throw e
      const held = await doc.send(
        new GetCommand({ TableName: T.attempts(), Key: { paymentId: `idem#${key}` } }),
      )
      const receipt = held.Item?.receipt as PaymentReceipt | undefined
      return receipt ? { state: 'DONE' as const, receipt } : { state: 'IN_PROGRESS' as const }
    }
  }

  async completeIdempotencyKey(key: string, opId: string, receipt: PaymentReceipt) {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: T.attempts(),
          Key: { paymentId: `idem#${key}` },
          UpdateExpression: 'SET st = :done, receipt = :r REMOVE leaseExpiresAt',
          ConditionExpression: 'st = :inprogress AND ow = :op',
          ExpressionAttributeValues: {
            ':done': 'DONE',
            ':inprogress': 'IN_PROGRESS',
            ':op': opId,
            ':r': receipt,
          },
        }),
      )
      return true
    } catch (e) {
      if (isConditionalFailure(e)) return false
      throw e
    }
  }
}
