/**
 * Exports the agent's OTel metrics as CloudWatch Embedded Metric Format.
 *
 * **Why not OTLP, when the spans go out over OTLP.** CloudWatch does have a metrics OTLP endpoint,
 * but what it ingests lands in the PromQL-queryable store rather than as a classic
 * namespace/dimension metric. A CloudWatch alarm and a dashboard widget — the two things the
 * assessment asks for and the reason these numbers are wanted at all — are built on the classic
 * kind. EMF produces exactly that: CloudWatch Logs extracts a metric from any log event carrying an
 * `_aws.CloudWatchMetrics` block, so the namespace, the dimensions and the units are ours to name,
 * and the only permission involved is writing to a log group this stack already owns.
 *
 * What this makes available, from instruments Strands already emits and nothing here has to invent:
 * `gen_ai.agent.tokens.input`/`.output`, `gen_ai.agent.tool.call.count`, `.tool.error.count`,
 * `gen_ai.agent.tool.duration`, `gen_ai.agent.model.latency` and `gen_ai.server.time_to_first_token`.
 * The assessment lists these as absent business metrics; they were never absent, only unexported.
 */
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  CreateLogStreamCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import {
  AggregationTemporality,
  DataPointType,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

/** CloudWatch rejects a metric name with a dot, so `gen_ai.agent.tokens.input` becomes a PascalCase name. */
export function metricName(name: string): string {
  return name
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** The dimension set every metric carries. Kept to one so the metric stays cheap to alarm on. */
const DIMENSION = 'ServiceName'

interface EmfRecord {
  _aws: {
    Timestamp: number
    CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string }[] }[]
  }
  [key: string]: unknown
}

/**
 * Turns one collection into EMF records — one per distinct attribute set, since a record's
 * dimensions apply to every metric in it.
 *
 * Exported for the tests: the mapping from OTel's data model to EMF is the part worth pinning, and
 * asserting it through a log client would test the mock instead.
 */
export function toEmfRecords(
  metrics: ResourceMetrics,
  namespace: string,
  serviceName: string,
): EmfRecord[] {
  const timestamp = Date.now()
  const values = new Map<string, Record<string, number>>()

  for (const scope of metrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const name = metricName(metric.descriptor.name)

      for (const point of metric.dataPoints) {
        // Attributes beyond the service name — a tool name, most often — become part of the key so
        // two tools' durations do not collapse into one number.
        const key = JSON.stringify(point.attributes ?? {})
        const bucket = values.get(key) ?? {}

        if (metric.dataPointType === DataPointType.HISTOGRAM) {
          const histogram = point.value as { sum?: number; count: number }
          // A histogram becomes its mean. CloudWatch can hold a StatisticSet, but a mean is what a
          // dashboard line and a latency alarm both read, and it costs one value instead of four.
          if (histogram.count > 0) bucket[name] = (histogram.sum ?? 0) / histogram.count
        } else {
          bucket[name] = point.value as number
        }

        values.set(key, bucket)
      }
    }
  }

  return [...values.entries()]
    .filter(([, bucket]) => Object.keys(bucket).length > 0)
    .map(([key, bucket]) => {
      const attributes = JSON.parse(key) as Record<string, unknown>
      const dimensionNames = [DIMENSION, ...Object.keys(attributes).map(metricName)]

      return {
        _aws: {
          Timestamp: timestamp,
          CloudWatchMetrics: [
            {
              Namespace: namespace,
              Dimensions: [dimensionNames],
              Metrics: Object.keys(bucket).map((name) => ({ Name: name })),
            },
          ],
        },
        [DIMENSION]: serviceName,
        ...Object.fromEntries(
          Object.entries(attributes).map(([k, v]) => [metricName(k), String(v)]),
        ),
        ...bucket,
      }
    })
}

/** Writes those records to a log group, where CloudWatch Logs turns them into metrics. */
export class EmfMetricExporter implements PushMetricExporter {
  private readonly client: CloudWatchLogsClient
  private readonly logGroupName: string
  private readonly logStreamName: string
  private readonly namespace: string
  private readonly serviceName: string
  private streamReady = false

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.client = new CloudWatchLogsClient({ region: env.AWS_REGION || 'us-east-1' })
    this.logGroupName = env.AGENT_METRICS_LOG_GROUP ?? ''
    this.namespace = env.AGENT_METRICS_NAMESPACE || 'AgenticApp/Agent'
    this.serviceName = env.OTEL_SERVICE_NAME || 'agent'
    // One stream per container. Two replicas writing the same stream would have their sequence
    // tokens race; per-container streams cost nothing and remove the contention entirely.
    this.logStreamName = `metrics/${process.env.HOSTNAME || 'local'}`
  }

  /** Configured only in a deployed runtime. Unset, the exporter is a no-op rather than an error. */
  get configured(): boolean {
    return Boolean(this.logGroupName)
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    if (!this.configured) return resultCallback({ code: ExportResultCode.SUCCESS })

    const records = toEmfRecords(metrics, this.namespace, this.serviceName)
    if (records.length === 0) return resultCallback({ code: ExportResultCode.SUCCESS })

    this.write(records)
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((error: Error) => {
        console.error(
          JSON.stringify({ level: 'error', event: 'telemetry.metrics.failed', reason: error.message }),
        )
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  private async write(records: EmfRecord[]): Promise<void> {
    if (!this.streamReady) {
      try {
        await this.client.send(
          new CreateLogStreamCommand({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
          }),
        )
      } catch (error) {
        // Already there — the expected case on every export after the first, and after a restart.
        if ((error as { name?: string }).name !== 'ResourceAlreadyExistsException') throw error
      }
      this.streamReady = true
    }

    await this.client.send(
      new PutLogEventsCommand({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
        logEvents: records.map((record) => ({
          timestamp: record._aws.Timestamp,
          message: JSON.stringify(record),
        })),
      }),
    )
  }

  /**
   * Delta, not cumulative. An EMF record is a datapoint for the period it lands in, so a cumulative
   * counter would publish the container's lifetime total every minute and a token graph would only
   * ever climb.
   */
  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.client.destroy()
  }
}
