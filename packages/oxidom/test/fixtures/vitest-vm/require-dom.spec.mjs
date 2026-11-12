// Test code may load the DOM library itself (a helper `new JSDOM()`): the window the environment installed keeps
// working.
import { test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// jsdom 30 itself cannot be loaded in a VM pool (ESM dependencies): the oracle run only checks the document
const lib = process.env.VITEST_DOM === 'jsdom' ? null : 'oxidom';

test('a JSDOM made in a test leaves the environment document alone', () => {
  document.body.innerHTML = '<p id=g>global</p>';
  if (lib !== null) expect(new (require(lib).JSDOM)('<p>helper</p>').window.document.querySelector('p').textContent).toBe('helper');
  expect(document.getElementById('g').textContent).toBe('global');
});

test('...and so does an import of it', async () => {
  if (lib !== null) expect(new (await import(lib)).JSDOM('<p>helper</p>').window.document.querySelector('p').textContent).toBe('helper');
  expect(document.getElementById('g').textContent).toBe('global');
});
