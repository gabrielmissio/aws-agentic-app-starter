import { randomBytes } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import type { EvidenceInput, EvidenceSink } from '../domain'

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
})

/**
 * The Evidence Store: append-only, partitioned by `journeyId` and sorted by a
 * `timestamp#type#nonce` key.
 *
 * The random suffix matters — two entities can record within the same millisecond, and without it
 * the later write would silently overwrite the earlier one, losing a step from the very trail that
 * exists to be complete.
 *
 * **Append-only is enforced by the write, not only by the grant.** The entity roles hold
 * `dynamodb:PutItem` and nothing else, which stops an `UpdateItem` or a `DeleteItem` — but `PutItem`
 * on an existing key is an overwrite, so the grant alone left the audit trail editable by anything
 * that could write to it. The condition below closes that: a second write to the same key is
 * refused rather than silently replacing the first.
 */
export class DynamoEvidence implements EvidenceSink {
  private table = () => {
    const v = process.env.TABLE_EVIDENCE
    if (!v) throw new Error('Evidence store: missing environment variable TABLE_EVIDENCE')
    return v
  }

  async record(e: EvidenceInput): Promise<void> {
    const ts = new Date().toISOString()
    await doc.send(
      new PutCommand({
        TableName: this.table(),
        // `randomBytes`, not `Math.random()`: this suffix is what separates two entries written in
        // the same millisecond, and a predictable one lets a writer aim a second write at an
        // existing key. `Math.random()` is not a CSPRNG and has no place in a key on an audit trail.
        Item: { ...e, ts, sk: `${ts}#${e.type}#${randomBytes(4).toString('hex')}` },
        // The whole composite key. DynamoDB evaluates the condition against the item at that key, so
        // this succeeds only when nothing is there — an append, never a replacement.
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    )
  }

  async byJourney(journeyId: string) {
    const out = await doc.send(
      new QueryCommand({
        TableName: this.table(),
        KeyConditionExpression: 'journeyId = :j',
        ExpressionAttributeValues: { ':j': journeyId },
      }),
    )
    return out.Items ?? []
  }
}
