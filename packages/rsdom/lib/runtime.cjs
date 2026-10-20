'use strict';
// rsdom facade runtime: the native binding, epoch page (EP), OUT buffer, node-table view (T), identity table
// (W), atom mirror, DOMException mapping and the extension API (`rt`) that area modules receive.
//
// INVARIANTS (DESIGN §2.2, §3.3, §3.4):
//  - Never keep the table view `T` in a local variable across a native call: growth replaces it. Read
//    record fields through `off(id)` + `T[...]` (inside this module) or `rt.field(id, F.X)` (elsewhere).
//  - After any node-allocating ("G") native call, call `afterAlloc()` (remaps `T` if EP[GEN] changed).
//    Mutations can allocate too (adopting a <template> creates the destination's template-contents
//    document; convert-nodes-into-a-node creates a fragment before validating), so `mutated()` and the
//    error paths of `check()` / `checkId()` remap as well: no facade method leaves `V.T` detached.
//  - OUT is volatile scratch: copy results out with `outIds(n)` BEFORE any further native call.
//  - JS never authors DOM state; it only memoises Rust answers validated by Rust-written counters.

const N = require('./native.cjs');
const STATIC_ATOMS = require('./generated/atoms.cjs');

const ENV = process.env;
/** Ablation flags (DESIGN §12): every JS-side shortcut can be switched off. */
const flags = {
  SHARED: ENV.RSDOM_SHARED !== '0',
  MEMO: ENV.RSDOM_NO_MEMO !== '1',
  PREFILTER: ENV.RSDOM_NO_PREFILTER !== '1',
};

/** Epoch-page indices (src/env.rs `ep`). */
const EPI = Object.freeze({
  GEN: 0, TREE: 1, ATTR: 2, STYLE: 3, FORM: 4, MO_PENDING: 5, FOCUS: 6, ATOM_LEN: 7, NODE_LEN: 8,
  OUT_NEED: 9, ERR: 10, REC: 11, TEXT: 12,
  /** area A's slot (src/style/mod.rs EP_STYLE_DEP): non-zero while author sheets select on element state */
  STYLE_DEP: 13,
});
/** Node-record field offsets (src/table.rs `NodeRec`). */
const F = Object.freeze({
  PARENT: 0, FIRST: 1, LAST: 2, PREV: 3, NEXT: 4, META: 5, LOCAL: 6, CHILD_VER: 7, OWNER: 8, CHILD_LEN: 9,
  STATE: 10, ATTR_VER: 11, FORM_VER: 12, PAYLOAD: 13,
  /** character data: data version (word 11 = ATTR_VER of elements), changes with every data change */
  DATA_VER: 11,
});
/** `meta` bits (src/node.rs `meta`). */
const M = Object.freeze({
  KIND: 0xf, NS_SHIFT: 4, NS_MASK: 0x30, CONNECTED: 1 << 6, OBSERVED: 1 << 7, HTML_DOC: 1 << 8,
  IN_TEMPLATE: 1 << 9, HAS_ID: 1 << 10, HAS_CLASS: 1 << 11, HAS_STYLE: 1 << 12, DISABLED_ATTR: 1 << 13,
  HAS_PREFIX: 1 << 14, TEMPLATE_CONTENT: 1 << 15,
});
/** `state` bits (src/node.rs `state`). */
const S = Object.freeze({
  CHECKED: 1, SELECTED: 2, INDETERMINATE: 4, DIRTY_VALUE: 8, DIRTY_CHECKED: 16, DIRTY_SELECTED: 32,
  INPUT_TYPE_SHIFT: 8, INPUT_TYPE_MASK: 0x1f00, FOCUSED: 1 << 16,
});
/** nodeType values. */
const K = Object.freeze({ ELEMENT: 1, ATTRIBUTE: 2, TEXT: 3, CDATA: 4, PI: 7, COMMENT: 8, DOCUMENT: 9, DOCTYPE: 10, FRAGMENT: 11 });
/** Namespace classes (meta bits 4-5). */
const NSC = Object.freeze({ HTML: 0, SVG: 1, MATHML: 2, OTHER: 3 });
const NS = Object.freeze({
  HTML: 'http://www.w3.org/1999/xhtml', SVG: 'http://www.w3.org/2000/svg', MATHML: 'http://www.w3.org/1998/Math/MathML',
  XLINK: 'http://www.w3.org/1999/xlink', XML: 'http://www.w3.org/XML/1998/namespace', XMLNS: 'http://www.w3.org/2000/xmlns/',
});

// ------------------------------------------------------------------------------------------- state

/**
 * Hot shared state. Modules read `V.T[...]`, `V.EP[...]`, `V.off(id)` (one monomorphic property load each)
 * so that `T` can be replaced on growth / fallback-mirror resize without stale module-level copies.
 */
const V = {
  /** Node table: zero-copy view (shared mode) or JS-owned record mirror (fallback mode). */
  T: new Uint32Array(16),
  /** Epoch page (Rust writes, JS reads). */
  EP: new Uint32Array(16),
  /** OUT scratch buffer (length-tracking view over a resizable ArrayBuffer). */
  OUT: new Uint32Array(0),
  /** Offset of record `id` in `T` (fallback mode refreshes a stale mirror record first). */
  off: offShared,
  /** Env generation: incremented by every `reset()` (id-caching objects use memo.cjs `envGen()` / `alive()`). */
  envGen: 1,
};
let EP_AB = null;
let OUT_AB = null;
/** Fallback mode: EP[REC] value each mirrored record was copied at. */
let RV = new Uint32Array(0);
/** Fallback mode: the record mirror's resizable buffer (V.T is a length-tracking view over it). */
let MIRROR_AB = null;
const MIRROR_MAX = 1 << 30;
let gen = 0;
let shared = false;
/**
 * id -> wrapper (strong; never shrinks while the env lives). Kept dense (`materialize` pads it with
 * `undefined` up to the id) so V8 never switches it to dictionary elements.
 */
const W = [];

function init(opts = {}) {
  EP_AB = new ArrayBuffer(64);
  V.EP = new Uint32Array(EP_AB);
  OUT_AB = new ArrayBuffer(1 << 20, { maxByteLength: 1 << 28 });
  V.OUT = new Uint32Array(OUT_AB);
  const wantShared = opts.shared ?? flags.SHARED;
  const ab = N.init(EP_AB, OUT_AB, opts.capacity ?? 0, wantShared);
  shared = ab !== null;
  if (shared) {
    V.T = new Uint32Array(ab);
    V.off = offShared;
  } else {
    // A length-tracking view over a resizable buffer: growing the mirror never replaces `V.T`, so an
    // expression like `V.T[V.off(id) + k]` (V.T is evaluated BEFORE V.off refreshes the record) always
    // reads the current mirror.
    MIRROR_AB = new ArrayBuffer(1 << 16, { maxByteLength: MIRROR_MAX });
    V.T = new Uint32Array(MIRROR_AB);
    RV = new Uint32Array(1 << 10);
    V.off = offFallback;
  }
  gen = V.EP[EPI.GEN];
  W.length = 0;
  resetAtoms();
}

/** Remaps the table view after growth (EP[GEN] changed). */
function remap() {
  gen = V.EP[EPI.GEN];
  if (shared) V.T = new Uint32Array(N.nodeTable());
}

/** Call after every node-allocating native call. */
function afterAlloc() {
  if (V.EP[EPI.GEN] !== gen) remap();
}

function offShared(id) {
  return id << 4;
}

function offFallback(id) {
  const o = id << 4;
  if (RV[id] !== V.EP[EPI.REC]) refreshRec(id, o);
  return o;
}

function refreshRec(id, o) {
  if (o + 16 > V.T.length) {
    let bytes = MIRROR_AB.byteLength;
    while (bytes < (o + 16) * 4) bytes *= 2;
    if (bytes > MIRROR_MAX) throw new RangeError('rsdom: fallback record mirror limit (16M nodes)');
    MIRROR_AB.resize(bytes);
  }
  if (id >= RV.length) {
    let n = RV.length;
    while (n <= id) n *= 2;
    const r = new Uint32Array(n);
    r.set(RV);
    RV = r;
  }
  N.rec(id);
  const T = V.T;
  const OUT = V.OUT;
  for (let k = 0; k < 16; k++) T[o + k] = OUT[k];
  RV[id] = V.EP[EPI.REC];
}

/** Reads one record field (`F.*`) of node `id`. */
function field(id, k) {
  const o = V.off(id);
  return V.T[o + k];
}

// --------------------------------------------------------------------------------------------- OUT

function align(bytes) {
  return (bytes + 0xffff) & ~0xffff;
}

/** Copies the `n` result words a native just wrote (handles the overflow protocol). */
function outIds(n) {
  if (n > V.OUT.length) {
    OUT_AB.resize(align(n * 4));
    N.bindOut(OUT_AB);
    N.outRefill();
  }
  return V.OUT.slice(0, n);
}

/** Writes input ids for natives that read OUT[0..n] (replaceChildren, nodesToNode, ...). */
function writeOut(ids) {
  if (ids.length > V.OUT.length) {
    OUT_AB.resize(align(ids.length * 4));
    N.bindOut(OUT_AB);
  }
  V.OUT.set(ids);
}

/** Live view of OUT (read immediately; do not keep across native calls). */
function outView() {
  return V.OUT;
}

// ------------------------------------------------------------------------------------------- atoms

let ATOMS = [];
let ATOM = new Map();
let EL_NAME = new Map();
let ATTR_NAME = new Map();
/** atom -> ASCII-uppercased name; same length as ATOMS (dense: no dictionary-mode elements). */
let UPPER = [];
const INVALID_ATTR = /[\0\t\n\f\r />=]/;
const VALID_EL = /^(?:[A-Za-z][^\0\t\n\f\r />]*|[:_\u0080-\u{10FFFF}][A-Za-z0-9-.:_\u0080-\u{10FFFF}]*)$/u;

function resetAtoms() {
  ATOMS = STATIC_ATOMS.slice();
  ATOM = new Map();
  EL_NAME = new Map();
  ATTR_NAME = new Map();
  UPPER = new Array(ATOMS.length).fill(undefined);
  for (let i = 1; i < ATOMS.length; i++) {
    const s = ATOMS[i];
    ATOM.set(s, i);
    if (s.length > 0 && !INVALID_ATTR.test(s)) ATTR_NAME.set(s, i);
    if (VALID_EL.test(s)) EL_NAME.set(s, i);
  }
}

/**
 * Pulls dynamic atoms created by Rust (parser, class tokens, ...) into the mirror. Length-prefixed protocol:
 * one string with the names concatenated + their UTF-16 lengths in OUT (names may contain any character).
 */
function syncAtoms() {
  const start = ATOMS.length;
  const n = V.EP[EPI.ATOM_LEN] - start;
  if (n <= 0) return;
  const s = N.atomsFrom(start);
  const lens = outIds(n);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const name = s.slice(pos, pos + lens[i]);
    pos += lens[i];
    ATOM.set(name, ATOMS.length);
    ATOMS.push(name);
    UPPER.push(undefined);
  }
}

function learn(name, a) {
  if (a === ATOMS.length) {
    ATOM.set(name, a);
    ATOMS.push(name);
    UPPER.push(undefined);
  } else if (a > ATOMS.length) {
    syncAtoms();
  }
}

/** Name of atom `a` ('' for 0). */
function atomName(a) {
  if (a >= ATOMS.length) syncAtoms();
  return ATOMS[a] ?? '';
}

/** Atom of `name` without interning (0 if unknown: no node can carry that name). */
function lookupAtom(name) {
  let a = ATOM.get(name);
  if (a === undefined) {
    if (V.EP[EPI.ATOM_LEN] <= ATOMS.length) return 0;
    syncAtoms();
    a = ATOM.get(name);
  }
  return a ?? 0;
}

/** Atom of `name`, interning it (no validation). */
function internAtom(name) {
  let a = lookupAtom(name);
  if (a === 0 && name !== '') {
    a = N.intern(name, 0);
    learn(name, a);
  }
  return a;
}

/** Atom of a valid element local name; throws InvalidCharacterError otherwise. */
function elementAtom(name) {
  let a = EL_NAME.get(name);
  if (a !== undefined) return a;
  a = N.intern(name, 1);
  if (a === 0) throw domError(3, `"${name}" is not a valid element local name`);
  learn(name, a);
  EL_NAME.set(name, a);
  return a;
}

/** Atom of a valid attribute local name; throws InvalidCharacterError otherwise. */
function attrNameAtom(name) {
  let a = ATTR_NAME.get(name);
  if (a !== undefined) return a;
  a = N.intern(name, 2);
  if (a === 0) throw domError(3, `"${name}" is not a valid attribute name`);
  learn(name, a);
  ATTR_NAME.set(name, a);
  return a;
}

/** ASCII-uppercased atom name (tagName of HTML elements in HTML documents). */
function upperAtom(a) {
  if (a >= UPPER.length) {
    syncAtoms();
    if (a >= UPPER.length) return '';
  }
  return UPPER[a] ?? (UPPER[a] = asciiUpper(ATOMS[a]));
}

function asciiUpper(s) {
  return /[^\x00-\x7f]/.test(s) ? s.replace(/[a-z]+/g, (m) => m.toUpperCase()) : s.toUpperCase();
}

function asciiLower(s) {
  return /[^\x00-\x7f]/.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s.toLowerCase();
}

// ------------------------------------------------------------------------------------------ errors

const ERR_NAMES = [
  '', 'HierarchyRequestError', 'NotFoundError', 'InvalidCharacterError', 'SyntaxError', 'IndexSizeError',
  'InvalidStateError', 'NotSupportedError', 'WrongDocumentError', 'NamespaceError', 'NoModificationAllowedError',
  // 11 is TypeError (Rust `DomError::Type`); 12 is facade-only (Range boundary points, DESIGN §25)
  '', 'InvalidNodeTypeError',
];
const ERR_MSG = [
  '', 'The operation would yield an incorrect node tree.', 'The object can not be found here.',
  'The string contains invalid characters.', 'The string did not match the expected pattern.',
  'The index is not in the allowed range.', 'The object is in an invalid state.',
  'The operation is not supported.', 'The object is in the wrong document.',
  'The operation is not allowed by Namespaces in XML.', 'The object can not be modified.',
  '', 'The supplied node is incorrect or has an incorrect ancestor for this operation.',
];

/** The DOMException constructor errors are created with (the window area may swap in a realm's). */
let DOMExceptionCtor = globalThis.DOMException;

function domError(code, msg) {
  if (code === 11 || code === 0 || code >= ERR_NAMES.length) return new TypeError(msg ?? 'Illegal invocation');
  return new DOMExceptionCtor(msg ?? ERR_MSG[code], ERR_NAMES[code]);
}

/** Throws for a non-zero native error code (after remapping: the failed call may have allocated). */
function check(code, msg) {
  if (code !== 0) {
    afterAlloc();
    throw domError(code, msg);
  }
}

/** For id-returning natives: throws EP[ERR] when `id === 0` (remapping first, like `check`). */
function checkId(id, msg) {
  if (id === 0) {
    afterAlloc();
    throw domError(V.EP[EPI.ERR] || 11, msg);
  }
  return id;
}

// ------------------------------------------------------------------------------- identity & hooks

let materializer = null;

/** id -> wrapper (zero crossings in shared mode). The slow path stays out of line so this inlines cheaply. */
function wrap(id) {
  if (id === 0) return null;
  const w = W[id];
  return w !== undefined ? w : wrapSlow(id);
}

function wrapSlow(id) {
  return materializer(id);
}

let moPending = () => {};
let uaTasks = () => {};
/**
 * Every mutating facade method ends with this: remaps the table if the mutation allocated (two
 * typed-array reads when nothing changed) and runs the post-mutation handlers when EP[MO_PENDING] (a bit
 * mask) is set: bit 0 = MutationObserver records queued, bit 1 = UA element tasks queued (details toggle).
 */
function mutated() {
  if (V.EP[EPI.GEN] !== gen) remap();
  const p = V.EP[EPI.MO_PENDING];
  if (p !== 0) {
    if ((p & 1) !== 0) moPending();
    if ((p & 2) !== 0) uaTasks();
  }
}

const resetHooks = [];

/**
 * Drops all DOM state (teardown) and re-initialises a fresh env in place. Ids restart at 1 in the new env,
 * so every wrapper handed out before is neutered first (`_i = 0`, the null record): a wrapper leaked from
 * a previous test file (timer, effect, module variable) reads as an empty detached node and its mutators
 * throw, instead of aliasing a node of the new env. Collections compare `envGen`.
 */
function reset(opts) {
  N.destroy();
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    if (w !== undefined) {
      w._i = 0;
      w._ch = null; // also drops a character-data memo
    }
  }
  W.length = 0;
  V.envGen++;
  for (const h of resetHooks) h();
  init(opts);
}

/**
 * Copies accessors/methods of `obj` onto `C.prototype` with WebIDL descriptors: public (string, not
 * `_`-prefixed) members are enumerable, like jsdom's; internal `_x` members and symbols are not.
 */
function define(C, obj) {
  defineOn(C.prototype, obj);
  return C;
}

/** True for keys WebIDL exposes as enumerable members (public string names). */
function isPublicKey(key) {
  return typeof key === 'string' && key[0] !== '_' && key !== 'constructor';
}

/**
 * Makes the public members of every registered interface prototype enumerable (WebIDL attributes and
 * operations are; class syntax makes them non-enumerable). Called once after all areas installed.
 */
function exposeMembers() {
  for (const C of Object.values(rt.classes)) {
    const proto = C?.prototype;
    if (!proto) continue;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!isPublicKey(key) || /^\d+$/.test(key)) continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d.enumerable || !d.configurable) continue;
      d.enumerable = true;
      Object.defineProperty(proto, key, d);
    }
  }
}

function defineOn(target, obj) {
  for (const key of Reflect.ownKeys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    d.enumerable = isPublicKey(key);
    if ('value' in d) d.writable = true;
    d.configurable = true;
    Object.defineProperty(target, key, d);
  }
  return target;
}

init();

/**
 * The extension API handed to area modules (`install(rt)`). Everything here is stable; see CONTRIBUTING.md.
 */
const rt = {
  N, V, flags, EPI, F, M, S, K, NSC, NS, W,
  /** private constructor token: `new C(rt.TOKEN)` is how wrappers are made; anything else is illegal */
  TOKEN: Symbol('rsdom.token'),
  field, afterAlloc, remap, outIds, writeOut, outView,
  atomName, lookupAtom, internAtom, elementAtom, attrNameAtom, upperAtom, syncAtoms, asciiLower, asciiUpper,
  check, checkId, domError,
  wrap, mutated, define, defineOn, exposeMembers, reset,
  get shared() { return shared; },
  /** set by dom.cjs */
  setMaterializer(fn) { materializer = fn; },
  /** area C: called (from `mutated()`) when EP[MO_PENDING] != 0 */
  setMoPendingHandler(fn) { moPending = fn; },
  /** area B: called (from `mutated()`) when bit 1 of EP[MO_PENDING] is set (UA element tasks queued) */
  setUaTaskHandler(fn) { uaTasks = fn; },
  /** area C: realm-specific DOMException */
  setDOMException(ctor) { DOMExceptionCtor = ctor; },
  /** called after `reset()` drops the env: clear JS-side caches keyed by node ids */
  onReset(fn) { resetHooks.push(fn); },
  /** registry of interface constructors, filled by dom.cjs / collections.cjs / areas */
  classes: Object.create(null),
  // `defaultDocument` (read-only): the current browsing context's document, defined by lib/context.cjs.
};

module.exports = rt;
