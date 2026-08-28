import { readAppConfig } from './app-config'

/**
 * The three MFA postures, and what each one asks of the app.
 *
 * They are not three settings of one feature — they are three different products, and the difference
 * that matters is *where enrollment happens*:
 *
 * - **off** — no second factor exists. Offering to set one up would call an API the pool refuses.
 * - **required** — Cognito challenges every user with no factor at sign-in, so enrollment is part of
 *   signing in and needs nothing else. See `auth-steps.ts`.
 * - **optional** — Cognito challenges only users who *already* have a factor, and never asks anyone
 *   to create one. Without somewhere for a signed-in user to opt in, this mode is `off` wearing a
 *   different name: nobody can ever enroll, so nobody is ever challenged.
 *
 * That last case is the reason this module exists.
 */
export type MfaMode = 'off' | 'optional' | 'required'

const MFA_MODES: readonly MfaMode[] = ['off', 'optional', 'required']

/**
 * The mode this deployment runs, from the config the frontend stack injects.
 *
 * Falls back to `off` on anything unrecognized — including a stale `config.js` from before this
 * existed. The fallback is the safe direction: it hides a control, where guessing `required` would
 * show people an enrollment flow the pool would reject.
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
 * What the security panel should show. One shape per thing the user can be told or offered.
 *
 * `unavailable` is not an error state — it is the correct answer for a deployment that runs without
 * MFA, and the panel is not rendered at all.
 */
export type MfaStatus =
  | { kind: 'unavailable' }
  | { kind: 'enrolled'; canDisable: boolean }
  | { kind: 'notEnrolled'; enforced: boolean }

/**
 * Reads a status out of the mode and the user's current preference.
 *
 * `canDisable` is false under `required` because Cognito refuses to remove the last factor from a
 * pool that mandates one — so offering a button that always fails would be worse than not offering
 * it. `enforced` under `required` is only reachable in theory (sign-in enrolls first), but a user
 * who lands here mid-flow should be told the enrollment is not optional rather than shown a
 * take-it-or-leave-it invitation.
 */
export function mfaStatus(mode: MfaMode, preference: MfaPreference | undefined): MfaStatus {
  if (mode === 'off') return { kind: 'unavailable' }

  const enrolled = preference?.enabled?.includes('TOTP') ?? false
  if (enrolled) return { kind: 'enrolled', canDisable: mode === 'optional' }

  return { kind: 'notEnrolled', enforced: mode === 'required' }
}
