import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { translate, type Locale } from './core'
import { CATALOGS, I18nContext, STORAGE_KEY, detectLocale, type I18nValue } from './context'

/**
 * Holds the active locale and hands a typed `t` down the tree.
 *
 * This file exports the provider and nothing else on purpose — see the note in `context.ts`.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Preference just will not survive the reload; not worth surfacing.
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next
    }
  }, [])

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(CATALOGS, locale, key, vars),
    }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
