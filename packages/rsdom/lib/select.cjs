'use strict';
// AREA A (selectors, ROADMAP M3): querySelector(All) on Document/DocumentFragment/Element, matches,
// closest, webkitMatchesSelector, getElementsByTagName/TagNameNS/ClassName/Name (live via
// collections.liveQueryCollection), the SEL cache, the corrected tag prefilter (DESIGN §6.3) and the
// epoch-validated qSA memo.
//
// - SEL: selector string -> compiled entry { id (Rust sel id), flags, t1 (single prefilter tag or -1),
//   tags (Set of lowercase type atoms or null), tagOnly }. Bounded (FIFO eviction frees the Rust side).
// - Prefilter (RSDOM_NO_PREFILTER=1 disables): `matches` on an HTML element of an HTML document whose
//   local-name atom is not one of the selector list's rightmost type selectors returns false with zero
//   FFI; `tagOnly` lists (`a, button`) return true on a tag hit. Never applied to SVG/MathML elements or
//   to elements of XML documents (type selectors are case-sensitive there).
// - qSA memo (RSDOM_NO_MEMO=1 disables): LRU of 64 (root, sel) entries holding the result ids, valid
//   while EP[TREE] / EP[ATTR] are unchanged, plus EP[TEXT] for :empty/:has/value-dependent lists and
//   EP[FORM] / EP[REC] for state-dependent ones (:checked, :focus, ...). Every hit returns a FRESH static
//   NodeList built from the cached ids.

/** Rust `sel_flags` (src/select/mod.rs). */
const SF = Object.freeze({ TAG_ONLY: 1, STATE: 2, FOCUS: 4, PSEUDO_ELEMENT: 8, TEXT: 16 });

const SEL_MAX = 4096;
const MEMO_MAX = 64;

function install(rt, dom) {
  const { N, V, F, M, EPI, flags } = rt;
  const { liveQueryCollection, staticNodeListShared, wrapAll } = require('./collections.cjs');
  const { Element, Document, DocumentFragment, staticNodeListFromIds, wrap } = dom;
  const PREFILTER = flags.PREFILTER;
  const MEMO = flags.MEMO;

  /** @type {Map<string, {id:number, flags:number, t1:number, tags:Set<number>|null, tagOnly:boolean}>} */
  let SEL = new Map();
  /** @type {Map<number, {ids: Uint32Array, first: number, t: number, a: number, x: number, f: number, r: number}>} */
  let MEMO_MAP = new Map();

  rt.onReset(() => {
    SEL = new Map();
    MEMO_MAP = new Map();
  });

  function evict() {
    // FIFO: drop the oldest quarter. Sel ids are reused by Rust, so the memo (keyed by sel id) goes too.
    let n = SEL.size >> 2;
    for (const [k, c] of SEL) {
      if (n-- <= 0) break;
      SEL.delete(k);
      N.selFree(c.id);
    }
    MEMO_MAP.clear();
  }

  function compile(s) {
    const id = N.compileSel(s);
    if (id === 0) throw rt.domError(4, `'${s}' is not a valid selector`);
    const OUT = V.OUT;
    const fl = OUT[0];
    const n = OUT[1];
    let t1 = -1;
    let tags = null;
    if (n === 1) t1 = OUT[2];
    else if (n > 1) {
      tags = new Set();
      for (let i = 0; i < n; i++) tags.add(OUT[2 + i]);
    }
    const c = { id, flags: fl, t1, tags, tagOnly: (fl & SF.TAG_ONLY) !== 0 && n > 0 };
    if (SEL.size >= SEL_MAX) evict();
    // Key by an internalized copy: sliced/cons strings (split(), template literals) kept as Map keys make
    // every later SEL lookup ~30 ns slower in V8 (measured: prefilter miss 7 ns -> 39 ns).
    SEL.set(internalize(s), c);
    return c;
  }

  /** Internalized copy of `s` (property keys are internalized strings). */
  function internalize(s) {
    const o = { [s]: 0 };
    for (const k in o) return k;
    return s;
  }

  /** Compiled entry for a selector argument (coerced like WebIDL DOMString). */
  function sel(s) {
    if (typeof s !== 'string') s = String(s);
    const c = SEL.get(s);
    return c !== undefined ? c : compile(s);
  }

  function required(len, method, iface) {
    if (len < 1) {
      throw new TypeError(`Failed to execute '${method}' on '${iface}': 1 argument required, but only 0 present.`);
    }
  }

  // ------------------------------------------------------------------------------------- memo

  function memoKey(c, root, first) {
    // sel ids < 2^26, node ids < 2^27: exact in a double.
    return (c.id * 134217728 + root) * 2 + (first ? 1 : 0);
  }

  function memoGet(c, root, first) {
    const key = memoKey(c, root, first);
    const m = MEMO_MAP.get(key);
    if (m === undefined) return undefined;
    const EP = V.EP;
    if (m.t !== EP[EPI.TREE] || m.a !== EP[EPI.ATTR] || (m.x >= 0 && m.x !== EP[EPI.TEXT])
      || (m.f >= 0 && (m.f !== EP[EPI.FORM] || m.r !== EP[EPI.REC]))) {
      MEMO_MAP.delete(key);
      return undefined;
    }
    // LRU: most recently used last.
    MEMO_MAP.delete(key);
    MEMO_MAP.set(key, m);
    return m;
  }

  function memoPut(c, root, first, ids, one) {
    if (MEMO_MAP.size >= MEMO_MAX) MEMO_MAP.delete(MEMO_MAP.keys().next().value);
    const EP = V.EP;
    const state = (c.flags & SF.STATE) !== 0;
    const m = {
      ids,
      /** wrappers of `ids` (querySelectorAll: shared by every NodeList built from this entry) */
      w: null,
      first: one,
      t: EP[EPI.TREE],
      a: EP[EPI.ATTR],
      x: (c.flags & SF.TEXT) !== 0 || state ? EP[EPI.TEXT] : -1,
      f: state ? EP[EPI.FORM] : -1,
      r: state ? EP[EPI.REC] : -1,
    };
    MEMO_MAP.set(memoKey(c, root, first), m);
    return m;
  }

  /**
   * querySelectorAll result list (a fresh NodeList each call, as the spec requires). The memo entry keeps
   * the wrapper array, shared by every NodeList built from it (static lists never mutate it).
   */
  function qsaList(root, c) {
    if (MEMO) {
      const m = memoGet(c, root, false);
      if (m !== undefined) return staticNodeListShared(m.w);
    }
    const ids = rt.outIds(N.qsa(root, c.id));
    const ws = wrapAll(ids);
    if (MEMO) memoPut(c, root, false, ids, 0).w = ws;
    return staticNodeListShared(ws);
  }

  function qsId(root, c) {
    if (MEMO) {
      const m = memoGet(c, root, true);
      if (m !== undefined) return m.first;
    }
    const id = N.qs(root, c.id);
    if (MEMO) memoPut(c, root, true, null, id);
    return id;
  }

  // ------------------------------------------------------------------------------ ParentNode

  const QueryMixin = {
    querySelector(selectors) {
      required(arguments.length, 'querySelector', this.constructor.name);
      return wrap(qsId(this._i, sel(selectors)));
    },
    querySelectorAll(selectors) {
      required(arguments.length, 'querySelectorAll', this.constructor.name);
      return qsaList(this._i, sel(selectors));
    },
  };
  rt.define(Element, QueryMixin);
  rt.define(Document, QueryMixin);
  rt.define(DocumentFragment, QueryMixin);

  // --------------------------------------------------------------------------- matches/closest

  function matches(selectors) {
    required(arguments.length, 'matches', 'Element');
    const c = sel(selectors);
    const id = this._i;
    if (PREFILTER) {
      const o = V.off(id);
      if ((V.T[o + F.META] & (M.NS_MASK | M.HTML_DOC)) === M.HTML_DOC) {
        const t = V.T[o + F.LOCAL];
        if (c.t1 >= 0) {
          if (t !== c.t1) return false;
          if (c.tagOnly) return true;
        } else if (c.tags !== null) {
          if (!c.tags.has(t)) return false;
          if (c.tagOnly) return true;
        }
      }
    }
    return N.matches(id, c.id);
  }

  rt.define(Element, {
    matches,
    webkitMatchesSelector: matches,
    closest(selectors) {
      required(arguments.length, 'closest', 'Element');
      return wrap(N.closest(this._i, sel(selectors).id));
    },
  });

  // ------------------------------------------------------------------------ getElementsBy*

  /** Live collection over a Rust query; `key` must be a Rust-written version (sums of epochs grow). */
  function live(key, run) {
    return liveQueryCollection({
      key,
      items() {
        const ids = rt.outIds(run());
        const a = new Array(ids.length);
        for (let i = 0; i < ids.length; i++) a[i] = wrap(ids[i]);
        return a;
      },
    });
  }

  const treeKey = () => V.EP[EPI.TREE];
  const treeAttrKey = () => V.EP[EPI.TREE] + V.EP[EPI.ATTR];

  const ByMixin = {
    getElementsByTagName(qualifiedName) {
      required(arguments.length, 'getElementsByTagName', this.constructor.name);
      const root = this._i;
      const name = String(qualifiedName);
      return live(treeKey, () => N.byTag(root, name));
    },
    getElementsByTagNameNS(namespace, localName) {
      const root = this._i;
      const ns = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
      const local = String(localName);
      return live(treeKey, () => N.byTagNS(root, ns, local));
    },
    getElementsByClassName(classNames) {
      required(arguments.length, 'getElementsByClassName', this.constructor.name);
      const root = this._i;
      const names = String(classNames);
      return live(treeAttrKey, () => N.byClass(root, names));
    },
  };
  rt.define(Element, ByMixin);
  rt.define(Document, ByMixin);

  rt.define(Document, {
    // A NodeList per spec. Divergence: a static snapshot (the core has no live query NodeList); jsdom
    // returns a live list. getElementsByName is rare in tests and usually read immediately.
    getElementsByName(elementName) {
      required(arguments.length, 'getElementsByName', 'Document');
      return staticNodeListFromIds(rt.outIds(N.byName(this._i, String(elementName))));
    },
  });

  // Exposed for tests / benches (not part of the DOM surface).
  rt.select = { sel, SF, memoSize: () => MEMO_MAP.size, selSize: () => SEL.size };
}

module.exports = { install, SF };
