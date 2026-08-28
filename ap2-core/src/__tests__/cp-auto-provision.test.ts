import { describe, expect, it } from 'vitest'
import { MemoryCredentialRepo } from '../domain/adapters/memory'
import * as cp from '../domain/entities/credential-provider'

/**
 * AUTO_PROVISION_SANDBOX_METHOD: a brand-new user has no registered method, so the demo checkout
 * would stall. When the caller passes `autoProvision`, `listPaymentMethods` mints a sandbox method on the
 * first listing — letting a fresh Cognito user complete the journey without a per-user seed. The flag is a
 * caller-injected parameter — the handler reads the environment, so the domain stays free of config.
 */
describe('CP listPaymentMethods — sandbox auto-provision', () => {
  it('mints a sandbox method for a user with none when autoProvision is on', async () => {
    const repo = new MemoryCredentialRepo()
    const methods = await cp.listPaymentMethods(repo, 'cognito-sub-uuid', true)
    expect(methods).toHaveLength(1)
    expect(methods[0]?.paymentMethodRef).toBe('pm_visa_1234')
    // Persisted under the queried userId, so the next (flag-off) listing still finds it.
    expect(await cp.listPaymentMethods(repo, 'cognito-sub-uuid')).toHaveLength(1)
  })

  it('returns empty (no write) for a user with none when autoProvision is off', async () => {
    const repo = new MemoryCredentialRepo()
    expect(await cp.listPaymentMethods(repo, 'cognito-sub-uuid')).toHaveLength(0)
    expect(await cp.listPaymentMethods(repo, 'cognito-sub-uuid', false)).toHaveLength(0)
  })

  it('does not duplicate or overwrite an existing method', async () => {
    const repo = new MemoryCredentialRepo()
    await repo.putMethod({ ...cp.makeSandboxMethod('u1'), displayName: 'My real card' })
    const methods = await cp.listPaymentMethods(repo, 'u1', true)
    expect(methods).toHaveLength(1)
    expect(methods[0]?.displayName).toBe('My real card'); // untouched — auto-provision only fills the empty case
  })

  it('is idempotent across concurrent first listings (fixed PK)', async () => {
    const repo = new MemoryCredentialRepo()
    await Promise.all([
      cp.listPaymentMethods(repo, 'u2', true),
      cp.listPaymentMethods(repo, 'u2', true),
    ])
    expect(await cp.listPaymentMethods(repo, 'u2')).toHaveLength(1)
  })
})
