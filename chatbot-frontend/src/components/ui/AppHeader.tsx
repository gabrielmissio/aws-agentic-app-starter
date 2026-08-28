import type { ReactNode } from 'react'

/**
 * The chrome every full-screen surface shares — the chat and the admin panel.
 *
 * One header rather than three near-identical ones: the height, the alignment and the divider are
 * decided here, so a new screen in a new project inherits them for free. It spans the same
 * `max-w-3xl` column the content below it uses, so the title lines up with the first message.
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
   * A second row under the title, aligned with the content column — a tab bar, typically.
   *
   * Anything wider than a couple of icons belongs here rather than in `actions`. The top row does
   * not wrap: on a phone a wrapped `actions` group lands as an unaligned orphan line beneath a
   * centred title, which reads as a broken header rather than as a row.
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
