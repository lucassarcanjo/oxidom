// oxidom-only selector checks: prefilter / memo transparency (ablation equivalence), zero-FFI prefilter
// misses, SEL cache bounds, memo validation and reset behaviour.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const ROLE_SELECTORS = fs.readFileSync(path.join(ROOT, '../../crates/oxidom/data/role-selectors.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const HTML = `<form name=f><input list=l type=email><input type=text><input><select multiple></select>
  <select size=2></select><select></select><button>b</button><a href="/x">a</a><a>n</a><img alt=""><img alt=y>
  <table><tr><th scope=col>h</th><td>d</td></tr></table><ul><li>i</li></ul><svg><a href="#"><circle/></a></svg>
  <section aria-label=s><h2>t</h2></section><textarea></textarea></form>`;

function withCounter(name, fn) {
  const orig = rt.N[name];
  let n = 0;
  rt.N[name] = (...a) => {
    n++;
    return orig(...a);
  };
  try {
    fn();
  } finally {
    rt.N[name] = orig;
  }
  return n;
}

describe('selectors: ablation transparency', () => {
  it('prefiltered matches() equals the raw Rust answer for every element x role selector', () => {
    const { document } = createWindow();
    document.body.innerHTML = HTML;
    const els = [...document.querySelectorAll('*')];
    const extra = ['a, button', 'input', 'svg a', 'a', 'circle', 'html', 'body > form', '*', 'li, td', 'A'];
    let mismatches = 0;
    for (const s of [...ROLE_SELECTORS, ...extra]) {
      const c = rt.select.sel(s);
      for (const el of els) {
        if (el.matches(s) !== rt.N.matches(el._i, c.id)) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('a prefilter miss makes no native call; tag-only lists answer in JS', () => {
    const { document } = createWindow();
    document.body.innerHTML = HTML;
    const td = document.querySelector('td');
    const li = document.querySelector('li');
    td.matches('input[type="email"]'); // compile first
    li.matches('a, li');
    const calls = withCounter('matches', () => {
      for (let i = 0; i < 100; i++) {
        expect(td.matches('input[type="email"]')).toBe(false);
        expect(li.matches('a, li')).toBe(true);
      }
    });
    expect(calls).toBe(rt.flags.PREFILTER ? 0 : 200);
    // SVG elements and HTML elements of XML documents never use the prefilter (case-sensitive names).
    const svgA = document.querySelector('svg a');
    expect(svgA.matches('a')).toBe(true);
    const xml = new (rt.classes.Document)();
    const x = xml.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    expect(x.matches('DIV')).toBe(false);
    expect(x.matches('div')).toBe(true);
  });

  it('memoized querySelectorAll returns fresh lists equal to an uncached query', () => {
    const { document } = createWindow();
    document.body.innerHTML = HTML;
    const s = 'input, a[href], li';
    const a = document.querySelectorAll(s);
    const b = document.querySelectorAll(s);
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
    const c = rt.select.sel(s);
    const raw = Array.from(rt.outIds(rt.N.qsa(document._i, c.id)));
    expect([...b].map((e) => e._i)).toEqual(raw);
    const calls = withCounter('qsa', () => {
      for (let i = 0; i < 10; i++) document.querySelectorAll(s);
    });
    expect(calls).toBe(rt.flags.MEMO ? 0 : 10);
    // every kind of change invalidates
    document.querySelector('li').setAttribute('data-x', '1');
    expect(withCounter('qsa', () => document.querySelectorAll(s))).toBe(1);
    document.querySelector('ul').appendChild(document.createElement('li'));
    expect(document.querySelectorAll(s).length).toBe(a.length + 1);
    const t = document.createElement('p');
    document.body.appendChild(t);
    const empty = document.querySelectorAll('p:empty').length;
    t.textContent = 'x';
    expect(document.querySelectorAll('p:empty').length).toBe(empty - 1);
  });

  it('memo stays bounded and is cleared with the SEL cache on eviction / reset', () => {
    const { document } = createWindow();
    document.body.innerHTML = HTML;
    for (let i = 0; i < 200; i++) document.querySelectorAll(`[data-k="${i}"]`);
    expect(rt.select.memoSize()).toBeLessThanOrEqual(64);
    for (let i = 0; i < 5000; i++) document.body.matches(`[data-q="${i}"]`);
    expect(rt.select.selSize()).toBeLessThanOrEqual(4096);
    expect(document.querySelectorAll('li').length).toBe(1);
    rt.reset();
    expect(rt.select.selSize()).toBe(0);
    const w2 = createWindow();
    w2.document.body.innerHTML = '<p class=a></p><p></p>';
    expect(w2.document.querySelectorAll('p').length).toBe(2);
    expect(w2.document.querySelectorAll('.a').length).toBe(1);
  });

  it('live getElementsBy* collections are validated by Rust epochs', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<p class="a b"></p><p class=a></p>';
    const byCls = document.getElementsByClassName('a b');
    const byTag = document.getElementsByTagName('p');
    expect(byCls.length).toBe(1);
    const calls = withCounter('byClass', () => {
      for (let i = 0; i < 10; i++) void byCls.length;
    });
    // OXIDOM_NO_MEMO=1 turns the collection's query cache off too (lib/memo.cjs)
    expect(calls).toBe(rt.flags.MEMO ? 0 : 10);
    document.querySelectorAll('p')[1].setAttribute('class', 'b a');
    expect(byCls.length).toBe(2);
    document.body.appendChild(document.createElement('p'));
    expect(byTag.length).toBe(3);
  });
});
