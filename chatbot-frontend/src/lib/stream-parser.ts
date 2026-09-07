/**
 * Parses the Strands SDK's SSE events, as re-streamed by the BFF. The shapes handled below come from
 * `agent.stream() → toJSON()`; anything unrecognized is skipped rather than treated as an error.
 */

/**
 * The turn ended without producing a reply and without saying why.
 *
 * Distinct from a reported failure because there is no server message to show: the UI has to supply
 * its own wording, and it can only do that if it can tell the two apart.
 */
export class EmptyReplyError extends Error {
  constructor() {
    super('The agent finished without producing a reply.')
    this.name = 'EmptyReplyError'
  }
}

/**
 * The turn was cut short by one of the agent's configured ceilings rather than finishing.
 *
 * Also a silent failure, and a worse one than an empty reply: text *was* produced, so the answer looks
 * complete and simply stops — often mid-task, right after the model asked for a tool the loop then
 * refused to run. Nothing errors, the runtime answers 200, and the only other record is a
 * `turn.limited` line in the agent's log group, which the person reading the answer cannot see.
 */
export class TurnLimitError extends Error {
  constructor(readonly stopReason: string) {
    super(`The turn stopped at a configured ceiling (${stopReason}).`)
    this.name = 'TurnLimitError'
  }
}

/**
 * Stop reasons that mean a ceiling fired, not that the model was done.
 *
 * `limit*` come from the per-invocation caps in `agent/src/limits.ts`; `maxTokens` comes from the
 * model's own per-response cap. Restated here rather than imported because the agent and the frontend
 * are separate packages — the same reason `ACTOR_ID_LENGTH` is restated — and because these are the
 * SDK's spellings, not ours.
 */
const TRUNCATING_STOP_REASONS = new Set([
  'limitTurns',
  'limitTotalTokens',
  'limitOutputTokens',
  'maxTokens',
])

export interface StreamCallbacks {
  /** One visible text token, with `<thinking>` already stripped. */
  onToken: (text: string) => void
  onToolStart: (toolName: string) => void
  onThinking: (text: string) => void
  /** A status label, e.g. `Using get_current_time`. */
  onStatus: (status: string) => void
  onComplete: () => void
  onError: (error: Error) => void
}

/** Strips `<thinking>…</thinking>` from streamed text, including tags split across tokens. */
function createThinkingFilter(callbacks: StreamCallbacks) {
  let inThinking = false
  let tagBuffer = ''
  let hasEmittedVisible = false

  function emitVisible(text: string) {
    if (!hasEmittedVisible) {
      text = text.replace(/^\s+/, '')
      if (!text) return
      hasEmittedVisible = true
    }
    callbacks.onToken(text)
  }

  return {
    /** Feed a text delta token. Visible text goes to onToken, thinking to onThinking. */
    push(text: string) {
      tagBuffer += text

      while (tagBuffer.length > 0) {
        if (inThinking) {
          const closeIdx = tagBuffer.indexOf('</thinking>')
          if (closeIdx !== -1) {
            const thinkingText = tagBuffer.substring(0, closeIdx)
            if (thinkingText) callbacks.onThinking(thinkingText)
            tagBuffer = tagBuffer.substring(closeIdx + '</thinking>'.length)
            inThinking = false
            hasEmittedVisible = false // reset so leading whitespace after thinking is stripped
            callbacks.onStatus('Streaming...')
          } else {
            // A trailing `<` may be a split `</thinking>`: hold back only what the tag could need.
            const maxPartial = '</thinking>'.length - 1
            if (tagBuffer.length > maxPartial) {
              const safe = tagBuffer.substring(0, tagBuffer.length - maxPartial)
              callbacks.onThinking(safe)
              tagBuffer = tagBuffer.substring(safe.length)
            }
            break
          }
        } else {
          const openIdx = tagBuffer.indexOf('<thinking>')
          if (openIdx !== -1) {
            const visibleText = tagBuffer.substring(0, openIdx)
            if (visibleText) emitVisible(visibleText)
            tagBuffer = tagBuffer.substring(openIdx + '<thinking>'.length)
            inThinking = true
            callbacks.onStatus('Thinking...')
          } else {
            const maxPartial = '<thinking>'.length - 1
            const lastLt = tagBuffer.lastIndexOf('<')
            if (lastLt !== -1 && lastLt >= tagBuffer.length - maxPartial) {
              const safe = tagBuffer.substring(0, lastLt)
              if (safe) emitVisible(safe)
              tagBuffer = tagBuffer.substring(lastLt)
              break
            } else {
              emitVisible(tagBuffer)
              tagBuffer = ''
            }
            break
          }
        }
      }
    },

    /** Flush any remaining buffered text. */
    flush() {
      if (tagBuffer) {
        if (inThinking) {
          callbacks.onThinking(tagBuffer)
        } else {
          emitVisible(tagBuffer)
        }
        tagBuffer = ''
      }
    },
  }
}

/**
 * Parses a streaming response from AgentCore and dispatches callbacks.
 */
export async function parseAgentCoreStream(
  response: Response,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!response.body) {
    callbacks.onError(new Error('Response has no body'))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  /** Whether the model produced any text this turn, and whether a failure was already reported. */
  let produced = false
  let failed = false
  /** The ceiling that ended the turn, if one did. See `TRUNCATING_STOP_REASONS`. */
  let limitedBy: string | undefined

  /**
   * Fires exactly once. A finished turn arrives as *both* a `modelMessageStopEvent` with `endTurn`
   * and an `agentResultEvent`, plus the final flush if neither showed up — and consumers hang
   * end-of-turn work off this, so letting it through twice does that work twice.
   */
  const complete = () => {
    if (completed) return
    completed = true

    // A turn that ends having produced neither text nor a reported error is the silent-failure
    // shape: every layer behaved — the runtime answered 200, the BFF relayed every chunk and said
    // `done: ok` — and the user is left with an empty bubble and nothing to report. A reply with no
    // content is not a reply, so it is named rather than rendered.
    //
    // A ceiling firing is the same class of failure with the opposite symptom: there *is* content, and
    // that is what makes it dangerous — the answer reads as finished. Reported even when text arrived,
    // and ahead of the empty-reply case, because "stopped at a limit" is the more specific explanation.
    if (!failed) {
      if (limitedBy) callbacks.onError(new TurnLimitError(limitedBy))
      else if (!produced) callbacks.onError(new EmptyReplyError())
    }

    callbacks.onComplete()
  }
  const thinkingFilter = createThinkingFilter(callbacks)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue

        let jsonString = line
        if (line.startsWith('data: ')) {
          jsonString = line.substring(6)
        }

        if (jsonString === '[DONE]') continue

        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(jsonString)
        } catch {
          continue
        }

        const eventType = chunk.type as string | undefined

        // ── Any event carrying an error → the turn failed ────────────────
        // A failed model call arrives as an ordinary lifecycle event with an `error` on it, and
        // then the stream ends normally: nothing throws, the runtime answers 200, and the BFF
        // relays a `done` that says ok. Treating those events as noise is what turned "Model
        // access is denied" into an empty bubble that could only be read in devtools.
        //
        // Checked on every event rather than on `afterModelCallEvent` alone: the same shape carries
        // a failed tool call and a failed invocation, and a turn can only fail in ways this file
        // has not been told about yet.
        const failure = chunk.error as { message?: unknown } | undefined
        if (typeof failure?.message === 'string' && failure.message) {
          failed = true
          thinkingFilter.flush()
          callbacks.onError(new Error(failure.message))
          continue
        }

        // ── modelStreamUpdateEvent → wraps raw ModelStreamEvent ──────────
        if (eventType === 'modelStreamUpdateEvent') {
          const inner = chunk.event as Record<string, unknown> | undefined
          if (!inner) continue
          const innerType = inner.type as string | undefined

          if (innerType === 'modelContentBlockDeltaEvent') {
            const delta = inner.delta as Record<string, string> | undefined
            if (delta?.type === 'textDelta' && delta.text != null) {
              if (delta.text) produced = true
              thinkingFilter.push(delta.text)
            }
            if (delta?.type === 'reasoningContentDelta' && delta.text) {
              callbacks.onThinking(delta.text)
            }
            continue
          }

          if (innerType === 'modelContentBlockStartEvent') {
            const start = inner.start as Record<string, unknown> | undefined
            const toolUse = start?.toolUse as Record<string, string> | undefined
            if (toolUse?.name) {
              callbacks.onToolStart(toolUse.name)
              callbacks.onStatus(`Using ${toolUse.name}`)
            }
            continue
          }

          if (innerType === 'modelMessageStopEvent') {
            const stopReason = inner.stopReason as string | undefined
            if (stopReason && TRUNCATING_STOP_REASONS.has(stopReason)) limitedBy = stopReason

            if (stopReason === 'endTurn' || stopReason === 'end_turn') {
              thinkingFilter.flush()
              complete()
            } else if (stopReason === 'toolUse' || stopReason === 'tool_use') {
              callbacks.onStatus('Using tools...')
            } else {
              callbacks.onStatus('Processing...')
            }
            continue
          }

          continue
        }

        // ── beforeToolCallEvent → tool about to execute ──────────────────
        if (eventType === 'beforeToolCallEvent') {
          const toolUse = chunk.toolUse as Record<string, string> | undefined
          if (toolUse?.name) {
            callbacks.onToolStart(toolUse.name)
            callbacks.onStatus(`Using ${toolUse.name}`)
          }
          continue
        }

        // ── afterToolCallEvent / toolResultEvent → tool finished ─────────
        if (eventType === 'afterToolCallEvent' || eventType === 'toolResultEvent') {
          callbacks.onStatus('Processing result...')
          continue
        }

        // ── agentResultEvent → final result ──────────────────────────────
        if (eventType === 'agentResultEvent') {
          // Where a per-invocation cap actually surfaces: the caps are checked at the top of each
          // loop iteration, so the last model call ends with its own ordinary stop reason and the
          // *result* is what carries `limitTurns`. Reading only `modelMessageStopEvent` misses it.
          const stopReason = (chunk.result as { stopReason?: unknown } | undefined)?.stopReason
          if (typeof stopReason === 'string' && TRUNCATING_STOP_REASONS.has(stopReason)) {
            limitedBy = stopReason
          }

          thinkingFilter.flush()
          complete()
          continue
        }

        // ── Skip lifecycle noise events ──────────────────────────────────
        if (
          eventType === 'beforeInvocationEvent' ||
          eventType === 'afterInvocationEvent' ||
          eventType === 'beforeModelCallEvent' ||
          eventType === 'afterModelCallEvent' ||
          eventType === 'beforeToolsEvent' ||
          eventType === 'afterToolsEvent' ||
          eventType === 'messageAddedEvent' ||
          eventType === 'contentBlockEvent' ||
          eventType === 'modelMessageEvent'
        ) {
          continue
        }
      }
    }

    thinkingFilter.flush()
    complete()
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}
