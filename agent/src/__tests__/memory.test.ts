import { describe, expect, it } from 'vitest'
import { ACTOR_ID_LENGTH, actorIdFor } from '../memory'
import { parseBaggage } from '../telemetry'

/**
 * The actor is what isolates one user's conversations inside the memory store: every read names one,
 * so a leaked session id on its own reaches nothing. It is the namespace the BFF already prefixes
 * onto the session id — `chatbot-bff/src/__tests__/session.test.ts` pins the other half of this
 * contract, because the two packages cannot import from each other.
 */
describe('actorIdFor', () => {
  const ALICE_NAMESPACE = '3f9a1c07b2e4d6a8'
  const sessionOf = (namespace: string) => `${namespace}-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`

  it('is the caller namespace the BFF prefixed onto the session id', () => {
    expect(ACTOR_ID_LENGTH).toBe(16)
    expect(actorIdFor(sessionOf(ALICE_NAMESPACE))).toBe(ALICE_NAMESPACE)
  })

  it('separates two callers, which is the whole isolation property', () => {
    expect(actorIdFor(sessionOf(ALICE_NAMESPACE))).not.toBe(actorIdFor(sessionOf('a1b2c3d4e5f60718')))
  })

  it('does not carry the identifier the namespace was derived from', () => {
    // The BFF hashes the Cognito `sub` before it ever reaches here, so no user id is written into
    // the memory store — this side only ever sees the hash.
    expect(actorIdFor(sessionOf(ALICE_NAMESPACE))).toHaveLength(ACTOR_ID_LENGTH)
  })
})

describe('parseBaggage', () => {
  it('recovers the id the BFF sent', () => {
    expect(parseBaggage('correlationId=abc-123')).toEqual({ correlationId: 'abc-123' })
  })

  it('finds it among other entries a collector may have added', () => {
    expect(parseBaggage('userId=x, correlationId=abc-123, other=y')).toEqual({
      correlationId: 'abc-123',
    })
  })

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['a header carrying other keys only', 'foo=bar'],
  ])('yields nothing for %s', (_label, header) => {
    expect(parseBaggage(header)).toEqual({})
  })
})
