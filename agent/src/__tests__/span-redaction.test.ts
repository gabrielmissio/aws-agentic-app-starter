import { describe, expect, it, vi } from 'vitest'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ExportResultCode } from '@opentelemetry/core'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import { REDACTED, RedactingSpanExporter, redactSpan } from '../span-redaction'
import { formatSessionContext } from '../caller'

/**
 * A span carries far more than this, but every field the redaction reads is here. Building a literal
 * rather than driving a real agent keeps the assertion about the *rule*, not about whichever
 * attributes the SDK happened to set on the day the test was written.
 */
function span(attributes: Record<string, unknown>, events: { name: string; attributes: Record<string, unknown> }[] = []) {
  return { attributes, events } as unknown as ReadableSpan
}

const toolSpan = (attributes: Record<string, unknown>, events?: { name: string; attributes: Record<string, unknown> }[]) =>
  span({ 'gen_ai.operation.name': 'execute_tool', ...attributes }, events)

describe('redactSpan', () => {
  /**
   * The reason this module exists. `get_signed_in_user` returns the caller's email, and the Bedrock
   * guardrail never sees it: the guardrail sits on model input and output, and `guardLatestUserMessage`
   * means a tool result is not evaluated as input at all.
   */
  it('removes tool call results, which the guardrail does not cover', () => {
    const redacted = redactSpan(
      toolSpan({
        'gen_ai.tool.name': 'get_signed_in_user',
        'gen_ai.tool.call.result': JSON.stringify({ email: 'person@example.com' }),
      }),
    )

    expect(redacted.attributes['gen_ai.tool.call.result']).toBe(REDACTED)
    expect(JSON.stringify(redacted)).not.toContain('person@example.com')
  })

  /** Strands writes the same payload twice, under the dedicated key and the aggregated one. */
  it('removes the aggregated message attributes on a tool span too', () => {
    const redacted = redactSpan(
      toolSpan({
        'gen_ai.tool.call.arguments': '{"query":"secret"}',
        'gen_ai.input.messages': '[{"parts":[{"arguments":{"query":"secret"}}]}]',
        'gen_ai.output.messages': '[{"parts":[{"response":"secret"}]}]',
      }),
    )

    expect(redacted.attributes['gen_ai.tool.call.arguments']).toBe(REDACTED)
    expect(redacted.attributes['gen_ai.input.messages']).toBe(REDACTED)
    expect(redacted.attributes['gen_ai.output.messages']).toBe(REDACTED)
  })

  /** The legacy per-message events reuse `content` and `message` for the same values. */
  it('removes tool content carried in span events', () => {
    const redacted = redactSpan(
      toolSpan({ 'gen_ai.tool.name': 'get_signed_in_user' }, [
        { name: 'gen_ai.tool.message', attributes: { content: '{"email":"person@example.com"}' } },
      ]),
    )

    expect(redacted.events[0]?.attributes?.content).toBe(REDACTED)
  })

  /**
   * The deliberate other half of the policy. Dropping the prompt and the completion would meet the
   * anti-pattern Well-Architected's Agentic AI Lens names — a trace that cannot reconstruct the
   * decision. They travel, and the destination log group masks them.
   */
  it('leaves the model prompt and completion on a model span', () => {
    const redacted = redactSpan(
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.input.messages': 'what is the date today',
        'gen_ai.output.messages': 'it is the 7th',
        'gen_ai.usage.input_tokens': 42,
      }),
    )

    expect(redacted.attributes['gen_ai.input.messages']).toBe('what is the date today')
    expect(redacted.attributes['gen_ai.output.messages']).toBe('it is the 7th')
    expect(redacted.attributes['gen_ai.usage.input_tokens']).toBe(42)
  })

  /**
   * A model span that *chose* a tool also carries `gen_ai.tool.name`, so keying the rule on that
   * attribute rather than on the operation would silently blank the prompts this policy keeps.
   */
  it('does not treat a model span that chose a tool as a tool span', () => {
    const redacted = redactSpan(
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.tool.name': 'get_current_time',
        'gen_ai.input.messages': 'what time is it',
      }),
    )

    expect(redacted.attributes['gen_ai.input.messages']).toBe('what time is it')
  })

  /**
   * `parsePrompt` already splits the identity block off before the prompt reaches the agent, so in
   * the current wiring this never fires. It is asserted because that is a property of one line in
   * `index.ts` — passing `prompt` rather than `raw` — and a fork that changes it would otherwise ship
   * the caller's email to a log group with nothing turning red.
   */
  it('strips a leaked identity block out of any span attribute', () => {
    const leaked =
      formatSessionContext({ userId: 'sub-1', email: 'person@example.com', displayName: 'A Person' }) +
      'what is my email'

    const redacted = redactSpan(span({ 'gen_ai.operation.name': 'chat', 'gen_ai.input.messages': leaked }))

    expect(redacted.attributes['gen_ai.input.messages']).toBe('what is my email')
    expect(JSON.stringify(redacted)).not.toContain('person@example.com')
  })

  it('leaves a span with no content attributes untouched', () => {
    const original = span({ 'gen_ai.operation.name': 'chat', 'gen_ai.usage.output_tokens': 7 })

    expect(redactSpan(original).attributes).toEqual(original.attributes)
  })
})

describe('RedactingSpanExporter', () => {
  it('is the only path to the inner exporter, so nothing reaches the wire unsanitized', () => {
    const inner: SpanExporter = { export: vi.fn(), shutdown: vi.fn(async () => {}) }

    new RedactingSpanExporter(inner).export(
      [toolSpan({ 'gen_ai.tool.call.result': '{"email":"person@example.com"}' })],
      () => {},
    )

    const [exported] = (inner.export as ReturnType<typeof vi.fn>).mock.calls[0] as [ReadableSpan[]]
    expect(exported[0]?.attributes['gen_ai.tool.call.result']).toBe(REDACTED)
  })

  /** Failing closed: a redaction bug drops the batch rather than exporting what it failed to clean. */
  it('drops the batch rather than falling through when redaction throws', () => {
    const inner: SpanExporter = { export: vi.fn(), shutdown: vi.fn(async () => {}) }
    const hostile = { get attributes(): never { throw new Error('boom') }, events: [] } as unknown as ReadableSpan
    const result = vi.fn()

    new RedactingSpanExporter(inner).export([hostile], result)

    expect(inner.export).not.toHaveBeenCalled()
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ code: ExportResultCode.FAILED }))
  })
})

/**
 * The regression that cost a deployment.
 *
 * The literal spans above are plain objects, so they never exercised the contract the exporter
 * actually has: a `ReadableSpan` is a class instance and the OTLP serializer calls `spanContext()`
 * on it. `redactSpan` used to return `{ ...span, ... }`, which drops prototype methods — the
 * serializer threw, the exporter failed closed as designed, and every batch was silently discarded
 * while `metrics` kept flowing and nothing looked wrong.
 *
 * Driving a real span through a real serializer is the only shape of test that catches it.
 */
describe('redaction against a real span', () => {
  function realSpan(attributes: Record<string, string>): ReadableSpan {
    const provider = new BasicTracerProvider()
    const span = provider.getTracer('test').startSpan('execute_tool')
    span.setAttributes(attributes)
    span.end()
    return span as unknown as ReadableSpan
  }

  it('leaves the span serializable after redacting it', () => {
    const span = realSpan({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.call.result': '{"email":"person@example.com"}',
    })

    const redacted = redactSpan(span)

    // The method the serializer needs has to survive — this is what the spread destroyed.
    expect(typeof redacted.spanContext).toBe('function')
    expect(() => JsonTraceSerializer.serializeRequest([redacted])).not.toThrow()

    const wire = new TextDecoder().decode(JsonTraceSerializer.serializeRequest([redacted]))
    expect(wire).toContain(REDACTED)
    expect(wire).not.toContain('person@example.com')
  })

  it('reaches the inner exporter through the decorator, still serializable', () => {
    const captured: ReadableSpan[] = []
    const inner: SpanExporter = {
      export: (spans) => captured.push(...spans),
      shutdown: async () => {},
    }

    new RedactingSpanExporter(inner).export(
      [realSpan({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.result': 'secret' })],
      () => {},
    )

    expect(captured).toHaveLength(1)
    expect(() => JsonTraceSerializer.serializeRequest(captured)).not.toThrow()
    expect(captured[0]?.attributes['gen_ai.tool.call.result']).toBe(REDACTED)
  })
})
