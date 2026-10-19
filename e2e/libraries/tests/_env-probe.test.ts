// Records which documented shims tests/setup.ts had to install in this DOM, plus a
// few feature facts. Writes results/raw/probe-<env>-<mode>.json. Always passes.
import fs from 'node:fs'
import path from 'node:path'
import { APIS } from '../apis.mjs'

test('environment probe', () => {
  const env = process.env.DOM_ENV ?? 'jsdom'
  const mode = process.env.LIBS_POLYFILLS === '0' ? 'nopolyfills' : 'polyfills'
  const out = {
    env,
    mode,
    polyfillsApplied: (globalThis as any).__libsPolyfillsApplied,
    userAgent: navigator.userAgent,
    // Availability of every census API in THIS environment, AFTER tests/setup.ts ran
    // (so in 'polyfills' mode a shimmed API reads as available; use the 'nopolyfills' probe for native).
    apis: Object.fromEntries(APIS.filter((a) => a.probe).map((a) => {
      try { return [a.id, Boolean(new Function(`return (${a.probe})`)())] } catch (e: any) { return [a.id, false] }
    })),
  }
  const dir = path.resolve(process.cwd(), 'results/raw')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `probe-${env}-${mode}.json`), JSON.stringify(out, null, 2))
  expect(true).toBe(true)
})
