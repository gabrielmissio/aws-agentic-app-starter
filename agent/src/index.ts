// `instrumentation.ts` is deliberately *not* imported here. It patches the AWS SDK by intercepting
// module loading, and every static import in this file is evaluated before the first line of it
// runs — so an import here would register after the SDK clients below are already resolved, and
// produce no spans at all. It is preloaded instead, via `node --import` in the `start` script.
import express, { type NextFunction, type Request, type Response } from 'express'
import { createAgent, GUARDED_STOP_REASONS, isGuarded, systemPromptVersion } from './agent'
import { agentLimits, LIMIT_STOP_REASONS, MAX_BODY_BYTES, MAX_BODY_LENGTH } from './limits'
import { parsePrompt, withCaller } from './caller'
import { isDurable, loadHistory, recordTurn } from './memory'
import { countGuardedTurn, parseBaggage, startTelemetry, withRemoteContext } from './telemetry'

// Before anything else: the Agent's spans and metrics are emitted unconditionally but reach a no-op
// provider until this registers a real one, so a late call silently loses the first requests.
const telemetry = startTelemetry()

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

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      // The WHOLE stream is consumed inside the scope, not merely created inside it: a generator's
      // body inherits the context active while it is *iterated*, so binding at creation would leave
      // every tool callback seeing no caller. `__tests__/caller.test.ts` pins this down.
      //
      // `withRemoteContext` wraps it for the same reason: the spans Strands raises attach to whatever
      // OTel context is active when they start, so entering the caller's trace has to happen out
      // here rather than around the agent's construction.
      await withRemoteContext(req.headers as Record<string, string | undefined>, () =>
        withCaller(caller, async () => {
          // Prior turns, replayed into this one. A read failure is not fatal: answering without
          // history is a worse conversation, but refusing the turn outright is a worse outage.
          //
          // Read *inside* the trace context, and that placement is the fix for a real defect: it
          // used to run before `withRemoteContext`, so the `ListEvents` span the AWS SDK
          // instrumentation raises for it started with no active context and became the root of a
          // separate trace. The turn's own trace then showed the model call and the memory write but
          // not the memory read — the one span that explains a slow start.
          let history: Awaited<ReturnType<typeof loadHistory>>
          try {
            history = sessionId ? await loadHistory(sessionId) : undefined
          } catch (err) {
            console.error(
              JSON.stringify({ level: 'error', event: 'memory.load.failed', correlationId, sessionId }),
            )
            console.error(err)
          }

          // No session id means something invoked the runtime directly rather than through the BFF.
          // That turn still answers, but it starts empty and is never recorded — and it carries no
          // `session.id`, which is the attribute CloudWatch's GenAI Observability page groups a
          // conversation by. The correlation id rides alongside it so the trace is reachable from the
          // browser report and the BFF log line that quote the same value.
          const agent = createAgent(history, {
            ...(sessionId ? { 'session.id': sessionId } : {}),
            ...(correlationId ? { 'correlation.id': correlationId } : {}),
          })

          /**
           * Cancels the loop when the caller goes away.
           *
           * Without this the container keeps calling Bedrock for a turn nobody is reading: the BFF's
           * 60s timeout ends the relay, the browser is gone, and the loop runs on being billed. The
           * `close` event fires on a normal end too, hence the `writableEnded` guard — aborting there
           * would cancel a turn that had already finished.
           */
          const cancellation = new AbortController()
          res.on('close', () => {
            if (!res.writableEnded) cancellation.abort()
          })

          for await (const event of agent.stream(prompt, {
            // Omitted, Strands treats every dimension as unlimited — see `limits.ts` for why that is
            // the one axis nothing else in this template bounds.
            limits: agentLimits,
            cancelSignal: cancellation.signal,
          })) {
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

            // A cap firing is not an error and does not throw: the loop stops, the stream ends, and
            // the answer simply arrives shorter than it should have. Logged for exactly that reason —
            // an unexplained truncation is indistinguishable from a model that had nothing more to
            // say, and this is the only record that tells the two apart.
            const stopReason = (event as { result?: { stopReason?: unknown } }).result?.stopReason
            if (typeof stopReason === 'string' && LIMIT_STOP_REASONS.has(stopReason)) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'turn.limited',
                  correlationId,
                  sessionId,
                  reason: stopReason,
                  limits: agentLimits,
                }),
              )
            }

            // A content control ending the turn is the third way a turn goes wrong while answering
            // 200, and it was the one nothing recorded. The guardrail is the only layer here that
            // reads what is said; when it intervenes, the reply the user gets is not the one the
            // model wrote, and without this line the sole evidence of that is the answer itself.
            //
            // Logged at the same level as the two above, on purpose: `turn.failed`, `turn.limited`
            // and `turn.guarded` are one class — the turn did not end the way the model intended —
            // and one query on `level` should find all three. The counter beside it is what makes
            // "how often did the guardrail fire this week" answerable without reading any of them.
            if (typeof stopReason === 'string' && GUARDED_STOP_REASONS.has(stopReason)) {
              countGuardedTurn()
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'turn.guarded',
                  correlationId,
                  sessionId,
                  reason: stopReason,
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
        }),
      )

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
  // operator reads them from the log group instead of inferring them from behaviour. `prompt` is the
  // digest stamped on every span, so a trace can be tied back to the prompt that produced it.
  console.log(`   guardrail=${isGuarded} durableSessions=${isDurable} telemetry=${telemetry.enabled}`)
  console.log(
    `   prompt=${systemPromptVersion} maxTurns=${agentLimits.turns} maxTotalTokens=${agentLimits.totalTokens}`,
  )
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
    // Spans and metrics sit in a batch buffer until an interval elapses, and a recycle is exactly
    // when that interval will not. Flushing after `close` resolves means the turns that finished
    // during the drain are described, rather than being the ones no trace exists for.
    server.close(() => {
      telemetry.flush().finally(() => process.exit(0))
    })
  })
}
