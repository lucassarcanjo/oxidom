import { defineConfig } from 'vitest/config';

// Contract + native tests run in Vitest's `node` environment: every DOM is created explicitly through
// test/contract/adapter.cjs (`makeWindow('jsdom' | 'happy-dom' | 'oxidom')`), never through globals.
// OXIDOM_SHARED=0 runs the same suite through the crossing-getter fallback (npm run test:fallback).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,mjs,cjs}'],
    testTimeout: 20_000,
  },
});
