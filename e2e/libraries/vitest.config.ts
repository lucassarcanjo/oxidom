import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Real-world library compatibility suite.
 *
 *   DOM_ENV=jsdom|happy-dom|rsdom  npx vitest run
 *   LIBS_POLYFILLS=0               disables the documented test-setup shims (tests/setup.ts)
 *
 * Mirrors e2e/react-app/vitest.config.ts: the only variable between runs is the DOM environment.
 */
type DomEnv = 'jsdom' | 'happy-dom' | 'rsdom'

const RSDOM_ENVIRONMENT = fileURLToPath(
  new URL('../../packages/rsdom/lib/vitest-environment.mjs', import.meta.url),
)

const ENVIRONMENTS: Record<DomEnv, string> = {
  jsdom: 'jsdom',
  'happy-dom': 'happy-dom',
  rsdom: RSDOM_ENVIRONMENT,
}

const requested = (process.env.DOM_ENV ?? 'jsdom') as DomEnv
if (!(requested in ENVIRONMENTS)) {
  throw new Error(`Unknown DOM_ENV "${requested}"`)
}

export default defineConfig({
  test: {
    name: requested,
    environment: ENVIRONMENTS[requested],
    environmentOptions: {
      // Same URL for all three DOMs (react-router BrowserRouter, axios/msw relative URLs).
      jsdom: { url: 'http://localhost:3000/' },
      happyDOM: { url: 'http://localhost:3000/' },
      rsdom: { url: 'http://localhost:3000/' },
    },
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 10_000,
    // keep CPU use modest (shared machine)
    maxWorkers: 2,
  },
})
