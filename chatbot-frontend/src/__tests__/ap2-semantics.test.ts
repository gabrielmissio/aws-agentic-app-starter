import { describe, expect, it } from 'vitest'
import {
  ACTOR_ORDER,
  ACTOR_PALETTE,
  actorAttestsKey,
  actorLabelKey,
  humanizeStepType,
  stepKind,
  stepMeaningKey,
  stepSigner,
  stepTitleKey,
} from '../lib/ap2/semantics'
import { enUS } from '../lib/i18n/messages/en-US'

/** Every evidence type the domain records, so the catalog cannot silently fall behind it. */
const DOMAIN_STEP_TYPES = [
  'CART_MANDATE',
  'CART_MANDATE_IDEMPOTENT',
  'CHECKOUT_MANDATE',
  'PAYMENT_MANDATE',
  'PAYMENT_CREDENTIAL_ISSUED',
  'PAYMENT_CREDENTIAL_REDEEMED',
  'PAYMENT_CREDENTIAL_REPLAYED',
  'MERCHANT_INITIATE_PAYMENT',
  'PAYMENT_RECEIPT',
  'PAYMENT_RECEIPT_REPLAYED',
  'PAYMENT_RECEIPT_RACE',
  'MANDATES_ORPHANED',
  'CHECKOUT_RECEIPT',
  'VERIFY_CART_MANDATE',
  'VERIFY_CHECKOUT_MANDATE',
  'VERIFY_PAYMENT_MANDATE',
  'VERIFY_PAYMENT_CREDENTIAL',
  'VERIFY_CHAIN_LINKAGE',
  'BLOCKED_TAMPERED_CART',
  'BLOCKED_INVALID_MANDATE',
  'BLOCKED_EXPIRED',
  'BLOCKED_DOUBLE_SPEND',
  'BLOCKED_OUT_OF_SCOPE',
  'BLOCKED_REPLAY',
  'BLOCKED_IN_PROGRESS',
]

describe('step semantics', () => {
  it.each(DOMAIN_STEP_TYPES)('explains %s in plain language', (type) => {
    // A trail nobody can read is a log, not evidence — so every step the domain records must have
    // both a title and an explanation, and a new one added upstream fails here until it does.
    expect(enUS[stepTitleKey(type) as keyof typeof enUS]).toBeTypeOf('string')
    expect(enUS[stepMeaningKey(type) as keyof typeof enUS]).toBeTypeOf('string')
  })

  it('classifies an unknown step by its prefix rather than giving up', () => {
    // A new VERIFY_* or BLOCKED_* step added to the domain renders correctly before the frontend
    // knows about it, so deploying one side ahead of the other does not break the timeline.
    expect(stepKind('VERIFY_SOMETHING_NEW')).toBe('verify')
    expect(stepKind('BLOCKED_SOMETHING_NEW')).toBe('blocked')
    expect(stepKind('SOMETHING_ENTIRELY_NEW')).toBe('info')
  })

  it('classifies the known steps by what they actually are', () => {
    expect(stepKind('CART_MANDATE')).toBe('signed')
    expect(stepKind('PAYMENT_CREDENTIAL_REDEEMED')).toBe('redeemed')
    expect(stepKind('VERIFY_CHAIN_LINKAGE')).toBe('verify')
    expect(stepKind('BLOCKED_DOUBLE_SPEND')).toBe('blocked')
    expect(stepKind('MERCHANT_INITIATE_PAYMENT')).toBe('info')
  })

  it('attributes each signed artifact to the key that signed it', () => {
    // The colours on the timeline come from this, and they are what let a reader see that four
    // independent parties were involved — so a wrong attribution is a misleading picture.
    expect(stepSigner('CART_MANDATE')).toBe('merchant')
    expect(stepSigner('CHECKOUT_MANDATE')).toBe('consent')
    expect(stepSigner('PAYMENT_MANDATE')).toBe('consent')
    expect(stepSigner('PAYMENT_CREDENTIAL_ISSUED')).toBe('cp')
    expect(stepSigner('PAYMENT_RECEIPT')).toBe('mpp')
    // A re-verification signs nothing; it checks someone else's signature.
    expect(stepSigner('VERIFY_CART_MANDATE')).toBeUndefined()
  })

  it('degrades an uncovered step to something readable', () => {
    expect(humanizeStepType('SOME_NEW_STEP')).toBe('some new step')
  })
})

describe('actors', () => {
  it('covers all four, in chain order', () => {
    expect(ACTOR_ORDER).toEqual(['merchant', 'consent', 'cp', 'mpp'])
  })

  it.each(ACTOR_ORDER)('names %s and says what its signature attests', (kid) => {
    expect(enUS[actorLabelKey(kid) as keyof typeof enUS]).toBeTypeOf('string')
    expect(enUS[actorAttestsKey(kid) as keyof typeof enUS]).toBeTypeOf('string')
  })

  it('gives each actor a distinct hue', () => {
    // Telling the four parties apart at a glance is the single most important thing the timeline
    // conveys; two sharing a colour would quietly undo that.
    const dots = ACTOR_ORDER.map((kid) => ACTOR_PALETTE[kid].dot)
    expect(new Set(dots).size).toBe(ACTOR_ORDER.length)
  })

  it('spells out full class names so Tailwind generates them', () => {
    // Tailwind scans source text. An interpolated class name is simply never generated, and the
    // failure is invisible in review — the page just renders unstyled. Values may hold more than
    // one class (a border and a fill together), each with an optional `/opacity` modifier.
    for (const kid of ACTOR_ORDER) {
      for (const value of Object.values(ACTOR_PALETTE[kid])) {
        expect(value).not.toContain('${')
        for (const className of value.split(' ')) {
          expect(className).toMatch(/^[a-z]+-[a-z]+-\d+(\/\d+)?$/)
        }
      }
    }
  })
})
