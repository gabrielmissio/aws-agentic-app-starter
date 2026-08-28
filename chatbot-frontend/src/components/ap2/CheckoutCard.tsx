import { useEffect, useRef, useState } from 'react'
import { Clock, ShieldCheck } from 'lucide-react'
import { confirmCheckout, declineCheckout, CheckoutError, type CheckoutIntent, type Receipt } from '@/lib/ap2/api.ts'
import { formatCountdown } from '@/lib/ap2/format.ts'
import { useI18n, translateErrorCode } from '@/lib/i18n/context.ts'
import { Alert, Button, Card, CardHeader, cn } from '../ui/index.ts'

const CODE_LENGTH = 6

export interface CheckoutCardProps {
  intent: CheckoutIntent
  onAuthorized: (receipt: Receipt) => void
  /** The user refused. Nothing was signed and nothing was charged. */
  onDeclined?: () => void
  /**
   * The window elapsed. Distinct from a decline: nobody refused anything, the checkout simply timed
   * out — so the caller should not record it as a refusal.
   */
  onExpired?: () => void
}

/**
 * The authorization card.
 *
 * It posts straight to the BFF, so the agent never sees the code — the whole reason the card exists
 * rather than the agent asking for a number in the chat. On success the BFF has already verified the
 * approval, had both mandates signed and settled the chain; what comes back is the signed receipt.
 *
 * Two shapes, chosen by the server from the cart's value: a six-digit code above the step-up
 * threshold, and a single confirm below it. The client is told which, but never decides it — the BFF
 * re-derives that from the sealed amount when the card submits.
 */
export function CheckoutCard({ intent, onAuthorized, onDeclined, onExpired }: CheckoutCardProps) {
  const { t } = useI18n()
  const oneTap = intent.requiresStepUp === false

  const [code, setCode] = useState(intent.devOtp ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * The code the boxes were filled from, so a re-issued one replaces it.
   *
   * Opening the gate mints a fresh one-time code and replaces the stored hash, and the intent id is
   * the consent session — so the same card can be handed a different code without ever remounting,
   * and a `key` on the intent id would not catch it either. Without this the boxes would keep
   * showing a code the server has already invalidated, which then fails to authorize.
   */
  const [prefilled, setPrefilled] = useState(intent.devOtp)
  if (prefilled !== intent.devOtp) {
    setPrefilled(intent.devOtp)
    setCode(intent.devOtp ?? '')
    setError(null)
  }

  const expiresAtMs = intent.expiresAt ? new Date(intent.expiresAt).getTime() : null
  const msLeft = expiresAtMs === null ? null : expiresAtMs - now
  const expired = msLeft !== null && msLeft <= 0
  const expiresAtLabel =
    expiresAtMs === null
      ? null
      : new Date(expiresAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  useEffect(() => {
    if (oneTap) return
    const id = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 150)
    return () => clearTimeout(id)
  }, [oneTap])

  // Ticks only while the window is actually open — once authorized or expired there is nothing left
  // to count down, and a timer running behind a settled receipt is pure waste.
  useEffect(() => {
    if (expiresAtMs === null || receipt || expired) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [expiresAtMs, receipt, expired])

  async function authorize() {
    if (expired || busy) return
    if (!oneTap && code.length !== CODE_LENGTH) {
      setError(t('ap2.checkout.enterCode'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      const settled = await confirmCheckout(intent.intentId, intent.seal, oneTap ? undefined : code)
      setReceipt(settled)
      // A brief pause on the success state before the receipt replaces the card, so the outcome
      // registers as a distinct moment rather than the card vanishing mid-tap.
      setTimeout(() => onAuthorized(settled), 800)
    } catch (err) {
      const code = err instanceof CheckoutError ? err.code : 'internal'
      setError(translateErrorCode(t, code))
      setCode('')
      inputRef.current?.focus({ preventScroll: true })
    } finally {
      setBusy(false)
    }
  }

  function decline() {
    if (busy) return
    // Fire-and-forget: the user has decided, and the card should close on their tap rather than on a
    // round trip. The intent expires on its own if the call does not land.
    void declineCheckout(intent.intentId).catch(() => {})
    onDeclined?.()
  }

  const header = (icon: React.ReactNode, title: string, tone: 'primary' | 'warning' = 'primary') => (
    <CardHeader
      icon={
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            tone === 'primary' ? 'bg-primary text-primary-foreground' : 'bg-amber-100 text-amber-700',
          )}
        >
          {icon}
        </span>
      }
      title={title}
      subtitle={t('ap2.checkout.subtitle')}
    />
  )

  if (receipt) {
    return (
      <Card className="w-full">
        {header(<ShieldCheck className="h-4 w-4" />, t('ap2.checkout.authorized'))}
        <div className="flex flex-col items-center gap-1.5 px-4 py-6" role="status" aria-live="polite">
          <ShieldCheck className="h-7 w-7 text-emerald-600" />
          <p className="text-sm font-medium text-foreground">{t('ap2.receipt.authorized')}</p>
          <p className="text-xs text-muted-foreground">{t('ap2.checkout.settling')}</p>
        </div>
      </Card>
    )
  }

  if (expired) {
    const dismiss = onExpired ?? onDeclined
    return (
      <Card className="w-full">
        {header(<Clock className="h-4 w-4" />, t('ap2.checkout.expiredTitle'), 'warning')}
        <div className="flex flex-col gap-3 px-4 py-4" role="status" aria-live="polite">
          <p className="text-sm text-muted-foreground">{intent.summary}</p>
          <Alert tone="warning">
            {t('ap2.checkout.expiredDetail', { time: expiresAtLabel ?? '' })}
          </Alert>
          {dismiss && (
            <Button variant="ghost" size="md" onClick={dismiss}>
              {t('ap2.checkout.dismiss')}
            </Button>
          )}
        </div>
      </Card>
    )
  }

  const slots = Array.from({ length: CODE_LENGTH }, (_, i) => code[i] ?? '')

  return (
    // `relative` is load-bearing: the real input below is `sr-only`, which is `position: absolute`.
    // Without a positioned ancestor its containing block would be the document, so it would be laid
    // out at the card's *unscrolled* coordinates inside the chat's scroll area — stretching the page
    // and making the browser scroll to blank space the moment the input takes focus.
    <section className="relative w-full" aria-label={t('ap2.checkout.regionLabel')}>
      <Card>
        {header(
          <ShieldCheck className="h-4 w-4" />,
          oneTap ? t('ap2.checkout.oneTapTitle') : t('ap2.checkout.authRequired'),
        )}

        <div className="flex flex-col gap-4 px-4 py-4">
          <p className="text-sm text-muted-foreground">{intent.summary}</p>

          {expiresAtLabel && msLeft !== null && (
            <div
              className={cn(
                'flex items-center justify-center gap-1.5 text-xs',
                msLeft <= 60_000 ? 'font-medium text-danger' : 'text-subtle',
              )}
            >
              <Clock className="h-3 w-3" />
              {t('ap2.checkout.countdown', {
                time: expiresAtLabel,
                remaining: formatCountdown(msLeft),
              })}
            </div>
          )}

          {oneTap ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
              {t('ap2.checkout.oneTapHint')}
            </p>
          ) : (
            <>
              {/* The boxes are decorative; the real input is visually hidden but focusable, so screen
                  readers and password managers see one ordinary field rather than six fragments. */}
              <div
                className="flex cursor-text flex-col items-center gap-2.5 py-1"
                onClick={() => inputRef.current?.focus()}
              >
                <span className="text-xs text-muted-foreground">{t('ap2.checkout.enterCode')}</span>
                <div className="flex gap-2" aria-hidden="true">
                  {slots.map((ch, i) => (
                    <span
                      key={i}
                      className={cn(
                        'flex h-11 w-9 items-center justify-center rounded-lg border text-lg font-medium transition-colors',
                        code.length === i
                          ? 'border-primary bg-primary-light text-foreground'
                          : code.length > i
                            ? 'border-border bg-card text-foreground'
                            : 'border-border bg-muted text-transparent',
                      )}
                    >
                      {ch || '·'}
                    </span>
                  ))}
                </div>
              </div>

              <input
                ref={inputRef}
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={CODE_LENGTH}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, ''))
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void authorize()
                }}
                className="sr-only"
                aria-label={t('ap2.checkout.inputLabel')}
                aria-describedby={error ? 'checkout-error' : undefined}
                disabled={busy}
              />
            </>
          )}

          {error && (
            <p id="checkout-error" className="text-center text-xs font-medium text-danger" role="alert">
              {error}
            </p>
          )}

          {intent.devOtp && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs text-amber-700">
              {t('ap2.checkout.demoCodeHint', { code: intent.devOtp })}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Button
              size="lg"
              onClick={() => void authorize()}
              disabled={busy || (!oneTap && code.length !== CODE_LENGTH)}
            >
              {busy ? t('ap2.checkout.confirming') : t('ap2.checkout.confirm')}
            </Button>

            {onDeclined && (
              <Button variant="ghost" size="md" onClick={decline} disabled={busy}>
                {t('ap2.checkout.decline')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </section>
  )
}
