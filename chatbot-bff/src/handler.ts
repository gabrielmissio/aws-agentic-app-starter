import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import type { APIGatewayProxyEvent } from 'aws-lambda'
import type { Writable } from 'node:stream'
import { invokeAgentStream } from './agent-client.js'
import { conversationIndexUpdate, deriveTitle, resolveRetentionDays } from './conversations.js'
import { CORRELATION_HEADER, logEvent, resolveCorrelationId, traceParentFrom } from './correlation.js'
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
// Likewise: unset locally, always set once deployed. Without it a conversation still works and is
// still persisted by the agent — it just never appears in the sidebar.
const CONVERSATION_TABLE_NAME = process.env.CONVERSATION_TABLE_NAME ?? ''
const RETENTION_DAYS = resolveRetentionDays(process.env.CONVERSATION_RETENTION_DAYS)
const RATE_LIMIT_CONFIG = resolveRateLimitConfig()
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })

function writeSseEvent(responseStream: Writable, event: string, data: unknown) {
  responseStream.write(formatSseEvent(event, data))
}

/**
 * The X-Ray root for this invocation, when active tracing is on. Read per request, not once at cold
 * start: Lambda rewrites this variable on every invocation, so a cached value would staple every
 * turn on a warm container to the trace of the first one.
 */
function currentTraceId(): string | undefined {
  return process.env._X_AMZN_TRACE_ID?.split(';')[0]?.replace('Root=', '') || undefined
}

/**
 * Names the conversation and bumps its recency, so it appears in the user's sidebar.
 *
 * Never fatal. The agent has already been given the turn by the time this matters, and a failed
 * index write costs a sidebar entry — refusing the conversation over it would trade a cosmetic
 * failure for a total one.
 */
async function recordConversation(
  userId: string,
  sessionId: string,
  message: string,
  fields: { correlationId: string },
): Promise<void> {
  if (!CONVERSATION_TABLE_NAME) return

  try {
    await dynamoClient.send(
      new UpdateItemCommand(
        conversationIndexUpdate({
          tableName: CONVERSATION_TABLE_NAME,
          userId,
          sessionId,
          title: deriveTitle(message),
          retentionDays: RETENTION_DAYS,
        }),
      ),
    )
  } catch (err) {
    logEvent('error', 'conversation.index.failed', {
      correlationId: fields.correlationId,
      actorSub: userId,
      sessionId,
      reason: err instanceof Error ? err.name : 'unknown',
    })
  }
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
    const correlationId = resolveCorrelationId(event.headers)

    const httpResponseMetadata = {
      statusCode: 200,
      headers: {
        ...sseHeaders(ALLOWED_ORIGIN, origin),
        // Echoed so the browser can show the id a user quotes when reporting a bad answer.
        [CORRELATION_HEADER]: correlationId,
      },
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
        logEvent('error', 'chat.unauthenticated', { correlationId })
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
          logEvent('info', 'chat.rate-limited', { correlationId, actorSub: userId })
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
      // bearer token for AgentCore conversation history, so without this, one signed-in user could
      // read or continue another user's conversation just by supplying their session id.
      const sessionId = resolveSessionId(parsedBody.sessionId, userId)

      writeSseEvent(responseStream, 'session', { sessionId, correlationId })

      await recordConversation(userId, sessionId, message, { correlationId })

      logEvent('info', 'chat.invoke', {
        correlationId,
        actorSub: userId,
        sessionId,
        messageLength: message.length,
      })

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
        correlationId,
        ...(currentTraceId() ? { traceId: currentTraceId() as string } : {}),
        // The same segment, in the format the agent's OTel propagator understands. Sending both is
        // deliberate: `traceId` is what X-Ray and the AgentCore service span use, `traceParent` is
        // what joins the container's spans to that same tree instead of starting a second one.
        ...(traceParentFrom(process.env._X_AMZN_TRACE_ID)
          ? { traceParent: traceParentFrom(process.env._X_AMZN_TRACE_ID) as string }
          : {}),
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
      // Structured, and carrying the correlation id: an error the user reports has to be findable
      // from what they can see, and the only thing they can see is that id.
      logEvent('error', 'chat.failed', {
        correlationId,
        reason: err instanceof Error ? err.name : 'unknown',
        message: err instanceof Error ? err.message : String(err),
      })

      writeSseEvent(responseStream, 'error', {
        error: 'Internal server error',
      })
      writeSseEvent(responseStream, 'done', { ok: false })
      responseStream.end()
    }
  },
)
