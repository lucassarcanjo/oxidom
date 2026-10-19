// rsdom-only traversal protocols (lib/traversal.cjs, src/traversal.rs, DESIGN §16): NodeIterator pointers live
// in a buffer shared with Rust and move inside the removal natives (nothing in JS wraps them), replaceChildren
// with a live iterator inserts exactly the given nodes in both table modes, iterators and walkers from an env
// that was reset return null instead of walking the new env's ids, and a traversal re-entered from its own
// filter leaves the outer one's state alone (where jsdom 30 loses it).
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

  it('replaceChildren with a live iterator inserts exactly the given nodes', () => {
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

  it('a traversal re-entered from its filter (InvalidStateError) leaves the outer traversal where it was', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<div id="r"><p id="x"></p><p id="y"></p></div>';
    let inner = null;
    const it = document.createNodeIterator(document.getElementById('r'), 1, (n) => {
      if (n.id === 'r') return 3; // FILTER_SKIP
      try {
        it.nextNode();
      } catch (e) {
        inner ??= e.name;
      }
      return 1;
    });
    expect(it.nextNode().id).toBe('x');
    expect(inner).toBe('InvalidStateError');
    expect(it.referenceNode.id).toBe('x'); // jsdom 30: null, then nextNode() throws a TypeError
    expect(it.nextNode().id).toBe('y');
  });

  it('iterators and walkers from a reset env return null', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<div><p></p><p></p></div>';
    const it = document.createNodeIterator(document.body);
    const untouched = document.createNodeIterator(document.body);
    const tw = document.createTreeWalker(document.body);
    expect(it.nextNode()).toBe(document.body);
    rt.reset();
    const fresh = createWindow().document;
    fresh.body.innerHTML = '<div><p></p><p></p><p></p></div>';
    expect(it.nextNode()).toBe(null);
    expect(it.previousNode()).toBe(null);
    expect(tw.nextNode()).toBe(null);
    expect(tw.firstChild()).toBe(null);
    // the reference reads as the (neutered) root, not as the new env's node with the same id
    for (const ni of [it, untouched]) {
      expect(ni.referenceNode).toBe(ni.root);
      expect(ni.referenceNode).not.toBe(fresh.body);
      expect(ni.referenceNode.isConnected).toBe(false);
    }
  });
});
