import { describe, expect, it } from 'vitest'
import { isZoomed, keyboardInset } from '../lib/viewport'

/** iOS reports the two heights as equal at rest, and only the visual one shrinks for a keyboard. */
const metrics = (innerHeight: number, visualHeight: number, scale = 1) => ({
  innerHeight,
  visualHeight,
  scale,
})

describe('keyboardInset', () => {
  it('is zero when the whole layout viewport is on screen', () => {
    expect(keyboardInset(metrics(844, 844))).toBe(0)
  })

  it('measures the keyboard as the gap between the two viewports', () => {
    expect(keyboardInset(metrics(844, 508))).toBe(336)
  })

  it('ignores a gap too small to be a keyboard', () => {
    // The address bar collapsing on scroll, which the shell must not react to.
    expect(keyboardInset(metrics(844, 760))).toBe(0)
  })

  it('ignores the shrink a pinch gesture causes', () => {
    // Same numbers as the keyboard case; only the scale says it is the user's doing.
    expect(keyboardInset(metrics(844, 508, 2))).toBe(0)
  })

  it('tolerates the scale never being exactly 1', () => {
    expect(keyboardInset(metrics(844, 508, 1.0000001))).toBe(336)
  })

  it('rounds the sub-pixel heights browsers report', () => {
    expect(keyboardInset(metrics(844.5, 508.2))).toBe(336)
  })

  it('never reports a negative inset', () => {
    // Desktop Safari reports a visual viewport slightly taller than innerHeight while rubber-banding.
    expect(keyboardInset(metrics(844, 850))).toBe(0)
  })
})

describe('isZoomed', () => {
  it('treats the resting scale as unzoomed', () => {
    expect(isZoomed(1)).toBe(false)
    expect(isZoomed(1.005)).toBe(false)
  })

  it('detects a real pinch', () => {
    expect(isZoomed(1.5)).toBe(true)
  })
})
