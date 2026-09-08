import { afterEach, describe, expect, it, vi } from 'vitest'
import { mfaStatus, resolveMfaStatus, type MfaMode, type MfaPreference } from '../lib/mfa'

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

describe('resolving the status against an account Cognito will not fully describe', () => {
  /**
   * A Cognito account as the two calls see it. `verifiedToken` is the half `GetUser` never
   * reports: the write is refused without one, and with one it succeeds and writes the preference
   * the read has been missing — which is exactly how the probe tells the two apart.
   */
  function account(state: { verifiedToken: boolean; preference: MfaPreference }) {
    const calls = { reads: 0, writes: 0 }
    return {
      calls,
      readPreference: async () => {
        calls.reads += 1
        return state.preference
      },
      preferTotp: async () => {
        calls.writes += 1
        if (!state.verifiedToken) throw new Error('User has not verified software token')
        state.preference = { enabled: ['TOTP'], preferred: 'TOTP' }
      },
    }
  }

  it('reports the enrolled user Cognito challenges but does not describe', async () => {
    // The bug: `required` challenges on the verified token, and the sign-in setup challenge writes
    // no preference — so a protected account reads back as enrolled in nothing and was shown the
    // enrollment prompt at every visit.
    const cognito = account({ verifiedToken: true, preference: {} })

    expect(await resolveMfaStatus('required', cognito)).toEqual({
      kind: 'enrolled',
      canDisable: false,
    })
    // And the record is repaired on the way past, so the next read needs no probe at all.
    expect(cognito.calls.writes).toBe(1)
  })

  it('still offers enrollment to a user who genuinely has no factor', async () => {
    // Cognito refuses the write without a verified token, which is the answer the probe wants: the
    // one person who needs the enrollment control must not have it hidden.
    const cognito = account({ verifiedToken: false, preference: {} })

    expect(await resolveMfaStatus('required', cognito)).toEqual({
      kind: 'notEnrolled',
      enforced: true,
    })
  })

  it('never probes under optional, where an empty preference is a decision', async () => {
    // There Cognito challenges on the preference, so empty means opted out. Probing would switch
    // the factor back on for someone who deliberately turned it off.
    const cognito = account({ verifiedToken: true, preference: { enabled: [] } })

    expect(await resolveMfaStatus('optional', cognito)).toEqual({
      kind: 'notEnrolled',
      enforced: false,
    })
    expect(cognito.calls.writes).toBe(0)
  })

  it('does not probe an account that already reads as enrolled', async () => {
    const cognito = account({ verifiedToken: true, preference: { enabled: ['TOTP'] } })

    expect(await resolveMfaStatus('required', cognito)).toEqual({
      kind: 'enrolled',
      canDisable: false,
    })
    expect(cognito.calls.writes).toBe(0)
  })

  it('does not probe at all when the pool runs without MFA', async () => {
    // The APIs behind the probe are refused by a pool with no MFA configured, and there is no
    // panel to populate either way.
    const cognito = account({ verifiedToken: false, preference: {} })

    expect(await resolveMfaStatus('off', cognito)).toEqual({ kind: 'unavailable' })
    expect(cognito.calls.writes).toBe(0)
  })

  it('believes the re-read rather than the write it just made', async () => {
    // A write that reports success but leaves the preference empty leaves the enrollment control
    // on screen. Wrong in the direction that can still be recovered from by hand.
    const stubborn = {
      readPreference: async (): Promise<MfaPreference> => ({}),
      preferTotp: async () => undefined,
    }

    expect(await resolveMfaStatus('required', stubborn)).toEqual({
      kind: 'notEnrolled',
      enforced: true,
    })
  })
})
