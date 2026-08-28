import type { CheckoutReceipt, PaymentReceipt } from './types'

/**
 * A negative-scenario block carrying an accountability code (`TAMPERED`, `OUT_OF_SCOPE`, `EXPIRED`,
 * `DOUBLE_SPEND`, `INVALID_MANDATE`, `REPLAYED`, …).
 *
 * The code is the stable part — it survives the SigV4 hop between entities (see
 * `handlers/internal-call.ts`), maps to an HTTP status in `http.ts`, and is what the frontend
 * localizes. The message is operator-facing English detail, never something anyone must translate.
 *
 * Per AP2 §Mandate Receipt a verifier must return a *signed* receipt on rejection too. When one does,
 * it attaches that `status: 'Error'` receipt here, so the throw contract is preserved and the signed
 * artifact still travels back to the caller.
 */
export class BlockedError extends Error {
  /** A signed `status: 'Error'` receipt issued by the rejecting verifier, when it issued one. */
  receipt?: PaymentReceipt | CheckoutReceipt

  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BlockedError'
  }
}
