import { describe, expect, it } from 'vitest'
import {
  conversationIndexUpdate,
  conversationKeys,
  deriveTitle,
  MAX_TITLE_LENGTH,
  resolveConversationsRoute,
  resolveRetentionDays,
  toConversationSummary,
  toTranscript,
} from '../conversations.js'
import { withSessionContext } from '../session-context.js'

describe('resolveConversationsRoute', () => {
  it.each([
    ['GET', '/conversations', { kind: 'list' }],
    ['GET', '/conversations/abc-1', { kind: 'get', sessionId: 'abc-1' }],
    ['DELETE', '/conversations/abc-1', { kind: 'delete', sessionId: 'abc-1' }],
    ['OPTIONS', '/conversations', { kind: 'preflight' }],
  ])('maps %s %s', (method, path, expected) => {
    expect(resolveConversationsRoute(method, path)).toEqual(expected)
  })

  it.each([
    ['a method the route does not serve', 'POST', '/conversations'],
    ['a write to a single conversation', 'PUT', '/conversations/abc-1'],
    ['another resource entirely', 'GET', '/admin/users'],
    ['a path deeper than one id', 'GET', '/conversations/abc-1/messages'],
    ['no path at all', 'GET', undefined],
  ])('refuses %s', (_label, method, path) => {
    expect(resolveConversationsRoute(method, path)).toBeUndefined()
  })

  /**
   * A percent-encoded separator must decode to the same id the ownership check sees. If routing kept
   * it encoded, `belongsToCaller` would compare an encoded string against a decoded namespace and
   * reject a legitimate conversation — or, worse in another shape, let one through unnormalized.
   */
  it('decodes the id before anything else sees it', () => {
    expect(resolveConversationsRoute('GET', '/conversations/abc%2D1')).toEqual({
      kind: 'get',
      sessionId: 'abc-1',
    })
  })
})

describe('deriveTitle', () => {
  it('uses what the user typed, collapsed onto one line', () => {
    expect(deriveTitle('  How   do I\n\nrotate a key? ')).toBe('How do I rotate a key?')
  })

  /** Every stored user turn is wrapped in the identity block; a title must not show it. */
  it('never carries the identity block into a title', () => {
    const wrapped = withSessionContext({ userId: 'sub-1', email: 'a@b.c' }, 'What is the date?')

    expect(deriveTitle(wrapped)).toBe('What is the date?')
    expect(deriveTitle(wrapped)).not.toContain('sub-1')
  })

  it('truncates rather than overflowing the sidebar', () => {
    const title = deriveTitle('x'.repeat(500))

    expect(title).toHaveLength(MAX_TITLE_LENGTH)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back for a message with nothing in it', () => {
    expect(deriveTitle('   ')).toBe('New conversation')
  })
})

describe('conversationIndexUpdate', () => {
  const base = { tableName: 'conversations', userId: 'sub-1', sessionId: 'ns-1', title: 'Hello' }

  it('partitions by the caller, which is what makes a listing incapable of crossing users', () => {
    expect(conversationKeys('sub-1', 'ns-1')).toEqual({ pk: 'USER#sub-1', sk: 'CONV#ns-1' })
    expect(conversationIndexUpdate(base).Key).toEqual({
      pk: { S: 'USER#sub-1' },
      sk: { S: 'CONV#ns-1' },
    })
  })

  /** The first turn names the conversation; later turns must not rename it under the user. */
  it('sets the title only once and the recency every time', () => {
    const update = conversationIndexUpdate(base).UpdateExpression ?? ''

    expect(update).toContain('title = if_not_exists(title, :title)')
    expect(update).toContain('createdAt = if_not_exists(createdAt, :now)')
    expect(update).toContain('updatedAt = :now')
  })

  /** The index must not outlive the content it points at, or the sidebar opens empty rows. */
  it('expires on the same clock as the bucket lifecycle', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z')
    const values = conversationIndexUpdate({ ...base, retentionDays: 7, now }).ExpressionAttributeValues

    expect(values?.[':expiresAt']).toEqual({ N: String(now / 1000 + 7 * 24 * 60 * 60) })
  })
})

describe('resolveRetentionDays', () => {
  it('falls back rather than throwing, because this runs at cold start in the chat path', () => {
    expect(resolveRetentionDays('7')).toBe(7)
    expect(resolveRetentionDays('nonsense')).toBe(30)
    expect(resolveRetentionDays('0')).toBe(30)
    expect(resolveRetentionDays('-5')).toBe(30)
    expect(resolveRetentionDays(undefined)).toBe(30)
  })
})

describe('toConversationSummary', () => {
  it('drops a row missing what the sidebar needs, instead of rendering undefined', () => {
    expect(toConversationSummary({ title: { S: 'Orphan' } })).toBeUndefined()
  })

  it('falls back to the update time when a row predates a creation time', () => {
    const summary = toConversationSummary({
      sessionId: { S: 'ns-1' },
      updatedAt: { S: '2026-01-02T00:00:00.000Z' },
    })

    expect(summary).toEqual({
      sessionId: 'ns-1',
      title: 'New conversation',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
  })
})

describe('toTranscript', () => {
  const at = (iso: string) => new Date(iso)
  const turn = (role: 'USER' | 'ASSISTANT', text: string) => ({
    conversational: { role, content: { text } },
  })

  it('replays a conversation as the two sides of it', () => {
    expect(
      toTranscript([
        { eventTimestamp: at('2026-01-01T10:00:00Z'), payload: [turn('USER', 'What day is it?'), turn('ASSISTANT', 'Thursday.')] },
      ]),
    ).toEqual([
      { role: 'user', content: 'What day is it?' },
      { role: 'agent', content: 'Thursday.' },
    ])
  })

  /**
   * The API promises no ordering. A transcript assembled out of order reads as a different
   * conversation than the one that happened — answers attached to the wrong questions.
   */
  it('orders by the events own timestamps, not by arrival', () => {
    expect(
      toTranscript([
        { eventTimestamp: at('2026-01-01T10:05:00Z'), payload: [turn('USER', 'second')] },
        { eventTimestamp: at('2026-01-01T10:00:00Z'), payload: [turn('USER', 'first')] },
      ]).map((message) => message.content),
    ).toEqual(['first', 'second'])
  })

  it('strips the identity block rather than showing transport as content', () => {
    const wrapped = withSessionContext({ userId: 'sub-1', email: 'a@b.c' }, 'Hi')
    const transcript = toTranscript([{ eventTimestamp: at('2026-01-01T10:00:00Z'), payload: [turn('USER', wrapped)] }])

    expect(transcript).toEqual([{ role: 'user', content: 'Hi' }])
    expect(JSON.stringify(transcript)).not.toContain('sub-1')
  })

  it('ignores a role it has no place for and an empty turn', () => {
    expect(
      toTranscript([
        {
          eventTimestamp: at('2026-01-01T10:00:00Z'),
          payload: [turn('TOOL' as 'USER', '{"weekday":"Thursday"}'), turn('ASSISTANT', '   '), turn('ASSISTANT', 'Thursday.')],
        },
      ]),
    ).toEqual([{ role: 'agent', content: 'Thursday.' }])
  })

  it.each([
    ['a session with no events', []],
    ['a session that was never written', undefined],
    ['an event carrying no payload', [{ eventTimestamp: at('2026-01-01T10:00:00Z') }]],
    ['a payload shape this projection does not read', [{ payload: [{ blob: { anything: true } }] }]],
  ])('returns nothing for %s', (_label, input) => {
    expect(toTranscript(input as never)).toEqual([])
  })
})
