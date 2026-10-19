import { test, expect } from 'vitest';

test('trivial 4', () => {
  expect(typeof document.createElement('div')).toBe('object');
});
