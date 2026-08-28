/**
 * Local dev server — simulates API Gateway REST API locally with SSE streaming.
 * Emits the same SSE event protocol as the Lambda handler:
 *   event: session  → { sessionId }
 *   event: chunk    → { content: "..." }
 *   event: done     → { ok: true, sessionId }
 *   event: error    → { error: "..." }
 *
 * Run with: npm run dev
 */
import { createServer, type ServerResponse } from 'node:http'
import { invokeAgentStream } from './agent-client.js'
import { formatSseEvent, validateMessage } from './http.js'
import { resolveSessionId } from './session.js'

const PORT = Number(process.env.PORT ?? 3001)
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN ?? ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'

// There is no API Gateway Cognito authorizer locally, so there is no real caller identity to bind
// a session to. Fixed on purpose: it still exercises the same namespacing path as the real handler.
const LOCAL_CALLER_ID = 'local-dev'

function writeSseEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(formatSseEvent(event, data))
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin ?? ALLOWED_ORIGIN
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN === '*' ? '*' : origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'POST') {
    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const rawBody = Buffer.concat(chunks).toString()

  let message: string
  let sessionId: string
  try {
    const body = JSON.parse(rawBody)
    const validated = validateMessage(body.message)
    if (!validated.ok) {
      for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: validated.error }))
      return
    }
    message = validated.message
    sessionId = resolveSessionId(body.sessionId, LOCAL_CALLER_ID)
  } catch {
    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })

  try {
    writeSseEvent(res, 'session', { sessionId })

    const stream = await invokeAgentStream({
      message,
      sessionId,
      agentRuntimeArn: AGENT_RUNTIME_ARN,
    })

    const decoder = new TextDecoder()

    for await (const value of stream) {
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) {
        writeSseEvent(res, 'chunk', { content: chunk })
      }
    }

    const finalChunk = decoder.decode()
    if (finalChunk) {
      writeSseEvent(res, 'chunk', { content: finalChunk })
    }

    writeSseEvent(res, 'done', { ok: true, sessionId })
    res.end()
  } catch (err) {
    console.error('Stream error:', err)
    writeSseEvent(res, 'error', { error: 'Internal server error' })
    writeSseEvent(res, 'done', { ok: false })
    res.end()
  }
})

server.listen(PORT, () => {
  console.log(`🔥 BFF dev server running on http://localhost:${PORT} (streaming SSE)`)
  console.log(`   POST http://localhost:${PORT}/chat`)
})
