// oxidom-only regression tests for the foundation review fixes: table growth inside mutations (no stale
// detached view), reset() neutering leaked wrappers, the length-prefixed atom sync (NUL in names), the
// fallback mirror never being replaced, dense W, the data memo protocol, iterative cloning, untrusted ids,
// and OUT pinning.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');
const { N, V, EPI, F } = rt;

afterAll(() => rt.reset());

/** Fills the table with comments until the next allocation must grow it. */
function fillToCapacity(document) {
  const cap = N.__tableCap();
  while (V.EP[EPI.NODE_LEN] < cap) document.createComment('pad');
}

describe('table growth inside mutations (no detached view, no hang)', () => {
  // Adopting a <template> whose contents exist allocates the destination's template-contents document.
  for (const op of ['appendChild', 'insertBefore', 'replaceChild', 'append', 'adoptNode']) {
    it(`growth during ${op} of a template from another document`, () => {
      rt.reset({ capacity: 64 });
      const { document } = createWindow();
      const other = document.implementation.createHTMLDocument('o');
      const tpl = other.createElement('template');
      tpl.content.append(other.createElement('div'));
      const victim = document.createElement('i');
      document.body.append(victim);
      fillToCapacity(document);
      const gen = V.EP[EPI.GEN];
      if (op === 'appendChild') document.body.appendChild(tpl);
      else if (op === 'insertBefore') document.body.insertBefore(tpl, victim);
      else if (op === 'replaceChild') document.body.replaceChild(tpl, victim);
      else if (op === 'append') document.body.append(tpl);
      else document.adoptNode(tpl);
      expect(V.EP[EPI.GEN]).toBeGreaterThan(gen); // the mutation itself grew the table
      if (rt.shared) expect(V.T.length).toBeGreaterThan(0); // remapped: not the detached view
      if (op !== 'adoptNode') {
        expect(tpl.parentNode).toBe(document.body);
        expect(document.body.childNodes.length).toBe(op === 'replaceChild' ? 1 : 2);
      }
      expect(tpl.content.firstChild.ownerDocument).toBe(tpl.content.ownerDocument);
    });
  }

  it('growth inside a FAILING replaceChildren (fragment allocated before validation) still remaps', () => {
    rt.reset({ capacity: 64 });
    const { document } = createWindow();
    const B = document.implementation.createHTMLDocument('b');
    const e1 = B.createElement('a');
    const e2 = B.createElement('b');
    fillToCapacity(document);
    expect(() => B.replaceChildren(e1, e2)).toThrow(/HierarchyRequest|incorrect node tree/);
    if (rt.shared) expect(V.T.length).toBeGreaterThan(0);
    expect(document.body.isConnected).toBe(true);
    expect(e1.parentNode.nodeType).toBe(11);
  });
});

describe('reset() neuters wrappers of the previous env', () => {
  it('a leaked wrapper reads as an empty detached node and cannot write into the new env', () => {
    rt.reset();
    const { document: d1 } = createWindow();
    const leaked = d1.createElement('div');
    d1.body.append(leaked);
    leaked.textContent = 'old';
    const leakedText = leaked.firstChild;
    expect(leakedText.data).toBe('old'); // memoized in the wrapper
    const kids = d1.body.childNodes;
    const items = d1.body.children;
    expect(kids.length).toBe(1);
    rt.reset();
    expect(rt.defaultDocument).toBe(null);
    const { document: d2 } = createWindow();
    d2.body.innerHTML = '<main>new test content</main>';
    expect(leaked._i).toBe(0);
    expect(leaked.parentNode).toBe(null);
    expect(leaked.isConnected).toBe(false);
    expect(leaked.textContent).toBe(null);
    expect(leakedText.data).toBe(''); // the memo died with the env
    expect(() => { leaked.textContent = 'clobbered'; }).toThrow();
    expect(() => d2.body.appendChild(leaked)).toThrow(/reset/);
    expect(kids.length).toBe(0);
    expect(kids[0]).toBe(undefined);
    expect(items.length).toBe(0);
    expect(d2.body.innerHTML).toBe('<main>new test content</main>');
  });

  it('dynamic-atom interface classes do not leak across envs', () => {
    rt.reset();
    const { document: d1 } = createWindow();
    expect(d1.createElement('x-foo').constructor.name).toBe('HTMLElement');
    rt.reset();
    const { document: d2 } = createWindow();
    // `blorp` gets the dynamic atom id `x-foo` had in the previous env
    expect(d2.createElement('blorp').constructor.name).toBe('HTMLUnknownElement');
    expect(d2.createElement('x-bar').constructor.name).toBe('HTMLElement');
  });
});

describe('atom mirror', () => {
  it('names containing U+0000 do not shift later atoms (length-prefixed sync)', () => {
    rt.reset();
    const { document } = createWindow();
    const d = document.createElement('div');
    d.setAttribute('class', 'tok\0en');
    d.setAttribute('id', 'x\0y');
    const ns = document.createElementNS('urn:a\0b', 'p:foo');
    document.body.innerHTML = '<my-widget aria-x="1"></my-widget><custom-two data-zzz="1"></custom-two>';
    const w = document.body.firstChild;
    expect(w.localName).toBe('my-widget');
    expect(w.tagName).toBe('MY-WIDGET');
    expect(w.getAttributeNames()).toEqual(['aria-x']);
    expect(w.nextSibling.localName).toBe('custom-two');
    expect(ns.namespaceURI).toBe('urn:a\0b');
    expect(ns.localName).toBe('foo');
    expect(document.getElementById('x\0y')).toBe(null); // detached
    document.body.append(d);
    expect(document.getElementById('x\0y')).toBe(d);
    expect(rt.atomName(rt.V.EP[EPI.ATOM_LEN] - 1)).not.toBe('');
  });
});

describe('dense identity table and fallback mirror', () => {
  it('materializing a high id first keeps W free of holes', () => {
    rt.reset();
    const { document } = createWindow();
    const host = document.createElement('div');
    host.innerHTML = '<i id=a></i>'.repeat(3000) + '<b id=last></b>';
    document.body.append(host);
    expect(document.getElementById('last').tagName).toBe('B');
    expect(Object.keys(rt.W).length).toBe(rt.W.length); // no holes (no dictionary elements)
  });

  it('the fallback mirror is resized in place (V.T identity is stable)', () => {
    if (rt.shared) return; // only meaningful with OXIDOM_SHARED=0
    rt.reset();
    const { document } = createWindow();
    const T = V.T;
    const node = document.createElement('p');
    document.body.append(node);
    node.insertAdjacentHTML('beforebegin', '<i></i>'.repeat(5000));
    const r = document.createRange();
    r.setStartBefore(node);
    expect(r.startOffset).toBe(5000);
    expect(V.T).toBe(T);
  });
});

describe('character-data memo', () => {
  it('is keyed by the per-node DATA_VER that every data change bumps', () => {
    rt.reset();
    const { document } = createWindow();
    const t = document.createTextNode('a');
    const v0 = rt.field(t._i, F.DATA_VER);
    expect(t.data).toBe('a');
    t.appendData('b');
    const v1 = rt.field(t._i, F.DATA_VER);
    expect(v1).not.toBe(v0);
    expect(t.data).toBe('ab');
    // a change through another wrapper path (normalize merges into the first text node)
    const p = document.createElement('p');
    p.append(t, document.createTextNode('c'));
    p.normalize();
    expect(t.data).toBe('abc');
    // OXIDOM_NO_MEMO=1 disables it (rt.flags.MEMO); either way the answers are equal
    expect(t.length).toBe(3);
  });
});

describe('untrusted ids and deep inputs', () => {
  it('compareDocumentPosition with invalid ids does not panic', () => {
    expect(N.compareDocumentPosition(0, 8)).toBe(1 | 2 | 32);
    expect(N.compareDocumentPosition(8, 0x3fffffff)).toBe(1 | 2 | 32);
  });

  it('deep cloneNode / importNode through 20000 nested templates (iterative)', () => {
    rt.reset();
    const { document } = createWindow();
    const div = document.createElement('div');
    div.innerHTML = '<template>'.repeat(20000) + 'x';
    const html = div.innerHTML;
    expect(div.cloneNode(true).innerHTML).toBe(html);
    expect(document.importNode(div, true).innerHTML).toBe(html);
  });
});

describe('OUT binding', () => {
  it('bindOut pins the buffer it caches (no write through a collected ArrayBuffer)', () => {
    const native = require.resolve('../../lib/native.cjs');
    const script = `
      const N = require(${JSON.stringify(native)});
      const ep = new ArrayBuffer(64);
      const out = new ArrayBuffer(4096);
      N.init(ep, out, 0, true);
      let tmp = new ArrayBuffer(1 << 20);
      const ref = new WeakRef(tmp);
      N.bindOut(tmp);
      tmp = null;
      for (let i = 0; i < 5; i++) gc();
      const alive = ref.deref() !== undefined;
      N.__outSeq(1000);
      const wrote = new Uint32Array(ref.deref())[999] === 1000;
      process.stdout.write(JSON.stringify({ alive, wrote }));`;
    const r = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ alive: true, wrote: true });
  });
});

