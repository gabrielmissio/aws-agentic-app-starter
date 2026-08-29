import { MessageSquare, Plus, Trash2, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n/context.ts'
import type { ConversationSummary } from '@/lib/conversations-api.ts'
import { Button, cn, EmptyState } from './ui/index.ts'

export interface ConversationSidebarProps {
  conversations: ConversationSummary[]
  /** The conversation on screen, if it is one that has been saved. */
  activeSessionId?: string
  loading?: boolean
  /** Set while a delete is in flight, so the row it targets can say so. */
  deletingSessionId?: string
  onSelect: (sessionId: string) => void
  onNew: () => void
  onDelete: (sessionId: string) => void
  /** Mobile only — on a wide screen the panel is always present. */
  open?: boolean
  onClose: () => void
}

/**
 * The conversation list.
 *
 * Titles come from an index the chat function writes, not from the conversations themselves, so
 * rendering this reads no message content — the common case never decrypts a transcript. Opening one
 * is what fetches it.
 *
 * One panel, two presentations: a permanent column from `lg` up, and an overlay drawer below it.
 * Rendering it twice would mean two sources of truth for which conversation is selected.
 */
export function ConversationSidebar({
  conversations,
  activeSessionId,
  loading,
  deletingSessionId,
  onSelect,
  onNew,
  onDelete,
  open,
  onClose,
}: ConversationSidebarProps) {
  const { t, locale } = useI18n()

  // Resolved once per render rather than per row: constructing a formatter is the expensive part.
  const formatDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })

  return (
    <>
      {/* Closes the drawer on a tap outside it. Inert on a wide screen, where the panel is static. */}
      <div
        className={cn(
          'fixed inset-0 z-20 bg-slate-900/40 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        aria-label={t('conversations.title')}
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-border bg-card transition-transform',
          'lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Button variant="secondary" size="sm" onClick={onNew} className="flex-1">
            <Plus className="h-3.5 w-3.5" />
            {t('conversations.newChat')}
          </Button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('conversations.close')}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {loading && conversations.length === 0 && (
            <p className="px-2 py-3 text-xs text-subtle">{t('common.loading')}</p>
          )}

          {!loading && conversations.length === 0 && (
            <EmptyState className="border-0 shadow-none">
              <MessageSquare className="mx-auto mb-2 h-5 w-5 text-subtle" aria-hidden="true" />
              {t('conversations.empty')}
            </EmptyState>
          )}

          <ul className="flex flex-col gap-0.5">
            {conversations.map((conversation) => {
              const active = conversation.sessionId === activeSessionId
              const deleting = conversation.sessionId === deletingSessionId

              return (
                <li key={conversation.sessionId} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.sessionId)}
                    aria-current={active ? 'true' : undefined}
                    disabled={deleting}
                    className={cn(
                      'w-full rounded-lg py-2 pl-3 pr-9 text-left text-sm transition-colors disabled:opacity-50',
                      active
                        ? 'bg-primary-light text-primary-dark'
                        : 'text-foreground hover:bg-muted',
                    )}
                  >
                    {/* `truncate` needs the block to be constrained; the padding above leaves room
                        for the delete control so a long title never runs underneath it. */}
                    <span className="block truncate">{conversation.title}</span>
                    <span className="mt-0.5 block text-xs text-subtle">
                      {formatDate.format(new Date(conversation.updatedAt))}
                    </span>
                  </button>

                  {/* Shown on hover on a pointer device, and always where there is no hover — a
                      control that only appears on hover is unreachable on a touchscreen. */}
                  <button
                    type="button"
                    onClick={() => onDelete(conversation.sessionId)}
                    disabled={deleting}
                    aria-label={t('conversations.delete', { title: conversation.title })}
                    className="absolute right-1 top-1.5 rounded-lg p-2 text-subtle opacity-100 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <p className="border-t border-border px-3 py-2 text-xs text-subtle">
          {t('conversations.retentionNote')}
        </p>
      </aside>
    </>
  )
}
