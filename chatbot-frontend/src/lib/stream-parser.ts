/**
 * Parses SSE streaming responses from Strands Agents SDK (via AgentCore).
 *
 * Strands SDK event types (from agent.stream() → toJSON()):
 *   modelStreamUpdateEvent  → wraps ModelStreamEvent (text deltas, tool starts, stop)
 *   contentBlockEvent       → completed content block (text with thinking stripped)
 *   beforeToolCallEvent     → tool about to execute
 *   afterToolCallEvent      → tool finished executing
 *   agentResultEvent        → final result
 */

export interface StreamCallbacks {
  /** Called for each visible text token (token-by-token). */
  onToken: (text: string) => void
  /** Called when a tool starts executing. */
  onToolStart: (toolName: string) => void
  /** Called when the model is thinking/reasoning. */
  onThinking: (text: string) => void
  /** Called with a status label (e.g. "Using search_products", "Streaming..."). */
  onStatus: (status: string) => void
  /** Called when the stream completes. */
  onComplete: () => void
  /** Called on error. */
  onError: (error: Error) => void
  /**
   * Called when `initiate_consent_session` returns, with the session id — how the UI learns to open
   * the checkout gate. Only an opaque reference crosses: no amount, no code, nothing the agent could
   * alter to its advantage.
   */
  onConsentProposed?: (sessionId: string) => void
}

/**
 * Finds the first string value for `key` anywhere in a value, including inside JSON serialized into
 * a string — how tool results commonly arrive. A deep search rather than a fixed path because the
 * SDK's wrapper shape is not stable across versions, and `toolResult.content[0].text` would silently
 * stop matching on an upgrade: the checkout card never appears, reading as a broken agent.
 */
function deepFindString(node: unknown, key: string): string | undefined {
  if (typeof node === 'string') {
    if (!node.includes(`"${key}"`)) return undefined
    try {
      return deepFindString(JSON.parse(node), key)
    } catch {
      return undefined
    }
  }

  if (!node || typeof node !== 'object') return undefined

  if (Array.isArray(node)) {
    for (const el of node) {
      const found = deepFindString(el, key)
      if (found) return found
    }
    return undefined
  }

  const obj = node as Record<string, unknown>
  const direct = obj[key]
  if (typeof direct === 'string' && direct) return direct

  for (const value of Object.values(obj)) {
    const found = deepFindString(value, key)
    if (found) return found
  }
  return undefined
}

/** Exported for tests: the tool result shapes this has to survive are the whole reason it exists. */
export const __testing = { deepFindString }

/**
 * Strips inline `<thinking>...</thinking>` blocks from streamed text,
 * handling tags that arrive split across multiple tokens.
 */
function createThinkingFilter(callbacks: StreamCallbacks) {
  let inThinking = false
  let tagBuffer = ''
  let hasEmittedVisible = false

  function emitVisible(text: string) {
    // Strip leading whitespace before the first visible content
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
            // A trailing `<` may be the start of `</thinking>` split across tokens, so hold
            // back only as much as the tag could still need and emit the rest.
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

  /**
   * Signals the end of the stream, exactly once. A finished turn arrives as *both* a
   * `modelMessageStopEvent` with `endTurn` and an `agentResultEvent`, and the final flush signals it
   * again if neither showed up. Consumers act on completion, so letting it through twice opens two
   * checkout gates for one proposal — the second overwriting the first one's code.
   */
  const complete = () => {
    if (completed) return
    completed = true
    callbacks.onComplete()
  }
  /** The last tool the model started, so a result event can be attributed even without its name. */
  let lastToolName = ''
  const thinkingFilter = createThinkingFilter(callbacks)

  /** Emits the consent session id once `initiate_consent_session` has produced one. */
  const maybeEmitConsent = (chunk: Record<string, unknown>) => {
    if (!callbacks.onConsentProposed) return
    const toolUse = chunk.toolUse as Record<string, string> | undefined
    if ((toolUse?.name ?? lastToolName) !== 'initiate_consent_session') return
    const sessionId = deepFindString(chunk, 'sessionId')
    if (sessionId) callbacks.onConsentProposed(sessionId)
  }

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

        // ── modelStreamUpdateEvent → wraps raw ModelStreamEvent ──────────
        if (eventType === 'modelStreamUpdateEvent') {
          const inner = chunk.event as Record<string, unknown> | undefined
          if (!inner) continue
          const innerType = inner.type as string | undefined

          if (innerType === 'modelContentBlockDeltaEvent') {
            const delta = inner.delta as Record<string, string> | undefined
            if (delta?.type === 'textDelta' && delta.text != null) {
              thinkingFilter.push(delta.text)
            }
            // Extended thinking (real reasoning content, e.g. Claude)
            if (delta?.type === 'reasoningContentDelta' && delta.text) {
              callbacks.onThinking(delta.text)
            }
            continue
          }

          if (innerType === 'modelContentBlockStartEvent') {
            const start = inner.start as Record<string, unknown> | undefined
            const toolUse = start?.toolUse as Record<string, string> | undefined
            if (toolUse?.name) {
              lastToolName = toolUse.name
              callbacks.onToolStart(toolUse.name)
              callbacks.onStatus(`Using ${toolUse.name}`)
            }
            continue
          }

          if (innerType === 'modelMessageStopEvent') {
            const stopReason = inner.stopReason as string | undefined
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
            lastToolName = toolUse.name
            callbacks.onToolStart(toolUse.name)
            callbacks.onStatus(`Using ${toolUse.name}`)
          }
          continue
        }

        // ── afterToolCallEvent / toolResultEvent → tool finished ─────────
        // `initiate_consent_session`'s result carries the session id the UI needs to open the
        // checkout gate, so both shapes are inspected for it.
        if (eventType === 'afterToolCallEvent' || eventType === 'toolResultEvent') {
          callbacks.onStatus('Processing result...')
          maybeEmitConsent(chunk)
          continue
        }

        // ── agentResultEvent → final result ──────────────────────────────
        if (eventType === 'agentResultEvent') {
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
