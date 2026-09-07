import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, Lightbulb, PanelLeft, Send, ShieldCheck, Sparkles } from 'lucide-react'
import { UserMenu } from './UserMenu.tsx'
import { ChatBubble, type ChatMessage } from './ChatBubble.tsx'
import { ConversationSidebar } from './ConversationSidebar.tsx'
import { ThinkingBubble } from './ThinkingBubble.tsx'
import { LanguageSwitcher } from './LanguageSwitcher.tsx'
import { Alert, AppHeader, BrandAvatar, Button, CARD_CLASS } from './ui/index.ts'
import { sendMessageBff } from '@/lib/api.ts'
import { EmptyReplyError } from '@/lib/stream-parser.ts'
import {
  deleteConversation,
  listConversations,
  readConversation,
  type ConversationSummary,
} from '@/lib/conversations-api.ts'
import { BRAND } from '@/lib/brand.ts'
import { useI18n } from '@/lib/i18n/context.ts'
import { isZoomed } from '@/lib/viewport.ts'

/** How far from the bottom still counts as following the conversation rather than reading back. */
const FOLLOW_SLACK = 120

export interface ChatExperienceProps {
  /** Shown in the header so it is obvious which account is talking to the agent. */
  userEmail?: string
  /**
   * Renders the admin badge and the link to the admin panel. Cosmetic — it reflects a
   * `cognito:groups` claim read in the browser, so it must never be the thing that gates a
   * privileged action; the BFF's admin routes re-check group membership server-side.
   */
  isAdmin?: boolean
  /** Owned by the caller — clears the Cognito session and swaps back to the auth screen. */
  onSignOut?: () => void | Promise<void>
  /** Shown only alongside `isAdmin` — switches the app to the admin panel view. */
  onOpenAdmin?: () => void
}

export function ChatExperience({ userEmail, isAdmin, onSignOut, onOpenAdmin }: ChatExperienceProps) {
  const { t } = useI18n()
  const SUGGESTIONS = [
    { icon: CalendarClock, label: t('chat.suggestionDayLabel'), prompt: t('chat.suggestionDayPrompt') },
    { icon: Lightbulb, label: t('chat.suggestionIdeaLabel'), prompt: t('chat.suggestionIdeaPrompt') },
    { icon: Sparkles, label: t('chat.suggestionDraftLabel'), prompt: t('chat.suggestionDraftPrompt') },
    { icon: ShieldCheck, label: t('chat.suggestionAboutLabel'), prompt: t('chat.suggestionAboutPrompt') },
  ]

  const welcome = (): ChatMessage[] => [
    { id: 'welcome', role: 'agent', content: t('chat.welcome', { brand: BRAND.name }) },
  ]

  const [signingOut, setSigningOut] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(welcome)
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [sessionId, setSessionId] = useState<string | undefined>()

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loadingConversations, setLoadingConversations] = useState(true)
  const [deletingSessionId, setDeletingSessionId] = useState<string>()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notice, setNotice] = useState<string>()

  /**
   * Refreshing the list is never worth interrupting the conversation for: a failure here costs a
   * stale sidebar, and the chat on screen still works. The banner says so and nothing is thrown.
   */
  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations())
    } catch {
      setNotice(t('conversations.loadFailed'))
    } finally {
      setLoadingConversations(false)
    }
    // `t` is stable per locale; refreshing on a language change is harmless and keeps the banner
    // in the language the user is now reading.
  }, [t])

  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])

  const startNewConversation = () => {
    setMessages(welcome())
    setSessionId(undefined)
    setInput('')
    setNotice(undefined)
    setSidebarOpen(false)
  }

  const openConversation = async (id: string) => {
    if (thinking) return

    setSidebarOpen(false)
    setNotice(undefined)

    try {
      const transcript = await readConversation(id)
      setMessages(
        transcript.map((message, index) => ({
          id: `${id}-${index}`,
          role: message.role,
          content: message.content,
        })),
      )
      setSessionId(id)
    } catch {
      setNotice(t('conversations.openFailed'))
      // The list is refreshed rather than left alone: the most likely reason a transcript is gone
      // is that its retention window passed, and the row pointing at it should go too.
      void refreshConversations()
    }
  }

  const removeConversation = async (id: string) => {
    const summary = conversations.find((conversation) => conversation.sessionId === id)
    // The browser's own dialog, deliberately: a destructive action needs a confirmation the user
    // cannot mistake for part of the page, and a bespoke modal here would be the app's only one.
    if (!window.confirm(t('conversations.deleteConfirm', { title: summary?.title ?? '' }))) return

    setDeletingSessionId(id)
    setNotice(undefined)

    try {
      await deleteConversation(id)
      setConversations((current) => current.filter((conversation) => conversation.sessionId !== id))
      // Only if the deleted conversation is the one on screen — deleting a different one from the
      // sidebar must not throw away what the user is in the middle of reading.
      if (id === sessionId) {
        setMessages(welcome())
        setSessionId(undefined)
      }
    } catch {
      setNotice(t('conversations.deleteFailed'))
    } finally {
      setDeletingSessionId(undefined)
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  /** Whether the reader is following the conversation or has scrolled back into its history. */
  const following = useRef(true)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  /**
   * Re-pins the conversation when the software keyboard opens.
   *
   * The shell shrinks to stay above it (see lib/viewport.ts), and the transcript shrinks with it
   * from the bottom — so the message the user was reading when they reached for the composer is the
   * first thing to leave the screen. `following` is read rather than recomputed because by the time
   * this fires the pane has already been resized, which makes every scroll position look far from
   * the bottom.
   */
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const repin = () => {
      if (!following.current || isZoomed(viewport.scale)) return
      // No smooth scroll: this rides an animation the browser is already running.
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }

    viewport.addEventListener('resize', repin)
    return () => viewport.removeEventListener('resize', repin)
  }, [])

  const handleSignOut = async () => {
    if (!onSignOut || signingOut) return
    setSigningOut(true)
    try {
      await onSignOut()
    } finally {
      setSigningOut(false)
    }
  }

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || thinking) return

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: trimmed }
    setMessages((m) => [...m, userMsg])
    setInput('')
    setThinking(true)

    // Ensure we have a session id
    const currentSessionId = sessionId ?? crypto.randomUUID()
    if (!sessionId) setSessionId(currentSessionId)

    const agentMsgId = crypto.randomUUID()
    const toolsUsed: string[] = []

    // Placeholder bubble the stream fills in.
    setMessages((m) => [
      ...m,
      {
        id: agentMsgId,
        role: 'agent',
        content: '',
        isStreaming: true,
        status: t('chat.statusConnecting'),
        toolsUsed: [],
      },
    ])

    /** Applies `fn` to the streaming bubble, leaving the rest of the conversation untouched. */
    const patch = (fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((m) => m.map((msg) => (msg.id === agentMsgId ? fn(msg) : msg)))

    const callbacks = {
      onSessionId: (newSessionId: string) => setSessionId(newSessionId),
      onToken: (token: string) =>
        patch((msg) => ({
          ...msg,
          content: msg.content + token,
          status: t('chat.statusStreaming'),
        })),
      onToolStart: (toolName: string) => {
        if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName)
        patch((msg) => ({
          ...msg,
          toolsUsed: [...toolsUsed],
          activeTool: toolName,
          status: t('chat.statusUsingTool', { tool: toolName }),
        }))
      },
      onThinking: () => patch((msg) => ({ ...msg, status: t('chat.statusThinking') })),
      onStatus: (status: string) => patch((msg) => ({ ...msg, status })),
      onComplete: () =>
        patch((msg) => ({ ...msg, isStreaming: false, activeTool: undefined, status: undefined })),
      onError: (error: Error) => {
        // An empty reply carries no server message to show, so the UI supplies its own wording;
        // anything else is quoted, because the sentence the model layer produced is the one that
        // names the actual problem — a denied model, a throttle, a blocked completion.
        const notice =
          error instanceof EmptyReplyError
            ? t('chat.errorEmptyReply')
            : t('chat.errorWithMessage', { message: error.message })

        patch((msg) => ({
          ...msg,
          // Appended rather than substituted: a turn that failed halfway has real text in it, and
          // replacing it would hide both what the agent managed to say and that it stopped.
          content: msg.content ? `${msg.content}\n\n${notice}` : notice,
          isStreaming: false,
          activeTool: undefined,
          status: undefined,
        }))
      },
    }

    try {
      await sendMessageBff(trimmed, currentSessionId, callbacks)
      // After the turn, not before: the server names a conversation from its first message, so the
      // title only exists once the request has been accepted.
      void refreshConversations()
    } catch {
      patch((msg) => ({
        ...msg,
        content: msg.content || t('chat.errorGeneric'),
        isStreaming: false,
        status: undefined,
      }))
    } finally {
      setThinking(false)
    }
  }

  return (
    <div className="flex h-viewport bg-background">
      <ConversationSidebar
        conversations={conversations}
        activeSessionId={sessionId}
        loading={loadingConversations}
        deletingSessionId={deletingSessionId}
        onSelect={(id) => void openConversation(id)}
        onNew={startNewConversation}
        onDelete={(id) => void removeConversation(id)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
      <AppHeader
        leading={
          <>
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label={t('conversations.open')}
              className="-ml-1 rounded-lg p-2 text-muted-foreground hover:bg-muted lg:hidden"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <BrandAvatar online />
          </>
        }
        title={BRAND.name}
        subtitle={BRAND.tagline}
        actions={
          <>
            <LanguageSwitcher />
            {isAdmin && onOpenAdmin && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onOpenAdmin}
                title={t('chat.adminPanelTitle')}
                aria-label={t('chat.adminPanelTitle')}
                className="max-sm:h-9 max-sm:w-9 max-sm:p-0"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span className="max-sm:sr-only">{t('chat.adminLink')}</span>
              </Button>
            )}
            {onSignOut && (
              <UserMenu email={userEmail} onSignOut={handleSignOut} signingOut={signingOut} />
            )}
          </>
        }
      />

      {notice && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-3">
          <Alert tone="danger" role="alert">
            {notice}
          </Alert>
        </div>
      )}

      <main
        ref={scrollRef}
        onScroll={(e) => {
          const pane = e.currentTarget
          following.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < FOLLOW_SLACK
        }}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={
                m.id === 'welcome' ? { ...m, content: t('chat.welcome', { brand: BRAND.name }) } : m
              }
            />
          ))}
          {thinking && <ThinkingBubble />}

          {/* Only on a genuinely new conversation. A restored one that happens to hold a single
              message is not an empty state, and offering starters under it reads as a bug. */}
          {!sessionId && messages.length === 1 && !thinking && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => send(prompt)}
                  className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:border-primary hover:bg-primary-light`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="leading-tight">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      <footer className="border-t border-border bg-card">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
          className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            // Mirrors MAX_MESSAGE_LENGTH in chatbot-bff/src/http.ts, kept in sync by hand: the two
            // packages build separately. The server rejects a longer message either way — this only
            // decides whether the user finds out while typing or after pressing send.
            maxLength={8000}
            placeholder={t('chat.inputPlaceholder')}
            aria-label={t('chat.inputPlaceholder')}
            className="h-10 flex-1 rounded-full border border-border bg-background px-4 text-base text-foreground transition-colors placeholder:text-subtle hover:border-slate-300 focus:border-primary focus:outline-none sm:text-sm"
            autoFocus
          />
          <Button
            type="submit"
            disabled={!input.trim() || thinking}
            aria-label={t('chat.send')}
            className="h-10 w-10 rounded-full p-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
        <p className="pb-3 text-center text-xs text-subtle">{t('chat.footer')}</p>
      </footer>
      </div>
    </div>
  )
}
