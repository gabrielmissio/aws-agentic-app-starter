import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatClock,
  formatCountdown,
  formatUtc,
  shortHash,
} from '../lib/ap2/format'

describe('formatAmount', () => {
  it('renders minor units with two decimals and the currency', () => {
    expect(formatAmount(4180, 'BRL')).toBe('BRL 41.80')
    expect(formatAmount(0, 'USD')).toBe('USD 0.00')
    expect(formatAmount(5, 'BRL')).toBe('BRL 0.05')
  })
})

describe('formatCountdown', () => {
  it('renders minutes and seconds', () => {
    expect(formatCountdown(125_000)).toBe('2:05')
    expect(formatCountdown(60_000)).toBe('1:00')
    expect(formatCountdown(9_000)).toBe('0:09')
  })

  it('clamps at zero rather than counting into negatives', () => {
    // The card polls once a second, so it will render at least once after the window closes.
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})

describe('shortHash', () => {
  it('leaves a short hash alone', () => {
    expect(shortHash('abc')).toBe('abc')
  })

  it('truncates a long one with an ellipsis', () => {
    const long = 'a'.repeat(64)
    expect(shortHash(long, 10)).toBe('aaaaaaaaaa…')
  })

  it('renders an em dash for a missing hash rather than an empty gap', () => {
    expect(shortHash(undefined)).toBe('—')
  })
})

describe('timestamps', () => {
  it('formats an ISO instant in UTC', () => {
    expect(formatUtc('2026-01-01T12:34:56.000Z')).toBe('2026-01-01 · 12:34:56 UTC')
    expect(formatClock('2026-01-01T12:34:56.000Z')).toBe('12:34:56')
  })

  it('returns null for a missing or unparseable value', () => {
    // Evidence rows come from the server, and a malformed timestamp should drop the stamp rather
    // than render "Invalid Date" in the middle of an audit trail.
    expect(formatUtc(undefined)).toBeNull()
    expect(formatUtc('not a date')).toBeNull()
    expect(formatClock('')).toBeNull()
  })
})
