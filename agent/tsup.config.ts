import { defineConfig } from 'tsup'

export default defineConfig({
  // tsup silently ignores an entry that does not resolve, so a stale path here builds nothing and
  // fails nothing — keep this list matched to the files that actually exist.
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
})
