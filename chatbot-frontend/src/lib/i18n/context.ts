/**
 * Everything about i18n that is not a React component.
 *
 * Split from `index.tsx` so that file exports only `I18nProvider`: React Fast Refresh degrades to a
 * full reload for any module that mixes component and non-component exports.
 */
import { createContext, useContext } from 'react'
import { resolveLocale, type Catalog, type Locale, type Vars } from './core'
import { enUS, type MessageKey } from './messages/en-US'
import { ptBR } from './messages/pt-BR'

export { BASE_LOCALE, SUPPORTED_LOCALES, resolveLocale } from './core'
export type { Locale } from './core'
export type { MessageKey } from './messages/en-US'

export const CATALOGS: Record<Locale, Catalog> = {
  'en-US': enUS,
  'pt-BR': ptBR,
}

/** Each label is written in its own language, as it should be. */
export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English',
  'pt-BR': 'Português',
}

/**
 * The same choice, two characters wide.
 *
 * The header switcher sits next to the product name on a phone, where "Português" would push the
 * title off the screen. Full names stay wherever there is room for them — the admin panel's invite
 * form, for one.
 */
export const LOCALE_SHORT_LABELS: Record<Locale, string> = {
  'en-US': 'EN',
  'pt-BR': 'PT',
}

export const STORAGE_KEY = 'app.locale'

/** Typed translator: unknown keys do not compile. */
export type Translate = (key: MessageKey, vars?: Vars) => string

export interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translate
}

export const I18nContext = createContext<I18nValue | undefined>(undefined)

/**
 * Picks the startup locale: an explicit past choice wins, otherwise the browser's preference order,
 * otherwise English. Reading `localStorage` is wrapped because it throws outright in a few privacy
 * modes, and a locale preference is never worth failing to render over.
 */
export function detectLocale(): Locale {
  let stored: string | null
  try {
    stored = localStorage.getItem(STORAGE_KEY)
  } catch {
    stored = null
  }

  return resolveLocale([stored, ...(typeof navigator === 'undefined' ? [] : navigator.languages)])
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>')
  return value
}

/**
 * Maps a BFF error code onto localized copy, falling back to the server's English message and then
 * to a generic line. The server never sends prose we are expected to translate — see
 * `chatbot-bff/src/errors.ts`.
 */
export function translateErrorCode(t: Translate, code?: string, serverMessage?: string): string {
  if (code) {
    const key = `error.${code}` as MessageKey
    const translated = t(key)
    if (translated !== key) return translated
  }

  return serverMessage ?? t('error.internal')
}
