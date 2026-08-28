import { signJws, verifyJws } from './jws'
import type { Signer } from './ports'

/**
 * The **caller identity token** — how an entity learns *who* is asking, without taking anyone's word
 * for it.
 *
 * Identity is an artifact like every other here, not a `userId` body field the entities take on
 * trust: a short-lived compact JWS, signed by the **BFF** with its own KMS key, carrying the `sub`
 * the API Gateway's Cognito authorizer verified. A body field would rest the guarantee on properties
 * of *other* components — that the agent is the sole caller, that it has no signing tool — and AP2
 * rules that out:
 *
 * > *"All LLMs and Agents MUST be considered potential attackers."*
 * > — [Security and privacy considerations](https://ap2-protocol.org/ap2/security_and_privacy_considerations/)
 *
 * **The key asymmetry is the point.** The BFF holds `kms:Sign`; the Merchant, the consent surface
 * and the CP hold only `kms:Verify`, so an entity can check who is calling but cannot mint a claim
 * about anyone. The **agent holds neither** — it receives one token, for the turn it is serving, and
 * can only pass it along unchanged.
 *
 * The token never enters the model's context: it rides in the session-context block, which
 * `agent/src/index.ts` strips before the prompt reaches the model.
 */

/** JOSE `typ` for the identity token — the type-confusion guard, as for every other artifact here. */
export const IDENTITY_TYP = 'ap2.IdentityToken'

/**
 * Ten minutes. Long enough for a chat turn plus the settlement it triggers, short enough that a
 * token recovered from a log is almost always already dead. The agent re-receives a fresh one on
 * every invocation, so there is no refresh path to build.
 */
export const IDENTITY_TTL_SEC = 600

/** The `kid`/entity name of the identity signing key. Distinct from the four AP2 role keys. */
export const IDENTITY_KID = 'identity'

/** The entities that verify an identity token, and therefore the values its `aud` may carry. */
export const IDENTITY_AUDIENCE = ['merchant', 'consent', 'cp'] as const

/**
 * Mints a token asserting that `sub` is the authenticated caller.
 *
 * Only the BFF can do this, because only the BFF holds `kms:Sign` on the identity key — and only the
 * BFF sits behind the Cognito authorizer that established `sub` in the first place.
 */
export async function mintIdentityToken(
  signer: Signer,
  sub: string,
  ttlSec = IDENTITY_TTL_SEC,
): Promise<string> {
  if (!sub) throw new Error('mintIdentityToken: sub is required')
  const now = Math.floor(Date.now() / 1000)
  return signJws(
    signer,
    IDENTITY_KID,
    {
      iss: 'bff',
      sub,
      // Every entity that resolves a caller re-verifies it independently.
      aud: [...IDENTITY_AUDIENCE],
      iat: now,
      exp: now + ttlSec,
    },
    IDENTITY_TYP,
  )
}

/** The outcome of verifying an identity token: the authenticated subject, or why it was refused. */
export interface IdentityCheck {
  ok: boolean
  reason: string
  sub?: string
}

/**
 * Verifies a token and returns the subject it authenticates.
 *
 * Fail-closed in every direction: a missing token, a token signed by anything other than the
 * identity key, a wrong `typ`, an expired one, or one not addressed to this verifier all yield
 * `ok: false`. There is deliberately **no** fallback to a caller-supplied `userId` — that fallback
 * is the vulnerability this replaces.
 */
export async function verifyIdentityToken(
  signer: Signer,
  token: string | undefined,
  verifier: (typeof IDENTITY_AUDIENCE)[number],
): Promise<IdentityCheck> {
  if (!token) return { ok: false, reason: 'no identity token was presented' }

  const v = await verifyJws(signer, token, { typ: IDENTITY_TYP, aud: verifier })
  if (!v.ok) return { ok: false, reason: v.reason }

  // `verifyJws` checks the signature against the key named by `kid`, so an attacker cannot point it
  // at a key they control — but they could point it at another *legitimate* key. Pinning the kid is
  // what stops a Cart Mandate's merchant signature from being replayed as an identity assertion.
  if (v.header?.kid !== IDENTITY_KID) {
    return { ok: false, reason: `identity token was not signed by '${IDENTITY_KID}'` }
  }

  const sub = v.claims?.sub
  if (typeof sub !== 'string' || !sub) {
    return { ok: false, reason: 'identity token carries no sub' }
  }

  return { ok: true, reason: 'identity token checks out', sub }
}
