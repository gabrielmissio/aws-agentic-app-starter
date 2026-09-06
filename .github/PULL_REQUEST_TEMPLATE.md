## What changed

<!-- What this makes true, not what you touched. Link the issue if there is one. -->

## Why

<!-- What a fork gains. If this closes something in the README's "What this template leaves open",
     say so — that section should shrink in the same PR. -->

## What a fork inherits

<!-- Anything downstream picks up whether they read this or not: a new default, a new required
     environment variable, a widened IAM grant, a changed profile-gate rule, a new billed resource.
     "Nothing" is a perfectly good answer — write it rather than deleting the section. -->

## Checks

- [ ] `npm run verify` passes (lint, typecheck, test)
- [ ] `npm run audit` passes
- [ ] Tests cover the change — and a profile-gate change covers **both** directions: the value the
      gate accepts and the value it refuses
- [ ] A new or changed environment variable is documented in the relevant `.env.example`, with the
      reasoning: what it does, what it bills for, whether the gate refuses it
- [ ] A new or changed security property is asserted in `infra/`'s suite, not only described in a README
- [ ] Commits follow Conventional Commits and are written in English
