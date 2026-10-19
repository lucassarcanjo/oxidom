import { test, expect } from 'vitest';

test('trivial 6', () => {
  expect(typeof document.createElement('div')).toBe('object');
});
