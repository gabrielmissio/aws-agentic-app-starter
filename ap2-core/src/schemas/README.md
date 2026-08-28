# AP2 JSON Schemas

JSON Schema (draft 2020-12) for the AP2 artifacts this stack emits, hand-authored from
github.com/google-agentic-commerce/AP2 — originally from the generation 1 Python models
(`code/sdk/python/ap2/models/`), before upstream published canonical schemas at
`code/sdk/schemas/ap2/`.

`../__tests__/ap2-conformance.test.ts` validates the mandates a real run of the chain produces
against these schemas. A reviewer can also paste any `merchant_authorization` into jwt.io and read
the `cart_hash` claim for themselves.

**Two limits worth stating.** These schemas are *ours*, hand-authored from the older Python models —
so they catch drift from our reading of the specification, not divergence from the specification
itself. And there are **no receipt schemas here**, so the two artifacts a user actually receives are
the two nothing validates. The canonical schemas live upstream at `code/sdk/schemas/ap2/`; validating
against those surfaces two receipt deltas, recorded as D10 in `docs/ap2-conformance.md`. Vendoring
them is the fix.

Two of the schemas describe a *decoded claim set* rather than a wire format: the Checkout and Payment
Mandates are serialized SD-JWT-VC strings, so what gets validated is the issuer-JWT payload merged
with its disclosures.
