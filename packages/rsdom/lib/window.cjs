'use strict';
// AREA C (window/globals, DESIGN §12, §18, ROADMAP M6). `makeWindow(ctx, global)` builds the window of a
// browsing context (lib/context.cjs, which owns the document, the URL, timers and teardown):
// - `createWindow()` (plain Node, contract tests): a fresh null-prototype object;
// - the Vitest environment (lib/vitest-environment.mjs): `global = globalThis`, so every member is
//   installed as an OWN DATA property of globalThis (1-2 ns per read, vs ~20 ns for populateGlobal accessors);
//   the context's `close()` puts the original properties back.
//
// Members: every interface constructor in `rt.classes` (installed generically, so whatever areas A/B
// register appears without editing this file), window/self/top/parent/frames = the window, document
// (`document.defaultView === window`), location, history, navigator, screen, localStorage/sessionStorage,
// matchMedia, requestAnimationFrame/cancelAnimationFrame (Node timers), getComputedStyle (area A), getSelection,
// CSS.escape/supports, FormData override `(form, submitter)` (area B's formEntries), geometry constants and
// no-op scroll/alert-family functions. The window is an EventTarget through area B's `installWindow`.
//
// Kept as Node's (never overridden): timers, setImmediate, queueMicrotask, performance, console,
// AbortController/AbortSignal, MessageChannel, typed arrays, URL, fetch, crypto, DOMException,
// structuredClone, TextEncoder/Decoder. Names rsdom does not implement are not defined (feature detection
// with `in` must not be fooled): no DataTransfer, requestIdleCallback, TextEvent,
// reportError, documentMode. ResizeObserver and IntersectionObserver come from lib/observers.cjs (DESIGN §24).
// Blob and File are rsdom's subclasses of Node's (lib/file-api.cjs, DESIGN §27).

const rt = require('./runtime.cjs');

// NOT read at load: `FormData` (and `performance`) are lazy Node globals; touching FormData's descriptor loads
// undici (~50-70 ms per process or worker), so rsdom ships its own FormData and deletes Node's.

const VERSION = '0.1.0';
const USER_AGENT = `Mozilla/5.0 (${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'}) AppleWebKit/537.36 (KHTML, like Gecko) rsdom/${VERSION}`;

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

/** Private state of window-plumbing objects (Location, History: `{ ctx, ... }`), keyed by the object. */
const state = new WeakMap();

// =========================================================================================== Storage
// DESIGN §26. A Storage is a legacy platform object with named properties (`localStorage.foo = 'x'`,
// `'foo' in localStorage`, `delete`, `Object.keys`): like jsdom's generated wrapper
// (node_modules/jsdom/lib/generated/idl/Storage.js), each instance is a Proxy over an ordinary target whose
// prototype is Storage.prototype. The items live in a facade Map: storage is window state, not DOM state.

/** jsdom's default `storageQuota` (refs/jsdom/lib/api.js), in UTF-16 code units of keys plus values. */
const STORAGE_QUOTA = 5000000;

/** Storage area per proxy and per proxy target (the traps see the target, methods see the proxy). */
const areas = new WeakMap();

function area(s, name) {
  const m = areas.get(s);
  if (m === undefined) throw new TypeError(`'${name}' called on an object that is not a valid instance of Storage.`);
  return m;
}

function needArgs(len, n, name) {
  if (len < n) {
    throw new TypeError(`Failed to execute '${name}' on 'Storage': ${n} argument${n > 1 ? 's' : ''} required, but only ${len} present.`);
  }
}

/** WebIDL DOMString conversion (a template literal throws TypeError on a Symbol, as ToString must). */
const domString = (v) => (typeof v === 'string' ? v : `${v}`);

class QuotaExceededError extends DOMException {
  #quota = null;
  #requested = null;

  constructor(message = '', options = undefined) {
    super(message === undefined ? '' : domString(message), 'QuotaExceededError');
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' && typeof options !== 'function') {
        throw new TypeError("Failed to construct 'QuotaExceededError': parameter 2 is not of type 'QuotaExceededErrorOptions'.");
      }
      const finite = (v, k) => {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new TypeError(`Failed to construct 'QuotaExceededError': ${k} is not a finite floating-point value.`);
        return n;
      };
      const { quota, requested } = options;
      if (quota !== undefined) {
        this.#quota = finite(quota, 'quota');
        if (this.#quota < 0) throw new RangeError('quota must be non-negative');
      }
      if (requested !== undefined) {
        this.#requested = finite(requested, 'requested');
        if (this.#requested < 0) throw new RangeError('requested must be non-negative');
      }
      if (this.#quota !== null && this.#requested !== null && this.#requested < this.#quota) {
        throw new RangeError('requested must be greater than or equal to quota');
      }
    }
  }

  get quota() {
    return this.#quota;
  }

  get requested() {
    return this.#requested;
  }
}
tag(QuotaExceededError);

class Storage {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  get length() {
    return area(this, 'length').items.size;
  }

  key(index) {
    const { items } = area(this, 'key');
    needArgs(arguments.length, 1, 'key');
    const i = Number(index) >>> 0;
    if (i >= items.size) return null;
    let k = 0;
    for (const key of items.keys()) if (k++ === i) return key;
    return null;
  }

  getItem(key) {
    const { items } = area(this, 'getItem');
    needArgs(arguments.length, 1, 'getItem');
    const v = items.get(domString(key));
    return v === undefined ? null : v;
  }

  setItem(key, value) {
    const a = area(this, 'setItem');
    needArgs(arguments.length, 2, 'setItem');
    setItem(a, domString(key), domString(value));
  }

  removeItem(key) {
    const { items } = area(this, 'removeItem');
    needArgs(arguments.length, 1, 'removeItem');
    items.delete(domString(key));
  }

  clear() {
    area(this, 'clear').items.clear();
  }
}
tag(Storage);

/** setItem steps with jsdom's quota check (refs/jsdom/lib/jsdom/living/webstorage/Storage-impl.js). */
function setItem(a, key, value) {
  const { items } = a;
  if (items.get(key) === value) return;
  let total = key.length + value.length;
  for (const [k, v] of items) if (k !== key) total += k.length + v.length;
  if (total > a.quota) throw new QuotaExceededError(`The ${a.quota}-code unit storage quota has been exceeded.`);
  items.set(key, value);
}

/**
 * The named-property traps: WebIDL's legacy platform object [[GetOwnProperty]], [[Set]], [[DefineOwnProperty]],
 * [[Delete]] and [[OwnPropertyKeys]] for an interface with a named getter, setter and deleter and no
 * [LegacyOverrideBuiltIns]: an item is visible as a property only when no own or inherited property shadows it.
 */
const storageTraps = {
  get(target, P, receiver) {
    if (typeof P !== 'symbol' && !(P in target)) {
      const v = areas.get(target).items.get(P);
      if (v !== undefined) return v;
    }
    return Reflect.get(target, P, receiver);
  },

  has(target, P) {
    if (typeof P !== 'symbol' && areas.get(target).items.has(P)) return true;
    return Reflect.has(target, P);
  },

  getOwnPropertyDescriptor(target, P) {
    if (typeof P !== 'symbol' && !(P in target)) {
      const v = areas.get(target).items.get(P);
      if (v !== undefined) return { value: v, writable: true, enumerable: true, configurable: true };
    }
    return Reflect.getOwnPropertyDescriptor(target, P);
  },

  set(target, P, V, receiver) {
    const a = areas.get(target);
    if (typeof P === 'string' && receiver === a.proxy) {
      setItem(a, P, domString(V));
      return true;
    }
    return Reflect.set(target, P, V, receiver);
  },

  defineProperty(target, P, desc) {
    if (typeof P === 'symbol' || Object.hasOwn(target, P)) return Reflect.defineProperty(target, P, desc);
    if (desc.get || desc.set) return false;
    setItem(areas.get(target), P, domString(desc.value));
    return true;
  },

  deleteProperty(target, P) {
    if (typeof P !== 'symbol' && !(P in target)) {
      const { items } = areas.get(target);
      if (items.has(P)) {
        items.delete(P);
        return true;
      }
    }
    return Reflect.deleteProperty(target, P);
  },

  ownKeys(target) {
    const keys = new Set();
    for (const k of areas.get(target).items.keys()) if (!(k in target)) keys.add(k);
    for (const k of Reflect.ownKeys(target)) keys.add(k);
    return [...keys];
  },

  preventExtensions() {
    return false;
  },
};

/** A new, empty Storage (one per window and kind: rsdom has no same-origin frames to share an area with). */
function createStorage(quota = STORAGE_QUOTA) {
  const target = new Storage(rt.TOKEN);
  const proxy = new Proxy(target, storageTraps);
  const a = { items: new Map(), quota, proxy };
  areas.set(target, a);
  areas.set(proxy, a);
  return proxy;
}

/** True for a real Storage object (StorageEvent's `storageArea` conversion). */
const isStorage = (v) => areas.get(v)?.proxy === v;

// ========================================================================================== Location

/**
 * Navigates the context to `href`. Like jsdom, only fragment navigations take effect (other navigations are
 * not implemented: the URL stays as it is); they add a session history entry (`replacement`: in place of the
 * current one), DESIGN §23.
 */
function navigate(ctx, href, replacement = false) {
  let next;
  try {
    next = new URL(String(href), ctx.url.href);
  } catch {
    throw rt.domError(4, `Failed to set the 'href' property on 'Location': '${href}' is not a valid URL.`);
  }
  const a = new URL(ctx.url.href);
  const b = new URL(next.href);
  a.hash = '';
  b.hash = '';
  if (a.href === b.href && next.hash !== ctx.url.hash) ctx.history.navigateToFragment(next, replacement);
}

class Location {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  /** the browsing context (lib/context.cjs): `url` is the document URL */
  #s() {
    return state.get(this).ctx;
  }

  get href() {
    return this.#s().url.href;
  }

  set href(v) {
    navigate(this.#s(), v);
  }

  get origin() {
    return this.#s().url.origin;
  }

  get protocol() {
    return this.#s().url.protocol;
  }

  get host() {
    return this.#s().url.host;
  }

  get hostname() {
    return this.#s().url.hostname;
  }

  get port() {
    return this.#s().url.port;
  }

  get pathname() {
    return this.#s().url.pathname;
  }

  get search() {
    return this.#s().url.search;
  }

  get hash() {
    return this.#s().url.hash;
  }

  set hash(v) {
    const u = new URL(this.#s().url.href);
    u.hash = String(v);
    navigate(this.#s(), u.href);
  }

  assign(url) {
    navigate(this.#s(), url);
  }

  replace(url) {
    navigate(this.#s(), url, true);
  }

  reload() {}

  toString() {
    return this.href;
  }
}
tag(Location);

// =========================================================================================== History

class History {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  /** the context's session history (lib/history.cjs) */
  #s() {
    return state.get(this).ctx.history;
  }

  get length() {
    return this.#s().length;
  }

  get state() {
    return this.#s().state;
  }

  get scrollRestoration() {
    return state.get(this).scroll;
  }

  set scrollRestoration(v) {
    if (v === 'auto' || v === 'manual') state.get(this).scroll = v;
  }

  pushState(data, unused, url = undefined) {
    const [next, clone] = this.#args(data, url, 'pushState');
    this.#s().push(next, clone);
  }

  replaceState(data, unused, url = undefined) {
    const [next, clone] = this.#args(data, url, 'replaceState');
    this.#s().replace(next, clone);
  }

  /** The new URL (the current one if `url` is absent) and the cloned state of push/replaceState. */
  #args(data, url, method) {
    const ctx = state.get(this).ctx;
    let next = ctx.url;
    if (url !== undefined && url !== null && String(url) !== '') {
      next = new URL(String(url), ctx.url.href);
      if (next.origin !== ctx.url.origin) {
        throw new rt.classes.DOMException(`Failed to execute '${method}' on 'History': A history state object with URL '${next.href}' cannot be created in a document with origin '${ctx.url.origin}'.`, 'SecurityError');
      }
    }
    return [next, data === undefined ? null : structuredClone(data)];
  }

  // DESIGN §23: traversal is queued like jsdom's; go(0) is location.reload(), which does nothing.
  go(delta = 0) {
    const d = delta | 0;
    if (d !== 0) this.#s().traverseByDelta(d);
  }

  back() {
    this.#s().traverseByDelta(-1);
  }

  forward() {
    this.#s().traverseByDelta(1);
  }
}
tag(History);

// ============================================================================================ Window

/**
 * The `Window` interface object. Window objects are plain objects (or the Vitest global), so `instanceof Window`
 * asks whether the value is an open context's window.
 */
class Window {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  static [Symbol.hasInstance](v) {
    return require('./context.cjs').isWindow(v);
  }
}
tag(Window);

// ========================================================================================= Navigator

class Navigator {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  get userAgent() {
    return state.get(this)?.ctx.settings.userAgent ?? USER_AGENT;
  }

  get appCodeName() {
    return 'Mozilla';
  }

  get appName() {
    return 'Netscape';
  }

  get appVersion() {
    return USER_AGENT.slice('Mozilla/'.length);
  }

  get platform() {
    return '';
  }

  get product() {
    return 'Gecko';
  }

  get productSub() {
    return '20030107';
  }

  get vendor() {
    return 'Apple Computer, Inc.';
  }

  get vendorSub() {
    return '';
  }

  get language() {
    return 'en-US';
  }

  get languages() {
    return ['en-US', 'en'];
  }

  get onLine() {
    return true;
  }

  get cookieEnabled() {
    return true;
  }

  get hardwareConcurrency() {
    return 4;
  }

  get maxTouchPoints() {
    return 0;
  }

  get webdriver() {
    return false;
  }

  get doNotTrack() {
    return null;
  }

  get pdfViewerEnabled() {
    return false;
  }

  javaEnabled() {
    return false;
  }

  /** Always empty (lib/geometry.cjs, DESIGN §40); one object per navigator, as jsdom's [SameObject] */
  get plugins() {
    const s = state.get(this);
    if (s === undefined) throw new TypeError('Illegal invocation');
    return (s.plugins ??= new (require('./geometry.cjs').PluginArray)(rt.TOKEN));
  }

  get mimeTypes() {
    const s = state.get(this);
    if (s === undefined) throw new TypeError('Illegal invocation');
    return (s.mimeTypes ??= new (require('./geometry.cjs').MimeTypeArray)(rt.TOKEN));
  }
}
tag(Navigator);

/** jsdom parity: no screen geometry (every size is 0), 24-bit colour. */
class Screen {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  get width() {
    return 0;
  }

  get height() {
    return 0;
  }

  get availWidth() {
    return 0;
  }

  get availHeight() {
    return 0;
  }

  get availLeft() {
    return 0;
  }

  get availTop() {
    return 0;
  }

  get colorDepth() {
    return 24;
  }

  get pixelDepth() {
    return 24;
  }
}
tag(Screen);

// ===================================================================================== MediaQueryList

/** No media-query evaluation (ROADMAP: out of scope): `matches` is always false. */
class MediaQueryList {
  #media;

  constructor(t = undefined, media = '') {
    if (t !== rt.TOKEN) illegal();
    this.#media = media;
    this.onchange = null;
  }

  get media() {
    return this.#media;
  }

  get matches() {
    return false;
  }

  addListener() {}

  removeListener() {}

  addEventListener() {}

  removeEventListener() {}

  dispatchEvent() {
    return true;
  }
}
tag(MediaQueryList);

// ========================================================================================= Selection
// lib/selection.cjs (DESIGN §29)

const { Selection, selectionOf } = require('./selection.cjs');

// =============================================================================================== CSS

/** CSSOM `CSS.escape` (https://drafts.csswg.org/cssom/#serialize-an-identifier). */
function cssEscape(value) {
  if (arguments.length === 0) throw new TypeError("Failed to execute 'escape' on 'CSS': 1 argument required, but only 0 present.");
  const s = String(value);
  const n = s.length;
  const first = s.charCodeAt(0);
  if (n === 1 && first === 0x2d) return '\\' + s;
  let out = '';
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) {
      out += '�';
    } else if ((c >= 0x1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) || (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)) {
      out += '\\' + c.toString(16) + ' ';
    } else if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      out += s[i];
    } else {
      out += '\\' + s[i];
    }
  }
  return out;
}

/**
 * `CSS.supports(property, value)` / `CSS.supports(conditionText)` (jsdom CSS-impl.js): a declaration is supported
 * when setting it on an empty declaration block leaves a non-empty value (custom properties: always); a condition
 * is `not` / `and` / `or` over parenthesized declarations or conditions.
 */
function cssSupports(...args) {
  if (args.length === 0) throw new TypeError("Failed to execute 'supports' on 'CSS': 1 argument required, but only 0 present.");
  if (args.length === 1) return supportsCondition(String(args[0]).trim());
  return supportsDeclaration(String(args[0]), String(args[1]));
}

const PROP_VAL = /^([^():]+)\s*:\s*(.+)\s*$/;

function supportsDeclaration(prop, value) {
  return rt.N.cssSupports(prop, value);
}

/** A `@supports` condition (`CSS.supports(conditionText)`, `CSSSupportsRule#matches`). */
function supportsCondition(text) {
  if (PROP_VAL.test(text)) {
    const [, p, v] = PROP_VAL.exec(text);
    return supportsDeclaration(p.trim(), v);
  }
  const toks = supportsTokens(text);
  return toks === null ? false : supportsList(toks);
}

/** Tokens of a condition: identifiers and parenthesized groups (null: anything else, e.g. a function). */
function supportsTokens(t) {
  const out = [];
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(') {
      let d = 0;
      let j = i;
      for (; j < t.length; j++) {
        if (t[j] === '(') d++;
        else if (t[j] === ')' && --d === 0) break;
      }
      if (d !== 0) return null;
      out.push({ g: t.slice(i + 1, j) });
      i = j + 1;
    } else {
      const m = /^-?[A-Za-z_][\w-]*/.exec(t.slice(i));
      if (m === null || t[i + m[0].length] === '(') return null;
      out.push({ id: m[0].toLowerCase() });
      i += m[0].length;
    }
  }
  return out;
}

/** jsdom `#evaluateList`. */
function supportsList(toks) {
  let result = null;
  let op = null;
  let not = false;
  let expecting = true;
  for (const t of toks) {
    if (t.id !== undefined) {
      if (t.id === 'not') {
        if (result !== null || not) return false;
        not = true;
      } else if (t.id === 'and' || t.id === 'or') {
        if (not || expecting || (op !== null && op !== t.id)) return false;
        op = t.id;
        expecting = true;
      } else {
        return false;
      }
      continue;
    }
    if (!expecting) return false;
    const inner = t.g.trim();
    let r;
    if (PROP_VAL.test(inner) && !inner.startsWith('(')) {
      const [, p, v] = PROP_VAL.exec(inner);
      r = supportsDeclaration(p.trim(), v);
    } else {
      const sub = supportsTokens(inner);
      r = sub === null ? false : supportsList(sub);
    }
    if (not) {
      r = !r;
      not = false;
    }
    if (result === null) result = r;
    else if (op === 'and') result &&= r;
    else result ||= r;
    expecting = false;
  }
  if (not || (expecting && result !== null)) return false;
  return result === null ? false : result;
}

// ========================================================================================== FormData

/** USVString conversion (lone surrogates -> U+FFFD). */
const usv = (v) => String(v).toWellFormed();

/** `value` as a FormData entry value: Blobs become Files (XHR "create an entry"), anything else a USVString. */
function entryValue(value, filename, argc, method) {
  if (value instanceof Blob) {
    if (filename !== undefined) {
      return new File([value], usv(filename), { type: value.type, lastModified: value instanceof File ? value.lastModified : undefined });
    }
    return value instanceof File ? value : new File([value], 'blob', { type: value.type });
  }
  if (argc > 2) throw new TypeError(`Failed to execute '${method}' on 'FormData': parameter 2 is not of type 'Blob'.`);
  return usv(value);
}

function needArgs(argc, n, method) {
  if (argc < n) {
    throw new TypeError(`Failed to execute '${method}' on 'FormData': ${n} argument${n > 1 ? 's' : ''} required, but only ${argc} present.`);
  }
}

const FD_ITER_PROTO = Object.create(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));

/**
 * `new FormData(form, submitter)` (XHR spec), pure JS like jsdom's and happy-dom's: subclassing Node's
 * FormData would load Node's whole undici bundle (~50-70 ms per worker) through its lazy global. Entries are
 * [name, value] pairs; `new FormData(form)` fills them from area B's entry list (`formEntries`).
 */
class FormData {
  #entries = [];

  constructor(form = undefined, submitter = undefined) {
    if (form === undefined) return;
    const forms = require('./forms.cjs');
    if (typeof forms.formEntries !== 'function') {
      throw new TypeError("rsdom: new FormData(form) needs area B's formEntries (forms.cjs)");
    }
    this.#entries = forms.formEntries(form, submitter ?? null);
  }

  append(name, value, filename = undefined) {
    needArgs(arguments.length, 2, 'append');
    this.#entries.push([usv(name), entryValue(value, filename, arguments.length, 'append')]);
  }

  delete(name) {
    needArgs(arguments.length, 1, 'delete');
    const n = usv(name);
    this.#entries = this.#entries.filter((e) => e[0] !== n);
  }

  get(name) {
    needArgs(arguments.length, 1, 'get');
    const n = usv(name);
    const e = this.#entries.find((x) => x[0] === n);
    return e === undefined ? null : e[1];
  }

  getAll(name) {
    needArgs(arguments.length, 1, 'getAll');
    const n = usv(name);
    return this.#entries.filter((e) => e[0] === n).map((e) => e[1]);
  }

  has(name) {
    needArgs(arguments.length, 1, 'has');
    const n = usv(name);
    return this.#entries.some((e) => e[0] === n);
  }

  set(name, value, filename = undefined) {
    needArgs(arguments.length, 2, 'set');
    const entry = [usv(name), entryValue(value, filename, arguments.length, 'set')];
    const list = this.#entries;
    const i = list.findIndex((e) => e[0] === entry[0]);
    if (i < 0) {
      list.push(entry);
      return;
    }
    list[i] = entry;
    this.#entries = list.filter((e, k) => k <= i || e[0] !== entry[0]);
  }

  forEach(callback, thisArg = undefined) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'forEach' on 'FormData': The callback provided as parameter 1 is not a function.");
    }
    // WebIDL iteration is live (by index over the current list).
    for (let i = 0; i < this.#entries.length; i++) {
      const e = this.#entries[i];
      callback.call(thisArg, e[1], e[0], this);
    }
  }

  #iter(kind) {
    let i = 0;
    const self = this;
    const it = Object.create(FD_ITER_PROTO);
    it.next = function next() {
      const list = self.#entries;
      if (i >= list.length) return { value: undefined, done: true };
      const e = list[i++];
      return { value: kind === 0 ? [e[0], e[1]] : kind === 1 ? e[0] : e[1], done: false };
    };
    return it;
  }

  entries() {
    return this.#iter(0);
  }

  keys() {
    return this.#iter(1);
  }

  values() {
    return this.#iter(2);
  }
}
Object.defineProperty(FD_ITER_PROTO, Symbol.toStringTag, { value: 'FormData Iterator', configurable: true });
Object.defineProperty(FormData.prototype, Symbol.iterator, { value: FormData.prototype.entries, writable: true, configurable: true });
tag(FormData);

/** Marker in `saved`: the key was one of Node's lazy globals, deleted without materialising it. */
const LAZY_NATIVE = Symbol('lazy-native');
/** Node 22's globals backed by undici (lazy V8 data properties): never read their descriptors. */
const LAZY_NATIVE_KEYS = new Set(['FormData', 'Headers', 'Request', 'Response', 'MessageEvent', 'WebSocket', 'EventSource']);

// ========================================================================================= Window

/** Window error routing (Vitest's `catchWindowErrors`): unhandled ErrorEvents become uncaught exceptions. */
function catchWindowErrors(win) {
  if (typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function') return () => {};
  let userListeners = 0;
  const add = win.addEventListener;
  const remove = win.removeEventListener;
  function onError(e) {
    if (userListeners === 0 && e.error != null) {
      e.preventDefault();
      process.emit('uncaughtException', e.error);
    }
  }
  add.call(win, 'error', onError);
  const patch = {
    addEventListener(type, listener, options) {
      if (type === 'error') userListeners++;
      // eslint-disable-next-line prefer-rest-params
      return Reflect.apply(add, this, arguments);
    },
    removeEventListener(type, listener, options) {
      if (type === 'error' && userListeners > 0) userListeners--;
      // eslint-disable-next-line prefer-rest-params
      return Reflect.apply(remove, this, arguments);
    },
  };
  for (const k of ['addEventListener', 'removeEventListener']) {
    Object.defineProperty(win, k, { value: patch[k], writable: true, enumerable: true, configurable: true });
  }
  return () => {
    remove.call(win, 'error', onError);
    Object.defineProperty(win, 'addEventListener', { value: add, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(win, 'removeEventListener', { value: remove, writable: true, enumerable: true, configurable: true });
  };
}

/**
 * Puts back every property `makeWindow` (and the window EventTarget installed with it) defined on a
 * pre-existing object such as globalThis: original descriptors back, added keys deleted.
 */
function restoreGlobals(win, saved) {
  for (const [k, d] of saved) {
    if (d === undefined || d === LAZY_NATIVE) delete win[k];
    else Object.defineProperty(win, k, d);
  }
  saved.clear();
}

/** jsdom's `window.console` members. */
const CONSOLE_METHODS = ['assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error', 'group',
  'groupCollapsed', 'groupEnd', 'info', 'log', 'table', 'time', 'timeLog', 'timeEnd', 'trace', 'warn'];

/**
 * A `JSDOM` window's own timers (the Vitest global keeps Node's): integer handles, `this` = the window, errors
 * reported to the window, all cancelled when the context closes, after which new ones return 0 (jsdom).
 */
function installTimers(win, ctx, def) {
  const events = require('./events.cjs');
  const timers = new Map();
  let nextId = 0;
  const start = (repeat, name) => ({
    [name](handler, timeout = 0, ...args) {
      if (ctx.closed) return 0;
      const id = ++nextId;
      const run = () => {
        if (!repeat) timers.delete(id);
        // a string handler is script source: rsdom does not run scripts
        if (typeof handler !== 'function') return;
        try {
          handler.apply(win, args);
        } catch (err) {
          events.reportException(win, err);
        }
      };
      const ms = Math.max(0, Number(timeout) || 0);
      timers.set(id, repeat ? setInterval(run, ms) : setTimeout(run, ms));
      return id;
    },
  })[name];
  const clear = (name) => ({
    [name](id = 0) {
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimeout(t); // clears intervals too
        timers.delete(id);
      }
    },
  })[name];
  def('setTimeout', start(false, 'setTimeout'));
  def('setInterval', start(true, 'setInterval'));
  def('clearTimeout', clear('clearTimeout'));
  def('clearInterval', clear('clearInterval'));
  ctx.onClose(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });
}

/**
 * Builds the window of browsing context `ctx` (lib/context.cjs) onto `global` (the Vitest environment) or a
 * fresh null-prototype object, and returns it. On a pre-existing global, the context's `close()` restores
 * the original properties.
 * @param {import('./context.cjs').BrowsingContext} ctx
 * @param {object} [global]
 * @param {boolean} [ownTimers] window timers on a `global` too (context.cjs `open`)
 */
function makeWindow(ctx, global = undefined, ownTimers = false) {
  const { document, url } = ctx;
  const win = global ?? Object.create(null);
  const isGlobal = global !== undefined;
  /**
   * Original descriptors of every key this window defines on a pre-existing object (undefined = the key was
   * absent): `restoreGlobals` puts them back. Only the keys we touch are read (never a whole-global snapshot).
   */
  const saved = new Map();
  // Registered first, so it runs last: error routing installed over the window is undone before.
  if (isGlobal) ctx.onClose(() => restoreGlobals(win, saved));
  const save = (k) => {
    if (saved.has(k)) return;
    if (!Object.prototype.hasOwnProperty.call(win, k)) saved.set(k, undefined);
    else if (win === globalThis && LAZY_NATIVE_KEYS.has(k)) {
      // Node's undici-backed lazy V8 data property: reading its descriptor (or redefining it) loads undici
      // (~50-70 ms), `delete` does not. It cannot be brought back without loading undici, so restoreGlobals()
      // just deletes ours (an isolate: false worker tears the environment down when it stops).
      saved.set(k, LAZY_NATIVE);
      delete win[k];
    } else saved.set(k, Object.getOwnPropertyDescriptor(win, k));
  };
  // Globals are non-enumerable (like populateGlobal's); a createWindow() object enumerates its members.
  const def = (k, v, enumerable = !isGlobal) => {
    if (isGlobal) save(k);
    Object.defineProperty(win, k, { value: v, writable: true, enumerable, configurable: true });
  };
  const perf = globalThis.performance;
  const events = require('./events.cjs');

  // Interface objects (WebIDL: non-enumerable on the global). FormData is one of them (tag() above).
  for (const [name, C] of Object.entries(rt.classes)) if (C !== undefined && C !== null) def(name, C, false);

  def('window', win);
  def('self', win);
  def('top', win);
  def('parent', win);
  def('frames', win);
  def('document', document);
  def('opener', null);
  def('frameElement', null);
  def('closed', false);
  def('origin', url.origin);

  const location = new Location(rt.TOKEN);
  state.set(location, { ctx });
  def('location', location);
  const history = new History(rt.TOKEN);
  state.set(history, { ctx, scroll: 'auto' });
  ctx.history = new (require('./history.cjs').SessionHistory)(ctx);
  def('history', history);
  const { settings } = ctx;
  const navigator = new Navigator(rt.TOKEN);
  state.set(navigator, { ctx });
  def('navigator', navigator);
  def('screen', new Screen(rt.TOKEN));
  def('customElements', require('./custom-elements.cjs').registryFor(ctx));
  // jsdom's remaining Window members (refs/jsdom/lib/jsdom/browser/Window.js; DESIGN §40)
  const { BarProp, External } = require('./geometry.cjs');
  for (const k of ['locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar']) def(k, new BarProp(rt.TOKEN));
  def('external', new External(rt.TOKEN));
  def('name', '');
  def('status', '');
  // no child browsing contexts (iframes have no window yet: `browsing-contexts`)
  def('length', 0);
  def('captureEvents', function captureEvents() {});
  def('releaseEvents', function releaseEvents() {});
  /** `new Audio(src)` (legacy factory function): jsdom's needs no `new`. */
  function Audio(src) {
    const audio = document.createElement('audio');
    audio.setAttributeNS(null, 'preload', 'auto');
    if (src !== undefined) audio.setAttributeNS(null, 'src', String(src));
    return audio;
  }
  Object.defineProperty(Audio, 'prototype', { value: rt.classes.HTMLAudioElement.prototype, writable: false, enumerable: false, configurable: false });
  def('Audio', Audio, false);
  def('postMessage', function postMessage(message, targetOrigin) {
    if (arguments.length < 2) throw new TypeError("'postMessage' requires 2 arguments: 'message' and 'targetOrigin'");
    const target = `${targetOrigin}`; // DOMString: a Symbol throws TypeError
    // "/" needs the incumbent settings object, which jsdom does not track either
    if (target === '/') return;
    if (target !== '*') {
      let origin;
      try {
        origin = new URL(target).origin;
      } catch {
        throw new rt.classes.DOMException(`Failed to execute 'postMessage' on 'Window': Invalid target origin '${target}' in a call to 'postMessage'.`, 'SyntaxError');
      }
      if (origin !== url.origin) return;
    }
    // jsdom: a trusted event with no source / origin / ports, and `data` is not structured-cloned. A closed
    // context runs no task (jsdom's _queueATask checks _isDestroyed)
    if (ctx.closed) return;
    ctx.queueTask(() => {
      if (!ctx.closed) events.fire(ctx.wt, 'message', { data: message }, events.MessageEvent);
    });
  });
  def('localStorage', createStorage(settings.storageQuota));
  def('sessionStorage', createStorage(settings.storageQuota));

  def('innerWidth', 1024);
  def('innerHeight', 768);
  def('outerWidth', 1024);
  def('outerHeight', 768);
  def('devicePixelRatio', 1);
  for (const k of ['scrollX', 'scrollY', 'pageXOffset', 'pageYOffset', 'screenX', 'screenY', 'screenLeft', 'screenTop']) def(k, 0);

  const noop = function () {};
  const vc = settings.virtualConsole;
  /** jsdom's not-implemented report (refs/jsdom/lib/jsdom/browser/not-implemented.js), on a virtual console only */
  const notImplemented = (name, ret) => ({
    [name]() {
      if (vc) {
        const error = new Error(`Not implemented: Window's ${name}() method`);
        error.type = 'not-implemented';
        vc.emit('jsdomError', error);
      }
      return ret;
    },
  })[name];
  def('scrollTo', notImplemented('scrollTo'));
  def('scroll', notImplemented('scroll'));
  def('scrollBy', notImplemented('scrollBy'));
  def('alert', notImplemented('alert'));
  def('confirm', notImplemented('confirm', false));
  def('prompt', notImplemented('prompt', null));
  def('print', notImplemented('print'));
  def('open', notImplemented('open', null));
  // Closing a `JSDOM` window closes its context (timers, animation frames); other windows stay open
  def('close', settings.closable && !isGlobal ? function close() {
    ctx.close();
    win.closed = true;
  } : function close() {});
  def('stop', noop);
  def('focus', notImplemented('focus'));
  def('blur', notImplemented('blur'));
  def('moveTo', notImplemented('moveTo'));
  def('moveBy', notImplemented('moveBy'));
  def('resizeTo', notImplemented('resizeTo'));
  def('resizeBy', notImplemented('resizeBy'));
  if (vc && !isGlobal) {
    // jsdom's window.console: every method emits on the virtual console (a global keeps its console, as
    // Vitest's jsdom environment does)
    const c = {};
    for (const m of CONSOLE_METHODS) c[m] = (...args) => vc.emit(m, ...args);
    def('console', c);
  }
  if (!isGlobal || ownTimers) installTimers(win, ctx, def);

  def('matchMedia', function matchMedia(query) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'matchMedia' on 'Window': 1 argument required, but only 0 present.");
    return new MediaQueryList(rt.TOKEN, String(query));
  });
  /** animation-frame id -> its context timer (closing the context cancels them) */
  const rafs = new Map();
  let rafId = 0;
  // jsdom defines animation frames only with `pretendToBeVisual` (createWindow and the Vitest environment set it)
  if (settings.pretendToBeVisual) def('requestAnimationFrame', function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.");
    }
    if (ctx.closed) return 0;
    const id = ++rafId;
    rafs.set(id, ctx.setTimer(() => {
      rafs.delete(id);
      try {
        callback(perf.now());
      } catch (err) {
        // HTML "report an exception": the window's `error` listeners, then the process.
        events.reportException(win, err);
      }
    }, 16));
    return id;
  });
  if (settings.pretendToBeVisual) def('cancelAnimationFrame', function cancelAnimationFrame(id) {
    const t = rafs.get(id);
    if (t !== undefined) {
      ctx.clearTimer(t);
      rafs.delete(id);
    }
  });
  def('getComputedStyle', rt.getComputedStyle);
  def('getSelection', function getSelection() {
    return selectionOf(document);
  });
  // a WebIDL namespace object: plain writable methods and a configurable @@toStringTag
  const css = { escape: cssEscape, supports: cssSupports };
  Object.defineProperty(css, Symbol.toStringTag, { value: 'CSS', configurable: true });
  def('CSS', css, false);

  // Area B's window EventTarget: listener methods, `event` and on* handlers.
  if (isGlobal) {
    // Record their originals (normally absent), and every key installWindow adds.
    for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'event']) save(k);
    const before = new Set(Reflect.ownKeys(win));
    events.installWindow(win, document);
    for (const k of Reflect.ownKeys(win)) if (!before.has(k)) saved.set(k, undefined);
    // Diagnostics for benches / acceptance tests (non-enumerable): MO delivery stats, native counters.
    def('__rsdom', Object.freeze({
      version: VERSION,
      flags: rt.flags,
      shared: rt.shared,
      moStats: require('./mo.cjs').stats,
      counters: () => JSON.parse(rt.N.counters()),
    }), false);
  } else {
    events.installWindow(win, document);
  }
  return win;
}

// ============================================================================================ install

function install(_rt, d) {
  rt.define(d.Document, {
    getSelection() {
      return this._ctx !== undefined ? selectionOf(this) : null;
    },
    get location() {
      return this._ctx?.window?.location ?? null;
    },
    get cookie() {
      const jar = this._cookies;
      if (jar === undefined || jar.size === 0) return '';
      let out = '';
      for (const [k, v] of jar) out += (out === '' ? '' : '; ') + (k === '' ? v : `${k}=${v}`);
      return out;
    },
    set cookie(v) {
      const str = String(v);
      const pair = str.split(';', 1)[0];
      const eq = pair.indexOf('=');
      const name = (eq < 0 ? '' : pair.slice(0, eq)).trim();
      const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
      const jar = this._cookies ?? (this._cookies = new Map());
      const attrs = str.slice(pair.length).toLowerCase();
      const expires = /;\s*expires=([^;]*)/.exec(attrs);
      const maxAge = /;\s*max-age=(-?\d+)/.exec(attrs);
      if ((maxAge !== null && Number(maxAge[1]) <= 0) || (expires !== null && Date.parse(expires[1]) <= Date.now())) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
    get referrer() {
      return this._ctx?.settings.referrer ?? '';
    },
    get domain() {
      return this._ctx?.url.hostname ?? '';
    },
    // jsdom: visible only with `pretendToBeVisual` (a document without a window is hidden)
    get hidden() {
      return this._ctx?.settings.pretendToBeVisual !== true;
    },
    get visibilityState() {
      return this._ctx?.settings.pretendToBeVisual === true ? 'visible' : 'prerender';
    },
    get scrollingElement() {
      return this.documentElement;
    },
  });
}

module.exports = { install, makeWindow, catchWindowErrors, cssEscape, cssSupports, supportsCondition, Storage, isStorage, Location, History, Navigator, Selection, USER_AGENT };
