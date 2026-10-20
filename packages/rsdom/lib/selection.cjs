'use strict';
// Selection (ROADMAP Stage 3, Selection API; DESIGN §29), ported from
// refs/jsdom/lib/jsdom/living/selection/Selection-impl.js.
//
// A Selection is empty or holds one Range plus a direction. The range is a real Range (lib/range.cjs): addRange
// keeps the caller's object, so getRangeAt(0) returns it and later setStart/setEnd calls on it move the selection.
// anchor and focus are the range's boundaries, swapped when the direction is backwards. Facade state only; one
// Selection per browsing context's document (`doc._sel`). selectionchange is queued on `ctx.queueTask`, as jsdom's
// `_queueATask` does.

const rt = require('./runtime.cjs');
const events = require('./events.cjs');
const { Range, internal: R } = require('./range.cjs');

const { K, TOKEN } = rt;
const { sc, so, ec, eo, setStart_, setEnd_, setStartChecked, setEndChecked, compareBP, nodeLength, rootKey } = R;

let dom = null;

const FORWARDS = 1;
const BACKWARDS = -1;
const DIRECTIONLESS = 0;

// ------------------------------------------------------------------------------------------ arguments

function argc(len, n, method) {
  if (len < n) {
    throw new TypeError(`Failed to execute '${method}' on 'Selection': ${n} argument${n > 1 ? 's' : ''} required, but only ${len} present.`);
  }
}

function nodeArg(v, method, n = 1) {
  if (!(v instanceof dom.Node)) {
    throw new TypeError(`Failed to execute '${method}' on 'Selection': parameter ${n} is not of type 'Node'.`);
  }
  return v;
}

/** WebIDL `Node?`: undefined and null are null. */
function nullableNodeArg(v, method) {
  return v === undefined || v === null ? null : nodeArg(v, method);
}

function rangeArg(v, method) {
  if (!(v instanceof Range)) {
    throw new TypeError(`Failed to execute '${method}' on 'Selection': parameter 1 is not of type 'Range'.`);
  }
  return v;
}

function isDoctype(node) {
  return node._i !== 0 && node.nodeType === K.DOCTYPE;
}

function invalidNodeType() {
  return rt.domError(12, "DocumentType Node can't be used as boundary point.");
}

/** A new Range collapsed at (node, offset); the caller has validated the point. */
function rangeAt(node, offset) {
  const r = new Range(TOKEN);
  setStart_(r, node, offset);
  setEnd_(r, node, offset);
  return r;
}

/** True when both points are in the same tree and equal. */
function samePoint(n1, o1, n2, o2) {
  return rootKey(n1) === rootKey(n2) && compareBP(n1, o1, n2, o2) === 0;
}

// ------------------------------------------------------------------------------------------ Selection

/** The selection's "set the range" (resets the direction to forwards), bound in the static block. */
let associate;

class Selection {
  #doc = null;
  #range = null;
  #dir = DIRECTIONLESS;

  constructor(t = undefined, doc = null) {
    if (t !== TOKEN) throw new TypeError('Illegal constructor');
    this.#doc = doc;
  }

  static {
    associate = (s, r) => {
      const old = s.#range;
      const changed = old !== r && (r === null || old === null
        || !samePoint(sc(r), so(r), sc(old), so(old)) || !samePoint(ec(r), eo(r), ec(old), eo(old)));
      s.#range = r;
      s.#dir = r === null ? DIRECTIONLESS : FORWARDS;
      // Selection API "selectionchange event": a task fires it at the document
      if (changed) {
        const doc = s.#doc;
        doc._ctx?.queueTask(() => events.fire(doc, 'selectionchange'));
      }
    };
  }

  get anchorNode() {
    const r = this.#range;
    if (r === null) return null;
    return this.#dir === FORWARDS ? sc(r) : ec(r);
  }

  get anchorOffset() {
    const r = this.#range;
    if (r === null) return 0;
    return this.#dir === FORWARDS ? so(r) : eo(r);
  }

  get focusNode() {
    const r = this.#range;
    if (r === null) return null;
    return this.#dir === FORWARDS ? ec(r) : sc(r);
  }

  get focusOffset() {
    const r = this.#range;
    if (r === null) return 0;
    return this.#dir === FORWARDS ? eo(r) : so(r);
  }

  get isCollapsed() {
    const r = this.#range;
    return r === null || r.collapsed;
  }

  get rangeCount() {
    return this.#range === null ? 0 : 1;
  }

  get type() {
    const r = this.#range;
    if (r === null) return 'None';
    return r.collapsed ? 'Caret' : 'Range';
  }

  getRangeAt(index) {
    argc(arguments.length, 1, 'getRangeAt');
    if (index >>> 0 !== 0 || this.#range === null) throw rt.domError(5, 'Invalid range index.');
    return this.#range;
  }

  addRange(range) {
    argc(arguments.length, 1, 'addRange');
    rangeArg(range, 'addRange');
    if (this.#range === null && rootKey(sc(range)) === this.#doc._i) associate(this, range);
  }

  removeRange(range) {
    argc(arguments.length, 1, 'removeRange');
    rangeArg(range, 'removeRange');
    if (range !== this.#range) throw rt.domError(2, 'Invalid range.');
    associate(this, null);
  }

  removeAllRanges() {
    associate(this, null);
  }

  empty() {
    associate(this, null);
  }

  collapse(node, offset = 0) {
    argc(arguments.length, 1, 'collapse');
    this.#collapse(nullableNodeArg(node, 'collapse'), offset >>> 0);
  }

  setPosition(node, offset = 0) {
    argc(arguments.length, 1, 'setPosition');
    this.#collapse(nullableNodeArg(node, 'setPosition'), offset >>> 0);
  }

  /** Selection "collapse" / "setPosition" with converted arguments. */
  #collapse(node, offset) {
    if (node === null) {
      associate(this, null);
      return;
    }
    if (isDoctype(node)) throw invalidNodeType();
    if (offset > nodeLength(node)) throw rt.domError(5, 'Invalid range index.');
    if (rootKey(node) !== this.#doc._i) return;
    associate(this, rangeAt(node, offset));
  }

  collapseToStart() {
    const r = this.#range;
    if (r === null) throw rt.domError(6, 'There is no selection to collapse.');
    associate(this, rangeAt(sc(r), so(r)));
  }

  collapseToEnd() {
    const r = this.#range;
    if (r === null) throw rt.domError(6, 'There is no selection to collapse.');
    associate(this, rangeAt(ec(r), eo(r)));
  }

  extend(node, offset = 0) {
    argc(arguments.length, 1, 'extend');
    nodeArg(node, 'extend');
    offset >>>= 0;
    if (rootKey(node) !== this.#doc._i) return;
    const old = this.#range;
    if (old === null) throw rt.domError(6, 'There is no selection to extend.');
    const an = this.anchorNode;
    const ao = this.anchorOffset;
    const r = rangeAt(node, 0);
    if (rootKey(node) !== rootKey(sc(old))) {
      setStartChecked(r, node, offset);
      setEndChecked(r, node, offset);
    } else if (compareBP(an, ao, node, offset) <= 0) {
      setStartChecked(r, an, ao);
      setEndChecked(r, node, offset);
    } else {
      setStartChecked(r, node, offset);
      setEndChecked(r, an, ao);
    }
    associate(this, r);
    this.#dir = compareBP(node, offset, an, ao) === -1 ? BACKWARDS : FORWARDS;
  }

  setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    argc(arguments.length, 4, 'setBaseAndExtent');
    nodeArg(anchorNode, 'setBaseAndExtent', 1);
    anchorOffset >>>= 0;
    nodeArg(focusNode, 'setBaseAndExtent', 3);
    focusOffset >>>= 0;
    if (anchorOffset > nodeLength(anchorNode) || focusOffset > nodeLength(focusNode)) {
      throw rt.domError(5, 'Invalid anchor or focus offset.');
    }
    const doc = this.#doc._i;
    if (rootKey(anchorNode) !== doc || rootKey(focusNode) !== doc) return;
    const backwards = compareBP(focusNode, focusOffset, anchorNode, anchorOffset) === -1;
    const r = new Range(TOKEN);
    if (compareBP(anchorNode, anchorOffset, focusNode, focusOffset) === -1) {
      setStart_(r, anchorNode, anchorOffset);
      setEnd_(r, focusNode, focusOffset);
    } else {
      setStart_(r, focusNode, focusOffset);
      setEnd_(r, anchorNode, anchorOffset);
    }
    associate(this, r);
    this.#dir = backwards ? BACKWARDS : FORWARDS;
  }

  selectAllChildren(node) {
    argc(arguments.length, 1, 'selectAllChildren');
    nodeArg(node, 'selectAllChildren');
    if (isDoctype(node)) throw invalidNodeType();
    if (rootKey(node) !== this.#doc._i) return;
    const r = new Range(TOKEN);
    setStart_(r, node, 0);
    setEnd_(r, node, node._i === 0 ? 0 : node.childNodes.length);
    associate(this, r);
  }

  deleteFromDocument() {
    const r = this.#range;
    // Range.prototype.deleteContents is the ranges thread's (DESIGN §25); until it lands this is a no-op
    if (r !== null && typeof Range.prototype.deleteContents === 'function') Range.prototype.deleteContents.call(r);
  }

  containsNode(node, allowPartialContainment = false) {
    argc(arguments.length, 1, 'containsNode');
    nodeArg(node, 'containsNode');
    const r = this.#range;
    if (r === null || rootKey(node) !== this.#doc._i || rootKey(sc(r)) !== this.#doc._i) return false;
    // jsdom compares strictly (a range starting at (node, 0) does not fully contain node)
    const startBefore = compareBP(sc(r), so(r), node, 0) === -1;
    const endAfter = compareBP(ec(r), eo(r), node, nodeLength(node)) === 1;
    return allowPartialContainment ? startBefore || endAfter : startBefore && endAfter;
  }

  toString() {
    const r = this.#range;
    return r === null ? '' : Range.prototype.toString.call(r);
  }
}

/** The document's Selection (created on first use). */
function selectionOf(doc) {
  return doc._sel ?? (doc._sel = new Selection(TOKEN, doc));
}

function install(rt_, dom_) {
  dom = dom_;
  Object.defineProperty(Selection.prototype, Symbol.toStringTag, { value: 'Selection', configurable: true });
  rt.classes.Selection = Selection;
}

module.exports = { install, Selection, selectionOf };
