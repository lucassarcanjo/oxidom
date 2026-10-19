'use strict';
// AREA B (ROADMAP M5): form controls (input / textarea / select / option / button / form / label / fieldset /
// output), constraint validation, labels, focus()/blur()/activeElement, tabIndex, classList (DOMTokenList),
// dataset, HTMLElement reflection (hidden/title/lang/dir/...), URL reflection (href/src), zero geometry,
// HTMLImageElement, HTMLDialogElement, anchors' URL parts.
//
// State lives in Rust (src/forms/, src/focus.rs); this file memoises Rust answers only:
// - `value` of input/textarea is memoised in the wrapper's `_vm` (area B's side object) keyed by the record's
//   FORM_VER (written by Rust on every value/selection change), `RSDOM_NO_MEMO=1` disables it;
// - `checked` / `selected` / `indeterminate` / the input type are read from the table's state bits (zero FFI);
// - `document.activeElement` is EP[FOCUS] for the main document (zero FFI).
//
// Prototype contract (DESIGN §7, React value tracking + DTL setNativeValue + user-event interceptors):
// `value`/`checked` are own accessors of HTMLInputElement.prototype, `value` of HTMLTextAreaElement.prototype
// and HTMLSelectElement.prototype; selectionStart/End/Direction, setSelectionRange, setRangeText and select
// are own members of the input and textarea prototypes. Internal code never reads `element.value`.

const rt = require('./runtime.cjs');
const events = require('./events.cjs');
const { installIndices, liveQueryCollection, staticNodeListFromIds, ListIterator, HTMLCollection } = require('./collections.cjs');

const { N, V, F, M, K, S, EPI, W, NS } = rt;
const MEMO = rt.flags.MEMO;

function wrap(id) {
  if (id === 0) return null;
  const w = W[id];
  return w !== undefined ? w : rt.wrap(id);
}

/** Input type names indexed by the Rust type code (src/forms/types.rs `ty`). */
const INPUT_TYPES = [
  'text', 'hidden', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time',
  'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button',
];
const T_HIDDEN = 1;
const T_FILE = 17;
const T_SUBMIT = 18;
const T_IMAGE = 19;
const T_RESET = 20;
const T_BUTTON = 21;

/** Validity bits (src/forms/mod.rs `vbits`). */
const VB = {
  VALUE_MISSING: 1, TYPE_MISMATCH: 2, PATTERN_MISMATCH: 4, TOO_LONG: 8, TOO_SHORT: 16, RANGE_UNDERFLOW: 32,
  RANGE_OVERFLOW: 64, STEP_MISMATCH: 128, BAD_INPUT: 256, CUSTOM_ERROR: 512, CANDIDATE: 1 << 16,
  CHECK_PATTERN: 1 << 17, CHECK_URL: 1 << 18, CHECK_FILES: 1 << 19,
};
const FAIL_MASK = 0x3ff;

const A = {};
for (const n of ['input', 'textarea', 'select', 'option', 'body', 'html', 'base', 'fieldset', 'legend', 'details', 'summary', 'a', 'area', 'img', 'svg', 'button', 'datalist', 'object']) {
  A[n] = rt.lookupAtom(n);
}

function isHtml(id, a) {
  const o = V.off(id);
  return (V.T[o + F.META] & (M.KIND | M.NS_MASK)) === K.ELEMENT && V.T[o + F.LOCAL] === a;
}

function inputTypeOf(id) {
  return (V.T[V.off(id) + F.STATE] & S.INPUT_TYPE_MASK) >>> S.INPUT_TYPE_SHIFT;
}

/** Area B's per-wrapper side object (wrapper field `_vm`). */
class BState {
  constructor() {
    this.fv = -1; // FORM_VER the value memo belongs to
    this.val = '';
    this.sv = -1; // FORM_VER the selection memo belongs to
    this.ss = 0;
    this.se = 0;
    this.sd = 0; // 0 none, 1 forward, 2 backward, -1 selection API does not apply
    this.cl = null; // classList
    this.ds = null; // dataset
    this.files = null;
    this.coll = null; // options / form.elements / fieldset.elements (SameObject)
    this.coll2 = null; // selectedOptions
    this.validity = null;
    this.tl = null; // relList / htmlFor DOMTokenList
    this.sx = 0; // scrollLeft / scrollTop as last assigned (no layout)
    this.sy = 0;
  }
}

function bs(el) {
  const s = el._vm;
  return s !== null && s !== undefined ? s : (el._vm = new BState());
}

/** Copies the members of each object onto `C.prototype` (descriptors: getters are not invoked). */
function defineAll(C, ...objs) {
  for (const o of objs) rt.define(C, o);
}

function str(v) {
  return typeof v === 'string' ? v : String(v);
}

/** [LegacyNullToEmptyString] DOMString. */
function strNullEmpty(v) {
  return v === null ? '' : str(v);
}

// ======================================================================================== events

function queueSelect(el) {
  setImmediate(() => {
    if (el._i !== 0) events.fire(el, 'select', { bubbles: true, cancelable: false });
  });
}

// ===================================================================================== reflection

function reflectStr(C, prop, attr = prop.toLowerCase()) {
  Object.defineProperty(C.prototype, prop, {
    get() {
      return this.getAttribute(attr) ?? '';
    },
    set(v) {
      this.setAttribute(attr, v);
    },
    enumerable: false,
    configurable: true,
  });
}

function reflectBool(C, prop, attr = prop.toLowerCase()) {
  Object.defineProperty(C.prototype, prop, {
    get() {
      return this.hasAttribute(attr);
    },
    set(v) {
      if (v) this.setAttribute(attr, '');
      else this.removeAttribute(attr);
    },
    enumerable: false,
    configurable: true,
  });
}

/** HTML rules for parsing integers (null on error). */
function parseInteger(v) {
  const m = /^[\t\n\f\r ]*([-+]?[0-9]+)/.exec(v);
  if (m === null) return null;
  const n = parseInt(m[1], 10);
  return n === 0 ? 0 : n;
}

/** `long` reflection; [ReflectNonNegative] when `nonNeg` (default -1, IndexSizeError on negative sets). */
function reflectLong(C, prop, attr, dflt, nonNeg = false) {
  Object.defineProperty(C.prototype, prop, {
    get() {
      const v = this.getAttribute(attr);
      if (v === null) return dflt;
      const n = parseInteger(v);
      if (n === null || n < -2147483648 || n > 2147483647 || (nonNeg && n < 0)) return dflt;
      return n;
    },
    set(v) {
      const n = Number(v) | 0;
      if (nonNeg && n < 0) throw rt.domError(5, `The value provided (${n}) is negative.`);
      this.setAttribute(attr, String(n));
    },
    enumerable: false,
    configurable: true,
  });
}

/** `unsigned long` reflection ([ReflectPositive] when `positive`: 0 is invalid). */
function reflectULong(C, prop, attr, dflt, positive = false) {
  Object.defineProperty(C.prototype, prop, {
    get() {
      const v = this.getAttribute(attr);
      if (v === null) return dflt;
      const n = parseInteger(v);
      if (n === null || n < 0 || n > 2147483647 || (positive && n === 0)) return dflt;
      return n;
    },
    set(v) {
      let n = Number(v) >>> 0;
      if (n > 2147483647) n = dflt;
      if (positive && n === 0) throw rt.domError(5, 'The value provided is 0, which is not a valid positive value.');
      this.setAttribute(attr, String(n));
    },
    enumerable: false,
    configurable: true,
  });
}

// ------------------------------------------------------------------------------------------- URLs

const BASE = new WeakMap();
const URL_CACHE = new Map();
rt.onReset(() => URL_CACHE.clear());

/** Document base URL: the first `<base href>` resolved against the document URL, else the URL. */
function baseURL(doc) {
  if (doc === null) return 'about:blank';
  const url = doc.URL;
  const key = V.EP[EPI.TREE] * 0x1000 + (V.EP[EPI.ATTR] & 0xfff);
  const m = BASE.get(doc);
  if (m !== undefined && m.k === key && m.u === url) return m.b;
  let b = url;
  const root = doc.documentElement;
  if (root !== null) {
    let n = root._i;
    const stop = n;
    while (n > 0) {
      if (isHtml(n, A.base)) {
        const h = wrap(n).getAttribute('href');
        if (h !== null) {
          try {
            b = new URL(h, url).href;
          } catch {
            // keep the document URL
          }
          break;
        }
      }
      n = nextInSubtree(n, stop);
    }
  }
  BASE.set(doc, { k: key, u: url, b });
  return b;
}

function nextInSubtree(n, root) {
  const f = V.T[V.off(n) + F.FIRST];
  if (f > 0) return f;
  for (let c = n; c > 0 && c !== root; c = V.T[V.off(c) + F.PARENT]) {
    const nx = V.T[V.off(c) + F.NEXT];
    if (nx > 0) return nx;
  }
  return 0;
}

/** Parses `v` against the element's document base URL (null if unparseable). */
function parseURL(el, v) {
  const base = baseURL(el.ownerDocument);
  const key = base + '\0' + v;
  let r = URL_CACHE.get(key);
  if (r === undefined) {
    try {
      r = new URL(v, base).href;
    } catch {
      r = null;
    }
    if (URL_CACHE.size > 2000) URL_CACHE.clear();
    URL_CACHE.set(key, r);
  }
  return r;
}

function reflectURL(C, prop, attr = prop.toLowerCase()) {
  Object.defineProperty(C.prototype, prop, {
    get() {
      const v = this.getAttribute(attr);
      if (v === null) return '';
      return parseURL(this, v) ?? v;
    },
    set(v) {
      this.setAttribute(attr, v);
    },
    enumerable: false,
    configurable: true,
  });
}

// =================================================================================== DOMTokenList

const ASCII_WS = /[\t\n\f\r ]+/;

function parseTokens(v) {
  if (v === null || v === '') return [];
  const out = [];
  for (const t of v.split(ASCII_WS)) if (t !== '' && !out.includes(t)) out.push(t);
  return out;
}

function validateToken(t) {
  if (t === '') throw rt.domError(4, 'The token provided must not be empty.');
  if (/[\t\n\f\r ]/.test(t)) throw rt.domError(3, 'The token provided contains HTML space characters, which are not valid in tokens.');
}

/** Live ordered token set over one attribute, memoised by the element's ATTR_VER. */
class DOMTokenList {
  #el = null;
  #attr = '';
  #ver = -1;
  #tokens = [];
  #supported = null;

  constructor(t = undefined) {
    if (t !== rt.TOKEN) throw new TypeError('Illegal constructor');
  }

  static _for(el, attr, supported = null) {
    const l = new DOMTokenList(rt.TOKEN);
    l.#el = el;
    l.#attr = attr;
    l.#supported = supported;
    return l;
  }

  #sync() {
    const el = this.#el;
    const v = V.T[V.off(el._i) + F.ATTR_VER];
    if (v !== this.#ver || !MEMO) {
      this.#ver = v;
      this.#tokens = parseTokens(el.getAttribute(this.#attr));
    }
    return this.#tokens;
  }

  #update(tokens) {
    const el = this.#el;
    if (tokens.length === 0 && !el.hasAttribute(this.#attr)) return;
    el.setAttribute(this.#attr, tokens.join(' '));
  }

  _get(i) {
    const t = this.#sync();
    if (i >= DTL_IDX.n) DTL_IDX.n = installIndices(DOMTokenList.prototype, DTL_IDX.n, i + 1);
    return t[i];
  }

  get length() {
    const n = this.#sync().length;
    if (n > DTL_IDX.n) DTL_IDX.n = installIndices(DOMTokenList.prototype, DTL_IDX.n, n);
    return n;
  }

  item(index) {
    return this.#sync()[index >>> 0] ?? null;
  }

  contains(token) {
    return this.#sync().includes(str(token));
  }

  add(...tokens) {
    const ts = tokens.map(str);
    for (const t of ts) validateToken(t);
    const cur = this.#sync().slice();
    for (const t of ts) if (!cur.includes(t)) cur.push(t);
    this.#update(cur);
  }

  remove(...tokens) {
    const ts = tokens.map(str);
    for (const t of ts) validateToken(t);
    const cur = this.#sync().filter((t) => !ts.includes(t));
    this.#update(cur);
  }

  toggle(token, force = undefined) {
    token = str(token);
    validateToken(token);
    const cur = this.#sync();
    if (cur.includes(token)) {
      if (force === undefined || !force) {
        this.#update(cur.filter((t) => t !== token));
        return false;
      }
      return true;
    }
    if (force === undefined || force) {
      this.#update([...cur, token]);
      return true;
    }
    return false;
  }

  replace(token, newToken) {
    token = str(token);
    newToken = str(newToken);
    validateToken(token);
    validateToken(newToken);
    const cur = this.#sync();
    if (!cur.includes(token)) return false;
    const out = [];
    for (const t of cur) {
      const r = t === token ? newToken : t;
      if (!out.includes(r)) out.push(r);
    }
    this.#update(out);
    return true;
  }

  supports(token) {
    const s = this.#supported;
    if (s === null) throw new TypeError(`${this.#attr} attribute has no supported tokens`);
    return s.has(rt.asciiLower(str(token)));
  }

  get value() {
    return this.#el.getAttribute(this.#attr) ?? '';
  }

  set value(v) {
    this.#el.setAttribute(this.#attr, v);
  }

  toString() {
    return this.value;
  }

  forEach(callback, thisArg = undefined) {
    const t = this.#sync().slice();
    for (let i = 0; i < t.length; i++) callback.call(thisArg, t[i], i, this);
  }

  keys() {
    return new ListIterator(this, 1);
  }

  values() {
    return new ListIterator(this, 0);
  }

  entries() {
    return new ListIterator(this, 2);
  }
}
DOMTokenList.prototype[Symbol.iterator] = DOMTokenList.prototype.values;
Object.defineProperty(DOMTokenList.prototype, Symbol.toStringTag, { value: 'DOMTokenList', configurable: true });
rt.classes.DOMTokenList = DOMTokenList;
const DTL_IDX = { n: installIndices(DOMTokenList.prototype, 0, 32) };

function tokenListAccessor(C, prop, attr, slot = 'tl', supported = null) {
  Object.defineProperty(C.prototype, prop, {
    get() {
      const s = bs(this);
      return s[slot] ?? (s[slot] = DOMTokenList._for(this, attr, supported));
    },
    set(v) {
      this.setAttribute(attr, v); // [PutForwards=value]
    },
    enumerable: false,
    configurable: true,
  });
}

// ===================================================================================== dataset

class DOMStringMap {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) throw new TypeError('Illegal constructor');
  }
}
Object.defineProperty(DOMStringMap.prototype, Symbol.toStringTag, { value: 'DOMStringMap', configurable: true });
rt.classes.DOMStringMap = DOMStringMap;

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const DATA_RE = /^data-([^A-Z]*)$/;

/** DOMStringMap supported property names: null-namespace `data-*` attributes only (HTML spec). */
function dataNames(el) {
  const out = [];
  const n = N.attrNames(el._i);
  const q = rt.outIds(n * 4);
  for (let i = 0; i < n; i++) {
    if (q[i * 4 + 1] !== 0) continue; // namespaced
    const m = DATA_RE.exec(rt.atomName(q[i * 4 + 3]));
    if (m !== null) out.push(camel(m[1]));
  }
  return out;
}

// The DOMStringMap getter / setter address the attribute with NO namespace and local name `name` (a
// namespaced `data-k` with the same qualified name is a different attribute; M9 review).
function dataGet(el, name) {
  const a = rt.lookupAtom(name);
  return a === 0 ? null : N.getAttrNSA(el._i, 0, a);
}

let attrSetAtom = null;
function dataSet(el, name, v) {
  const a = attrSetAtom(el, name); // validates (InvalidCharacterError)
  rt.check(N.setAttrNSA(el._i, 0, a, 0, String(v)));
  rt.mutated();
}

/** dataset: the one Proxy the design allows (DESIGN §4.3; dataset is cold). */
function makeDataset(el) {
  const target = new DOMStringMap(rt.TOKEN);
  return new Proxy(target, {
    get(t, p, r) {
      if (typeof p !== 'string' || p in t) return Reflect.get(t, p, r);
      const v = dataGet(el, `data-${kebab(p)}`);
      return v === null ? undefined : v;
    },
    set(t, p, v) {
      if (typeof p !== 'string') return Reflect.set(t, p, v);
      if (/-[a-z]/.test(p)) throw rt.domError(4, `'${p}' is not a valid property name`);
      dataSet(el, `data-${kebab(p)}`, v);
      return true;
    },
    has(t, p) {
      if (typeof p !== 'string') return Reflect.has(t, p);
      return dataGet(el, `data-${kebab(p)}`) !== null || Reflect.has(t, p);
    },
    deleteProperty(t, p) {
      if (typeof p !== 'string') return Reflect.deleteProperty(t, p);
      el.removeAttribute(`data-${kebab(p)}`);
      return true;
    },
    ownKeys(t) {
      return [...dataNames(el), ...Reflect.ownKeys(t)];
    },
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === 'string') {
        const v = dataGet(el, `data-${kebab(p)}`);
        if (v !== null && DATA_RE.test(`data-${kebab(p)}`)) return { value: v, writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
    defineProperty(t, p, d) {
      if (typeof p === 'string' && 'value' in d) {
        dataSet(el, `data-${kebab(p)}`, d.value);
        return true;
      }
      return Reflect.defineProperty(t, p, d);
    },
  });
}

// ===================================================================================== value memo

/** API value of input / textarea (memoised by FORM_VER). */
function memoValue(el) {
  const id = el._i;
  const fv = V.T[V.off(id) + F.FORM_VER];
  const s = el._vm;
  if (MEMO && s !== null && s.fv === fv) return s.val;
  const v = N.valueGet(id);
  const st = s !== null && s !== undefined ? s : bs(el);
  st.fv = fv;
  st.val = v;
  return v;
}

/** `valueSet` flag (src/forms/mod.rs VALUE_IS_ARG): the API value is now exactly the argument. */
const VALUE_IS_ARG = 0x100;

/** Value setter of input / textarea: when Rust reports that the value is now `v`, memoise it (no re-read). */
function setValue(el, v) {
  const id = el._i;
  const c = N.valueSet(id, v);
  if (c === VALUE_IS_ARG) {
    // Lone surrogates become U+FFFD in Rust's UTF-8 storage: memoise only what Rust really holds.
    if (MEMO && v.isWellFormed()) {
      const s = bs(el);
      s.fv = V.T[V.off(id) + F.FORM_VER];
      s.val = v;
    }
  } else if (c !== 0) rt.check(c);
}

/** Selection memo (start, end, dir) or null when the selection API does not apply. */
function selection(el) {
  const id = el._i;
  const fv = V.T[V.off(id) + F.FORM_VER];
  const s = bs(el);
  if (!(MEMO && s.sv === fv)) {
    if (N.selGet(id) === 0) {
      s.sd = -1;
    } else {
      const out = rt.outView();
      s.ss = out[0];
      s.se = out[1];
      s.sd = out[2];
    }
    s.sv = fv;
  }
  return s.sd < 0 ? null : s;
}

const DIRS = ['none', 'forward', 'backward'];
function dirCode(d) {
  return d === 'forward' ? 1 : d === 'backward' ? 2 : 0;
}

function invalidState(what) {
  return rt.domError(6, `Failed to ${what}: The input element's type does not support selection.`);
}

function toULongArg(v) {
  return Number(v) >>> 0;
}

/** Selection members shared by HTMLInputElement and HTMLTextAreaElement (own on each prototype). */
function selectionMembers() {
  return {
    get selectionStart() {
      const s = selection(this);
      return s === null ? null : s.ss;
    },
    set selectionStart(v) {
      const s = selection(this);
      if (s === null) throw invalidState("set the 'selectionStart' property");
      const start = toULongArg(v);
      rt.check(N.selSet(this._i, start, Math.max(start, s.se), s.sd));
      queueSelect(this);
    },
    get selectionEnd() {
      const s = selection(this);
      return s === null ? null : s.se;
    },
    set selectionEnd(v) {
      const s = selection(this);
      if (s === null) throw invalidState("set the 'selectionEnd' property");
      rt.check(N.selSet(this._i, s.ss, toULongArg(v), s.sd));
      queueSelect(this);
    },
    get selectionDirection() {
      const s = selection(this);
      return s === null ? null : DIRS[s.sd];
    },
    set selectionDirection(v) {
      const s = selection(this);
      if (s === null) throw invalidState("set the 'selectionDirection' property");
      rt.check(N.selSet(this._i, s.ss, s.se, dirCode(str(v))));
      queueSelect(this);
    },
    setSelectionRange(start, end, direction = undefined) {
      if (arguments.length < 2) throw new TypeError(`Failed to execute 'setSelectionRange': 2 arguments required, but only ${arguments.length} present.`);
      const c = N.selSet(this._i, toULongArg(start), toULongArg(end), direction === undefined ? 0 : dirCode(str(direction)));
      if (c !== 0) throw invalidState("execute 'setSelectionRange'");
      queueSelect(this);
    },
    setRangeText(replacement, start = undefined, end = undefined, selectionMode = 'preserve') {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'setRangeText': 1 argument required, but only 0 present.");
      const explicit = arguments.length >= 3;
      if (arguments.length === 2) throw new TypeError("Failed to execute 'setRangeText': 3 arguments required, but only 2 present.");
      const mode = { preserve: 0, select: 1, start: 2, end: 3 }[str(selectionMode)];
      if (mode === undefined) throw new TypeError(`Failed to execute 'setRangeText': The provided value '${selectionMode}' is not a valid enum value of type SelectionMode.`);
      const c = N.setRangeText(this._i, str(replacement), explicit ? toULongArg(start) : 0, explicit ? toULongArg(end) : 0, mode, explicit);
      if (c === 6) throw invalidState("execute 'setRangeText'");
      rt.check(c);
      rt.mutated();
      queueSelect(this);
    },
    select() {
      if (N.selectAll(this._i)) queueSelect(this);
    },
  };
}

// ====================================================================================== validity

const PATTERNS = new Map();
rt.onReset(() => PATTERNS.clear());

function patternRegExp(p) {
  let r = PATTERNS.get(p);
  if (r === undefined) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(p, 'v');
      r = new RegExp(`^(?:${p})$`, 'v');
    } catch {
      r = null;
    }
    if (PATTERNS.size > 500) PATTERNS.clear();
    PATTERNS.set(p, r);
  }
  return r;
}

/** Full validity bits: Rust's plus the parts that need ECMAScript (pattern, URL parsing, FileList). */
function validityBits(el) {
  const id = el._i;
  let b = N.validity(id);
  if ((b & (VB.CHECK_PATTERN | VB.CHECK_URL | VB.CHECK_FILES)) !== 0) {
    if ((b & VB.CHECK_PATTERN) !== 0) {
      const re = patternRegExp(el.getAttribute('pattern'));
      if (re !== null) {
        const v = N.valueGet(id);
        const multiple = inputTypeOf(id) === 5 && el.hasAttribute('multiple');
        const ok = multiple ? v.split(',').map((s) => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')).every((s) => re.test(s)) : re.test(v);
        if (!ok) b |= VB.PATTERN_MISMATCH;
      }
    }
    if ((b & VB.CHECK_URL) !== 0 && !URL.canParse(N.valueGet(id))) b |= VB.TYPE_MISMATCH;
    if ((b & VB.CHECK_FILES) !== 0) {
      const files = el.files;
      if (files === null || files === undefined || files.length === 0) b |= VB.VALUE_MISSING;
    }
  }
  return b;
}

class ValidityState {
  #el = null;

  constructor(t = undefined) {
    if (t !== rt.TOKEN) throw new TypeError('Illegal constructor');
  }

  static _for(el) {
    const v = new ValidityState(rt.TOKEN);
    v.#el = el;
    return v;
  }

  #b() {
    return validityBits(this.#el);
  }

  get valueMissing() {
    return (this.#b() & VB.VALUE_MISSING) !== 0;
  }

  get typeMismatch() {
    return (this.#b() & VB.TYPE_MISMATCH) !== 0;
  }

  get patternMismatch() {
    return (this.#b() & VB.PATTERN_MISMATCH) !== 0;
  }

  get tooLong() {
    return (this.#b() & VB.TOO_LONG) !== 0;
  }

  get tooShort() {
    return (this.#b() & VB.TOO_SHORT) !== 0;
  }

  get rangeUnderflow() {
    return (this.#b() & VB.RANGE_UNDERFLOW) !== 0;
  }

  get rangeOverflow() {
    return (this.#b() & VB.RANGE_OVERFLOW) !== 0;
  }

  get stepMismatch() {
    return (this.#b() & VB.STEP_MISMATCH) !== 0;
  }

  get badInput() {
    return (this.#b() & VB.BAD_INPUT) !== 0;
  }

  get customError() {
    return (this.#b() & VB.CUSTOM_ERROR) !== 0;
  }

  get valid() {
    return (this.#b() & FAIL_MASK) === 0;
  }
}
Object.defineProperty(ValidityState.prototype, Symbol.toStringTag, { value: 'ValidityState', configurable: true });
rt.classes.ValidityState = ValidityState;

/** Runs "check validity": fires a cancelable `invalid` on failure. */
function checkValidity(el) {
  const b = validityBits(el);
  if ((b & VB.CANDIDATE) === 0 || (b & FAIL_MASK) === 0) return true;
  events.fire(el, 'invalid', { cancelable: true });
  return false;
}

/** Constraint-validation members (input, textarea, select, button, fieldset, output). */
const ConstraintValidation = {
  get willValidate() {
    return (N.validity(this._i) & VB.CANDIDATE) !== 0;
  },
  get validity() {
    const s = bs(this);
    return s.validity ?? (s.validity = ValidityState._for(this));
  },
  get validationMessage() {
    const b = validityBits(this);
    if ((b & VB.CANDIDATE) === 0 || (b & FAIL_MASK) === 0) return '';
    if ((b & VB.CUSTOM_ERROR) !== 0) return N.customValidity(this._i);
    return 'Constraints not satisfied';
  },
  checkValidity() {
    return checkValidity(this);
  },
  reportValidity() {
    return checkValidity(this);
  },
  setCustomValidity(error) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'setCustomValidity': 1 argument required, but only 0 present.");
    N.setCustomValidity(this._i, str(error));
  },
};

// ========================================================================= labels / form owner

const FormAssociated = {
  get form() {
    return wrap(N.formOwner(this._i));
  },
};

const Labelable = {
  get labels() {
    const n = N.labels(this._i);
    if (n === 0xffffffff) return null;
    return staticNodeListFromIds(rt.outIds(n));
  },
};

// =============================================================================== collections

/** Key of live area-B collections: EP[REC] changes with any record write (tree, attributes, form state). */
function recKey() {
  return V.EP[EPI.REC];
}

function idsToWrappers(ids) {
  const a = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) a[i] = wrap(ids[i]);
  return a;
}

class HTMLOptionsCollection extends HTMLCollection {
  get length() {
    const n = super.length;
    coverOptionIndices(n);
    return n;
  }

  set length(v) {
    const sel = OWNER.get(this);
    const n = Number(v) >>> 0;
    const cur = super.length;
    if (n > cur) {
      const doc = sel.ownerDocument;
      for (let i = cur; i < n; i++) sel.appendChild(doc.createElement('option'));
    } else {
      for (let i = cur - 1; i >= n; i--) {
        const o = this.item(i);
        o.parentNode.removeChild(o);
      }
    }
  }

  add(element, before = null) {
    const sel = OWNER.get(this);
    if (element.contains(sel)) throw rt.domError(1, 'The operation would yield an incorrect node tree.');
    if (before instanceof rt.classes.Element && !sel.contains(before)) throw rt.domError(2, 'The object can not be found here.');
    if (element === before) return;
    let ref = null;
    if (before instanceof rt.classes.Node) ref = before;
    else if (typeof before === 'number') ref = this.item(before);
    const parent = ref !== null ? ref.parentNode : sel;
    parent.insertBefore(element, ref);
  }

  remove(index) {
    const i = Number(index) | 0;
    const o = i >= 0 ? this.item(i) : null;
    if (o !== null) o.parentNode.removeChild(o);
  }

  get selectedIndex() {
    return N.selectedIndexGet(OWNER.get(this)._i);
  }

  set selectedIndex(v) {
    N.selectedIndexSet(OWNER.get(this)._i, Number(v) | 0);
  }
}
Object.defineProperty(HTMLOptionsCollection.prototype, Symbol.toStringTag, { value: 'HTMLOptionsCollection', configurable: true });
rt.classes.HTMLOptionsCollection = HTMLOptionsCollection;

class RadioNodeList extends rt.classes.NodeList {
  get value() {
    for (const el of this) {
      if (isHtml(el._i, A.input) && inputTypeOf(el._i) === 16 && el.checked) return el.value;
    }
    return '';
  }

  set value(v) {
    for (const el of this) {
      if (isHtml(el._i, A.input) && inputTypeOf(el._i) === 16 && el.value === v) {
        el.checked = true;
        return;
      }
    }
  }
}
Object.defineProperty(RadioNodeList.prototype, Symbol.toStringTag, { value: 'RadioNodeList', configurable: true });
rt.classes.RadioNodeList = RadioNodeList;

class HTMLFormControlsCollection extends HTMLCollection {
  namedItem(name) {
    name = str(name);
    if (name === '') return null;
    const matches = [];
    for (const el of this) if (el.getAttribute('id') === name || el.getAttribute('name') === name) matches.push(el);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    const l = staticNodeListFromIds(matches.map((m) => m._i));
    Object.setPrototypeOf(l, RadioNodeList.prototype);
    return l;
  }
}
Object.defineProperty(HTMLFormControlsCollection.prototype, Symbol.toStringTag, { value: 'HTMLFormControlsCollection', configurable: true });
rt.classes.HTMLFormControlsCollection = HTMLFormControlsCollection;

/** Owner element of an options collection. */
const OWNER = new WeakMap();

// ------------------------------------------------------------------------------ indexed properties
// HTMLSelectElement, HTMLOptionsCollection (WebIDL `getter` + `setter`) and HTMLFormElement (`getter`) support
// indexed properties: `select[i]` is `select.options[i]`, `select[i] = option | null` runs the options
// collection's indexed setter, `form[i]` is `form.elements[i]`. Like the live lists' index getters
// (collections.cjs) they are accessors on the prototypes, installed up to max(256, the largest `length` any
// access has seen) (CONTRIBUTING §8 "Index getters bound"); getters return the live entry or undefined past
// the end. Without a setter, assigning an index throws in strict code (WebIDL: no indexed setter).

/** Accessor bound shared by a group of prototypes: `cover(n)` makes indices [0, n) resolve. */
function indexedGroup(specs) {
  let have = 0;
  return function cover(n) {
    if (n <= have) return;
    const target = Math.max(n, have * 2, 16);
    for (const { proto, get, set } of specs) {
      for (let i = have; i < target; i++) {
        Object.defineProperty(proto, i, {
          get() {
            return get(this, i);
          },
          set: set === null ? undefined : function (v) {
            set(this, i, v);
          },
          enumerable: false,
          configurable: true,
        });
      }
    }
    have = target;
  };
}

/** Type check + the options collection's indexed setter (HTML §2.7.4, jsdom's filler count). */
function setOptionAt(coll, index, value, iface) {
  if (value === undefined) value = null; // nullable interface type
  if (value !== null && !(value instanceof rt.classes.HTMLOptionElement)) {
    throw new TypeError(`Failed to set the ${index} property on '${iface}': The provided value is not of type 'HTMLOptionElement'.`);
  }
  if (value === null) {
    coll.remove(index);
    return;
  }
  const sel = OWNER.get(coll);
  const n = index - coll.length;
  if (n > 0) {
    const doc = sel.ownerDocument;
    const frag = doc.createDocumentFragment();
    for (let i = 0; i < n; i++) frag.appendChild(doc.createElement('option'));
    sel.appendChild(frag);
  }
  if (n >= 0) sel.appendChild(value);
  else {
    // the option's own parent (Chromium's SetOption -> ReplaceWith); jsdom replaces it as a child of the
    // select, which throws NotFoundError for an option inside an <optgroup>
    const old = coll.item(index);
    old.parentNode.replaceChild(value, old);
  }
}

/** Set by install(): grows the select / options collection index accessors. */
let coverOptionIndices = null;

function liveIds(Proto, owner, native) {
  const id = owner._i;
  const c = liveQueryCollection({ key: recKey, items: () => idsToWrappers(rt.outIds(native(id))) });
  if (Proto !== null) Object.setPrototypeOf(c, Proto.prototype);
  OWNER.set(c, owner);
  return c;
}

// ======================================================================================= FileList

class FileList {
  #files = [];

  constructor(t = undefined) {
    if (t !== rt.TOKEN) throw new TypeError('Illegal constructor');
  }

  get length() {
    return this.#files.length;
  }

  item(i) {
    return this.#files[i >>> 0] ?? null;
  }

  _clear() {
    this.#files.length = 0;
  }

  [Symbol.iterator]() {
    return this.#files[Symbol.iterator]();
  }
}
Object.defineProperty(FileList.prototype, Symbol.toStringTag, { value: 'FileList', configurable: true });
rt.classes.FileList = FileList;

// ========================================================================================= focus

function currentFocus(doc) {
  if (doc === rt.defaultDocument) return V.EP[EPI.FOCUS];
  return N.focusedOf(doc._i);
}

function fireFocus(type, target, related, bubbles) {
  const doc = target.ownerDocument;
  events.fire(target, type, {
    bubbles, composed: true, relatedTarget: related, view: doc?.defaultView ?? null, detail: 0,
  }, events.FocusEvent);
}

/** HTML focusing steps (jsdom `focusingSteps` for a single top-level document). */
function focusingSteps(el) {
  const id = el._i;
  if (id === 0) return;
  const doc = el.ownerDocument;
  if (doc === null || doc.defaultView === null) return;
  let newEl = el;
  if (!N.isFocusable(id)) {
    if (doc.documentElement !== el) return;
    newEl = null; // the viewport (document)
  }
  const old = currentFocus(doc);
  if (newEl === null ? old === 0 : old === id) return;
  const oldEl = old === 0 ? null : wrap(old);
  N.setFocus(doc._i, 0);
  if (oldEl !== null) {
    fireFocus('blur', oldEl, newEl, false);
    fireFocus('focusout', oldEl, newEl, true);
    if (currentFocus(doc) !== 0) return; // a blur listener moved the focus
  }
  if (newEl === null) return;
  if (N.isFocusable(id)) N.setFocus(doc._i, id);
  // jsdom's selection convention at the focusing step, before the focus events (window.cjs Selection).
  if (typeof doc.getSelection === 'function') doc.getSelection()?.collapse(newEl, 0);
  fireFocus('focus', newEl, oldEl, false);
  if (currentFocus(doc) !== id) return;
  fireFocus('focusin', newEl, oldEl, true);
}

/** HTML unfocusing steps. */
function unfocusingSteps(el) {
  const doc = el.ownerDocument;
  if (doc === null || el._i === 0) return;
  if (currentFocus(doc) !== el._i) return;
  if (!N.isFocusable(el._i)) return;
  N.setFocus(doc._i, 0);
  fireFocus('blur', el, null, false);
  fireFocus('focusout', el, null, true);
}

const FocusMembers = {
  focus(_options = undefined) {
    focusingSteps(this);
  },
  blur() {
    unfocusingSteps(this);
  },
};

const TABINDEX_ZERO = new Set(['a', 'area', 'button', 'frame', 'iframe', 'input', 'object', 'select', 'textarea']);

const HTMLOrSVG = {
  get dataset() {
    const s = bs(this);
    return s.ds ?? (s.ds = makeDataset(this));
  },
  get tabIndex() {
    const v = this.getAttribute('tabindex');
    if (v === null) {
      const ns = this.namespaceURI;
      const ln = this.localName;
      if (ns === NS.HTML && (TABINDEX_ZERO.has(ln) || (ln === 'summary' && isSummaryForDetails(this)))) return 0;
      if (ns === NS.SVG && ln === 'a') return 0;
      return -1;
    }
    return Number(v) | 0;
  },
  set tabIndex(v) {
    this.setAttribute('tabindex', String(Number(v) | 0));
  },
  get nonce() {
    return this.getAttribute('nonce') ?? '';
  },
  set nonce(v) {
    this.setAttribute('nonce', v);
  },
  ...FocusMembers,
};

function isSummaryForDetails(el) {
  const p = el.parentNode;
  if (p === null || !(p instanceof rt.classes.Element) || p.localName !== 'details') return false;
  for (let c = p.firstElementChild; c !== null; c = c.nextElementSibling) if (c.localName === 'summary') return c === el;
  return false;
}

// ================================================================================ form submission

function isSubmitButton(el) {
  if (!(el instanceof rt.classes.HTMLElement)) return false;
  const id = el._i;
  if (isHtml(id, A.input)) {
    const t = inputTypeOf(id);
    return t === T_SUBMIT || t === T_IMAGE;
  }
  return el.localName === 'button' && N.buttonType(id) === T_SUBMIT;
}

/** HTMLFormElement "statically validate the constraints" + interactive part (fires `invalid`). */
function formCheckValidity(form) {
  const ids = rt.outIds(N.formCandidates(form._i));
  const invalid = [];
  for (const id of ids) {
    const el = wrap(id);
    if ((validityBits(el) & FAIL_MASK) !== 0) invalid.push(el);
  }
  for (const el of invalid) events.fire(el, 'invalid', { cancelable: true });
  return invalid.length === 0;
}

function submitForm(form, submitter) {
  if (!form.hasAttribute('novalidate') && !formCheckValidity(form)) return;
  // No navigation: an uncanceled submission is a no-op (jsdom reports "not implemented").
  events.fire(form, 'submit', { bubbles: true, cancelable: true, submitter }, events.SubmitEvent);
}

/**
 * HTML "construct the entry list" (jsdom `FormData-impl.js`): [name, value] pairs, values are strings or
 * File objects. AREA C's FormData override (`new FormData(form, submitter)`) builds on this.
 */
function formEntries(form, submitter = null) {
  if (!(form instanceof rt.classes.HTMLFormElement)) throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
  if (submitter !== null && submitter !== undefined) {
    if (!isSubmitButton(submitter)) throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
    if (submitter.form !== form) throw rt.domError(2, "Failed to construct 'FormData': The specified element is not owned by this form element.");
  } else submitter = null;
  const ids = rt.outIds(N.formSubmittables(form._i));
  const out = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    let inDatalist = false;
    for (let p = V.T[V.off(id) + F.PARENT]; p > 0; p = V.T[V.off(p) + F.PARENT]) {
      if (isHtml(p, A.datalist)) {
        inDatalist = true;
        break;
      }
    }
    if (inDatalist || N.isDisabled(id)) continue;
    const el = wrap(id);
    const isInput = isHtml(id, A.input);
    const t = isInput ? inputTypeOf(id) : -1;
    const isButton = isHtml(id, A.button) || t === T_SUBMIT || t === T_IMAGE || t === T_RESET || t === T_BUTTON;
    if (isButton && el !== submitter) continue;
    if ((t === 15 || t === 16) && (V.T[V.off(id) + F.STATE] & S.CHECKED) === 0) continue;
    if (isHtml(id, A.object)) continue;
    const name = el.getAttribute('name');
    if (t === T_IMAGE) {
      const prefix = name ? `${name}.` : '';
      out.push([`${prefix}x`, '0'], [`${prefix}y`, '0']);
      continue;
    }
    if (name === null || name === '') continue;
    if (isHtml(id, A.select)) {
      const opts = rt.outIds(N.selectOptions(id));
      for (const o of opts) if ((V.T[V.off(o) + F.STATE] & S.SELECTED) !== 0) out.push([name, N.valueGet(o)]);
    } else if (t === 15 || t === 16) {
      out.push([name, el.getAttribute('value') ?? 'on']);
    } else if (t === T_FILE) {
      const files = el.files;
      if (files === null || files.length === 0) out.push([name, new File([], '', { type: 'application/octet-stream' })]);
      else for (let i = 0; i < files.length; i++) out.push([name, files.item(i)]);
    } else {
      out.push([name, N.valueGet(id)]);
    }
    const dirname = el.getAttribute('dirname');
    if (dirname !== null && dirname !== '') out.push([dirname, 'ltr']);
  }
  return out;
}

function resetForm(form) {
  if (!events.fire(form, 'reset', { bubbles: true, cancelable: true })) return;
  N.formReset(form._i);
  for (const el of form.elements) {
    if (el.localName === 'output' && el.namespaceURI === NS.HTML) {
      el.textContent = el.defaultValue;
      N.setOutputOverride(el._i, null);
    }
  }
  rt.mutated();
}

// =================================================================================== install

// <details> toggle events (HTML "queue a details toggle event task"). Rust queues the element when its
// `open` attribute is added or removed (attribute APIs, the `open` setter, summary activation, the parser)
// and sets bit 1 of EP[MO_PENDING]; `mutated()` calls this. A queued task coalesces later changes (the
// details toggle task tracker) and fires a plain `toggle` Event from a task, like jsdom.
const TOGGLE_PENDING = new Set();
rt.onReset(() => TOGGLE_PENDING.clear());

function runUaTasks() {
  const ids = rt.outIds(N.takeToggles());
  for (const id of ids) {
    const el = rt.wrap(id);
    if (TOGGLE_PENDING.has(el)) continue;
    TOGGLE_PENDING.add(el);
    const envGen = rt.envGen;
    setImmediate(() => {
      TOGGLE_PENDING.delete(el);
      if (el._i !== 0 && rt.envGen === envGen) events.fire(el, 'toggle', {});
    });
  }
}

function install(_rt, dom) {
  const C = rt.classes;
  const { HTMLElement, SVGElement, Element, Document } = dom;
  rt.setUaTaskHandler(runUaTasks);
  attrSetAtom = dom.attrSetAtom;

  events.hooks.requestSubmit = submitForm;
  events.hooks.reset = resetForm;

  // ---------------------------------------------------------------------------- all elements
  defineAll(Element, {
    get classList() {
      const s = bs(this);
      return s.cl ?? (s.cl = DOMTokenList._for(this, 'class'));
    },
    set classList(v) {
      this.setAttribute('class', v);
    },
    // No layout: jsdom keeps the last value assigned (a plain field), so a scroll round-trip
    // (React's restoreSelection, scroll-restoration code) reads back what it wrote.
    get scrollTop() {
      const s = this._vm;
      return s === null || s === undefined ? 0 : s.sy;
    },
    set scrollTop(v) {
      bs(this).sy = Number(v);
    },
    get scrollLeft() {
      const s = this._vm;
      return s === null || s === undefined ? 0 : s.sx;
    },
    set scrollLeft(v) {
      bs(this).sx = Number(v);
    },
    get scrollWidth() {
      return 0;
    },
    get scrollHeight() {
      return 0;
    },
    get clientTop() {
      return 0;
    },
    get clientLeft() {
      return 0;
    },
    get clientWidth() {
      return 0;
    },
    get clientHeight() {
      return 0;
    },
  });

  defineAll(HTMLElement, {
    get offsetParent() {
      return null;
    },
    get offsetTop() {
      return 0;
    },
    get offsetLeft() {
      return 0;
    },
    get offsetWidth() {
      return 0;
    },
    get offsetHeight() {
      return 0;
    },
    get dir() {
      const v = this.getAttribute('dir');
      if (v === null) return '';
      const l = rt.asciiLower(v);
      return l === 'ltr' || l === 'rtl' || l === 'auto' ? l : '';
    },
    set dir(v) {
      this.setAttribute('dir', v);
    },
    get translate() {
      const v = this.getAttribute('translate');
      if (v !== null) {
        const l = rt.asciiLower(v);
        if (l === 'yes' || l === '') return true;
        if (l === 'no') return false;
      }
      const p = this.parentElement;
      return p === null || !(p instanceof HTMLElement) || p.translate;
    },
    set translate(v) {
      this.setAttribute('translate', v ? 'yes' : 'no');
    },
    get draggable() {
      const v = rt.asciiLower(this.getAttribute('draggable') ?? '');
      if (v === 'true') return true;
      if (v === 'false') return false;
      return this.localName === 'img' || (this.localName === 'a' && this.hasAttribute('href'));
    },
    set draggable(v) {
      this.setAttribute('draggable', String(!!v));
    },
    get contentEditable() {
      const v = this.getAttribute('contenteditable');
      if (v === null) return 'inherit';
      const l = rt.asciiLower(v);
      if (l === '' || l === 'true') return 'true';
      if (l === 'false') return 'false';
      if (l === 'plaintext-only') return 'plaintext-only';
      return 'inherit';
    },
    set contentEditable(v) {
      const l = rt.asciiLower(str(v));
      if (l === 'inherit') this.removeAttribute('contenteditable');
      else if (l === 'true' || l === 'false' || l === 'plaintext-only') this.setAttribute('contenteditable', l);
      else throw rt.domError(4, `Failed to set the 'contentEditable' property on 'HTMLElement': The value provided ('${v}') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.`);
    },
    get isContentEditable() {
      for (let e = this; e !== null && e instanceof HTMLElement; e = e.parentElement) {
        const c = e.contentEditable;
        if (c === 'true' || c === 'plaintext-only') return true;
        if (c === 'false') return false;
      }
      return false;
    },
  }, HTMLOrSVG);
  reflectStr(HTMLElement, 'title');
  reflectStr(HTMLElement, 'lang');
  reflectStr(HTMLElement, 'accessKey', 'accesskey');
  reflectBool(HTMLElement, 'hidden');

  defineAll(SVGElement, HTMLOrSVG);
  defineAll(dom.MathMLElement, HTMLOrSVG);

  // --------------------------------------------------------------------------------- document
  defineAll(Document, {
    get activeElement() {
      const f = currentFocus(this);
      if (f !== 0) return wrap(f);
      return this.body ?? this.documentElement;
    },
  });

  // ------------------------------------------------------------------------------------ input
  const Input = C.HTMLInputElement;
  defineAll(Input, {
    get type() {
      return INPUT_TYPES[inputTypeOf(this._i)];
    },
    set type(v) {
      this.setAttribute('type', v);
    },
    get value() {
      if (inputTypeOf(this._i) === T_FILE) {
        const f = bs(this).files;
        return f !== null && f.length > 0 ? `C:\\fakepath\\${f.item(0).name}` : '';
      }
      return memoValue(this);
    },
    set value(v) {
      v = strNullEmpty(v);
      if (inputTypeOf(this._i) === T_FILE) {
        if (v !== '') rt.check(6, "Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename, which may only be programmatically set to the empty string.");
        bs(this).files?._clear();
        return;
      }
      setValue(this, v);
      rt.mutated();
    },
    get checked() {
      return (V.T[V.off(this._i) + F.STATE] & S.CHECKED) !== 0;
    },
    set checked(v) {
      N.setChecked(this._i, !!v);
    },
    get indeterminate() {
      return (V.T[V.off(this._i) + F.STATE] & S.INDETERMINATE) !== 0;
    },
    set indeterminate(v) {
      N.setIndeterminate(this._i, !!v);
    },
    get valueAsNumber() {
      return N.inputNumber(this._i);
    },
    set valueAsNumber(v) {
      const t = INPUT_TYPES[inputTypeOf(this._i)];
      const n = Number(v);
      if (t !== 'number' && t !== 'range') {
        throw rt.domError(6, "Failed to set the 'valueAsNumber' property on 'HTMLInputElement': This input element does not support Number values.");
      }
      if (!Number.isFinite(n) && !Number.isNaN(n)) throw new TypeError('Failed to set infinite value as Number');
      this.value = Number.isNaN(n) ? '' : String(n);
    },
    get files() {
      if (inputTypeOf(this._i) !== T_FILE) return null;
      const s = bs(this);
      return s.files ?? (s.files = new FileList(rt.TOKEN));
    },
    set files(v) {
      if (inputTypeOf(this._i) === T_FILE && v !== null && v !== undefined) bs(this).files = v;
    },
    get list() {
      const id = this.getAttribute('list');
      if (!id) return null;
      const root = this.getRootNode();
      const el = typeof root.getElementById === 'function' ? root.getElementById(id) : null;
      return el !== null && el.localName === 'datalist' ? el : null;
    },
  }, selectionMembers(), ConstraintValidation, FormAssociated, Labelable);
  reflectStr(Input, 'defaultValue', 'value');
  reflectBool(Input, 'defaultChecked', 'checked');
  for (const p of ['accept', 'alt', 'autocomplete', 'max', 'min', 'name', 'pattern', 'placeholder', 'step', 'align']) reflectStr(Input, p);
  reflectStr(Input, 'dirName', 'dirname');
  reflectStr(Input, 'formTarget', 'formtarget');
  reflectStr(Input, 'inputMode', 'inputmode');
  reflectStr(Input, 'useMap', 'usemap');
  for (const p of ['autofocus', 'disabled', 'multiple', 'required']) reflectBool(Input, p);
  reflectBool(Input, 'readOnly', 'readonly');
  reflectBool(Input, 'formNoValidate', 'formnovalidate');
  reflectLong(Input, 'maxLength', 'maxlength', -1, true);
  reflectLong(Input, 'minLength', 'minlength', -1, true);
  reflectULong(Input, 'size', 'size', 20, true);
  reflectURL(Input, 'src');
  reflectURL(Input, 'formAction', 'formaction');

  // --------------------------------------------------------------------------------- textarea
  const TextArea = C.HTMLTextAreaElement;
  defineAll(TextArea, {
    get type() {
      return 'textarea';
    },
    get value() {
      return memoValue(this);
    },
    set value(v) {
      setValue(this, strNullEmpty(v));
    },
    get defaultValue() {
      return N.childText(this._i);
    },
    set defaultValue(v) {
      this.textContent = v;
    },
    get textLength() {
      return memoValue(this).length;
    },
  }, selectionMembers(), ConstraintValidation, FormAssociated, Labelable);
  for (const p of ['autocomplete', 'name', 'placeholder', 'wrap']) reflectStr(TextArea, p);
  reflectStr(TextArea, 'dirName', 'dirname');
  reflectStr(TextArea, 'inputMode', 'inputmode');
  for (const p of ['autofocus', 'disabled', 'required']) reflectBool(TextArea, p);
  reflectBool(TextArea, 'readOnly', 'readonly');
  reflectLong(TextArea, 'maxLength', 'maxlength', -1, true);
  reflectLong(TextArea, 'minLength', 'minlength', -1, true);
  reflectULong(TextArea, 'cols', 'cols', 20, true);
  reflectULong(TextArea, 'rows', 'rows', 2, true);

  // ----------------------------------------------------------------------------------- select
  const Select = C.HTMLSelectElement;
  const optionsOf = (sel) => {
    const s = bs(sel);
    return s.coll ?? (s.coll = liveIds(HTMLOptionsCollection, sel, N.selectOptions));
  };
  defineAll(Select, {
    get type() {
      return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
    },
    get value() {
      return N.valueGet(this._i);
    },
    set value(v) {
      N.valueSet(this._i, strNullEmpty(v));
    },
    get options() {
      return optionsOf(this);
    },
    get selectedOptions() {
      const s = bs(this);
      return s.coll2 ?? (s.coll2 = liveIds(null, this, N.selectedOptions));
    },
    get selectedIndex() {
      return N.selectedIndexGet(this._i);
    },
    set selectedIndex(v) {
      N.selectedIndexSet(this._i, Number(v) | 0);
    },
    get length() {
      return optionsOf(this).length;
    },
    set length(v) {
      optionsOf(this).length = v;
    },
    item(index) {
      return optionsOf(this).item(index);
    },
    namedItem(name) {
      return optionsOf(this).namedItem(name);
    },
    add(element, before = null) {
      optionsOf(this).add(element, before);
    },
    remove(...args) {
      if (args.length === 0) {
        C.Element.prototype.remove.call(this);
        return;
      }
      optionsOf(this).remove(args[0]);
    },
  }, ConstraintValidation, FormAssociated, Labelable);
  // WebIDL: an interface with an indexed getter and an integer `length` gets Array.prototype.values as
  // @@iterator (jsdom: `[...select]` iterates the options).
  Object.defineProperty(Select.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true });
  coverOptionIndices = indexedGroup([
    {
      proto: Select.prototype,
      get: (sel, i) => optionsOf(sel)._get(i),
      set: (sel, i, v) => setOptionAt(optionsOf(sel), i, v, 'HTMLSelectElement'),
    },
    {
      proto: HTMLOptionsCollection.prototype,
      get: (coll, i) => coll._get(i),
      set: (coll, i, v) => setOptionAt(coll, i, v, 'HTMLOptionsCollection'),
    },
  ]);
  coverOptionIndices(256);
  for (const p of ['autofocus', 'disabled', 'multiple', 'required']) reflectBool(Select, p);
  reflectStr(Select, 'name');
  reflectULong(Select, 'size', 'size', 0);

  // ----------------------------------------------------------------------------------- option
  const Option = C.HTMLOptionElement;
  defineAll(Option, {
    get value() {
      return N.valueGet(this._i);
    },
    set value(v) {
      this.setAttribute('value', v);
    },
    get text() {
      return N.optionText(this._i);
    },
    set text(v) {
      this.textContent = v;
    },
    get label() {
      return this.getAttribute('label') ?? N.optionText(this._i);
    },
    set label(v) {
      this.setAttribute('label', v);
    },
    get selected() {
      return (V.T[V.off(this._i) + F.STATE] & S.SELECTED) !== 0;
    },
    set selected(v) {
      N.setSelected(this._i, !!v);
    },
    get index() {
      return N.optionIndex(this._i);
    },
  }, FormAssociated);
  reflectBool(Option, 'disabled');
  reflectBool(Option, 'defaultSelected', 'selected');

  /** `new Option(text, value, defaultSelected, selected)` (legacy factory function). */
  function OptionFactory(text = '', value = undefined, defaultSelected = false, selected = false) {
    if (new.target === undefined) throw new TypeError("Failed to construct 'Option': Please use the 'new' operator.");
    const doc = rt.defaultDocument;
    if (doc === null) throw new TypeError('rsdom: no document');
    const o = doc.createElement('option');
    text = str(text);
    if (text !== '') o.appendChild(doc.createTextNode(text));
    if (value !== undefined) o.setAttribute('value', value);
    if (defaultSelected) o.setAttribute('selected', '');
    o.selected = !!selected;
    return o;
  }
  OptionFactory.prototype = Option.prototype;
  Object.defineProperty(OptionFactory, 'name', { value: 'Option' });
  C.Option = OptionFactory;

  const OptGroup = C.HTMLOptGroupElement;
  reflectBool(OptGroup, 'disabled');
  reflectStr(OptGroup, 'label');

  // ----------------------------------------------------------------------------------- button
  const Button = C.HTMLButtonElement;
  defineAll(Button, {
    get type() {
      return INPUT_TYPES[N.buttonType(this._i)];
    },
    set type(v) {
      const l = rt.asciiLower(str(v));
      this.setAttribute('type', l === 'reset' || l === 'button' ? l : 'submit');
    },
  }, ConstraintValidation, FormAssociated, Labelable);
  reflectBool(Button, 'autofocus');
  reflectBool(Button, 'disabled');
  reflectBool(Button, 'formNoValidate', 'formnovalidate');
  reflectStr(Button, 'formTarget', 'formtarget');
  reflectStr(Button, 'name');
  reflectStr(Button, 'value');
  reflectURL(Button, 'formAction', 'formaction');

  // ------------------------------------------------------------------------------------- form
  const Form = C.HTMLFormElement;
  const formElements = (form) => {
    const s = bs(form);
    return s.coll ?? (s.coll = liveIds(HTMLFormControlsCollection, form, N.formElements));
  };
  // `form[i]` (indexed getter, no setter) + WebIDL @@iterator for indexed interfaces with a `length`
  const coverFormIndices = indexedGroup([{ proto: Form.prototype, get: (f, i) => formElements(f)._get(i), set: null }]);
  coverFormIndices(256);
  Object.defineProperty(Form.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true });
  defineAll(Form, {
    get elements() {
      return formElements(this);
    },
    get length() {
      const n = formElements(this).length;
      coverFormIndices(n);
      return n;
    },
    get method() {
      const m = rt.asciiLower(this.getAttribute('method') ?? '');
      return m === 'post' || m === 'dialog' ? m : 'get';
    },
    set method(v) {
      this.setAttribute('method', v);
    },
    get enctype() {
      const t = rt.asciiLower(this.getAttribute('enctype') ?? '');
      return t === 'multipart/form-data' || t === 'text/plain' ? t : 'application/x-www-form-urlencoded';
    },
    set enctype(v) {
      this.setAttribute('enctype', v);
    },
    get encoding() {
      return this.enctype;
    },
    set encoding(v) {
      this.enctype = v;
    },
    get action() {
      const v = this.getAttribute('action');
      const doc = this.ownerDocument;
      if (v === null || v === '') return doc?.URL ?? '';
      return parseURL(this, v) ?? v;
    },
    set action(v) {
      this.setAttribute('action', v);
    },
    submit() {
      // No navigation in rsdom (jsdom reports "not implemented"); a silent no-op.
    },
    requestSubmit(submitter = null) {
      if (submitter !== null && submitter !== undefined) {
        if (!isSubmitButton(submitter)) throw new TypeError("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not a submit button.");
        if (submitter.form !== this) throw rt.domError(2, "Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not owned by this form element.");
      } else submitter = null;
      submitForm(this, submitter);
    },
    reset() {
      resetForm(this);
    },
    checkValidity() {
      return formCheckValidity(this);
    },
    reportValidity() {
      return formCheckValidity(this);
    },
  });
  reflectStr(Form, 'acceptCharset', 'accept-charset');
  reflectStr(Form, 'name');
  reflectStr(Form, 'target');
  reflectStr(Form, 'autocomplete');
  reflectBool(Form, 'noValidate', 'novalidate');

  // ----------------------------------------------------------------------- label / fieldset / ...
  const Label = C.HTMLLabelElement;
  defineAll(Label, {
    get control() {
      return wrap(N.labelControl(this._i));
    },
    get form() {
      const c = N.labelControl(this._i);
      return c === 0 ? null : wrap(N.formOwner(c));
    },
  });
  reflectStr(Label, 'htmlFor', 'for');

  const FieldSet = C.HTMLFieldSetElement;
  defineAll(FieldSet, {
    get type() {
      return 'fieldset';
    },
    get elements() {
      const s = bs(this);
      return s.coll ?? (s.coll = liveIds(null, this, N.fieldsetElements));
    },
  }, ConstraintValidation, FormAssociated);
  reflectBool(FieldSet, 'disabled');
  reflectStr(FieldSet, 'name');

  const Legend = C.HTMLLegendElement;
  defineAll(Legend, {
    get form() {
      const p = this.parentNode;
      return p !== null && p instanceof FieldSet ? p.form : null;
    },
  });

  const Output = C.HTMLOutputElement;
  defineAll(Output, {
    get type() {
      return 'output';
    },
    get value() {
      return this.textContent;
    },
    set value(v) {
      N.setOutputOverride(this._i, this.defaultValue);
      this.textContent = v;
    },
    get defaultValue() {
      return N.outputOverride(this._i) ?? this.textContent;
    },
    set defaultValue(v) {
      if (N.outputOverride(this._i) === null) this.textContent = v;
      else N.setOutputOverride(this._i, str(v));
    },
  }, ConstraintValidation, FormAssociated, Labelable);
  reflectStr(Output, 'name');
  tokenListAccessor(Output, 'htmlFor', 'for');

  const Details = C.HTMLDetailsElement;
  reflectBool(Details, 'open');

  // ------------------------------------------------------------------------------------ dialog
  const Dialog = C.HTMLDialogElement;
  const DIALOG_RV = new WeakMap();
  defineAll(Dialog, {
    get returnValue() {
      return DIALOG_RV.get(this) ?? '';
    },
    set returnValue(v) {
      DIALOG_RV.set(this, str(v));
    },
    show() {
      if (!this.hasAttribute('open')) this.setAttribute('open', '');
    },
    showModal() {
      if (this.hasAttribute('open')) return;
      if (!this.isConnected) throw rt.domError(6, "Failed to execute 'showModal' on 'HTMLDialogElement': The element is not in a Document.");
      this.setAttribute('open', '');
    },
    close(returnValue = undefined) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      if (returnValue !== undefined) DIALOG_RV.set(this, str(returnValue));
      events.fire(this, 'close', {});
    },
  });
  reflectBool(Dialog, 'open');

  // --------------------------------------------------------------------------- image / links
  const Img = C.HTMLImageElement;
  defineAll(Img, {
    get width() {
      const v = this.getAttribute('width');
      return v === null ? 0 : Math.max(0, parseInteger(v) ?? 0);
    },
    set width(v) {
      this.setAttribute('width', String(Number(v) >>> 0));
    },
    get height() {
      const v = this.getAttribute('height');
      return v === null ? 0 : Math.max(0, parseInteger(v) ?? 0);
    },
    set height(v) {
      this.setAttribute('height', String(Number(v) >>> 0));
    },
    get naturalWidth() {
      return 0;
    },
    get naturalHeight() {
      return 0;
    },
    get complete() {
      const s = this.getAttribute('src');
      return s === null || s === '';
    },
    get currentSrc() {
      return '';
    },
    decode() {
      return Promise.resolve();
    },
    get crossOrigin() {
      return this.getAttribute('crossorigin');
    },
    set crossOrigin(v) {
      if (v === null) this.removeAttribute('crossorigin');
      else this.setAttribute('crossorigin', v);
    },
  });
  reflectURL(Img, 'src');
  reflectURL(Img, 'lowsrc');
  reflectURL(Img, 'longDesc', 'longdesc');
  for (const p of ['alt', 'srcset', 'sizes', 'name', 'align', 'loading', 'decoding']) reflectStr(Img, p);
  reflectStr(Img, 'useMap', 'usemap');
  reflectBool(Img, 'isMap', 'ismap');

  /** `new Image(width, height)` (legacy factory function). */
  function ImageFactory(width = undefined, height = undefined) {
    if (new.target === undefined) throw new TypeError("Failed to construct 'Image': Please use the 'new' operator.");
    const doc = rt.defaultDocument;
    if (doc === null) throw new TypeError('rsdom: no document');
    const img = doc.createElement('img');
    if (width !== undefined) img.setAttribute('width', String(Number(width) >>> 0));
    if (height !== undefined) img.setAttribute('height', String(Number(height) >>> 0));
    return img;
  }
  ImageFactory.prototype = Img.prototype;
  Object.defineProperty(ImageFactory, 'name', { value: 'Image' });
  C.Image = ImageFactory;

  const URL_PARTS = ['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
  const Hyperlink = {
    get href() {
      const v = this.getAttribute('href');
      if (v === null) return '';
      return parseURL(this, v) ?? v;
    },
    set href(v) {
      this.setAttribute('href', v);
    },
    get origin() {
      const h = this.getAttribute('href');
      const u = h === null ? null : parseURL(this, h);
      return u === null ? '' : new URL(u).origin;
    },
    toString() {
      return this.href;
    },
  };
  for (const part of URL_PARTS) {
    Object.defineProperty(Hyperlink, part, {
      get() {
        const h = this.getAttribute('href');
        const u = h === null ? null : parseURL(this, h);
        if (u === null) return part === 'protocol' ? ':' : '';
        return new URL(u)[part];
      },
      set(v) {
        const h = this.getAttribute('href');
        const u = h === null ? null : parseURL(this, h);
        if (u === null) return;
        const url = new URL(u);
        url[part] = str(v);
        this.setAttribute('href', url.href);
      },
      enumerable: true,
      configurable: true,
    });
  }
  for (const H of [C.HTMLAnchorElement, C.HTMLAreaElement]) {
    defineAll(H, Hyperlink);
    for (const p of ['target', 'download', 'rel', 'hreflang', 'type', 'referrerPolicy', 'ping']) reflectStr(H, p, p.toLowerCase());
    tokenListAccessor(H, 'relList', 'rel');
  }
  defineAll(C.HTMLAnchorElement, {
    get text() {
      return this.textContent;
    },
    set text(v) {
      this.textContent = v;
    },
  });
  for (const p of ['coords', 'charset', 'name', 'rev', 'shape']) reflectStr(C.HTMLAnchorElement, p);
  reflectStr(C.HTMLAreaElement, 'alt');
  reflectStr(C.HTMLAreaElement, 'coords');
  reflectStr(C.HTMLAreaElement, 'shape');
  const Link = C.HTMLLinkElement;
  reflectURL(Link, 'href');
  for (const p of ['rel', 'media', 'hreflang', 'type', 'as', 'sizes', 'integrity']) reflectStr(Link, p);
  tokenListAccessor(Link, 'relList', 'rel');
  for (const H of [C.HTMLScriptElement, C.HTMLIFrameElement, C.HTMLSourceElement, C.HTMLEmbedElement, C.HTMLMediaElement, C.HTMLTrackElement]) {
    if (H !== undefined) reflectURL(H, 'src');
  }
  reflectURL(C.HTMLBaseElement, 'href');
}

module.exports = {
  install, INPUT_TYPES, DOMTokenList, ValidityState, focusingSteps, unfocusingSteps, currentFocus, formEntries,
  baseURL,
};
