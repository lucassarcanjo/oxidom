// MutationObserver oracles (DOM §4.3; jsdom 30 `helpers/mutation-observers.js` is the oracle): record shapes
// for every mutation kind, options and validation, delivery order and batching, takeRecords / disconnect,
// transient registered observers.
//
// happy-dom 21's MutationObserver diverges from jsdom (and the spec) almost everywhere these oracles look:
// one record per parsed node for innerHTML, per-node records for fragments/replaceChildren, no MutationRecord
// class, callbacks not in creation order, observe() options validation, re-observe semantics. The record-shape
// suite therefore runs on jsdom and oxidom (PINNED to jsdom); a delivery smoke suite runs on all three.
//
// Spec-correct divergences from jsdom 30 (asserted for oxidom, documented for jsdom):
// - transient registered observers (DOM "remove" step 13): jsdom does not implement them, so mutations of a
//   just-removed subtree are not reported before the next delivery;
// - attributeFilter ignores namespaced attributes (spec: "namespace is non-null"); jsdom matches the filter
//   against the local name OR the namespace.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const flush = () => new Promise((r) => setTimeout(r, 0));

function label(n) {
  if (n === null || n === undefined) return null;
  if (n.nodeType === 3) return `#text:${n.data}`;
  if (n.nodeType === 8) return `#comment:${n.data}`;
  if (n.nodeType === 11) return '#fragment';
  return n.id ? `${n.localName}#${n.id}` : n.localName;
}

function shape(r) {
  return {
    type: r.type,
    target: label(r.target),
    added: Array.from(r.addedNodes, label),
    removed: Array.from(r.removedNodes, label),
    prev: label(r.previousSibling),
    next: label(r.nextSibling),
    name: r.attributeName,
    ns: r.attributeNamespace,
    old: r.oldValue,
  };
}

const cl = (target, added, removed, prev = null, next = null) => ({
  type: 'childList', target, added, removed, prev, next, name: null, ns: null, old: null,
});
const at = (target, name, old = null, ns = null) => ({
  type: 'attributes', target, added: [], removed: [], prev: null, next: null, name, ns, old,
});
const cd = (target, old = null) => ({
  type: 'characterData', target, added: [], removed: [], prev: null, next: null, name: null, ns: null, old,
});

describe.each(DOMS)('MutationObserver delivery smoke [%s]', (kind) => {
  it('waitFor-style observation of a container sees React-like mutations in one microtask', async () => {
    const w = makeWindow(kind);
    const d = w.document;
    const container = d.createElement('div');
    d.body.appendChild(container);
    let calls = 0;
    let records = 0;
    const mo = new w.MutationObserver((r) => {
      calls++;
      records += r.length;
    });
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    const p = d.createElement('p');
    p.appendChild(d.createTextNode('loading'));
    container.appendChild(p);
    p.setAttribute('class', 'x');
    p.firstChild.data = 'done';
    expect(calls).toBe(0);
    await flush();
    expect(calls).toBe(1);
    expect(records).toBe(3);
    mo.disconnect();
    container.appendChild(d.createElement('i'));
    await flush();
    expect(calls).toBe(1);
  });
});

describe.each(DOMS.filter((k) => k !== 'happy-dom'))('MutationObserver [%s]', (kind) => {
  let w;
  let d;
  let root;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    root = d.createElement('div');
    root.id = 'root';
    d.body.appendChild(root);
  });
  const el = (t, id) => {
    const e = d.createElement(t);
    if (id) e.id = id;
    return e;
  };
  /** Observes `target` and returns the log of delivered record shapes (one array per callback). */
  function watch(target, options) {
    const calls = [];
    const mo = new w.MutationObserver((records, observer) => {
      calls.push(records.map(shape));
      expect(observer).toBe(mo);
    });
    mo.observe(target, options);
    return { mo, calls };
  }

  it('exists on the window with the right names', () => {
    expect(typeof w.MutationObserver).toBe('function');
    expect(w.MutationObserver.name).toBe('MutationObserver');
    const mo = new w.MutationObserver(() => {});
    expect(Object.prototype.toString.call(mo)).toBe('[object MutationObserver]');
    expect(errName(() => new w.MutationObserver())).toBe('TypeError');
    expect(errName(() => new w.MutationObserver({}))).toBe('TypeError');
  });

  it('childList: append, insertBefore, removeChild with siblings', async () => {
    const a = el('p', 'a');
    const b = el('p', 'b');
    root.appendChild(a);
    const { calls } = watch(root, { childList: true });
    root.appendChild(b);
    const c = el('p', 'c');
    root.insertBefore(c, b);
    root.removeChild(a);
    expect(calls.length).toBe(0); // delivered in a microtask
    await flush();
    expect(calls).toEqual([[
      cl('div#root', ['p#b'], [], 'p#a', null),
      cl('div#root', ['p#c'], [], 'p#a', 'p#b'),
      cl('div#root', [], ['p#a'], null, 'p#c'),
    ]]);
  });

  it('childList: replaceChild, remove(), before/after, replaceChildren', async () => {
    const a = el('i', 'a');
    const b = el('i', 'b');
    root.append(a, b);
    const { calls } = watch(root, { childList: true });
    const x = el('i', 'x');
    root.replaceChild(x, a);
    b.remove();
    x.after(el('i', 'y'));
    root.replaceChildren(el('i', 'z'));
    await flush();
    expect(calls[0]).toEqual([
      cl('div#root', ['i#x'], ['i#a'], null, 'i#b'),
      cl('div#root', [], ['i#b'], 'i#x', null),
      cl('div#root', ['i#y'], [], 'i#x', null),
      cl('div#root', ['i#z'], ['i#x', 'i#y'], null, null),
    ]);
  });

  it('childList: moving a node records the removal from its old parent', async () => {
    const p1 = el('section', 'p1');
    const p2 = el('section', 'p2');
    const n = el('b', 'n');
    p1.appendChild(n);
    root.append(p1, p2);
    const { calls } = watch(root, { childList: true, subtree: true });
    p2.appendChild(n);
    await flush();
    expect(calls[0]).toEqual([
      cl('section#p1', [], ['b#n'], null, null),
      cl('section#p2', ['b#n'], [], null, null),
    ]);
  });

  it('childList: fragment insertion', async () => {
    const f = d.createDocumentFragment();
    f.append(el('u', 'f1'), el('u', 'f2'));
    const r1 = watch(f, { childList: true });
    const r2 = watch(root, { childList: true });
    root.appendChild(f);
    await flush();
    expect(r1.calls[0]).toEqual([cl('#fragment', [], ['u#f1', 'u#f2'])]);
    expect(r2.calls[0]).toEqual([cl('div#root', ['u#f1', 'u#f2'], [], null, null)]);
  });

  it('childList: innerHTML and textContent produce one record each', async () => {
    root.innerHTML = '<p>old</p><span>x</span>';
    const { calls } = watch(root, { childList: true, subtree: true });
    root.innerHTML = '<ul><li>1</li><li>2</li></ul>text';
    root.textContent = 'plain';
    root.textContent = 'plain2';
    root.innerHTML = '';
    await flush();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      cl('div#root', ['ul', '#text:text'], ['p', 'span'], null, null),
      cl('div#root', ['#text:plain'], ['ul', '#text:text'], null, null),
      cl('div#root', ['#text:plain2'], ['#text:plain'], null, null),
      cl('div#root', [], ['#text:plain2'], null, null),
    ]);
  });

  it('subtree: off ignores descendants, on reports them', async () => {
    const child = el('div', 'child');
    root.appendChild(child);
    const off = watch(root, { childList: true, attributes: true });
    const on = watch(root, { childList: true, attributes: true, subtree: true });
    child.appendChild(el('b'));
    child.setAttribute('title', 't');
    await flush();
    expect(off.calls).toEqual([]);
    expect(on.calls[0]).toEqual([cl('div#child', ['b'], [], null, null), at('div#child', 'title')]);
  });

  it('attributes: old values, same-value sets, removal, toggleAttribute, absent removal', async () => {
    root.setAttribute('data-x', '1');
    const { calls } = watch(root, { attributeOldValue: true });
    root.setAttribute('data-x', '2');
    root.setAttribute('data-x', '2');
    root.setAttribute('title', 'new');
    root.removeAttribute('data-x');
    root.removeAttribute('never-there');
    root.toggleAttribute('hidden');
    root.toggleAttribute('hidden');
    await flush();
    expect(calls[0]).toEqual([
      at('div#root', 'data-x', '1'),
      at('div#root', 'data-x', '2'),
      at('div#root', 'title', null),
      at('div#root', 'data-x', '2'),
      at('div#root', 'hidden', null),
      at('div#root', 'hidden', ''),
    ]);
  });

  it('attributes: attributeFilter and namespaced attributes', async () => {
    const xlink = 'http://www.w3.org/1999/xlink';
    const { calls } = watch(root, { attributeFilter: ['title', 'href'], attributeOldValue: true });
    root.setAttribute('title', 'a');
    root.setAttribute('class', 'ignored');
    root.setAttributeNS(xlink, 'xlink:href', '#x'); // namespaced: filtered out even though the local name matches
    root.setAttribute('href', 'h');
    await flush();
    if (kind === 'jsdom') {
      // DIVERGENCE (spec-correct oxidom): jsdom also reports the namespaced xlink:href (local name in the filter).
      expect(calls[0].length).toBe(3);
    } else {
      expect(calls[0]).toEqual([at('div#root', 'title', null), at('div#root', 'href', null)]);
    }
    const all = watch(root, { attributes: true });
    root.setAttributeNS(xlink, 'xlink:href', '#y');
    await flush();
    expect(all.calls[0]).toEqual([at('div#root', 'href', null, xlink)]);
  });

  it('characterData: data, appendData, replaceData, textContent/nodeValue, splitText', async () => {
    const t = d.createTextNode('abc');
    root.appendChild(t);
    const { calls } = watch(root, { characterData: true, characterDataOldValue: true, subtree: true });
    t.data = 'xyz';
    t.appendData('!');
    t.replaceData(0, 1, 'Q');
    t.nodeValue = 'n';
    t.textContent = 'tc';
    const c = d.createComment('c1');
    root.appendChild(c);
    c.data = 'c2';
    await flush();
    expect(calls[0]).toEqual([
      cd('#text:tc', 'abc'),
      cd('#text:tc', 'xyz'),
      cd('#text:tc', 'xyz!'),
      cd('#text:tc', 'Qyz!'),
      cd('#text:tc', 'n'),
      cd('#comment:c2', 'c1'),
    ]);
    const s = watch(root, { characterData: true, childList: true, subtree: true });
    t.splitText(1);
    await flush();
    expect(s.calls[0].map((r) => r.type)).toEqual(['childList', 'characterData']);
  });

  it('characterData without old values, and non-ASCII old values', async () => {
    const t = d.createTextNode('ünï😀');
    root.appendChild(t);
    const a = watch(t, { characterData: true });
    const b = watch(t, { characterDataOldValue: true });
    t.data = 'é';
    await flush();
    expect(a.calls[0]).toEqual([cd('#text:é', null)]);
    expect(b.calls[0]).toEqual([cd('#text:é', 'ünï😀')]);
  });

  it('options validation (TypeError) and the implied attributes/characterData', () => {
    const mo = new w.MutationObserver(() => {});
    expect(errName(() => mo.observe(root, {}))).toBe('TypeError');
    expect(errName(() => mo.observe(root))).toBe('TypeError');
    expect(errName(() => mo.observe(root, { attributes: false, attributeOldValue: true }))).toBe('TypeError');
    expect(errName(() => mo.observe(root, { attributes: false, attributeFilter: ['a'] }))).toBe('TypeError');
    expect(errName(() => mo.observe(root, { characterData: false, characterDataOldValue: true }))).toBe('TypeError');
    expect(errName(() => mo.observe({}, { childList: true }))).toBe('TypeError');
    expect(errName(() => mo.observe(null, { childList: true }))).toBe('TypeError');
    expect(errName(() => mo.observe(root, { attributeOldValue: true }))).toBe('ok');
    expect(errName(() => mo.observe(root, { attributeFilter: [] }))).toBe('ok');
    expect(errName(() => mo.observe(root, { characterDataOldValue: false }))).toBe('ok');
    expect(errName(() => mo.observe(root, { subtree: true, childList: 1 }))).toBe('ok');
    mo.disconnect();
  });

  it('re-observing the same target replaces the options', async () => {
    const { mo, calls } = watch(root, { attributes: true });
    mo.observe(root, { childList: true });
    root.setAttribute('title', 'x');
    root.appendChild(el('b'));
    await flush();
    expect(calls[0]).toEqual([cl('div#root', ['b'], [], null, null)]);
  });

  it('observers are notified in creation order, one callback per burst', async () => {
    const order = [];
    const m2 = new w.MutationObserver((r) => order.push(['first', r.length]));
    const m1 = new w.MutationObserver((r) => order.push(['second', r.length]));
    m1.observe(root, { childList: true });
    m2.observe(root, { childList: true });
    root.appendChild(el('a'));
    root.appendChild(el('a'));
    await flush();
    expect(order).toEqual([['first', 2], ['second', 2]]);
    root.appendChild(el('a'));
    await flush();
    expect(order.length).toBe(4);
  });

  it('records queued by a callback reach later observers in the same round', async () => {
    const log = [];
    let n = 0;
    const a = new w.MutationObserver((r) => {
      log.push(`a${r.length}`);
      if (n++ === 0) root.appendChild(el('i'));
    });
    const b = new w.MutationObserver((r) => log.push(`b${r.length}`));
    a.observe(root, { childList: true });
    b.observe(root, { childList: true });
    root.appendChild(el('i'));
    await flush();
    expect(log).toEqual(['a1', 'b2', 'a1']);
  });

  it('takeRecords and disconnect', async () => {
    const { mo, calls } = watch(root, { childList: true, attributes: true });
    root.appendChild(el('b'));
    root.setAttribute('title', 't');
    const taken = mo.takeRecords();
    expect(taken.map(shape)).toEqual([cl('div#root', ['b'], [], null, null), at('div#root', 'title')]);
    expect(mo.takeRecords()).toEqual([]);
    await flush();
    expect(calls).toEqual([]);
    root.appendChild(el('c'));
    mo.disconnect();
    root.appendChild(el('d'));
    await flush();
    expect(calls).toEqual([]);
    expect(mo.takeRecords()).toEqual([]);
    mo.observe(root, { childList: true });
    root.appendChild(el('e'));
    await flush();
    expect(calls.length).toBe(1);
  });

  it('transient registered observers: a removed subtree stays observed until delivery', async () => {
    const p = el('p', 'p');
    const t = d.createTextNode('x');
    p.appendChild(t);
    root.appendChild(p);
    const { calls } = watch(root, { childList: true, characterData: true, subtree: true });
    root.removeChild(p);
    t.data = 'y'; // detached, but still observed through the transient registration
    p.appendChild(el('b'));
    await flush();
    if (kind === 'jsdom') {
      // DIVERGENCE (spec-correct oxidom): jsdom has no transient registered observers.
      expect(calls[0]).toEqual([cl('div#root', [], ['p#p'], null, null)]);
      return;
    }
    expect(calls[0]).toEqual([
      cl('div#root', [], ['p#p'], null, null),
      cd('#text:y'),
      cl('p#p', ['b'], [], '#text:y', null),
    ]);
    t.data = 'z'; // after delivery the transient registration is gone
    await flush();
    expect(calls.length).toBe(1);
  });

  it('record objects', async () => {
    let rec;
    const mo = new w.MutationObserver((r) => {
      rec = r[0];
    });
    mo.observe(root, { childList: true });
    root.appendChild(el('b'));
    await flush();
    expect(Object.prototype.toString.call(rec)).toBe('[object MutationRecord]');
    expect(rec.addedNodes.length).toBe(1);
    expect(rec.addedNodes[0]).toBe(root.lastChild);
    expect(rec.addedNodes.item(0)).toBe(root.lastChild);
    expect(rec.removedNodes.length).toBe(0);
    expect(rec.target).toBe(root);
    expect(typeof w.MutationRecord).toBe('function');
    expect(errName(() => new w.MutationRecord())).toBe('TypeError');
  });

  it('a throwing callback does not stop other observers', async () => {
    const seen = [];
    const handler = (e) => {
      seen.push('error');
      e.preventDefault?.();
    };
    // jsdom reports the exception on the window (an ErrorEvent); keep it from failing the test run.
    w.addEventListener?.('error', handler);
    const prev = process.listeners('uncaughtException');
    const swallow = () => seen.push('uncaught');
    process.on('uncaughtException', swallow);
    try {
      const a = new w.MutationObserver(() => {
        throw new Error('boom');
      });
      const b = new w.MutationObserver(() => seen.push('b'));
      a.observe(root, { childList: true });
      b.observe(root, { childList: true });
      root.appendChild(el('b'));
      await flush();
      expect(seen).toContain('b');
    } finally {
      process.removeListener('uncaughtException', swallow);
      w.removeEventListener?.('error', handler);
      expect(process.listeners('uncaughtException')).toEqual(prev);
    }
  });
});
