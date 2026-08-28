import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { UserMenu } from './UserMenu.tsx'
import { ApiError, inviteUser, listUsers, type AdminUser } from '@/lib/admin-api.ts'
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  translateErrorCode,
  useI18n,
  type Locale,
  type Translate,
} from '@/lib/i18n/context.ts'
import { LanguageSwitcher } from './LanguageSwitcher.tsx'
import type { UserRole } from '@/lib/session-roles.ts'
import {
  Alert,
  AppHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  IconButton,
  Select,
  TextInput,
} from './ui/index.ts'

export interface AdminPanelProps {
  userEmail?: string
  onSignOut: () => void | Promise<void>
  /** Returns to the chat view. There is no router here — the app just swaps components. */
  onBack: () => void
}

/** Cognito's status for someone who has been invited but has not completed the first sign-in. */
const PENDING_STATUS = 'FORCE_CHANGE_PASSWORD'

type UsersResult = { users?: AdminUser[]; errorCode?: string; errorMessage?: string }

/** Kept outside the component so the mount effect can call it without touching state first. */
async function fetchUsers(): Promise<UsersResult> {
  try {
    return { users: await listUsers() }
  } catch (err) {
    return {
      errorCode: err instanceof ApiError ? err.code : undefined,
      errorMessage: err instanceof Error ? err.message : undefined,
    }
  }
}

function statusLabel(t: Translate, user: AdminUser): string {
  if (!user.enabled) return t('admin.statusDisabled')
  if (user.status === PENDING_STATUS) return t('admin.statusPending')
  if (user.status === 'CONFIRMED') return t('admin.statusActive')
  // An unmapped Cognito status is shown raw rather than hidden — it is operational information.
  return user.status ?? t('admin.statusUnknown')
}

export function AdminPanel({ userEmail, onSignOut, onBack }: AdminPanelProps) {
  const { locale, t } = useI18n()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  // Defaults to the admin's own language: most invites go to people in the same place.
  const [inviteLocale, setInviteLocale] = useState<Locale>(locale)
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [invited, setInvited] = useState('')

  const applyResult = useCallback(
    (result: UsersResult) => {
      if (result.users) setUsers(result.users)
      setLoadError(
        result.users ? '' : translateErrorCode(t, result.errorCode, result.errorMessage),
      )
      setLoading(false)
    },
    [t],
  )

  // State is set from the promise callback rather than from the effect body: a synchronous setState
  // there cascades renders. `loading` already starts true, so the first fetch needs no flag flip.
  useEffect(() => {
    let active = true
    void fetchUsers().then((result) => {
      if (active) applyResult(result)
    })
    return () => {
      active = false
    }
  }, [applyResult])

  /** The explicit path — refresh button, post-invite — where the spinner should reappear. */
  const refresh = useCallback(async () => {
    setLoading(true)
    applyResult(await fetchUsers())
  }, [applyResult])

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (inviting) return

    setInviting(true)
    setInviteError('')
    setInvited('')
    try {
      await inviteUser(email, role, inviteLocale)
      setInvited(t('admin.inviteSent', { email }))
      setEmail('')
      setRole('user')
      // Re-read rather than push the response into the table: the list is Cognito's answer, not
      // ours, and refetching keeps the two from drifting.
      await refresh()
    } catch (err) {
      setInviteError(
        err instanceof ApiError
          ? translateErrorCode(t, err.code, err.message)
          : t('admin.inviteFailed'),
      )
    } finally {
      setInviting(false)
    }
  }

  return (
    <div className="flex h-viewport flex-col bg-background">
      <AppHeader
        leading={
          <IconButton variant="ghost" aria-label={t('admin.backToChat')} onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        }
        title={t('admin.title')}
        subtitle={t('admin.subtitle')}
        actions={
          <>
            <LanguageSwitcher />
            <UserMenu email={userEmail} onSignOut={onSignOut} />
          </>
        }
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {/* ── Invite ── */}
          <Card>
            <CardHeader
              icon={<UserPlus className="h-4 w-4 text-primary" aria-hidden="true" />}
              title={t('admin.inviteHeading')}
              subtitle={t('admin.inviteHint')}
            />
            <form onSubmit={submitInvite} className="flex flex-col gap-3 p-4">
              {inviteError && <Alert tone="danger" role="alert">{inviteError}</Alert>}
              {invited && <Alert tone="success">{invited}</Alert>}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field label={t('admin.inviteEmail')} htmlFor="invite-email" className="flex-1">
                  <TextInput
                    id="invite-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('admin.inviteEmailPlaceholder')}
                    required
                  />
                </Field>

                <Field label={t('admin.inviteRole')} htmlFor="invite-role" className="sm:w-32">
                  <Select
                    id="invite-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as UserRole)}
                  >
                    <option value="user">{t('admin.roleUser')}</option>
                    <option value="admin">{t('admin.roleAdmin')}</option>
                  </Select>
                </Field>

                <Field label={t('admin.inviteLanguage')} htmlFor="invite-locale" className="sm:w-36">
                  <Select
                    id="invite-locale"
                    value={inviteLocale}
                    onChange={(e) => setInviteLocale(e.target.value as Locale)}
                  >
                    {SUPPORTED_LOCALES.map((supported) => (
                      <option key={supported} value={supported}>
                        {LOCALE_LABELS[supported]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Button type="submit" disabled={inviting || !email.trim()}>
                  {inviting ? t('admin.inviteSending') : t('admin.inviteSubmit')}
                </Button>
              </div>
            </form>
          </Card>

          {/* ── Users ── */}
          <Card>
            <CardHeader
              icon={<Users className="h-4 w-4 text-primary" aria-hidden="true" />}
              title={t('admin.membersHeading', { count: users.length })}
              action={
                <IconButton
                  variant="ghost"
                  aria-label={t('admin.refresh')}
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </IconButton>
              }
            />

            <div className="p-4">
              {loadError && <Alert tone="danger" role="alert">{loadError}</Alert>}

              {!loadError && loading && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('admin.loadingUsers')}
                </p>
              )}

              {!loadError && !loading && users.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('admin.noUsers')}</p>
              )}

              {!loadError && !loading && users.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-xs font-medium text-muted-foreground">
                        <th className="pb-2">{t('admin.columnUser')}</th>
                        <th className="pb-2">{t('admin.columnRole')}</th>
                        <th className="pb-2">{t('admin.columnStatus')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.username} className="border-t border-border">
                          <td className="py-2 text-foreground">{user.email ?? user.username}</td>
                          <td className="py-2">
                            {user.role === 'admin' ? (
                              <Badge tone="primary">
                                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                                {t('admin.roleAdmin')}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {t('admin.roleUser')}
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground">
                            {statusLabel(t, user)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </div>
      </main>
    </div>
  )
}
