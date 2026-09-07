/**
 * OpenTelemetry wiring for the runtime.
 *
 * The Strands `Agent` already emits spans and metrics — token counts per cycle, per-tool call counts
 * and durations, time to first token — but only once a provider is registered globally. Without this
 * module those instruments exist and write to a no-op provider: the runtime role holds X-Ray and
 * `PutMetricData` permissions that nothing ever uses, and no telemetry leaves the container.
 *
 * **Enabled by `AGENT_OBSERVABILITY_ENABLED`**, the variable AgentCore itself defines for this, and
 * not by `OTEL_EXPORTER_OTLP_ENDPOINT` as it once was. That earlier gate encoded a model AWS has
 * since retired: the documentation now states plainly that the ADOT *Collector* is not supported for
 * agent observability, and the supported path is a direct, SigV4-signed export to regional CloudWatch
 * endpoints. Keying off a collector's address meant the deployed runtime was silent — nothing set
 * that variable — and setting it to a CloudWatch endpoint would have failed anyway, because the
 * stock exporter does not sign. See `otlp-sigv4.ts`.
 *
 * The provider is built here rather than by `setupTracer({ exporters: { otlp: true } })` because two
 * things have to sit in the pipeline before the wire: the signing exporter, and the redaction that
 * covers what the Bedrock guardrail cannot (`span-redaction.ts`).
 *
 * The two signals leave by different routes on purpose. Spans go over OTLP to the X-Ray endpoint,
 * where Transaction Search indexes them for the GenAI Observability console. Metrics go as Embedded
 * Metric Format to a log group, because CloudWatch's metrics OTLP endpoint feeds the PromQL store
 * rather than the namespace/dimension metrics a dashboard widget and an alarm are built on — see
 * `emf-metrics.ts`.
 */
import { context, metrics, propagation, type Context, type Counter } from '@opentelemetry/api'
import { W3CBaggagePropagator, W3CTraceContextPropagator, CompositePropagator } from '@opentelemetry/core'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { setupMeter, setupTracer } from '@strands-agents/sdk/telemetry'
import { EmfMetricExporter } from './emf-metrics'
import { SigV4SpanExporter } from './otlp-sigv4'
import { RedactingSpanExporter } from './span-redaction'

/** Flushes whatever is still buffered. `index.ts` awaits it while draining on `SIGTERM`. */
export type FlushTelemetry = () => Promise<void>

export interface Telemetry {
  enabled: boolean
  flush: FlushTelemetry
}

/**
 * The resource every span and metric carries.
 *
 * Built through `envDetector`, not from the literal alone, and that is a correction. The deployed
 * runtime sets `OTEL_RESOURCE_ATTRIBUTES`; `resourceFromAttributes` does not read it. Spans went out
 * carrying `service.name` and nothing else, so `aws.log.group.names` — the attribute that offers a
 * span's surrounding log lines in the console — never arrived, while the stack's comment beside that
 * variable claimed it did. The detector is the SDK's own parser for the variable, which keeps the
 * format the spec's rather than a second implementation of it.
 *
 * Merged second, so the environment wins: the literal here is the fallback for a local run, not an
 * override of the deployment. Note the detector reads `process.env` rather than `env` — that
 * variable is the platform's, and the SDK is the thing that owns its parsing.
 */
export function telemetryResource(env: NodeJS.ProcessEnv = process.env) {
  return resourceFromAttributes({
    'service.name': env.OTEL_SERVICE_NAME?.trim() || 'agent',
  }).merge(detectResources({ detectors: [envDetector] }))
}

/**
 * Registers the tracer, the meter, the propagators and an async context manager.
 *
 * The context manager is set explicitly because this package deliberately does not install
 * `@opentelemetry/sdk-trace-node`: that package pulls `@opentelemetry/propagator-jaeger`, which
 * carries a high-severity DoS advisory that `npm run audit` gates on. `BasicTracerProvider` — the
 * documented fallback — registers no context manager at all, so spans raised inside an `await` would
 * attach to no parent. `AsyncLocalStorageContextManager` restores exactly the propagation
 * `NodeTracerProvider` exists to provide, and nothing else it brings.
 *
 * The propagators are set for the same reason and are not optional here: `traceparent` is what joins
 * the BFF's Lambda segment to these spans into one trace, and `baggage` is what carries the
 * correlation id. Strands registers both itself, but only on the path where it builds the provider —
 * passing our own means we own that step.
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  const noop: Telemetry = { enabled: false, flush: async () => {} }

  if (env.AGENT_OBSERVABILITY_ENABLED?.trim().toLowerCase() !== 'true') return noop

  const resource = telemetryResource(env)

  // Redaction wraps signing, so there is no ordering to get wrong: the only object the batch
  // processor can reach the endpoint through is the one that sanitizes first.
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new SigV4SpanExporter(env)))],
  })

  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new EmfMetricExporter(env) })],
  })

  setupTracer({ provider: tracerProvider })
  setupMeter({ provider: meterProvider })

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  )

  return {
    enabled: true,
    // Both, and never rejecting: a container is being recycled when this runs, and an exporter that
    // cannot reach its endpoint must not be what stops the process from exiting cleanly.
    flush: async () => {
      await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()])
    },
  }
}

/**
 * Counts a turn a content control ended, as one more instrument in the agent's own namespace.
 *
 * Everything else in that namespace is something Strands emits and `emf-metrics.ts` merely exports.
 * This one is ours, because the event has no instrument upstream: a guardrail intervention arrives
 * as an ordinary stop reason on a successful turn (`GUARDED_STOP_REASONS` in `agent.ts`), so the
 * only record it left was the answer being quietly different from the one the model wrote.
 *
 * Deliberately carries no attributes. `emf-metrics.ts` turns every attribute into a CloudWatch
 * dimension, so a `reason` here would mean the metric only existed under `(ServiceName, Reason)` and
 * an alarm on "any intervention" would have to enumerate the reasons. The reason goes on the log
 * line instead, which is where you look once the count tells you to look at all.
 *
 * The meter is resolved on first use rather than at module load: `startTelemetry` is what registers
 * the global provider, and an instrument created before it would be bound to the no-op one. When
 * telemetry is off it stays no-op, which is the correct behaviour and not an error.
 */
let guardedTurns: Counter | undefined

export function countGuardedTurn(): void {
  guardedTurns ??= metrics.getMeter('agent').createCounter('gen_ai.agent.guarded.count', {
    description: 'Turns ended by a guardrail intervention or the model content filter',
  })

  guardedTurns.add(1)
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

/**
 * Runs `fn` inside the trace the caller started, when the request carries one.
 *
 * Without this the container's spans form their own tree. The BFF's Lambda segment and the agent's
 * work would then be two traces sharing only a correlation id, and "where did the turn spend its
 * time" would have to be answered by reading two consoles side by side. AgentCore forwards the
 * `traceParent` field of the invocation as the standard `traceparent` header, and the global
 * propagator registered in `startTelemetry` is what reads it.
 *
 * Harmless when telemetry is off: with no propagator registered, extraction yields the active
 * context unchanged and this is an ordinary function call.
 */
export function withRemoteContext<T>(
  headers: Record<string, string | undefined>,
  fn: () => T,
): T {
  const parent: Context = propagation.extract(context.active(), headers, {
    get: (carrier, key) => carrier[key.toLowerCase()],
    keys: (carrier) => Object.keys(carrier),
  })

  return context.with(parent, fn)
}
