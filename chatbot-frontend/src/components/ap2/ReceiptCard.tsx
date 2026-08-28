import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Copy, ShieldCheck } from 'lucide-react'
import type { Receipt } from '@/lib/ap2/api.ts'
import { shortHash } from '@/lib/ap2/format.ts'
import { useI18n } from '@/lib/i18n/context.ts'
import { IconButton } from '../ui/index.ts'

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex-1 truncate text-subtle" title={value}>
        {shortHash(value)}
      </span>
    </div>
  )
}

/**
 * The settled receipt.
 *
 * Frameless on purpose: it is the whole content of its chat bubble, which already supplies the
 * border, the surface and the tail (`bubble-flush` in styles.css). Rendered anywhere else it would
 * need a `Card` around it.
 *
 * It shows the hash-linked artifacts the processor re-verified, and links to the trail where each
 * of those checks can be read step by step. Surfacing the hashes here is the point: a receipt that
 * only says "paid" asks to be believed, while one that names what was verified can be checked.
 */
export function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const authorized = receipt.status === 'Success'

  async function copyId() {
    try {
      await navigator.clipboard.writeText(receipt.receiptId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is denied in some contexts; the id is on screen and selectable regardless.
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <CheckCircle2
          className={`mt-0.5 h-5 w-5 shrink-0 ${authorized ? 'text-emerald-600' : 'text-danger'}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {authorized
              ? t('ap2.receipt.authorized')
              : t('ap2.receipt.status', { status: receipt.status.toLowerCase() })}
          </p>
          <p className="text-sm text-muted-foreground">{receipt.amount}</p>

          <div className="mt-3 flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-subtle">
              {receipt.receiptId}
            </span>
            <IconButton
              variant="ghost"
              className="h-7 w-7"
              onClick={() => void copyId()}
              title={t('ap2.receipt.copyId')}
              aria-label={t('ap2.receipt.copyId')}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          {copied && <span className="text-xs text-emerald-600">{t('ap2.receipt.copied')}</span>}

          {receipt.chain && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-primary">
                {t('ap2.receipt.signedChain')}
              </summary>
              <div className="mt-2 space-y-1 font-mono text-[11px]">
                <HashRow label={t('ap2.receipt.hashCart')} value={receipt.chain.cartHash} />
                <HashRow label={t('ap2.receipt.hashPayment')} value={receipt.chain.paymentMandateHash} />
                <HashRow
                  label={t('ap2.receipt.hashCredential')}
                  value={receipt.chain.paymentCredentialHash}
                />
              </div>
            </details>
          )}

          <Link
            to={`/explorer/${encodeURIComponent(receipt.journeyId)}`}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('ap2.receipt.openExplorer')}
          </Link>

          <p className="mt-3 text-xs leading-snug text-subtle">{t('ap2.receipt.footer')}</p>
        </div>
      </div>
    </div>
  )
}
