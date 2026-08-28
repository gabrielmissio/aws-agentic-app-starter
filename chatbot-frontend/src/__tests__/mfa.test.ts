import { afterEach, describe, expect, it, vi } from 'vitest'
import { mfaStatus, type MfaMode } from '../lib/mfa'

/**
 * The three MFA modes, as three different products.
 *
 * The one worth testing is `optional`. Cognito challenges users who already hold a factor and never
 * asks anyone to create one — so a deployment set to `optional` with no way for a signed-in user to
 * opt in is `off` under another name: nobody enrolls, so nobody is ever challenged. These pin the
 * decisions the panel makes from the mode, and the state of the account looking at it.
 */

/**
 * `readAppConfig` snapshots `window.__APP_CONFIG__` when its module is first evaluated — the SPA
 * loads `/config.js` before the bundle, so at runtime the snapshot is already correct. A test that
 * assigns the config after importing would be reading an empty snapshot, so each case builds the
 * window first and imports fresh.
 */
async function modeWith(mfa: string | undefined): Promise<string> {
  vi.resetModules()
  ;(globalThis as { window?: { __APP_CONFIG__?: Record<string, string> } }).window = {
    __APP_CONFIG__: mfa === undefined ? {} : { VITE_COGNITO_MFA: mfa },
  }
  const { mfaMode } = await import('../lib/mfa')
  return mfaMode()
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('reading the configured mode', () => {
  it.each(['off', 'optional', 'required'] as MfaMode[])('accepts %s', async (mode) => {
    expect(await modeWith(mode)).toBe(mode)
  })

  it('falls back to off for anything it does not recognize', async () => {
    // Including a `config.js` deployed before this existed. Hiding a control is the safe direction;
    // guessing `required` would show an enrollment flow the pool would refuse.
    expect(await modeWith(undefined)).toBe('off')
    expect(await modeWith('yes')).toBe('off')
  })
})

describe('what the security panel is told', () => {
  it('offers nothing at all when the pool runs without MFA', () => {
    // Not an error state — the correct answer for a deployment that does not do MFA. The menu entry
    // is not rendered, because the enrollment APIs behind it would be refused.
    expect(mfaStatus('off', undefined)).toEqual({ kind: 'unavailable' })
    expect(mfaStatus('off', { enabled: ['TOTP'], preferred: 'TOTP' })).toEqual({
      kind: 'unavailable',
    })
  })

  it('invites an unenrolled user to opt in when MFA is optional', () => {
    // The case the panel exists for: without this invitation `optional` never enrols anyone.
    expect(mfaStatus('optional', { enabled: [] })).toEqual({
      kind: 'notEnrolled',
      enforced: false,
    })
    expect(mfaStatus('optional', undefined)).toEqual({ kind: 'notEnrolled', enforced: false })
  })

  it('lets an enrolled user turn it off only where the pool allows it', () => {
    // Cognito refuses to remove the last factor from a pool that mandates one, so a button that
    // always fails would be worse than no button.
    expect(mfaStatus('optional', { enabled: ['TOTP'] })).toEqual({
      kind: 'enrolled',
      canDisable: true,
    })
    expect(mfaStatus('required', { enabled: ['TOTP'] })).toEqual({
      kind: 'enrolled',
      canDisable: false,
    })
  })

  it('tells an unenrolled user under `required` that it is not a choice', () => {
    // Reachable only mid-flow, since sign-in enrolls first — but the wording has to say "finish
    // this" rather than offering a take-it-or-leave-it invitation.
    expect(mfaStatus('required', { enabled: [] })).toEqual({ kind: 'notEnrolled', enforced: true })
  })

  it('reads enrollment from the factor, not from the preference alone', () => {
    // A user can hold a verified factor without it being their preferred one; they are still
    // enrolled, and offering them "set up an authenticator" would start a second association.
    expect(mfaStatus('optional', { enabled: ['TOTP'], preferred: undefined })).toMatchObject({
      kind: 'enrolled',
    })
    expect(mfaStatus('optional', { enabled: ['SMS'] })).toMatchObject({ kind: 'notEnrolled' })
  })
})
