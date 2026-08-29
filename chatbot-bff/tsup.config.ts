import { defineConfig } from 'tsup'

/**
 * One self-contained bundle per handler. `BffStack` ships this package with `node_modules` excluded,
 * so anything left external is a bet on what the managed runtime provides — one that fails at cold
 * start, and that pins the SDK to whatever AWS ships rather than what was tested.
 */
export default defineConfig({
  entry: ['src/handler.ts', 'src/admin-handler.ts', 'src/conversations-handler.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
})
