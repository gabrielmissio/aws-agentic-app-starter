import { Suspense, lazy, useMemo } from 'react'
import { normalizeMarkdown, splitStreamingMarkdown } from '@/lib/markdown.ts'
import { ToolBadgeList } from './ToolBadge.tsx'
import { BrandAvatar } from './ui/index.ts'

/**
 * Loaded on demand, with the plain text as the fallback.
 *
 * The Markdown renderer and its GFM plugin are the single largest thing this app would otherwise
 * ship on first paint. The lazy boundary means the chunk is fetched on the stream's first line
 * break — long before a long answer is finished — so the swap is seamless.
 */
const AgentMarkdown = lazy(() => import('./AgentMarkdown.tsx'))

/** Where the next token will land. */
function Cursor() {
  return <span className="ml-0.5 inline-block w-1.5 animate-pulse text-primary">▌</span>
}

/** The streaming and fallback rendering: raw text, plus a cursor while tokens are still arriving. */
function PlainText({ content, cursor }: { content: string; cursor?: boolean }) {
  return (
    <p className="whitespace-pre-wrap">
      {content}
      {cursor && <Cursor />}
    </p>
  )
}

/**
 * Renders every complete line as markdown while the line still being written stays plain text.
 *
 * Line-by-line rather than paragraph-by-paragraph: a table only becomes a table once its rows are
 * there, and waiting for the blank line that ends it would leave the reader looking at a screenful
 * of raw pipes until the model moved on to the next paragraph. Splitting at the last line break
 * renders each row as it lands, and keeps a half-typed row out of the parser — where it would
 * render as a broken one and then reflow.
 */
function StreamingMarkdown({ content }: { content: string }) {
  const { complete, tail } = useMemo(() => splitStreamingMarkdown(content), [content])

  if (!complete) return <PlainText content={tail} cursor />

  return (
    <>
      <Suspense fallback={<PlainText content={complete} />}>
        <AgentMarkdown content={complete} />
      </Suspense>
      {/* The caret stays put between lines: `tail` is empty for as long as the content ends on a
          line break, and a caret that blinks out at the end of every row reads as a stall. */}
      {tail ? <PlainText content={tail} cursor /> : <Cursor />}
    </>
  )
}

/** The finished message: the whole text, repaired, through the parser. */
function FinishedMarkdown({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeMarkdown(content), [content])

  return (
    <Suspense fallback={<PlainText content={normalized} />}>
      <AgentMarkdown content={normalized} />
    </Suspense>
  )
}

export type ChatMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  /** Tool names used by the agent during this response. */
  toolsUsed?: string[]
  /** Currently active tool (while streaming). */
  activeTool?: string
  /** Whether the message is still being streamed. */
  isStreaming?: boolean
  /** Status label (e.g. "Using get_current_time"). */
  status?: string
}

export function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex animate-bubble-in justify-end">
        <div className="bubble-user max-w-[85%]">
          <p className="break-words text-sm leading-relaxed">{message.content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex animate-bubble-in items-end gap-2">
      <BrandAvatar size="sm" className="mb-0.5" />
      <div className="bubble-agent max-w-[85%]">
        <div className="break-words text-sm leading-relaxed">
          {message.isStreaming ? (
            <StreamingMarkdown content={message.content} />
          ) : (
            <FinishedMarkdown content={message.content} />
          )}
        </div>
        {message.toolsUsed && message.toolsUsed.length > 0 && (
          <ToolBadgeList tools={message.toolsUsed} activeTool={message.activeTool} />
        )}
        {message.status && message.isStreaming && (
          <p className="mt-1.5 text-xs text-subtle">{message.status}</p>
        )}
      </div>
    </div>
  )
}
