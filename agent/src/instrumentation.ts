/**
 * Patches the AWS SDK so the agent's own calls appear in the trace.
 *
 * **This module must be imported before anything that imports an AWS SDK client**, which is why
 * `index.ts` lists it first and why `__tests__/instrumentation.test.ts` asserts that ordering. The
 * patch works by intercepting the module loader: a client already resolved is a client already
 * unpatched, and nothing reports the difference. Measured, not assumed — registering after a static
 * `import` of `@aws-sdk/client-cloudwatch-logs` produces zero spans, against one when the import
 * follows registration.
 *
 * **What it buys.** Until now the trace showed the BFF calling DynamoDB and AgentCore, then the
 * agent's own work as a tree with no outbound calls at all — the invocations to Bedrock and to
 * AgentCore Memory made *by the agent* were invisible. "Was the time spent in the model or in
 * memory?" is the first question asked of a slow turn, and it was the one question the trace could
 * not answer.
 *
 * No provider is passed. The instrumentation resolves its tracer through the global API, which hands
 * back a proxy until `startTelemetry` registers the real provider a moment later and then delegates
 * to it — so the patch can happen this early without the provider existing yet.
 */
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk'

/** Whether the SDK was patched. Gated on the same variable as the rest of the telemetry. */
export const instrumented = registerAwsSdk()

function registerAwsSdk(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AGENT_OBSERVABILITY_ENABLED?.trim().toLowerCase() !== 'true') return false

  registerInstrumentations({
    instrumentations: [
      new AwsInstrumentation({
        // The exporters are themselves AWS SDK callers — `emf-metrics.ts` writes log events every
        // interval. Their traffic is telemetry about telemetry: it says nothing about a turn and it
        // would outnumber the spans that do. They suppress tracing around their own calls; this
        // keeps the SQS/SNS-style context injection from fighting that.
        suppressInternalInstrumentation: true,
      }),
    ],
  })

  return true
}
