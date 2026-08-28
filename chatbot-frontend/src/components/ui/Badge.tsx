import type { ReactNode } from 'react'
import { cn, TONE_CLASS, type Tone } from './styles.ts'

/** A small status pill. Same five tones as `Alert`, so a status reads identically at both sizes. */
export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: Tone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
