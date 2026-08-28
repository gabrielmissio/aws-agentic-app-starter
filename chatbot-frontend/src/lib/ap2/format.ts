/** Shared formatting for the checkout and Explorer surfaces. */

/** Renders integer minor units with their currency, e.g. `BRL 41.80`. */
export function formatAmount(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`
}

/** `m:ss` for a duration in milliseconds, clamped at zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** A hash, shortened for display. The full value stays available in the element's title. */
export function shortHash(hash: string | undefined, max = 32): string {
  if (!hash) return '—'
  return hash.length > max ? `${hash.slice(0, max)}…` : hash
}

/** `YYYY-MM-DD · HH:MM:SS UTC`, or null when the timestamp is missing or unparseable. */
export function formatUtc(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const s = d.toISOString()
  return `${s.slice(0, 10)} · ${s.slice(11, 19)} UTC`
}

/** `HH:MM:SS` in UTC — the compact per-step stamp on the timeline. */
export function formatClock(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(11, 19)
}
