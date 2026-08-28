import { defineConfig } from 'vitest/config'

/**
 * `environment: 'node'`, not `jsdom`: the current test suite covers `src/lib/` only — pure
 * functions and mocked SDK calls, no rendered React components — so there's nothing here that
 * needs a DOM. Component tests (testing-library + jsdom) are a deliberate follow-up, not an
 * oversight; adding them means adding that dependency and this config's `environment` too.
 */
export default defineConfig({ test: { environment: 'node' } })
