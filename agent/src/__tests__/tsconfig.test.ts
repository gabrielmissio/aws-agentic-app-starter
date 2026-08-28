import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * This package's `tsconfig.json` inlines the repo's base compiler options instead of `extends`-ing
 * `../tsconfig.base.json`.
 *
 * The reason is the container build. `infra/src/stacks/agent-stack.ts` points `DockerImageAsset` at
 * this package's own directory, so that's the entire build context — `../tsconfig.base.json` does
 * not exist inside it. With `extends`, every image build hit `Cannot find base config file` and
 * esbuild silently fell back to its own defaults, so the shipped bundle was compiled under
 * different settings than `npm run typecheck` verified locally.
 *
 * Inlining removes that failure but buys a drift risk, which is what this test exists to close: the
 * package must stay a superset of the repo base. It reads the root file directly, so a change there
 * fails here until this package is synced.
 */
const readJson = (relativePath: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')) as {
    compilerOptions: Record<string, unknown>
  }

describe('tsconfig.json', () => {
  const base = readJson('../../../tsconfig.base.json')
  const agent = readJson('../../tsconfig.json')

  it.each(Object.entries(base.compilerOptions))(
    'keeps the repo-wide %s option',
    (option, expected) => {
      expect(agent.compilerOptions[option]).toEqual(expected)
    },
  )

  it('does not extend a file that lives outside the Docker build context', () => {
    expect(agent).not.toHaveProperty('extends')
  })
})
