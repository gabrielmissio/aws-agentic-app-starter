/**
 * The class strings every primitive is built from.
 *
 * Pure functions rather than components, so a `<Link>` or an `<a>` can look exactly like a button
 * without wrapping one — and so React Fast Refresh keeps working in the component modules that
 * import them (a module mixing component and non-component exports falls back to a full reload).
 *
 * Full class strings on purpose: Tailwind scans source text, so a class assembled by interpolation
 * would simply never be generated.
 */

/** Joins class names, dropping anything falsy — the usual `cn` helper, without the dependency. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary-dark',
  secondary: 'border border-border bg-card text-foreground hover:bg-muted',
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  danger: 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
}

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 w-full px-5 text-sm',
}

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size])
}

/** Square button for an icon on its own. Same visual language, no text metrics to balance. */
export function iconButtonClass(variant: Exclude<ButtonVariant, 'primary'> = 'secondary'): string {
  return cn(BUTTON_BASE, BUTTON_VARIANT[variant], 'h-9 w-9 shrink-0 p-0')
}

export const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-base text-foreground transition-colors placeholder:text-subtle hover:border-slate-300 focus:border-primary focus:outline-none disabled:opacity-50 sm:text-sm'

export const CARD_CLASS = 'rounded-xl border border-border bg-card shadow-[var(--shadow-card)]'

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

/** The five status hues, used by badges, alerts and the Explorer's banners alike. */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  primary: 'border-blue-200 bg-primary-light text-primary-dark',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
}
