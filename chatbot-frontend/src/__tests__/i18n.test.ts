import { describe, expect, it } from 'vitest'
import {
  BASE_LOCALE,
  SUPPORTED_LOCALES,
  interpolate,
  resolveLocale,
  selectPlural,
  translate,
  type Catalog,
  type Locale,
} from '../lib/i18n/core'
import { enUS } from '../lib/i18n/messages/en-US'
import { ptBR } from '../lib/i18n/messages/pt-BR'

describe('resolveLocale', () => {
  it('matches an exact tag', () => {
    expect(resolveLocale(['pt-BR'])).toBe('pt-BR')
  })

  it('matches on the primary subtag so regional variants still land somewhere sensible', () => {
    expect(resolveLocale(['pt-PT'])).toBe('pt-BR')
    expect(resolveLocale(['en-GB'])).toBe('en-US')
  })

  it('is case insensitive', () => {
    expect(resolveLocale(['PT-br'])).toBe('pt-BR')
  })

  it('walks the candidate list in order and skips empty entries', () => {
    expect(resolveLocale([null, undefined, '', '  ', 'de', 'pt-BR'])).toBe('pt-BR')
  })

  it('falls back to the base locale when nothing matches', () => {
    expect(resolveLocale(['de', 'ja'])).toBe(BASE_LOCALE)
    expect(resolveLocale([])).toBe(BASE_LOCALE)
  })
})

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('Invite sent to {email}', { email: 'a@b.com' })).toBe('Invite sent to a@b.com')
  })

  it('substitutes the same placeholder more than once', () => {
    expect(interpolate('{a} and {a}', { a: 'x' })).toBe('x and x')
  })

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(interpolate('Hello {name}', { other: 'x' })).toBe('Hello {name}')
  })

  it('returns the template untouched with no vars', () => {
    expect(interpolate('Hello {name}')).toBe('Hello {name}')
  })
})

describe('selectPlural', () => {
  it('picks the English categories', () => {
    const forms = { one: '{count} rock', other: '{count} rocks' }
    expect(selectPlural(forms, 'en-US', 1)).toBe('{count} rock')
    expect(selectPlural(forms, 'en-US', 5)).toBe('{count} rocks')
    expect(selectPlural(forms, 'en-US', 0)).toBe('{count} rocks')
  })

  it('follows CLDR rules per locale — Portuguese treats 0 as singular', () => {
    const forms = { one: '{count} pedra', other: '{count} pedras' }
    expect(selectPlural(forms, 'pt-BR', 0)).toBe('{count} pedra')
    expect(selectPlural(forms, 'pt-BR', 1)).toBe('{count} pedra')
    expect(selectPlural(forms, 'pt-BR', 2)).toBe('{count} pedras')
  })

  it('falls back to `other` when the locale needs a category the catalog omits', () => {
    expect(selectPlural({ other: 'fallback' }, 'en-US', 1)).toBe('fallback')
  })
})

describe('translate', () => {
  const catalogs: Partial<Record<Locale, Catalog>> = {
    'en-US': {
      greeting: 'Hello {name}',
      onlyInBase: 'Base only',
      items: { one: '1 item', other: '{count} items' },
    },
    'pt-BR': { greeting: 'Olá {name}' },
  }

  it('uses the requested locale when the key exists there', () => {
    expect(translate(catalogs, 'pt-BR', 'greeting', { name: 'Ana' })).toBe('Olá Ana')
  })

  it('falls back to the base locale for a missing key', () => {
    expect(translate(catalogs, 'pt-BR', 'onlyInBase')).toBe('Base only')
  })

  it('returns the key itself when nothing resolves, so the gap is visible', () => {
    expect(translate(catalogs, 'pt-BR', 'nope')).toBe('nope')
  })

  it('selects a plural form using `count`', () => {
    expect(translate(catalogs, 'en-US', 'items', { count: 1 })).toBe('1 item')
    expect(translate(catalogs, 'en-US', 'items', { count: 7 })).toBe('7 items')
  })
})

describe('catalogs', () => {
  const baseKeys = Object.keys(enUS).sort()

  it('pt-BR defines no key that is absent from the base catalog', () => {
    expect(Object.keys(ptBR).filter((key) => !(key in enUS))).toEqual([])
  })

  // Not a hard requirement — the fallback covers gaps — but the shipped locale is complete today
  // and this is what tells us when that stops being true.
  it('pt-BR currently translates every base key', () => {
    expect(Object.keys(ptBR).sort()).toEqual(baseKeys)
  })

  it('exposes every supported locale, and the base locale is one of them', () => {
    expect(SUPPORTED_LOCALES).toContain(BASE_LOCALE)
    expect(SUPPORTED_LOCALES).toEqual(['en-US', 'pt-BR'])
  })
})
