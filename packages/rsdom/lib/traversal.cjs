'use strict';
// DOM traversal (ROADMAP Stage 1, DOM §6): NodeFilter, NodeIterator, TreeWalker and
// document.createNodeIterator() / createTreeWalker(). Ported from refs/jsdom/lib/jsdom/living/traversal/.
//
// Walks read the parent/child/sibling links of the zero-FFI node table by id and wrap only the nodes they hand
// to a filter or return. A filter callback may run arbitrary code (including node creation, which can replace
// the table), so links are re-read through `V.off()` after every call, never cached.
//
// NodeIterator pre-removing steps (DOM §6.1) must run before every removal, and removals happen inside natives
// (removeChild, the replace-all behind innerHTML / textContent, normalize, ...), which never call into JS
// (CONTRIBUTING §7.1). The first createNodeIterator() in a process wraps those natives on `rt.N`: each wrapper
// works out from its arguments which nodes the call removes, in order, runs the steps for every live iterator
// against a virtual view of the tree in which the earlier removals of the same call already happened, and puts
// the iterators back if the native then fails validation. Until then the natives are untouched, so the feature
// costs nothing on the mutation paths of code that never creates a NodeIterator.

const rt = require('./runtime.cjs');

const { N, V, F, M, K, TOKEN } = rt;

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

/** Live iterators' states (WeakRefs: an iterator nobody holds stops costing anything once collected). */
const live = new Set();

class NodeIterator {
  #s;

  constructor(t = undefined, root = undefined, whatToShow = 0, filter = null) {
    if (t !== TOKEN) illegal();
    const s = makeState(root, whatToShow, filter);
    s.ref = s.rootId; // reference node id (0 = the root itself is an Attr)
    s.before = true; // pointer before reference
    s.candRef = 0; // candidate reference while traversing (0 = none)
    s.candBefore = false;
    this.#s = s;
    live.add(new WeakRef(s));
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
    return s.ref === 0 ? s.root : rt.wrap(s.ref);
  }

  get pointerBeforeReferenceNode() {
    return this.#s.before;
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

/** DOM "traverse" for NodeIterator (refs/jsdom/lib/jsdom/living/traversal/NodeIterator-impl.js). */
function traverse(s, next) {
  if (s.gen !== V.envGen) return null;
  s.candRef = s.ref;
  s.candBefore = s.before;
  let result = -1;
  for (;;) {
    if (next) {
      if (!s.candBefore) {
        const f = following(s.candRef, s.rootId);
        if (f === 0) break;
        s.candRef = f;
      }
      s.candBefore = false;
    } else {
      if (s.candBefore) {
        const p = preceding(s.candRef, s.rootId);
        if (p === 0) break;
        s.candRef = p;
      }
      s.candBefore = true;
    }
    const node = s.candRef;
    let r;
    try {
      r = filterNode(s, node);
    } catch (e) {
      s.candRef = 0;
      throw e;
    }
    if (r === FILTER_ACCEPT) {
      // a removal during the filter callback may have moved the candidate (pre-removing steps)
      s.ref = s.candRef;
      s.before = s.candBefore;
      result = node;
      break;
    }
  }
  s.candRef = 0;
  if (result === -1) return null;
  return result === 0 ? s.root : rt.wrap(result);
}

// ------------------------------------------------------------------------ NodeIterator pre-removing steps

// Virtual tree: links that skip nodes already removed earlier in the same native call (`gone`).
function nextKept(id, gone) {
  let n = nextOf(id);
  while (n > 0 && gone.has(n)) n = nextOf(n);
  return n > 0 ? n : 0;
}
function prevKept(id, gone) {
  let n = prevOf(id);
  while (n > 0 && gone.has(n)) n = prevOf(n);
  return n > 0 ? n : 0;
}
function lastKeptDescendant(id, gone) {
  for (;;) {
    let c = lastOf(id);
    while (c > 0 && gone.has(c)) c = prevOf(c);
    if (!(c > 0)) return id;
    id = c;
  }
}
function isInclusiveAncestor(a, b) {
  for (let n = b; n > 0; n = parentOf(n)) if (n === a) return true;
  return false;
}

/**
 * The new [reference, pointerBefore] of one pointer when `removed` is removed (DOM §6.1, as jsdom does it), or
 * null when it does not move. `leaf`: `removed` has no children, so only a pointer at `removed` itself moves
 * (one comparison per iterator for the common single-node removal, however many iterators are alive).
 */
function adjustPointer(s, ref, before, removed, gone, leaf) {
  if (ref === 0 || (leaf ? ref !== removed : !isInclusiveAncestor(removed, ref)) || isInclusiveAncestor(removed, s.rootId)) {
    return null;
  }
  if (before) {
    for (let n = removed; n > 0 && n !== s.rootId; n = parentOf(n)) {
      const sibling = nextKept(n, gone);
      if (sibling > 0) return [sibling, true];
    }
  }
  const prev = prevKept(removed, gone);
  return [prev > 0 ? lastKeptDescendant(prev, gone) : parentOf(removed), false];
}

/**
 * Runs the pre-removing steps of every live iterator for `nodes` (removed in that order by one native call).
 * Returns the iterators it moved with their previous pointers (to undo a call that then fails), or null.
 */
function preRemove(nodes) {
  const gone = new Set();
  let undo = null;
  for (const removed of nodes) {
    if (gone.has(removed) || !(parentOf(removed) > 0)) continue;
    const leaf = !(firstOf(removed) > 0);
    for (const w of live) {
      const s = w.deref();
      if (s === undefined) {
        live.delete(w);
        continue;
      }
      const r = adjustPointer(s, s.ref, s.before, removed, gone, leaf);
      const c = s.candRef === 0 ? null : adjustPointer(s, s.candRef, s.candBefore, removed, gone, leaf);
      if (r === null && c === null) continue;
      (undo ??= []).push([s, s.ref, s.before, s.candRef, s.candBefore]);
      if (r) [s.ref, s.before] = r;
      if (c) [s.candRef, s.candBefore] = c;
    }
    gone.add(removed);
  }
  return undo;
}

function children(id) {
  const out = [];
  for (let c = firstOf(id); c > 0; c = nextOf(c)) out.push(c);
  return out;
}

/** Nodes that inserting `node` removes: a fragment's children, or the node itself if it has a parent. */
function moved(node) {
  if (typeOf(node) === K.FRAGMENT) return children(node);
  return parentOf(node) > 0 ? [node] : [];
}

/** Text nodes normalize() removes, in tree order: empty exclusive Text nodes and the rest of each run. */
function normalizeRemovals(root) {
  const out = [];
  const gone = new Set();
  let n = following(root, root);
  while (n > 0) {
    if (typeOf(n) === K.TEXT && !gone.has(n)) {
      if (N.dataLen(n) === 0) {
        out.push(n);
        gone.add(n);
      } else {
        for (let c = nextOf(n); c > 0 && typeOf(c) === K.TEXT; c = nextOf(c)) {
          out.push(c);
          gone.add(c);
        }
      }
    }
    n = following(n, root);
    while (n > 0 && gone.has(n)) n = following(n, root);
  }
  return out;
}

/** The parent whose children an innerHTML set replaces (a template's contents). */
function innerHTMLTarget(id) {
  const w = rt.wrap(id);
  return w instanceof rt.classes.HTMLTemplateElement ? w.content._i : id;
}

const isParent = (id) => {
  const t = typeOf(id);
  return t === K.ELEMENT || t === K.FRAGMENT;
};

/**
 * native -> (a, b, c, outIds) => the node ids the call removes, in removal order (a, b, c: the native's
 * arguments; outIds: the node list replaceChildren / nodesToNode read from OUT).
 */
const REMOVALS = {
  insertBefore: (a, b) => moved(b),
  appendChild: (a, b) => moved(b),
  removeChild: (a, b) => (parentOf(b) === a ? [b] : []),
  replaceChild: (a, b, c) => (parentOf(c) === a ? [c] : []).concat(moved(b)),
  remove: (a) => [a],
  adopt: (a, b) => (typeOf(b) === K.FRAGMENT ? [] : [b]),
  replaceChildren: (a, b, c, ids) => ids.flatMap(moved).concat(children(a)),
  nodesToNode: (a, b, c, ids) => ids.flatMap(moved),
  normalize: (a) => normalizeRemovals(a),
  textContentSet: (a) => (isParent(a) ? children(a) : []),
  innerHTMLSet: (a) => children(innerHTMLTarget(a)),
  outerHTMLSet: (a) => [a],
};
const READS_OUT = new Set(['replaceChildren', 'nodesToNode']);

let patched = false;

function patchNatives() {
  if (patched) return;
  patched = true;
  for (const name of Object.keys(REMOVALS)) {
    const orig = N[name];
    const removals = REMOVALS[name];
    const readsOut = READS_OUT.has(name);
    // Every removal native takes at most 3 arguments; napi reads its own count and ignores the rest.
    N[name] = function (a, b, c) {
      if (live.size === 0) return orig.call(N, a, b, c);
      // copy the OUT input first: record reads in fallback mode (RSDOM_SHARED=0) reuse OUT
      const ids = readsOut ? Array.from(V.OUT.subarray(0, b)) : null;
      const undo = preRemove(removals(a, b, c, ids));
      if (readsOut) rt.writeOut(ids);
      const r = orig.call(N, a, b, c);
      if (undo !== null && (name === 'nodesToNode' ? r === 0 : typeof r === 'number' && r !== 0)) {
        // newest first: an iterator moved by several removals of this call ends at its original pointers
        for (let i = undo.length - 1; i >= 0; i--) {
          const [s, ref, before, candRef, candBefore] = undo[i];
          s.ref = ref;
          s.before = before;
          s.candRef = candRef;
          s.candBefore = candBefore;
        }
      }
      return r;
    };
  }
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
      const it = new NodeIterator(TOKEN, nodeRoot(root, 'createNodeIterator'), whatToShow >>> 0, filterArg(filter, 'createNodeIterator'));
      patchNatives();
      return it;
    },
  });
  rt.onReset(() => live.clear());
}

module.exports = { install, NodeFilter, TreeWalker, NodeIterator };
