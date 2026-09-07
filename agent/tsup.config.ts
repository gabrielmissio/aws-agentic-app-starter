import { defineConfig } from 'tsup'

export default defineConfig({
  // tsup silently ignores an entry that does not resolve, so a stale path here builds nothing and
  // fails nothing — keep this list matched to the files that actually exist.
  // Two entries, and the second is not optional. `instrumentation.ts` patches the AWS SDK by
  // intercepting module loading, so it has to finish before any SDK client is resolved — and inside
  // a bundle it cannot: ESM evaluates every static import before the first line of module body runs,
  // so a bundled `import './instrumentation'` registers *after* the SDK is already loaded. Measured:
  // that arrangement produces zero spans. Built separately, it is preloaded with `node --import`
  // (see the `start` script), which runs it to completion before `index.js` is even resolved.
  entry: ['src/index.ts', 'src/instrumentation.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
})
