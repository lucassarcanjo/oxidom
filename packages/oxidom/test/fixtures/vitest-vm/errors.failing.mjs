// Run on its own by test/native/vitest-env.test.mjs: an error thrown by an event listener fails the run.
import { test } from 'vitest';

test('listener error', () => {
  const b = document.createElement('button');
  b.addEventListener('click', () => {
    throw new Error('listener boom');
  });
  b.click();
});
