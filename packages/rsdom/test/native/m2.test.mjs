// rsdom-specific M2 checks (behaviour parity lives in test/contract/parse-serialize.test.mjs).
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

const wrappers = () => rt.W.reduce((n, w) => n + (w !== undefined ? 1 : 0), 0);

describe('M2: parser integration', () => {
  it('parser inserts create no wrappers', () => {
    const { document } = createWindow();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const before = wrappers();
    host.innerHTML = '<table>' + '<tr><td><input><b>x</b></td></tr>'.repeat(200) + '</table>';
    expect(wrappers()).toBe(before);
    expect(host.innerHTML.length).toBeGreaterThan(1000); // serializing creates none either
    expect(wrappers()).toBe(before);
    expect(host.firstChild.tagName).toBe('TABLE'); // materialized on access only
    expect(wrappers()).toBe(before + 1);
  });

  it('dynamic atoms created by the parser reach the JS mirror lazily', () => {
    const { document } = createWindow();
    const host = document.createElement('div');
    host.innerHTML = '<never-seen-tag some-new-attr="v" class="fresh-class"></never-seen-tag>';
    const el = host.firstChild;
    expect(el.localName).toBe('never-seen-tag');
    expect(el.getAttribute('some-new-attr')).toBe('v');
    expect(el.getAttributeNames()).toEqual(['some-new-attr', 'class']);
    expect(el.constructor.name).toBe('HTMLElement');
  });

  it('table growth during a parse remaps the view (EP[GEN])', () => {
    rt.reset({ capacity: 64 });
    const { document } = createWindow();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const gen = rt.V.EP[rt.EPI.GEN];
    host.innerHTML = '<p>x</p>'.repeat(500);
    expect(rt.V.EP[rt.EPI.GEN]).toBeGreaterThan(gen);
    expect(host.childNodes.length).toBe(500);
    expect(host.lastChild.textContent).toBe('x');
    rt.reset();
  });
});
