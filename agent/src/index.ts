import express, { type NextFunction, type Request, type Response } from 'express'
import { createAgent } from './agent'
import { MAX_BODY_BYTES, MAX_BODY_LENGTH } from './limits'
import { parsePrompt, withCaller } from './caller'

const app = express()
const PORT = process.env.PORT || 8080

// In-memory conversation store keyed by AgentCore runtime session ID.
// Sessions idle for more than 30 minutes are evicted on the next request.
//
// NOTE: this store is local to the container process. History is lost on restart and is not
// shared across replicas. For a multi-instance or durable deployment, replace this with the
// Strands SDK SessionManager backed by a persistent store (e.g. DynamoDB).
const SESSION_TTL_MS = 30 * 60 * 1000
type ConversationHistory = ReturnType<typeof createAgent>['messages']
const conversationStore = new Map<string, { history: ConversationHistory; lastAccess: number }>()

function evictStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, entry] of conversationStore) {
    if (entry.lastAccess < cutoff) conversationStore.delete(id)
  }
}

// Health check endpoint (REQUIRED)
app.get('/ping', (_: Request, res: Response) =>
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  })
)

// Agent invocation endpoint (REQUIRED)
// AWS sends binary payload, so we use express.raw middleware
app.post(
  '/invocations',
  express.raw({ type: '*/*', limit: MAX_BODY_BYTES }),
  async (req: Request, res: Response) => {
    try {
      const raw = new TextDecoder().decode(req.body)

      if (raw.length > MAX_BODY_LENGTH) {
        return res.status(413).json({ error: `Body exceeds ${MAX_BODY_LENGTH} characters` })
      }

      // The BFF prepends a block naming the caller it authenticated. Splitting it off here means the
      // identity is bound to the request's async context, where tools read it directly — so no tool
      // has to take a user id as a parameter, and no prompt can talk the agent into using another
      // one. A request with no block simply carries no caller; see caller.ts.
      const { caller, message: prompt } = parsePrompt(raw)

      // AgentCore forwards the runtime session id as a header; use it to look up this
      // conversation's message history so the agent has context from prior turns.
      const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined
      evictStaleSessions()
      const prior = sessionId ? conversationStore.get(sessionId)?.history : undefined

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      // The WHOLE stream is consumed inside the caller scope, not just created inside it. An async
      // generator's body does not inherit the context its creation call ran in — only the context
      // active while it is being iterated — so binding at creation would leave every tool callback
      // seeing no caller at all. `caller.test.ts` pins this down.
      //
      // A fresh agent per request — see the comment on createAgent() for why one must not be shared.
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

// express.raw() rejects an oversized body itself, before the route handler above ever runs, by
// calling next(err) — without this, Express's default error handler would turn that into an HTML
// error page, not the JSON this endpoint's callers expect.
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
