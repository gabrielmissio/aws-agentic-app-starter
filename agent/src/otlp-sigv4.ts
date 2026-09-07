/**
 * OTLP exporters that sign with SigV4, because CloudWatch's OTLP endpoints require it.
 *
 * AWS retired the "run a collector somewhere" model for agent observability — the documentation is
 * explicit that the ADOT *Collector* is not supported for it. What replaced it is a pair of
 * regional endpoints that speak OTLP over HTTP and authenticate the caller with SigV4:
 *
 * - traces → `https://xray.<region>.amazonaws.com/v1/traces`
 *
 * Only traces go this way. CloudWatch's metrics OTLP endpoint exists, but what it ingests lands in
 * the PromQL store rather than as an alarmable namespace/dimension metric — see `emf-metrics.ts`.
 *
 * `@opentelemetry/exporter-trace-otlp-http` cannot reach either: it sends the request unsigned, so
 * the endpoint answers 403 and the spans are dropped with nothing in the log group to say why. That
 * is the gap this module closes, and it is why `telemetry.ts` builds its own provider rather than
 * letting `setupTracer({ exporters: { otlp: true } })` construct the stock exporter.
 *
 * Implemented against the `SpanExporter`/`PushMetricExporter` interfaces rather than by subclassing
 * the stock exporter: signing needs the serialized body, which the base class produces deep inside a
 * transport it does not expose. Serialize, sign, POST — three steps we can see — is both shorter and
 * more honest than reaching into internals that change between minor versions.
 */
import { createHash, createHmac } from 'node:crypto'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { context } from '@opentelemetry/api'
import { ExportResultCode, suppressTracing, type ExportResult } from '@opentelemetry/core'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { SignatureV4 } from '@smithy/signature-v4'

/**
 * The hasher `@smithy/signature-v4` asks for, over `node:crypto`.
 *
 * SigV4 needs both a plain digest (of the payload) and a keyed one (for the signing key chain), and
 * the interface expresses that as one constructor whose optional argument decides which. Written
 * here rather than pulled from `@aws-crypto/sha256-js` because Node ships both primitives and this
 * package is deliberately thin — `telemetry.ts` already declines a dependency that would drag a
 * vulnerable transitive in, and adding one for `createHash` would undo that reasoning.
 */
class Sha256 {
  private readonly hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>

  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash = secret
      ? createHmac('sha256', Buffer.from(secret as ArrayBuffer))
      : createHash('sha256')
  }

  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer))
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest())
  }
}

/**
 * Resolved once, not per export. The provider chain reads the container's credential endpoint, and
 * doing that on every batch would add a round trip to a path that runs continuously; the chain
 * caches and refreshes the credentials it hands back, so a long-lived container still rotates.
 */
const credentials = defaultProvider()

/** The region the endpoints live in. AgentCore always sets `AWS_REGION` in the container. */
function resolveRegion(env: NodeJS.ProcessEnv): string {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Parses the standard `key=value,key=value` OTLP headers form.
 *
 * The one this runtime sets is `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, and what it carries decides
 * *where the spans land*: with `x-aws-log-group` and `x-aws-log-stream`, the endpoint writes them to
 * that log group instead of the account-shared `aws/spans`. That is not a cosmetic preference — a
 * log group this deployment owns is the only one it can put a retention, its own CMK and a data
 * protection policy on, and those are the destination half of the content policy the origin-side
 * redaction in `span-redaction.ts` implements. Spans in `aws/spans` would have none of them.
 */
export function parseOtlpHeaders(header: string | undefined): Record<string, string> {
  if (!header?.trim()) return {}

  return Object.fromEntries(
    header
      .split(',')
      .map((entry) => entry.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0] && pair[1]))
      .map(([key, value]) => [key.trim().toLowerCase(), value.trim()]),
  )
}

/**
 * POSTs a serialized OTLP payload to a CloudWatch endpoint, signed.
 *
 * JSON rather than protobuf: both are accepted, and JSON keeps the failure mode readable — a
 * rejected batch comes back with a message an operator can act on instead of a binary mismatch.
 */
async function postSigned(
  endpoint: string,
  service: string,
  region: string,
  body: Uint8Array,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const url = new URL(endpoint)
  const signer = new SignatureV4({ credentials, region, service, sha256: Sha256 })

  const signed = await signer.sign({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      // `host` is part of the signature, so it has to be present before signing rather than left
      // for fetch to add afterwards — an added-later host produces a signature that does not match.
      host: url.hostname,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body,
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: signed.headers,
    // `Buffer.from` shares the serializer's memory rather than copying it; the cast is only because
    // `BodyInit` predates `Uint8Array` carrying its buffer type as a parameter.
    body: Buffer.from(body) as unknown as BodyInit,
  })

  if (!response.ok) {
    throw new Error(`${service} OTLP endpoint answered ${response.status}: ${await response.text()}`)
  }
}

/** Spans to the X-Ray OTLP endpoint, where Transaction Search indexes them. */
export class SigV4SpanExporter implements SpanExporter {
  private readonly endpoint: string
  private readonly region: string
  private readonly headers: Record<string, string>

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.region = resolveRegion(env)
    this.endpoint = `https://xray.${this.region}.amazonaws.com/v1/traces`
    this.headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const body = JsonTraceSerializer.serializeRequest(spans)
    if (!body) return resultCallback({ code: ExportResultCode.SUCCESS })

    // Suppressed for the same reason as the metrics exporter: resolving credentials calls STS or
    // IMDS through the AWS SDK, which `instrumentation.ts` has patched. Tracing the export of a span
    // produces a span, and a batch that never settles.
    context
      .with(suppressTracing(context.active()), () =>
        postSigned(this.endpoint, 'xray', this.region, body, this.headers),
      )
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((error: Error) => {
        // Logged, not thrown: a telemetry backend that is refusing writes must not take the turn
        // down with it. The line is structured so the failure is greppable next to the turns it
        // failed to describe — a silent exporter is the failure mode this whole module exists to fix.
        console.error(
          JSON.stringify({ level: 'error', event: 'telemetry.spans.failed', reason: error.message }),
        )
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

