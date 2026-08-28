import { useState } from 'react'
import { useI18n } from '@/lib/i18n/context.ts'
import { Button, Field, QrCode } from './ui/index.ts'

/**
 * The three ways an authenticator app can be given an account, in the order people reach for them.
 *
 * The QR code is the one that matters: enrolling almost always means one device holding the screen
 * and another holding the camera, and neither the link nor the key helps there. The link is for
 * enrolling on the same device the app is on, and the key is the fallback for when a camera is not
 * available — selectable, and next to a copy button, because nobody wants to retype base32.
 *
 * Shared by both places enrollment happens: forced at sign-in under `required`, and voluntary from
 * the security panel under `optional`. One component, so the two cannot drift apart.
 */
export function TotpSecret({ sharedSecret, setupUri }: { sharedSecret: string; setupUri: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sharedSecret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused — an insecure context, a permission prompt declined. The key
      // is on screen and selectable either way, so this is a convenience failing, not the flow.
    }
  }

  return (
    <>
      <div className="flex justify-center">
        <QrCode value={setupUri} label={t('auth.totpQrLabel')} />
      </div>

      <a
        href={setupUri}
        className="text-center text-sm font-medium text-primary hover:underline"
      >
        {t('auth.totpOpenApp')}
      </a>

      <Field label={t('auth.totpSecretLabel')} htmlFor="totp-secret">
        <div className="flex items-center gap-2">
          <code
            id="totp-secret"
            className="flex-1 select-all break-all rounded-md bg-muted px-2 py-1.5 text-xs text-foreground"
          >
            {sharedSecret}
          </code>
          <Button type="button" variant="secondary" onClick={copy}>
            {copied ? t('auth.totpSecretCopied') : t('auth.totpSecretCopy')}
          </Button>
        </div>
      </Field>
    </>
  )
}
