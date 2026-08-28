import { cn } from './styles.ts'
import { BRAND } from '@/lib/brand.ts'

const SIZE = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
} as const

const ICON_SIZE = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
} as const

/**
 * The agent's face: the brand icon in a filled circle.
 *
 * An icon rather than an illustration, so swapping products is a one-line change in
 * `lib/brand.ts` instead of commissioning artwork — and so nothing has to be downloaded before the
 * first message renders.
 */
export function BrandAvatar({
  size = 'md',
  online,
  className,
}: {
  size?: keyof typeof SIZE
  /** Draws the small presence dot. Decorative — it says the app is running, nothing more. */
  online?: boolean
  className?: string
}) {
  const Icon = BRAND.icon
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn(
          'flex items-center justify-center rounded-full bg-primary text-primary-foreground',
          SIZE[size],
        )}
      >
        <Icon className={ICON_SIZE[size]} aria-hidden="true" />
      </span>
      {online && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-emerald-500" />
      )}
    </span>
  )
}

/** Someone's initials, derived from their email. The fallback when there is no avatar to show. */
export function InitialsAvatar({ email, className }: { email?: string; className?: string }) {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground',
        className,
      )}
    >
      {initialsOf(email)}
    </span>
  )
}

function initialsOf(email?: string): string {
  if (!email) return '?'
  const local = email.split('@')[0] ?? ''
  const parts = local.split(/[^a-zA-Z]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (parts[0]?.slice(0, 2) ?? '??').toUpperCase()
}
