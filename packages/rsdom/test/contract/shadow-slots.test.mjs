// Slots (ROADMAP Stage 4 `shadow-dom`, DESIGN §42 part 2). The upstream coverage is conformance/parity
// (`--item shadow-dom`: WPT slots*, slotchange*, event-inside-slotted-node, HTMLSlotElement-interface); these
// cases cover what component libraries do with slots (read assignedNodes / assignedElements, listen for
// `slotchange`, handle events from slotted light-DOM content) and the Rust hooks that keep assignment current
// (insert, remove, the `slot` and `name` attributes, fragments, moves between hosts). Every assertion runs on
// jsdom, happy-dom and rsdom; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const tick = () => new Promise((r) => setTimeout(r, 0));

// PINNED to jsdom: happy-dom 21 has no slot assignment (assignedSlot is undefined, assignedNodes ignores names)
describe.each(DOMS.filter((k) => k !== 'happy-dom'))('slots [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  /** A connected host with light children `html` and a shadow tree `shadow` (open unless `mode`). */
  function tree(html, shadow, mode = 'open') {
    const host = d.body.appendChild(d.createElement('div'));
    host.innerHTML = html;
    const root = host.attachShadow({ mode });
    root.innerHTML = shadow;
    return { host, root, slot: (sel) => root.querySelector(sel) };
  }
  const ids = (list) => list.map((n) => (n.nodeType === 3 ? `#${n.data}` : n.id || n.localName));

  it('assignedNodes, assignedElements and assignedSlot by name', () => {
    const t = tree('<b id=a slot=x></b>text<i id=c></i><u id=d slot=nope></u>', '<slot id=def></slot><slot id=sx name=x></slot>');
    const def = t.slot('#def');
    const sx = t.slot('#sx');
    expect(def).toBeInstanceOf(w.HTMLSlotElement);
    expect(ids(def.assignedNodes())).toEqual(['#text', 'c']);
    expect(ids(def.assignedElements())).toEqual(['c']);
    expect(ids(sx.assignedNodes())).toEqual(['a']);
    expect(d.getElementById('a').assignedSlot).toBe(sx);
    expect(d.getElementById('d').assignedSlot).toBe(null);
    expect(t.host.childNodes[1].assignedSlot).toBe(def);
    expect(def.name).toBe('');
    expect(sx.name).toBe('x');
    expect(errName(() => def.assignedNodes(1))).toBe('TypeError');
  });

  it('assignment follows insertions, removals and attribute changes', () => {
    const t = tree('<b id=a slot=x></b>', '<slot id=s1 name=x></slot>');
    const a = d.getElementById('a');
    const s1 = t.slot('#s1');
    // an earlier slot with the same name takes over
    const s0 = d.createElement('slot');
    s0.name = 'x';
    t.root.insertBefore(s0, s1);
    expect(ids(s0.assignedNodes())).toEqual(['a']);
    expect(s1.assignedNodes()).toEqual([]);
    expect(a.assignedSlot).toBe(s0);
    s0.remove();
    expect(a.assignedSlot).toBe(s1);
    expect(s0.assignedNodes()).toEqual([]);
    // renaming the slottable or the slot
    a.slot = 'y';
    expect(a.assignedSlot).toBe(null);
    s1.name = 'y';
    expect(a.assignedSlot).toBe(s1);
    // a fragment of slottables, then removal from the host
    const f = d.createDocumentFragment();
    for (const id of ['p', 'q']) {
      const e = f.appendChild(d.createElement('p'));
      e.id = id;
      e.slot = 'y';
    }
    t.host.appendChild(f);
    expect(ids(s1.assignedNodes())).toEqual(['a', 'p', 'q']);
    a.remove();
    expect(a.assignedSlot).toBe(null);
    expect(ids(s1.assignedNodes())).toEqual(['p', 'q']);
    // moving a child to another host
    const other = tree('', '<slot id=o name=y></slot>');
    other.host.appendChild(d.getElementById('p'));
    expect(ids(other.slot('#o').assignedNodes())).toEqual(['p']);
    expect(ids(s1.assignedNodes())).toEqual(['q']);
  });

  it('flatten, fallback content and closed roots', () => {
    const t = tree('<b id=a></b>', '<div id=inner></div>', 'closed');
    const innerHost = t.root.querySelector('#inner');
    innerHost.innerHTML = '<slot id=mid>fallback</slot>';
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<slot id=leaf></slot>';
    const mid = t.root.querySelector('#mid');
    const leaf = innerRoot.querySelector('#leaf');
    expect(ids(mid.assignedNodes())).toEqual(['a']);
    expect(ids(leaf.assignedNodes())).toEqual(['mid']);
    expect(ids(leaf.assignedNodes({ flatten: true }))).toEqual(['a']);
    // assignedSlot hides a slot in a closed shadow root
    expect(d.getElementById('a').assignedSlot).toBe(null);
    d.getElementById('a').remove();
    expect(ids(leaf.assignedNodes({ flatten: true }))).toEqual(['#fallback']);
    // a slot outside any shadow tree has nothing assigned, and no fallback when flattened
    const loose = d.body.appendChild(d.createElement('slot'));
    loose.textContent = 'x';
    expect(loose.assignedNodes({ flatten: true })).toEqual([]);
  });

  it('assignedElements keeps HTML elements only, and unslotted content is not focusable', () => {
    const t = tree('<svg></svg><b id=b></b><input id=in slot=none>', '<slot id=s></slot><slot name=x><input id=fb></slot>');
    // jsdom filters with HTMLElement.is; the spec keeps every element
    expect(ids(t.slot('#s').assignedElements())).toEqual(['b']);
    const input = d.getElementById('in');
    input.focus();
    expect(d.activeElement).toBe(d.body);
    input.slot = 'x';
    input.focus();
    expect(d.activeElement).toBe(input);
    // fallback content of a slot with assigned nodes is not in the flat tree
    t.root.querySelector('#fb').focus();
    expect(t.root.activeElement).toBe(null);
  });

  it('slotchange fires once per slot after mutation observers, and bubbles', async () => {
    const t = tree('', '<div><slot id=s></slot></div>');
    const s = t.slot('#s');
    const log = [];
    s.addEventListener('slotchange', (e) => log.push(['slot', e.target.id, e.bubbles, e.isTrusted, e.composed]));
    t.root.addEventListener('slotchange', () => log.push(['root']));
    t.host.addEventListener('slotchange', () => log.push(['host']));
    const m = d.createElement('i');
    new w.MutationObserver(() => log.push(['mo'])).observe(m, { attributes: true });
    t.host.appendChild(d.createElement('b'));
    t.host.appendChild(d.createElement('b'));
    m.id = 'x';
    expect(log).toEqual([]);
    await tick();
    expect(log).toEqual([['mo'], ['slot', 's', true, true, false], ['root']]);
    // emptying the host signals; so does a fallback change of an empty slot; an unchanged assignment does not
    const seen = [];
    s.addEventListener('slotchange', () => seen.push('s'));
    t.host.textContent = '';
    await tick();
    seen.push('|');
    s.textContent = 'fallback';
    await tick();
    seen.push('|');
    t.host.appendChild(d.createElement('b')).setAttribute('slot', '');
    await tick();
    expect(seen).toEqual(['s', '|', 's', '|', 's']);
  });

  it('events from slotted content pass through the slot', () => {
    const t = tree('<b id=a><i id=leaf></i></b>', '<div id=wrap><slot id=s></slot></div>', 'closed');
    const leaf = d.getElementById('leaf');
    const path = [];
    for (const n of [leaf, d.getElementById('a'), t.host, t.slot('#s'), t.root.querySelector('#wrap'), t.root, d.body]) {
      n.addEventListener('click', (e) => path.push([n.id || n.nodeName, e.target.id, e.composedPath().length]));
    }
    let composed = null;
    leaf.addEventListener('click', (e) => {
      composed = e.composedPath().map((n) => n.id || n.nodeName || 'window');
    });
    leaf.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(path).toEqual([
      ['leaf', 'leaf', 7],
      ['a', 'leaf', 7],
      ['s', 'leaf', 10],
      ['wrap', 'leaf', 10],
      ['#document-fragment', 'leaf', 10],
      ['DIV', 'leaf', 7],
      ['BODY', 'leaf', 7],
    ]);
    // the closed shadow tree (slot, wrapper, root) is hidden from listeners outside it
    expect(composed).toEqual(['leaf', 'a', 'DIV', 'BODY', 'HTML', '#document', 'window']);
  });
});
