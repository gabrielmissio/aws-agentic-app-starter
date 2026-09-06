# Contributing

Thanks for looking. This is a starter template, so the bar for a change is a little different from a
product's: prefer the option that leaves the next person's fork simpler, and be willing to state what
a default does *not* cover.

Found a security flaw? Don't open an issue — see [SECURITY.md](SECURITY.md).

## Setup

Node 22+ and npm 10+ (`.nvmrc` pins the major; `nvm use` picks it up). Docker with Buildx and AWS
credentials are needed only to deploy, never to run the checks below.

```bash
npm run bootstrap
```

**npm workspaces are not used here.** Each package installs independently, which is why `bootstrap`
runs `npm ci` in the root and in all four subpackages, and why `.github/dependabot.yml` names five
directories. Running `npm ci` in the root alone leaves the subpackages empty.

## The gate

```bash
npm run verify   # lint, typecheck, test — across every package
npm run audit    # npm audit --audit-level=high, every package
```

Both must pass before you open a pull request. CI runs exactly these two
(`.github/workflows/ci.yml`), so a green local run is a green CI run — neither needs AWS credentials,
Docker or a browser.

## Tests

Every package uses [vitest](https://vitest.dev) scoped to `environment: 'node'`. The root
[README's Testing section](README.md#testing) explains what each suite is *for*; two things worth
knowing before you add one:

* **`infra/` asserts security properties against the synthesized template** via
  `aws-cdk-lib/assertions`. A change to an IAM grant, the profile gate or an encryption setting
  belongs there, as an assertion — not only in a README line.
* **`AgentStack` is never synthesized**, because constructing it builds a real Docker image. Its
  invariants are asserted by reading the source instead. Add to that suite the same way.

A change to the deployment-profile gate (`infra/src/config.ts`) needs a test for both directions: the
value the gate accepts, and the value it refuses.

## Documentation is part of the change

The `.env.example` files are the primary reference for configuration, and they carry the *reasoning*,
not just the variable name — why a default is what it is, what it bills for, and whether the profile
gate refuses it. A new environment variable that arrives without that paragraph is an incomplete
change. The same goes for a new security property and the root README.

## Commits and branches

[Conventional Commits](https://www.conventionalcommits.org), which is what the history already uses:

```
feat(agent): …    fix(bff): …    docs(readme): …    chore(deps): …    build: …
```

Scope is the package (`agent`, `bff`, `infra`, `frontend`, `readme`) and is optional when a change is
genuinely repository-wide. Branches follow the same prefixes — `feat/pilot-enabler`,
`docs/update-readmes`.

Write the message in **English**, and describe what the change makes true rather than what you
touched.

## Pull requests

Open against `main`. In the description, say what changed and why, name any security property you
added, moved or relaxed, and call out anything a fork inherits — a new default, a widened grant, a
new required variable.

Small and focused beats large and complete. If a change turns out to need a design decision the
README does not already answer, open an issue first and let's agree on it before you write it.

## Scope

Good contributions here: closing something in
[What this template leaves open](README.md#what-this-template-leaves-open), tightening a grant,
covering an untested handler, correcting documentation that no longer matches the code.

Harder sell: a new feature in the example domain. The agent is a deliberately thin personal
assistant with two example tools — the value is the scaffolding around it, and every feature added to
the example is one more thing a fork has to delete.

**This applies to contributions back to this template, not to your fork.** Adapting the template to a
real domain means replacing the example wholesale — that is what it is for. [AGENTS.md](AGENTS.md)
draws that line for a coding agent.

## Licensing

By contributing, you agree your contribution is licensed under the [MIT License](LICENSE), the same
terms as the rest of the repository. There is no CLA.
