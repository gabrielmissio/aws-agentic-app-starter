/**
 * Keeping a full-screen surface above the software keyboard.
 *
 * On iOS the keyboard is not browser chrome: it slides over the page without resizing the layout
 * viewport, so a `100dvh` shell keeps its full height and its pinned composer ends up underneath.
 * The gap between `visualViewport.height` and `window.innerHeight` is the keyboard; it is published
 * as `--keyboard-inset` and subtracted by `h-viewport` in styles.css.
 *
 * Chrome on Android handles this natively via `interactive-widget=resizes-content` (index.html) and
 * the inset stays 0. Safari ignores that key, which is why the measurement exists at all.
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
 * How much of the viewport the keyboard covers, in CSS pixels — 0 when none is open.
 *
 * Deliberately blind to `visualViewport.offsetTop`: subtracting Safari's pan makes this a moving
 * target, since shrinking the shell removes the reason it panned and the next measurement disagrees
 * with the one that caused it. The gap between the two heights is the keyboard either way.
 */
export function keyboardInset({ innerHeight, visualHeight, scale }: ViewportMetrics): number {
  // A zoomed visual viewport is smaller for a reason that has nothing to do with a keyboard.
  if (isZoomed(scale)) return 0

  const covered = innerHeight - visualHeight
  return covered >= KEYBOARD_MIN_HEIGHT ? Math.round(covered) : 0
}

/**
 * Publishes `--keyboard-inset` and keeps it current. A no-op without `visualViewport`: the variable
 * keeps the 0 styles.css declares, and every shell stays a plain `100dvh`.
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

  // `scroll` too: iOS fires only that for part of the keyboard animation. Both reads are idempotent.
  viewport.addEventListener('resize', sync)
  viewport.addEventListener('scroll', sync)
  sync()

  return () => {
    viewport.removeEventListener('resize', sync)
    viewport.removeEventListener('scroll', sync)
  }
}
