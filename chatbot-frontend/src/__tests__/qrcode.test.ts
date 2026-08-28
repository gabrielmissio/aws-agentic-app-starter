import { describe, expect, it } from 'vitest'
import qrcode from 'qrcode-generator'

/**
 * The QR encoder, at the boundary the component depends on.
 *
 * `QrCode.tsx` builds its SVG path from `getModuleCount()` and `isDark(row, col)` rather than from
 * the library's own markup string, so what has to hold is that those two behave: a real grid, and
 * a payload the size of an `otpauth://` URI actually fitting in it. A broken import or a version
 * whose auto-sizing gives up would otherwise surface as a blank square on the enrollment screen,
 * which no type check catches.
 */

const OTPAUTH_URI =
  'otpauth://totp/Aria:user@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Aria&algorithm=SHA1&digits=6&period=30'

describe('encoding an enrollment URI', () => {
  it('produces a square grid with dark modules in it', () => {
    const qr = qrcode(0, 'M')
    qr.addData(OTPAUTH_URI)
    qr.make()

    const count = qr.getModuleCount()
    // Auto-sizing picks a version that fits; anything at or below 21 would mean the payload was
    // silently truncated rather than encoded.
    expect(count).toBeGreaterThan(21)

    let dark = 0
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (qr.isDark(row, col)) dark++
    }
    // A real symbol is roughly half dark. Zero would render a blank white square that scans as
    // nothing — the failure this test exists to catch.
    expect(dark).toBeGreaterThan(count * count * 0.2)
  })

  it('always carries the three finder patterns a scanner looks for', () => {
    const qr = qrcode(0, 'M')
    qr.addData(OTPAUTH_URI)
    qr.make()
    const last = qr.getModuleCount() - 1

    // The corners of each finder square: top-left, top-right, bottom-left. Not the bottom-right,
    // which is where the alignment pattern goes instead.
    expect(qr.isDark(0, 0)).toBe(true)
    expect(qr.isDark(0, last)).toBe(true)
    expect(qr.isDark(last, 0)).toBe(true)
  })

  it('encodes a different URI differently', () => {
    const grid = (value: string) => {
      const qr = qrcode(0, 'M')
      qr.addData(value)
      qr.make()
      const count = qr.getModuleCount()
      return Array.from({ length: count * count }, (_, i) =>
        qr.isDark(Math.floor(i / count), i % count) ? '1' : '0',
      ).join('')
    }

    expect(grid(OTPAUTH_URI)).not.toBe(grid(OTPAUTH_URI.replace('user@', 'other@')))
  })
})
