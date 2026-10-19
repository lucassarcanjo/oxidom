// rsdom-specific MutationObserver checks (behaviour parity lives in test/contract/mo.test.mjs): zero cost
// without observers, O(1) observe, one microtask and (observers with records + 1) crossings per delivery.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');
const mo = require('../../lib/mo.cjs');

const flush = () => new Promise((r) => setTimeout(r, 0));
const wrappers = () => rt.W.reduce((n, w) => n + (w !== undefined ? 1 : 0), 0);
const OBSERVED = rt.M.OBSERVED;

describe('MutationObserver (rsdom internals)', () => {
  it('no observers: no records, EP[MO_PENDING] stays 0, no delivery microtask', async () => {
    const { document } = createWindow();
    const before = { ...mo.stats };
    for (let i = 0; i < 100; i++) {
      const p = document.createElement('p');
      document.body.appendChild(p);
      p.setAttribute('title', String(i));
      p.textContent = 'x';
      p.remove();
    }
    expect(rt.V.EP[rt.EPI.MO_PENDING]).toBe(0);
    await flush();
    expect(mo.stats.ticks).toBe(before.ticks);
    expect(rt.N.moRegistrations()).toBe(0);
  });

  it('observe/disconnect are O(1): no subtree walk, no wrappers, one registration', () => {
    const { window, document } = createWindow();
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = '<ul>' + '<li><a href="#">x</a> y</li>'.repeat(1000) + '</ul>';
    const w0 = wrappers();
    const m = new window.MutationObserver(() => {});
    const before = rt.N.moRegistrations();
    m.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
    expect(rt.N.moRegistrations()).toBe(before + 1);
    expect(wrappers()).toBe(w0);
    expect(rt.field(host._i, rt.F.META) & OBSERVED).toBe(OBSERVED);
    m.disconnect();
    expect(rt.N.moRegistrations()).toBe(before);
    expect(rt.field(host._i, rt.F.META) & OBSERVED).toBe(0);
  });

  it('one microtask per burst; moTake crossings = observers with records + 1', async () => {
    const { window, document } = createWindow();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const got = [];
    const a = new window.MutationObserver((r) => got.push(['a', r.length]));
    const b = new window.MutationObserver((r) => got.push(['b', r.length]));
    const c = new window.MutationObserver((r) => got.push(['c', r.length]));
    a.observe(host, { childList: true, subtree: true });
    b.observe(host, { attributes: true });
    c.observe(document.head, { childList: true }); // registered, but gets no records
    const t0 = mo.stats.ticks;
    const k0 = mo.stats.takes;
    for (let i = 0; i < 50; i++) host.appendChild(document.createElement('i'));
    host.setAttribute('title', 'x');
    expect(rt.V.EP[rt.EPI.MO_PENDING]).toBe(1);
    await flush();
    expect(got).toEqual([['a', 50], ['b', 1]]);
    expect(mo.stats.ticks - t0).toBe(1);
    expect(mo.stats.takes - k0).toBe(3);
    expect(rt.V.EP[rt.EPI.MO_PENDING]).toBe(0);
    a.disconnect();
    b.disconnect();
    c.disconnect();
  });

  it('large records go through the OUT overflow protocol', async () => {
    const { window, document } = createWindow();
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = '<b></b>'.repeat(300_000);
    let removed = 0;
    const m = new window.MutationObserver((r) => {
      removed = r[0].removedNodes.length;
    });
    m.observe(host, { childList: true });
    host.textContent = '';
    await flush();
    expect(removed).toBe(300_000);
    m.disconnect();
  });

  it('reset drops observers and pending records', async () => {
    const { window, document } = createWindow();
    let calls = 0;
    const m = new window.MutationObserver(() => calls++);
    m.observe(document.body, { childList: true });
    document.body.appendChild(document.createElement('p'));
    rt.reset();
    expect(rt.N.moRegistrations()).toBe(0);
    await flush();
    expect(calls).toBe(0);
    const { document: d2 } = createWindow();
    d2.body.appendChild(d2.createElement('p'));
    expect(rt.V.EP[rt.EPI.MO_PENDING]).toBe(0);
  });
});
