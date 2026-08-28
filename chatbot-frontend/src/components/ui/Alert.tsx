import type { ReactNode } from 'react'
import { cn, TONE_CLASS, type Tone } from './styles.ts'

/**
 * A short, tinted statement: an error on a form, or the Explorer's verdict on a chain.
 *
 * `role="status"` rather than `alert` by default — most uses report an outcome the user just caused,
 * and an assertive live region interrupting a screen reader for that is noise. Pass `role="alert"`
 * for the cases that genuinely interrupt (a failed authorization).
 */
export function Alert({
  tone = 'neutral',
  icon,
  role = 'status',
  className,
  children,
}: {
  tone?: Tone
  icon?: ReactNode
  role?: 'status' | 'alert'
  className?: string
  children: ReactNode
}) {
  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
        TONE_CLASS[tone],
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
