import { test, expect } from 'vitest';

test('trivial 2', () => {
  expect(typeof document.createElement('div')).toBe('object');
});
