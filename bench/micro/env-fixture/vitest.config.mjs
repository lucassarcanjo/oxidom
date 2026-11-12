// Fixture for the `env-vitest` micro case: 6 trivial files, so the per-file `environment` phase that Vitest
// reports is dominated by the DOM environment's import + setup. DOM_ENV selects the environment.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV = {
  jsdom: 'jsdom',
  'happy-dom': 'happy-dom',
  oxidom: path.resolve(here, '../../../packages/oxidom/lib/vitest-environment.mjs'),
};
const env = ENV[process.env.DOM_ENV ?? 'jsdom'];
if (!env) throw new Error(`unknown DOM_ENV ${process.env.DOM_ENV}`);

export default defineConfig({
  root: here,
  cacheDir: path.join(here, '.vite'),
  test: { environment: env, include: ['t/*.test.js'] },
});
