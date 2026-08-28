import { useEffect, useState } from 'react'
import { FileSignature, KeyRound } from 'lucide-react'
import { ExplorerLayout } from './ExplorerLayout.tsx'
import { Card, EmptyState } from '../ui/index.ts'
import { fetchActors, type Actor } from '@/lib/ap2/api.ts'
import { ACTOR_ORDER, ACTOR_PALETTE, actorAttestsKey, actorLabelKey } from '@/lib/ap2/semantics.ts'
import { useI18n } from '@/lib/i18n/context.ts'

/**
 * The four signing actors and what each one's signature attests.
 *
 * This is the non-technical key to the whole chain: who is allowed to sign what, and why that
 * signature is worth anything. The public keys are shown because they are what lets someone verify
 * the trail without taking this page's word for it.
 */
export function ActorsView() {
  const { t } = useI18n()
  const [actors, setActors] = useState<Actor[] | null>(null)

  useEffect(() => {
    let live = true
    fetchActors()
      .then((a) => live && setActors(a))
      .catch(() => live && setActors([]))
    return () => {
      live = false
    }
  }, [])

  // Ordered by their place in the chain rather than by whatever order the server returned.
  const ordered = actors
    ? [...actors].sort((a, b) => ACTOR_ORDER.indexOf(a.kid) - ACTOR_ORDER.indexOf(b.kid))
    : null

  return (
    <ExplorerLayout>
      <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
        {t('ap2.explorer.actorsIntro')}
      </p>

      {ordered === null ? (
        <p className="text-sm text-subtle">{t('ap2.explorer.loading')}</p>
      ) : ordered.length === 0 ? (
        <EmptyState>{t('ap2.explorer.actorsUnavailable')}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((actor) => {
            const palette = ACTOR_PALETTE[actor.kid]
            return (
              <li key={actor.kid}>
                <Card className="p-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${palette.badgeBg} ${palette.badgeText} ${palette.badgeBorder}`}
                    >
                      <FileSignature className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {t(actorLabelKey(actor.kid))}
                      </p>
                      <p className="truncate text-xs text-subtle">
                        kid <span className="font-mono">{actor.kid}</span> · {actor.alg}
                      </p>
                    </div>
                  </div>

                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                    {t(actorAttestsKey(actor.kid))}
                  </p>

                  <div className="mt-3 rounded-lg bg-muted p-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <KeyRound className="h-3.5 w-3.5" /> {t('ap2.explorer.publicKey')}
                    </p>
                    {actor.publicKey ? (
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-subtle">
                        {actor.publicKey}
                      </pre>
                    ) : (
                      <p className="mt-1 text-xs text-subtle">{t('ap2.explorer.keyUnavailable')}</p>
                    )}
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </ExplorerLayout>
  )
}
