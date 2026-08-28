import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/**
 * A QR code as SVG, built from the encoder's `isDark(row, col)` grid rather than its
 * `createSvgTag()` string — so no `dangerouslySetInnerHTML` — and drawn as one `<path>` rather than
 * a rect per module, which for a 40×40 symbol is one node instead of a thousand.
 *
 * **Fixed black on white in both themes.** Contrast here is functional: a code that inverted itself
 * in dark mode stops scanning on many cameras.
 */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const { path, extent } = useMemo(() => {
    // Type 0 asks the encoder to pick the smallest version that fits. 'M' recovers ~15% of the
    // symbol, which is the level authenticator apps are built around.
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()

    const count = qr.getModuleCount()
    const quiet = 4 // The spec's quiet zone. Without it, scanners on a busy screen miss the finder.
    const commands: string[] = []

    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) commands.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
      }
    }

    return { path: commands.join(''), extent: count + quiet * 2 }
  }, [value])

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      // `shapeRendering` stops the edges antialiasing to grey at small sizes, which breaks scanning.
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
