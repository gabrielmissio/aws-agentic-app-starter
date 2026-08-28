# AP2 conformance

What this implementation gets right against the AP2 specification, what it deliberately does
differently, and what is simply not built.

The short version: the **human-present flow follows the specification's own Phase 2 step for step**,
the chain-verification MUSTs are met by the roles the specification names, and this stack sits
squarely in AP2's **Trusted Agent Provider** delegation model — which is a normative option, not a
shortcut. What diverges is the *serialization envelope*, *who orchestrates the settlement*, and the
scope (human-present only, simulated processor).

Of the MUSTs read so far, §2 scores them one by one: **seven met, none unmet.** "Fully
spec-conformant" is still not claimed, though: §3 lists ten deliberate divergences, of which the
serialization envelope (D4) is the one that blocks interoperability with an independent AP2
implementation.

---

## 0. Which AP2 this targets

**Target: the published specification, [v0.2](https://ap2-protocol.org/ap2/specification/).** Note
the version number: `v0.2` is an early draft, not a mature major release. It will move, and some of
what follows will move with it.

The upstream repository carries **two generations of the protocol side by side**, and a reader
comparing this code against the wrong one will reach the wrong conclusions:

| | Generation 1 | Generation 2 — **what this repo targets** |
|---|---|---|
| Models | `code/sdk/python/ap2/models/` — Intent / Cart / Payment, with a `user_authorization` field | `code/sdk/python/ap2/sdk/` — Checkout / Payment, SD-JWT delegation chains, generated from the JSON Schemas |
| Sample | `roles/shopping_agent`, used by `scenarios/a2a/human-present/cards` | `roles/shopping_agent_v2` |
| Specification | — | `specification.md` v0.2 |
| Mandate types | `IntentMandate`, `CartMandate`, `PaymentMandate` | `CheckoutMandate`, `PaymentMandate` |

This stack is a **hybrid, deliberately**: it keeps generation 1's `CartMandate` as the merchant's
signed-cart artifact, and takes generation 2's `vct` values, mandate shapes and JSON Schemas for
everything the user authorizes. The Cart Mandate has no generation 2 equivalent — v0.2 replaces it
with an opaque merchant-signed `checkout_jwt` whose payload is explicitly outside AP2's scope — so
keeping a typed, W3C-`PaymentRequest`-shaped cart is a superset, not a contradiction. It is what the
Explorer renders.

Where the JSON Schemas are concerned, the authoritative artifacts now live upstream at
`code/sdk/schemas/ap2/`. The copies in [`ap2-core/src/schemas/ap2/`](../ap2-core/src/schemas/ap2)
were hand-authored from the older Python models and have drifted; see D10.

One caveat for anyone planning to vendor the upstream set: **it does not resolve as published.**
`checkout_receipt.json` and `payment_receipt.json` both `$ref` `types/receipt_status.json`, but that
file declares `$id: ".../schemas/receipt-status.json"` — hyphen, no `types/` segment. `types/jwk.json`
has the same problem, declaring itself `jwk_public_key.json`. Ajv refuses to compile either receipt
schema until both `$id`s are corrected. Vendoring means carrying that patch, and saying so in the
schema README.

---

## 1. What is machine-checked

[`ap2-conformance.test.ts`](../ap2-core/src/__tests__/ap2-conformance.test.ts) validates the
artifacts a real run of the chain produces against the JSON Schemas in
[`ap2-core/src/schemas/ap2/`](../ap2-core/src/schemas/ap2), so drift fails a test rather than sitting
in a document nobody re-checks.

**Two limits on that claim**, both tracked in [`assessment.md`](assessments/assessment.md): the schemas are
**this repository's own**, so they catch drift from our reading of the specification rather than
divergence from it; and **the receipts are not schema-validated at all**, so the two artifacts a user
actually receives are the two nothing checks (see D10).

| Property | Where it is asserted |
|---|---|
| The Cart Mandate, its contents and its W3C `PaymentRequest` match the spec shapes | `ap2-conformance.test.ts` |
| Both user-signed mandates are verifiable SD-JWT-VCs whose decoded claims are schema-valid | `ap2-conformance.test.ts` |
| `vct` is matched **exactly**, version suffix included — `mandate.payment` and `mandate.payment.2` are both rejected | `chain.test.ts` |
| `transaction_id` is the hash of the signed checkout **token**, not of the cart contents | `ap2-conformance.test.ts` |
| Money in every signed artifact is an integer in minor units; no float survives into a signature | `chain.test.ts`, `ap2-conformance.test.ts` |
| Signatures are non-deterministic ES256, emitted as raw R‖S rather than DER | `jws.test.ts`, `crypto-ecdsa.test.ts` |
| Audiences are enforced: an artifact presented to a party outside its signed `aud` is rejected | `chain.test.ts` |
| Type confusion is rejected: the right issuer and hash under another artifact's `typ` does not pass | `chain.test.ts` |
| Selective disclosure works, and a forged disclosure invalidates the presentation | `sdjwt.test.ts` |
| The step-up attestation names the channel that actually delivered the code | `chain.test.ts` |
| The Merchant refuses to sign a cart outside its line-item and quantity bounds | `chain.test.ts` |
| Every terminal outcome — success, decline, and verification block — is a signed receipt | `chain.test.ts` |
| Disclosure salts carry 128 bits and a fresh salt per claim | `sdjwt.test.ts` |
| A credential redeems only the instrument of the payer the CP verified, never one that merely shares a reference | `chain.test.ts` |
| No payer identifier travels in the credential the Merchant receives | `chain.test.ts` |
| Only the Mandate Authority holds `kms:Sign` on the Consent key, and only the checkout Lambda may invoke it | `infra/src/__tests__/stacks.test.ts` |
| Caller identity verifies only under the BFF's key: an AP2 role signature, a wrong `typ`, an expired or edited token are all refused | `identity.test.ts` |
| Only the BFF may sign an identity; the three caller-resolving entities may only verify one, and the agent neither | `infra/src/__tests__/stacks.test.ts` |
| A journey belongs to the caller who opened it — a second caller is refused, not handed the first one's signed cart | `chain.test.ts` |
| Point-in-time recovery is on for every table | `infra/src/__tests__/stacks.test.ts` |
| No processor identifier appears in any artifact or in the audit trail | `ap2-conformance.test.ts` |

Anyone can check the crypto by hand: paste a `merchant_authorization` into jwt.io and read its
`cart_hash` claim, or pull an actor's public key from `/actors` and verify a signature yourself.

---

## 2. The hard MUSTs

### 2.1 Non-deterministic signatures — **met**

The specification requires the Checkout JWT to use *"a digital signature scheme (e.g. ECDSA) and
**not** a deterministic signature (e.g. Ed25519)"*, because a deterministic signature over a
low-entropy cart is open to a rainbow-table attack.

Every artifact here is **ES256** (ECDSA P-256) — the specification's own example — whose random
per-signature nonce satisfies that. KMS signs `ECDSA_SHA_256` on `ECC_NIST_P256`, and the adapter
converts its ASN.1 DER output to the raw R‖S the JOSE wire format carries, so tokens verify in any
off-the-shelf JOSE library rather than only here.

### 2.2 The Agent must not be able to use the signing key — **met**

[Agent Authorization §Trusted Agent Provider](https://ap2-protocol.org/ap2/agent_authorization/):

> *"The Agent Provider **MUST** ensure that the Agent is not able to access the Agent Provider signing
> key, **or use it without the Trusted Surface**."*

Meeting this needs the consent surface split across **two** functions, and the reason is worth
recording because a single function looks adequate. Denying the agent *access* to the Consent KMS key
is the easy half. But a Lambda Function URL authorizes with IAM at the **function** granularity and
cannot scope a principal to one operation — so if `submit_consent_decision` shared a function with
the session operations the agent legitimately calls, the agent's execution role would hold
`InvokeFunctionUrl` on it and could have mandates signed with no Trusted Surface involved. The only
thing standing in the way would be the agent's own toolset not exposing the operation, and the
specification rules that out explicitly:

> *"**All LLMs and Agents MUST be considered potential attackers**"* — prompt injection being feasible.
> — [Security and privacy considerations](https://ap2-protocol.org/ap2/security_and_privacy_considerations/)

A control that lives inside the attacker's own boundary is not a control for this MUST.

That same sentence is why **caller identity is a signed artifact too**. Reading `userId` off the
request body would make the Credential Provider's answer to *"list this user's payment methods"* a
function of whatever the agent sent. Instead the BFF mints a short-lived JWS naming the `sub` the
Cognito authorizer verified, signed with a KMS key it alone holds `kms:Sign` on; the Merchant, the
consent surface and the CP verify it, read the user out of it, and refuse a call that arrives without
one. There is no fallback to a body field — a fallback would reopen the hole.

**How it is arranged.** `submit_consent_decision` runs in
[`consent-decision.ts`](../ap2-core/src/handlers/consent-decision.ts) on a function of its own:

- It is the **only** principal in the deployment granted `kms:Sign` on the Consent key.
- Its Function URL is granted to the checkout Lambda alone — the Trusted Surface that ran the step-up
  and built the `ConsentProof`. That grant appears once, in `bff-stack.ts`; the agent stack has no
  equivalent line.
- [`consent-mandates.ts`](../ap2-core/src/handlers/consent-mandates.ts), the function the agent *does*
  call, holds **no KMS grant at all**. Full control of it mints nothing.

Four assertions in `infra/src/__tests__/stacks.test.ts` pin this: the session function has zero
`kms:` actions, the decision function is the only consent signer, the two operations sit behind two
Function URLs, and the agent stack never references the decision URL.

Both halves of the MUST now hold: the Agent can neither access the signing key nor cause it to be
used without the Trusted Surface.

### 2.3 The chain-verification MUSTs — **met**

[Security and privacy considerations](https://ap2-protocol.org/ap2/security_and_privacy_considerations/)
carries five requirements on who must check what before money moves. Each is enforced in deterministic
code, by the role the specification names, independently of every other role:

| MUST | Where |
|---|---|
| *"Merchant MUST verify that `checkout_hash` matches the hash of the **latest** `checkout_jwt`"* | `merchant.ts` fetches the cart by `journeyId` from its own repository and compares `checkoutJwtHash(latest)` against the mandate's hash. The cart is never accepted from the agent, and *latest* is literal — a re-priced cart invalidates an earlier approval |
| *"The Merchant Payment Processor **and** Credential Provider MUST verify the User's signature on the Payment Mandate"* | `credential-provider.ts` at issuance, `mpp.ts` step 4 after the redeem — two independent verifications |
| *"The Payment Credential/Token MUST ONLY be released … upon receipt and verification"* | `cp.redeem` checks the signature, the expiry, the authorized MPP and single-use **before** returning any PSP reference |
| *"The Payment Mandate MUST contain a reference to its associated Checkout"* | `transaction_id`, a visible signed claim holding the `checkout_jwt` hash |
| *"Selective Disclosure MUST be used to preserve user privacy"* | Both user-signed mandates are SD-JWT-VCs |

One further MUST does **not** apply, which is what makes D2 below a correct reading rather than a
gap: *"Closed Mandates MUST contain the `sd_hash` claim to bind them to the presented **open**
Mandate."* There is no open mandate in this flow, so there is nothing for an `sd_hash` to bind to.

### 2.4 Salt entropy — **met**

> *"Digests in SD-JWTs MUST include a salt with sufficient entropy to prevent guessing"* — mitigating
> *"rainbow table attacks on digests"* with *"cryptographic salts with sufficient entropy per RFC9901"*.

RFC 9901 §9.3 puts a number on "sufficient": *"The RECOMMENDED minimum length of the randomly
generated portion of the salt is 128 bits."* Every disclosure emitted here carries exactly that.

It has to be requested explicitly. The library's default yields **64** bits: `@sd-jwt/core` calls
`saltGenerator(16)` meaning 16 *characters*, and `@sd-jwt/crypto-nodejs` implements that as
`randomBytes(length).toString('hex').substring(0, length)` — drawing 128 bits and discarding half.
`sdjwt.ts` passes `SALT_HEX_CHARS = 32`, and `sdjwt.test.ts` asserts the emitted length and per-claim
uniqueness, so a dependency bump cannot quietly halve it.

---

## 3. Documented divergences

Each of these is a deliberate choice with a known upgrade path — not an oversight.

### Structural

#### D1 — Consent signs as the **Trusted Agent Provider**

AP2 defines two delegation models, both normative: **User Credential** (an external issuer, presented
over OpenID4VP) and **Trusted Agent Provider** (the agent's own provider holds a signing key and
signs after its Trusted Surface obtains consent).

This stack is the second one, and the specification's own human-present flow says so directly:

> *"The Trusted Surface uses `user_sk` to sign and create the Payment Mandate and Checkout Mandate.
> — **The `user_sk` would be the Agent Provider's key in the Trusted Agent Provider model.**"*
> — [Flows §Human Present](https://ap2-protocol.org/ap2/flows/)

So the Consent entity's KMS key **is** `user_sk` here, by the book. A mandate proves *the trusted
surface obtained consent and signed* — which under this model is what a mandate is supposed to prove,
not a weaker substitute for something else.

What is genuinely missing is the *other* half of the model: a verifier is supposed to trust the Agent
Provider through a trust list, and nothing here establishes the Consent key as such. `iss` is the
bare string `consent` rather than a provider identity, and there is no published trust anchor. Inside
one deployment that is fine, because the MPP holds `kms:Verify` on the key directly. Across
organizations it would not be.

Moving to the **User Credential** model — OpenID4VP plus the Digital Credentials API, with a
DPC-style credential — is the upgrade path for higher assurance. Note that the specification lists a
directly trusted user key, *"such as a passkey or hardware-attested key"*, only under **future**
models to be explored; it is not the current normative route.

#### D2 — No `cnf` claim and no key-binding JWT

Largely by design rather than by omission. `cnf` is *"**OPTIONAL**. (…) **REQUIRED if the Mandate is still open**"*, and key binding exists so an
**open** mandate can be bound to a transaction the agent closes later. A human-present closed mandate
is signed directly and validated *"using a User Credential or a trust list of Agent Providers"*.

So for this flow, the absence of `cnf` and a KB-JWT is expected. What the verifiers still compensate
for is presentation replay — the same mandate cannot be presented to the same verifier twice — which
matters here precisely because there is no key binding to prove possession.

This becomes a real gap the moment the autonomous framework is added (D6), where key binding is a MUST.

#### D3 — The BFF orchestrates settlement, not the agent

The specification's human-present flow has the Trusted Surface hand the signed mandates **back to the
Shopping Agent**, which then drives the Credential Provider and the Merchant:

> *"4. The Trusted Surface passes the Mandates back to the Shopping Agent. 5. The Shopping Agent
> passes the Payment Mandate to the Credential Provider… 6. The Shopping Agent sends this token and
> the Checkout Mandate to the Merchant."*

Here the mandates never return to the agent. The BFF holds them and drives CP → Merchant → MPP
itself; the agent learns the outcome as a system event.

A signed artifact that never enters the model's context cannot be reformatted, leaked or replayed by
anything a prompt talks the agent into. The payloads each party receives are unchanged, so every
verification still happens at the same hop; only the courier differs.

The specification is in tension with itself here — the flows page makes the agent the courier for
signed mandates, the security page says *"All LLMs and Agents MUST be considered potential
attackers."* This resolves it on the safe side.

### Serialization

#### D4 — Mandate content is not wrapped in `delegate_payload`

AP2 serializes every mandate — root tokens included, human-present included — with the mandate
content inside a `delegate_payload` array as a disclosure, so one resolver handles both root tokens
and delegation hops. The upstream SDK is explicit:

> *"The claim is wrapped under `delegate_payload` so the same resolver logic works for both root
> tokens and KB-SD-JWT[+KB] hops. No `sd_hash`, `iat`, `aud`, or `nonce` is injected — those belong
> on KB-SD-JWTs."* — `ap2/sdk/sdjwt/sd_jwt.py`

The upstream shape is therefore an outer credential (`iss`, its own `vct`, `_sd_alg`,
`delegate_payload: [<digest>]`) with the AP2 mandate — carrying `vct: mandate.checkout.1` — as a
disclosure inside it.

This stack emits the mandate claims **flat on the issuer payload**, with `vct` at the top level and no
`delegate_payload`, and additionally places `aud` and `nonce` on the issued token where upstream puts
them on the KB-SD-JWT at presentation time. The consequence is concrete: an independent AP2
implementation following v0.2 cannot parse these mandates, and audience is fixed at issuance rather
than scoped per presentation.

This is the single largest interoperability gap in the stack, and closing it is mechanical — the
signing and verifying logic is unchanged, only the envelope moves.

#### D5 — Selective disclosure beyond what the schemas mark

Upstream marks exactly one field as selectively disclosable: `checkout_jwt`, on the Checkout Mandate.
**No field of the Payment Mandate is marked disclosable**, and `payment_instrument` is `required`.

This stack additionally makes `payment_instrument`, `risk_data` and `consent_proof` disclosures on the
Payment Mandate. Nothing breaks today, because every presentation carries all disclosures and the
decoded claim set therefore validates — but the capability, if exercised, would produce a mandate
missing a required field. Treat the extra disclosability as a local extension, not as a
privacy feature to lean on.

The `checkout_jwt` disclosure matches upstream exactly.

### Scope

#### D6 — Human-present only

The Cart Mandate flow is implemented. The **open mandate** framework — the human-not-present case,
where a user approves constraints and the agent later signs a closed mandate under a `cnf`-endorsed
key — is not built, and with it the `*.open.*` `vct` variants, the constraint types
(`checkout.line_items`, `checkout.allowed_merchants`, `payment.amount_range`, …) and the
`unresolved_constraint` error code.

Worth knowing: `unresolved_constraint` is not purely an autonomous-mode concern. The specification
uses it as the **downgrade signal** — *"A Human Not Present flow can be turned into a Human Present
flow by the Merchant… returning an `unresolved_constraint` error and bringing the User back into the
loop."* Nothing here emits it, because nothing here can be in the autonomous state it downgrades from.

Generation 1's `IntentMandate` is defined as a type and never emitted. The cards sample still uses it
in human-present *"to maintain consistency across Human-Present and Human-Not-Present flows"*; v0.2
dropped it, so not emitting it is alignment with the specification rather than a gap.

#### D7 — A bespoke merchant API, not the Universal Commerce Protocol

The `checkout_jwt` payload is this repository's `CartContents` (W3C `PaymentRequest`-shaped) rather
than a UCP `Checkout` object, and the merchant exposes operations rather than UCP catalog and checkout
endpoints. AP2 is explicitly agnostic to the contents of the merchant-signed Checkout JWT, so this is
an extension point rather than a violation. The Payment Mandate does use the specification's current
common types: an integer `Amount`, a `Merchant` with a stable id, and a `PaymentInstrument` reference.

#### D8 — Native SigV4 transport, not A2A or MCP

Entities talk over SigV4-signed Lambda Function URLs. The canonical AP2 transport rides A2A and MCP.
The signed artifacts are identical either way — only the envelope differs — so this is a transport
substitution rather than a protocol one. The AgentCore Gateway is the natural next step: each tool
becomes a Gateway target and the agent stops signing its own requests.

#### D9 — The payment processor is simulated

`SimulatedPsp` authorizes at or below a ceiling and declines above it, which is what makes the decline
path testable without a network call. Swapping in a real processor is a change behind the
`PspGateway` port and nowhere else.

There is also no **issuer** here, and that is worth naming: in the reference sample the one-time code
is an *issuer* challenge raised at the payment processor — *"This challenge would normally be raised
by the issuer, but we don't have an issuer in the demo"* — a 3-D Secure-shaped step at settlement
time, entirely separate from signing the mandate. This stack has no issuer to raise one, so its
one-time code sits at the consent surface instead, as an input to the attestation. Those are different
controls at different layers; a production deployment would have both.

#### D10 — Receipt shape deltas

Validating the emitted receipts against the **upstream** `payment_receipt.json` surfaces two:

- On `status: "Success"`, the schema's `oneOf` requires `network_confirmation_id`; this stack does not
  emit one, having no network. Upstream is internally inconsistent here — the rendered field table
  lists it as optional while the schema requires it on success — so this is a divergence against the
  machine-readable artifact rather than a clean defect.
- On a **PSP decline** this stack emits `status: "Error"` with an `error_description` but no `error`
  code, on the reasoning that a decline is not a mandate fault. The schema requires `error` whenever
  the status is `Error`. This one is unambiguous, and is a defect rather than a divergence.

The Checkout Mandate, the Payment Mandate and the Checkout Receipt all validate clean against the
upstream schemas.

---

## 4. Not built

- **Network-level 3-D Secure / strong customer authentication**, and no issuer to raise it (D9).
- **A real step-up channel.** The one-time code is delivered by SMS to a `phone_number` claim the user
  pool does not collect, or revealed in the response under a sandbox flag. The gate refuses rather
  than opening a code field nobody can fill, and the signed attestation names which channel actually
  carried the code — but neither is proof of possession.
- **Role distribution.** One organization runs the Merchant, the CP and the MPP here. Distinct keys,
  functions and IAM roles preserve the auditability the separation exists for, but they are not
  separate operators.
- **Dispute resolution as a flow.** The evidence needed for one is retained — including the full
  SD-JWT presentations with their disclosures — but nothing consumes it. Note that the specification's
  dispute procedure computes a receipt's `reference` *"in the same manner as the `sd_hash`"*, over the
  presentation; this stack hashes the issuer-JWT segment alone, so the value is stable when a
  disclosure is withheld but will not match a verifier following that procedure.
- **Key rotation.** The signing keys are asymmetric and cannot be rotated automatically by KMS.
  Rotating them means issuing new keys and keeping the old public halves available, since every
  artifact ever signed must remain verifiable.

---

## 5. Production gaps

Beyond conformance, these would need addressing before real money. The full list, with severities and
evidence, is in [`assessment.md`](assessments/assessment.md).

- The catalog and cart-by-journey lookups scan rather than query; the intents table has the two
  indexes it needs, the merchant tables have none.
- No WAF sits in front of the API or the distribution.
- Cognito runs without MFA, without a strict password policy, and without threat protection.

---

## 6. Sources

Read against the specification as published at the time of writing; `v0.2` is a draft and will move.

- [AP2 specification v0.2](https://ap2-protocol.org/ap2/specification/) ·
  [Agent Authorization](https://ap2-protocol.org/ap2/agent_authorization/) ·
  [Flows](https://ap2-protocol.org/ap2/flows/)
- [Checkout Mandate](https://ap2-protocol.org/ap2/checkout_mandate/) ·
  [Payment Mandate](https://ap2-protocol.org/ap2/payment_mandate/)
- [Security and privacy considerations](https://ap2-protocol.org/ap2/security_and_privacy_considerations/)
- The reference implementation: [github.com/google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2)
  — canonical JSON Schemas at `code/sdk/schemas/ap2/`, the generation 2 SDK at `code/sdk/python/ap2/sdk/`
- RFC 9901 (SD-JWT) · RFC 8785 (JCS) · RFC 7800 (`cnf`) ·
  [Delegate SD-JWT](https://github.com/GarethCOliver/gco-delegate-sd-jwt) (`delegate_payload`)
