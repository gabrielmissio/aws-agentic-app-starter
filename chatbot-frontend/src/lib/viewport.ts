/**
 * Keeping a full-screen surface above the software keyboard.
 *
 * `100dvh` answers "how tall is the viewport once the browser's own chrome is accounted for" — and
 * on iOS the software keyboard is not browser chrome. It slides over the page without resizing the
 * layout viewport, so a `100dvh` shell keeps its full height and the composer pinned to its bottom
 * edge ends up underneath the keyboard. Safari compensates by panning the layout viewport, which
 * drags the sticky header off the top of the screen and can leave the page offset afterwards.
 *
 * `visualViewport` is the part of the page actually on screen, so the gap between it and
 * `window.innerHeight` is the keyboard. We publish that gap as `--keyboard-inset` and the shell
 * subtracts it — see `h-viewport` in styles.css.
 *
 * Chrome on Android does this natively given `interactive-widget=resizes-content` in the viewport
 * meta tag (index.html): there the layout viewport shrinks along with the visual one, both heights
 * fall together, and the inset measured here stays 0. Safari ignores the key, which is why the
 * measurement exists at all.
 */

/** Below this, the gap is browser chrome mid-collapse or rounding — no keyboard is that short. */
const KEYBOARD_MIN_HEIGHT = 120

/** `visualViewport.scale` is 1 at rest; floating-point drift means it is never quite exactly 1. */
const ZOOM_EPSILON = 0.01

export interface ViewportMetrics {
  /** `window.innerHeight` — the layout viewport, which iOS does not shrink for the keyboard. */
  innerHeight: number
  /** `visualViewport.height` — how much of that layout viewport is on screen. */
  visualHeight: number
  /** `visualViewport.scale` — 1 unless the user has pinched. */
  scale: number
}

/** Whether the user has pinch-zoomed, which shrinks the visual viewport for its own reasons. */
export function isZoomed(scale: number): boolean {
  return scale > 1 + ZOOM_EPSILON
}

/**
 * How much of the viewport the software keyboard covers, in CSS pixels — 0 when none is open.
 *
 * Deliberately blind to `visualViewport.offsetTop`. Subtracting the pan as well would measure "how
 * much of the layout viewport falls below the screen right now", which is a moving target: shrinking
 * the shell removes the reason Safari panned, the pan unwinds, and the next measurement disagrees
 * with the one that caused it. The gap between the two heights is the keyboard whether the page has
 * been panned or not.
 *
 * Pure, so the awkward cases are testable without a browser.
 */
export function keyboardInset({ innerHeight, visualHeight, scale }: ViewportMetrics): number {
  // Resizing the shell mid-gesture would fight the user, and a zoomed visual viewport is smaller
  // for a reason that has nothing to do with a keyboard.
  if (isZoomed(scale)) return 0

  const covered = innerHeight - visualHeight
  return covered >= KEYBOARD_MIN_HEIGHT ? Math.round(covered) : 0
}

/**
 * Publishes `--keyboard-inset` on the document element and keeps it current. Returns a teardown.
 *
 * A no-op where `visualViewport` is missing: the variable keeps the 0 it is declared with in
 * styles.css, and every shell stays a plain `100dvh`.
 */
export function trackKeyboardInset(): () => void {
  const viewport = window.visualViewport
  if (!viewport) return () => {}

  const sync = () => {
    const inset = keyboardInset({
      innerHeight: window.innerHeight,
      visualHeight: viewport.height,
      scale: viewport.scale,
    })
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
  }

  // `scroll` as well as `resize`: iOS pans the visual viewport while the keyboard animates in, and
  // fires nothing but `scroll` for part of that. Both handlers do the same idempotent read.
  viewport.addEventListener('resize', sync)
  viewport.addEventListener('scroll', sync)
  sync()

  return () => {
    viewport.removeEventListener('resize', sync)
    viewport.removeEventListener('scroll', sync)
  }
}
