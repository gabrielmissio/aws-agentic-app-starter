import type { ReactNode } from 'react'

/**
 * The chrome the chat and the admin panel share, so a new screen inherits the height, alignment and
 * divider for free. Spans the same `max-w-3xl` column as the content below it.
 */
export function AppHeader({
  leading,
  title,
  subtitle,
  actions,
  center,
  below,
}: {
  /** Rendered before the title: an avatar, or a back button. */
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** Rendered at the far right: language switcher, menus. Keep it to a few compact controls. */
  actions?: ReactNode
  /** Centres the title between `leading` and `actions` instead of letting it sit beside them. */
  center?: boolean
  /**
   * A second row under the title — a tab bar, typically. Anything wider than a couple of icons
   * belongs here: the top row does not wrap, and a wrapped `actions` group lands on a phone as an
   * unaligned orphan line under a centred title.
   */
  below?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur">
      <div className="mx-auto max-w-3xl px-4 py-2.5">
        <div className="flex items-center gap-3">
          {leading}
          <div className={center ? 'flex min-w-0 flex-1 justify-center' : 'min-w-0 flex-1'}>
            <div className="min-w-0 leading-tight">
              <h1 className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground sm:text-base">
                {title}
              </h1>
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
        {below && <div className="mt-2 flex items-center gap-1.5">{below}</div>}
      </div>
    </header>
  )
}
