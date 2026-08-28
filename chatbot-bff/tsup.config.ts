import { defineConfig } from 'tsup'

/**
 * One bundle per handler, each self-contained.
 *
 * `BffStack` ships this package with `node_modules` excluded, so anything left external has to be
 * something the managed Node runtime happens to provide. `noExternal` removes that bet entirely:
 * every import is bundled, so nothing resolves to nothing at cold start, and the SDK version that
 * runs is the one these handlers were tested against rather than whatever AWS ships this month.
 */
export default defineConfig({
  entry: ['src/handler.ts', 'src/admin-handler.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
})
