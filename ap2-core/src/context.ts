import {
  DynamoConsentRepo,
  DynamoCredentialRepo,
  DynamoEvidence,
  DynamoMerchantRepo,
  DynamoMppRepo,
  DynamoNonceRepo,
  KmsSigner,
} from './adapters-aws'
import { SimulatedPsp } from './domain'
import type {
  ConsentRepo,
  CredentialRepo,
  EvidenceSink,
  MerchantRepo,
  MppRepo,
  NonceRepo,
  PspGateway,
  Signer,
} from './domain'

/**
 * Builds the ports the handlers need from the AWS environment — one instance per Lambda container,
 * reused across invocations so clients and credential providers are not rebuilt per request.
 *
 * This module is the *only* place the deployed adapters are chosen. Everything downstream of it
 * depends on the port interfaces, which is what lets the same domain run in memory under test.
 */
export interface Ctx {
  signer: Signer
  evidence: EvidenceSink
  merchant: MerchantRepo
  consent: ConsentRepo
  credential: CredentialRepo
  mpp: MppRepo
  nonces: NonceRepo
  psp: PspGateway
  allowedMpps: string[]
  /** Mint a sandbox payment method for a user who has none, on first listing. */
  autoProvisionSandbox: boolean
}

let cached: Ctx | undefined

export function ctx(): Ctx {
  if (cached) return cached

  cached = {
    signer: KmsSigner.fromEnv(),
    evidence: new DynamoEvidence(),
    merchant: new DynamoMerchantRepo(),
    consent: new DynamoConsentRepo(),
    credential: new DynamoCredentialRepo(),
    mpp: new DynamoMppRepo(),
    nonces: new DynamoNonceRepo(),
    // The sandbox PSP. Swapping in a real processor is a change behind the `PspGateway` port and
    // nowhere else — see the note on `SimulatedPsp`.
    psp: new SimulatedPsp(),
    allowedMpps: (process.env.ALLOWED_MPPS ?? 'mpp-sandbox-001').split(','),
    // Fail-closed: only an explicit 'true' enables it. The default-on behavior comes from config
    // (`Ap2EntitiesStack` sets it), never from an ambiguous value reaching here.
    autoProvisionSandbox: process.env.AUTO_PROVISION_SANDBOX_METHOD === 'true',
  }

  return cached
}
