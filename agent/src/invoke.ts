import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { randomUUID } from 'node:crypto'

/**
 * Invokes a deployed AgentCore runtime from a terminal, for smoke-testing without the frontend.
 *
 * SigV4 only, because that is the only way in: the runtime carries no authorizer configuration (see
 * `infra/src/stacks/agent-stack.ts`), so it accepts nothing but signed requests from an IAM identity
 * granted `bedrock-agentcore:InvokeAgentRuntime` on it. Credentials come from the ambient AWS
 * profile.
 */

const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN
const region = process.env.AWS_REGION || 'us-east-1'

if (!agentRuntimeArn) {
  throw new Error('AGENT_RUNTIME_ARN environment variable is not set.')
}

const inputText = 'Tell me what tools/skills you have and can use to help me.'
const sessionId = randomUUID()

// ── Invoke ──────────────────────────────────────────────────────────────
const client = new BedrockAgentCoreClient({ region })
const command = new InvokeAgentRuntimeCommand({
  agentRuntimeArn,
  qualifier: 'DEFAULT',
  runtimeSessionId: sessionId,
  payload: new TextEncoder().encode(inputText),
})

console.log('✅ Invoking agent via SigV4 (IAM credentials)')
const result = await client.send(command)

if (!result.response) {
  console.error('Error: No response body from agent.')
  process.exit(1)
}

const stream = result.response as unknown as ReadableStream<Uint8Array>

// ── Read SSE stream ─────────────────────────────────────────────────────
const reader = stream.getReader()
const decoder = new TextDecoder()
let fullText = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  const chunk = decoder.decode(value, { stream: true })
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.substring(6)
    if (data === '[DONE]') continue

    try {
      const event = JSON.parse(data)
      console.log(`[${event.type ?? 'unknown'}]`, JSON.stringify(event).substring(0, 200))

      if (event.type === 'modelStreamUpdateEvent') {
        const inner = event.event
        if (inner?.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta') {
          process.stdout.write(inner.delta.text)
          fullText += inner.delta.text
        }
      }
    } catch {
      // not JSON, skip
    }
  }
}

console.log('\n\n--- Full response ---')
console.log(fullText)
