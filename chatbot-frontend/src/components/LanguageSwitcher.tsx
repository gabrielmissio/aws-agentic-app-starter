import { Languages } from 'lucide-react'
import { LOCALE_SHORT_LABELS, SUPPORTED_LOCALES, useI18n, type Locale } from '@/lib/i18n/context.ts'

/**
 * A native `<select>` rather than a custom dropdown: it is keyboard- and screen-reader-correct for
 * free, and on mobile it opens the platform picker. The icon carries the meaning when the label is
 * hidden on narrow screens.
 */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n()

  return (
    <label className="flex h-9 items-center gap-1 rounded-lg border border-border bg-card px-2 text-muted-foreground transition-colors hover:bg-muted">
      <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        aria-label={t('common.language')}
        className="cursor-pointer bg-transparent text-base font-medium text-foreground focus:outline-none sm:text-xs"
      >
        {SUPPORTED_LOCALES.map((supported) => (
          <option key={supported} value={supported}>
            {LOCALE_SHORT_LABELS[supported]}
          </option>
        ))}
      </select>
    </label>
  )
}
