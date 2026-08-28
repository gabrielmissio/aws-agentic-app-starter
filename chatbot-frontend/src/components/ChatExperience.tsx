import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, ScrollText, Send, ShieldCheck, Wallet, Zap } from 'lucide-react'
import { UserMenu } from './UserMenu.tsx'
import { ChatBubble, type ChatMessage } from './ChatBubble.tsx'
import { ThinkingBubble } from './ThinkingBubble.tsx'
import { LanguageSwitcher } from './LanguageSwitcher.tsx'
import { CheckoutCard } from './ap2/CheckoutCard.tsx'
import { ReceiptCard } from './ap2/ReceiptCard.tsx'
import { AppHeader, BrandAvatar, Button, CARD_CLASS, iconButtonClass } from './ui/index.ts'
import { sendMessageBff } from '@/lib/api.ts'
import { openCheckout, type CheckoutIntent, type Receipt } from '@/lib/ap2/api.ts'
import { BRAND } from '@/lib/brand.ts'
import { useI18n } from '@/lib/i18n/context.ts'
import { isZoomed } from '@/lib/viewport.ts'

/**
 * A note handed to the agent on the user's next turn, telling it how a checkout ended.
 *
 * The authorization and the settlement happen outside the agent — which is the point of the design —
 * so this is the only way it learns that a journey closed. It is sent to the model and never shown
 * in the user's own bubble.
 */
function outcomeNote(outcome: 'paid' | 'declined' | 'expired', receipt?: Receipt): string {
  const closing =
    'That journey is now closed. For anything further, start a NEW journey with a fresh cart.'

  if (outcome === 'paid' && receipt) {
    return `[SYSTEM EVENT — not visible to the user] The proposed order (journeyId ${receipt.journeyId}) was authorized and PAID (receipt ${receipt.receiptId}). ${closing}`
  }
  if (outcome === 'declined') {
    return `[SYSTEM EVENT — not visible to the user] The user DECLINED the proposed order. No payment was made and that journey is closed. Do not re-propose it unless the user asks.`
  }
  return `[SYSTEM EVENT — not visible to the user] The proposed order EXPIRED before the user authorized it. No payment was made. ${closing}`
}

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
    { icon: BookOpen, label: t('chat.suggestionMenuLabel'), prompt: t('chat.suggestionMenuPrompt') },
    { icon: Zap, label: t('chat.suggestionProteinLabel'), prompt: t('chat.suggestionProteinPrompt') },
    { icon: Wallet, label: t('chat.suggestionCheapLabel'), prompt: t('chat.suggestionCheapPrompt') },
    { icon: ShieldCheck, label: t('chat.suggestionAp2Label'), prompt: t('chat.suggestionAp2Prompt') },
  ]

  const [signingOut, setSigningOut] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'agent',
      content: t('chat.welcome', { brand: BRAND.name }),
    },
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [sessionId, setSessionId] = useState<string | undefined>()

  // The open checkout, and which agent message it belongs under.
  const [pendingCheckout, setPendingCheckout] = useState<CheckoutIntent | null>(null)
  const [checkoutMsgId, setCheckoutMsgId] = useState<string | null>(null)
  // Keyed by message id so every past receipt stays where it happened in the conversation.
  const [receipts, setReceipts] = useState<Map<string, Receipt>>(new Map())

  /**
   * The outcome note owed to the agent on the next turn.
   *
   * A ref rather than state: nothing renders from it, and putting it in state would re-render the
   * whole conversation each time a checkout closed.
   */
  const pendingNote = useRef<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** Whether the reader is following the conversation or has scrolled back into its history. */
  const following = useRef(true)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking, pendingCheckout])

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

  /** Closes the card, records the outcome for the agent, and says so in the conversation. */
  const closeCheckout = (outcome: 'declined' | 'expired') => {
    setPendingCheckout(null)
    setCheckoutMsgId(null)
    pendingNote.current = outcomeNote(outcome)
    setMessages((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        role: 'agent',
        content: t(outcome === 'declined' ? 'ap2.checkout.declinedMessage' : 'ap2.checkout.expiredMessage'),
      },
    ])
  }

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

    // Any checkout outcome the agent has not been told about rides along ahead of the user's text.
    // It goes to the model only — the bubble above shows what the user actually typed.
    const note = pendingNote.current
    pendingNote.current = null
    const payload = note ? `${note}\n\n${trimmed}` : trimmed

    // Ensure we have a session id
    const currentSessionId = sessionId ?? crypto.randomUUID()
    if (!sessionId) setSessionId(currentSessionId)

    const agentMsgId = crypto.randomUUID()
    const toolsUsed: string[] = []
    /** Set when the agent opens a consent session; the checkout gate opens once the turn ends. */
    let consentSessionId: string | null = null
    /** Guards the gate against being opened twice for one proposal. */
    let checkoutOpened = false

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

    // One set of callbacks for both transports. They differ only in how the stream reaches the
    // browser — direct from AgentCore, or re-streamed by the BFF — and nothing downstream of the
    // parser cares which, so the checkout wiring below exists in exactly one place.
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
      onConsentProposed: (id: string) => {
        consentSessionId = id
      },
      onComplete: () => {
        patch((msg) => ({ ...msg, isStreaming: false, activeTool: undefined, status: undefined }))

        // Opened only once the turn is complete, so the card appears under a finished proposal
        // rather than under a half-written one — and only once per turn: the server issues a fresh
        // one-time code on every open, so a second call would invalidate the code already on screen.
        if (!consentSessionId || checkoutOpened) return
        checkoutOpened = true
        void openCheckout(consentSessionId).then((intent) => {
          if (!intent) return
          setPendingCheckout(intent)
          setCheckoutMsgId(agentMsgId)
        })
      },
      onError: (error: Error) =>
        patch((msg) => ({
          ...msg,
          content: msg.content || t('chat.errorWithMessage', { message: error.message }),
          isStreaming: false,
          activeTool: undefined,
          status: undefined,
        })),
    }

    try {
      await sendMessageBff(payload, currentSessionId, callbacks)
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
    <div className="flex h-viewport flex-col bg-background">
      <AppHeader
        leading={<BrandAvatar online />}
        title={BRAND.name}
        subtitle={BRAND.tagline}
        actions={
          <>
            <LanguageSwitcher />
            <Link
              to="/explorer"
              title={t('ap2.explorer.open')}
              aria-label={t('ap2.explorer.open')}
              className={iconButtonClass()}
            >
              <ScrollText className="h-4 w-4" />
            </Link>
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
              slot={
                m.id === checkoutMsgId && pendingCheckout ? (
                  <CheckoutCard
                    intent={pendingCheckout}
                    onAuthorized={(receipt) => {
                      // The receipt gets its own bubble, so the proposal above stays readable as the
                      // thing that was authorized rather than being replaced by its outcome.
                      const receiptMsgId = crypto.randomUUID()
                      setMessages((prev) => [
                        ...prev,
                        { id: receiptMsgId, role: 'agent', content: '' },
                      ])
                      setReceipts((prev) => new Map(prev).set(receiptMsgId, receipt))
                      setPendingCheckout(null)
                      setCheckoutMsgId(null)
                      pendingNote.current = outcomeNote('paid', receipt)
                    }}
                    onDeclined={() => closeCheckout('declined')}
                    onExpired={() => closeCheckout('expired')}
                  />
                ) : (
                  receipts.get(m.id) && <ReceiptCard receipt={receipts.get(m.id) as Receipt} />
                )
              }
            />
          ))}
          {thinking && <ThinkingBubble />}

          {messages.length === 1 && !thinking && (
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
  )
}
