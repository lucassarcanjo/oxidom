// rsdom-only traversal protocols (lib/traversal.cjs, DESIGN §16): the removal natives are wrapped only once a
// NodeIterator exists, the wrappers keep OUT intact for replaceChildren in both table modes, and iterators and
// walkers from an env that was reset return null instead of walking the new env's ids.
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
