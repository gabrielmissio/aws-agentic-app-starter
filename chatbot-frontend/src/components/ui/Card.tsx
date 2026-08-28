import type { ReactNode } from 'react'
import { CARD_CLASS, cn } from './styles.ts'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(CARD_CLASS, className)}>{children}</div>
}

/**
 * A card's title strip: an optional icon, a title, an optional second line.
 *
 * Separated from the body by a border rather than by a fill, so several stacked cards read as one
 * calm surface instead of a set of coloured headers competing for attention.
 */
export function CardHeader({
  icon,
  title,
  subtitle,
  action,
}: {
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      {icon}
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold text-foreground">{title}</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

/** Standard padding for a card's contents, so every card breathes the same way. */
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-4 py-3', className)}>{children}</div>
}
