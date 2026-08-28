import { useEffect, useRef, useState } from 'react'
import { LogOut, ShieldCheck } from 'lucide-react'
import { useI18n } from '@/lib/i18n/context.ts'
import { mfaMode } from '@/lib/mfa.ts'
import { TwoFactorDialog } from './TwoFactorDialog.tsx'
import { Button, CARD_CLASS, InitialsAvatar } from './ui/index.ts'

interface UserMenuProps {
  email?: string
  onSignOut: () => void | Promise<void>
  signingOut?: boolean
}

export function UserMenu({ email, onSignOut, signingOut }: UserMenuProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [twoFactorOpen, setTwoFactorOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Not rendered at all when the pool runs without MFA: the enrollment APIs behind it would be
  // refused, so offering the entry would be offering a dead end.
  const twoFactorAvailable = mfaMode() !== 'off'

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Escape closes it too: a menu opened by accident should not need a click elsewhere to dismiss.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('common.userMenu')}
        aria-expanded={open}
        className="rounded-full transition-opacity hover:opacity-80"
      >
        <InitialsAvatar email={email} />
      </button>

      {open && (
        <div className={`${CARD_CLASS} absolute right-0 top-full z-50 mt-2 min-w-[14rem] p-3 shadow-[var(--shadow-pop)]`}>
          <p className="text-xs text-muted-foreground">{t('common.connectedAs')}</p>
          <p className="mb-3 break-all text-sm font-medium text-foreground">{email ?? '—'}</p>
          {twoFactorAvailable && (
            <Button
              variant="secondary"
              size="sm"
              className="mb-2 w-full"
              onClick={() => {
                setOpen(false)
                setTwoFactorOpen(true)
              }}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('mfa.menuEntry')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => {
              setOpen(false)
              void onSignOut()
            }}
            disabled={signingOut}
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('common.signOutLabel')}
          </Button>
        </div>
      )}

      {twoFactorOpen && <TwoFactorDialog email={email} onClose={() => setTwoFactorOpen(false)} />}
    </div>
  )
}
