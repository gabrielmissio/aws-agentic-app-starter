import type { ReactNode } from 'react'
import { CARD_CLASS, cn } from './styles.ts'

/** What a list says when it has nothing to show, including what to do about it. */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(CARD_CLASS, 'px-6 py-8 text-center text-sm text-muted-foreground', className)}>
      {children}
    </div>
  )
}
