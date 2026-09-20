/**
 * Runs `preflight.ts` against the account the shell's credentials resolve to and prints the report.
 *
 *   npm run preflight                    # what a first `npm run deploy` needs
 *   npm run preflight -- --github-oidc   # and what deploy-on-merge needs on top
 *
 * The only file that spawns a process; everything it reports is decided in `preflight.ts`. Not
 * imported by `app.ts`, so `cdk synth` and `cdk deploy` cannot load it — like `nag.ts`, it is an
 * entry point of its own and the deploy path is unchanged.
 */
import { execFile } from 'node:child_process'
import { classifyFailure, exitCode, formatReport, runPreflight, type AwsCli } from './preflight.js'

const USAGE = `Usage: npm run preflight [-- --github-oidc]

Read-only. Checks the account behind your AWS credentials for what a first deploy needs but the
stacks cannot create: the CDK toolkit stack, CloudWatch Transaction Search, and Bedrock model
access. Prints the command that fixes each one it finds missing, and runs none of them.

  --github-oidc   also check what deploy-on-merge needs (see infra/bootstrap/README.md)
  -h, --help      this text

Reads infra/.env, like every other script here. Set AWS_PROFILE to choose the account.`

const args = process.argv.slice(2)

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

const unknown = args.filter((arg) => arg !== '--github-oidc')
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(' ')}\n\n${USAGE}`)
  process.exit(2)
}

/**
 * `execFile`, not `exec`: the arguments reach `aws` as an argv array and no shell parses them, so a
 * model id or Region read from the environment cannot become a command.
 */
const aws: AwsCli = (cliArgs) =>
  new Promise((resolve) => {
    execFile(
      'aws',
      cliArgs,
      // A pager on a pipe is a hang; the CLI only starts one on a TTY, and this says so twice.
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '' } },
      (error, stdout, stderr) => {
        if (!error) {
          // `aws --version` is the one answer v1 wrote to stderr.
          resolve({ ok: true, output: stdout || stderr })
          return
        }
        const spawnCode = (error as NodeJS.ErrnoException).code
        resolve({
          ok: false,
          ...classifyFailure({ spawnCode: typeof spawnCode === 'string' ? spawnCode : undefined, stderr }),
        })
      },
    )
  })

const report = await runPreflight({ env: process.env, githubOidc: args.includes('--github-oidc') }, aws)

console.log(formatReport(report))
process.exitCode = exitCode(report)
