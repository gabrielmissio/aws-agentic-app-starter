/**
 * Runs cdk-nag's `AwsSolutionsChecks` over the synthesized app and writes the result as JSON.
 *
 * **Report-only, and that is the design rather than a first step someone forgot to finish.** The pack
 * reports 44 findings in CI and 53 against a fully configured `.env`, and roughly a third of either
 * number is on constructs CDK generates for itself — the bucket deployment behind `s3-deployment`, the custom-resource Lambdas behind log-group
 * governance. Turning this into a gate means writing a suppression for every one of them first, and a
 * template whose forks inherit fifty pre-accepted exceptions has made the suppression list worthless:
 * it stops reading as "decisions we took" and starts reading as "noise that came with the template".
 *
 * What a report is worth without a single suppression written is the *delta*. A pull request that
 * takes the count from 53 to 55 has added two, and the summary says which rule and which resource.
 * That question is answerable today; "is the list empty" is not, and would not be for a long time.
 *
 * Deliberately a separate entry point rather than a flag inside `app.ts`. `cdk.json` still runs
 * `src/app.ts`, so `cdk synth` and `cdk deploy` cannot load cdk-nag at all — the deploy path is
 * unchanged, and the dependency stays a development one in every sense.
 *
 * `validateScope` rather than `Validations.of(app).addPlugins(...)`: the plugin route reports through
 * the CLI's own output, which is prose on stderr and would have to be parsed back. This returns the
 * `PolicyValidationPluginReport` directly. Both were run against this app and agree — 53 findings —
 * so the structured path costs nothing in fidelity.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AwsSolutionsChecks } from 'cdk-nag'
import { app } from './app.js'

/**
 * Beside the templates it describes, and already ignored by git for the same reason they are.
 *
 * Relative to the working directory rather than `app.outdir`, which is only `cdk.out` when the CDK
 * CLI sets `CDK_OUTDIR`. Run directly — which is the whole point of this entry — the App picks a
 * temporary directory, and the report would land somewhere nothing could collect it from.
 */
const OUTPUT = join('cdk.out', 'cdk-nag.json')

const report = new AwsSolutionsChecks(app, { verbose: true }).validateScope(app)
const findings = report.violations.reduce((total, v) => total + v.violatingResources.length, 0)

/**
 * The variables that decide which resources exist at all — and therefore what the finding count even
 * means. Two reports are comparable only when this matches; the count alone is not a number.
 *
 * `DEPLOY_PROFILE` is not enough on its own, and assuming it was is a mistake this stamp exists to
 * correct. CI has no `.env`, so it scans `demo`; a developer's `.env` also usually says `demo` while
 * switching WAF, the guardrail and observability on. Measured: 53 findings here against 44 in CI, both
 * of them "demo". A label that claims two runs are comparable when they describe different stacks is
 * worse than no label.
 *
 * Recorded raw rather than through `config.ts`, deliberately: this is a description of the inputs, so
 * it should report what was actually set, including a value the gate would go on to reject.
 */
const POSTURE = [
  'DEPLOY_PROFILE',
  'WAF_ENABLED',
  'GUARDRAIL_ENABLED',
  'TRACING_ENABLED',
  'AGENT_OBSERVABILITY_ENABLED',
  'COGNITO_MFA',
  'COGNITO_THREAT_PROTECTION',
  'PUBLIC_SIGNUP_ENABLED',
  'RETAIN_DATA',
  'ALERT_EMAIL',
  'MONTHLY_BUDGET_USD',
] as const

const posture = Object.fromEntries(
  POSTURE.map((name) => [
    name,
    // Presence, not the value: `ALERT_EMAIL` decides whether a subscription and a budget exist, and
    // the address itself is neither interesting here nor something to copy into a CI artifact.
    name === 'ALERT_EMAIL' || name === 'MONTHLY_BUDGET_USD'
      ? Boolean(process.env[name]?.trim())
      : process.env[name]?.trim() || null,
  ]),
)

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, JSON.stringify({ ...report, posture }, null, 2))

// stderr, so a caller redirecting stdout still gets a readable line, and the JSON stays the only
// thing on stdout should anyone pipe this instead of reading the file.
console.error(
  `cdk-nag: ${findings} finding(s) across ${report.violations.length} rule group(s) → ${OUTPUT}`,
)
