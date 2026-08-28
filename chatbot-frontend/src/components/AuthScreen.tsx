import { useState } from 'react'
import { confirmSignIn, confirmSignUp, signIn, signUp, type SignInOutput } from 'aws-amplify/auth'
import { isPublicSignUpEnabled } from '@/lib/auth.ts'
import { routeSignIn, type ChallengeView, type TotpSetup } from '@/lib/auth-steps.ts'
import { BRAND } from '@/lib/brand.ts'
import { useI18n, type MessageKey } from '@/lib/i18n/context.ts'
import { LanguageSwitcher } from './LanguageSwitcher.tsx'
import { TotpSecret } from './TotpSecret.tsx'
import { Alert, BrandAvatar, Button, Card, Field, TextInput } from './ui/index.ts'

type AuthView = 'signIn' | 'signUp' | 'confirmSignUp' | ChallengeView

export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t, locale } = useI18n()
  const publicSignUp = isPublicSignUpEnabled()
  const [view, setView] = useState<AuthView>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /**
   * Routes a sign-in/challenge result to the next view.
   *
   * Every handler sends its result back through here, including the one it gets from *answering* a
   * challenge: sign-in is a chain, and Cognito is what decides whether it is finished. The rules
   * for which step means what live in `routeSignIn`, so they can be tested without a browser.
   */
  const applyResult = (result: SignInOutput) => {
    const routing = routeSignIn(result, { issuer: BRAND.name, account: email })

    if (routing.kind === 'signedIn') {
      onAuthenticated()
      return
    }

    if (routing.kind === 'unsupported') {
      setError(t('auth.unsupportedStep', { step: routing.step }))
      return
    }

    if (routing.totp) setTotpSetup(routing.totp)
    // A fresh field for every challenge: a six-digit code is valid for one window, so whatever is
    // in there from a previous step is already stale.
    setTotpCode('')
    setView(routing.view)
  }

  const handleSignIn = async () => {
    setError('')
    setLoading(true)
    try {
      applyResult(await signIn({ username: email, password }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.signInFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleSignUp = async () => {
    setError('')
    setLoading(true)
    try {
      await signUp({
        username: email,
        password,
        // The current UI language, so the CustomMessage trigger can send the verification (and any
        // later invite) email in it — see LOCALE_ATTRIBUTE in chatbot-bff/src/admin.ts.
        options: { userAttributes: { email, 'custom:inviteLocale': locale } },
      })
      setView('confirmSignUp')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.signUpFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleConfirm = async () => {
    setError('')
    setLoading(true)
    try {
      await confirmSignUp({ username: email, confirmationCode: confirmCode })
      // Auto sign-in after confirmation, routed through `applyResult`: with MFA required this
      // sign-in answers with an enrollment challenge rather than a session, and treating a
      // not-signed-in result as "nothing to do" would leave the user on a dead confirmation screen.
      applyResult(await signIn({ username: email, password }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.confirmationFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleNewPassword = async () => {
    setError('')
    setLoading(true)
    try {
      applyResult(await confirmSignIn({ challengeResponse: newPassword }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.newPasswordFailed'))
    } finally {
      setLoading(false)
    }
  }

  /**
   * Answers both TOTP challenges — enrollment and a later sign-in — with the same call.
   *
   * The result goes back through `applyResult`: enrolling can be followed by another step, and
   * Cognito is the one that decides whether the chain is finished.
   */
  const handleTotp = async () => {
    setError('')
    setLoading(true)
    try {
      applyResult(await confirmSignIn({ challengeResponse: totpCode.trim() }))
    } catch (err) {
      // The code is wrong or expired far more often than anything else here, and either way the
      // next attempt needs an empty field — a six-digit code is only valid for one window.
      setTotpCode('')
      setError(err instanceof Error ? err.message : t('auth.totpFailed'))
    } finally {
      setLoading(false)
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (view === 'signIn') handleSignIn()
    else if (view === 'signUp') handleSignUp()
    else if (view === 'confirmSignUp') handleConfirm()
    else if (view === 'totpSetup' || view === 'totpCode') handleTotp()
    else handleNewPassword()
  }

  const TITLES: Record<AuthView, MessageKey> = {
    signIn: 'auth.signInTitle',
    signUp: 'auth.signUpTitle',
    confirmSignUp: 'auth.verifyEmailTitle',
    newPassword: 'auth.newPasswordTitle',
    totpSetup: 'auth.totpSetupTitle',
    totpCode: 'auth.totpCodeTitle',
  }

  const SUBMIT_LABELS: Record<AuthView, MessageKey> = {
    signIn: 'auth.submitSignIn',
    signUp: 'auth.submitSignUp',
    confirmSignUp: 'auth.submitVerify',
    newPassword: 'auth.submitNewPassword',
    totpSetup: 'auth.submitTotpSetup',
    totpCode: 'auth.submitTotpCode',
  }

  const title = t(TITLES[view])
  const submitLabel = loading ? t('common.loading') : t(SUBMIT_LABELS[view])

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>

      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <BrandAvatar size="lg" />
        <div>
          <p className="text-lg font-semibold text-foreground">{BRAND.name}</p>
          <p className="text-xs text-muted-foreground">{BRAND.tagline}</p>
        </div>
      </div>

      <Card className="w-full max-w-sm">
        <form onSubmit={onSubmit} className="flex flex-col gap-4 p-6">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>

          {error && <Alert tone="danger" role="alert">{error}</Alert>}

          {(view === 'signIn' || view === 'signUp') && (
            <>
              <Field label={t('auth.email')} htmlFor="auth-email">
                <TextInput
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth.emailPlaceholder')}
                  required
                  autoFocus
                  autoComplete="email"
                />
              </Field>

              <Field label={t('auth.password')} htmlFor="auth-password">
                <TextInput
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete={view === 'signIn' ? 'current-password' : 'new-password'}
                />
              </Field>
            </>
          )}

          {view === 'confirmSignUp' && (
            <>
              <p className="text-sm text-muted-foreground">{t('auth.checkEmailForCode')}</p>
              <Field label={t('auth.confirmationCode')} htmlFor="auth-code">
                <TextInput
                  id="auth-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  className="text-center text-lg tracking-[0.3em]"
                  placeholder="123456"
                  required
                  autoFocus
                />
              </Field>
            </>
          )}

          {view === 'newPassword' && (
            <>
              <p className="text-sm text-muted-foreground">{t('auth.newPasswordPrompt')}</p>
              <Field label={t('auth.newPassword')} htmlFor="auth-new-password">
                <TextInput
                  id="auth-new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoFocus
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          {view === 'totpSetup' && totpSetup && (
            <>
              <p className="text-sm text-muted-foreground">{t('auth.totpSetupPrompt')}</p>

              <TotpSecret sharedSecret={totpSetup.sharedSecret} setupUri={totpSetup.setupUri} />
            </>
          )}

          {view === 'totpCode' && (
            <p className="text-sm text-muted-foreground">{t('auth.totpCodePrompt')}</p>
          )}

          {(view === 'totpSetup' || view === 'totpCode') && (
            <Field label={t('auth.totpCodeLabel')} htmlFor="auth-totp-code">
              <TextInput
                id="auth-totp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="text-center text-lg tracking-[0.3em]"
                placeholder="123456"
                required
                autoFocus
              />
            </Field>
          )}

          <Button type="submit" size="lg" disabled={loading}>
            {submitLabel}
          </Button>

          {view === 'signIn' && publicSignUp && (
            <p className="text-center text-xs text-muted-foreground">
              {t('auth.noAccountPrompt')}{' '}
              <button
                type="button"
                onClick={() => {
                  setView('signUp')
                  setError('')
                }}
                className="font-medium text-primary hover:underline"
              >
                {t('auth.signUpLink')}
              </button>
            </p>
          )}
          {view === 'signIn' && !publicSignUp && (
            <p className="text-center text-xs text-muted-foreground">{t('auth.inviteOnlyHint')}</p>
          )}
          {view === 'signUp' && (
            <p className="text-center text-xs text-muted-foreground">
              {t('auth.alreadyHaveAccountPrompt')}{' '}
              <button
                type="button"
                onClick={() => {
                  setView('signIn')
                  setError('')
                }}
                className="font-medium text-primary hover:underline"
              >
                {t('auth.signInLink')}
              </button>
            </p>
          )}
        </form>
      </Card>
    </div>
  )
}
