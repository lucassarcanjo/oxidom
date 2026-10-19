// rsdom-only traversal protocols (lib/traversal.cjs, DESIGN §16): the removal natives are wrapped only once a
// NodeIterator exists, the wrappers keep OUT intact for replaceChildren in both table modes, iterators and
// walkers from an env that was reset return null instead of walking the new env's ids, and a traversal
// re-entered from its own filter leaves the outer one's state alone (where jsdom 30 loses it).
import { createRequire } from 'node:module';
import { describe, it, expect, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

afterAll(() => {
  rt.reset();
});

describe('traversal (rsdom protocols)', () => {
  it('the removal natives are wrapped by the first createNodeIterator(), not by createTreeWalker()', () => {
    const { document } = createWindow();
    const before = rt.N.removeChild;
    document.createTreeWalker(document.body).nextNode();
    expect(rt.N.removeChild).toBe(before);
    document.createNodeIterator(document.body);
    expect(rt.N.removeChild).not.toBe(before);
    const wrapped = rt.N.removeChild;
    document.createNodeIterator(document.body);
    expect(rt.N.removeChild).toBe(wrapped); // once per process
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
