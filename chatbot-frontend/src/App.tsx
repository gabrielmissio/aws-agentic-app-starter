import { useEffect, useState } from 'react'
import { getCurrentUser, signOut } from 'aws-amplify/auth'
import { AdminPanel } from '@/components/AdminPanel.tsx'
import { ChatExperience } from '@/components/ChatExperience.tsx'
import { AuthScreen } from '@/components/AuthScreen.tsx'
import { fetchGroups, isAdmin } from '@/lib/session-roles.ts'

/**
 * Three surfaces, switched by state rather than by a router: the auth screen, the chat, and the
 * admin panel. There are no linkable, bookmarkable pages here — a router would buy nothing and cost
 * a dependency plus a CloudFront SPA-fallback story. Add one when a deep link becomes real.
 */
type View = 'chat' | 'admin'

export function App() {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const [email, setEmail] = useState<string>()
  const [admin, setAdmin] = useState(false)
  const [view, setView] = useState<View>('chat')

  /** Resolves the signed-in user, if any, and reports whether there is one. */
  const syncUser = () =>
    getCurrentUser()
      .then(async (user) => {
        // `loginId` is the email the user typed; `username` is the pool's internal id.
        setEmail(user.signInDetails?.loginId ?? user.username)
        // A failure here only costs the admin badge/panel access, so it must not cost the session.
        setAdmin(await fetchGroups().then(isAdmin).catch(() => false))
        return true
      })
      .catch(() => false)

  useEffect(() => {
    syncUser()
      .then(setAuthed)
      .finally(() => setChecking(false))
  }, [])

  const handleSignOut = async () => {
    try {
      await signOut()
    } finally {
      // Amplify clears its local token store even when the request to revoke the session
      // server-side fails, so the user still leaves the session they asked to end.
      setAuthed(false)
      setEmail(undefined)
      setAdmin(false)
      setView('chat')
    }
  }

  if (checking) return null

  if (!authed) {
    return (
      <AuthScreen
        onAuthenticated={() => {
          syncUser().then(setAuthed)
        }}
      />
    )
  }

  if (view === 'admin' && admin) {
    return <AdminPanel userEmail={email} onSignOut={handleSignOut} onBack={() => setView('chat')} />
  }

  return (
    <ChatExperience
      userEmail={email}
      isAdmin={admin}
      onSignOut={handleSignOut}
      onOpenAdmin={() => setView('admin')}
    />
  )
}
