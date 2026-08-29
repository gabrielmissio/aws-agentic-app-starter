/**
 * OpenTelemetry wiring for the runtime.
 *
 * The Strands `Agent` already emits spans and metrics — token counts per cycle, per-tool call
 * counts, durations — but only once a provider is registered globally. Without this module those
 * instruments exist and write to a no-op provider, which is the state the assessment found: the
 * runtime role holds X-Ray and `PutMetricData` permissions that nothing uses.
 *
 * Enabled by the presence of `OTEL_EXPORTER_OTLP_ENDPOINT` rather than a flag of our own. That is
 * the variable every OTLP collector already sets, so a runtime that has a collector traces and one
 * that does not stays silent — no configuration that can disagree with itself.
 */
import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { setupMeter, setupTracer } from '@strands-agents/sdk/telemetry'

/**
 * Registers the tracer, the meter and an async context manager. Returns whether telemetry is on, so
 * the caller can say so once at boot instead of leaving an operator guessing.
 *
 * The context manager is set explicitly because the SDK reaches for `NodeTracerProvider` and this
 * package deliberately does not install it: `@opentelemetry/sdk-trace-node` pulls
 * `@opentelemetry/propagator-jaeger`, which carries a high-severity DoS advisory that `npm run
 * audit` gates on. `BasicTracerProvider` — the SDK's documented fallback — registers no context
 * manager at all, so spans raised inside an `await` would attach to no parent. Installing
 * `AsyncLocalStorageContextManager` restores exactly the propagation `NodeTracerProvider` exists to
 * provide, and nothing else it brings.
 *
 * Safe to call after `setupTracer`: `BasicTracerProvider.register()` sets a context manager only
 * when one is passed to it, and the SDK passes none.
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return false

  setupTracer({ exporters: { otlp: true } })
  setupMeter({ exporters: { otlp: true } })
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

  return true
}

/**
 * Reads one key out of a W3C `baggage` header.
 *
 * The BFF puts its correlation id there when it invokes the runtime (`chatbot-bff/src/agent-client.ts`)
 * — `baggage` being the field the spec reserves for application-defined context, rather than a trace
 * id the platform assigns meaning to. Deliberately minimal: the one entry this runtime consumes is
 * that id, and a full parser would be more surface than that is worth.
 */
export function parseBaggage(header: string | undefined): { correlationId?: string } {
  const correlationId = header
    ?.split(',')
    .map((entry) => entry.trim().split('='))
    .find(([key]) => key === 'correlationId')?.[1]

  return correlationId ? { correlationId } : {}
}
