import { test, expect } from 'vitest';

test('trivial 5', () => {
  expect(typeof document.createElement('div')).toBe('object');
});
