import { describe, expect, it } from 'vitest'
import { journeyDisplayStatus } from '../lib/ap2/journey-status'
import { buildTimeline } from '../lib/ap2/journey-timeline'
import type { EvidenceStep, JourneySummary } from '../lib/ap2/api'

const NOW = new Date('2026-01-01T12:00:00Z')
const future = '2026-01-01T12:05:00Z'
const past = '2026-01-01T11:55:00Z'

type StatusInput = Pick<JourneySummary, 'status' | 'expiresAt' | 'declineReason'>

describe('journeyDisplayStatus', () => {
  it('reports a settled checkout regardless of its window', () => {
    const settled: StatusInput = { status: 'settled', expiresAt: past }
    expect(journeyDisplayStatus(settled, NOW)).toBe('settled')
  })

  it('tells a refusal apart from a replaced cart', () => {
    // "You refused this" and "you changed your mind about the items" are not the same event, and a
    // person reading their own history should not have to work out which one happened.
    expect(journeyDisplayStatus({ status: 'declined', expiresAt: future }, NOW)).toBe('declined')
    expect(
      journeyDisplayStatus(
        { status: 'declined', expiresAt: future, declineReason: 'superseded' },
        NOW,
      ),
    ).toBe('superseded')
    expect(
      journeyDisplayStatus({ status: 'declined', expiresAt: future, declineReason: 'user' }, NOW),
    ).toBe('declined')
  })

  it('derives expiry from a still-pending window that has closed', () => {
    // The backend never stores "expired" — it is the absence of a decision plus the passage of time.
    expect(journeyDisplayStatus({ status: 'pending', expiresAt: past }, NOW)).toBe('expired')
    expect(journeyDisplayStatus({ status: 'pending', expiresAt: future }, NOW)).toBe('pending')
  })
})

/** A trail step, with only the fields the timeline groups on. */
const step = (type: string, entity = 'mpp'): EvidenceStep => ({ type, entity, verified: null })

describe('buildTimeline', () => {
  it('merges the two mandates signed in one approval into one row', () => {
    // They were a single act. Showing them apart implies the user did two separate things.
    const items = buildTimeline([step('CHECKOUT_MANDATE', 'consent'), step('PAYMENT_MANDATE', 'consent')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'approval' })
    if (items[0].kind === 'approval') {
      expect(items[0].checkout.type).toBe('CHECKOUT_MANDATE')
      expect(items[0].payment?.type).toBe('PAYMENT_MANDATE')
    }
  })

  it('keeps a lone checkout mandate as an approval with no payment half', () => {
    const items = buildTimeline([step('CHECKOUT_MANDATE', 'consent'), step('CART_MANDATE', 'merchant')])
    expect(items[0]).toMatchObject({ kind: 'approval' })
    if (items[0].kind === 'approval') expect(items[0].payment).toBeUndefined()
    expect(items[1]).toMatchObject({ kind: 'step' })
  })

  it('collapses a run of consecutive re-verifications into one cluster', () => {
    const items = buildTimeline([
      step('CART_MANDATE', 'merchant'),
      step('VERIFY_CART_MANDATE', 'cp'),
      step('VERIFY_PAYMENT_MANDATE', 'cp'),
      step('VERIFY_PAYMENT_CREDENTIAL', 'mpp'),
      step('PAYMENT_RECEIPT', 'mpp'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['step', 'verify', 'step'])
    if (items[1].kind === 'verify') expect(items[1].steps).toHaveLength(3)
  })

  it('never reorders: the story stays a chronological play-by-play', () => {
    // Grouping is only ever of adjacent entries. Reordering would make the timeline a summary
    // rather than a record, and a record is the entire point of an audit trail.
    const steps = [
      step('CART_MANDATE', 'merchant'),
      step('VERIFY_CART_MANDATE', 'consent'),
      step('CHECKOUT_MANDATE', 'consent'),
      step('PAYMENT_MANDATE', 'consent'),
      step('VERIFY_PAYMENT_MANDATE', 'cp'),
      step('PAYMENT_CREDENTIAL_ISSUED', 'cp'),
    ]
    const flattened = buildTimeline(steps).flatMap((item) =>
      item.kind === 'verify'
        ? item.steps
        : item.kind === 'approval'
          ? [item.checkout, ...(item.payment ? [item.payment] : [])]
          : [item.step],
    )
    expect(flattened).toEqual(steps)
  })

  it('separates verification runs that are not adjacent', () => {
    const items = buildTimeline([
      step('VERIFY_CART_MANDATE', 'cp'),
      step('PAYMENT_CREDENTIAL_ISSUED', 'cp'),
      step('VERIFY_PAYMENT_CREDENTIAL', 'mpp'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['verify', 'step', 'verify'])
  })

  it('returns nothing for an empty trail', () => {
    expect(buildTimeline([])).toEqual([])
  })
})
