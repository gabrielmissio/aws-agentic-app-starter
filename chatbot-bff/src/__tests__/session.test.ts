import { describe, expect, it } from 'vitest'
import {
  MIN_SESSION_ID_LENGTH,
  SESSION_NAMESPACE_LENGTH,
  SESSION_SEPARATOR,
  belongsToCaller,
  resolveSessionId,
  sessionNamespace,
} from '../session.js'

describe('sessionNamespace', () => {
  it('is stable for a user and different between users', () => {
    expect(sessionNamespace('user-a')).toBe(sessionNamespace('user-a'))
    expect(sessionNamespace('user-a')).not.toBe(sessionNamespace('user-b'))
  })

  // Hashed so the id does not carry a user identifier into request bodies, logs and screenshots.
  it('does not leak the identifier it was derived from', () => {
    expect(sessionNamespace('user-a')).not.toContain('user-a')
    expect(sessionNamespace('user-a')).toHaveLength(SESSION_NAMESPACE_LENGTH)
  })
})

describe('resolveSessionId', () => {
  const ALICE = 'alice-sub'
  const BOB = 'bob-sub'
  const generate = () => 'generated'

  it('reuses a session id the same caller was given', () => {
    const mine = resolveSessionId(undefined, ALICE)

    expect(resolveSessionId(mine, ALICE)).toBe(mine)
  })

  // The whole point of the binding: an id only works for the user it was minted for, so a leaked
  // id is not replayable and two clients cannot collide into one conversation.
  it('refuses another caller session id and starts a fresh one', () => {
    const alices = resolveSessionId(undefined, ALICE)

    expect(resolveSessionId(alices, BOB, generate)).not.toBe(alices)
    expect(resolveSessionId(alices, BOB, generate)).toContain('generated')
  })

  it('ignores a forged id that carries no real namespace', () => {
    expect(resolveSessionId('a'.repeat(MIN_SESSION_ID_LENGTH), ALICE, generate)).toContain(
      'generated',
    )
  })

  // The prefix alone would pass a naive startsWith check but is still too short for AgentCore.
  it('rejects a candidate that has the right prefix but is too short', () => {
    const shortButPrefixed = `${sessionNamespace(ALICE)}${SESSION_SEPARATOR}`
    expect(shortButPrefixed.length).toBeLessThan(MIN_SESSION_ID_LENGTH)

    expect(resolveSessionId(shortButPrefixed, ALICE, generate)).toContain('generated')
  })

  it('generates when the candidate is too short, missing or not a string', () => {
    expect(resolveSessionId('too-short', ALICE, generate)).toContain('generated')
    expect(resolveSessionId(undefined, ALICE, generate)).toContain('generated')
    expect(resolveSessionId(42, ALICE, generate)).toContain('generated')
  })

  it('produces an id AgentCore will accept', () => {
    expect(resolveSessionId(undefined, ALICE).length).toBeGreaterThanOrEqual(MIN_SESSION_ID_LENGTH)
  })

  /**
   * The id becomes an S3 key prefix in `agent/src/sessions.ts`, where the Strands session store
   * validates it against this exact pattern. A colon — the separator this used to use — fails it,
   * and would surface as a snapshot write throwing mid-turn rather than as a rejected request.
   */
  it('produces an id the conversation store will accept as a key', () => {
    expect(resolveSessionId(undefined, ALICE)).toMatch(/^[a-z0-9_-]+$/)
  })
})

describe('belongsToCaller', () => {
  const ALICE = 'alice-sub'
  const BOB = 'bob-sub'

  it('accepts an id it minted for that caller', () => {
    expect(belongsToCaller(resolveSessionId(undefined, ALICE), ALICE)).toBe(true)
  })

  it('rejects another caller id, which is what stops a cross-user transcript read', () => {
    expect(belongsToCaller(resolveSessionId(undefined, ALICE), BOB)).toBe(false)
  })

  /**
   * A bare namespace is a prefix matching every one of that caller's sessions. Accepting it would
   * turn a single-conversation read into a listing, and a delete into a wipe of the account.
   */
  it('rejects a bare namespace with no conversation after it', () => {
    expect(belongsToCaller(sessionNamespace(ALICE), ALICE)).toBe(false)
    expect(belongsToCaller(`${sessionNamespace(ALICE)}${SESSION_SEPARATOR}`, ALICE)).toBe(false)
  })

  it.each([[undefined], [null], [42], [{}]])('rejects the non-string %s', (candidate) => {
    expect(belongsToCaller(candidate, ALICE)).toBe(false)
  })
})
