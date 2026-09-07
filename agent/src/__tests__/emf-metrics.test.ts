import { describe, expect, it } from 'vitest'
import { DataPointType, type ResourceMetrics } from '@opentelemetry/sdk-metrics'
import { EmfMetricExporter, metricName, toEmfRecords } from '../emf-metrics'

/**
 * A collection shaped the way the SDK hands one over, carrying only the fields the mapping reads.
 * Driving a real MeterProvider would test the SDK; what is worth pinning here is the translation
 * into the format CloudWatch Logs turns into a metric.
 */
function collection(
  metrics: {
    name: string
    type?: DataPointType
    points: { attributes?: Record<string, string>; value: unknown }[]
  }[],
): ResourceMetrics {
  return {
    scopeMetrics: [
      {
        metrics: metrics.map((metric) => ({
          descriptor: { name: metric.name },
          dataPointType: metric.type ?? DataPointType.SUM,
          dataPoints: metric.points.map((point) => ({
            attributes: point.attributes ?? {},
            value: point.value,
          })),
        })),
      },
    ],
  } as unknown as ResourceMetrics
}

describe('metricName', () => {
  /** CloudWatch rejects a dot in a metric name, and every Strands instrument has three. */
  it('turns a dotted instrument name into a CloudWatch-legal one', () => {
    expect(metricName('gen_ai.agent.tokens.input')).toBe('GenAiAgentTokensInput')
    expect(metricName('gen_ai.server.time_to_first_token')).toBe('GenAiServerTimeToFirstToken')
  })
})

describe('toEmfRecords', () => {
  it('emits a record CloudWatch Logs will read as a metric', () => {
    const [record] = toEmfRecords(
      collection([{ name: 'gen_ai.agent.tokens.input', points: [{ value: 1200 }] }]),
      'AgenticApp/Agent',
      'my-agent',
    )

    expect(record?._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: 'AgenticApp/Agent',
      Dimensions: [['ServiceName']],
      Metrics: [{ Name: 'GenAiAgentTokensInput' }],
    })
    expect(record?.ServiceName).toBe('my-agent')
    expect(record?.GenAiAgentTokensInput).toBe(1200)
  })

  /**
   * The reason attributes are part of the grouping key. Two tools' durations sharing one record
   * would overwrite each other, and "which tool is slow" is the question the metric exists for.
   */
  it('keeps distinct attribute sets in distinct records', () => {
    const records = toEmfRecords(
      collection([
        {
          name: 'gen_ai.agent.tool.call.count',
          points: [
            { attributes: { 'gen_ai.tool.name': 'get_current_time' }, value: 3 },
            { attributes: { 'gen_ai.tool.name': 'get_signed_in_user' }, value: 5 },
          ],
        },
      ]),
      'AgenticApp/Agent',
      'my-agent',
    )

    expect(records).toHaveLength(2)
    expect(records[0]?._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([
      ['ServiceName', 'GenAiToolName'],
    ])
    expect(records.map((r) => r.GenAiAgentToolCallCount)).toEqual([3, 5])
  })

  it('reduces a histogram to its mean', () => {
    const [record] = toEmfRecords(
      collection([
        {
          name: 'gen_ai.agent.model.latency',
          type: DataPointType.HISTOGRAM,
          points: [{ value: { sum: 900, count: 3 } }],
        },
      ]),
      'AgenticApp/Agent',
      'my-agent',
    )

    expect(record?.GenAiAgentModelLatency).toBe(300)
  })

  /** An empty histogram has no mean; publishing a zero would read as "fast", not as "no calls". */
  it('omits a histogram that recorded nothing', () => {
    expect(
      toEmfRecords(
        collection([
          {
            name: 'gen_ai.agent.model.latency',
            type: DataPointType.HISTOGRAM,
            points: [{ value: { sum: 0, count: 0 } }],
          },
        ]),
        'AgenticApp/Agent',
        'my-agent',
      ),
    ).toEqual([])
  })

  it('yields nothing for a collection with no datapoints', () => {
    expect(toEmfRecords(collection([]), 'AgenticApp/Agent', 'my-agent')).toEqual([])
  })
})

/**
 * The stream name, asserted because the old one collapsed every replica onto one stream.
 *
 * It was `metrics/${process.env.HOSTNAME || 'local'}`, with a comment explaining that per-container
 * streams avoid a sequence-token race between replicas. AgentCore sets no `HOSTNAME`, so every
 * container resolved `metrics/local` and they all raced for exactly the stream the comment claimed
 * to have separated — the premise was false and the code read as if it were true.
 */
describe('EmfMetricExporter stream naming', () => {
  it('gives each process its own stream when the platform names no container', () => {
    const first = new EmfMetricExporter({ AGENT_METRICS_LOG_GROUP: '/g' }).logStream
    const second = new EmfMetricExporter({ AGENT_METRICS_LOG_GROUP: '/g' }).logStream

    expect(first).toMatch(/^metrics\//)
    expect(first).not.toBe(second)
    expect(first).not.toBe('metrics/local')
  })

  it('prefers a container name when one exists', () => {
    expect(new EmfMetricExporter({ AGENT_METRICS_LOG_GROUP: '/g', HOSTNAME: 'box-7' }).logStream).toBe(
      'metrics/box-7',
    )
  })
})
