import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { LanguageSwitcher } from '../LanguageSwitcher.tsx'
import { AppHeader, cn } from '../ui/index.ts'
import { useI18n } from '@/lib/i18n/context.ts'

/**
 * Shared chrome for the Explorer routes.
 *
 * The app header, with the product identity swapped for the two tabs: this is where someone goes to
 * check a claim rather than to hold a conversation, so what matters at the top is the trail and the
 * signers behind it.
 *
 * The tabs sit on the header's second row rather than beside the title. They are navigation, not a
 * control, and two translated labels plus the language switcher are wider than a phone's top row —
 * which left them wrapping into an orphan line under a centred title.
 */
export function ExplorerLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const { pathname } = useLocation()

  const tab = (to: string, label: string) => (
    <Link
      key={to}
      to={to}
      aria-current={pathname === to ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 shrink-0 items-center rounded-full px-3 text-xs font-medium transition-colors',
        pathname === to
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )

  return (
    <div className="min-h-[100dvh] bg-background">
      <AppHeader
        center
        leading={
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('ap2.explorer.backToChat')}
          </Link>
        }
        title={
          <>
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            {t('ap2.explorer.title')}
          </>
        }
        actions={<LanguageSwitcher />}
        below={
          <>
            {tab('/explorer', t('ap2.explorer.tabJourneys'))}
            {tab('/explorer/actors', t('ap2.explorer.tabActors'))}
          </>
        }
      />

      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  )
}
