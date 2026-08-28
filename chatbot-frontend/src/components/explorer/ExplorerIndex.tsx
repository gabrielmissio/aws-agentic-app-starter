import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ChevronRight } from 'lucide-react'
import { ExplorerLayout } from './ExplorerLayout.tsx'
import { STATUS_ICON, STATUS_TONE } from './status.ts'
import { Badge, CARD_CLASS, EmptyState, TONE_CLASS } from '../ui/index.ts'
import { fetchJourneys, type JourneySummary } from '@/lib/ap2/api.ts'
import { journeyDisplayStatus } from '@/lib/ap2/journey-status.ts'
import { useI18n } from '@/lib/i18n/context.ts'

/** The caller's own checkouts. Each one links to the trail that proves what happened to it. */
export function ExplorerIndex() {
  const { t } = useI18n()
  const [journeys, setJourneys] = useState<JourneySummary[] | null>(null)

  useEffect(() => {
    let live = true
    fetchJourneys()
      .then((j) => live && setJourneys(j))
      .catch(() => live && setJourneys([]))
    return () => {
      live = false
    }
  }, [])

  return (
    <ExplorerLayout>
      <p className="text-sm leading-relaxed text-muted-foreground">{t('ap2.explorer.intro')}</p>
      <Link
        to="/explorer/actors"
        className="mb-5 mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {t('ap2.explorer.meetActors')}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>

      {journeys === null ? (
        <p className="text-sm text-subtle">{t('ap2.explorer.loading')}</p>
      ) : journeys.length === 0 ? (
        <EmptyState>{t('ap2.explorer.empty')}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {journeys.map((j) => {
            const status = journeyDisplayStatus(j)
            const Icon = STATUS_ICON[status]
            return (
              <li key={j.intentId}>
                <Link
                  to={`/explorer/${encodeURIComponent(j.journeyId)}`}
                  className={`${CARD_CLASS} flex items-center gap-3 px-4 py-3 transition-colors hover:border-primary`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${TONE_CLASS[STATUS_TONE[status]]}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm text-foreground">{j.summary || j.journeyId}</p>
                      <Badge tone={STATUS_TONE[status]}>{t(`ap2.status.${status}` as const)}</Badge>
                    </div>
                    <p className="truncate text-xs text-subtle">
                      <span className="font-mono">{j.journeyId}</span> ·{' '}
                      {t(`ap2.statusDetail.${status}` as const)}
                    </p>
                  </div>

                  <span className="shrink-0 text-sm font-medium text-foreground">{j.amount}</span>
                  <ChevronRight className="hidden h-4 w-4 shrink-0 text-subtle sm:block" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </ExplorerLayout>
  )
}
