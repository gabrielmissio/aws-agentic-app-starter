import { Suspense, lazy, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { getCurrentUser, signOut } from 'aws-amplify/auth'
import { AdminPanel } from '@/components/AdminPanel.tsx'
import { ChatExperience } from '@/components/ChatExperience.tsx'
import { AuthScreen } from '@/components/AuthScreen.tsx'
import { fetchGroups, isAdmin } from '@/lib/session-roles.ts'

/**
 * The Explorer is loaded on demand.
 *
 * It is a distinct surface most sessions never open — someone chats, and only sometimes goes to
 * check how a payment was verified — so its timeline, markdown and route code have no business in
 * the bundle that has to render the first message.
 */
const ExplorerIndex = lazy(() =>
  import('@/components/explorer/ExplorerIndex.tsx').then((m) => ({ default: m.ExplorerIndex })),
)
const JourneyView = lazy(() =>
  import('@/components/explorer/JourneyView.tsx').then((m) => ({ default: m.JourneyView })),
)
const ActorsView = lazy(() =>
  import('@/components/explorer/ActorsView.tsx').then((m) => ({ default: m.ActorsView })),
)

type View = 'chat' | 'admin'

export function App() {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const [email, setEmail] = useState<string>()
  const [admin, setAdmin] = useState(false)
  const [view, setView] = useState<View>('chat')
  const navigate = useNavigate()

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
      // Signing out from the Explorer would otherwise leave the router on a route the auth screen
      // does not own, so the next sign-in lands somewhere unexpected.
      navigate('/', { replace: true })
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

  const chat =
    view === 'admin' && admin ? (
      <AdminPanel userEmail={email} onSignOut={handleSignOut} onBack={() => setView('chat')} />
    ) : (
      <ChatExperience
        userEmail={email}
        isAdmin={admin}
        onSignOut={handleSignOut}
        onOpenAdmin={() => setView('admin')}
      />
    )

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={chat} />
        <Route path="/explorer" element={<ExplorerIndex />} />
        <Route path="/explorer/actors" element={<ActorsView />} />
        <Route path="/explorer/:journeyId" element={<JourneyView />} />
        {/* Anything else lands back on the chat rather than on a blank page. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
