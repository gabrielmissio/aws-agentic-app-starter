import { fetchAuthSession } from 'aws-amplify/auth'
import { parseAgentCoreStream, type StreamCallbacks } from './stream-parser'
import { readAppConfig } from './app-config'

/**
 * The chat transport. There is exactly one: the browser posts to the BFF, which invokes the
 * AgentCore runtime over SigV4 and re-streams the result.
 *
 * The browser has no path to the runtime at all, and that is a security property rather than a
 * layering preference. The agent learns who is asking from an identity block the BFF prepends to the
 * prompt, built from claims the API Gateway Cognito authorizer already verified. Were the browser to
 * speak to AgentCore directly, that block would be the opening lines of a request body it composed —
 * so anyone able to type into the chat box could name any `userId` and the agent's payment tools
 * would act for them. See `infra/src/stacks/agent-stack.ts` for the deployment-side half.
 */

const BFF_URL = readAppConfig('VITE_API_URL') ?? '/api'

export type AgentResponse = {
  sessionId: string
  content: string
}

export interface BffStreamCallbacks extends StreamCallbacks {
  onSessionId?: (sessionId: string) => void
}

/**
 * Sends a message through the BFF and streams SSE events back.
 * The BFF wraps AgentCore's raw SSE inside its own event protocol:
 *   event: session → { sessionId }
 *   event: chunk   → { content: "<raw AgentCore SSE data>" }
 *   event: done    → { ok: true, sessionId }
 *   event: error   → { error: "..." }
 */
export async function sendMessageBff(
  message: string,
  sessionId: string,
  callbacks: BffStreamCallbacks,
): Promise<void> {
  const session = await fetchAuthSession({ forceRefresh: false })
  // The ID token: a REST Cognito authorizer with no `authorizationScopes` treats whatever arrives
  // as an identity token and refuses an access token. See the note in `infra/src/stacks/bff-stack.ts`.
  const idToken = session.tokens?.idToken?.toString()
  if (!idToken) {
    throw new Error('No valid ID token. Please sign in.')
  }

  const response = await fetch(`${BFF_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: idToken,
    },
    body: JSON.stringify({ message, sessionId }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`BFF HTTP ${response.status}: ${errorText}`)
  }

  if (!response.body) {
    throw new Error('No response body from BFF')
  }

  // The BFF sends its own SSE envelope. Each "chunk" event's content
  // contains raw AgentCore SSE data. We pipe those chunks into the
  // existing AgentCore stream parser.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let eventType = ''

  // Push-based ReadableStream: reads the BFF SSE stream and forwards
  // only the inner AgentCore SSE content to the consumer.
  const agentCoreStream = new ReadableStream<Uint8Array>({
    start(controller) {
      ;(async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.substring(7).trim()
              } else if (line.startsWith('data: ')) {
                const dataStr = line.substring(6)
                try {
                  const data = JSON.parse(dataStr)
                  if (eventType === 'session' && data.sessionId) {
                    callbacks.onSessionId?.(data.sessionId)
                  } else if (eventType === 'error' && data.error) {
                    callbacks.onError(new Error(data.error))
                  } else if (eventType === 'chunk' && data.content) {
                    controller.enqueue(encoder.encode(data.content))
                  }
                } catch {
                  // Not JSON, skip
                }
              }
            }
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      })()
    },
  })

  // Parse the forwarded AgentCore events using the existing parser
  const fakeResponse = new Response(agentCoreStream)
  await parseAgentCoreStream(fakeResponse, callbacks)
}
