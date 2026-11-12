import { test, expect } from 'vitest';

test('every file starts from a fresh document', () => {
  expect(document.body.innerHTML).toBe('');
  document.body.innerHTML = '<p>left behind</p>';
});
