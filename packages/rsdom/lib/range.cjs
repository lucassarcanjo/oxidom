'use strict';
// AbstractRange, StaticRange and Range (ROADMAP Stage 3, DOM §5; DESIGN §25), ported from
// refs/jsdom/lib/jsdom/living/range/.
//
// Boundary points are (node wrapper, offset) pairs. Tree positions are read from the zero-FFI node table by id:
// comparing two boundary points lifts the deeper node to the other's depth, climbs both chains to their common
// ancestor and compares the two children below it (refs/jsdom/lib/jsdom/living/range/boundary-point.js), so a
// comparison costs O(depth + siblings), with no native call. Attr nodes (no table id, `_i === 0`) are their own
// root: a range can only be collapsed on one, or lie inside one.

const rt = require('./runtime.cjs');

const { V, F, M, K, TOKEN } = rt;

let dom = null;

const START_TO_START = 0;
const START_TO_END = 1;
const END_TO_END = 2;
const END_TO_START = 3;

// ------------------------------------------------------------------------------------------ table links

const parentOf = (id) => V.T[V.off(id) + F.PARENT];
const firstOf = (id) => V.T[V.off(id) + F.FIRST];
const nextOf = (id) => V.T[V.off(id) + F.NEXT];
const prevOf = (id) => V.T[V.off(id) + F.PREV];
const typeOf = (id) => V.T[V.off(id) + F.META] & M.KIND;

/** True for Text, CDATASection, Comment and ProcessingInstruction (DOM CharacterData). */
function isCharData(t) {
  return t === K.TEXT || t === K.CDATA || t === K.COMMENT || t === K.PI;
}

function isText(t) {
  return t === K.TEXT || t === K.CDATA;
}

/** Index of `id` among its siblings. */
function indexOf(id) {
  let i = 0;
  for (let c = prevOf(id); c > 0; c = prevOf(c)) i++;
  return i;
}

/** The `i`th child of `id`, or 0. */
function childAt(id, i) {
  let c = firstOf(id);
  while (c > 0 && i-- > 0) c = nextOf(c);
  return c;
}

/** DOM "length" of a node: 0 for doctypes and Attrs, the data length of character data, else the child count. */
function nodeLength(node) {
  const id = node._i;
  if (id === 0) return 0;
  const t = typeOf(id);
  if (t === K.DOCTYPE) return 0;
  if (isCharData(t)) return node.data.length;
  return V.T[V.off(id) + F.CHILD_LEN];
}

/** A value identifying `node`'s root: the root's id, or the node itself for an Attr (its own root). */
function rootKey(node) {
  let id = node._i;
  if (id === 0) return node;
  for (let p = parentOf(id); p > 0; p = parentOf(id)) id = p;
  return id;
}

function depthOf(id) {
  let d = 0;
  for (let p = parentOf(id); p > 0; p = parentOf(p)) d++;
  return d;
}

/**
 * DOM "position of a boundary point" relative to another: -1 before, 0 equal, 1 after. Both points must share
 * a root (the callers check).
 */
function compareBP(nodeA, offA, nodeB, offB) {
  if (nodeA === nodeB) return offA === offB ? 0 : offA < offB ? -1 : 1;
  const a0 = nodeA._i;
  const b0 = nodeB._i;
  let a = a0;
  let b = b0;
  let da = depthOf(a);
  let db = depthOf(b);
  // the children of the common ancestor on the way to a0 / b0 (0 while a / b is still the node itself)
  let ca = 0;
  let cb = 0;
  for (; da > db; da--) {
    ca = a;
    a = parentOf(a);
  }
  for (; db > da; db--) {
    cb = b;
    b = parentOf(b);
  }
  while (a !== b) {
    ca = a;
    cb = b;
    a = parentOf(a);
    b = parentOf(b);
  }
  // nodeA is an ancestor of nodeB: ordered by whether offA is past the child of nodeA that holds nodeB
  if (a === a0) return indexOf(cb) < offA ? 1 : -1;
  if (a === b0) return indexOf(ca) < offB ? -1 : 1;
  // disjoint subtrees: the order of the two children
  for (let c = nextOf(ca); c > 0; c = nextOf(c)) if (c === cb) return -1;
  return 1;
}

/** The node after `id`'s subtree in tree order, or 0. */
function nextAfterSubtree(id) {
  for (let n = id; n > 0; n = parentOf(n)) {
    const s = nextOf(n);
    if (s > 0) return s;
  }
  return 0;
}

/** The node after `id` in tree order, or 0. */
function nextInTree(id) {
  const c = firstOf(id);
  return c > 0 ? c : nextAfterSubtree(id);
}

/**
 * The first node at or after boundary point (id, offset) that is not one of its container's earlier children:
 * the child at `offset`, else the node after the container's subtree (character data skips to the latter).
 */
function nodeAfterBoundary(id, offset) {
  if (!isCharData(typeOf(id))) {
    const c = childAt(id, offset);
    if (c > 0) return c;
  }
  return nextAfterSubtree(id);
}

// ------------------------------------------------------------------------------------------ arguments

function argc(len, n, method, iface = 'Range') {
  if (len < n) {
    throw new TypeError(`Failed to execute '${method}' on '${iface}': ${n} argument${n > 1 ? 's' : ''} required, but only ${len} present.`);
  }
}

function nodeArg(v, method, n = 1) {
  if (!(v instanceof dom.Node)) {
    throw new TypeError(`Failed to execute '${method}' on 'Range': parameter ${n} is not of type 'Node'.`);
  }
  return v;
}

function invalidNodeType(msg) {
  return rt.domError(12, msg);
}

/** DOM "set the start or end" step 1-2 checks of a boundary point. */
function validateBP(node, offset) {
  if (node._i !== 0 && typeOf(node._i) === K.DOCTYPE) {
    throw invalidNodeType("DocumentType Node can't be used as boundary point.");
  }
  if (offset > nodeLength(node)) throw rt.domError(5, `The offset ${offset} is larger than the node's length (${nodeLength(node)}).`);
}

/** The parent of `node` (for setStartBefore & co), or InvalidNodeTypeError. */
function parentArg(node) {
  const p = node._i === 0 ? 0 : parentOf(node._i);
  if (p === 0) throw invalidNodeType('The given Node has no parent.');
  return p;
}

// ------------------------------------------------------------------------------------------ interfaces

/** Boundary state accessors, bound in AbstractRange's static block (the fields are private). */
let sc;
let so;
let ec;
let eo;
let setStart_;
let setEnd_;

class AbstractRange {
  #sc = null;
  #so = 0;
  #ec = null;
  #eo = 0;

  constructor(t = undefined) {
    if (t !== TOKEN) throw new TypeError('Illegal constructor');
  }

  static {
    sc = (r) => r.#sc;
    so = (r) => r.#so;
    ec = (r) => r.#ec;
    eo = (r) => r.#eo;
    setStart_ = (r, node, offset) => {
      r.#sc = node;
      r.#so = offset;
    };
    setEnd_ = (r, node, offset) => {
      r.#ec = node;
      r.#eo = offset;
    };
  }

  get startContainer() {
    return this.#sc;
  }

  get startOffset() {
    return this.#so;
  }

  get endContainer() {
    return this.#ec;
  }

  get endOffset() {
    return this.#eo;
  }

  get collapsed() {
    return this.#sc === this.#ec && this.#so === this.#eo;
  }
}

class StaticRange extends AbstractRange {
  constructor(init) {
    argc(arguments.length, 1, 'construct', 'StaticRange');
    if (init === null || (typeof init !== 'object' && typeof init !== 'function')) {
      throw new TypeError("Failed to construct 'StaticRange': The provided value is not of type 'StaticRangeInit'.");
    }
    // dictionary members are read in lexicographic order, each converted as it is read
    const ec0 = member(init, 'endContainer');
    const eo0 = member(init, 'endOffset') >>> 0;
    const sc0 = member(init, 'startContainer');
    const so0 = member(init, 'startOffset') >>> 0;
    super(TOKEN);
    for (const n of [sc0, ec0]) {
      const t = n.nodeType;
      if (t === K.DOCTYPE || t === K.ATTRIBUTE) throw invalidNodeType('The supplied node is incorrect.');
    }
    setStart_(this, sc0, so0);
    setEnd_(this, ec0, eo0);
  }
}

function member(init, key) {
  const v = init[key];
  if (v === undefined) {
    throw new TypeError(`Failed to construct 'StaticRange': required member ${key} is undefined.`);
  }
  if (key.endsWith('Container') && !(v instanceof dom.Node)) {
    throw new TypeError(`Failed to construct 'StaticRange': member ${key} is not of type 'Node'.`);
  }
  return key.endsWith('Offset') ? Number(v) : v;
}

class Range extends AbstractRange {
  /** `new Range()` starts collapsed at the current document; internal callers pass TOKEN and set both points. */
  constructor(t = undefined) {
    super(TOKEN);
    if (t === TOKEN) return;
    const doc = rt.defaultDocument;
    if (doc === null || doc === undefined) throw new TypeError('Illegal constructor');
    setStart_(this, doc, 0);
    setEnd_(this, doc, 0);
  }

  get commonAncestorContainer() {
    const s = sc(this);
    const e = ec(this);
    if (s === e || s._i === 0) return s;
    const target = e._i;
    for (let a = s._i; a > 0; a = parentOf(a)) {
      for (let n = target; n > 0; n = parentOf(n)) if (n === a) return dom.wrap(a);
    }
    return null;
  }

  setStart(node, offset) {
    argc(arguments.length, 2, 'setStart');
    setStartChecked(this, nodeArg(node, 'setStart'), offset >>> 0);
  }

  setEnd(node, offset) {
    argc(arguments.length, 2, 'setEnd');
    setEndChecked(this, nodeArg(node, 'setEnd'), offset >>> 0);
  }

  setStartBefore(node) {
    argc(arguments.length, 1, 'setStartBefore');
    const p = parentArg(nodeArg(node, 'setStartBefore'));
    setStartChecked(this, dom.wrap(p), indexOf(node._i));
  }

  setStartAfter(node) {
    argc(arguments.length, 1, 'setStartAfter');
    const p = parentArg(nodeArg(node, 'setStartAfter'));
    setStartChecked(this, dom.wrap(p), indexOf(node._i) + 1);
  }

  setEndBefore(node) {
    argc(arguments.length, 1, 'setEndBefore');
    const p = parentArg(nodeArg(node, 'setEndBefore'));
    setEndChecked(this, dom.wrap(p), indexOf(node._i));
  }

  setEndAfter(node) {
    argc(arguments.length, 1, 'setEndAfter');
    const p = parentArg(nodeArg(node, 'setEndAfter'));
    setEndChecked(this, dom.wrap(p), indexOf(node._i) + 1);
  }

  collapse(toStart = false) {
    if (toStart) setEnd_(this, sc(this), so(this));
    else setStart_(this, ec(this), eo(this));
  }

  selectNode(node) {
    argc(arguments.length, 1, 'selectNode');
    selectNode(this, nodeArg(node, 'selectNode'));
  }

  selectNodeContents(node) {
    argc(arguments.length, 1, 'selectNodeContents');
    nodeArg(node, 'selectNodeContents');
    if (node._i !== 0 && typeOf(node._i) === K.DOCTYPE) {
      throw invalidNodeType("DocumentType Node can't be used as boundary point.");
    }
    setStart_(this, node, 0);
    setEnd_(this, node, nodeLength(node));
  }

  compareBoundaryPoints(how, sourceRange) {
    argc(arguments.length, 2, 'compareBoundaryPoints');
    how = (how >>> 0) & 0xffff; // WebIDL unsigned short
    if (!(sourceRange instanceof Range)) {
      throw new TypeError("Failed to execute 'compareBoundaryPoints' on 'Range': parameter 2 is not of type 'Range'.");
    }
    if (how > END_TO_START) {
      throw rt.domError(7, "The comparison method provided must be one of 'START_TO_START', 'START_TO_END', 'END_TO_END', or 'END_TO_START'.");
    }
    if (rootKey(sc(this)) !== rootKey(sc(sourceRange))) throw rt.domError(8, 'The two Ranges are not in the same tree.');
    switch (how) {
      case START_TO_START:
        return compareBP(sc(this), so(this), sc(sourceRange), so(sourceRange));
      case START_TO_END:
        return compareBP(ec(this), eo(this), sc(sourceRange), so(sourceRange));
      case END_TO_END:
        return compareBP(ec(this), eo(this), ec(sourceRange), eo(sourceRange));
      default:
        return compareBP(sc(this), so(this), ec(sourceRange), eo(sourceRange));
    }
  }

  cloneRange() {
    const r = new Range(TOKEN);
    setStart_(r, sc(this), so(this));
    setEnd_(r, ec(this), eo(this));
    return r;
  }

  detach() {}

  isPointInRange(node, offset) {
    argc(arguments.length, 2, 'isPointInRange');
    nodeArg(node, 'isPointInRange');
    offset >>>= 0;
    if (rootKey(node) !== rootKey(sc(this))) return false;
    validateBP(node, offset);
    return compareBP(node, offset, sc(this), so(this)) !== -1 && compareBP(node, offset, ec(this), eo(this)) !== 1;
  }

  comparePoint(node, offset) {
    argc(arguments.length, 2, 'comparePoint');
    nodeArg(node, 'comparePoint');
    offset >>>= 0;
    if (rootKey(node) !== rootKey(sc(this))) throw rt.domError(8, 'The given Node and the Range are not in the same tree.');
    validateBP(node, offset);
    if (compareBP(node, offset, sc(this), so(this)) === -1) return -1;
    if (compareBP(node, offset, ec(this), eo(this)) === 1) return 1;
    return 0;
  }

  intersectsNode(node) {
    argc(arguments.length, 1, 'intersectsNode');
    nodeArg(node, 'intersectsNode');
    if (rootKey(node) !== rootKey(sc(this))) return false;
    const p = node._i === 0 ? 0 : parentOf(node._i);
    if (p === 0) return true;
    const parent = dom.wrap(p);
    const i = indexOf(node._i);
    return compareBP(parent, i, ec(this), eo(this)) === -1 && compareBP(parent, i + 1, sc(this), so(this)) === 1;
  }

  getBoundingClientRect() {
    return dom.makeRect();
  }

  getClientRects() {
    return [];
  }

  createContextualFragment(fragment) {
    argc(arguments.length, 1, 'createContextualFragment');
    const node = sc(this);
    const id = node._i;
    const t = id === 0 ? K.ATTRIBUTE : typeOf(id);
    let ctx = 0;
    if (t === K.ELEMENT) ctx = id;
    else if (t !== K.DOCUMENT && t !== K.FRAGMENT && id !== 0) {
      const p = parentOf(id);
      if (p > 0 && typeOf(p) === K.ELEMENT) ctx = p;
    }
    // an `html` context in an HTML document parses as `body` (DOM Parsing "createContextualFragment" step 3)
    if (ctx !== 0 && (V.T[V.off(ctx) + F.META] & M.HTML_DOC) !== 0 && dom.isHtml(ctx, rt.lookupAtom('html'))) ctx = 0;
    const doc = t === K.DOCUMENT ? node : node.ownerDocument;
    const fid = rt.checkId(rt.N.parseFragment(ctx, String(fragment), doc._i));
    rt.afterAlloc();
    return dom.wrap(fid);
  }

  toString() {
    const s = sc(this);
    const e = ec(this);
    const s0 = so(this);
    const e0 = eo(this);
    if (s === e && s0 === e0) return '';
    const st = s._i === 0 ? K.ATTRIBUTE : typeOf(s._i);
    const et = e._i === 0 ? K.ATTRIBUTE : typeOf(e._i);
    if (s === e && isCharData(st)) return isText(st) ? s.data.slice(s0, e0) : '';
    if (st === K.ATTRIBUTE) return '';
    let out = isText(st) ? s.data.slice(s0) : '';
    const end = isCharData(et) ? e._i : nodeAfterBoundary(e._i, e0);
    for (let n = nodeAfterBoundary(s._i, s0); n > 0 && n !== end; n = nextInTree(n)) {
      if (isText(typeOf(n))) out += dom.wrap(n).data;
    }
    if (isText(et)) out += e.data.slice(0, e0);
    return out;
  }
}

/** DOM "set the start": an out-of-root or after-end start collapses the range there. */
function setStartChecked(r, node, offset) {
  validateBP(node, offset);
  if (rootKey(node) !== rootKey(sc(r)) || compareBP(node, offset, ec(r), eo(r)) === 1) setEnd_(r, node, offset);
  setStart_(r, node, offset);
}

/** DOM "set the end": an out-of-root or before-start end collapses the range there. */
function setEndChecked(r, node, offset) {
  validateBP(node, offset);
  if (rootKey(node) !== rootKey(sc(r)) || compareBP(node, offset, sc(r), so(r)) === -1) setStart_(r, node, offset);
  setEnd_(r, node, offset);
}

/** DOM "select" a node. */
function selectNode(r, node) {
  const p = dom.wrap(parentArg(node));
  const i = indexOf(node._i);
  setStart_(r, p, i);
  setEnd_(r, p, i + 1);
}

const CONSTANTS = { START_TO_START, START_TO_END, END_TO_END, END_TO_START };

function install(rt_, dom_) {
  dom = dom_;
  for (const C of [AbstractRange, StaticRange, Range]) {
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: C.name, configurable: true });
    rt.classes[C.name] = C;
  }
  for (const [k, v] of Object.entries(CONSTANTS)) {
    Object.defineProperty(Range, k, { value: v, enumerable: true });
    Object.defineProperty(Range.prototype, k, { value: v, enumerable: true });
  }
  rt.define(dom.Document, {
    createRange() {
      const r = new Range(TOKEN);
      setStart_(r, this, 0);
      setEnd_(r, this, 0);
      return r;
    },
  });
}

/**
 * Boundary-point helpers for lib/selection.cjs (DESIGN §29): a Selection's anchor and focus are its range's
 * boundaries, read through the private-field accessors.
 */
const internal = { sc, so, ec, eo, setStart_, setEnd_, setStartChecked, setEndChecked, compareBP, nodeLength, rootKey, validateBP };

module.exports = { install, AbstractRange, StaticRange, Range, internal };
