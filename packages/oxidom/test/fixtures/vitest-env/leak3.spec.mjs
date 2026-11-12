// isolate: false: files share one DOM per worker; the setup file's afterEach cleanup keeps them apart.
import { test, expect } from 'vitest';

test('leak 3: starts from an empty body and leaves nodes behind for cleanup', () => {
  expect(document.body.childNodes.length).toBe(0);
  expect(document.getElementById('from-leak1')).toBe(null);
  expect(document.getElementById('from-leak2')).toBe(null);
  document.body.innerHTML = '<div id="from-leak3">x</div>';
});
