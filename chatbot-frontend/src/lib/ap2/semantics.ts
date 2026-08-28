import type { MessageKey } from '../i18n/context'

/**
 * The structure of the accountability chain: who signs what, and what kind of act each recorded step
 * is.
 *
 * Only structure lives here. The plain-language explanations live in the message catalogs, because
 * they are the part that has to be translated — while the evidence type codes (`CART_MANDATE`,
 * `BLOCKED_TAMPERED_CART`, …) are protocol identifiers and stay language-neutral in every locale.
 * Translating those would make the audit trail harder to compare against the specification, not
 * easier, which is the opposite of what an audit trail is for.
 */
export type ActorKid = 'merchant' | 'consent' | 'cp' | 'mpp'

/** The order the four actors appear in, following the chain rather than the alphabet. */
export const ACTOR_ORDER: ActorKid[] = ['merchant', 'consent', 'cp', 'mpp']

/** What kind of act a recorded step was. Drives the icon and the colour, not the wording. */
export type StepKind = 'signed' | 'verify' | 'redeemed' | 'blocked' | 'info'

/**
 * One hue per signing actor, so a reader can tell the four independent parties apart at a glance —
 * which is the single most important thing the timeline has to convey.
 *
 * Full class strings on purpose: Tailwind scans this file, so an interpolated class name would
 * simply not be generated.
 */
export interface ActorPalette {
  /** The timeline dot for a step this actor signed. */
  dot: string
  badgeBg: string
  badgeText: string
  badgeBorder: string
  /** Border and fill of the artifact card holding what this actor signed. */
  artifact: string
  /** The artifact card's title row — the hue at full strength, on a tinted ground. */
  artifactHead: string
}

export const ACTOR_PALETTE: Record<ActorKid, ActorPalette> = {
  merchant: {
    dot: 'bg-sky-600',
    badgeBg: 'bg-sky-50',
    badgeText: 'text-sky-800',
    badgeBorder: 'border-sky-200',
    artifact: 'border-sky-200 bg-sky-50/50',
    artifactHead: 'text-sky-700',
  },
  consent: {
    dot: 'bg-emerald-600',
    badgeBg: 'bg-emerald-50',
    badgeText: 'text-emerald-800',
    badgeBorder: 'border-emerald-200',
    artifact: 'border-emerald-200 bg-emerald-50/50',
    artifactHead: 'text-emerald-700',
  },
  cp: {
    dot: 'bg-violet-600',
    badgeBg: 'bg-violet-50',
    badgeText: 'text-violet-800',
    badgeBorder: 'border-violet-200',
    artifact: 'border-violet-200 bg-violet-50/50',
    artifactHead: 'text-violet-700',
  },
  mpp: {
    dot: 'bg-amber-600',
    badgeBg: 'bg-amber-50',
    badgeText: 'text-amber-900',
    badgeBorder: 'border-amber-200',
    artifact: 'border-amber-200 bg-amber-50/50',
    artifactHead: 'text-amber-800',
  },
}

/** Which actor's key signed the artifact a step produced. Absent for steps that sign nothing. */
const STEP_SIGNER: Partial<Record<string, ActorKid>> = {
  CART_MANDATE: 'merchant',
  CART_MANDATE_IDEMPOTENT: 'merchant',
  CHECKOUT_RECEIPT: 'merchant',
  MERCHANT_INITIATE_PAYMENT: 'merchant',
  CHECKOUT_MANDATE: 'consent',
  PAYMENT_MANDATE: 'consent',
  PAYMENT_CREDENTIAL_ISSUED: 'cp',
  PAYMENT_CREDENTIAL_REPLAYED: 'cp',
  PAYMENT_RECEIPT: 'mpp',
  PAYMENT_RECEIPT_REPLAYED: 'mpp',
  PAYMENT_RECEIPT_RACE: 'mpp',
  MANDATES_ORPHANED: 'consent',
}

const STEP_KIND: Record<string, StepKind> = {
  CART_MANDATE: 'signed',
  CHECKOUT_MANDATE: 'signed',
  PAYMENT_MANDATE: 'signed',
  PAYMENT_CREDENTIAL_ISSUED: 'signed',
  CHECKOUT_RECEIPT: 'signed',
  PAYMENT_RECEIPT: 'signed',
  PAYMENT_CREDENTIAL_REDEEMED: 'redeemed',
  CART_MANDATE_IDEMPOTENT: 'info',
  MERCHANT_INITIATE_PAYMENT: 'info',
  PAYMENT_RECEIPT_REPLAYED: 'info',
  PAYMENT_CREDENTIAL_REPLAYED: 'info',
  // Not a block and not a signature: two signed artifacts exist and the trail is saying which one
  // counts. 'info' renders it as a note on the timeline, which is what it is.
  PAYMENT_RECEIPT_RACE: 'info',
  MANDATES_ORPHANED: 'info',
  VERIFY_CART_MANDATE: 'verify',
  VERIFY_CHECKOUT_MANDATE: 'verify',
  VERIFY_PAYMENT_MANDATE: 'verify',
  VERIFY_PAYMENT_CREDENTIAL: 'verify',
  VERIFY_CHAIN_LINKAGE: 'verify',
  BLOCKED_TAMPERED_CART: 'blocked',
  BLOCKED_EXPIRED: 'blocked',
  BLOCKED_DOUBLE_SPEND: 'blocked',
  BLOCKED_OUT_OF_SCOPE: 'blocked',
  BLOCKED_INVALID_MANDATE: 'blocked',
  BLOCKED_REPLAY: 'blocked',
}

/**
 * The kind of a step, falling back to its prefix.
 *
 * The prefix fallback matters: a new `VERIFY_*` or `BLOCKED_*` step added to the domain renders
 * correctly here without a frontend change, which keeps a deploy of one from breaking the other.
 */
export function stepKind(type: string): StepKind {
  const known = STEP_KIND[type]
  if (known) return known
  if (type.startsWith('VERIFY_')) return 'verify'
  if (type.startsWith('BLOCKED_')) return 'blocked'
  return 'info'
}

export function stepSigner(type: string): ActorKid | undefined {
  return STEP_SIGNER[type]
}

/** Catalog keys for a step. Unknown steps fall back to a readable form of the code itself. */
export function stepTitleKey(type: string): MessageKey {
  return `ap2.step.${type}.title` as MessageKey
}

export function stepMeaningKey(type: string): MessageKey {
  return `ap2.step.${type}.meaning` as MessageKey
}

export function actorLabelKey(kid: string): MessageKey {
  return `ap2.actor.${kid}.label` as MessageKey
}

export function actorAttestsKey(kid: string): MessageKey {
  return `ap2.actor.${kid}.attests` as MessageKey
}

/**
 * A last-resort label for a step the catalogs do not cover.
 *
 * `CART_MANDATE_IDEMPOTENT` becomes "cart mandate idempotent" — not elegant, but readable, and far
 * better than a raw screaming-snake code in the middle of a plain-language timeline.
 */
export function humanizeStepType(type: string): string {
  return type.replace(/_/g, ' ').toLowerCase()
}
