import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  fetchMFAPreference,
  setUpTOTP,
  updateMFAPreference,
  verifyTOTPSetup,
} from 'aws-amplify/auth'
import { BRAND } from '@/lib/brand.ts'
import { useI18n } from '@/lib/i18n/context.ts'
import { mfaMode, resolveMfaStatus, type MfaStatus } from '@/lib/mfa.ts'
import { TotpSecret } from './TotpSecret.tsx'
import { Alert, Button, CARD_CLASS, Field, TextInput } from './ui/index.ts'

/**
 * Voluntary second-factor enrollment — the only path under `optional`, where Cognito challenges
 * users who already have a factor but never asks anyone to create one. Under `required` sign-in has
 * already enrolled the user, so what is left is confirming it and replacing a lost authenticator;
 * under `off` it is not rendered at all.
 *
 * Portalled into `document.body`, which is not a detail: `AppHeader` sets `backdrop-blur`, and
 * `backdrop-filter` makes an element a containing block for `position: fixed` descendants — so
 * `inset-0` would resolve against the header strip and the dialog would render clipped inside it.
 */
export function TwoFactorDialog({ email, onClose }: { email?: string; onClose: () => void }) {
  const { t } = useI18n()
  const mode = mfaMode()

  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [setup, setSetup] = useState<{
    sharedSecret: string
    setupUri: string
    /** A replacement invalidates the entry the user already has, so it is worded differently. */
    replacing: boolean
  } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const refresh = async () => {
    // `resolveMfaStatus` rather than the preference alone: under `required` an empty preference
    // does not mean unenrolled, and it is the one that knows how to find out.
    setStatus(
      await resolveMfaStatus(mode, {
        readPreference: fetchMFAPreference,
        preferTotp: () => updateMFAPreference({ totp: 'PREFERRED' }),
      }),
    )
  }

  useEffect(() => {
    // Once per open — the dialog is mounted only while open. It reads the account's real state
    // rather than assuming from the mode: under `optional`, two users legitimately differ.
    refresh().catch(() => setError(t('mfa.loadFailed')))
  }, [])

  const beginEnrollment = async (replacing: boolean) => {
    setError('')
    setDone('')
    setBusy(true)
    try {
      const details = await setUpTOTP()
      setSetup({
        sharedSecret: details.sharedSecret,
        // Both, so someone enrolled in two environments can tell the entries apart.
        setupUri: details.getSetupUri(BRAND.name, email).toString(),
        replacing,
      })
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mfa.setupFailed'))
    } finally {
      setBusy(false)
    }
  }

  const confirmEnrollment = async () => {
    setError('')
    setBusy(true)
    try {
      await verifyTOTPSetup({ code: code.trim() })
      // Verifying associates the device; it does not switch the factor on. Without this the user
      // finishes the flow, is told they are protected, and is never challenged.
      await updateMFAPreference({ totp: 'PREFERRED' })
      const replaced = setup?.replacing ?? false
      setSetup(null)
      setDone(t(replaced ? 'mfa.replacedNow' : 'mfa.enrolledNow'))
      await refresh()
    } catch (err) {
      // A six-digit code is valid for one window, so a retry always needs an empty field.
      setCode('')
      setError(err instanceof Error ? err.message : t('auth.totpFailed'))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setError('')
    setBusy(true)
    try {
      await updateMFAPreference({ totp: 'DISABLED' })
      setDone(t('mfa.disabledNow'))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mfa.disableFailed'))
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (setup) void confirmEnrollment()
  }

  // Escape closes it, like the menu it opens from.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('mfa.title')}
      onClick={onClose}
    >
      <div
        // `my-auto`, not a centred flex child: with the QR the panel can outgrow a short viewport,
        // and a centred flex item that overflows is clipped at the top with no way to scroll to it.
        className={`${CARD_CLASS} my-auto w-full max-w-sm p-6 shadow-[var(--shadow-pop)]`}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-foreground">{t('mfa.title')}</h2>

          {error && <Alert tone="danger" role="alert">{error}</Alert>}
          {done && !error && <Alert tone="success">{done}</Alert>}

          {status === null && !error && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}

          {setup ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t(setup.replacing ? 'mfa.replacePrompt' : 'auth.totpSetupPrompt')}
              </p>
              <TotpSecret sharedSecret={setup.sharedSecret} setupUri={setup.setupUri} />
              <Field label={t('auth.totpCodeLabel')} htmlFor="mfa-code">
                <TextInput
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center text-lg tracking-[0.3em]"
                  placeholder="123456"
                  required
                  autoFocus
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? t('common.loading') : t('auth.submitTotpSetup')}
              </Button>
            </>
          ) : (
            status?.kind === 'enrolled' && (
              <>
                <p className="text-sm text-muted-foreground">{t('mfa.enrolled')}</p>
                {/*
                  A lost or changed phone otherwise needs an administrator, and under `required`
                  there is no signing in without the code. Labelled as a replacement because that is
                  what it is: verifying a new secret invalidates the entry already in the app.
                */}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void beginEnrollment(true)}
                  disabled={busy}
                >
                  {t('mfa.replace')}
                </Button>
                {status.canDisable ? (
                  <Button type="button" variant="danger" onClick={() => void disable()} disabled={busy}>
                    {t('mfa.disable')}
                  </Button>
                ) : (
                  // Not a missing feature: the pool mandates a factor, so Cognito would refuse.
                  <p className="text-xs text-muted-foreground">{t('mfa.requiredHint')}</p>
                )}
              </>
            )
          )}

          {!setup && status?.kind === 'notEnrolled' && (
            <>
              <p className="text-sm text-muted-foreground">
                {status.enforced ? t('mfa.enforcedPrompt') : t('mfa.optionalPrompt')}
              </p>
              <Button type="button" onClick={() => void beginEnrollment(false)} disabled={busy}>
                {busy ? t('common.loading') : t('mfa.enroll')}
              </Button>
            </>
          )}

          <Button type="button" variant="ghost" onClick={onClose}>
            {t('mfa.close')}
          </Button>
        </form>
      </div>
    </div>,
    document.body,
  )
}
