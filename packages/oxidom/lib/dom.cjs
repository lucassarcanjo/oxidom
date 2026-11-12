'use strict';
// Core DOM classes: EventTarget (base only; area B adds the listener API), Node, Document/HTMLDocument,
// DocumentFragment, DocumentType, Attr, CharacterData/Text/Comment/CDATASection/ProcessingInstruction,
// Element, HTMLElement + every HTML*Element (generated from data/interfaces.json), SVG*, MathMLElement,
// NamedNodeMap, DOMImplementation, DOMParser. Range lives in range.cjs.
//
// Wrappers: `W[id]` identity table, created lazily by `materialize` with zero crossings in shared mode.
// Field order is the same for every node wrapper (stable hidden classes until React adds expandos):
//   _ev (EventTarget listeners), _i (node id), _cn (childNodes), _ch (children), _cs (computed-style memo),
//   _st (CSSStyleDeclaration), _vm (value memo), _at (attribute state: Attr cache + NamedNodeMap)
// CharacterData wrappers have no children/attributes and reuse two foundation fields for the data memo:
//   _ch = DATA_VER the memo was read at, _at = the memoized data string.

const rt = require('./runtime.cjs');
const context = require('./context.cjs');
const interfaces = require('./generated/interfaces.cjs');
const {
  NodeList, HTMLCollection, liveChildNodes, liveChildren, staticNodeListFromIds, ListIterator, installIndices,
  coverIndices, installNamedProperties,
} = require('./collections.cjs');
const { MEMO, NODE, nodeVersion } = require('./memo.cjs');
/** lib/custom-elements.cjs, loaded on the first HTML element creation (it requires this module). */
let CE = null;

const { N, V, EPI, F, M, K, NSC, NS, W, TOKEN } = rt;
const {
  check, checkId, afterAlloc, mutated, atomName, lookupAtom, internAtom, elementAtom, attrNameAtom,
  upperAtom, outIds, writeOut, domError, define, asciiLower,
} = rt;


/**
 * id -> wrapper. Local copy of `rt.wrap` with the materialize slow path out of line: keeps the hot link
 * getters inlinable (measured ~12 ns/node vs ~18 for the cross-module call in a 4096-node walk).
 */
function wrap(id) {
  if (id === 0) return null;
  const w = W[id];
  return w !== undefined ? w : wrapSlow(id);
}

function wrapSlow(id) {
  return rt.wrap(id);
}

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

/** Record offset of wrapper `n` (use `V.T[o + F.X]` right after; do not hold `V.T` across native calls). */
function o_(n) {
  return V.off(n._i);
}

/** Node id of a node argument; throws TypeError like WebIDL conversion does. */
function nodeArg(v, method, iface = 'Node') {
  if (v instanceof Node) {
    if (v._i === 0) throw deadOrAttr(v, method, iface);
    return v._i;
  }
  throw new TypeError(`Failed to execute '${method}' on '${iface}': parameter 1 is not of type 'Node'.`);
}

/** Error for a node argument without a table id: an Attr, or a wrapper from an env that was reset. */
function deadOrAttr(v, method, iface) {
  if (v instanceof Attr) return domError(1, `Failed to execute '${method}' on '${iface}': Attr nodes cannot be inserted.`);
  return domError(6, `Failed to execute '${method}' on '${iface}': the node belongs to a DOM environment that was reset.`);
}

/** Throws TypeError when fewer than `n` arguments were passed (WebIDL required arguments). */
function argc(len, n, method, iface) {
  if (len < n) {
    throw new TypeError(`Failed to execute '${method}' on '${iface}': ${n} argument${n > 1 ? 's' : ''} required, but only ${len} present.`);
  }
}

/** Nullable node argument (0 for null/undefined). */
function optNodeArg(v, method, iface = 'Node') {
  return v === null || v === undefined ? 0 : nodeArg(v, method, iface);
}

// ==================================================================================== EventTarget

/** Base class only. AREA B (events.cjs) installs addEventListener/removeEventListener/dispatchEvent. */
class EventTarget {
  constructor(t = undefined) {
    /** listener registry (area B); null until the first addEventListener */
    this._ev = null;
  }
}
tag(EventTarget);

// ============================================================================================ Node

class Node extends EventTarget {
  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
    super();
    this._i = 0; // materialize() builds table-backed wrappers without this constructor (Object.create)
    this._cn = null;
    this._ch = null;
    this._cs = null;
    this._st = null;
    this._vm = null;
    this._at = null;
  }

  get nodeType() {
    return V.T[V.off(this._i) + F.META] & M.KIND;
  }

  get nodeName() {
    return '';
  }

  get parentNode() {
    return wrap(V.T[V.off(this._i) + F.PARENT]);
  }

  get parentElement() {
    const p = V.T[V.off(this._i) + F.PARENT];
    return p !== 0 && (V.T[V.off(p) + F.META] & M.KIND) === K.ELEMENT ? wrap(p) : null;
  }

  get firstChild() {
    return wrap(V.T[V.off(this._i) + F.FIRST]);
  }

  get lastChild() {
    return wrap(V.T[V.off(this._i) + F.LAST]);
  }

  get previousSibling() {
    return wrap(V.T[V.off(this._i) + F.PREV]);
  }

  get nextSibling() {
    return wrap(V.T[V.off(this._i) + F.NEXT]);
  }

  get childNodes() {
    // Sync on every access so `el.childNodes[i]` is always current; only a list held across a mutation and
    // indexed without touching `length` can be stale (documented caveat, DESIGN §4.3).
    const n = V.T[V.off(this._i) + F.CHILD_LEN];
    if (n > 256) coverIndices(n);
    const l = this._cn ?? (this._cn = liveChildNodes(this._i));
    // own index properties as of now (DESIGN §4.3), so two lists compared with toEqual agree
    l._own(n);
    return l;
  }

  get isConnected() {
    return (V.T[V.off(this._i) + F.META] & M.CONNECTED) !== 0;
  }

  get ownerDocument() {
    const o = V.off(this._i);
    return (V.T[o + F.META] & M.KIND) === K.DOCUMENT ? null : wrap(V.T[o + F.OWNER]);
  }

  get baseURI() {
    const d = this.ownerDocument ?? this;
    return d instanceof Document ? d.URL : 'about:blank';
  }

  hasChildNodes() {
    return V.T[V.off(this._i) + F.CHILD_LEN] !== 0;
  }

  getRootNode(options = undefined) {
    let id = this._i;
    if (id === 0) return this; // Attr (its own root) or a wrapper from a reset env
    for (;;) {
      for (let p = V.T[V.off(id) + F.PARENT]; p > 0; p = V.T[V.off(id) + F.PARENT]) id = p;
      // { composed: true }: the shadow-including root (DESIGN §22)
      if ((V.T[V.off(id) + F.META] & (M.KIND | M.SHADOW)) !== (K.FRAGMENT | M.SHADOW) || options === undefined || options === null
        || !options.composed) return wrap(id);
      id = N.shadowHost(id);
    }
  }

  contains(other) {
    if (other === null || other === undefined) return false;
    if (other === this) return true;
    if (!(other instanceof Node)) nodeArg(other, 'contains');
    const target = other._i;
    const me = this._i;
    if (target === 0 || me === 0) return false; // Attrs are nobody's descendants
    for (let c = target; c > 0; c = V.T[V.off(c) + F.PARENT]) if (c === me) return true;
    return false;
  }

  get nodeValue() {
    return null;
  }

  set nodeValue(_v) {}

  get textContent() {
    return N.textContentGet(this._i);
  }

  set textContent(v) {
    check(N.textContentSet(this._i, v === null || v === undefined ? '' : String(v)));
    afterAlloc();
    mutated();
  }

  appendChild(node) {
    check(N.appendChild(this._i, nodeArg(node, 'appendChild')));
    mutated();
    return node;
  }

  insertBefore(node, child) {
    argc(arguments.length, 2, 'insertBefore', 'Node');
    if (child instanceof Attr) throw domError(2);
    check(N.insertBefore(this._i, nodeArg(node, 'insertBefore'), optNodeArg(child, 'insertBefore')));
    mutated();
    return node;
  }

  removeChild(child) {
    if (child instanceof Attr) throw domError(2);
    check(N.removeChild(this._i, nodeArg(child, 'removeChild')));
    mutated();
    return child;
  }

  replaceChild(node, child) {
    if (child instanceof Attr && node instanceof Node && !(node instanceof Attr)) throw domError(2);
    check(N.replaceChild(this._i, nodeArg(node, 'replaceChild'), nodeArg(child, 'replaceChild')));
    mutated();
    return child;
  }

  cloneNode(deep = false) {
    const id = checkId(N.cloneNode(this._i, !!deep));
    afterAlloc();
    mutated(); // upgrade reactions of cloned custom elements (DESIGN §43)
    const w = wrap(id);
    if (this instanceof Document) {
      // Document cloning steps: URL and content type travel with the clone (kept on the wrapper; a clone
      // has no browsing context).
      w._url = this.URL;
      if (this._ct !== undefined) w._ct = this._ct;
    }
    return w;
  }

  normalize() {
    N.normalize(this._i);
    mutated();
  }

  isEqualNode(other) {
    if (other === null || other === undefined) return false;
    if (!(other instanceof Node)) nodeArg(other, 'isEqualNode');
    if (other instanceof Attr || this instanceof Attr) {
      return other instanceof Attr && this instanceof Attr && this.namespaceURI === other.namespaceURI
        && this.localName === other.localName && this.value === other.value;
    }
    return N.isEqualNode(this._i, other._i);
  }

  isSameNode(other) {
    return this === other;
  }

  compareDocumentPosition(other) {
    if (!(other instanceof Node)) throw new TypeError("Failed to execute 'compareDocumentPosition' on 'Node': parameter 1 is not of type 'Node'.");
    if (this === other) return 0;
    let a = this;
    let b = other;
    let attrA = null;
    let attrB = null;
    if (b instanceof Attr) {
      attrB = b;
      b = b.ownerElement;
    }
    if (a instanceof Attr) {
      attrA = a;
      a = a.ownerElement;
      if (attrB !== null && a !== null && a === b) {
        // Two attributes of the same element: order by position in the attribute list.
        for (const at of a.attributes) {
          if (at === attrB) return Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC | Node.DOCUMENT_POSITION_PRECEDING;
          if (at === attrA) return Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC | Node.DOCUMENT_POSITION_FOLLOWING;
        }
      }
    }
    if (a === null || b === null) {
      return Node.DOCUMENT_POSITION_DISCONNECTED | Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC
        | Node.DOCUMENT_POSITION_PRECEDING;
    }
    if (a === b) {
      // attribute vs. its own element
      if (attrA !== null) return Node.DOCUMENT_POSITION_CONTAINS | Node.DOCUMENT_POSITION_PRECEDING;
      return Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_FOLLOWING;
    }
    let r = N.compareDocumentPosition(a._i, b._i);
    if (attrA !== null && (r & Node.DOCUMENT_POSITION_CONTAINED_BY)) r = Node.DOCUMENT_POSITION_FOLLOWING;
    if (attrB !== null && (r & Node.DOCUMENT_POSITION_CONTAINS)) r = Node.DOCUMENT_POSITION_PRECEDING;
    return r;
  }

  lookupNamespaceURI(prefix) {
    if (prefix === '') prefix = null;
    // DOM "locate a namespace": doctypes and fragments have none; the xml / xmlns prefixes are an element's
    const t = this.nodeType;
    let el = t === 1 ? this : t === 9 ? this.documentElement : t === 2 ? this.ownerElement
      : t === 10 || t === 11 ? null : this.parentElement;
    if (el === null) return null;
    if (prefix === 'xml') return NS.XML;
    if (prefix === 'xmlns') return NS.XMLNS;
    for (; el !== null; el = el.parentElement) {
      if (el.namespaceURI !== null && el.prefix === prefix) return el.namespaceURI;
      const v = prefix === null ? el.getAttributeNS(NS.XMLNS, 'xmlns') : el.getAttributeNS(NS.XMLNS, prefix);
      if (v !== null) return v === '' ? null : v;
    }
    return null;
  }

  lookupPrefix(namespace) {
    if (!namespace) return null;
    let el = this instanceof Element ? this : this instanceof Document ? this.documentElement
      : this instanceof Attr ? this.ownerElement : this.parentElement;
    for (; el !== null; el = el.parentElement) {
      if (el.namespaceURI === namespace && el.prefix !== null) return el.prefix;
    }
    return null;
  }

  isDefaultNamespace(namespace) {
    return (namespace || null) === this.lookupNamespaceURI(null);
  }
}
tag(Node);

const NODE_CONSTANTS = {
  ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, ENTITY_REFERENCE_NODE: 5,
  ENTITY_NODE: 6, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11, NOTATION_NODE: 12, DOCUMENT_POSITION_DISCONNECTED: 1,
  DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8,
  DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
};
for (const [k, v] of Object.entries(NODE_CONSTANTS)) {
  const d = { value: v, writable: false, enumerable: true, configurable: false };
  Object.defineProperty(Node, k, d);
  Object.defineProperty(Node.prototype, k, d);
}

// ------------------------------------------------------------------- mixins: ParentNode / ChildNode

/** The node document id of wrapper `n` (a document is its own). */
function docIdOf(n) {
  return V.T[o_(n) + F.OWNER];
}

/** DOM "convert nodes into a node": strings become Text nodes; several nodes become one fragment. */
function convertNodes(ctx, nodes, method) {
  const doc = docIdOf(ctx);
  const ids = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n instanceof Node) ids[i] = nodeArg(n, method);
    else {
      ids[i] = checkId(N.createText(doc, String(n)));
      afterAlloc();
    }
  }
  if (ids.length === 1) return ids[0];
  writeOut(ids);
  const id = checkId(N.nodesToNode(doc, ids.length));
  afterAlloc();
  return id;
}

const ParentNode = {
  get children() {
    const n = V.T[V.off(this._i) + F.CHILD_LEN];
    if (n > 256) coverIndices(n);
    const l = this._ch ?? (this._ch = liveChildren(this._i));
    l.length; // syncs its own index properties (DESIGN §4.3); the element count is memoised per child_ver
    return l;
  },
  get firstElementChild() {
    for (let c = V.T[V.off(this._i) + F.FIRST]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) return wrap(c);
      c = V.T[o + F.NEXT];
    }
    return null;
  },
  get lastElementChild() {
    for (let c = V.T[V.off(this._i) + F.LAST]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) return wrap(c);
      c = V.T[o + F.PREV];
    }
    return null;
  },
  get childElementCount() {
    let n = 0;
    for (let c = V.T[V.off(this._i) + F.FIRST]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) n++;
      c = V.T[o + F.NEXT];
    }
    return n;
  },
  prepend(...nodes) {
    const node = convertNodes(this, nodes, 'prepend');
    check(N.insertBefore(this._i, node, V.T[V.off(this._i) + F.FIRST]));
    mutated();
  },
  append(...nodes) {
    const node = convertNodes(this, nodes, 'append');
    check(N.appendChild(this._i, node));
    mutated();
  },
  replaceChildren(...nodes) {
    const doc = docIdOf(this);
    const ids = nodes.map((n) => {
      if (n instanceof Node) return nodeArg(n, 'replaceChildren');
      const id = checkId(N.createText(doc, String(n)));
      afterAlloc();
      return id;
    });
    writeOut(ids);
    check(N.replaceChildren(this._i, ids.length));
    afterAlloc();
    mutated();
  },
};

function inArgs(id, nodes) {
  for (const n of nodes) if (n instanceof Node && n._i === id) return true;
  return false;
}

const ChildNode = {
  before(...nodes) {
    const parent = V.T[V.off(this._i) + F.PARENT];
    if (parent === 0) return;
    let prev = V.T[V.off(this._i) + F.PREV];
    while (prev > 0 && inArgs(prev, nodes)) prev = V.T[V.off(prev) + F.PREV];
    const node = convertNodes(this, nodes, 'before');
    const ref = prev === 0 ? V.T[V.off(parent) + F.FIRST] : V.T[V.off(prev) + F.NEXT];
    check(N.insertBefore(parent, node, ref));
    mutated();
  },
  after(...nodes) {
    const parent = V.T[V.off(this._i) + F.PARENT];
    if (parent === 0) return;
    let next = V.T[V.off(this._i) + F.NEXT];
    while (next > 0 && inArgs(next, nodes)) next = V.T[V.off(next) + F.NEXT];
    const node = convertNodes(this, nodes, 'after');
    check(N.insertBefore(parent, node, next));
    mutated();
  },
  replaceWith(...nodes) {
    const parent = V.T[V.off(this._i) + F.PARENT];
    if (parent === 0) return;
    let next = V.T[V.off(this._i) + F.NEXT];
    while (next > 0 && inArgs(next, nodes)) next = V.T[V.off(next) + F.NEXT];
    const node = convertNodes(this, nodes, 'replaceWith');
    if (V.T[V.off(this._i) + F.PARENT] === parent) check(N.replaceChild(parent, node, this._i));
    else check(N.insertBefore(parent, node, next));
    mutated();
  },
  remove() {
    if (V.T[V.off(this._i) + F.PARENT] === 0) return;
    N.remove(this._i);
    mutated();
  },
};

const NonDocumentTypeChildNode = {
  get previousElementSibling() {
    for (let c = V.T[V.off(this._i) + F.PREV]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) return wrap(c);
      c = V.T[o + F.PREV];
    }
    return null;
  },
  get nextElementSibling() {
    for (let c = V.T[V.off(this._i) + F.NEXT]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) return wrap(c);
      c = V.T[o + F.NEXT];
    }
    return null;
  },
};

// =============================================================================== Document & co

class Document extends Node {
  constructor(t = undefined) {
    if (t !== TOKEN) {
      // `new Document()`: a new XML document (content type application/xml) whose wrapper is a Document.
      const id = N.createDocument(1, null);
      afterAlloc();
      const d = materializeAs(id, Document);
      d._url = context.currentDocument()?.URL ?? 'about:blank';
      return d;
    }
    super(t);
  }

  get nodeType() {
    return 9;
  }

  get nodeName() {
    return '#document';
  }

  get textContent() {
    return null;
  }

  set textContent(_v) {}

  get documentElement() {
    for (let c = V.T[V.off(this._i) + F.FIRST]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.ELEMENT) return wrap(c);
      c = V.T[o + F.NEXT];
    }
    return null;
  }

  get doctype() {
    for (let c = V.T[V.off(this._i) + F.FIRST]; c > 0; ) {
      const o = V.off(c);
      if ((V.T[o + F.META] & M.KIND) === K.DOCTYPE) return wrap(c);
      c = V.T[o + F.NEXT];
    }
    return null;
  }

  /** first child of the html root that is an HTML element named one of `atoms` */
  _rootChild(a1, a2 = -1) {
    const root = this.documentElement;
    if (root === null || !isHtml(root._i, A.html)) return null;
    for (let c = V.T[o_(root) + F.FIRST]; c > 0; c = V.T[V.off(c) + F.NEXT]) {
      if (isHtml(c, a1) || isHtml(c, a2)) return wrap(c);
    }
    return null;
  }

  get head() {
    return this._rootChild(A.head);
  }

  get body() {
    return this._rootChild(A.body, A.frameset);
  }

  set body(v) {
    // HTML "The body element" setter.
    if (!(v instanceof HTMLElement) || !(isHtml(v._i, A.body) || isHtml(v._i, A.frameset))) {
      throw domError(1, "Failed to set the 'body' property on 'Document': The new body element is of type '"
        + (v?.tagName ?? typeof v) + "'. It must be either a 'BODY' or 'FRAMESET' element.");
    }
    const old = this.body;
    if (old === v) return;
    if (old !== null) {
      old.parentNode.replaceChild(v, old);
      return;
    }
    const root = this.documentElement;
    if (root === null) throw domError(1);
    root.appendChild(v);
  }

  // jsdom Document-impl.js: an `svg` document element's first SVG `title` child, else the document's first HTML
  // `title`; the element's own Text children only (childTextContent), whitespace stripped and collapsed
  get title() {
    const root = this.documentElement;
    let t;
    if (root !== null && root.localName === 'svg') t = svgTitleOf(root);
    else {
      const id = firstDescendant(this._i, (n) => isHtml(n, A.title));
      t = id === 0 ? null : wrap(id);
    }
    if (t === null) return '';
    let text = '';
    for (const c of t.childNodes) if (c.nodeType === K.TEXT || c.nodeType === K.CDATA) text += c.data;
    return text.replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
  }

  set title(v) {
    const root = this.documentElement;
    if (root === null) return;
    if (root.localName === 'svg') {
      let t = svgTitleOf(root);
      // inside the svg root, as the spec says (jsdom inserts into the document when the root is empty)
      if (t === null) t = root.insertBefore(this.createElementNS(NS.SVG, 'title'), root.firstChild);
      t.textContent = String(v);
      return;
    }
    if (root.namespaceURI !== NS.HTML) return;
    let t = firstDescendant(this._i, (id) => isHtml(id, A.title));
    if (t === 0) {
      const head = this.head;
      if (head === null) return;
      t = checkId(N.createElement(this._i, A.title, 0));
      afterAlloc();
      check(N.appendChild(head._i, t));
    }
    check(N.textContentSet(t, String(v)));
    afterAlloc();
    mutated();
  }

  get URL() {
    // A browsing-context document reads its context's URL (lib/context.cjs, the only copy); others keep theirs.
    const c = this._ctx;
    return c !== undefined ? c.url.href : (this._url ?? 'about:blank');
  }

  get documentURI() {
    return this.URL;
  }

  get defaultView() {
    return this._ctx?.window ?? null;
  }

  get compatMode() {
    return N.quirksMode(this._i) === 2 ? 'BackCompat' : 'CSS1Compat';
  }

  get characterSet() {
    return 'UTF-8';
  }

  get charset() {
    return 'UTF-8';
  }

  get inputEncoding() {
    return 'UTF-8';
  }

  get contentType() {
    if (this._ct !== undefined) return this._ct;
    return (V.T[V.off(this._i) + F.META] & M.HTML_DOC) !== 0 ? 'text/html' : 'application/xml';
  }

  get readyState() {
    // `_ready`: a `JSDOM` document's load sequence (lib/scripts.cjs, DESIGN §45)
    return this._ready ?? 'complete';
  }

  get currentScript() {
    return this._currentScript ?? null;
  }

  // jsdom's open() / write() / writeln() (lib/scripts.cjs, DESIGN §45)
  open() {
    return require('./scripts.cjs').open(this);
  }

  write(...text) {
    require('./scripts.cjs').write(this, text.join(''));
  }

  writeln(...text) {
    require('./scripts.cjs').write(this, text.join('') + '\n');
  }

  get implementation() {
    return this._impl ?? (this._impl = makeImplementation(this));
  }

  createElement(localName, options = undefined) {
    let name = String(localName);
    const html = (V.T[V.off(this._i) + F.META] & M.HTML_DOC) !== 0;
    const isValue = options !== null && typeof options === 'object' && options.is !== undefined ? String(options.is) : null;
    // Non-HTML documents: the HTML namespace when the content type is application/xhtml+xml, else null; the
    // whole name is the local name (`a:b` is not split into a prefix, so needs no namespace)
    if (!html) {
      const id = checkId(N.createElement(this._i, elementAtom(name), this._ct === 'application/xhtml+xml' ? 0 : 3));
      afterAlloc();
      return wrap(id);
    }
    if (/[A-Z]/.test(name)) name = asciiLower(name);
    return this._createHtml(name, isValue, () => N.createElement(this._i, elementAtom(name), 0));
  }

  /** DOM "create an element" in the HTML namespace with the synchronous custom elements flag (DESIGN §43). */
  _createHtml(name, isValue, plain, prefix = null) {
    CE ??= require('./custom-elements.cjs');
    const def = CE.lookup(this, name, isValue);
    if (def !== null) {
      const el = CE.createSync(this, def, name, isValue, prefix);
      mutated();
      return el;
    }
    const id = checkId(plain());
    afterAlloc();
    if (isValue !== null) N.ceSetIs(id, isValue);
    return wrap(id);
  }

  createElementNS(namespace, qualifiedName, options = undefined) {
    const ns = namespace === null || namespace === undefined ? null : String(namespace);
    const qn = String(qualifiedName);
    const plain = () => N.createElementNS(this._i, ns, qn);
    if (ns === NS.HTML) {
      const isValue = options !== null && typeof options === 'object' && options.is !== undefined ? String(options.is) : null;
      // a prefixed name never matches a definition here (the prefix is not carried into a constructed element)
      const c = qn.indexOf(':');
      if (c === -1) return this._createHtml(qn, isValue, plain);
      checkId(N.validateQName(qn)); // the name must be valid before a constructor runs
      return this._createHtml(qn.slice(c + 1), isValue, plain, qn.slice(0, c));
    }
    const id = checkId(plain());
    afterAlloc();
    return wrap(id);
  }

  createTextNode(data) {
    argc(arguments.length, 1, 'createTextNode', 'Document');
    const id = checkId(N.createText(this._i, String(data)));
    afterAlloc();
    return wrap(id);
  }

  createComment(data) {
    argc(arguments.length, 1, 'createComment', 'Document');
    const id = checkId(N.createComment(this._i, String(data)));
    afterAlloc();
    return wrap(id);
  }

  createCDATASection(data) {
    if ((V.T[V.off(this._i) + F.META] & M.HTML_DOC) !== 0) throw domError(7, 'CDATA sections are not supported in HTML documents');
    const id = checkId(N.createCDATA(this._i, String(data)));
    afterAlloc();
    return wrap(id);
  }

  createProcessingInstruction(target, data) {
    const id = checkId(N.createPI(this._i, String(target), String(data)));
    afterAlloc();
    return wrap(id);
  }

  createDocumentFragment() {
    const id = checkId(N.createFragment(this._i));
    afterAlloc();
    return wrap(id);
  }

  createAttribute(localName) {
    let name = String(localName);
    if ((V.T[V.off(this._i) + F.META] & M.HTML_DOC) !== 0 && /[A-Z]/.test(name)) name = asciiLower(name);
    const a = attrNameAtom(name);
    return makeAttr(null, a, 0, 0, a, '', this);
  }

  createAttributeNS(namespace, qualifiedName) {
    const qn = String(qualifiedName);
    const ns = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
    const i = qn.indexOf(':');
    const prefix = i < 0 ? null : qn.slice(0, i);
    const local = i < 0 ? qn : qn.slice(i + 1);
    attrNameAtom(local);
    // DOM "validate and extract" (the namespace half)
    if (prefix !== null && ns === null) throw domError(9);
    if (prefix === 'xml' && ns !== NS.XML) throw domError(9);
    if ((qn === 'xmlns' || prefix === 'xmlns') !== (ns === NS.XMLNS)) throw domError(9);
    return makeAttr(null, internAtom(qn), ns === null ? 0 : internAtom(ns), prefix === null ? 0 : internAtom(prefix), internAtom(local), '', this);
  }

  importNode(node, deep = false) {
    if (node instanceof Attr) return makeAttr(null, node._q, node._n, node._p, node._l, node.value, this);
    const id = checkId(N.importNode(this._i, nodeArg(node, 'importNode', 'Document'), !!deep));
    afterAlloc();
    mutated();
    return wrap(id);
  }

  adoptNode(node) {
    if (node instanceof Attr) {
      // An Attr has no parent, so adopting never detaches it from its element (DOM "adopt" step 2).
      node._doc = this;
      return node;
    }
    check(N.adopt(this._i, nodeArg(node, 'adoptNode', 'Document')));
    mutated();
    return node;
  }

  getElementById(elementId) {
    const a = lookupAtom(String(elementId));
    return a === 0 ? null : wrap(N.byId(this._i, a));
  }

  hasFocus() {
    return true;
  }
}
tag(Document);
define(Document, ParentNode);

// jsdom 30: `HTMLDocument === Document` and HTML documents report `[object Document]` (pinned to jsdom).
const HTMLDocument = Document;
rt.classes.HTMLDocument = Document;

class XMLDocument extends Document {}
tag(XMLDocument);

class DocumentFragment extends Node {
  constructor(t = undefined) {
    if (t !== TOKEN) {
      const doc = context.currentDocument();
      if (doc === null) illegal();
      return doc.createDocumentFragment();
    }
    super(t);
  }

  get nodeType() {
    return 11;
  }

  get nodeName() {
    return '#document-fragment';
  }

  getElementById(elementId) {
    const a = lookupAtom(String(elementId));
    return a === 0 ? null : wrap(N.byId(this._i, a));
  }
}
tag(DocumentFragment);
define(DocumentFragment, ParentNode);

class DocumentType extends Node {
  get nodeType() {
    return 10;
  }

  get nodeName() {
    return this.name;
  }

  get name() {
    return N.doctypeField(this._i, 0);
  }

  get publicId() {
    return N.doctypeField(this._i, 1);
  }

  get systemId() {
    return N.doctypeField(this._i, 2);
  }

  get textContent() {
    return null;
  }

  set textContent(_v) {}
}
tag(DocumentType);
define(DocumentType, ChildNode);

// ================================================================================ CharacterData

/**
 * Data of character-data wrapper `n`, memoized on the wrapper (`_at`) under the node's Rust-written data
 * version (`_ch` = DATA_VER): repeated reads (dom-testing-library's getNodeText on every *ByText query and
 * findBy poll) cost one table read instead of a crossing + string creation. OXIDOM_NO_MEMO=1 disables it.
 */
function charData(n) {
  const id = n._i;
  const ver = nodeVersion(id, NODE.DATA);
  if (MEMO && n._ch === ver) return n._at;
  const s = N.dataGet(id);
  if (MEMO && id !== 0) {
    n._ch = ver;
    n._at = s;
  }
  return s;
}

class CharacterData extends Node {
  get data() {
    return charData(this);
  }

  set data(v) {
    // [LegacyNullToEmptyString] DOMString: null -> '', undefined -> 'undefined'.
    check(N.dataSet(this._i, v === null ? '' : String(v)));
    mutated();
  }

  get nodeValue() {
    return charData(this);
  }

  set nodeValue(v) {
    this.data = v ?? '';
  }

  get textContent() {
    return charData(this);
  }

  set textContent(v) {
    this.data = v ?? '';
  }

  get length() {
    return charData(this).length;
  }

  substringData(offset, count) {
    const d = charData(this);
    offset >>>= 0;
    count >>>= 0;
    if (offset > d.length) throw domError(5);
    return d.substring(offset, offset + count);
  }

  appendData(data) {
    check(N.replaceData(this._i, N.dataLen(this._i), 0, String(data)));
    mutated();
  }

  insertData(offset, data) {
    check(N.replaceData(this._i, offset >>> 0, 0, String(data)));
    mutated();
  }

  deleteData(offset, count) {
    check(N.replaceData(this._i, offset >>> 0, count >>> 0, ''));
    mutated();
  }

  replaceData(offset, count, data) {
    check(N.replaceData(this._i, offset >>> 0, count >>> 0, String(data)));
    mutated();
  }
}
tag(CharacterData);
define(CharacterData, ChildNode);
define(CharacterData, NonDocumentTypeChildNode);

class Text extends CharacterData {
  constructor(t = undefined) {
    if (t !== TOKEN) {
      const doc = context.currentDocument();
      if (doc === null) illegal();
      return doc.createTextNode(t === undefined ? '' : t);
    }
    super(t);
  }

  get nodeType() {
    return 3;
  }

  get nodeName() {
    return '#text';
  }

  splitText(offset) {
    const id = checkId(N.splitText(this._i, offset >>> 0));
    afterAlloc();
    mutated();
    return wrap(id);
  }

  get wholeText() {
    let first = this._i;
    for (let p = V.T[V.off(first) + F.PREV]; p > 0 && isTextKind(p); p = V.T[V.off(p) + F.PREV]) first = p;
    let s = '';
    for (let c = first; c > 0 && isTextKind(c); c = V.T[V.off(c) + F.NEXT]) s += charData(wrap(c));
    return s;
  }

  get assignedSlot() {
    return null;
  }
}
tag(Text);

class CDATASection extends Text {
  get nodeType() {
    return 4;
  }

  get nodeName() {
    return '#cdata-section';
  }
}
tag(CDATASection);

class Comment extends CharacterData {
  constructor(t = undefined) {
    if (t !== TOKEN) {
      const doc = context.currentDocument();
      if (doc === null) illegal();
      return doc.createComment(t === undefined ? '' : t);
    }
    super(t);
  }

  get nodeType() {
    return 8;
  }

  get nodeName() {
    return '#comment';
  }
}
tag(Comment);

class ProcessingInstruction extends CharacterData {
  get nodeType() {
    return 7;
  }

  get nodeName() {
    return this.target;
  }

  get target() {
    return atomName(V.T[V.off(this._i) + F.LOCAL]);
  }
}
tag(ProcessingInstruction);

function isTextKind(id) {
  const k = V.T[V.off(id) + F.META] & M.KIND;
  return k === K.TEXT || k === K.CDATA;
}

// ============================================================================================= Attr

/**
 * Attr nodes are not in the node table (`_i === 0`). Bound attrs (`_el !== null`) read their value from Rust;
 * detached attrs keep it in `_v`. Wrappers are cached per (element, qualified-name atom) for stable identity.
 */
class Attr extends Node {
  get nodeType() {
    return 2;
  }

  get nodeName() {
    return atomName(this._q);
  }

  get name() {
    return atomName(this._q);
  }

  get localName() {
    return atomName(this._l);
  }

  get namespaceURI() {
    return this._n === 0 ? null : atomName(this._n);
  }

  get prefix() {
    return this._p === 0 ? null : atomName(this._p);
  }

  get value() {
    const el = this._el;
    if (el === null) return this._v;
    const v = N.getAttrNSA(el._i, this._n, this._l);
    if (v === null) {
      detachAttr(this, this._v);
      return this._v;
    }
    this._v = v;
    return v;
  }

  set value(v) {
    v = String(v);
    const el = this._el;
    if (el === null) this._v = v;
    else {
      check(N.setAttrNSA(el._i, this._n, this._l, this._p, v));
      this._v = v;
      mutated();
    }
  }

  get nodeValue() {
    return this.value;
  }

  set nodeValue(v) {
    this.value = v ?? ''; // DOMString? : null / undefined -> ''
  }

  get textContent() {
    return this.value;
  }

  set textContent(v) {
    this.value = v ?? '';
  }

  get ownerElement() {
    return this._el;
  }

  get ownerDocument() {
    return this._doc !== null ? this._doc : this._el.ownerDocument;
  }

  get specified() {
    return true;
  }

  get parentNode() {
    return null;
  }

  get isConnected() {
    return false;
  }

  getRootNode(_options = undefined) {
    return this;
  }

  // An Attr is never a parent: insertion throws HierarchyRequestError (pre-insert step 1), removal
  // NotFoundError (the child is not a child of this), after the argument conversion.
  appendChild(node) {
    nodeArgOrAttr(node, 'appendChild');
    throw domError(1);
  }

  insertBefore(node, child) {
    argc(arguments.length, 2, 'insertBefore', 'Node');
    nodeArgOrAttr(node, 'insertBefore');
    throw domError(1);
  }

  replaceChild(node, child) {
    nodeArgOrAttr(node, 'replaceChild');
    nodeArgOrAttr(child, 'replaceChild');
    throw domError(1);
  }

  removeChild(child) {
    nodeArgOrAttr(child, 'removeChild');
    throw domError(2);
  }

  cloneNode() {
    return makeAttr(null, this._q, this._n, this._p, this._l, this.value, this.ownerDocument);
  }
}
tag(Attr);

/** Like `nodeArg`, but an Attr is accepted (returns 0). */
function nodeArgOrAttr(v, method) {
  if (v instanceof Attr) return 0;
  return nodeArg(v, method);
}

function makeAttr(el, q, n, p, l, v, doc) {
  const a = new Attr(TOKEN);
  a._el = el;
  a._q = q;
  a._n = n;
  a._p = p;
  a._l = l;
  a._v = v;
  a._doc = doc;
  return a;
}

/** Attr cache key: (namespace atom, local atom); the common no-namespace case is the local atom itself. */
function attrKey(n, l) {
  return n === 0 ? l : `${n}:${l}`;
}

function detachAttr(attr, lastValue) {
  const el = attr._el;
  if (el === null) return;
  attr._v = lastValue;
  if (attr._doc === null) attr._doc = el.ownerDocument;
  attr._el = null;
  const st = el._at;
  if (st !== null && st.map !== null && st.map.get(attrKey(attr._n, attr._l)) === attr) st.map.delete(attrKey(attr._n, attr._l));
}

/**
 * Per-element attribute state (`_at`): Attr wrappers keyed by (namespace, local name) (`map`, created on
 * first use), the NamedNodeMap, and the getAttribute/hasAttribute memo (`attrMemoPut`): `m` = [atom, value | null | PRESENT,
 * ...] (`n` slots used, at most ATTR_MEMO_MAX) valid while the element's Rust-written `attr_ver` equals `v`.
 */
function attrState(el) {
  return el._at ?? (el._at = { map: null, nnm: null, v: -1, n: 0, m: null });
}

/** The Attr wrapper map of an attribute state. */
function attrMap(st) {
  return st.map ?? (st.map = new Map());
}

const ATTR_MEMO_MAX = 16; // 8 (atom, value) pairs per element

/** Memo value of an attribute known to be present whose value was not read (hasAttribute). */
const PRESENT = {};

/**
 * getAttribute / hasAttribute memo (`attrState`): values per element under its `attr_ver`, which Rust
 * rewrites on every attribute change of the element. Repeated reads (dom-testing-library's role / aria-* /
 * type checks on every query, jest-dom matchers) cost a table read and a short scan instead of a crossing
 * (plus a string creation). OXIDOM_NO_MEMO=1 disables it. Records `v` (a string, null or PRESENT) for
 * atom `a` at version `ver`.
 */
function attrMemoPut(el, ver, a, v) {
  const st = attrState(el);
  if (st.m === null) st.m = new Array(ATTR_MEMO_MAX).fill(null);
  const m = st.m;
  if (st.v !== ver) {
    st.v = ver;
    st.n = 0;
  }
  const n = st.n;
  for (let i = 0; i < n; i += 2) {
    if (m[i] === a) {
      m[i + 1] = v;
      return;
    }
  }
  if (n < ATTR_MEMO_MAX) {
    m[n] = a;
    m[n + 1] = v;
    st.n = n + 2;
  }
}

/** The cached Attr wrapper for an attribute described by atoms (created on first use). */
function attrFor(el, q, n, p, l, v) {
  const map = attrMap(attrState(el));
  const key = attrKey(n, l);
  let a = map.get(key);
  if (a === undefined) {
    a = makeAttr(el, q, n, p, l, v, null);
    map.set(key, a);
  } else {
    a._v = v;
  }
  return a;
}

/**
 * The cached Attr wrapper (if any) of the FIRST attribute whose qualified name is atom `q` (the one
 * removeAttribute/toggleAttribute act on), or undefined.
 */
function cachedAttrByQname(el, q) {
  const st = el._at;
  if (st === null || st.map === null || st.map.size === 0) return undefined;
  const n = N.attrNames(el._i);
  const quads = outIds(n * 4);
  for (let i = 0; i < n; i++) {
    if (quads[i * 4] === q) return st.map.get(attrKey(quads[i * 4 + 1], quads[i * 4 + 3]));
  }
  return undefined;
}

/**
 * Live NamedNodeMap, re-synced against the element's `attr_ver` with one `attrsAll` crossing. Like the live
 * collections, indices are prototype getters (always current) and internal state is #private.
 */
/** Shared own-index getters of NamedNodeMaps (`NNM_GET[i]` returns `this._get(i)`). */
const NNM_GET = [];

class NamedNodeMap {
  #e = null;
  #v = -1;
  #a = [];
  /** own index properties [0, #own) (`#ownIndices`) */
  #own = 0;

  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
  }

  static _for(el) {
    const m = new NamedNodeMap(TOKEN);
    m.#e = el;
    return m;
  }

  _sync() {
    const el = this.#e;
    const ver = nodeVersion(el._i, NODE.ATTRS);
    if (MEMO && ver === this.#v && el._i !== 0) return;
    this.#v = ver;
    const values = N.attrsAll(el._i);
    // OUT = [n, (qname, ns, prefix, local, start16, len16) x n]; EP[OUT_NEED] != 0 means it overflowed.
    const need = V.EP[EPI.OUT_NEED];
    const meta = outIds(need !== 0 ? need : 1 + V.OUT[0] * 6);
    const n = meta[0];
    const st = attrState(el);
    const live = new Set();
    const a = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = 1 + i * 6;
      const v = values.substr(meta[b + 4], meta[b + 5]);
      const at = attrFor(el, meta[b], meta[b + 1], meta[b + 2], meta[b + 3], v);
      live.add(at);
      a[i] = at;
    }
    this.#a = a;
    if (n > NNM_IDX) NNM_IDX = installIndices(NamedNodeMap.prototype, NNM_IDX, n);
    if (st.map !== null) for (const at of st.map.values()) if (!live.has(at)) detachAttr(at, at._v);
    if (n !== this.#own) this.#ownIndices(n);
  }

  /**
   * jsdom's NamedNodeMap is a Proxy whose indices are own enumerable properties: kept exact (from `#own`, the
   * count defined) on every `_sync` that sees a change (the `attributes` getter and every read sync), as shared
   * accessors that read the live map. Names read through `installNamedProperties` (DESIGN §4.3).
   */
  #ownIndices(n) {
    if (!Object.isExtensible(this)) return;
    for (let i = this.#own; i < n; i++) {
      let get = NNM_GET[i];
      if (get === undefined) {
        get = NNM_GET[i] = function () {
          return #e in this ? this._get(i) : undefined;
        };
      }
      Reflect.defineProperty(this, i, { get, enumerable: true, configurable: true });
    }
    for (let i = n; i < this.#own; i++) Reflect.deleteProperty(this, i);
    this.#own = n;
  }

  static {
    // the attributes' qualified names, except names with ASCII uppercase on an HTML element in an HTML document
    installNamedProperties(NamedNodeMap.prototype, (m, key) => {
      if (!(#e in m)) return undefined;
      const el = m.#e;
      if (/[A-Z]/.test(key) && el.namespaceURI === NS.HTML && (V.T[V.off(el._i) + F.META] & M.HTML_DOC) !== 0) return undefined;
      return m.getNamedItem(key) ?? undefined;
    });
  }

  _get(i) {
    this._sync();
    return this.#a[i];
  }

  get length() {
    this._sync();
    return this.#a.length;
  }

  item(index) {
    return this._get(index >>> 0) ?? null;
  }

  getNamedItem(qualifiedName) {
    return this.#e.getAttributeNode(qualifiedName);
  }

  getNamedItemNS(namespace, localName) {
    return this.#e.getAttributeNodeNS(namespace, localName);
  }

  setNamedItem(attr) {
    return this.#e.setAttributeNode(attr);
  }

  setNamedItemNS(attr) {
    return this.#e.setAttributeNodeNS(attr);
  }

  removeNamedItem(qualifiedName) {
    const a = this.#e.getAttributeNode(qualifiedName);
    if (a === null) throw domError(2);
    return this.#e.removeAttributeNode(a);
  }

  removeNamedItemNS(namespace, localName) {
    const a = this.#e.getAttributeNodeNS(namespace, localName);
    if (a === null) throw domError(2);
    return this.#e.removeAttributeNode(a);
  }

  [Symbol.iterator]() {
    return new ListIterator(this, 0);
  }
}
tag(NamedNodeMap);
let NNM_IDX = installIndices(NamedNodeMap.prototype, 0, 16);

// ========================================================================================== Element

/** Namespace atoms of elements with a prefix or an "other" namespace: id -> [nsAtom, prefixAtom]. */
const NSX = new Map();
rt.onReset(() => NSX.clear());

function nsx(id) {
  let v = NSX.get(id);
  if (v === undefined) {
    v = [N.elemNs(id), N.elemPrefix(id)];
    NSX.set(id, v);
  }
  return v;
}

const NS_URIS = [NS.HTML, NS.SVG, NS.MATHML];

/** True if `id` is an HTML-namespace element with local atom `a`. */
function isHtml(id, a) {
  const o = V.off(id);
  return (V.T[o + F.META] & (M.KIND | M.NS_MASK)) === K.ELEMENT && V.T[o + F.LOCAL] === a;
}

/** The first SVG `title` element child of `root` (a wrapper), or null. */
function svgTitleOf(root) {
  for (let c = root.firstElementChild; c !== null; c = c.nextElementSibling) {
    if (c.localName === 'title' && c.namespaceURI === NS.SVG) return c;
  }
  return null;
}

/** First element (preorder, excluding `root`) satisfying `pred`. */
function firstDescendant(root, pred) {
  let n = V.T[V.off(root) + F.FIRST];
  while (n > 0) {
    const o = V.off(n);
    if ((V.T[o + F.META] & M.KIND) === K.ELEMENT && pred(n)) return n;
    let next = V.T[o + F.FIRST];
    if (!(next > 0)) {
      let c = n;
      while (c !== root && c > 0) {
        const co = V.off(c);
        if (V.T[co + F.NEXT] > 0) {
          next = V.T[co + F.NEXT];
          break;
        }
        c = V.T[co + F.PARENT];
      }
      if (c === root || !(c > 0)) next = 0;
    }
    n = next;
  }
  return 0;
}

/** Attribute qualified name as used by getAttribute & co (lowercased for HTML elements in HTML docs). */
function attrQName(el, name) {
  name = String(name);
  if ((V.T[o_(el) + F.META] & (M.NS_MASK | M.HTML_DOC)) === M.HTML_DOC && /[A-Z]/.test(name)) return asciiLower(name);
  return name;
}

/**
 * Raw attribute name -> atom of its HTML-lowercased form, for HTML elements in HTML documents (the hot
 * getAttribute/hasAttribute path: one Map hit instead of regex + lowercase + Map). Only hits are cached,
 * since a missing atom can appear later (parser, setAttribute).
 */
const HTML_ATTR = new Map();
rt.onReset(() => HTML_ATTR.clear());

const HTML_ATTR_SET = new Map();
rt.onReset(() => HTML_ATTR_SET.clear());

/** Like `attrLookup` but interns + validates (setAttribute / toggleAttribute); throws InvalidCharacterError. */
function attrSetAtom(el, name) {
  if ((V.T[o_(el) + F.META] & (M.NS_MASK | M.HTML_DOC)) !== M.HTML_DOC) return attrNameAtom(String(name));
  if (typeof name !== 'string') name = String(name);
  let a = HTML_ATTR_SET.get(name);
  if (a !== undefined) return a;
  a = attrNameAtom(/[A-Z]/.test(name) ? asciiLower(name) : name);
  if (HTML_ATTR_SET.size < 50_000) HTML_ATTR_SET.set(name, a);
  return a;
}

function attrLookup(el, name) {
  if ((V.T[o_(el) + F.META] & (M.NS_MASK | M.HTML_DOC)) !== M.HTML_DOC) return lookupAtom(String(name));
  if (typeof name !== 'string') name = String(name);
  let a = HTML_ATTR.get(name);
  if (a !== undefined) return a;
  a = lookupAtom(/[A-Z]/.test(name) ? asciiLower(name) : name);
  if (a !== 0 && HTML_ATTR.size < 50_000) HTML_ATTR.set(name, a);
  return a;
}

class Element extends Node {
  get nodeType() {
    return 1;
  }

  get nodeName() {
    return this.tagName;
  }

  get tagName() {
    const o = V.off(this._i);
    const m = V.T[o + F.META];
    const a = V.T[o + F.LOCAL];
    if ((m & (M.NS_MASK | M.HAS_PREFIX)) === 0 && (m & M.HTML_DOC) !== 0) return upperAtom(a);
    const qn = (m & M.HAS_PREFIX) !== 0 && nsx(this._i)[1] !== 0 ? `${atomName(nsx(this._i)[1])}:${atomName(a)}` : atomName(a);
    return (m & (M.NS_MASK | M.HTML_DOC)) === M.HTML_DOC ? rt.asciiUpper(qn) : qn;
  }

  get localName() {
    return atomName(V.T[V.off(this._i) + F.LOCAL]);
  }

  get namespaceURI() {
    const m = V.T[V.off(this._i) + F.META];
    const c = (m & M.NS_MASK) >>> M.NS_SHIFT;
    if (c !== NSC.OTHER) return NS_URIS[c];
    const ns = nsx(this._i)[0];
    return ns === 0 ? null : atomName(ns);
  }

  get prefix() {
    if ((V.T[V.off(this._i) + F.META] & M.HAS_PREFIX) === 0) return null;
    const p = nsx(this._i)[1];
    return p === 0 ? null : atomName(p);
  }

  // id / className reflect the null-namespace attribute. The table's HAS_ID / HAS_CLASS bits say whether
  // it exists, so the common "no id/class" case needs no crossing.
  get id() {
    const id = this._i;
    if ((V.T[V.off(id) + F.META] & M.HAS_ID) === 0) return '';
    return N.getAttrNSA(id, 0, A.id) ?? '';
  }

  set id(v) {
    this.setAttribute('id', v);
  }

  get className() {
    const id = this._i;
    if ((V.T[V.off(id) + F.META] & M.HAS_CLASS) === 0) return '';
    return N.getAttrNSA(id, 0, A.class) ?? '';
  }

  set className(v) {
    this.setAttribute('class', v);
  }

  get slot() {
    return this.getAttribute('slot') ?? '';
  }

  set slot(v) {
    this.setAttribute('slot', v);
  }

  get shadowRoot() {
    return null;
  }

  get assignedSlot() {
    return null;
  }

  hasAttributes() {
    return N.attrCount(this._i) !== 0;
  }

  getAttribute(qualifiedName) {
    const a = attrLookup(this, qualifiedName);
    if (a === 0) return null;
    const id = this._i;
    if (!MEMO || id === 0) return N.getAttr(id, a);
    const ver = nodeVersion(id, NODE.ATTRS);
    const st = this._at;
    if (st !== null && st.v === ver) {
      const m = st.m;
      const n = st.n;
      for (let i = 0; i < n; i += 2) {
        if (m[i] === a) {
          const v = m[i + 1];
          if (v !== PRESENT) return v;
          break;
        }
      }
    }
    const v = N.getAttr(id, a);
    attrMemoPut(this, ver, a, v);
    return v;
  }

  hasAttribute(qualifiedName) {
    const a = attrLookup(this, qualifiedName);
    if (a === 0) return false;
    const id = this._i;
    if (!MEMO || id === 0) return N.hasAttr(id, a);
    const ver = nodeVersion(id, NODE.ATTRS);
    const st = this._at;
    if (st !== null && st.v === ver) {
      const m = st.m;
      const n = st.n;
      for (let i = 0; i < n; i += 2) if (m[i] === a) return m[i + 1] !== null;
    }
    const has = N.hasAttr(id, a);
    attrMemoPut(this, ver, a, has ? PRESENT : null);
    return has;
  }

  setAttribute(qualifiedName, value) {
    const a = attrSetAtom(this, qualifiedName);
    check(N.setAttr(this._i, a, String(value)));
    mutated();
  }

  removeAttribute(qualifiedName) {
    const a = attrLookup(this, qualifiedName);
    if (a === 0) return;
    const attr = cachedAttrByQname(this, a);
    if (attr !== undefined) detachAttr(attr, N.getAttr(this._i, a) ?? attr._v);
    if (N.removeAttr(this._i, a)) mutated();
  }

  toggleAttribute(qualifiedName, force = undefined) {
    const a = attrSetAtom(this, qualifiedName);
    if (this._at !== null && (force === undefined || !force)) {
      const attr = cachedAttrByQname(this, a);
      if (attr !== undefined) detachAttr(attr, N.getAttr(this._i, a) ?? attr._v);
    }
    const r = N.toggleAttr(this._i, a, force === undefined ? 0 : force ? 2 : 1);
    if (r >= 16) check(r - 16);
    mutated();
    return r === 1;
  }

  getAttributeNames() {
    const n = N.attrNames(this._i);
    const q = outIds(n * 4);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = atomName(q[i * 4]);
    return out;
  }

  getAttributeNS(namespace, localName) {
    return N.getAttrNS(this._i, namespace === undefined ? null : namespace, String(localName));
  }

  hasAttributeNS(namespace, localName) {
    return N.hasAttrNS(this._i, namespace === undefined ? null : namespace, String(localName));
  }

  setAttributeNS(namespace, qualifiedName, value) {
    const ns = namespace === null || namespace === undefined ? null : String(namespace);
    check(N.setAttrNS(this._i, ns, String(qualifiedName), String(value)));
    mutated();
  }

  removeAttributeNS(namespace, localName) {
    const ns = namespace === null || namespace === undefined ? null : String(namespace);
    const ln = String(localName);
    if (this._at !== null && this._at.map !== null) {
      for (const attr of this._at.map.values()) {
        if (attr.localName === ln && attr.namespaceURI === (ns || null)) detachAttr(attr, attr.value);
      }
    }
    if (N.removeAttrNS(this._i, ns, ln)) mutated();
  }

  get attributes() {
    const st = attrState(this);
    const m = st.nnm ?? (st.nnm = NamedNodeMap._for(this));
    m._sync(); // own index and name properties (DESIGN §4.3); one compare when the attributes did not change
    return m;
  }

  getAttributeNode(qualifiedName) {
    const a = lookupAtom(attrQName(this, qualifiedName));
    if (a === 0 || !N.hasAttr(this._i, a)) return null;
    return this._attrNodeWhere((q) => q[0] === a);
  }

  getAttributeNodeNS(namespace, localName) {
    const ns = namespace === null || namespace === undefined || namespace === '' ? 0 : lookupAtom(String(namespace));
    const l = lookupAtom(String(localName));
    if (l === 0 || (ns === 0 && namespace)) return null;
    return this._attrNodeWhere((q) => q[1] === ns && q[3] === l);
  }

  _attrNodeWhere(pred) {
    const n = N.attrNames(this._i);
    const q = outIds(n * 4);
    for (let i = 0; i < n; i++) {
      const quad = q.subarray(i * 4, i * 4 + 4);
      if (pred(quad)) {
        const v = N.getAttrNSA(this._i, quad[1], quad[3]) ?? '';
        return attrFor(this, quad[0], quad[1], quad[2], quad[3], v);
      }
    }
    return null;
  }

  setAttributeNode(attr) {
    if (!(attr instanceof Attr)) throw new TypeError("Failed to execute 'setAttributeNode' on 'Element': parameter 1 is not of type 'Attr'.");
    if (attr._el !== null && attr._el !== this) throw new rt.classes.DOMException('The attribute is in use.', 'InUseAttributeError');
    if (attr._el === this) return attr;
    // DOM "set an attribute": the old attribute is the one with the Attr's namespace and local name, also for a
    // null-namespace Attr whose name has a colon (createAttribute('p:id') must not replace a namespaced p:id)
    const old = this.getAttributeNodeNS(attr.namespaceURI, attr.localName);
    const value = attr._v;
    if (old !== null) detachAttr(old, old.value);
    if (attr._n === 0) check(N.setAttrNSA(this._i, 0, attr._l, 0, value));
    else check(N.setAttrNodeNS(this._i, attr.namespaceURI, attr.name, value));
    attr._el = this;
    attr._doc = null;
    attrMap(attrState(this)).set(attrKey(attr._n, attr._l), attr);
    mutated();
    return old;
  }

  setAttributeNodeNS(attr) {
    return this.setAttributeNode(attr);
  }

  removeAttributeNode(attr) {
    if (!(attr instanceof Attr) || attr._el !== this) throw domError(2);
    const v = attr.value;
    N.removeAttrNS(this._i, attr.namespaceURI, attr.localName);
    detachAttr(attr, v);
    mutated();
    return attr;
  }

  get innerHTML() {
    return N.innerHTMLGet(this._i);
  }

  set innerHTML(v) {
    check(N.innerHTMLSet(this._i, v === null ? '' : String(v)));
    afterAlloc();
    mutated();
  }

  get outerHTML() {
    return N.outerHTMLGet(this._i);
  }

  set outerHTML(v) {
    check(N.outerHTMLSet(this._i, v === null ? '' : String(v)));
    afterAlloc();
    mutated();
  }

  insertAdjacentHTML(position, text) {
    check(N.insertAdjacentHTML(this._i, adjacentPos(position), String(text)));
    afterAlloc();
    mutated();
  }

  insertAdjacentElement(position, element) {
    if (!(element instanceof Element)) throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.");
    return insertAdjacent(this, adjacentPos(position), element);
  }

  insertAdjacentText(position, data) {
    const t = this.ownerDocument.createTextNode(data);
    insertAdjacent(this, adjacentPos(position), t);
  }

  getBoundingClientRect() {
    return makeRect();
  }

  getClientRects() {
    return [];
  }
}
tag(Element);
define(Element, ParentNode);
define(Element, ChildNode);
define(Element, NonDocumentTypeChildNode);

const ADJ = { beforebegin: 0, afterbegin: 1, beforeend: 2, afterend: 3 };
function adjacentPos(p) {
  const c = ADJ[asciiLower(String(p))];
  if (c === undefined) throw domError(4, `The value provided ('${p}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`);
  return c;
}

function insertAdjacent(el, pos, node) {
  const id = node._i;
  if (pos === 0 || pos === 3) {
    const parent = V.T[o_(el) + F.PARENT];
    if (parent === 0) return null;
    check(N.insertBefore(parent, id, pos === 0 ? el._i : V.T[o_(el) + F.NEXT]));
  } else {
    check(N.insertBefore(el._i, id, pos === 1 ? V.T[o_(el) + F.FIRST] : 0));
  }
  mutated();
  return node;
}

function makeRect() {
  const r = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  r.toJSON = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
  return r;
}

// ---------------------------------------------------------------------------------- HTML elements

class HTMLElement extends Element {
  // [HTMLConstructor] (DESIGN §43): `new` on a custom element class (or a customized built-in's, through the
  // default constructors of the interface subclasses) creates or upgrades the element in lib/custom-elements.cjs
  constructor(t = undefined) {
    if (t !== TOKEN) return require('./custom-elements.cjs').htmlConstructor(new.target);
    super(t);
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(v) {
    this.textContent = v;
  }

  get outerText() {
    return this.textContent;
  }

  set outerText(v) {
    this.textContent = v;
  }
}
tag(HTMLElement);

class SVGElement extends Element {}
tag(SVGElement);

class MathMLElement extends Element {}
tag(MathMLElement);

/** Creates `class <name> extends <Base> {}` with an exact `name` and `Symbol.toStringTag`. */
function makeClass(name, Base) {
  const C = { [name]: class extends Base {} }[name];
  return tag(C, name);
}

// Interface class by local-name atom. Static atoms: dense arrays (never written past their length, so V8
// keeps fast elements). Dynamic atoms (custom elements, unknown tags) are env-specific ids, cached in a Map
// that is cleared on reset (the same id names a different tag in the next env).
const STATIC_ATOM_COUNT = require('./generated/atoms.cjs').length;
const HTML_CLASS = new Array(STATIC_ATOM_COUNT).fill(undefined);
const SVG_CLASS = new Array(STATIC_ATOM_COUNT).fill(undefined);
const HTML_CLASS_DYN = new Map();
rt.onReset(() => HTML_CLASS_DYN.clear());
const BUILTIN = { HTMLElement, SVGElement, Element };
function classByName(name) {
  if (rt.classes[name]) return rt.classes[name];
  const parent = interfaces.parents[name] ?? (name.startsWith('SVG') ? 'SVGElement' : 'HTMLElement');
  return makeClass(name, BUILTIN[name] ?? classByName(parent));
}
for (const ns of ['html', 'svg']) {
  for (const [iface, tags] of Object.entries(interfaces[ns])) {
    const C = classByName(iface);
    for (const t of tags) {
      const a = lookupAtom(t);
      if (a !== 0) (ns === 'html' ? HTML_CLASS : SVG_CLASS)[a] = C;
    }
  }
}
for (const t of interfaces.plainHtml) if (lookupAtom(t) !== 0) HTML_CLASS[lookupAtom(t)] = HTMLElement;
for (const t of interfaces.unknownHtml) if (lookupAtom(t) !== 0) HTML_CLASS[lookupAtom(t)] = rt.classes.HTMLUnknownElement;
const HTMLUnknownElement = rt.classes.HTMLUnknownElement;

const RESERVED_CE = new Set(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph']);
function isValidCustomElementName(name) {
  return /^[a-z][^A-Z]*-[^A-Z]*$/.test(name) && !RESERVED_CE.has(name) && /^[a-z][-.0-9_a-z·À-\u{EFFFF}]*$/u.test(name);
}

function htmlClass(a) {
  if (a < STATIC_ATOM_COUNT) {
    const C = HTML_CLASS[a];
    if (C !== undefined) return C;
  }
  let C = HTML_CLASS_DYN.get(a);
  if (C === undefined) {
    C = isValidCustomElementName(atomName(a)) ? HTMLElement : HTMLUnknownElement;
    if (a < STATIC_ATOM_COUNT) HTML_CLASS[a] = C;
    else HTML_CLASS_DYN.set(a, C);
  }
  return C;
}

const KIND_CLASS = [];
KIND_CLASS[K.TEXT] = Text;
KIND_CLASS[K.CDATA] = CDATASection;
KIND_CLASS[K.PI] = ProcessingInstruction;
KIND_CLASS[K.COMMENT] = Comment;
KIND_CLASS[K.DOCTYPE] = DocumentType;
KIND_CLASS[K.FRAGMENT] = DocumentFragment;

/** Creates the wrapper for `id` from its table record (zero crossings in shared mode). */
function materialize(id) {
  if (id >= V.EP[EPI.NODE_LEN]) return null;
  const o = V.off(id);
  const m = V.T[o + F.META];
  const k = m & M.KIND;
  let C;
  if (k === K.ELEMENT) {
    const c = (m & M.NS_MASK) >>> M.NS_SHIFT;
    const a = V.T[o + F.LOCAL];
    C = c === NSC.HTML ? htmlClass(a) : c === NSC.SVG ? ((a < STATIC_ATOM_COUNT ? SVG_CLASS[a] : undefined) ?? SVGElement)
      : c === NSC.MATHML ? MathMLElement : Element;
  } else if (k === K.DOCUMENT) {
    C = (m & M.HTML_DOC) !== 0 ? Document : XMLDocument;
  } else {
    C = (m & M.SHADOW) !== 0 && k === K.FRAGMENT ? rt.classes.ShadowRoot : KIND_CLASS[k];
    if (C === undefined) return null;
  }
  return materializeAs(id, C);
}

/**
 * Per-class wrapper constructors: `function (id) { this._ev = null; this._i = id; ... }` with
 * `prototype = C.prototype`. Same canonical field order as before, without running the 4-6 deep class
 * constructor chain, and V8 slack tracking gives every wrapper the 8 fields (plus room for React's
 * expandos) in-object instead of a separate PropertyArray (Object.create left only 4 in-object slots).
 */
const MAKERS = new Map();
function makerFor(C) {
  let Make = MAKERS.get(C);
  if (Make === undefined) {
    // eslint-disable-next-line func-names
    Make = function (id) {
      this._ev = null;
      this._i = id;
      this._cn = null;
      this._ch = null;
      this._cs = null;
      this._st = null;
      this._vm = null;
      this._at = null;
    };
    Make.prototype = C.prototype;
    MAKERS.set(C, Make);
  }
  return Make;
}

/** Creates (and registers in `W`) the wrapper of `id` with class `C`. */
function materializeAs(id, C) {
  const Make = makerFor(C);
  const w = new Make(id);
  // Keep W dense: pad with undefined up to `id` so a high id never turns it into dictionary elements.
  while (W.length < id) W.push(undefined);
  W[id] = w;
  return w;
}
rt.setMaterializer(materialize);

// Atoms used by the facade.
const A = {
  html: lookupAtom('html'), head: lookupAtom('head'), body: lookupAtom('body'), frameset: lookupAtom('frameset'),
  title: lookupAtom('title'), template: lookupAtom('template'), id: lookupAtom('id'), class: lookupAtom('class'),
};

// template.content
define(rt.classes.HTMLTemplateElement, {
  get content() {
    const id = N.templateContent(this._i);
    afterAlloc();
    return wrap(id);
  },
});

// =========================================================================== DOMImplementation & co

class DOMImplementation {
  constructor(t) {
    if (t !== TOKEN) illegal();
    this._doc = null;
  }

  createHTMLDocument(title = undefined) {
    const id = N.createDocument(0, title === undefined ? null : String(title));
    afterAlloc();
    const d = wrap(id);
    d._url = 'about:blank';
    return d;
  }

  createDocument(namespace, qualifiedName, doctype = null) {
    // [LegacyNullToEmptyString] DOMString: null is "", undefined is "undefined"
    qualifiedName = qualifiedName === null ? '' : `${qualifiedName}`;
    const id = N.createDocument(1, null);
    afterAlloc();
    const d = wrap(id);
    d._ct = namespace === NS.HTML ? 'application/xhtml+xml' : namespace === NS.SVG ? 'image/svg+xml' : 'application/xml';
    if (doctype !== null) d.appendChild(doctype);
    if (qualifiedName !== '') d.appendChild(d.createElementNS(namespace, qualifiedName));
    return d;
  }

  createDocumentType(qualifiedName, publicId, systemId) {
    const id = checkId(N.createDoctype(this._doc._i, String(qualifiedName), String(publicId), String(systemId)));
    afterAlloc();
    return wrap(id);
  }

  hasFeature() {
    return true;
  }
}
tag(DOMImplementation);

function makeImplementation(doc) {
  const impl = new DOMImplementation(TOKEN);
  impl._doc = doc;
  return impl;
}

class DOMParser {
  parseFromString(string, type) {
    const t = String(type);
    if (t !== 'text/html') {
      if (['text/xml', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(t)) {
        return require('./xml.cjs').parseXmlDocument(String(string), t, context.currentDocument()?.URL ?? 'about:blank'); // DESIGN §38
      }
      throw new TypeError(`Failed to execute 'parseFromString' on 'DOMParser': The provided value '${t}' is not a valid enum value of type DOMParserSupportedType.`);
    }
    const id = checkId(N.parseDocument(String(string), 0));
    afterAlloc();
    const d = wrap(id);
    d._url = context.currentDocument()?.URL ?? 'about:blank';
    return d;
  }
}
tag(DOMParser);

rt.classes.DOMException = globalThis.DOMException;

// ------------------------------------------------------------------- reflection helpers (for areas)

function defineAccessor(C, prop, get, set) {
  Object.defineProperty(C.prototype, prop, { get, set, enumerable: false, configurable: true });
}

/** DOMString reflection: getter `attr ?? ''`, setter `setAttribute(attr, String(v))` (HTML §2.6.1). */
function reflectString(C, prop, attr = prop.toLowerCase()) {
  defineAccessor(C, prop, function () {
    return this.getAttribute(attr) ?? '';
  }, function (v) {
    this.setAttribute(attr, v);
  });
}

/** Boolean reflection: getter `hasAttribute(attr)`, setter sets '' or removes. */
function reflectBool(C, prop, attr = prop.toLowerCase()) {
  defineAccessor(C, prop, function () {
    return this.hasAttribute(attr);
  }, function (v) {
    if (v) this.setAttribute(attr, '');
    else this.removeAttribute(attr);
  });
}

/** `long` reflection with HTML integer parsing; invalid/missing -> `dflt`. */
function reflectLong(C, prop, attr = prop.toLowerCase(), dflt = 0) {
  defineAccessor(C, prop, function () {
    const v = this.getAttribute(attr);
    if (v === null) return dflt;
    const m = /^[\t\n\f\r ]*([-+]?\d+)/.exec(v);
    if (m === null) return dflt;
    const n = parseInt(m[1], 10);
    return n >= -2147483648 && n <= 2147483647 ? n : dflt;
  }, function (v) {
    this.setAttribute(attr, String(v | 0));
  });
}

/** Forgets the cached namespace / prefix of element `id` (custom elements set the prefix after construction). */
function dropNsx(id) {
  NSX.delete(id);
}

module.exports = {
  dropNsx, EventTarget, Node, Document, HTMLDocument, XMLDocument, DocumentFragment, DocumentType, CharacterData, Text,
  CDATASection, Comment, ProcessingInstruction, Attr, NamedNodeMap, Element, HTMLElement, HTMLUnknownElement,
  SVGElement, MathMLElement, DOMImplementation, DOMParser, NodeList, HTMLCollection,
  nodeArg, convertNodes, staticNodeListFromIds, isHtml, firstDescendant, attrQName, attrLookup, attrSetAtom, makeRect,
  defineAccessor, reflectString, reflectBool, reflectLong, wrap, ParentNode, ChildNode, NonDocumentTypeChildNode,
};
