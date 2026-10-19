// Fixture for test/native/workers.test.mjs (Vitest pool: 'threads' smoke run; not part of the main suite).
import { test, expect } from 'vitest';
import { createRequire } from 'node:module';

test('file 3 loads rsdom in a fresh worker thread', () => {
  const { createWindow } = createRequire(import.meta.url)('../../../lib/index.cjs');
  const { document } = createWindow();
  document.body.innerHTML = '<p>hi 3</p>';
  expect(document.body.textContent).toBe('hi 3');
});
