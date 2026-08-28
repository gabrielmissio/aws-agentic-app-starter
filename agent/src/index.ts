import express, { type NextFunction, type Request, type Response } from 'express'
import { createAgent } from './agent'
import { MAX_BODY_BYTES, MAX_BODY_LENGTH } from './limits'
import { parsePrompt, withCaller } from './caller'

const app = express()
const PORT = process.env.PORT || 8080

// Conversation history, keyed by AgentCore session id, evicted after 30 idle minutes.
//
// Local to the container process: lost on restart, not shared across replicas. A durable deployment
// replaces this with the Strands SDK's SessionManager over a persistent store.
const SESSION_TTL_MS = 30 * 60 * 1000
type ConversationHistory = ReturnType<typeof createAgent>['messages']
const conversationStore = new Map<string, { history: ConversationHistory; lastAccess: number }>()

function evictStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, entry] of conversationStore) {
    if (entry.lastAccess < cutoff) conversationStore.delete(id)
  }
}

// Required by AgentCore.
app.get('/ping', (_: Request, res: Response) =>
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  })
)

// Required by AgentCore. The payload arrives binary, hence `express.raw`.
app.post(
  '/invocations',
  express.raw({ type: '*/*', limit: MAX_BODY_BYTES }),
  async (req: Request, res: Response) => {
    try {
      const raw = new TextDecoder().decode(req.body)

      if (raw.length > MAX_BODY_LENGTH) {
        return res.status(413).json({ error: `Body exceeds ${MAX_BODY_LENGTH} characters` })
      }

      // Splitting the BFF's identity block off here binds the caller to the request's async
      // context, where tools read it — so no tool needs a user id parameter. See caller.ts.
      const { caller, message: prompt } = parsePrompt(raw)

      // AgentCore forwards the session id as a header; it keys this conversation's history.
      const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined
      evictStaleSessions()
      const prior = sessionId ? conversationStore.get(sessionId)?.history : undefined

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      // The WHOLE stream is consumed inside the scope, not merely created inside it: a generator's
      // body inherits the context active while it is *iterated*, so binding at creation would leave
      // every tool callback seeing no caller. `__tests__/caller.test.ts` pins this down.
      await withCaller(caller, async () => {
        const agent = createAgent(prior)
        for await (const event of agent.stream(prompt)) {
          const json = JSON.stringify(event)
          res.write(`data: ${json}\n\n`)
        }
        if (sessionId) {
          conversationStore.set(sessionId, { history: agent.messages, lastAccess: Date.now() })
        }
      })

      res.write('data: [DONE]\n\n')
      res.end()
    } catch (err) {
      console.error('Error processing request:', err)
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Internal server error' })
      }
      res.end()
    }
  },
)

// `express.raw()` rejects an oversized body before the route runs. Without this, Express's default
// handler would answer with an HTML error page rather than the JSON callers expect.
app.use((err: (Error & { status?: number; type?: string }) | null, _req: Request, res: Response, next: NextFunction) => {
  if (!err) return next()

  if (err.status === 413 || err.type === 'entity.too.large') {
    return res.status(413).json({ error: `Body exceeds ${MAX_BODY_LENGTH} characters` })
  }

  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`🚀 AgentCore Runtime server listening on port ${PORT}`)
  console.log(`📍 Endpoints:`)
  console.log(`   POST http://0.0.0.0:${PORT}/invocations`)
  console.log(`   GET  http://0.0.0.0:${PORT}/ping`)
})
