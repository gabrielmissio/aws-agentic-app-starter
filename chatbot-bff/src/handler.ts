import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { APIGatewayProxyEvent } from 'aws-lambda'
import type { Writable } from 'node:stream'
import { invokeAgentStream } from './agent-client.js'
import { formatSseEvent, jsonHeaders, sseHeaders, validateMessage } from './http.js'
import { checkRateLimit, resolveRateLimitConfig } from './rate-limit.js'
import { resolveSessionId } from './session.js'
import { withSessionContext } from './session-context.js'

const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN ?? ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'
// Unset locally (local.ts has no DynamoDB table to point at) — the rate-limit check below is
// skipped in that case, same treatment as any other infra-only guardrail that only exists once
// deployed. The deployed Lambda always has this set (infra/src/stacks/bff-stack.ts).
const RATE_LIMIT_TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME ?? ''
const RATE_LIMIT_CONFIG = resolveRateLimitConfig()
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })

function writeSseEvent(responseStream: Writable, event: string, data: unknown) {
  responseStream.write(formatSseEvent(event, data))
}

type RequestBody = {
  message?: string
  sessionId?: string
}

export const handler = awslambda.streamifyResponse(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async (event: APIGatewayProxyEvent, responseStream: Writable, _context) => {
    const origin = event.headers?.origin ?? event.headers?.Origin
    const method = event.httpMethod

    const httpResponseMetadata = {
      statusCode: 200,
      headers: sseHeaders(ALLOWED_ORIGIN, origin),
    }

    // This is the AWS-recommended wrapper for HTTP metadata with response streaming.
    responseStream = awslambda.HttpResponseStream.from(
      responseStream,
      httpResponseMetadata,
    )

    if (method === 'OPTIONS') {
      responseStream.end()
      return
    }

    if (method !== 'POST') {
      responseStream.destroy(
        new Error(JSON.stringify({
          statusCode: 405,
          headers: jsonHeaders(ALLOWED_ORIGIN, origin),
          body: JSON.stringify({ error: 'Method not allowed' }),
        })),
      )
      return
    }

    try {
      // The Cognito authorizer on the API Gateway route (see infra/src/stacks/bff-stack.ts) puts the
      // caller's verified claims here. Its absence means the route is misconfigured or being hit
      // some other way — either way, there is no caller identity to bind a session to, so this fails
      // closed rather than falling back to an unbound one.
      const claims = (
        event.requestContext.authorizer as
          | { claims?: { sub?: string; email?: string; name?: string } }
          | undefined
      )?.claims
      const userId = claims?.sub

      if (!userId) {
        writeSseEvent(responseStream, 'error', { error: 'Unauthenticated' })
        writeSseEvent(responseStream, 'done', { ok: false })
        responseStream.end()
        return
      }

      // Bounds how often *this caller* can invoke the agent — MAX_MESSAGE_LENGTH (see http.ts)
      // bounds how much each call costs, API_RATE_LIMIT (infra) bounds the whole account. Without
      // this layer, one authenticated client looping calls only hits the account-wide ceiling,
      // which every other caller shares.
      if (RATE_LIMIT_TABLE_NAME) {
        const rateLimit = await checkRateLimit(dynamoClient, RATE_LIMIT_TABLE_NAME, userId, RATE_LIMIT_CONFIG)

        if (!rateLimit.allowed) {
          writeSseEvent(responseStream, 'error', {
            error: 'Too many requests, try again shortly.',
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          })
          writeSseEvent(responseStream, 'done', { ok: false })
          responseStream.end()
          return
        }
      }

      const parsedBody: RequestBody = JSON.parse(event.body ?? '{}')
      const validated = validateMessage(parsedBody.message)

      if (!validated.ok) {
        writeSseEvent(responseStream, 'error', { error: validated.error })
        writeSseEvent(responseStream, 'done', { ok: false })
        responseStream.end()
        return
      }

      const message = validated.message

      // Only a session id minted for this caller is honored — see session.ts. A session id is a
      // bearer token for AgentCore conversation history; without this, one signed-in user could read
      // or continue another user's conversation just by supplying their session id.
      const sessionId = resolveSessionId(parsedBody.sessionId, userId)

      writeSseEvent(responseStream, 'session', { sessionId })

      // The agent is told who is asking, from claims the gateway authorizer verified — never from
      // anything the client sent. Its tools read that identity from the request scope, so none of
      // them has to accept a user id the model could be persuaded to change. See
      // `session-context.ts` for the contract this shares with the agent's parser.
      const stream = await invokeAgentStream({
        message: withSessionContext(
          {
            userId,
            ...(claims?.email ? { email: claims.email } : {}),
            ...(claims?.name ? { displayName: claims.name } : {}),
          },
          message,
        ),
        sessionId,
        agentRuntimeArn: AGENT_RUNTIME_ARN,
      })

      const decoder = new TextDecoder()

      for await (const value of stream) {
        const chunk = decoder.decode(value, { stream: true })
        if (chunk) {
          writeSseEvent(responseStream, 'chunk', { content: chunk })
        }
      }

      const finalChunk = decoder.decode()
      if (finalChunk) {
        writeSseEvent(responseStream, 'chunk', { content: finalChunk })
      }

      writeSseEvent(responseStream, 'done', { ok: true, sessionId })
      responseStream.end()
    } catch (err) {
      console.error('Handler error:', err)

      writeSseEvent(responseStream, 'error', {
        error: 'Internal server error',
      })
      writeSseEvent(responseStream, 'done', { ok: false })
      responseStream.end()
    }
  },
)