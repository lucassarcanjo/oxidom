// oxidom-only shadow-root protocols (lib/shadow.cjs, src/shadow.rs, DESIGN §22): the SHADOW meta bit on a shadow
// root and its host (Element.shadowRoot reads it with no native call on other elements), wrapper identity of
// shadow roots, the env-generation guard on Document.activeElement's retarget walk across rt.reset(), and the
// CONNECTED / id-map split (connected shadow trees are not in the document's id map).
import { createRequire } from 'node:module';
import { describe, it, expect, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

afterAll(() => {
  rt.reset();
});

const meta = (n) => rt.V.T[rt.V.off(n._i) + rt.F.META];

describe('shadow root (oxidom protocols)', () => {
  it('the SHADOW bit marks the root and its host; shadowRoot on other elements makes no native call', () => {
    const { document } = createWindow();
    const host = document.body.appendChild(document.createElement('div'));
    const other = document.body.appendChild(document.createElement('div'));
    const root = host.attachShadow({ mode: 'closed' });
    expect(meta(root) & rt.M.SHADOW).not.toBe(0);
    expect(meta(root) & rt.M.KIND).toBe(11);
    expect(meta(host) & rt.M.SHADOW).not.toBe(0);
    expect(meta(other) & rt.M.SHADOW).toBe(0);
    expect(meta(root) & rt.M.CONNECTED).not.toBe(0);
    const native = rt.N.shadowRootOf;
    let calls = 0;
    rt.N.shadowRootOf = (...a) => { calls++; return native(...a); };
    try {
      expect(other.shadowRoot).toBe(null);
      expect(calls).toBe(0);
      expect(host.shadowRoot).toBe(null); // closed
      expect(calls).toBe(1);
    } finally {
      rt.N.shadowRootOf = native;
    }
    // one wrapper per shadow root, also when reached through a child
    const child = root.appendChild(document.createElement('span'));
    expect(child.parentNode).toBe(root);
    expect(child.getRootNode()).toBe(root);
    expect(rt.N.shadowHost(root._i)).toBe(host._i);
  });

  it('a connected shadow tree is not in the document id map', () => {
    const { document } = createWindow();
    const host = document.body.appendChild(document.createElement('div'));
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p id="dup"></p>';
    const light = document.body.appendChild(document.createElement('p'));
    light.id = 'dup';
    expect(document.getElementById('dup')).toBe(light);
    expect(document.querySelector('#dup')).toBe(light);
    expect(root.getElementById('dup')).toBe(root.firstChild);
    light.remove();
    expect(document.getElementById('dup')).toBe(null);
  });

  it('activeElement retargets in every env, before and after a reset', () => {
    for (let round = 0; round < 2; round++) {
      rt.reset();
      const { document } = createWindow();
      const plain = document.body.appendChild(document.createElement('input'));
      plain.focus();
      expect(document.activeElement).toBe(plain);
      const host = document.body.appendChild(document.createElement('div'));
      const input = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('input'));
      input.focus();
      expect(document.activeElement).toBe(host);
    }
  });
});
