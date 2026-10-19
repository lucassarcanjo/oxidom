// rsdom-only style checks: fine-grained STYLE epoch rules (ROADMAP M6: aria-*/data-*/text writes never
// bump EP[STYLE]), computed-style memo transparency, the display:none ancestor helper, the style
// attribute / MutationObserver-visible write path, and a cold getComputedStyle sanity timing.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

const STYLE = () => rt.V.EP[rt.EPI.STYLE];

describe('style: STYLE epoch', () => {
  it('aria-*, data-*, title and text writes never bump EP[STYLE]', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<div id=x><span>t</span></div>';
    const x = document.getElementById('x');
    const t = x.firstChild.firstChild;
    const s0 = STYLE();
    x.setAttribute('aria-hidden', 'true');
    x.setAttribute('data-state', 'open');
    x.setAttribute('aria-label', 'l');
    x.setAttribute('title', 't');
    x.setAttribute('class', 'a'); // no author sheets: class writes are irrelevant
    x.id = 'y';
    t.data = 'changed';
    expect(STYLE()).toBe(s0);
  });

  it('style / hidden / type / open writes and child-list changes bump it', () => {
    const { document } = createWindow();
    const x = document.createElement('div');
    document.body.appendChild(x);
    for (const f of [
      () => x.setAttribute('hidden', ''),
      () => x.style.color = 'red',
      () => x.setAttribute('style', 'color: blue'),
      () => x.setAttribute('type', 'hidden'),
      () => x.setAttribute('open', ''),
      () => x.appendChild(document.createElement('p')),
    ]) {
      const s = STYLE();
      f();
      expect(STYLE()).not.toBe(s);
    }
  });

  it('with author sheets, class / id and selected attributes bump it; EP[13] tracks state selectors', () => {
    const { document } = createWindow();
    document.head.innerHTML = '<style>.on { display: none } [data-x] { visibility: hidden }</style>';
    document.body.innerHTML = '<div id=x></div>';
    const x = document.getElementById('x');
    rt.getComputedStyle(x); // parses the sheet
    let s = STYLE();
    x.className = 'on';
    expect(STYLE()).not.toBe(s);
    s = STYLE();
    x.setAttribute('data-x', '1');
    expect(STYLE()).not.toBe(s);
    s = STYLE();
    x.setAttribute('data-y', '1');
    expect(STYLE()).toBe(s);
    expect(rt.V.EP[13]).toBe(0);
    document.head.firstChild.textContent = 'input:checked { display: none }';
    rt.getComputedStyle(x);
    expect(rt.V.EP[13]).toBe(1);
  });
});

describe('style: memo transparency and helpers', () => {
  it('memoised core equals a fresh computation across mutations', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<section><div id=a><p id=b hidden>x</p><span id=c style="visibility:hidden">y</span></div></section>';
    const els = [...document.querySelectorAll('*')];
    const check = () => {
      for (const el of els) expect(rt.style.core(el)).toBe(rt.N.csCore(el._i));
    };
    check();
    document.getElementById('b').removeAttribute('hidden');
    check();
    document.getElementById('a').style.display = 'none';
    check();
    document.getElementById('c').remove();
    check();
  });

  it('csHidden: element or ancestor computes to display: none (area B focusability)', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<div id=o><p><button id=b>x</button></p></div><input id=h type=hidden>';
    const b = document.getElementById('b');
    expect(rt.N.csHidden(b._i)).toBe(false);
    document.getElementById('o').hidden = true;
    document.getElementById('o').setAttribute('hidden', '');
    expect(rt.N.csHidden(b._i)).toBe(true);
    expect(rt.N.csHidden(document.getElementById('h')._i)).toBe(true);
  });

  it('style writes go through the attribute path (attr_ver bump, one write per change)', () => {
    const { document } = createWindow();
    const x = document.createElement('div');
    const before = rt.field(x._i, rt.F.ATTR_VER);
    x.style.color = 'red';
    const v1 = rt.field(x._i, rt.F.ATTR_VER);
    expect(v1).not.toBe(before);
    x.style.color = 'red'; // unchanged serialization: no attribute write
    expect(rt.field(x._i, rt.F.ATTR_VER)).toBe(v1);
    x.style.color = 'notacolor'; // invalid: ignored
    expect(rt.field(x._i, rt.F.ATTR_VER)).toBe(v1);
  });

  it('cold getComputedStyle after a mutation stays in the low-microsecond range (sanity)', () => {
    const { document } = createWindow();
    let html = '';
    for (let i = 0; i < 50; i++) html += `<div class="row"><span>${i}</span><button>b</button></div>`;
    document.body.innerHTML = `<main><section>${html}</section></main>`;
    const els = [...document.querySelectorAll('button')];
    const host = document.body.firstChild;
    for (let i = 0; i < 200; i++) rt.getComputedStyle(els[i % els.length]).display; // warm-up
    const N = 2000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      host.setAttribute('style', i & 1 ? 'color: red' : 'color: blue'); // invalidates every memo
      void rt.getComputedStyle(els[i % els.length]).display;
    }
    const ns = Number(process.hrtime.bigint() - t0) / N;
    // Generous bound for a debug build on a shared 4-CPU VM; bench/micro/style.mjs measures release.
    expect(ns).toBeLessThan(200_000);
  });
});
