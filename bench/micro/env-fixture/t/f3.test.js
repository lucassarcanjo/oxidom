import { test, expect } from 'vitest';

test('trivial 3', () => {
  expect(typeof document.createElement('div')).toBe('object');
});
