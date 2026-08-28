import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Check,
  FileSignature,
  FileText,
  Lock,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserCheck,
  XCircle,
} from 'lucide-react'
import { ExplorerLayout } from './ExplorerLayout.tsx'
import { STATUS_ICON, STATUS_TONE } from './status.ts'
import { Alert, cn, EmptyState, SegmentedControl } from '../ui/index.ts'
import {
  fetchEvidence,
  fetchJourneys,
  type EvidenceStep,
  type EvidenceTrail,
  type JourneySummary,
} from '@/lib/ap2/api.ts'
import { formatAmount, formatClock, formatUtc, shortHash } from '@/lib/ap2/format.ts'
import { buildTimeline, type TimelineItem } from '@/lib/ap2/journey-timeline.ts'
import { journeyDisplayStatus, type JourneyDisplayStatus } from '@/lib/ap2/journey-status.ts'
import {
  ACTOR_PALETTE,
  actorLabelKey,
  humanizeStepType,
  stepKind,
  stepSigner,
  stepMeaningKey,
  stepTitleKey,
  type ActorKid,
} from '@/lib/ap2/semantics.ts'
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n/context.ts'

type ViewMode = 'story' | 'raw'

/**
 * Resolves a catalog key, falling back to a readable form of the protocol code.
 *
 * `t()` returns the key itself when nothing matches, which is deliberate elsewhere — a visible key
 * is a bug report. Here it would put `ap2.step.SOMETHING.title` in the middle of a plain-language
 * timeline, so a step the catalogs do not yet cover degrades to its humanized code instead. That way
 * a new domain step renders sensibly before the translations catch up.
 */
function stepTitle(t: Translate, type: string): string {
  const key = stepTitleKey(type)
  const translated = t(key)
  return translated === key ? humanizeStepType(type) : translated
}

function stepMeaning(t: Translate, type: string): string | null {
  const key = stepMeaningKey(type)
  const translated = t(key)
  return translated === key ? null : translated
}

function SignerBadge({ kid }: { kid: ActorKid }) {
  const { t } = useI18n()
  const p = ACTOR_PALETTE[kid]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        p.badgeBg,
        p.badgeText,
        p.badgeBorder,
      )}
    >
      <FileSignature className="h-3 w-3" aria-hidden="true" />
      {t('ap2.explorer.signedBy', { actor: t(actorLabelKey(kid)) })}
    </span>
  )
}

// ── The signed artifacts ─────────────────────────────────────────────────
// Each step that produced a signed object renders the object itself, tinted in its signer's hue.
// Every field is real: the line items, amount and merchant come from the journey record, the hashes
// and timestamps from the evidence trail. The protocol invariants (single use, reuse blocked) are
// stated as the fixed truths this flow enforces.

/** One key/value line inside an artifact. */
function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn('truncate', strong ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
      <span
        className={cn(
          'truncate text-right tabular-nums',
          strong ? 'font-semibold text-foreground' : 'font-medium text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function ArtifactCard({
  kid,
  icon: Icon,
  title,
  signatureHash,
  children,
}: {
  kid: ActorKid
  icon: typeof ShoppingCart
  title: string
  signatureHash?: string
  children: ReactNode
}) {
  const { t } = useI18n()
  const palette = ACTOR_PALETTE[kid]

  return (
    <div className={cn('mt-3 overflow-hidden rounded-lg border', palette.artifact)}>
      <div className={cn('flex items-center gap-2 px-3 py-2', palette.artifactHead)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{title}</span>
      </div>
      <div className="space-y-1.5 border-t border-black/5 bg-card/60 px-3 py-2.5 text-xs">
        {children}
      </div>
      {signatureHash && (
        <div className="flex items-center gap-1.5 border-t border-black/5 px-3 py-1.5 text-[10px] text-muted-foreground">
          <FileSignature className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate font-mono" title={signatureHash}>
            {t('ap2.explorer.rowSignature', { actor: t(actorLabelKey(kid)) })} ·{' '}
            {shortHash(signatureHash, 32)}
          </span>
        </div>
      )}
    </div>
  )
}

/** The signed artifact belonging to this step, or nothing for the steps that sign nothing. */
function StepArtifact({
  step,
  journey,
  cartHash,
  verifications,
}: {
  step: EvidenceStep
  journey: JourneySummary | null
  cartHash?: string
  verifications: number
}) {
  const { t } = useI18n()
  if (!journey) return null

  const boundCart = <span className="font-mono">{shortHash(cartHash, 14)}</span>

  switch (step.type) {
    case 'CART_MANDATE':
      return (
        <ArtifactCard
          kid="merchant"
          icon={ShoppingCart}
          title={t('ap2.explorer.artifactCart')}
          signatureHash={step.payloadHash}
        >
          <Row label={t('ap2.explorer.rowMerchant')} value={journey.merchantName ?? '—'} />
          {journey.items?.map((item, i) => (
            <Row key={i} label={item.label} value={formatAmount(item.amountCents, journey.currency)} />
          ))}
          <div className="!my-1.5 border-t border-black/5" />
          <Row label={t('ap2.explorer.rowTotal')} value={journey.amount} strong />
        </ArtifactCard>
      )

    case 'CHECKOUT_MANDATE':
      return (
        <ArtifactCard
          kid="consent"
          icon={UserCheck}
          title={t('ap2.explorer.artifactApproval')}
          signatureHash={step.payloadHash}
        >
          <Row label={t('ap2.explorer.rowAuthorizesCart')} value={boundCart} />
          <Row
            label={t('ap2.explorer.rowAuthorizedBy')}
            value={
              journey.requiresStepUp === false
                ? t('ap2.explorer.rowAuthorizedTap')
                : t('ap2.explorer.rowAuthorizedCode')
            }
          />
          {formatUtc(step.recordedAt) && (
            <Row label={t('ap2.explorer.rowIssuedAt')} value={formatUtc(step.recordedAt)} />
          )}
        </ArtifactCard>
      )

    case 'PAYMENT_MANDATE':
      return (
        <ArtifactCard
          kid="consent"
          icon={ShieldCheck}
          title={t('ap2.explorer.artifactAuthorization')}
          signatureHash={step.payloadHash}
        >
          <Row label={t('ap2.explorer.rowAmount')} value={journey.amount} />
          {journey.paymentMethodRef && (
            <Row
              label={t('ap2.explorer.rowMethod')}
              value={<span className="font-mono">{journey.paymentMethodRef}</span>}
            />
          )}
          <Row label={t('ap2.explorer.rowPresence')} value={t('ap2.explorer.rowPresenceValue')} />
          <Row label={t('ap2.explorer.rowAuthorizedCart')} value={boundCart} />
        </ArtifactCard>
      )

    case 'PAYMENT_CREDENTIAL_ISSUED':
      return (
        <ArtifactCard
          kid="cp"
          icon={Lock}
          title={t('ap2.explorer.artifactCredential')}
          signatureHash={step.payloadHash}
        >
          <Row label={t('ap2.explorer.rowBoundToCart')} value={boundCart} />
          <Row label={t('ap2.explorer.rowMaxAmount')} value={journey.amount} />
          <Row label={t('ap2.explorer.rowUseLimit')} value={t('ap2.explorer.rowUseLimitValue')} />
          <Row
            label={t('ap2.explorer.rowProcessorScope')}
            value={t('ap2.explorer.rowProcessorScopeValue')}
          />
          {formatUtc(step.expiresAt) && (
            <Row label={t('ap2.explorer.rowExpires')} value={formatUtc(step.expiresAt)} />
          )}
        </ArtifactCard>
      )

    case 'PAYMENT_RECEIPT':
      return (
        <ArtifactCard
          kid="mpp"
          icon={FileText}
          title={t('ap2.explorer.artifactReceipt')}
          signatureHash={step.payloadHash}
        >
          {journey.status === 'settled' && (
            <Row label={t('ap2.explorer.rowStatus')} value={t('ap2.explorer.rowStatusSuccess')} />
          )}
          <Row label={t('ap2.explorer.rowAmountPaid')} value={journey.amount} />
          {journey.receiptId && (
            <Row
              label={t('ap2.explorer.rowReceipt')}
              value={<span className="font-mono">{journey.receiptId}</span>}
            />
          )}
          <Row
            label={t('ap2.explorer.rowChainVerified')}
            value={t('ap2.explorer.rowChainVerifiedValue', { count: verifications })}
          />
          {formatUtc(step.recordedAt) && (
            <Row label={t('ap2.explorer.rowSettledAt')} value={formatUtc(step.recordedAt)} />
          )}
        </ArtifactCard>
      )

    default:
      return null
  }
}

/** The shared shape of a timeline row: a dot in the actor's hue, the connector, then the content. */
function TimelineRow({ dot, last, children }: { dot: string; last?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', dot)} />
        {/* The chain ends at the last row: a line running past it would imply a step still to come. */}
        {!last && <span className="my-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn('min-w-0 flex-1', last ? 'pb-1' : 'pb-6')}>{children}</div>
    </li>
  )
}

/** The row's heading: what happened, who signed it, and when. */
function RowHeading({
  title,
  signer,
  recordedAt,
  blocked,
}: {
  title: string
  signer?: ActorKid
  recordedAt?: string
  blocked?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {signer && <SignerBadge kid={signer} />}
        {blocked && <XCircle className="h-3.5 w-3.5 text-danger" aria-hidden="true" />}
      </div>
      {formatClock(recordedAt) && (
        <time
          className="mt-0.5 shrink-0 whitespace-nowrap font-mono text-[10px] text-subtle"
          title={formatUtc(recordedAt) ?? undefined}
        >
          {formatClock(recordedAt)}
        </time>
      )}
    </div>
  )
}

/** One recorded step: what it was, what it means, and the artifact it produced. */
function StepRow({
  step,
  journey,
  cartHash,
  verifications,
  last,
}: {
  step: EvidenceStep
  journey: JourneySummary | null
  cartHash?: string
  verifications: number
  last?: boolean
}) {
  const { t } = useI18n()
  const kind = stepKind(step.type)
  const signer = stepSigner(step.type)
  const blocked = kind === 'blocked' || step.verified === false
  const meaning = stepMeaning(t, step.type)

  const dot = blocked
    ? 'bg-red-500'
    : kind === 'redeemed'
      ? 'bg-amber-500'
      : signer
        ? ACTOR_PALETTE[signer].dot
        : 'bg-slate-300'

  return (
    <TimelineRow dot={dot} last={last}>
      <RowHeading
        title={stepTitle(t, step.type)}
        signer={signer}
        recordedAt={step.recordedAt}
        blocked={blocked}
      />
      {meaning && (
        <p className={cn('mt-1 text-sm leading-relaxed', blocked ? 'text-danger' : 'text-muted-foreground')}>
          {meaning}
        </p>
      )}
      {kind === 'redeemed' && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-amber-600">
          <Lock className="h-3 w-3" aria-hidden="true" /> {t('ap2.explorer.redeemed')}
        </p>
      )}
      {step.note && <p className="mt-1 text-xs text-subtle">{step.note}</p>}
      <StepArtifact step={step} journey={journey} cartHash={cartHash} verifications={verifications} />
    </TimelineRow>
  )
}

/**
 * The two mandates the consent surface signs in one approval, shown as the single act they were.
 *
 * Both artifacts are rendered — they are separate signed objects and the trail says so — but under
 * one heading, because the person clicked once.
 */
function ApprovalRow({
  checkout,
  payment,
  journey,
  cartHash,
  verifications,
  last,
}: {
  checkout: EvidenceStep
  payment?: EvidenceStep
  journey: JourneySummary | null
  cartHash?: string
  verifications: number
  last?: boolean
}) {
  const { t } = useI18n()

  return (
    <TimelineRow dot={ACTOR_PALETTE.consent.dot} last={last}>
      <RowHeading
        title={stepTitle(t, 'CHECKOUT_MANDATE')}
        signer="consent"
        recordedAt={checkout.recordedAt}
      />
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {stepMeaning(t, 'CHECKOUT_MANDATE')}
      </p>
      {payment && (
        <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <UserCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          {stepMeaning(t, 'PAYMENT_MANDATE')}
        </p>
      )}
      <StepArtifact step={checkout} journey={journey} cartHash={cartHash} verifications={verifications} />
      {payment && (
        <StepArtifact step={payment} journey={journey} cartHash={cartHash} verifications={verifications} />
      )}
    </TimelineRow>
  )
}

/**
 * A run of consecutive re-verifications, summarised one line per re-checker.
 *
 * Each re-check is the point of the design, but eight rows of "verified ✓" read as noise; naming
 * the actor and what it re-checked keeps the meaning and loses the repetition.
 */
function VerifyClusterRow({ steps, last }: { steps: EvidenceStep[]; last?: boolean }) {
  const { t } = useI18n()
  const failed = steps.some((s) => s.verified === false)

  /** What each re-check was aimed at, in plain language, falling back to the protocol code. */
  const targetOf = (type: string): string => {
    const key = `ap2.recheckTarget.${type}` as MessageKey
    const translated = t(key)
    return translated === key ? humanizeStepType(type.replace(/^VERIFY_/, '')) : translated
  }

  // Consecutive checks by the same actor become one sentence: "X re-checked a, b and c".
  const byActor: { entity?: string; targets: string[] }[] = []
  for (const step of steps) {
    const last = byActor[byActor.length - 1]
    if (last && last.entity === step.entity) last.targets.push(targetOf(step.type))
    else byActor.push({ entity: step.entity, targets: [targetOf(step.type)] })
  }

  const join = (parts: string[]) =>
    parts.length <= 1
      ? (parts[0] ?? '')
      : `${parts.slice(0, -1).join(', ')} ${t('ap2.explorer.recheckAnd')} ${parts[parts.length - 1]}`

  return (
    <TimelineRow dot={failed ? 'bg-red-500' : 'bg-emerald-500'} last={last}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {byActor.map((group, i) => (
            <p
              key={i}
              className={cn(
                'flex items-start gap-1.5 text-sm leading-snug',
                failed ? 'text-danger' : 'text-muted-foreground',
              )}
            >
              {failed ? (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
              ) : (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
              )}
              <span>
                {t('ap2.explorer.recheckBy', {
                  actor: t(actorLabelKey(group.entity ?? '')),
                  targets: join(group.targets),
                })}
              </span>
            </p>
          ))}
        </div>
        {formatClock(steps[0]?.recordedAt) && (
          <time
            className="mt-0.5 shrink-0 whitespace-nowrap font-mono text-[10px] text-subtle"
            title={formatUtc(steps[0]?.recordedAt) ?? undefined}
          >
            {formatClock(steps[0]?.recordedAt)}
          </time>
        )}
      </div>
    </TimelineRow>
  )
}

/**
 * The chain's verdict on this checkout, in one line.
 *
 * A blocked step always wins: it is the strongest thing the trail has to say, and it outranks
 * whatever the journey's own status field claims.
 */
function StatusBanner({
  status,
  trail,
}: {
  status: JourneyDisplayStatus | null
  trail: EvidenceTrail | null
}) {
  const { t } = useI18n()
  const summary = trail?.summary

  if (summary && summary.blocked > 0) {
    return (
      <Alert tone="danger" icon={<XCircle className="h-4 w-4" />} className="mb-4">
        {t('ap2.explorer.bannerBlocked', { count: summary.blocked })}
      </Alert>
    )
  }

  if (status && status !== 'settled') {
    const Icon = STATUS_ICON[status]
    return (
      <Alert tone={STATUS_TONE[status]} icon={<Icon className="h-4 w-4" />} className="mb-4">
        {t(`ap2.explorer.banner.${status}` as MessageKey)}
      </Alert>
    )
  }

  if (summary?.allVerified) {
    return (
      <Alert tone="primary" icon={<ShieldCheck className="h-4 w-4" />} className="mb-4">
        {t('ap2.explorer.bannerAllVerified', { count: summary.verifications })}
      </Alert>
    )
  }

  return (
    <Alert tone="neutral" icon={<ShieldCheck className="h-4 w-4" />} className="mb-4">
      {t('ap2.explorer.bannerVerifications', { count: summary?.verifications ?? 0 })}
    </Alert>
  )
}

/** One checkout's full trail: what was signed, by whom, and who re-checked it. */
export function JourneyView() {
  const { t } = useI18n()
  const { journeyId = '' } = useParams()
  const [trail, setTrail] = useState<EvidenceTrail | null>(null)
  const [journey, setJourney] = useState<JourneySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('story')

  useEffect(() => {
    let live = true
    setLoading(true)

    // Both are needed and neither depends on the other: the trail is the proof, the journey record
    // is what makes it legible (the cart, the amount, the method). Fetched together so a slow
    // evidence query does not hold up the header.
    Promise.allSettled([fetchEvidence(journeyId), fetchJourneys()])
      .then(([evidence, journeys]) => {
        if (!live) return
        if (evidence.status === 'fulfilled') setTrail(evidence.value)
        if (journeys.status === 'fulfilled') {
          setJourney(journeys.value.find((j) => j.journeyId === journeyId) ?? null)
        }
      })
      .finally(() => live && setLoading(false))

    return () => {
      live = false
    }
  }, [journeyId])

  const status = journey ? journeyDisplayStatus(journey) : null
  const items: TimelineItem[] = trail ? buildTimeline(trail.steps) : []
  // The merchant's signature on the cart: the hash every later artifact is bound to.
  const cartHash = trail?.steps.find((s) => s.type === 'CART_MANDATE')?.payloadHash
  const verifications = trail?.summary.verifications ?? 0

  /** Why a trail can be empty — a checkout can close before anything was ever signed. */
  const emptyReason = (): string => {
    if (status === 'declined') return t('ap2.explorer.emptyDeclined')
    if (status === 'superseded') return t('ap2.explorer.emptySuperseded')
    if (status === 'expired') return t('ap2.explorer.emptyExpired')
    return t('ap2.explorer.emptyGeneric')
  }

  return (
    <ExplorerLayout>
      <div className="mb-4">
        <p className="font-mono text-xs text-subtle">{journeyId}</p>
        <h2 className="text-lg font-semibold text-foreground">
          {t('ap2.explorer.signedChainTitle')}
        </h2>
        {journey?.summary && <p className="mt-0.5 text-sm text-muted-foreground">{journey.summary}</p>}
        {formatUtc(journey?.requestedAt) && (
          <p className="mt-0.5 text-xs text-subtle">
            {formatUtc(journey?.requestedAt)?.slice(0, 10)} · {t('ap2.explorer.timesUtc')}
          </p>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-subtle">{t('ap2.explorer.loading')}</p>
      ) : !trail || trail.steps.length === 0 ? (
        <>
          <StatusBanner status={status} trail={trail} />
          <EmptyState>{emptyReason()}</EmptyState>
        </>
      ) : (
        <>
          <StatusBanner status={status} trail={trail} />

          <div className="mb-4 flex items-center gap-3">
            <SegmentedControl
              value={mode}
              onChange={setMode}
              label={t('ap2.explorer.viewMode')}
              options={[
                { value: 'story', label: t('ap2.explorer.viewStory') },
                { value: 'raw', label: t('ap2.explorer.viewRaw') },
              ]}
            />
            <span className="text-xs text-subtle">
              {t('ap2.explorer.stepCount', { count: trail.summary.total })}
            </span>
          </div>

          {mode === 'story' ? (
            <ol>
              {items.map((item, i) => {
                const last = i === items.length - 1
                if (item.kind === 'verify') {
                  return <VerifyClusterRow key={i} steps={item.steps} last={last} />
                }
                if (item.kind === 'approval') {
                  return (
                    <ApprovalRow
                      key={i}
                      checkout={item.checkout}
                      payment={item.payment}
                      journey={journey}
                      cartHash={cartHash}
                      verifications={verifications}
                      last={last}
                    />
                  )
                }
                return (
                  <StepRow
                    key={i}
                    step={item.step}
                    journey={journey}
                    cartHash={cartHash}
                    verifications={verifications}
                    last={last}
                  />
                )
              })}
            </ol>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t('ap2.explorer.colEntity')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('ap2.explorer.colType')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('ap2.explorer.colVerified')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('ap2.explorer.colSignedBy')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('ap2.explorer.colHash')}</th>
                  </tr>
                </thead>
                <tbody>
                  {trail.steps.map((step, i) => (
                    <tr key={i} className="border-t border-border align-top">
                      <td className="px-3 py-2 text-foreground">{step.entity}</td>
                      <td className="px-3 py-2 font-mono text-foreground">{step.type}</td>
                      <td className="px-3 py-2">
                        {step.verified === true ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                        ) : step.verified === false ? (
                          <XCircle className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{step.signedBy ?? '—'}</td>
                      <td
                        className="max-w-[180px] truncate px-3 py-2 font-mono text-subtle"
                        title={step.payloadHash}
                      >
                        {step.payloadHash ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 flex flex-wrap items-center gap-1 text-xs text-subtle">
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            {t('ap2.explorer.artifactFooter')}{' '}
            <Link to="/explorer/actors" className="text-primary hover:underline">
              {t('ap2.explorer.artifactFooterLink')}
            </Link>
          </p>
        </>
      )}
    </ExplorerLayout>
  )
}
