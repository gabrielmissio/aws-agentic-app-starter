import { defineConfig } from 'tsup'

/**
 * One bundle per entity handler, plus the post-deploy seed script.
 *
 * `noExternal` is set to a match-everything pattern, so every dependency is inlined — the AWS SDK
 * included. `Ap2EntitiesStack` points `lambda.Code.fromAsset` straight at this `dist/`, with no
 * `node_modules` alongside it, so anything left external would resolve at cold start only by
 * accident of what the managed runtime happens to ship. Inlining also pins the SDK version these
 * handlers were tested against instead of inheriting whatever the runtime rolls forward to.
 *
 * `.mjs` because the emitted ESM has to be loadable by a Lambda handler path
 * (`handlers/<entity>.handler`) without a `package.json` declaring `"type": "module"` next to it.
 */
export default defineConfig({
  entry: [
    'src/handlers/merchant.ts',
    'src/handlers/consent-mandates.ts',
    'src/handlers/consent-decision.ts',
    'src/handlers/credential-provider.ts',
    'src/handlers/mpp.ts',
    'src/handlers/evidence.ts',
    'src/seed.ts',
  ],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  bundle: true,
  clean: true,
  sourcemap: true,
  outExtension: () => ({ js: '.mjs' }),
  noExternal: [/.*/],
})
