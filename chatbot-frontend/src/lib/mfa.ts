import { readAppConfig } from './app-config'

/**
 * The three MFA postures. Not three settings of one feature — three different products, and the
 * difference is *where enrollment happens*:
 *
 * - **off** — no second factor. Offering to set one up calls an API the pool refuses.
 * - **required** — Cognito enrolls every factorless user at sign-in, and challenges on the
 *   *verified token*, which the browser cannot read. So the enrollment completes and the
 *   preference stays empty — see `resolveMfaStatus`.
 * - **optional** — Cognito challenges only users who *already* have a factor and never asks anyone
 *   to create one, so without somewhere to opt in this mode is `off` under another name.
 *
 * The last case is why this module exists; the middle one is why it cannot trust what it reads.
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

/**
 * The two calls the probe below makes, injected so the decision can be tested without the SDK:
 * `fetchMFAPreference`, and `updateMFAPreference({ totp: 'PREFERRED' })`.
 */
export interface MfaAccount {
  readPreference: () => Promise<MfaPreference>
  preferTotp: () => Promise<unknown>
}

/**
 * The status to show, asking Cognito the question `GetUser` cannot answer.
 *
 * Cognito stores the verified software token and the MFA preference separately, and the browser
 * reads only the second — `fetchMFAPreference` is a plain `GetUser` call, and a verified token
 * appears nowhere in its answer. Under `required` the two routinely disagree: the pool challenges
 * on the token, while the `MFA_SETUP` challenge that enrolls a user at sign-in verifies a token and
 * writes no preference at all. The account is then asked for a code at every sign-in and reads back
 * as enrolled in nothing.
 *
 * So an empty preference under `required` is ambiguous — a verified token with no preference, or no
 * factor at all — and only Cognito can tell the two apart. Asking means attempting the write: it is
 * refused for a user with no verified token, and succeeds for a user who has one, repairing the
 * record on the way past.
 *
 * Not attempted under `optional`, where the preference *is* what Cognito challenges on. There an
 * empty preference is a deliberate opt-out, and probing it would silently switch the factor back
 * on.
 */
export async function resolveMfaStatus(mode: MfaMode, account: MfaAccount): Promise<MfaStatus> {
  const status = mfaStatus(mode, await account.readPreference())
  if (status.kind !== 'notEnrolled' || !status.enforced) return status

  const hasVerifiedToken = await account.preferTotp().then(
    () => true,
    () => false,
  )
  // Re-read rather than assume the write landed as asked: whatever Cognito now reports is the
  // answer, and the enrollment control staying visible is the safe direction to be wrong in.
  return hasVerifiedToken ? mfaStatus(mode, await account.readPreference()) : status
}
