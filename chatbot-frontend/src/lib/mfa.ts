import { readAppConfig } from './app-config'

/**
 * The three MFA postures. Not three settings of one feature — three different products, and the
 * difference is *where enrollment happens*:
 *
 * - **off** — no second factor. Offering to set one up calls an API the pool refuses.
 * - **required** — Cognito enrolls every factorless user at sign-in; nothing else is needed.
 * - **optional** — Cognito challenges only users who *already* have a factor and never asks anyone
 *   to create one, so without somewhere to opt in this mode is `off` under another name.
 *
 * That last case is why this module exists.
 */
export type MfaMode = 'off' | 'optional' | 'required'

const MFA_MODES: readonly MfaMode[] = ['off', 'optional', 'required']

/**
 * The mode this deployment runs. Falls back to `off` on anything unrecognized, including a stale
 * `config.js`: hiding a control is safe, where guessing `required` shows a flow the pool rejects.
 */
export function mfaMode(): MfaMode {
  const raw = readAppConfig('VITE_COGNITO_MFA')?.trim().toLowerCase()
  return MFA_MODES.includes(raw as MfaMode) ? (raw as MfaMode) : 'off'
}

/** What `fetchMFAPreference` reports back. */
export interface MfaPreference {
  enabled?: readonly string[]
  preferred?: string
}

/**
 * What the security panel shows. `unavailable` is not an error — it is the right answer for a
 * deployment running without MFA, and the panel is not rendered at all.
 */
export type MfaStatus =
  | { kind: 'unavailable' }
  | { kind: 'enrolled'; canDisable: boolean }
  | { kind: 'notEnrolled'; enforced: boolean }

/**
 * A status from the mode and the user's current preference. `canDisable` is false under `required`:
 * Cognito refuses to remove the last factor from a pool that mandates one, so the button would
 * always fail.
 */
export function mfaStatus(mode: MfaMode, preference: MfaPreference | undefined): MfaStatus {
  if (mode === 'off') return { kind: 'unavailable' }

  const enrolled = preference?.enabled?.includes('TOTP') ?? false
  if (enrolled) return { kind: 'enrolled', canDisable: mode === 'optional' }

  return { kind: 'notEnrolled', enforced: mode === 'required' }
}
