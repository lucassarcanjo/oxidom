import { defineConfig } from 'vitest/config'

/**
 * DOM environment selection for the benchmark.
 *
 *   DOM_ENV=jsdom      npx vitest run   (default)
 *   DOM_ENV=happy-dom  npx vitest run
 *   DOM_ENV=rsdom      npx vitest run
 *
 * Everything else (pool, isolation, setup files, transforms) is identical across
 * environments so that the only variable in the end-to-end benchmark is the DOM.
 */
type DomEnv = 'jsdom' | 'happy-dom' | 'rsdom'

// rsdom is selected exactly like the builtin environments: Vitest resolves
// `environment: 'rsdom'` to the `vitest-environment-rsdom` package
// (packages/vitest-environment-rsdom, linked by the npm workspace), which
// re-exports `rsdom/vitest-environment`. Switching a project from jsdom to
// rsdom is that one-word change.
const ENVIRONMENTS: Record<DomEnv, string> = {
  jsdom: 'jsdom',
  'happy-dom': 'happy-dom',
  rsdom: 'rsdom',
}

const requested = (process.env.DOM_ENV ?? 'jsdom') as DomEnv
if (!(requested in ENVIRONMENTS)) {
  throw new Error(
    `Unknown DOM_ENV "${requested}". Expected one of: ${Object.keys(ENVIRONMENTS).join(', ')}`,
  )
}

export default defineConfig({
  test: {
    name: requested,
    environment: ENVIRONMENTS[requested],
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // React's act() + Testing Library can be slow on a cold JIT; keep the
    // default 5s but make it explicit since this suite doubles as a benchmark.
    testTimeout: 5_000,
  },
})
