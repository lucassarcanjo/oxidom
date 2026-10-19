// Mirrors e2e/react-app/src/test/setup.ts: per-file cleanup registered from a setup file (re-imported for every file,
// also under isolate: false), here without React: empty the body after each test.
import { afterEach } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
});
