'use strict';
// DOM traversal (ROADMAP Stage 1, DOM §6): NodeFilter, NodeIterator, TreeWalker and
// document.createNodeIterator() / createTreeWalker(). Ported from refs/jsdom/lib/jsdom/living/traversal/.
//
// Walks read the parent/child/sibling links of the zero-FFI node table by id and wrap only the nodes they hand
// to a filter or return. A filter callback may run arbitrary code (including node creation, which can replace
// the table), so links are re-read through `V.off()` after every call, never cached.
//
// NodeIterator pre-removing steps (DOM §6.1) run in Rust, inside every removal step of the child-list module
// (src/traversal.rs). An iterator's reference and candidate pointers live in a buffer both sides share: this
// file walks and writes them with zero FFI, and the removal natives move them.

const rt = require('./runtime.cjs');

const { N, V, F, M, TOKEN } = rt;

let dom = null;

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

function illegal() {
  throw new TypeError('Illegal constructor');
}

// ------------------------------------------------------------------------------------------ table links

const parentOf = (id) => V.T[V.off(id) + F.PARENT];
const firstOf = (id) => V.T[V.off(id) + F.FIRST];
const lastOf = (id) => V.T[V.off(id) + F.LAST];
const nextOf = (id) => V.T[V.off(id) + F.NEXT];
const prevOf = (id) => V.T[V.off(id) + F.PREV];
const typeOf = (id) => V.T[V.off(id) + F.META] & M.KIND;

// ---------------------------------------------------------------------------------------------- filter

/** WebIDL "call a user object's operation" for the NodeFilter callback interface. */
function callFilter(filter, node) {
  if (typeof filter === 'function') return filter.call(undefined, node);
  const accept = filter.acceptNode; // a Get on every call
  if (typeof accept !== 'function') {
    throw new TypeError("Failed to execute 'acceptNode' on 'NodeFilter': The provided callback is not a function.");
  }
  return accept.call(filter, node);
}

/**
 * DOM "filter": whatToShow, then the callback (re-entry throws), result converted to unsigned short. Id 0 is
 * the root when the root is an Attr (the only node without a table id a traversal can reach).
 */
function filterNode(s, id) {
  if (s.active) throw rt.domError(6, 'Recursive node filtering');
  if (((1 << ((id === 0 ? s.root.nodeType : typeOf(id)) - 1)) & s.whatToShow) === 0) return FILTER_SKIP;
  if (s.filter === null) return FILTER_ACCEPT;
  s.active = true;
  let r;
  try {
    r = callFilter(s.filter, id === 0 ? s.root : rt.wrap(id));
  } finally {
    s.active = false;
  }
  return (r >>> 0) & 0xffff;
}

/** Converts a `NodeFilter?` argument: null/undefined -> null; any object or function is kept as given. */
function filterArg(filter, method) {
  if (filter === undefined || filter === null) return null;
  if (typeof filter !== 'object' && typeof filter !== 'function') {
    throw new TypeError(`Failed to execute '${method}' on 'Document': The provided value is not of type 'NodeFilter'.`);
  }
  return filter;
}

/**
 * Shared private state of a TreeWalker / NodeIterator (`#s`). Root ids are 0 for Attr roots. The ids it keeps
 * belong to the env of `gen`: after `rt.reset()` every traversal step returns null.
 */
function makeState(root, whatToShow, filter) {
  return { root, rootId: root._i, whatToShow, filter, active: false, gen: V.envGen };
}

// ------------------------------------------------------------------------------------------ TreeWalker

class TreeWalker {
  #s;
  /** current node (a wrapper: it may be an Attr, which has no table id) */
  #current;

  constructor(t = undefined, root = undefined, whatToShow = 0, filter = null) {
    if (t !== TOKEN) illegal();
    this.#s = makeState(root, whatToShow, filter);
    this.#current = root;
  }

  get root() {
    return this.#s.root;
  }

  get whatToShow() {
    return this.#s.whatToShow;
  }

  get filter() {
    return this.#s.filter;
  }

  get currentNode() {
    return this.#current;
  }

  set currentNode(node) {
    if (!(node instanceof dom.Node)) {
      throw new TypeError("Failed to set the 'currentNode' property on 'TreeWalker': The provided value is not of type 'Node'.");
    }
    this.#current = node;
  }

  #accept(id) {
    this.#current = rt.wrap(id);
    return this.#current;
  }

  /** Table id of the current node, or 0 (an Attr, or a walker from an env that was reset). */
  #currentId() {
    return this.#s.gen === V.envGen ? this.#current._i : 0;
  }

  parentNode() {
    const s = this.#s;
    let node = this.#currentId();
    while (node > 0 && node !== s.rootId) {
      node = parentOf(node);
      if (node > 0 && filterNode(s, node) === FILTER_ACCEPT) return this.#accept(node);
    }
    return null;
  }

  firstChild() {
    return this.#traverseChildren(true);
  }

  lastChild() {
    return this.#traverseChildren(false);
  }

  previousSibling() {
    return this.#traverseSiblings(false);
  }

  nextSibling() {
    return this.#traverseSiblings(true);
  }

  previousNode() {
    const s = this.#s;
    let node = this.#currentId();
    if (node === 0) return null;
    while (node !== s.rootId) {
      let sibling = prevOf(node);
      while (sibling > 0) {
        node = sibling;
        let result = filterNode(s, node);
        while (result !== FILTER_REJECT && firstOf(node) > 0) {
          node = lastOf(node);
          result = filterNode(s, node);
        }
        if (result === FILTER_ACCEPT) return this.#accept(node);
        sibling = prevOf(node);
      }
      const parent = parentOf(node);
      if (node === s.rootId || !(parent > 0)) return null;
      node = parent;
      if (filterNode(s, node) === FILTER_ACCEPT) return this.#accept(node);
    }
    return null;
  }

  nextNode() {
    const s = this.#s;
    let node = this.#currentId();
    if (node === 0) return null;
    let result = FILTER_ACCEPT;
    for (;;) {
      while (result !== FILTER_REJECT) {
        const child = firstOf(node);
        if (!(child > 0)) break;
        node = child;
        result = filterNode(s, node);
        if (result === FILTER_ACCEPT) return this.#accept(node);
      }
      for (;;) {
        if (node === s.rootId) return null;
        const sibling = nextOf(node);
        if (sibling > 0) {
          node = sibling;
          break;
        }
        node = parentOf(node);
        if (!(node > 0)) return null;
      }
      result = filterNode(s, node);
      if (result === FILTER_ACCEPT) return this.#accept(node);
    }
  }

  #traverseChildren(first) {
    const s = this.#s;
    const current = this.#currentId();
    if (current === 0) return null;
    let node = first ? firstOf(current) : lastOf(current);
    if (!(node > 0)) return null;
    for (;;) {
      const result = filterNode(s, node);
      if (result === FILTER_ACCEPT) return this.#accept(node);
      if (result === FILTER_SKIP) {
        const child = first ? firstOf(node) : lastOf(node);
        if (child > 0) {
          node = child;
          continue;
        }
      }
      for (;;) {
        const sibling = first ? nextOf(node) : prevOf(node);
        if (sibling > 0) {
          node = sibling;
          break;
        }
        const parent = parentOf(node);
        if (!(parent > 0) || parent === s.rootId || parent === current) return null;
        node = parent;
      }
    }
  }

  #traverseSiblings(next) {
    const s = this.#s;
    let node = this.#currentId();
    if (node === 0 || node === s.rootId) return null;
    for (;;) {
      let sibling = next ? nextOf(node) : prevOf(node);
      while (sibling > 0) {
        node = sibling;
        const result = filterNode(s, node);
        if (result === FILTER_ACCEPT) return this.#accept(node);
        sibling = next ? firstOf(node) : lastOf(node);
        if (result === FILTER_REJECT || !(sibling > 0)) sibling = next ? nextOf(node) : prevOf(node);
      }
      node = parentOf(node);
      if (!(node > 0) || node === s.rootId) return null;
      if (filterNode(s, node) === FILTER_ACCEPT) return null;
    }
  }
}

// ---------------------------------------------------------------------------------------- NodeIterator

/**
 * Iterator pointer words shared with Rust (src/traversal.rs, DESIGN §16): slot `h - 1` of handle `h` holds
 * [reference, candidate], each packed `id << 1 | pointer before` (candidate 0 = not traversing). This file
 * reads and writes them with zero FFI between natives; the removal natives move them (pre-removing steps).
 * A length-tracking view over a resizable ArrayBuffer: a resize keeps the data pointer, and `iterBind` tells
 * Rust the new length. Bound once per env (a reset drops the binding with the env).
 */
const SLOT_WORDS = 2;
const IT_MAX_BYTES = 1 << 22; // 524,288 live iterators
let IT = null;
let itBoundGen = -1;

/** Makes room for handle `h`'s slot and (re)binds the buffer when it grew or the env is new. */
function itSlot(h) {
  if (IT === null) IT = new Uint32Array(new ArrayBuffer(64 * SLOT_WORDS * 4, { maxByteLength: IT_MAX_BYTES }));
  const buf = IT.buffer;
  const need = h * SLOT_WORDS * 4;
  let grew = false;
  if (buf.byteLength < need) {
    if (need > IT_MAX_BYTES) throw new RangeError('rsdom: too many live NodeIterators');
    buf.resize(Math.min(IT_MAX_BYTES, Math.max(need, buf.byteLength * 2)));
    grew = true;
  }
  if (grew || itBoundGen !== V.envGen) {
    N.iterBind(buf);
    itBoundGen = V.envGen;
  }
  return (h - 1) * SLOT_WORDS;
}

/**
 * Frees an iterator's Rust registration once JS no longer holds it. A FinalizationRegistry is fine here (DESIGN
 * §0 rejects them for node wrappers, which are hot and carry expandos); a stale callback from a reset env must
 * not free a handle of the new one.
 */
const registry = new FinalizationRegistry(({ h, gen }) => {
  if (gen === V.envGen) N.iterFree(h);
});

class NodeIterator {
  #s;

  constructor(t = undefined, root = undefined, whatToShow = 0, filter = null) {
    if (t !== TOKEN) illegal();
    const s = makeState(root, whatToShow, filter);
    s.h = N.iterNew(s.rootId);
    s.o = itSlot(s.h);
    IT[s.o] = (s.rootId << 1) | 1; // reference = root, pointer before it
    IT[s.o + 1] = 0;
    this.#s = s;
    registry.register(this, { h: s.h, gen: s.gen });
  }

  get root() {
    return this.#s.root;
  }

  get whatToShow() {
    return this.#s.whatToShow;
  }

  get filter() {
    return this.#s.filter;
  }

  get referenceNode() {
    const s = this.#s;
    if (s.gen !== V.envGen) return s.root;
    const ref = IT[s.o] >>> 1;
    return ref === 0 ? s.root : rt.wrap(ref);
  }

  get pointerBeforeReferenceNode() {
    const s = this.#s;
    return s.gen !== V.envGen || (IT[s.o] & 1) !== 0;
  }

  nextNode() {
    return traverse(this.#s, true);
  }

  previousNode() {
    return traverse(this.#s, false);
  }

  detach() {}
}

/** Next node in tree order inside `root` (0 = none). */
function following(id, root) {
  if (id === 0) return 0;
  const child = firstOf(id);
  if (child > 0) return child;
  for (let n = id; n > 0 && n !== root; n = parentOf(n)) {
    const sibling = nextOf(n);
    if (sibling > 0) return sibling;
  }
  return 0;
}

/** Previous node in tree order inside `root` (0 = none). */
function preceding(id, root) {
  if (id === 0 || id === root) return 0;
  let n = prevOf(id);
  if (!(n > 0)) return parentOf(id) > 0 ? parentOf(id) : 0;
  for (let c = lastOf(n); c > 0; c = lastOf(n)) n = c;
  return n;
}

/**
 * DOM "traverse" for NodeIterator (refs/jsdom/lib/jsdom/living/traversal/NodeIterator-impl.js). A filter
 * callback can remove nodes, and the pre-removing steps then move the candidate as well as the reference, so
 * around each callback the candidate sits in the shared slot and is read back after it.
 */
function traverse(s, next) {
  if (s.gen !== V.envGen) return null;
  const o = s.o;
  const user = s.filter !== null;
  let cand = IT[o] >>> 1;
  let candBefore = (IT[o] & 1) !== 0;
  let result = -1;
  for (;;) {
    if (next) {
      if (!candBefore) {
        const f = following(cand, s.rootId);
        if (f === 0) break;
        cand = f;
      }
      candBefore = false;
    } else {
      if (candBefore) {
        const p = preceding(cand, s.rootId);
        if (p === 0) break;
        cand = p;
      }
      candBefore = true;
    }
    const node = cand;
    let r;
    if (user) IT[o + 1] = (cand << 1) | (candBefore ? 1 : 0);
    try {
      r = filterNode(s, node);
    } finally {
      if (user) {
        const c = IT[o + 1];
        cand = c >>> 1;
        candBefore = (c & 1) !== 0;
        IT[o + 1] = 0;
      }
    }
    if (r === FILTER_ACCEPT) {
      IT[o] = (cand << 1) | (candBefore ? 1 : 0);
      result = node;
      break;
    }
  }
  if (result === -1) return null;
  return result === 0 ? s.root : rt.wrap(result);
}

// ------------------------------------------------------------------------------------------ NodeFilter

// WebIDL legacy callback interface object: a function (typeof 'function', not a constructor, no prototype)
// carrying the constants.
const NodeFilter = {
  NodeFilter() {
    illegal();
  },
}.NodeFilter;
const CONSTANTS = {
  FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP,
  SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8,
  SHOW_ENTITY_REFERENCE: 0x10, SHOW_ENTITY: 0x20, SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80,
  SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200, SHOW_DOCUMENT_FRAGMENT: 0x400, SHOW_NOTATION: 0x800,
};
for (const [k, v] of Object.entries(CONSTANTS)) {
  Object.defineProperty(NodeFilter, k, { value: v, writable: false, enumerable: true, configurable: false });
}

// ---------------------------------------------------------------------------------------------- install

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

function install(_rt, d) {
  dom = d;
  tag(TreeWalker);
  tag(NodeIterator);
  rt.classes.NodeFilter = NodeFilter;
  const nodeRoot = (root, method) => {
    if (!(root instanceof d.Node)) {
      throw new TypeError(`Failed to execute '${method}' on 'Document': parameter 1 is not of type 'Node'.`);
    }
    return root;
  };
  rt.define(d.Document, {
    createTreeWalker(root, whatToShow = 0xffffffff, filter = null) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'createTreeWalker' on 'Document': 1 argument required, but only 0 present.");
      return new TreeWalker(TOKEN, nodeRoot(root, 'createTreeWalker'), whatToShow >>> 0, filterArg(filter, 'createTreeWalker'));
    },
    createNodeIterator(root, whatToShow = 0xffffffff, filter = null) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'createNodeIterator' on 'Document': 1 argument required, but only 0 present.");
      return new NodeIterator(TOKEN, nodeRoot(root, 'createNodeIterator'), whatToShow >>> 0, filterArg(filter, 'createNodeIterator'));
    },
  });
}

module.exports = { install, NodeFilter, TreeWalker, NodeIterator };
