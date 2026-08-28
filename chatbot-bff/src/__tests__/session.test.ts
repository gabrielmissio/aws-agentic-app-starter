import { describe, expect, it } from 'vitest'
import { MIN_SESSION_ID_LENGTH, SESSION_NAMESPACE_LENGTH, resolveSessionId, sessionNamespace } from '../session.js'

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
    const shortButPrefixed = `${sessionNamespace(ALICE)}:`
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
})
