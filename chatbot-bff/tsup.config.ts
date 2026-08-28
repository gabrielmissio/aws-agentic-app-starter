import { defineConfig, type Options } from 'tsup'

const shared: Options = {
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
}

/**
 * Two builds, because the two kinds of handler need opposite bundling.
 *
 * `BffStack` ships this package with `node_modules` excluded. That works for the **admin** handler,
 * whose every import is an `@aws-sdk/*` client the managed runtime already provides. The AP2 handler
 * and the chat handler are not in that position: both pull in `ap2-core`, its JOSE and SD-JWT
 * dependencies and the JSON canonicalizer — none of which the runtime ships — so they carry them.
 *
 * The chat handler joined that group when caller identity became a signed artifact: it mints the
 * token the AP2 entities verify, which means `signJws` and the KMS ES256 signer, which means
 * `ap2-core`. Left external, those would resolve to nothing at cold start.
 */
export default defineConfig([
  {
    ...shared,
    entry: ['src/admin-handler.ts'],
    // Only the first config cleans: a second `clean` would delete what the first just emitted.
    clean: true,
  },
  {
    ...shared,
    entry: ['src/handler.ts', 'src/ap2-handler.ts'],
    // Self-contained, so nothing resolves at cold start by accident of what the runtime happens to
    // ship — and the SDK version is the one these handlers were tested against.
    noExternal: [/.*/],
  },
])
