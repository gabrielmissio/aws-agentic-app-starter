# AP2 on this stack

How an agent completes a purchase here without ever holding payment data or approving on the user's
behalf — and why the result is something you can check rather than something you have to believe.

For what is and is not conformant to the specification, see
[ap2-conformance.md](ap2-conformance.md). For the code, start at
[`ap2-core/`](../ap2-core/README.md).

---

## 1. The problem

When an agent buys on someone's behalf, "trust the agent" is not a security model: it is
non-deterministic, its instructions are partly attacker-controlled, and its output is prose.

AP2 moves the trust into the infrastructure instead. Each party signs a credential the next party
checks, so consent, scope, accountability and auditability survive whatever the agent is talked into.

Two guarantees anchor the design:

1. **Consent is bound to exact content.** The user approves a specific signed cart, identified by
   hash — not a description of it the agent could change afterwards.
2. **Every hop re-verifies.** Signatures and hash links are checked again at each entity, so a
   tampered, expired, reused or out-of-scope artifact is blocked *before* money moves.

## 2. The components

| Component | Responsibility | Signs | Verifies |
|---|---|---|---|
| **Merchant Endpoint** | Resolves price and fees, signs the cart; verifies the user's Checkout Mandate, then starts payment with the MPP | Cart Mandate, Checkout Receipt | the Checkout Mandate, and its freshness against the latest cart |
| **Consent sessions** | Opens a session over a signed cart, reads it back, hands over the signed mandates | — | — |
| **Mandate Authority** | The trusted surface — the only thing that signs on the user's behalf | Checkout Mandate, Payment Mandate | the merchant's cart |
| **Credential Provider** | Issues a scoped, single-use credential; redeems it for the MPP | Payment Credential | both mandates, their linkage, the amount, the method, the target processor, the payer |
| **Merchant Payment Processor** | Verifies the whole chain, redeems, settles | Payment Receipt | everything: all four signatures and every hash link |
| **Evidence Store** | Append-only audit trail, keyed by journey | — | — |

**Role separation is the point.** The agent sees only opaque references — never card, CVV or
processor data — and never talks to the MPP: the Merchant does. That is enforced at the IAM layer,
not by convention: the agent's execution role holds `InvokeFunctionUrl` on the Merchant, consent
**session** and CP functions and on nothing else.

**Why the consent surface is two components.** Function-URL IAM authorizes per function, never per
operation. Were the operation that signs to sit next to the session operations the agent legitimately
calls, any principal able to open a session would also be able — at the IAM layer — to have mandates
signed. AP2 makes that a MUST: *"The Agent Provider MUST ensure that the Agent is not able to access
the Agent Provider signing key, **or use it without the Trusted Surface**."* So `submit_consent_decision`
runs on its own function, holds the only `kms:Sign` grant on the Consent key, and is invokable only
by the checkout Lambda that ran the step-up. The agent has no grant on it, and the session function
it does call can sign nothing.

## 3. The signed chain

```text
1  Merchant     ──JWS──▸  Cart Mandate        the exact cart, at the exact price
2  Consent      ──SD-JWT─▸ Checkout Mandate   the user approved THIS cart (wraps the cart's token)
3  Consent      ──SD-JWT─▸ Payment Mandate    amount, payee, opaque instrument reference
4  Credential   ──JWS──▸  Payment Credential  scoped to one cart, one amount, one processor, once
5  Merchant     ────────▸  MPP                forwards only the token + the checkout hash
6  MPP          ──verify──                    the Checkout Mandate and the credential, pre-redeem
7  CP           ──redeem─▸ instruction        returns the Payment Mandate it verified at issuance
8  MPP          ──verify──                    that mandate, post-redeem, BEFORE the processor
9  MPP          ──JWS──▸  Payment Receipt     the signed outcome
10 Merchant     ──JWS──▸  Checkout Receipt    issued on acceptance AND on rejection
```

Two serializations coexist, following the specification's own tables. The Cart Mandate, the
credential and both receipts are **compact JWS**. The two **user-signed** mandates are
**SD-JWT-VCs**: the CP and MPP read the amount and payee from always-visible claims, while the
instrument reference, the risk signals and the consent proof ride as disclosures.

One caveat, because it is easy to over-read: upstream marks exactly one field disclosable —
`checkout_jwt`, which this stack matches — and nothing on the Payment Mandate, where
`payment_instrument` is `required`. The extra disclosures above are a local extension and every
presentation here carries all of them, so treat disclosure on the Payment Mandate as a shape this
stack supports, not a privacy property to lean on. See D5 in [ap2-conformance.md](ap2-conformance.md).

Signing is **ES256** (ECDSA P-256) throughout — AWS KMS in the cloud, Node's own EC signer locally.
The specification requires the Checkout JWT to use a *non-deterministic* scheme, because a
deterministic signature over a low-entropy cart is open to a rainbow-table attack; ECDSA's random
per-signature nonce is what satisfies that.

Hashes are base64url SHA-256 over **RFC 8785 (JCS)** canonical JSON. A standard canonicalization
rather than a home-grown one, so an independent implementation re-hashing the same object arrives at
the same digest — which is the whole basis for parties agreeing on what was signed.

### What gets blocked

| Code | Trigger |
|---|---|
| `TAMPERED` | a payload no longer matches its signed hash |
| `INVALID_MANDATE` | an approval did not verify, or no longer applies to the current cart |
| `OUT_OF_SCOPE` | the amount, method or target processor is outside what was approved |
| `EXPIRED` | the cart or the credential's window has closed |
| `DOUBLE_SPEND` | a single-use credential is redeemed twice |
| `REPLAYED` | the same mandate is presented to the same verifier twice |

Every one of these has a test in [`ap2-core`](../ap2-core/README.md), and every one produces a
**signed** Error receipt — a rejection is as auditable as a payment.

Two properties are worth stating on their own:

- **The MPP fails closed.** Its post-redeem checks run before the processor call, so an inconsistent
  chain burns the single-use credential but never charges anyone.
- **The audit trail is append-only at the IAM layer.** Each entity is granted `dynamodb:PutItem` on
  the evidence log and nothing else, so no participant can amend or erase the record of what it did.

## 4. Where the human fits

The agent **proposes**; the human **authorizes**; the infrastructure **settles**.

```text
browser ──▶ BFF /chat ──▶ AgentCore Runtime ──SigV4─▶ Merchant · Consent · CP
                                    │
                                    └─ proposes a cart, opens a consent session, stops

browser ──▶ BFF /intent   opens the approval gate over that session
        ──▶ BFF /confirm  verifies the approval → Consent signs both mandates → settle
```

**The BFF settles, not the agent** — a deliberate departure from the specification's human-present
flow, which hands the signed mandates back to the Shopping Agent. Here they never enter the model's
context, so nothing a prompt talks it into can reformat, leak or replay them. Every party still
receives exactly the payload the specification says it should; only the courier changes. See D3 in
[ap2-conformance.md](ap2-conformance.md).

The agent has four tools: search the menu, have the Merchant sign a cart, list opaque payment
references, and open a consent session. It has no tool that signs a mandate, issues a credential or
starts a payment. It is not instructed to avoid moving money — it has no way to.

The approval is **HMAC-sealed** to one session, cart, amount and user, because a one-time code proves
someone is present, not what they agreed to — unsealed, a code minted for a small cart authorizes a
large one. Above a configurable threshold checkout requires that code; below it an authenticated tap
on the sealed intent is the approval, and the BFF re-derives which applies from the *sealed* amount
so a client cannot downgrade a high-value checkout.

A step-up is only offered when a code can be delivered. `/intent` resolves a channel first — SMS to a
verified `phone_number`, or the sandbox reveal — and **refuses the checkout** when there is none,
rather than opening a code field nobody can fill. Which channel delivered is signed into both
mandates: a code read off the API response records as `OTP_SANDBOX_REVEALED`, never `OTP_SMS`,
because an audit trail that overstates how someone authorized is worse than one admitting the flow
was frictionless. Five wrong attempts burn the approval, so the six-digit secret is bounded by
attempts and not only by the clock.

Identity never reaches the agent as something it can change: the BFF prepends a block built from the
authorizer's verified claims, the runtime binds it to the request, and the tools read it from there.
No tool takes a user id, so no prompt can supply one.

**The transport is what makes that block trustworthy.** It is plain text, so it is only as good as
whoever could have written it. The AgentCore runtime carries no authorizer configuration — it accepts
SigV4 alone — and the BFF's chat function is the sole principal granted `InvokeAgentRuntime` on it.
There is no Cognito identity pool, so the browser holds no AWS credentials and the BFF is the only
writer. A direct browser→AgentCore transport would make the block the opening lines of a request body
any signed-in user could compose, and the agent's payment tools would act for whatever `userId` it
named — so `infra/src/__tests__/stacks.test.ts` asserts its preconditions stay absent.

## 5. The AWS mapping

```text
PUBLIC (Cognito-authorized)
  POST /chat                      the agent conversation, streamed
  POST /intent /confirm /decline  the approval gate and settlement
  GET  /journeys /evidence /actors the proof surfaces

INTERNAL (Lambda Function URL, AuthType=AWS_IAM, SigV4)
  Merchant Endpoint    ◂── the agent, the BFF          (and drives the MPP)
  Consent sessions     ◂── the agent, the BFF           — signs nothing
  Mandate Authority    ◂── the checkout Lambda ONLY     — the only kms:Sign on the consent key
  Credential Provider  ◂── the agent, the BFF, the MPP (redeem)
  MPP                  ◂── the Merchant only — never the agent
  Evidence Store       ◂── every entity, append-only
```

| Concern | Resource | Stack |
|---|---|---|
| One signing key per entity, plus the BFF's HMAC secret | KMS, Secrets Manager | [`security-stack.ts`](../infra/src/stacks/security-stack.ts) |
| Catalog, carts, sessions, mandates, methods, credentials, attempts, evidence, intents | DynamoDB (on-demand) | [`data-stack.ts`](../infra/src/stacks/data-stack.ts) |
| The six entity Lambdas and their private URLs | Lambda, IAM | [`ap2-entities-stack.ts`](../infra/src/stacks/ap2-entities-stack.ts) |
| The agent container and runtime | Bedrock AgentCore, ECR | [`agent-stack.ts`](../infra/src/stacks/agent-stack.ts) |
| The chat, admin and checkout functions, and the API | API Gateway, Lambda | [`bff-stack.ts`](../infra/src/stacks/bff-stack.ts) |

### Why these choices

| Choice | Why it fits | What to know |
|---|---|---|
| **One KMS key per entity** | Separate keys are the security model: a compromised Merchant cannot forge the user's consent, because it has no way to sign with the consent key | Asymmetric signing latency is small but not zero |
| **One Lambda per role** | Isolation and least privilege are expressible as "no grant"; SigV4 secures the internal hops; scales to zero | More functions to deploy and observe |
| **Three BFF functions** | The chat function relays untrusted model output and must not hold the HMAC secret or settlement rights; the admin function must not either | Three cold starts instead of one |
| **DynamoDB, on-demand** | Per-entity tables; single-use redeem is an atomic conditional write rather than a read-then-write race | Bursty human traffic is exactly its shape |
| **API Gateway REST + Cognito** | REST streams SSE, which HTTP APIs cannot; the authorizer gates every route including the money-moving ones | A streaming Lambda is held open during think time |

## 6. Security posture

- **Only the BFF can reach the agent.** The runtime is SigV4-only, granted to one role. The browser
  holds a Cognito token and no AWS credentials at all.
- **The agent cannot settle a payment.** It has no tool that signs a mandate, issues a credential or
  drives the MPP, and its execution role holds no grant on the MPP's Function URL. (It *can* invoke
  the Consent function's URL, since Function-URL IAM cannot scope by operation — so for the consent
  surface specifically the boundary is the toolset, not IAM. See `assessments/assessment.md` H1.)
- **The one-time code never touches the agent.** It goes out of band by SMS and comes back straight
  from the browser to the BFF.
- **Approvals are tamper-evident.** The HMAC seal binds a code to exactly one session, cart, amount
  and user.
- **Opaque references only.** No card, CVV or processor data reaches the agent or the browser.
- **Least privilege end to end.** Per-entity KMS scoping, `AWS_IAM` Function URLs, append-only
  evidence, and a checkout role that can read the audit trail but never write to it.
- **The HMAC secret is never templated.** Only its ARN reaches the function's environment; the value
  is fetched at cold start.

- **Caller identity is a signed artifact, not a body field.** The BFF mints a short-lived JWS naming
  the authenticated `sub`; the Merchant, the consent surface and the CP verify it and refuse a call
  without one. Only the BFF holds `kms:Sign` on that key — an entity can check who is calling and
  can never manufacture the answer, and the agent can only forward the token it was handed.
- **A journey belongs to the caller who opened it.** `journeyId` is caller-chosen and appears in
  URLs and logs, and the cart lookup by journey is idempotent — so without an owner recorded at the
  Merchant, naming someone else's journey would return their signed cart.

Deliberately **not** production-hardened, and worth knowing before building on this: consent is
signed by the trusted surface rather than by a user-held key (holder binding is the open item), the
processor is simulated, and there is no network-level 3-D Secure. `ALLOWED_ORIGIN` defaults to `*`
and is a comma-separated allowlist when set — an origin that is not on it is not reflected. See
[ap2-conformance.md](ap2-conformance.md) for the full statement.
