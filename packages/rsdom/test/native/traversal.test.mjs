// rsdom-only traversal protocols (lib/traversal.cjs, src/traversal.rs, DESIGN §16): NodeIterator pointers live
// in Rust and move inside the removal natives (nothing in JS wraps them), replaceChildren with a live iterator
// inserts exactly the given nodes in both table modes, and iterators and walkers from an env that was reset
// return null instead of walking the new env's ids.
import { createRequire } from 'node:module';
import { describe, it, expect, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

afterAll(() => {
  rt.reset();
});

describe('traversal (rsdom protocols)', () => {
  it('removal natives stay unwrapped; a filter that removes nodes moves the candidate in Rust', () => {
    const { document } = createWindow();
    const natives = { ...rt.N };
    const host = document.createElement('div');
    host.innerHTML = '<p id="a"></p><p id="b"></p><p id="c"></p>';
    document.body.appendChild(host);
    const seen = [];
    const it = document.createNodeIterator(host, 1, (n) => {
      seen.push(n.id || n.localName);
      // removing the candidate itself: the walk continues from where the pre-removing steps put it
      if (n.id === 'b') n.remove();
      return 1;
    });
    expect(Object.keys(natives).every((k) => rt.N[k] === natives[k])).toBe(true);
    expect(it.nextNode()).toBe(host);
    expect(it.nextNode().id).toBe('a');
    expect(it.nextNode().id).toBe('b');
    // b was removed while it was the candidate (pointer after it): the steps moved it to a, as jsdom does
    expect(it.referenceNode.id).toBe('a');
    expect(it.pointerBeforeReferenceNode).toBe(false);
    expect(it.nextNode().id).toBe('c');
    expect(seen).toEqual(['div', 'a', 'b', 'c']);
  });

  it('more live iterators than the first pointer buffer holds: each one is still moved by removals', () => {
    const { document } = createWindow();
    const host = document.createElement('div');
    host.innerHTML = '<p id="a"></p><p id="b"></p>';
    document.body.appendChild(host);
    const its = [];
    for (let i = 0; i < 300; i++) {
      const it = document.createNodeIterator(host);
      it.nextNode();
      it.nextNode(); // reference: a, pointer after it
      its.push(it);
    }
    document.getElementById('a').remove();
    expect(its.every((it) => it.referenceNode === host && it.pointerBeforeReferenceNode === false)).toBe(true);
    expect(its[299].nextNode().id).toBe('b');
  });

  it('replaceChildren with a live iterator inserts exactly the given nodes (OUT copied around the steps)', () => {
    const { document } = createWindow();
    const host = document.createElement('div');
    host.innerHTML = '<p id="old1"></p><p id="old2"></p>';
    document.body.appendChild(host);
    const it = document.createNodeIterator(host);
    while (it.nextNode() !== null);
    const nodes = ['a', 'b', 'c'].map((t) => document.createElement(t));
    host.replaceChildren(...nodes);
    expect([...host.childNodes].map((n) => n.localName)).toEqual(['a', 'b', 'c']);
    expect(it.referenceNode).toBe(host);
  });

  it('iterators and walkers from a reset env return null', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<div><p></p><p></p></div>';
    const it = document.createNodeIterator(document.body);
    const tw = document.createTreeWalker(document.body);
    expect(it.nextNode()).toBe(document.body);
    rt.reset();
    const fresh = createWindow().document;
    fresh.body.innerHTML = '<div><p></p><p></p><p></p></div>';
    expect(it.nextNode()).toBe(null);
    expect(it.previousNode()).toBe(null);
    expect(tw.nextNode()).toBe(null);
    expect(tw.firstChild()).toBe(null);
  });
});
