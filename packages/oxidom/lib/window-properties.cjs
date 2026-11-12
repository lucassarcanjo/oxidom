'use strict';
// Window's named properties (DESIGN §46): a port of jsdom 30's living/window-properties.js. `window.foo` is the
// child window of the frame named "foo", else the HTML element with id "foo" (or the embed / form / img / object /
// iframe / frame named "foo"), else a live HTMLCollection of them. Like jsdom's, the answer comes from an object in
// the window's prototype chain (a Proxy, as for Document's: collections.cjs `installNamedProperties`), so the
// window's own members and those of the objects above it win.
//
// The answer is memoised per document and name on EP[TREE] and EP[ATTR], so a repeated probe of a missing name
// (`typeof process` on a vm-context window) costs one stamp compare until the document changes. Then `N.winNamed`
// reads the document's id map, and walks the document for name contributors only when the name has some, which is
// memoised on EP[NAMED] (Rust bumps it only when an embed / form / iframe / img / object / frame is connected or
// disconnected or its name / id changes).
const rt = require('./runtime.cjs');

const { N } = rt;

let deps = null;
let idDeps = null;
/** document -> { names: Map<name, { stamp, has }>, ids: Map<name, { stamp, ids }>, colls: Map<name, HTMLCollection> } */
const MEMO = new WeakMap();

function memoOf(doc) {
  let s = MEMO.get(doc);
  if (s === undefined) MEMO.set(doc, (s = { names: new Map(), ids: new Map(), colls: new Map() }));
  return s;
}

/** True if some element of `doc` contributes `name` by its name attribute (memoised on EP[NAMED]). */
function hasNamed(s, doc, name) {
  deps ??= require('./memo.cjs').deps('NAMED');
  let m = s.names.get(name);
  if (m === undefined || !deps.fresh(m.stamp)) {
    if (m === undefined && s.names.size >= 256) s.names.clear(); // probes of many distinct names
    const stamp = deps.stamp(m === undefined ? null : m.stamp);
    m = { stamp, has: N.winNamed(doc._i, name, 1) > 0 };
    s.names.set(name, m);
  }
  return m.has;
}

/** The element ids behind `window[name]` in `doc`, in tree order (memoised on EP[TREE] and EP[ATTR]). */
function namedIds(s, doc, name) {
  idDeps ??= require('./memo.cjs').deps('TREE', 'ATTR');
  let m = s.ids.get(name);
  if (m === undefined || !idDeps.fresh(m.stamp)) {
    if (m === undefined && s.ids.size >= 256) s.ids.clear();
    const stamp = idDeps.stamp(m === undefined ? null : m.stamp);
    m = { stamp, ids: Array.from(rt.outIds(N.winNamed(doc._i, name, hasNamed(s, doc, name) ? 2 : 0))) };
    s.ids.set(name, m);
  }
  return m.ids;
}

/** jsdom `getNamedObject`. */
function namedObject(ctx, name) {
  const doc = ctx.document;
  const s = memoOf(doc);
  const ids = namedIds(s, doc, name);
  if (ids.length === 0) return undefined;
  const frames = require('./frames.cjs');
  for (const id of ids) {
    const el = rt.wrap(id);
    const w = frames.frameWindow(el);
    if (w !== null && el.getAttributeNS(null, 'name') === name) return w;
  }
  if (ids.length === 1) return rt.wrap(ids[0]);
  let c = s.colls.get(name);
  if (c === undefined) {
    const { liveQueryCollection } = require('./collections.cjs');
    c = liveQueryCollection({
      deps: require('./memo.cjs').deps('TREE', 'ATTR'),
      items: () => namedIds(memoOf(doc), doc, name).map((id) => rt.wrap(id)),
    });
    s.colls.set(name, c);
  }
  return c;
}

/** Puts Window's named properties object between window `win` of context `ctx` and its prototype. */
function install(win, ctx) {
  const target = Object.create(Object.getPrototypeOf(win));
  Object.defineProperty(target, Symbol.toStringTag, { value: 'WindowProperties', configurable: true });
  const named = (key) => {
    if (typeof key !== 'string' || key === '' || Reflect.has(target, key)) return undefined;
    if (ctx.closed) return undefined;
    try {
      return namedObject(ctx, key);
    } catch {
      return undefined; // a probe for a missing member must not throw
    }
  };
  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      const v = named(key);
      return v !== undefined ? v : Reflect.get(t, key, receiver);
    },
    // a bare `foo` in the window's realm resolves through [[HasProperty]]; assignments make own properties (the
    // default [[Set]] through the target: named properties are writable data properties)
    has(t, key) {
      return Reflect.has(t, key) || named(key) !== undefined;
    },
  });
  Object.setPrototypeOf(win, proxy);
}

module.exports = { install };
