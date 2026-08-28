import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * The agent's own text, rendered as Markdown.
 *
 * Tables are the reason this exists: anything the agent lays out for comparison reads as a table
 * and as a paragraph full of pipe characters otherwise. GFM is what makes that syntax work at all.
 *
 * The user's own messages stay plain text. They are not a formatting surface, and rendering them
 * would mean anything a user types could restyle the conversation around it.
 *
 * Its own module because `ChatBubble` loads it lazily — see the note there.
 */
export default function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-muted text-muted-foreground">{children}</thead>,
        th: ({ children }) => (
          <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border-t border-border px-2.5 py-1.5 align-top">{children}</td>
        ),
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc pl-4 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal pl-4 last:mb-0">{children}</ol>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>
        ),
        // `rel` is not optional next to target="_blank": without it the opened page can reach back
        // through `window.opener`.
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
