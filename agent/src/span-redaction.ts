/**
 * Removes from exported spans the content the Bedrock guardrail provably does not cover.
 *
 * The guardrail is not a log control, and AWS says so directly — Well-Architected's Agentic AI Lens
 * (AGENTSEC05-BP01) notes that its filters act "at inference time, but that is distinct from what
 * the logs capture", and prescribes adding write-time masking wherever the source does not mask on
 * its own. This module is that write-time masking. Three gaps make it necessary here:
 *
 * 1. **Ordering.** Strands opens the model span with the message array *before* calling Bedrock
 *    (`agent.js`, `startModelInvokeSpan`), and applies guardrail redaction after the stream ends.
 *    The span already holds the original text by then.
 * 2. **Scope.** That redaction runs only when the guardrail *intervened*, not on every turn, so it
 *    is not a per-turn scrub.
 * 3. **Tool results are outside the guardrail entirely.** It sits on model input and output;
 *    `guardLatestUserMessage: true` means a tool result is not even evaluated as input. Yet
 *    `get_signed_in_user` returns the caller's email and display name (`tools.ts`), and Strands
 *    writes that into `gen_ai.tool.call.result`.
 *
 * What is deliberately *not* removed is the model prompt and completion. Dropping those would meet
 * the anti-pattern the same lens names — "logging only final agent outputs without intermediate
 * reasoning, tool invocations, or decision points, making incident reconstruction impossible" — so
 * they travel to the span and the destination log group masks them with a CloudWatch Logs data
 * protection policy (`infra/src/stacks/agent-stack.ts`). Origin masking for what the guardrail
 * cannot see; destination masking for what it can. Two layers, each covering the other's blind spot.
 */
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

/** Greppable on purpose: a reader should see that a value was withheld, not that none existed. */
export const REDACTED = '[redacted]'

/**
 * Attributes carrying tool input or output. On a tool span Strands writes the dedicated
 * `gen_ai.tool.call.*` pair *and* the aggregated `gen_ai.*.messages` pair describing the same call,
 * so redacting one without the other would leave the value in place under a different key.
 */
const TOOL_CONTENT_ATTRIBUTES = [
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
]

/** Keys the legacy per-message span events reuse for the same payloads. */
const TOOL_CONTENT_EVENT_KEYS = ['content', 'message']

/** The markers `chatbot-bff/src/session-context.ts` wraps the verified identity in. */
const CONTEXT_HEADER = '[Session context — verified]'
const MESSAGE_HEADER = '[User message]'

/**
 * A tool span, by the operation name the GenAI conventions give it.
 *
 * Keyed on the operation rather than on the presence of `gen_ai.tool.name`, because the model span
 * of a turn that *chose* a tool also carries that name — and the model span is the one whose prompt
 * and completion are meant to survive.
 */
function isToolSpan(span: ReadableSpan): boolean {
  return span.attributes['gen_ai.operation.name'] === 'execute_tool'
}

/**
 * Strips a leaked identity block out of a string.
 *
 * Belt and braces: `parsePrompt` (`caller.ts`) already splits the block off before the prompt
 * reaches the agent, so in the current wiring nothing here should ever match. It stays because that
 * is a property of one line in `index.ts` — passing `prompt` rather than `raw` — and a fork that
 * changes it would start shipping the caller's email into a log group with no test turning red.
 */
function stripIdentityBlock(value: string): string {
  if (!value.includes(CONTEXT_HEADER)) return value

  const start = value.indexOf(CONTEXT_HEADER)
  const marker = value.indexOf(MESSAGE_HEADER, start)
  if (marker === -1) return value

  return value.slice(0, start) + value.slice(marker + MESSAGE_HEADER.length).replace(/^\n+/, '')
}

/**
 * Sanitizes one span **in place** and returns it.
 *
 * In place, and not `{ ...span, attributes, events }`, which is what this did first and what broke
 * every export in the first deployment: a `ReadableSpan` is a class instance, spreading it copies own
 * properties but not prototype methods, and the OTLP serializer calls `span.spanContext()` on the
 * result. The exporter caught the `TypeError`, failed closed as designed, and dropped every batch —
 * so the redaction was working and the telemetry was silently going nowhere.
 *
 * Mutation is safe here precisely because of where this runs. The batch processor has already
 * collected these spans and hands them to the exporter to be serialized and discarded; nothing reads
 * them again, and a retry of the same batch should send the redacted form anyway.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const tool = isToolSpan(span)

  const attributes = span.attributes as Record<string, unknown>
  for (const [key, value] of Object.entries(attributes)) {
    if (tool && TOOL_CONTENT_ATTRIBUTES.includes(key)) attributes[key] = REDACTED
    else if (typeof value === 'string') attributes[key] = stripIdentityBlock(value)
  }

  for (const event of span.events) {
    const eventAttributes = event.attributes as Record<string, unknown> | undefined
    if (!eventAttributes) continue

    for (const [key, value] of Object.entries(eventAttributes)) {
      if (tool && TOOL_CONTENT_EVENT_KEYS.includes(key)) eventAttributes[key] = REDACTED
      else if (typeof value === 'string') eventAttributes[key] = stripIdentityBlock(value)
    }
  }

  return span
}

/**
 * Wraps an exporter so nothing reaches the wire unsanitized.
 *
 * A decorator rather than a `SpanProcessor`: a processor's effect depends on running before the
 * batch processor that forwards the span, and that ordering is a registration detail nothing
 * asserts. Redacting at the exporter makes the guarantee positional — there is no path to the
 * endpoint that does not pass through here.
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans.map(redactSpan), resultCallback)
    } catch (error) {
      // Failing closed: a redaction bug must drop the batch, never fall through to exporting the
      // unredacted spans it failed to clean.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'telemetry.redaction.failed',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      )
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error })
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}
