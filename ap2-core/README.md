# ap2-core

The AP2 domain: the signed, hash-chained artifacts that make an agent-driven purchase verifiable, the
four entities that verify them, and the AWS adapters that deploy them as six Lambdas.

Concepts and the full picture: [`../docs/ap2-architecture.md`](../docs/ap2-architecture.md).

## The components

| Component | Handler | Operations | Signs with |
|---|---|---|---|
| **Merchant Endpoint** | `src/handlers/merchant.ts` | `search_products`, `create_merchant_cart`, `initiate_payment`, `get_payment_status` | `merchant` key |
| **Consent sessions** | `src/handlers/consent-mandates.ts` | `initiate_consent_session`, `get_consent_session`, `poll_consent_status`, `get_mandate` | **nothing** |
| **Mandate Authority** | `src/handlers/consent-decision.ts` | `submit_consent_decision` | `consent` key |
| **Credential Provider** | `src/handlers/credential-provider.ts` | `list_payment_methods`, `request_payment_credential`, `redeem` (MPP only) | `cp` key |
| **Merchant Payment Processor** | `src/handlers/mpp.ts` | `initiate_payment`, `get_payment_status` (called by the **Merchant**, never the agent) | `mpp` key |
| **Evidence Store** | `src/handlers/evidence.ts` | `POST /evidence`, `GET /evidence/journeys/{id}` | — |

The consent surface is **two** functions on purpose. Function-URL IAM authorizes per function, never
per operation, so `submit_consent_decision` sitting beside the session operations the agent calls
would let any principal able to open a session have mandates signed. AP2 makes that a MUST:

> *"The Agent Provider MUST ensure that the Agent is not able to access the Agent Provider signing
> key, **or use it without the Trusted Surface**."* —
> [Agent Authorization](https://ap2-protocol.org/ap2/agent_authorization/)

So the signing operation lives on its own function, holds the only `kms:Sign` grant on the Consent
key, and its Function URL is granted to the checkout Lambda alone. The session function the agent
calls holds no signing authority at all.

## Who is calling, and for whom

SigV4 authenticates the **component** making an entity call. It says nothing about the **user** it is
acting for, so that is carried as a signed artifact of its own — never as a `userId` body field the
entities would have to believe.

The BFF mints a short-lived compact JWS naming the `sub` the Cognito authorizer verified
(`src/domain/identity.ts`), signed with a KMS key **only the BFF holds `kms:Sign` on**. The five
caller-scoped operations resolve the user from it and refuse a request without one — there is no
fallback to a body field, because the fallback *is* the vulnerability. Entities hold `kms:Verify`
alone, so one can check an identity and never assert it; the agent holds neither key.

That token is what makes a **journey a tenant boundary**: `journeyId` is caller-chosen and rides in
URLs and logs, and the cart-by-journey lookup is idempotent — so without a recorded owner, naming
someone else's journey returns their signed cart.

## Layout

```text
src/
├─ domain/         Pure AP2 logic, no AWS: types, canonical hashing, JWS + SD-JWT-VC, the entities
│  ├─ entities/    merchant · consent-mandates · credential-provider · mpp
│  └─ adapters/    In-memory repositories + a local ES256 signer — the whole chain, offline
├─ adapters-aws/   KmsSigner (one key per entity), DynamoDB repositories, the SigV4 entity client
├─ handlers/       The six Lambdas — thin: they inject adapters into the domain and nothing else
├─ context.ts      Builds the ports from the AWS environment (one instance per warm container)
├─ http.ts         The request envelope: a block becomes a coherent HTTP status, never a 500
├─ log.ts          Structured logging with enforced redaction, shared with the BFF
├─ schemas/        AP2 JSON Schemas, asserted against by the conformance suite
└─ seed.ts         Post-deploy catalog seed
```

**Ports and adapters.** `Signer` is either `LocalSigner` (ECDSA P-256) or `KmsSigner`; the
repositories are either in-memory or DynamoDB. The domain depends only on the interfaces, which is
what lets the entire chain — including its negative paths — run in a unit test with no AWS account.

## Run

```bash
npm install
npm test          # the chain (happy path + every blocked scenario), JWS, SD-JWT, schema conformance
npm run build     # tsup → dist/handlers/*.mjs, one self-contained bundle per entity
npm run typecheck
```

Nothing above needs AWS credentials, Docker, or a network.

## The guarantee

```text
Cart Mandate → Checkout Mandate → Payment Mandate → Payment Credential → Payment Receipt
```

Each artifact is signed by a different key and carries the hash of the one before it, and each
entity re-verifies the whole chain rather than trusting the caller. Tampering, expiry, replay, reuse
of a single-use credential, and anything out of the approved scope are all blocked with a typed code
(`TAMPERED`, `EXPIRED`, `REPLAYED`, `DOUBLE_SPEND`, `OUT_OF_SCOPE`, `INVALID_MANDATE`) before money
moves — and every one of those paths has a test.
