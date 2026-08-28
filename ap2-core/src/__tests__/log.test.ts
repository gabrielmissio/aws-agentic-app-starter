import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger, log, setLogLevel } from '../log'

/**
 * The logger is a security boundary: redaction must hold even at DEBUG, and the correlation key must
 * survive `.child()` binding so a checkout can be reconstructed from logs. These tests assert both.
 */

function captureLine(write: 'stdout' | 'stderr', fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(process[write], 'write').mockImplementation(() => true)
  try {
    fn()
    expect(spy).toHaveBeenCalledTimes(1)
    return JSON.parse((spy.mock.calls[0]?.[0] as string).trim())
  } finally {
    spy.mockRestore()
  }
}

describe('logger', () => {
  beforeEach(() => setLogLevel('DEBUG'))
  afterEach(() => {
    setLogLevel('INFO')
    vi.restoreAllMocks()
  })

  it('emits one JSON object per line with ts/level/msg and bound + ad-hoc fields', () => {
    const rec = captureLine('stdout', () => createLogger({ service: 'bff' }).info('request', { method: 'POST' }))
    expect(rec).toMatchObject({ level: 'INFO', msg: 'request', service: 'bff', method: 'POST' })
    expect(typeof rec.ts).toBe('string')
  })

  it('binds correlation keys through child()', () => {
    const rec = captureLine('stdout', () =>
      createLogger({ service: 'bff' }).child({ journeyId: 'journey_abc' }).info('intent gate opened'),
    )
    expect(rec).toMatchObject({ service: 'bff', journeyId: 'journey_abc', msg: 'intent gate opened' })
  })

  it.each(['otp', 'hmac', 'sealToken', 'authorization', 'pan', 'cvv', 'apiKey', 'private_key'])(
    'redacts sensitive key %s even at DEBUG',
    (key) => {
      const rec = captureLine('stdout', () => log.debug('m', { [key]: 'super-secret' }))
      expect(rec[key]).toBe('[REDACTED]')
    },
  )

  it('redacts nested sensitive fields and keeps non-sensitive AP2 artifacts', () => {
    const rec = captureLine('stdout', () =>
      log.info('settle', { journeyId: 'j1', intent: { otp: '123456', cartHash: 'h', amountCents: 500 } }),
    )
    const intent = rec.intent as Record<string, unknown>
    expect(intent.otp).toBe('[REDACTED]')
    expect(intent.cartHash).toBe('h')
    expect(intent.amountCents).toBe(500)
    expect(rec.journeyId).toBe('j1')
  })

  it('serializes Errors with a BOUNDED stack above DEBUG and the full stack at DEBUG', () => {
    setLogLevel('INFO')
    const boundedRec = captureLine('stderr', () => log.error('boom', { err: new Error('kaboom') }))
    const bounded = boundedRec.err as Record<string, unknown>
    expect(bounded).toMatchObject({ name: 'Error', message: 'kaboom' })
    expect(typeof bounded.stack).toBe('string')
    const boundedLines = (bounded.stack as string).split('\n')
    expect(boundedLines.length).toBeLessThanOrEqual(8); // STACK_FRAME_LIMIT

    setLogLevel('DEBUG')
    const fullRec = captureLine('stderr', () => log.error('boom', { err: new Error('kaboom') }))
    const full = fullRec.err as Record<string, unknown>
    expect(typeof full.stack).toBe('string')
    // Full stack is a superset of the bounded one (DEBUG keeps every frame).
    expect((full.stack as string).split('\n').length).toBeGreaterThanOrEqual(boundedLines.length)
  })

  it('routes WARN/ERROR to stderr and INFO/DEBUG to stdout', () => {
    expect(captureLine('stderr', () => log.warn('w')).level).toBe('WARN')
    expect(captureLine('stdout', () => log.info('i')).level).toBe('INFO')
  })

  it('gates emission below the active level', () => {
    setLogLevel('WARN')
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    log.info('should not emit')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
