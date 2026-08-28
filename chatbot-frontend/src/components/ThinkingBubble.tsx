import { useI18n } from '@/lib/i18n/context.ts'
import { BrandAvatar } from './ui/index.ts'

export function ThinkingBubble() {
  const { t } = useI18n()

  return (
    <div className="flex animate-bubble-in items-end gap-2">
      <BrandAvatar size="sm" className="mb-0.5" />
      <div className="bubble-agent flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 animate-thinking rounded-full bg-subtle" style={{ animationDelay: '0s' }} />
        <span className="h-1.5 w-1.5 animate-thinking rounded-full bg-subtle" style={{ animationDelay: '0.2s' }} />
        <span className="h-1.5 w-1.5 animate-thinking rounded-full bg-subtle" style={{ animationDelay: '0.4s' }} />
        <span className="ml-1.5 text-xs text-muted-foreground">{t('chat.thinkingBubble')}</span>
      </div>
    </div>
  )
}
