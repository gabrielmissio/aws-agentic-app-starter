/**
 * The i18n engine — pure, dependency-free, and free of React.
 *
 * Everything formatting-related delegates to the platform's `Intl`, so plurals follow CLDR rules for
 * every locale without shipping a rules table. What is left is small enough to keep here: a fallback
 * chain, placeholder interpolation, and plural category selection.
 */

/** Locales the app ships copy for. The first entry is the base and must be complete. */
export const SUPPORTED_LOCALES = ['en-US', 'pt-BR'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** Every fallback ends here, so this catalog is the only one that may not have gaps. */
export const BASE_LOCALE: Locale = 'en-US'

/**
 * A translatable value: either one string, or the CLDR plural categories. Only `other` is required —
 * `one` is optional because some locales do not distinguish it.
 */
export type PluralForms = { other: string } & Partial<
  Record<'zero' | 'one' | 'two' | 'few' | 'many', string>
>
export type MessageValue = string | PluralForms

export type Catalog = Record<string, MessageValue>

/** Values a message can interpolate. `count` additionally drives plural selection. */
export type Vars = Record<string, string | number>

/**
 * Narrows an arbitrary language tag onto a supported locale.
 *
 * Matches exactly first, then by primary subtag, so a browser reporting `pt`, `pt-PT` or `en-GB`
 * still lands on the closest catalog we ship instead of falling through past it to English.
 */
export function resolveLocale(
  candidates: readonly (string | undefined | null)[],
  supported: readonly Locale[] = SUPPORTED_LOCALES,
): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue

    const tag = candidate.trim()
    if (!tag) continue

    const exact = supported.find((locale) => locale.toLowerCase() === tag.toLowerCase())
    if (exact) return exact

    const primary = tag.split('-')[0]?.toLowerCase()
    if (!primary) continue

    const byLanguage = supported.find((locale) => locale.split('-')[0]?.toLowerCase() === primary)
    if (byLanguage) return byLanguage
  }

  return BASE_LOCALE
}

/**
 * Replaces `{name}` placeholders. An unknown placeholder is left verbatim rather than blanked, so a
 * missing variable shows up in review instead of silently producing a gap in the sentence.
 */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

/** Picks a plural form using the locale's own CLDR categories, falling back to `other`. */
export function selectPlural(forms: PluralForms, locale: Locale, count: number): string {
  const category = new Intl.PluralRules(locale).select(count)
  return forms[category] ?? forms.other
}

/**
 * Resolves one key against a locale, then the base locale.
 *
 * Returns the key itself when nothing matches. That is deliberate: a visible `admin.inviteTitle` in
 * the UI is a bug report, whereas an empty string looks like an intentionally blank label.
 */
export function translate(
  catalogs: Partial<Record<Locale, Catalog>>,
  locale: Locale,
  key: string,
  vars?: Vars,
): string {
  const value = catalogs[locale]?.[key] ?? catalogs[BASE_LOCALE]?.[key]

  if (value === undefined) return key

  if (typeof value === 'string') return interpolate(value, vars)

  const count = typeof vars?.count === 'number' ? vars.count : 0
  return interpolate(selectPlural(value, locale, count), vars)
}
