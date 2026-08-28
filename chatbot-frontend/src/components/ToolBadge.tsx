import { Wrench } from 'lucide-react'
import { useI18n, type MessageKey } from '@/lib/i18n/context.ts'
import { Badge } from './ui/index.ts'

/**
 * The name of a tool the agent called, in the reader's language.
 *
 * A tool with no entry in the catalogs renders under its own protocol name rather than a blank or a
 * visible message key: a tool shipped on the agent today shows up in the transcript today, and the
 * label catches up when the copy does.
 */
function toolLabel(t: (key: MessageKey) => string, name: string): string {
  const key = `chat.tool.${name}` as MessageKey
  const translated = t(key)
  return translated === key ? name : translated
}

export function ToolBadge({ name, active }: { name: string; active?: boolean }) {
  const { t } = useI18n()

  return (
    <Badge tone={active ? 'primary' : 'neutral'} className={active ? 'animate-pulse' : undefined}>
      <Wrench className="h-3 w-3" aria-hidden="true" />
      {toolLabel(t, name)}
    </Badge>
  )
}

export function ToolBadgeList({ tools, activeTool }: { tools: string[]; activeTool?: string }) {
  if (tools.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {tools.map((tool) => (
        <ToolBadge key={tool} name={tool} active={tool === activeTool} />
      ))}
    </div>
  )
}
