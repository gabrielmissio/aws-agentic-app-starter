import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../domain'
import { handle, HttpError, ok, type LambdaEvent, type LambdaResult } from '../http'
import { setLogLevel } from '../log'

/**
 * The `handle()` envelope is the entity request boundary: it parses the body once, binds a correlated
 * request logger (service / op / journeyId / traceId), emits exactly ONE access line per request with
 * status and duration, and maps domain and HTTP errors onto responses.
 *
 * The correlation and the error-path logging are the parts worth pinning down: an uncorrelated error
 * line is diagnosable only by guessing which checkout it belonged to.
 */

/** Run an async handler while capturing the single log line it emits (stdout or stderr). */
async function runHandle(run: () => Promise<LambdaResult>): Promise<{ res: LambdaResult; line: Record<string, unknown> }> {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const res = await run()
    const calls = [...out.mock.calls, ...err.mock.calls]
    // Exactly one access line per request, on every path.
    expect(calls.length).toBe(1)
    return { res, line: JSON.parse((calls[0]?.[0] as string).trim()) }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

const evt = (body: unknown): LambdaEvent => ({ body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('handle() envelope', () => {
  beforeEach(() => setLogLevel('INFO'))
  afterEach(() => {
    delete process.env._X_AMZN_TRACE_ID
    vi.restoreAllMocks()
  })

  it('success: returns the handler result and logs one correlated access line with status + duration', async () => {
    process.env._X_AMZN_TRACE_ID = 'Root=1-abc-def;Parent=xyz;Sampled=1'
    const { res, line } = await runHandle(() =>
      handle('mpp', evt({ op: 'initiate_payment', journeyId: 'journey_1' }), async ({ body }) => ok({ echoed: body.op })),
    )
    expect(res.statusCode).toBe(200)
    expect(line).toMatchObject({
      level: 'INFO',
      msg: 'request',
      service: 'mpp',
      op: 'initiate_payment',
      journeyId: 'journey_1',
      traceId: '1-abc-def', // pivots trace <-> logs without pulling in the X-Ray SDK
      status: 200,
    })
    expect(typeof line.durationMs).toBe('number')
  })

  it('BlockedError: maps the code to its HTTP status and logs a correlated warn', async () => {
    const { res, line } = await runHandle(() =>
      handle('mpp', evt({ op: 'pay', journeyId: 'j2' }), async () => {
        throw new BlockedError('TAMPERED', 'cart tampered')
      }),
    )
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ blocked: true, code: 'TAMPERED' })
    expect(line).toMatchObject({ level: 'WARN', msg: 'blocked', code: 'TAMPERED', service: 'mpp', journeyId: 'j2', status: 422 })
  })

  it('HttpError: returns its status and still emits one INFO access line (4xx is visible, not an error)', async () => {
    const { res, line } = await runHandle(() =>
      handle('cp', evt({ op: 'redeem' }), async () => {
        throw new HttpError(404, 'not found')
      }),
    )
    expect(res.statusCode).toBe(404)
    expect(line).toMatchObject({ level: 'INFO', msg: 'request', service: 'cp', status: 404 })
  })

  it('unexpected error: returns a generic 500 and logs an ERROR line with a bounded stack + context', async () => {
    const { res, line } = await runHandle(() =>
      handle('cp', evt({ op: 'redeem', journeyId: 'j3' }), async () => {
        throw new Error('DynamoDB adapter: missing environment variable TABLE_CREDENTIALS')
      }),
    )
    expect(res.statusCode).toBe(500)
    // No internals leak to the caller.
    expect(JSON.parse(res.body)).toEqual({ error: 'internal error' })
    expect(line).toMatchObject({ level: 'ERROR', msg: 'unexpected handler error', service: 'cp', journeyId: 'j3', status: 500 })
    const errField = line.err as Record<string, unknown>
    expect(errField.message).toBe('DynamoDB adapter: missing environment variable TABLE_CREDENTIALS')
    // Diagnosable straight from the line — no redeploy at DEBUG.
    expect(typeof errField.stack).toBe('string')
  })

  it('malformed JSON body: 400 without invoking the handler', async () => {
    const handlerFn = vi.fn(async () => ok({}))
    const { res, line } = await runHandle(() => handle('merchant', evt('{not json'), handlerFn))
    expect(res.statusCode).toBe(400)
    expect(handlerFn).not.toHaveBeenCalled()
    expect(line).toMatchObject({ level: 'INFO', msg: 'request', service: 'merchant', status: 400 })
  })

  it('no trace context (local/dev): the line simply omits traceId', async () => {
    const { line } = await runHandle(() => handle('evidence', evt({}), async () => ok({ ok: true })))
    expect(line.traceId).toBeUndefined()
    expect(line.service).toBe('evidence')
  })
})
