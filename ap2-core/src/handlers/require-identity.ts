import { verifyIdentityToken, type IDENTITY_AUDIENCE } from '../domain'
import { ctx } from '../context'
import { HttpError, type RequestBody } from '../http'

/**
 * Resolves the authenticated caller for an entity operation, or refuses the request.
 *
 * The caller is read from a signed token, never from a body field. A `userId` in the request body
 * would make the Credential Provider's answer to *"list this user's payment methods"* a function of
 * whatever the caller typed — and the agent is one of those callers, which AP2 is explicit is to be
 * treated as an attacker.
 *
 * The token is minted by the BFF from the Cognito claims the API Gateway authorizer verified, and
 * signed with a KMS key **no entity holds `kms:Sign` on**. See `domain/identity.ts`.
 *
 * There is no fallback. A request without a valid token is a 401, never a request that quietly
 * proceeds under a body-supplied id — a fallback would reopen exactly what this closes.
 */
export async function requireCallerSub(
  body: RequestBody,
  verifier: (typeof IDENTITY_AUDIENCE)[number],
): Promise<string> {
  const token = typeof body.identityToken === 'string' ? body.identityToken : undefined
  const check = await verifyIdentityToken(ctx().signer, token, verifier)

  if (!check.ok || !check.sub) {
    // The reason is deliberately not echoed to the caller: it distinguishes "expired" from "wrong
    // signature" from "not addressed to me", which is a probing oracle. It is logged by the
    // envelope's error path instead.
    throw new HttpError(401, 'a valid caller identity token is required', 'IDENTITY_REQUIRED')
  }

  return check.sub
}
