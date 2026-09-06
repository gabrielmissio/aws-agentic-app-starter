# Security policy

This template deploys authentication, IAM grants, a transport boundary and an optional content
guardrail. A flaw in any of those is inherited by everyone who deploys it, so please report one
privately rather than in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
**[Security → Report a vulnerability](https://github.com/gabrielmissio/aws-agentic-app-starter/security/advisories/new)**.
It opens a private advisory visible only to you and the maintainers.

Please include the commit you tested, your `DEPLOY_PROFILE`, and what an attacker gains — a
too-broad IAM grant matters differently under `demo` than under `prod`. A synthesized template
excerpt or a failing test is worth more than a description.

Expect an acknowledgement within a week. If a report is confirmed, the fix and the advisory are
published together, crediting you unless you'd rather stay anonymous.

Do not open a public issue, and do not test against infrastructure you do not own. Deployments of
this template belong to whoever deployed them, not to this project.

## What is in scope

The template's own code and configuration:

* The deployment-profile gate in `infra/src/config.ts` — a sandbox default that a `pilot` or `prod`
  synth accepts anyway is a vulnerability in the gate
* IAM grants in `infra/src/stacks/` that are broader than the resource they exist for
* The transport boundary — anything that lets a browser reach the AgentCore runtime without passing
  through the BFF, or that lets a caller act as another user
* Identity handling: session ids not bound to the authenticated caller, or `actorId` isolation in
  AgentCore Memory failing to hold
* Per-caller rate limiting, the admin routes, and the Cognito configuration
* Secrets or account identifiers committed to the repository

## What is not in scope

* **Your deployment.** Its configuration, its data and its AWS account are yours.
* **AWS service vulnerabilities.** Report those to
  [AWS Security](https://aws.amazon.com/security/vulnerability-reporting/).
* **The documented `demo` defaults.** `ALLOWED_ORIGIN="*"`, `WAF_ENABLED` off, no guardrail and no
  MFA are deliberate sandbox conveniences, each one named in `infra/.env.example` and each one
  refused by the gate under `pilot` and `prod`. A default the gate already refuses is a design
  decision, not a finding. A default it *fails* to refuse is.
* **What this template leaves open**, as listed in the root [README](README.md#what-this-template-leaves-open) —
  no data layer, `networkMode: 'PUBLIC'` on the runtime, no CD pipeline. Those are stated gaps, and
  a better answer to any of them is welcome as a pull request rather than an advisory.

## Supported versions

There are no releases yet. `main` is the only supported line, and fixes land there.

This software is provided under the [MIT License](LICENSE), without warranty of any kind. A security
policy is a commitment to handle reports responsibly; it is not a warranty that the template is
secure in your environment. Reviewing what you deploy remains yours.
