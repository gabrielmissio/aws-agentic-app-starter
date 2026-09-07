import { describe, expect, it } from 'vitest'
import { parseBaggage, startTelemetry } from '../telemetry'
import { parseOtlpHeaders } from '../otlp-sigv4'

/**
 * The gate, asserted because it moved. It used to be `OTEL_EXPORTER_OTLP_ENDPOINT` — a collector's
 * address — which meant the deployed runtime was silent, since nothing set it, and would have failed
 * if anything had, because the stock exporter does not sign. `AGENT_OBSERVABILITY_ENABLED` is the
 * variable AgentCore defines for this, and the one `infra/src/stacks/agent-stack.ts` sets.
 */
describe('startTelemetry', () => {
  it('stays off when the variable is unset', () => {
    expect(startTelemetry({}).enabled).toBe(false)
  })

  it('stays off for any value that is not true', () => {
    for (const value of ['false', '', '  ', '1', 'yes']) {
      expect(startTelemetry({ AGENT_OBSERVABILITY_ENABLED: value }).enabled).toBe(false)
    }
  })

  /**
   * Off is a working state, not a broken one: a local run has no credentials and no endpoint to
   * reach, and must not be asked to flush something it never started.
   */
  it('returns a flush that resolves when off', async () => {
    await expect(startTelemetry({}).flush()).resolves.toBeUndefined()
  })

  /**
   * Runs last: this registers the global tracer and meter providers, and Strands returns the first
   * one registered on any later call. Nothing is exported here — the batch processor holds spans
   * until an interval elapses or a flush asks for them.
   */
  it('turns on for true, case-insensitively, and flushes without throwing', async () => {
    const telemetry = startTelemetry({
      AGENT_OBSERVABILITY_ENABLED: 'TRUE',
      AWS_REGION: 'us-east-1',
      OTEL_SERVICE_NAME: 'test-agent',
    })

    expect(telemetry.enabled).toBe(true)
    await expect(telemetry.flush()).resolves.toBeUndefined()
  })
})

describe('parseBaggage', () => {
  it('reads the correlation id the BFF puts there', () => {
    expect(parseBaggage('correlationId=abc-123')).toEqual({ correlationId: 'abc-123' })
  })

  it('finds it among other entries', () => {
    expect(parseBaggage('foo=bar, correlationId=abc-123 ,baz=qux')).toEqual({ correlationId: 'abc-123' })
  })

  it('yields nothing for an absent or unparseable header', () => {
    expect(parseBaggage(undefined)).toEqual({})
    expect(parseBaggage('foo=bar')).toEqual({})
  })
})

describe('parseOtlpHeaders', () => {
  /**
   * These headers decide which log group the spans land in, and therefore whether a retention, a
   * CMK and a data protection policy apply to them at all. A malformed value must degrade to the
   * shared `aws/spans` group rather than throw and take the export down with it.
   */
  it('parses the standard comma-separated form', () => {
    expect(
      parseOtlpHeaders('x-aws-log-group=/aws/vendedlogs/agent,x-aws-log-stream=spans'),
    ).toEqual({ 'x-aws-log-group': '/aws/vendedlogs/agent', 'x-aws-log-stream': 'spans' })
  })

  it('lowercases keys and trims whitespace', () => {
    expect(parseOtlpHeaders(' X-AWS-Log-Group = /g , x-aws-log-stream=spans ')).toEqual({
      'x-aws-log-group': '/g',
      'x-aws-log-stream': 'spans',
    })
  })

  it('yields nothing rather than throwing on an absent or malformed value', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({})
    expect(parseOtlpHeaders('')).toEqual({})
    expect(parseOtlpHeaders('nonsense')).toEqual({})
  })
})
