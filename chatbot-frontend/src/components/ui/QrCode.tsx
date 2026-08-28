import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/**
 * A QR code, rendered as SVG.
 *
 * Built from the encoder's `isDark(row, col)` grid rather than its `createSvgTag()` string, so the
 * markup is React elements and never goes through `dangerouslySetInnerHTML` — a library that emits
 * markup should not be the reason an app opens that door.
 *
 * The modules are drawn as one `<path>` instead of a rect per module: a typical `otpauth://` URI
 * lands around 40×40, which is well over a thousand nodes as rects and one node this way.
 *
 * **The colours are fixed black on white in both themes, deliberately.** Contrast here is
 * functional, not decorative — a scanner needs dark modules on a light ground, and a QR that
 * inverted itself in dark mode would simply stop working on many cameras.
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
      // `shapeRendering` keeps the module edges from being antialiased into grey at small sizes,
      // which is what turns a scannable code into an unscannable one.
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
