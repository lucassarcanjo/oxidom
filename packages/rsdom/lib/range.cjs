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

// ------------------------------------------------------------------------------------- live boundary words

/**
 * Live-range boundary words shared with Rust (src/range.rs, DESIGN §25): slot `h - 1` of handle `h` holds
 * [start id, start offset, end id, end offset, bucket document]. This file reads and writes the first four with
 * zero FFI; the mutation natives move them (DOM §5.5 live range steps) and Rust writes the bucket word. A
 * length-tracking view over a resizable ArrayBuffer, bound like the NodeIterator words (traversal.cjs).
 */
const SLOT_WORDS = 5;
const RW_MAX_BYTES = 1 << 25; // 1,677,721 live ranges
let RW = null;
let rwBoundGen = -1;
/** the largest handle Rust may return from the next `rangeNew` (free handles are below it) */
let rwHigh = 1;

/** Makes room for handle `h`'s slot and (re)binds the buffer when it grew or the env is new. */
function rwRoom(h) {
  if (RW === null) RW = new Uint32Array(new ArrayBuffer(64 * SLOT_WORDS * 4, { maxByteLength: RW_MAX_BYTES }));
  const buf = RW.buffer;
  const need = h * SLOT_WORDS * 4;
  let grew = false;
  if (buf.byteLength < need) {
    if (need > RW_MAX_BYTES) throw new RangeError('rsdom: too many live Ranges');
    buf.resize(Math.min(RW_MAX_BYTES, Math.max(need, buf.byteLength * 2)));
    grew = true;
  }
  if (grew || rwBoundGen !== V.envGen) {
    if (rwBoundGen !== V.envGen) rwHigh = 1;
    rt.N.rangeBind(buf);
    rwBoundGen = V.envGen;
  }
}

/** Frees a range's Rust registration once JS no longer holds it (as traversal.cjs does for NodeIterators). */
const registry = new FinalizationRegistry(({ h, gen }) => {
  if (gen === V.envGen) rt.N.rangeFree(h);
});

/** Node document id of a boundary node (0 for an Attr: in no bucket). */
function docOf(node) {
  return node._i === 0 ? 0 : V.T[V.off(node._i) + F.OWNER];
}

// ------------------------------------------------------------------------------------------ interfaces

/** Boundary state accessors, bound in AbstractRange's static block (the fields are private). */
let sc;
let so;
let ec;
let eo;
let setStart_;
let setEnd_;
let makeLive;

/**
 * A StaticRange keeps its boundary points in the four fields. A live Range (`#o >= 0`) keeps them in its slot
 * of the shared words while its env lives; the fields then hold only what the words cannot: Attr containers
 * (id 0), and the last points set from JS, read once the env was reset.
 */
class AbstractRange {
  #sc = null;
  #so = 0;
  #ec = null;
  #eo = 0;
  #o = -1;
  #gen = 0;

  constructor(t = undefined) {
    if (t !== TOKEN) throw new TypeError('Illegal constructor');
  }

  static {
    const live = (r) => r.#o >= 0 && r.#gen === V.envGen;
    sc = (r) => {
      if (!live(r)) return r.#sc;
      const id = RW[r.#o];
      return id === 0 ? r.#sc : dom.wrap(id);
    };
    so = (r) => (live(r) ? RW[r.#o + 1] : r.#so);
    ec = (r) => {
      if (!live(r)) return r.#ec;
      const id = RW[r.#o + 2];
      return id === 0 ? r.#ec : dom.wrap(id);
    };
    eo = (r) => (live(r) ? RW[r.#o + 3] : r.#eo);
    setStart_ = (r, node, offset) => {
      r.#sc = node;
      r.#so = offset;
      if (live(r)) {
        const o = r.#o;
        RW[o] = node._i;
        RW[o + 1] = offset;
        // a point in another document moves the range to that document's bucket (the end follows the start
        // into another root, never alone)
        if (RW[o + 4] !== docOf(node)) rt.N.rangeSync(o / SLOT_WORDS + 1);
      }
    };
    setEnd_ = (r, node, offset) => {
      r.#ec = node;
      r.#eo = offset;
      if (live(r)) {
        RW[r.#o + 2] = node._i;
        RW[r.#o + 3] = offset;
      }
    };
    makeLive = (r, sn, sOff, en, eOff) => {
      r.#sc = sn;
      r.#so = sOff;
      r.#ec = en;
      r.#eo = eOff;
      rwRoom(rwHigh);
      const h = rt.N.rangeNew(sn._i, sOff, en._i, eOff);
      if (h >= rwHigh) rwHigh = h + 1;
      r.#o = (h - 1) * SLOT_WORDS;
      r.#gen = V.envGen;
      registry.register(r, { h, gen: r.#gen });
    };
  }

  get startContainer() {
    return sc(this);
  }

  get startOffset() {
    return so(this);
  }

  get endContainer() {
    return ec(this);
  }

  get endOffset() {
    return eo(this);
  }

  get collapsed() {
    return sc(this) === ec(this) && so(this) === eo(this);
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
    setStart_(this, sc0, so0); // not live: the fields only
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
    makeLive(this, doc, 0, doc, 0);
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

  deleteContents() {
    if (this.collapsed) return;
    const s = sc(this);
    const e = ec(this);
    const s0 = so(this);
    const e0 = eo(this);
    if (s === e && isCharDataNode(s)) {
      s.replaceData(s0, e0 - s0, '');
      return;
    }
    // the outermost contained nodes, in tree order
    const remove = [];
    const end = isCharDataNode(e) ? e._i : nodeAfterBoundary(e._i, e0);
    for (let n = nodeAfterBoundary(s._i, s0); n > 0 && n !== end; ) {
      if (contained(n, this)) {
        remove.push(n);
        n = nextAfterSubtree(n);
      } else {
        n = nextInTree(n);
      }
    }
    const [nn, no] = collapsedPoint(s, s0, commonInfo(s, e));
    if (isCharDataNode(s)) s.replaceData(s0, nodeLength(s) - s0, '');
    for (const id of remove) {
      const n = dom.wrap(id);
      n.parentNode.removeChild(n);
    }
    if (isCharDataNode(e)) e.replaceData(0, e0, '');
    setStart_(this, nn, no);
    setEnd_(this, nn, no);
  }

  extractContents() {
    return extract(this);
  }

  cloneContents() {
    return cloneContents(this);
  }

  insertNode(node) {
    argc(arguments.length, 1, 'insertNode');
    insertNode(this, nodeArg(node, 'insertNode'));
  }

  surroundContents(newParent) {
    argc(arguments.length, 1, 'surroundContents');
    nodeArg(newParent, 'surroundContents');
    const { left, right } = commonInfo(sc(this), ec(this));
    // a partially contained non-Text node lies on one of the two boundary paths below the common ancestor
    if ((left !== 0 && !isText(typeOf(left))) || (right !== 0 && !isText(typeOf(right)))) {
      throw rt.domError(6, 'The Range partially contains a non-Text node.');
    }
    const t = newParent.nodeType;
    if (t === K.DOCUMENT || t === K.DOCTYPE || t === K.FRAGMENT) throw invalidNodeType('Invalid element type.');
    const fragment = extract(this);
    while (newParent.firstChild !== null) newParent.removeChild(newParent.firstChild);
    insertNode(this, newParent);
    newParent.appendChild(fragment);
    selectNode(this, newParent);
  }

  cloneRange() {
    return newRange(sc(this), so(this), ec(this), eo(this));
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

/** A live range with the given boundary points (createRange, cloneRange and the content methods' subranges). */
function newRange(sn, sOff, en, eOff) {
  const r = new Range(TOKEN);
  makeLive(r, sn, sOff, en, eOff);
  return r;
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

// ------------------------------------------------------------------------------------- content methods

function isCharDataNode(node) {
  return node._i !== 0 && isCharData(typeOf(node._i));
}

/** DOM "contained": node `id` lies entirely between the range's boundary points. */
function contained(id, r) {
  const n = dom.wrap(id);
  return compareBP(n, 0, sc(r), so(r)) === 1 && compareBP(n, nodeLength(n), ec(r), eo(r)) === -1;
}

/**
 * The common ancestor of boundary nodes `a` and `b` (same root) and the children of it on the way to each:
 * `left` holds `a` and `right` holds `b`, 0 where the node is the ancestor itself (as jsdom's
 * `_commonAncestorInfo`). Attr nodes are only ever their own common ancestor.
 */
function commonInfo(a, b) {
  if (a === b || a._i === 0) return { anc: a._i, left: 0, right: 0 };
  let x = a._i;
  let y = b._i;
  let dx = depthOf(x);
  let dy = depthOf(y);
  let cx = 0;
  let cy = 0;
  for (; dx > dy; dx--) {
    cx = x;
    x = parentOf(x);
  }
  for (; dy > dx; dy--) {
    cy = y;
    y = parentOf(y);
  }
  while (x !== y) {
    cx = x;
    cy = y;
    x = parentOf(x);
    y = parentOf(y);
  }
  return { anc: x, left: x === a._i ? 0 : cx, right: x === b._i ? 0 : cy };
}

/** Where extract / delete collapse the range: the start if it holds the end, else just after `left`. */
function collapsedPoint(s, s0, info) {
  return info.anc === s._i ? [s, s0] : [dom.wrap(info.anc), indexOf(info.left) + 1];
}

/** The fully contained children of the common ancestor, checked before anything is mutated. */
function containedChildren(r, info) {
  const start = info.left === 0 ? so(r) : indexOf(info.left) + 1;
  const end = info.right === 0 ? eo(r) : indexOf(info.right);
  const out = [];
  let c = info.left === 0 ? childAt(info.anc, start) : nextOf(info.left);
  for (let i = start; i < end && c > 0; i++, c = nextOf(c)) {
    if (typeOf(c) === K.DOCTYPE) throw rt.domError(1, 'Invalid document type element.');
    out.push(dom.wrap(c));
  }
  return out;
}

function nodeDocument(node) {
  return node.nodeType === K.DOCUMENT ? node : node.ownerDocument;
}

/** A shallow clone of character data `node` holding `data`. */
function cloneData(node, data) {
  const c = node.cloneNode(false);
  c.data = data;
  return c;
}

/** DOM "clone the contents" of a live range. */
function cloneContents(r) {
  const s = sc(r);
  const e = ec(r);
  const s0 = so(r);
  const e0 = eo(r);
  const fragment = nodeDocument(s).createDocumentFragment();
  if (s === e && s0 === e0) return fragment;
  if (s === e && isCharDataNode(s)) {
    fragment.appendChild(cloneData(s, s.substringData(s0, e0 - s0)));
    return fragment;
  }
  const info = commonInfo(s, e);
  const kids = containedChildren(r, info);
  if (info.left !== 0) {
    const left = dom.wrap(info.left);
    if (isCharDataNode(left)) {
      fragment.appendChild(cloneData(s, s.substringData(s0, nodeLength(s) - s0)));
    } else {
      const c = fragment.appendChild(left.cloneNode(false));
      c.appendChild(cloneContents(newRange(s, s0, left, nodeLength(left))));
    }
  }
  for (const k of kids) fragment.appendChild(k.cloneNode(true));
  if (info.right !== 0) {
    const right = dom.wrap(info.right);
    if (isCharDataNode(right)) {
      fragment.appendChild(cloneData(e, e.substringData(0, e0)));
    } else {
      const c = fragment.appendChild(right.cloneNode(false));
      c.appendChild(cloneContents(newRange(right, 0, e, e0)));
    }
  }
  return fragment;
}

/** DOM "extract" a live range. */
function extract(r) {
  const s = sc(r);
  const e = ec(r);
  const s0 = so(r);
  const e0 = eo(r);
  const fragment = nodeDocument(s).createDocumentFragment();
  if (s === e && s0 === e0) return fragment;
  if (s === e && isCharDataNode(s)) {
    fragment.appendChild(cloneData(s, s.substringData(s0, e0 - s0)));
    s.replaceData(s0, e0 - s0, '');
    return fragment;
  }
  const info = commonInfo(s, e);
  const kids = containedChildren(r, info);
  const [nn, no] = collapsedPoint(s, s0, info);
  if (info.left !== 0) {
    const left = dom.wrap(info.left);
    if (isCharDataNode(left)) {
      fragment.appendChild(cloneData(s, s.substringData(s0, nodeLength(s) - s0)));
      s.replaceData(s0, nodeLength(s) - s0, '');
    } else {
      const c = fragment.appendChild(left.cloneNode(false));
      c.appendChild(extract(newRange(s, s0, left, nodeLength(left))));
    }
  }
  for (const k of kids) fragment.appendChild(k);
  if (info.right !== 0) {
    const right = dom.wrap(info.right);
    if (isCharDataNode(right)) {
      fragment.appendChild(cloneData(e, e.substringData(0, e0)));
      e.replaceData(0, e0, '');
    } else {
      const c = fragment.appendChild(right.cloneNode(false));
      c.appendChild(extract(newRange(right, 0, e, e0)));
    }
  }
  setStart_(r, nn, no);
  setEnd_(r, nn, no);
  return fragment;
}

/** DOM "insert" a node into a live range. */
function insertNode(r, node) {
  const s = sc(r);
  const s0 = so(r);
  const st = s._i === 0 ? K.ATTRIBUTE : typeOf(s._i);
  if (st === K.PI || st === K.COMMENT || (isText(st) && parentOf(s._i) === 0) || node === s) {
    throw rt.domError(1, 'Invalid start node.');
  }
  // an Attr can neither hold nor be inserted (pre-insertion validity)
  if (s._i === 0 || node._i === 0) throw rt.domError(1);
  let ref = isText(st) ? s._i : childAt(s._i, s0);
  const parent = ref === 0 ? s._i : parentOf(ref);
  rt.check(rt.N.preInsertCheck(node._i, parent, ref));
  if (isText(st)) ref = s.splitText(s0)._i;
  if (node._i === ref) ref = nextOf(ref);
  const np = node.parentNode;
  if (np !== null) np.removeChild(node);
  const p = dom.wrap(parent);
  let offset = ref === 0 ? nodeLength(p) : indexOf(ref);
  offset += node.nodeType === K.FRAGMENT ? nodeLength(node) : 1;
  p.insertBefore(node, dom.wrap(ref));
  if (r.collapsed) setEnd_(r, p, offset);
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
      return newRange(this, 0, this, 0);
    },
  });
}

/**
 * Boundary-point helpers for lib/selection.cjs (DESIGN §29): a Selection's anchor and focus are its range's
 * boundaries, read through the private-field accessors.
 */
const internal = { sc, so, ec, eo, newRange, setStartChecked, setEndChecked, compareBP, nodeLength, rootKey };

module.exports = { install, AbstractRange, StaticRange, Range, internal };
