import { DynamoEvidence } from '../adapters-aws'
import type { EvidenceInput } from '../domain'
import { handle, HttpError, ok, type LambdaEvent } from '../http'
import * as v from '../validate'

/**
 * Evidence Store Lambda — `POST /evidence` to append, `GET /evidence/journeys/{id}` to read.
 *
 * The entities also write directly through `DynamoEvidence`; this function exists so the trail has
 * an HTTP surface of its own, independent of any entity that might be down.
 */
const store = new DynamoEvidence()

export const handler = (event: LambdaEvent) =>
  handle('evidence', event, async ({ event: e, body }) => {
    const method = e.requestContext?.http?.method ?? 'POST'
    const path = e.rawPath ?? ''

    if (method === 'GET' && path.includes('/evidence/journeys/')) {
      const journeyId = e.pathParameters?.journeyId ?? path.split('/').pop()
      if (!journeyId) throw new HttpError(400, 'journeyId is required')
      // The id becomes a DynamoDB partition key, so it is bounded here rather than at the query.
      return ok({ journeyId, trail: await store.byJourney(v.identifier().parse(journeyId, 'journeyId')) })
    }

    if (method === 'POST') {
      // This is the one place a request body used to be written to DynamoDB *whole*: `record(body)`
      // stored every attribute a caller chose to send, under names nothing checked, in the table
      // whose entire purpose is to be trustworthy afterwards. Now the record is assembled from
      // named, bounded fields, and anything else is a rejection.
      const entry = v.parseRequest(body, {
        journeyId: v.identifier(),
        entity: v.identifier(32),
        type: v.text({ max: 64, pattern: /^[A-Z][A-Z0-9_]*$/ }),
        artifactId: v.optional(v.identifier()),
        payloadHash: v.optional(v.text({ max: 128 })),
        signatureB64: v.optional(v.text({ max: 1024 })),
        signedBy: v.optional(v.identifier(32)),
        verified: v.optional(v.flag()),
        note: v.optional(v.text({ max: 1024 })),
        expiresAt: v.optional(v.text({ max: 40 })),
        artifact: v.optional(v.compact()),
      })

      await store.record(entry as EvidenceInput)
      return ok({ recorded: true }, 201)
    }

    throw new HttpError(400, 'unsupported route')
  })
