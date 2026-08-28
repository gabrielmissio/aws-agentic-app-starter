import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'

const EVIDENCE_TABLE = process.env.EVIDENCE_TABLE ?? ''

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
)

/**
 * One recorded step in the accountability trail.
 *
 * The trail carries hashes, signatures and notes — never instrument or PSP data, which `ap2-core`'s
 * conformance suite asserts directly rather than leaving to convention.
 */
export interface EvidenceRow {
  journeyId: string
  sk?: string
  entity: string
  type: string
  verified?: boolean | null
  signedBy?: string
  payloadHash?: string
  artifactId?: string
  ts?: string
  expiresAt?: string
  note?: string
}

/**
 * Reads a journey's trail, oldest first.
 *
 * The re-verifications recorded here *are* the proof the chain held: each one is an independent
 * party re-checking a signature it did not produce. Read-only by design — the BFF has no grant to
 * write to the evidence log, so the surface that displays the audit trail cannot alter it.
 */
export async function getJourneyEvidence(journeyId: string): Promise<EvidenceRow[]> {
  if (!EVIDENCE_TABLE) throw new Error('EVIDENCE_TABLE is required')

  const res = await dynamo.send(
    new QueryCommand({
      TableName: EVIDENCE_TABLE,
      KeyConditionExpression: 'journeyId = :j',
      ExpressionAttributeValues: { ':j': journeyId },
      ScanIndexForward: true,
    }),
  )
  return (res.Items ?? []) as EvidenceRow[]
}
