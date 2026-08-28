/**
 * The public surface of the AP2 domain — everything that runs without AWS.
 *
 * The BFF imports this through `ap2-core/domain` to build consent proofs and hash carts; the entity
 * handlers import it to drive the four entities against whichever adapters `context.ts` injected.
 */
export * from './types'
export * from './ports'
export * from './crypto'
export * from './jws'
export * from './sign'
export * from './mandates'
export * from './identity'

export * as merchant from './entities/merchant'
export * as consent from './entities/consent-mandates'
export * as cp from './entities/credential-provider'
export * as mpp from './entities/mpp'

// Re-exported outside their namespaces because adapters and handlers pass these around as plain
// payload types, without otherwise reaching into an entity's namespace.
export type { RedeemInstruction } from './entities/credential-provider'
export type { PaymentInput } from './entities/mpp'
export type { MerchantPaymentInput } from './entities/merchant'

// Local adapters — in-memory repositories plus a real ES256 signer, so the whole chain runs offline.
export * from './adapters/memory'
export * from './adapters/local-signer'
