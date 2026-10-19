// rsdom-only checks for area B: N-API crossings of dispatch (ROADMAP M4 acceptance), the value memo, zero-FFI
// state reads, the parser hook, focus epochs, window wiring.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');
const events = require('../../lib/events.cjs');

/** Counts native calls made while running `fn` (every export of the addon is wrapped once). */
const COUNTS = new Map();
let counting = false;
for (const [k, f] of Object.entries(rt.N)) {
  if (typeof f !== 'function') continue;
  rt.N[k] = function counted(...args) {
    if (counting) COUNTS.set(k, (COUNTS.get(k) ?? 0) + 1);
    return f.apply(this, args);
  };
}
function crossings(fn) {
  COUNTS.clear();
  counting = true;
  try {
    fn();
  } finally {
    counting = false;
  }
  return Object.fromEntries(COUNTS);
}

function deepTree(document, depth) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let n = root;
  for (let i = 0; i < depth; i++) {
    const c = document.createElement('div');
    n.appendChild(c);
    n = c;
  }
  return { root, leaf: n };
}

describe('dispatch crossings', () => {
  it.skipIf(!rt.shared)('a 20-deep dispatch with React-like root listeners makes no N-API call', () => {
    const { window, document } = createWindow();
    const { root, leaf } = deepTree(document, 20);
    let calls = 0;
    const listener = (e) => {
      calls++;
      void e.target;
      void e.currentTarget;
      void e.eventPhase;
      void e.timeStamp;
      void window.event;
    };
    root.addEventListener('click', listener, true);
    root.addEventListener('click', listener, false);
    window.addEventListener('click', listener);
    leaf.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); // materialises wrappers
    const c = crossings(() => {
      for (let i = 0; i < 10; i++) leaf.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(c).toEqual({});
    expect(calls).toBe(33);
  });

  it.skipIf(!rt.shared)('checkbox activation crosses only for preActivate / cancelActivation', () => {
    const { window, document } = createWindow();
    document.body.innerHTML = '<input type="checkbox" id="c">';
    const cb = document.getElementById('c');
    let change = 0;
    cb.addEventListener('change', () => change++);
    expect(crossings(() => cb.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))).toEqual({ preActivate: 1 });
    expect([cb.checked, change]).toEqual([true, 1]);
    const stop = (e) => e.preventDefault();
    cb.addEventListener('click', stop);
    expect(crossings(() => cb.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))).toEqual({ preActivate: 1, cancelActivation: 1 });
    expect(cb.checked).toBe(true);
    // checked / activeElement / type are table reads
    expect(crossings(() => [cb.checked, cb.type, document.activeElement])).toEqual({});
  });
});

describe('form state', () => {
  it('value memo: one crossing per FORM_VER', () => {
    const { document } = createWindow();
    const i = document.createElement('input');
    i.value = 'abc';
    // (fallback mode adds `rec` record refreshes; count the value crossings only)
    // the setter seeds the memo when Rust reports that the stored value is the argument
    expect(crossings(() => i.value).valueGet).toBe(rt.flags.MEMO ? undefined : 1);
    const j = document.createElement('input');
    j.setAttribute('value', 'xyz'); // a clean input follows its attribute: the memo is stale
    const first = crossings(() => j.value);
    expect(first.valueGet).toBe(1);
    const again = crossings(() => [j.value, j.value, j.value]);
    expect(again.valueGet).toBe(rt.flags.MEMO ? undefined : 3);
    const fv = rt.field(i._i, rt.F.FORM_VER);
    i.value = 'abcd';
    expect(rt.field(i._i, rt.F.FORM_VER)).not.toBe(fv);
    expect(i.value).toBe('abcd');
    i.setAttribute('type', 'checkbox'); // value mode change invalidates through the type hook
    expect(i.value).toBe('abcd'); // text -> checkbox wrote the value attribute
    i.removeAttribute('value');
    expect(i.value).toBe('on');
  });

  it('parser-created controls carry their state bits (hook_parsed)', () => {
    const { document } = createWindow();
    const host = document.createElement('div'); // detached: no per-node connected hooks
    host.innerHTML = '<input type="checkbox" checked><input type="radio" name="g" checked><input type="radio" name="g" checked>'
      + '<select><option>a</option><option selected>b</option></select><input type="number" value="x">';
    const [cb, r1, r2, sel, num] = host.children;
    const st = (el) => rt.field(el._i, rt.F.STATE);
    expect(st(cb) & rt.S.CHECKED).toBe(rt.S.CHECKED);
    // detached: both radios stay checked (jsdom parity: group exclusivity applies on insertion steps)
    expect([r1.checked, r2.checked]).toEqual([true, true]);
    document.body.appendChild(host);
    expect([r1.checked, r2.checked]).toEqual([true, false]);
    expect([sel.selectedIndex, sel.value]).toEqual([1, 'b']);
    expect([num.type, num.value]).toEqual(['number', '']);
  });

  it('clone copies form state', () => {
    const { document } = createWindow();
    const i = document.createElement('input');
    i.value = 'typed';
    i.setAttribute('type', 'checkbox');
    i.checked = true;
    const c = i.cloneNode();
    expect([c.checked, c.type, c.value]).toEqual([true, 'checkbox', 'typed']);
    const t = document.createElement('textarea');
    t.value = 'dirty';
    expect(t.cloneNode(true).value).toBe('dirty');
  });
});

describe('focus', () => {
  it('EP[14] focus version moves with focus changes; activeElement is EP[FOCUS]', () => {
    const { document } = createWindow();
    document.body.innerHTML = '<input id="a"><input id="b">';
    const v0 = rt.V.EP[14];
    document.getElementById('a').focus();
    expect(rt.V.EP[rt.EPI.FOCUS]).toBe(document.getElementById('a')._i);
    expect(rt.V.EP[14]).not.toBe(v0);
    const styleEpoch = rt.V.EP[rt.EPI.STYLE];
    document.getElementById('b').focus();
    expect(rt.V.EP[rt.EPI.STYLE]).toBe(styleEpoch); // focusing never invalidates style memos
  });

  it('a second window becomes the main document: EP[FOCUS] follows it', () => {
    const first = createWindow();
    first.document.body.innerHTML = '<input id="a">';
    first.document.getElementById('a').focus();
    const second = createWindow();
    expect(second.document.activeElement).toBe(second.document.body);
    expect(first.document.activeElement.id).toBe('a');
  });
});

describe('window target', () => {
  it('installWindow is idempotent and window.event accessor exists', () => {
    const { window, document } = createWindow();
    const wt = events.installWindow(window, document);
    expect(events.installWindow(window, document)).toBe(wt);
    expect(Object.getOwnPropertyDescriptor(window, 'event').get).toBeTypeOf('function');
    expect(window.event).toBe(undefined);
    expect(window.onclick).toBe(null);
  });

  it('unhandled listener errors reach process uncaughtException', () => {
    const { window, document } = createWindow();
    const seen = [];
    const handler = (e) => seen.push(e.message);
    const listeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', handler);
    try {
      document.body.addEventListener('x', () => {
        throw new Error('unhandled!');
      });
      document.body.dispatchEvent(new window.Event('x'));
    } finally {
      process.removeListener('uncaughtException', handler);
      for (const l of listeners) process.on('uncaughtException', l);
    }
    expect(seen).toEqual(['unhandled!']);
  });
});
