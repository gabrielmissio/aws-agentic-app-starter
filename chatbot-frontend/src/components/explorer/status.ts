import { Clock, Replace, ShieldCheck, TimerOff, XCircle, type LucideIcon } from 'lucide-react'
import type { JourneyDisplayStatus } from '@/lib/ap2/journey-status.ts'
import type { Tone } from '@/components/ui/index.ts'

/**
 * How each journey status looks, decided once.
 *
 * The list and the detail banner read the same two maps, so a checkout can never appear green in
 * one place and grey in the other — which, on a page whose whole job is to be trusted, would be
 * worse than either colour being wrong.
 */
export const STATUS_ICON: Record<JourneyDisplayStatus, LucideIcon> = {
  settled: ShieldCheck,
  declined: XCircle,
  superseded: Replace,
  expired: TimerOff,
  pending: Clock,
}

export const STATUS_TONE: Record<JourneyDisplayStatus, Tone> = {
  settled: 'success',
  declined: 'danger',
  superseded: 'neutral',
  expired: 'warning',
  pending: 'primary',
}
