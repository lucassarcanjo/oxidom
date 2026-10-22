'use strict';
// NodeList (live childNodes + static), HTMLCollection (live children + live queries). No Proxies
// (DESIGN §4.3).
//
// LIVE lists: indices are getters installed on the prototype on demand (`installIndices`), each calling
// `_get(i)`, which re-validates against the Rust-written version (`child_ver` / the query's epoch slots;
// lib/memo.cjs) on every read. So a list held across a mutation is always current, also when indexed without
// touching `length` first (live-list semantics, like jsdom). On top of that, every `length` read whose answer
// changed makes the list's OWN enumerable index accessors cover exactly [0, length) (`syncOwn`), so
// `hasOwnProperty(i)` and `Object.keys` match jsdom's Proxies as of the last `length` read (DESIGN §4.3).
// Element lookup uses a cursor cache (Blink's CollectionIndexCache): sequential `list[i]` / iteration and
// `[0]` are O(1), random access walks from the nearest of first / last / cursor. `childNodes.length` is CHILD_LEN (O(1)).
// Measured: ~100 ns per indexed read through the prototype getter (jsdom ~195, happy-dom ~145), ~1 ns
// for own properties; iteration goes through `_get` without the getter.
//
// STATIC lists (querySelectorAll results) are snapshots: own numeric data properties (fast).
//
// Internal state is in #private fields, so Object.keys/entries, JSON.stringify and Vitest's
// `toEqual` (which compares Object.entries of iterables) see only what jsdom exposes: the indices.

const rt = require('./runtime.cjs');
const { MEMO, NODE, nodeVersion, envGen, alive } = require('./memo.cjs');

const { V, F, M, K, TOKEN, W } = rt;

function wrapSlow(id) {
  return rt.wrap(id);
}

/** Local id -> wrapper with an out-of-line slow path (see dom.cjs `wrap`). */
function wrap(id) {
  if (id === 0) return null;
  const w = W[id];
  return w !== undefined ? w : wrapSlow(id);
}

function illegal() {
  throw new TypeError('Illegal constructor');
}

/** Number of index getters installed on NodeList.prototype / HTMLCollection.prototype (grown on demand). */
const IDX = { nl: 0, hc: 0 };

/** Makes `proto[have..]` getters calling `this._get(i)` (non-enumerable; no setter: writes are ignored). */
function installIndices(proto, have, n) {
  const target = Math.max(n, have * 2, 16);
  for (let i = have; i < target; i++) {
    Object.defineProperty(proto, i, {
      get() {
        return this._get(i);
      },
      enumerable: false,
      configurable: true,
    });
  }
  return target;
}

/** Shared own-index getters (`OWN_GET[i]` returns `this._get(i)`), grown on demand. */
const OWN_GET = [];
/** Shared own-index setters (`OWN_SET[i]` calls `this._setIndex(i, v)`). */
const OWN_SET = [];

/**
 * Makes a live list's own index properties cover exactly [0, n) (from `have`): jsdom's lists are Proxies whose
 * supported property indices are own, enumerable properties (`hasOwnProperty(i)`, `Object.keys`). Run on every
 * `length` read whose answer differs from the last one, so they are exact as of the last `length` read; reads
 * past them still reach the prototype getters.
 */
function syncOwn(list, have, n) {
  // a list the user froze or sealed keeps what it has (jsdom refuses the freeze; `length` must keep working)
  if (!Object.isExtensible(list)) return have;
  // a collection with an indexed setter (HTMLOptionsCollection) routes assignments through `_setIndex`
  const settable = '_setIndex' in list; // `in`: a missing property would reach the named-property lookup
  for (let i = have; i < n; i++) {
    let get = OWN_GET[i];
    if (get === undefined) {
      get = OWN_GET[i] = function () {
        // a copy of the descriptors onto another object (Jest's failure diff) reads undefined, not a throw
        return isLiveList(this) ? this._get(i) : undefined;
      };
      OWN_SET[i] = function (v) {
        if (isLiveList(this)) this._setIndex(i, v);
      };
    }
    // Reflect: an index the user redefined as non-configurable is left alone instead of throwing
    Reflect.defineProperty(list, i, { get, set: settable ? OWN_SET[i] : undefined, enumerable: true, configurable: true });
  }
  for (let i = n; i < have; i++) Reflect.deleteProperty(list, i);
  return n;
}

/** True for NodeList / HTMLCollection instances (their static blocks set the brand checks). */
let isNodeList;
let isHTMLCollection;
function isLiveList(o) {
  return isNodeList(o) || isHTMLCollection(o);
}

/** WebIDL array index: a canonical numeric string below 2^32 - 1 (never a named property). */
function isArrayIndex(key) {
  const n = Number(key);
  return n >>> 0 === n && n !== 4294967295 && String(n) === key;
}

/**
 * Named properties without own properties (DESIGN §4.3): jsdom's collections are Proxies whose supported names
 * (`form.elements.email`, `el.attributes.id`) read through to `namedItem`. Here a Proxy sits between `proto`
 * and Object.prototype, so a string key found nowhere on the instance or its interface prototypes reaches
 * `lookup(receiver, key)`, which returns the item or undefined. Nothing is synced on mutation (own name
 * properties re-derived after every change made mutation loops 10-35x slower than jsdom); the price is that
 * names are not own: `in`, `hasOwnProperty`, `Object.keys` and descriptors don't see them (the `has` trap
 * has no receiver). Names the rest of the chain has, array indices (unless `indices`: an interface without an
 * indexed getter) and names starting with `_` never reach `lookup`: the facade keeps its fields (`_i`, `_ev`,
 * lazily set `_ct`, ...) as `_` properties, and a page's `<form name="_ct">` must not answer for one, nor a
 * wrapper's first `this._ev = null` run a lookup on a half-made object.
 */
function installNamedProperties(proto, lookup, { indices = false } = {}) {
  const base = Object.getPrototypeOf(proto);
  const named = (receiver, key) =>
    typeof key === 'string' && key[0] !== '_' && !(key in base) && (indices || !isArrayIndex(key))
      ? lookup(receiver, key)
      : undefined;
  const object = new Proxy(Object.create(base), {
    get(target, key, receiver) {
      const v = named(receiver, key);
      return v !== undefined ? v : Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      // no named setter: assigning a supported name fails (a TypeError in strict code), as in jsdom
      if (named(receiver, key) !== undefined) return false;
      return Reflect.set(target, key, value, receiver);
    },
  });
  Object.setPrototypeOf(proto, object);
}

function ensureNL(n) {
  // eslint-disable-next-line no-use-before-define
  if (n > IDX.nl) IDX.nl = installIndices(LiveNodeList.prototype, IDX.nl, n);
}

function ensureHC(n) {
  if (n > IDX.hc) IDX.hc = installIndices(HTMLCollection.prototype, IDX.hc, n);
}

const ITER_VALUES = 0;
const ITER_KEYS = 1;
const ITER_ENTRIES = 2;

/** Iterator over a NodeList / HTMLCollection / NamedNodeMap: live (re-validates on every step). */
class ListIterator {
  constructor(list, kind) {
    this._l = list;
    this._k = kind;
    this._i = 0;
  }

  next() {
    const l = this._l;
    if (l === null) return { value: undefined, done: true };
    const i = this._i;
    const v = l._get(i);
    if (v === undefined) {
      this._l = null;
      return { value: undefined, done: true };
    }
    this._i = i + 1;
    const k = this._k;
    return { value: k === ITER_VALUES ? v : k === ITER_KEYS ? i : [i, v], done: false };
  }

  [Symbol.iterator]() {
    return this;
  }
}
Object.setPrototypeOf(ListIterator.prototype, Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));
Object.defineProperty(ListIterator.prototype, Symbol.toStringTag, { value: 'Array Iterator', configurable: true });

function isElem(c) {
  return (V.T[V.off(c) + F.META] & M.KIND) === K.ELEMENT;
}

/**
 * Id of the `i`-th entry of the live child list of `p` (`elems`: elements only), walking from the closest
 * of the first child, the last child (when `count` >= 0 is known) and the cursor (`ci`, `cid`; cid 0 =
 * none). Returns 0 when out of range. Loops test `c > 0` so a stale view can never spin.
 */
function walkTo(p, i, count, elems, ci, cid) {
  const dFirst = i;
  const dLast = count >= 0 ? count - 1 - i : Infinity;
  const dCur = cid !== 0 ? (i >= ci ? i - ci : ci - i) : Infinity;
  let idx;
  let c;
  if (dCur <= dFirst && dCur <= dLast) {
    idx = ci;
    c = cid;
  } else if (dLast < dFirst) {
    idx = count - 1;
    c = V.T[V.off(p) + F.LAST];
    if (elems) while (c > 0 && !isElem(c)) c = V.T[V.off(c) + F.PREV];
  } else {
    idx = 0;
    c = V.T[V.off(p) + F.FIRST];
    if (elems) while (c > 0 && !isElem(c)) c = V.T[V.off(c) + F.NEXT];
  }
  while (c > 0 && idx < i) {
    c = V.T[V.off(c) + F.NEXT];
    if (elems) while (c > 0 && !isElem(c)) c = V.T[V.off(c) + F.NEXT];
    idx++;
  }
  while (c > 0 && idx > i) {
    c = V.T[V.off(c) + F.PREV];
    if (elems) while (c > 0 && !isElem(c)) c = V.T[V.off(c) + F.PREV];
    idx--;
  }
  return c > 0 ? c : 0;
}

class NodeList {
  /** live: parent id (0 = static list) */
  #p = 0;
  /** live: child_ver the cursor belongs to */
  #v = -1;
  /** env generation the list was created in (a reset kills live lists) */
  #g = envGen();
  /** cursor: index and id of the last entry returned (id 0 = none) */
  #ci = -1;
  #cid = 0;
  /** static: the entries */
  #a = null;
  /** live: own index properties [0, #own) (syncOwn) */
  #own = 0;

  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
  }

  static {
    isNodeList = (o) => o !== null && typeof o === 'object' && #own in o;
  }

  /** The `childNodes` getter's sync (it knows the length: CHILD_LEN), so lists handed out are current. */
  _own(n) {
    if (n !== this.#own) this.#own = syncOwn(this, this.#own, n);
  }

  static _live(id) {
    // eslint-disable-next-line no-use-before-define
    const l = new LiveNodeList(TOKEN);
    l.#p = id;
    return l;
  }

  /** A static list over `wrappers` (never mutated afterwards: memos may share one array between lists). */
  static _static(wrappers) {
    const l = new NodeList(TOKEN);
    l.#a = wrappers;
    // Highest index first: the elements store is sized once instead of grown entry by entry (~25%
    // faster for hundreds of entries; the object keeps fast elements).
    for (let i = wrappers.length - 1; i >= 0; i--) l[i] = wrappers[i];
    return l;
  }

  /** Re-validates the cursor against the parent's child_ver (kept for area code that calls it). */
  _sync() {
    const p = this.#p;
    if (p === 0 || !alive(this.#g)) return;
    const v = nodeVersion(p, NODE.CHILDREN);
    if (!MEMO || v !== this.#v) {
      this.#v = v;
      this.#cid = 0;
      this.#ci = -1;
    }
  }

  /** Entry `i` or undefined (the indexed-property getter and the iterator use this). */
  _get(i) {
    const p = this.#p;
    if (p === 0) {
      const a = this.#a;
      return a === null ? undefined : a[i];
    }
    if (!alive(this.#g)) return undefined;
    const n = V.T[V.off(p) + F.CHILD_LEN];
    if (!(i >= 0 && i < n)) return undefined;
    // The cursor is a memo of the child list at `#v` (child_ver).
    const ver = nodeVersion(p, NODE.CHILDREN);
    let c;
    if (!MEMO || ver !== this.#v) {
      this.#v = ver;
      c = walkTo(p, i, n, false, -1, 0);
    } else {
      const ci = this.#ci;
      const cid = this.#cid;
      if (i === ci) c = cid;
      else if (i === ci + 1 && cid !== 0) c = V.T[V.off(cid) + F.NEXT];
      else c = walkTo(p, i, n, false, ci, cid);
    }
    if (c <= 0) return undefined;
    this.#ci = i;
    this.#cid = c;
    if (i >= IDX.nl) ensureNL(i + 1);
    const w = W[c];
    return w !== undefined ? w : wrapSlow(c);
  }

  get length() {
    const p = this.#p;
    if (p === 0) {
      const a = this.#a;
      return a === null ? 0 : a.length;
    }
    if (!alive(this.#g)) {
      if (this.#own !== 0) this.#own = syncOwn(this, this.#own, 0);
      return 0;
    }
    const n = V.T[V.off(p) + F.CHILD_LEN];
    if (n > IDX.nl) ensureNL(n);
    if (n !== this.#own) this.#own = syncOwn(this, this.#own, n);
    return n;
  }

  item(index) {
    return this._get(index >>> 0) ?? null;
  }

  forEach(callback, thisArg = undefined) {
    if (typeof callback !== 'function') throw new TypeError('NodeList.forEach: callback is not a function');
    for (let i = 0; ; i++) {
      const v = this._get(i);
      if (v === undefined) return;
      callback.call(thisArg, v, i, this);
    }
  }

  keys() {
    return new ListIterator(this, ITER_KEYS);
  }

  values() {
    return new ListIterator(this, ITER_VALUES);
  }

  entries() {
    return new ListIterator(this, ITER_ENTRIES);
  }
}
NodeList.prototype[Symbol.iterator] = NodeList.prototype.values;
Object.defineProperty(NodeList.prototype, Symbol.toStringTag, { value: 'NodeList', configurable: true });

/**
 * Live NodeLists get the index getters from this intermediate prototype (static lists, which hold own
 * index properties, must not inherit getters: an inherited getter without a setter blocks assignment).
 * `constructor` is NodeList, so `constructor.name`, `instanceof` and the toStringTag are NodeList's.
 */
class LiveNodeList extends NodeList {}
Object.defineProperty(LiveNodeList.prototype, 'constructor', { value: NodeList, writable: true, configurable: true });

/**
 * Index getters exist up to max(INITIAL_INDICES, the largest length any list access has seen); accesses
 * (`childNodes` / `children` getters, `length`, `item`, iteration) grow them. Only a list held across a
 * mutation that grows it past that bound and then indexed past it WITHOUT any of those accesses misses
 * (documented; 256 getters cost ~0.2 ms at load).
 */
const INITIAL_INDICES = 256;
ensureNL(INITIAL_INDICES);

/** Live `childNodes` of node `id`. */
function liveChildNodes(id) {
  return NodeList._live(id);
}

/** Called by the `childNodes` / `children` getters: makes sure `list[i]` getters cover `n` entries. */
function coverIndices(n) {
  if (n > IDX.nl) ensureNL(n);
  if (n > IDX.hc) ensureHC(n);
}

/** Static NodeList over wrappers (querySelectorAll, ...). */
function staticNodeList(nodes) {
  return NodeList._static(Array.from(nodes));
}

/** Wrappers of `ids` (a fresh array). */
function wrapAll(ids) {
  const a = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) a[i] = wrap(ids[i]);
  return a;
}

/** Static NodeList over ids copied out of OUT. */
function staticNodeListFromIds(ids) {
  return NodeList._static(wrapAll(ids));
}

/** Static NodeList over an array of wrappers that the caller never mutates (shared between lists). */
function staticNodeListShared(wrappers) {
  return NodeList._static(wrappers);
}

class HTMLCollection {
  /** live children: parent id (0 = query collection or dead) */
  #p = 0;
  /** children: the parent's child_ver the cached count and cursor belong to */
  #v = -1;
  #g = envGen();
  /** children: element count at #v (-1 = unknown); cursor */
  #n = -1;
  #ci = -1;
  #cid = 0;
  /** query collection: source ({ deps, items() }), its cached items and their `deps` stamp */
  #src = null;
  #a = null;
  #k = null;
  /** own index properties [0, #own) (syncOwn) */
  #own = 0;

  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
  }

  static {
    isHTMLCollection = (o) => o !== null && typeof o === 'object' && #own in o;
  }

  static _children(id) {
    const c = new HTMLCollection(TOKEN);
    c.#p = id;
    return c;
  }

  static _query(src) {
    const c = new HTMLCollection(TOKEN);
    c.#src = src;
    return c;
  }

  /** Re-validates cached state against the Rust-written version (kept for area code that calls it). */
  _sync() {
    if (!alive(this.#g)) {
      this.#p = 0;
      this.#src = null;
      this.#a = null;
      return;
    }
    const src = this.#src;
    if (src !== null) {
      if (this.#a !== null && src.deps.fresh(this.#k)) return;
      this.#k = src.deps.stamp(this.#k);
      this.#a = Array.from(src.items());
      ensureHC(this.#a.length);
      return;
    }
    const p = this.#p;
    if (p === 0) return;
    const v = nodeVersion(p, NODE.CHILDREN);
    if (!MEMO || v !== this.#v) {
      this.#v = v;
      this.#n = -1;
      this.#cid = 0;
      this.#ci = -1;
    }
  }

  #count() {
    if (this.#n < 0) {
      let n = 0;
      for (let c = V.T[V.off(this.#p) + F.FIRST]; c > 0; ) {
        const o = V.off(c);
        if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) n++;
        c = V.T[o + F.NEXT];
      }
      this.#n = n;
      ensureHC(n);
    }
    return this.#n;
  }

  /** Entry `i` or undefined (the indexed-property getter and the iterator use this). */
  _get(i) {
    this._sync();
    if (this.#src !== null) return this.#a[i];
    const p = this.#p;
    if (p === 0 || !(i >= 0)) return undefined;
    const ci = this.#ci;
    const cid = this.#cid;
    let c;
    if (cid !== 0 && i === ci) c = cid;
    else if (cid !== 0 && i === ci + 1) {
      c = V.T[V.off(cid) + F.NEXT];
      while (c > 0 && !isElem(c)) c = V.T[V.off(c) + F.NEXT];
    } else c = walkTo(p, i, this.#n, true, ci, cid);
    if (c <= 0) return undefined;
    this.#ci = i;
    this.#cid = c;
    if (i >= IDX.hc) ensureHC(i + 1);
    const w = W[c];
    return w !== undefined ? w : wrapSlow(c);
  }

  get length() {
    this._sync();
    const n = this.#src !== null ? this.#a.length : this.#p === 0 ? 0 : this.#count();
    if (n !== this.#own) this.#own = syncOwn(this, this.#own, n);
    return n;
  }

  /**
   * Syncs the own indices (a `length` read: one compare when nothing changed) and returns this: the getters of
   * `form.elements`, `select.options`, `document.forms` / `images` / ... and the table collections (DESIGN §4.3).
   */
  _synced() {
    void this.length;
    return this;
  }

  item(index) {
    return this._get(index >>> 0) ?? null;
  }

  namedItem(name) {
    name = String(name);
    if (name === '') return null;
    for (let i = 0; ; i++) {
      const el = this._get(i);
      if (el === undefined) return null;
      if (el.getAttribute('id') === name) return el;
      if (el.namespaceURI === rt.NS.HTML && el.getAttribute('name') === name) return el;
    }
  }

  [Symbol.iterator]() {
    return new ListIterator(this, ITER_VALUES);
  }
}
Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, { value: 'HTMLCollection', configurable: true });
// each element's `id`, then an HTML element's `name` (HTMLCollection's supported property names)
installNamedProperties(HTMLCollection.prototype, (c, key) => (isHTMLCollection(c) ? c.namedItem(key) ?? undefined : undefined));

ensureHC(INITIAL_INDICES);

/** Live `children` of node `id`. */
function liveChildren(id) {
  return HTMLCollection._children(id);
}

/**
 * A live HTMLCollection over a custom query (getElementsByTagName/ClassName/Name: area A; form collections:
 * area B). `src.deps` is a `memo.deps(...)` set naming the epoch slots the result depends on, and
 * `src.items()` returns the current wrappers (array or iterable); items are re-read when a slot changed.
 */
function liveQueryCollection(src) {
  return HTMLCollection._query(src);
}

rt.classes.NodeList = NodeList;
rt.classes.HTMLCollection = HTMLCollection;

module.exports = {
  NodeList, HTMLCollection, liveChildNodes, liveChildren, staticNodeList, staticNodeListFromIds, staticNodeListShared, wrapAll,
  liveQueryCollection,
  ListIterator, installIndices, coverIndices, installNamedProperties,
};
