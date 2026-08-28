import type { EvidenceStep } from './api'

/**
 * Groups the flat evidence trail into readable rows.
 *
 * The trail stays a strict chronological play-by-play — nothing is ever reordered — with two passes
 * that only merge adjacent entries:
 *
 *  - The two mandates the consent surface signs in one approval become a single "you approved" row,
 *    because they *were* one action; showing them apart implies the user did two things.
 *  - A run of consecutive re-verifications collapses into one cluster that still names who checked
 *    what. Each re-verification is the point of the design, but eight in a row read as noise, and
 *    the cluster is expandable.
 *
 * Raw mode renders every step individually instead.
 */
export type TimelineItem =
  | { kind: 'step'; step: EvidenceStep }
  | { kind: 'approval'; checkout: EvidenceStep; payment?: EvidenceStep }
  | { kind: 'verify'; steps: EvidenceStep[] }

export function buildTimeline(steps: EvidenceStep[]): TimelineItem[] {
  const items: TimelineItem[] = []

  for (let i = 0; i < steps.length; ) {
    const step = steps[i] as EvidenceStep

    if (step.type.startsWith('VERIFY_')) {
      const run: EvidenceStep[] = []
      while (i < steps.length && (steps[i] as EvidenceStep).type.startsWith('VERIFY_')) {
        run.push(steps[i] as EvidenceStep)
        i++
      }
      items.push({ kind: 'verify', steps: run })
      continue
    }

    if (step.type === 'CHECKOUT_MANDATE') {
      const next = steps[i + 1]
      if (next?.type === 'PAYMENT_MANDATE') {
        items.push({ kind: 'approval', checkout: step, payment: next })
        i += 2
        continue
      }
      items.push({ kind: 'approval', checkout: step })
      i++
      continue
    }

    items.push({ kind: 'step', step })
    i++
  }

  return items
}
