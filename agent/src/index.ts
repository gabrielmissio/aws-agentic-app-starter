import express, { type NextFunction, type Request, type Response } from 'express'
import { createAgent, isGuarded } from './agent'
import { MAX_BODY_BYTES, MAX_BODY_LENGTH } from './limits'
import { parsePrompt, withCaller } from './caller'
import { isDurable, loadHistory, recordTurn } from './memory'
import { parseBaggage, startTelemetry } from './telemetry'

// Before anything else: the Agent's spans and metrics are emitted unconditionally but reach a no-op
// provider until this registers a real one, so a late call silently loses the first requests.
const telemetryEnabled = startTelemetry()

const app = express()
const PORT = process.env.PORT || 8080

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

      // AgentCore forwards the session id as a header; it names this conversation in memory. The
      // BFF mints it, prefixed with a hash of the caller's `sub`, and that prefix is the actor the
      // turn is filed under — see chatbot-bff/src/session.ts and memory.ts.
      const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined
      // The BFF's correlation id, carried in W3C baggage so one turn is findable across the browser
      // report, the BFF log line and the stored exchange.
      const correlationId = parseBaggage(req.headers['baggage'] as string | undefined).correlationId

      // Prior turns, replayed into this one. A read failure is not fatal: answering without history
      // is a worse conversation, but refusing the turn outright is a worse outage.
      let history: Awaited<ReturnType<typeof loadHistory>>
      try {
        history = sessionId ? await loadHistory(sessionId) : undefined
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', event: 'memory.load.failed', correlationId, sessionId }))
        console.error(err)
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      // The WHOLE stream is consumed inside the scope, not merely created inside it: a generator's
      // body inherits the context active while it is *iterated*, so binding at creation would leave
      // every tool callback seeing no caller. `__tests__/caller.test.ts` pins this down.
      await withCaller(caller, async () => {
        // No session id means something invoked the runtime directly rather than through the BFF.
        // That turn still answers, but it starts empty and is never recorded.
        const agent = createAgent(history)
        for await (const event of agent.stream(prompt)) {
          // A failed model or tool call arrives as an ordinary lifecycle event carrying an `error`
          // and does not throw: the stream finishes, this handler answers 200, and the BFF relays a
          // `done` that says ok. Without this line the log group shows a turn that looks entirely
          // successful, and the only place the failure exists is the browser's event stream.
          const failure = (event as { error?: { message?: unknown } }).error
          if (failure?.message) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'turn.failed',
                correlationId,
                sessionId,
                reason: String(failure.message),
              }),
            )
          }

          const json = JSON.stringify(event)
          res.write(`data: ${json}\n\n`)
        }

        if (!sessionId) return

        // Recorded after the answer is complete, and taken from the agent's own message array rather
        // than reassembled from the stream: that array is what the model actually produced, already
        // carrying any guardrail redaction applied to it.
        try {
          await recordTurn(
            sessionId,
            [
              { role: 'USER', text: prompt },
              { role: 'ASSISTANT', text: lastAssistantText(agent) },
            ],
            correlationId ? { correlationId } : undefined,
          )
        } catch (err) {
          // The user has their answer; losing the record of it must not also lose the answer. It is
          // logged loudly because a pilot that cannot evidence a turn needs to know which one.
          console.error(JSON.stringify({ level: 'error', event: 'memory.record.failed', correlationId, sessionId }))
          console.error(err)
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

/** The final assistant text of a completed turn, flattened from its content blocks. */
function lastAssistantText(agent: { messages: readonly { role: string; content: readonly unknown[] }[] }): string {
  const last = [...agent.messages].reverse().find((message) => message.role === 'assistant')

  return (last?.content ?? [])
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

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

const server = app.listen(PORT, () => {
  console.log(`🚀 AgentCore Runtime server listening on port ${PORT}`)
  console.log(`📍 Endpoints:`)
  console.log(`   POST http://0.0.0.0:${PORT}/invocations`)
  console.log(`   GET  http://0.0.0.0:${PORT}/ping`)
  // Each of these is a posture the deployment either has or does not. Printed once, at boot, so an
  // operator reads them from the log group instead of inferring them from behaviour.
  console.log(`   guardrail=${isGuarded} durableSessions=${isDurable} telemetry=${telemetryEnabled}`)
})

/**
 * AgentCore recycles a container by sending `SIGTERM` and waiting before it sends `SIGKILL`. Without
 * a handler, Node exits immediately on the default disposition and every in-flight turn is cut
 * mid-stream — the user sees a truncated answer, and the snapshot for that turn is never written.
 * `server.close()` stops accepting new connections and resolves once the open ones finish.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received — draining in-flight requests`)
    server.close(() => process.exit(0))
  })
}
