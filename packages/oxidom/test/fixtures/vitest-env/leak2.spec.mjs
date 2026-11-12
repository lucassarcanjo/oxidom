// isolate: false: files share one DOM per worker; the setup file's afterEach cleanup keeps them apart.
import { test, expect } from 'vitest';

test('leak 2: starts from an empty body and leaves nodes behind for cleanup', () => {
  expect(document.body.childNodes.length).toBe(0);
  document.body.innerHTML = '<div id="from-leak2">x</div>';
});
