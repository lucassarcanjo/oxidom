import { test, expect } from 'vitest';

test('trivial 1', () => {
  expect(typeof document.createElement('div')).toBe('object');
});
