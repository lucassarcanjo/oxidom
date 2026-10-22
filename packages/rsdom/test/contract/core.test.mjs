// Core DOM gaps (ROADMAP Stage 3 `core`): behaviour no other item claims, checked against jsdom.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('core [%s]', (kind) => {
  let d;
  beforeEach(() => {
    d = makeWindow(kind).document;
  });

  it('live lists expose their indices as own enumerable properties', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    d.body.innerHTML = '<p></p><p></p>';
    const kids = d.body.childNodes;
    const ps = d.getElementsByTagName('p');
    expect(kids.length).toBe(2);
    expect(Object.keys(kids)).toEqual(['0', '1']);
    expect(ps.length).toBe(2); // own-ness is synced on `length` reads (DESIGN §4.3)
    expect(Object.prototype.hasOwnProperty.call(ps, 1)).toBe(true);
    d.body.lastChild.remove();
    expect(ps.length).toBe(1);
    expect([ps.hasOwnProperty(0), ps.hasOwnProperty(1)]).toEqual([true, false]);
    expect(Object.keys(ps)).toEqual(['0']);
  });

  it('two equal live lists compare equal after one had its length read', () => {
    d.body.innerHTML = '<ul><li>a</li></ul><ul><li>a</li></ul>';
    const [u1, u2] = d.querySelectorAll('ul');
    expect(u1.children.length).toBe(1);
    expect(u1.children).toEqual(u2.children);
    expect(u1.childNodes).toEqual(u2.childNodes);
  });

  it('a frozen live list keeps answering length', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's lists are arrays
    const kids = d.body.childNodes;
    try {
      Object.freeze(kids); // jsdom's Proxy refuses this
    } catch {}
    d.body.append(d.createElement('p'));
    expect(kids.length).toBe(1);
  });

  it('select.options keeps its indexed setter on own indices', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom ignores the assignment
    d.body.innerHTML = '<select><option>a</option><option>b</option></select>';
    const opts = d.querySelector('select').options;
    expect(opts.length).toBe(2);
    const o = d.createElement('option');
    o.textContent = 'c';
    opts[1] = o;
    expect(opts[1].textContent).toBe('c');
  });
});
