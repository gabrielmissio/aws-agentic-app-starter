import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/**
 * How `instrumentation.ts` reaches the process, asserted because the obvious way does not work.
 *
 * It patches the AWS SDK by intercepting module loading, so it has to finish before any SDK client
 * is resolved. Importing it first from `index.ts` looks like it would do that and does not: ESM
 * evaluates every static import in a module before the first line of that module's body, and the
 * bundler flattens everything into one module — so the registration runs after `@aws-sdk/*` is
 * already loaded. That was measured through the real bundler, not reasoned about: bundled-and-
 * imported yields `SPANS=0`, preloaded with `node --import` yields `SPANS=1`.
 *
 * So it is a separate build entry, preloaded by the `start` script. Both halves are load-bearing and
 * neither looks it: drop the entry and the preload has no file, drop the `--import` and the patch
 * never runs. Either way the agent's outbound calls vanish from traces with no error anywhere.
 */
describe('AWS SDK instrumentation', () => {
  const manifest = JSON.parse(read('../../package.json')) as { scripts: Record<string, string> }

  it('is preloaded rather than imported by the application', () => {
    expect(manifest.scripts.start).toContain('--import ./dist/instrumentation.js')
    // An import from index.ts would be evaluated too late to patch anything.
    expect(read('../index.ts')).not.toContain("import './instrumentation'")
  })

  it('is built as its own entry, so there is a file to preload', () => {
    expect(read('../../tsup.config.ts')).toContain("'src/instrumentation.ts'")
  })

  /** Off leaves the SDK unpatched: a local run has no exporter to send the spans to anyway. */
  it('is gated on the same variable as the rest of the telemetry', () => {
    expect(read('../instrumentation.ts')).toContain('AGENT_OBSERVABILITY_ENABLED')
  })

  /**
   * The exporters are themselves AWS SDK callers. Tracing their writes would produce a span per
   * export interval that describes no turn, and — for the span exporter — a span produced by
   * exporting a span. Both wrap their calls in `suppressTracing`.
   */
  it('does not trace the exporters own AWS calls', () => {
    expect(read('../emf-metrics.ts')).toContain('suppressTracing')
    expect(read('../otlp-sigv4.ts')).toContain('suppressTracing')
  })
})

/**
 * Every AWS call a turn makes has to happen inside the turn's trace context.
 *
 * Once the SDK is instrumented, each call raises a span that attaches to whatever context is active
 * when it starts. `loadHistory` used to run before `withRemoteContext`, so its `ListEvents` span
 * began with no active context and became the *root of its own trace* — the account showed exactly
 * that, a two-span orphan trace alongside the real one. The turn's trace then showed the model call
 * and the memory write but not the memory read, which is the span that explains a slow start.
 *
 * Line order is the only thing enforcing this, and moving a read "up for clarity" silently splits
 * the trace again, so it is asserted rather than left to review.
 */
describe('turn tracing', () => {
  const index = read('../index.ts')

  it('reads history inside the trace context, not before it', () => {
    expect(index.indexOf('withRemoteContext(req.headers')).toBeGreaterThan(-1)
    expect(index.indexOf('await loadHistory(')).toBeGreaterThan(index.indexOf('withRemoteContext(req.headers'))
  })
})

/**
 * The condition that retires this repo's hand-written OTLP transport.
 *
 * `otlp-sigv4.ts` and `emf-metrics.ts` exist only because the ADOT JavaScript distro cannot yet do
 * their job: at 0.12.0 it contains no reference to `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, so it cannot
 * direct spans into this deployment's own log group, and it exposes only `./register`, so origin-side
 * redaction has nowhere to attach. ADOT Python passed that point at 0.18.0; JavaScript has not.
 *
 * Without a trigger, temporary code becomes permanent by inertia, and a reference template ends up
 * teaching people to hand-roll AWS's transport. This test fires the moment the distro is adopted:
 * whoever adds the dependency is told, in the same breath, which files it replaces.
 *
 * To re-check the upstream condition: `npm pack @aws/aws-distro-opentelemetry-node-autoinstrumentation`
 * and grep the build for `TRACES_HEADERS`.
 */
describe('hand-written OTLP transport', () => {
  const manifest = JSON.parse(read('../../package.json')) as {
    dependencies?: Record<string, string>
  }
  const distro = '@aws/aws-distro-opentelemetry-node-autoinstrumentation'

  it('is retired the moment the ADOT distro can replace it', () => {
    if (manifest.dependencies?.[distro]) {
      // The distro is here. It brings a SigV4 span exporter and an EMF metric exporter of its own,
      // so these two modules are now duplicates of code AWS maintains — delete them, and move the
      // redaction onto whatever extension point the distro exposes.
      expect(() => read('../otlp-sigv4.ts')).toThrow()
      expect(() => read('../emf-metrics.ts')).toThrow()
      return
    }

    // Not adopted yet, so the two modules must still be here and still be wired in.
    expect(read('../telemetry.ts')).toContain('SigV4SpanExporter')
    expect(read('../telemetry.ts')).toContain('EmfMetricExporter')
  })
})
