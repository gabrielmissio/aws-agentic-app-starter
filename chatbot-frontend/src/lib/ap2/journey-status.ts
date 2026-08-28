import type { JourneySummary } from './api'

/**
 * How a journey reads in the UI.
 *
 * The backend stores only `pending | settled | declined`. **Expired** is derived here — a still
 * pending intent whose window elapsed — and **superseded** is a decline the user did not make, but a
 * consequence of asking for a different cart. Both distinctions matter to a person reading their own
 * history: "you refused this" and "you changed your mind about the items" are not the same event.
 *
 * Derived in one place so the index list and the detail banner can never disagree.
 */
export type JourneyDisplayStatus = 'settled' | 'declined' | 'superseded' | 'expired' | 'pending'

export function journeyDisplayStatus(
  j: Pick<JourneySummary, 'status' | 'expiresAt' | 'declineReason'>,
  now: Date = new Date(),
): JourneyDisplayStatus {
  if (j.status === 'settled') return 'settled'
  if (j.status === 'declined') return j.declineReason === 'superseded' ? 'superseded' : 'declined'
  if (new Date(j.expiresAt) < now) return 'expired'
  return 'pending'
}
