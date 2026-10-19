'use strict';
// AREA C (window/globals, DESIGN §12, ROADMAP M6). `makeWindow(rt, dom, document, options)` builds the window:
// - `createWindow()` (plain Node, contract tests): a fresh null-prototype object;
// - the Vitest environment (lib/vitest-environment.mjs): `options.global = globalThis`, so every member is
//   installed as an OWN DATA property of globalThis (1-2 ns per read, vs ~20 ns for populateGlobal accessors).
//
// Members: every interface constructor in `rt.classes` (installed generically, so whatever areas A/B
// register appears without editing this file), window/self/top/parent/frames = the window, document
// (`document.defaultView === window`), location, history, navigator, screen, localStorage/sessionStorage,
// matchMedia, requestAnimationFrame/cancelAnimationFrame (Node timers), getComputedStyle (area A), getSelection,
// CSS.escape/supports, FormData override `(form, submitter)` (area B's formEntries), geometry constants and
// no-op scroll/alert-family functions. The window is an EventTarget through area B's `installWindow`.
//
// Kept as Node's (never overridden): timers, setImmediate, queueMicrotask, performance, console,
// AbortController/AbortSignal, MessageChannel, typed arrays, Blob, File, URL, fetch, crypto, DOMException,
// structuredClone, TextEncoder/Decoder. Names rsdom does not implement are not defined (feature detection
// with `in` must not be fooled): no customElements, ResizeObserver, IntersectionObserver, DataTransfer,
// requestIdleCallback, TextEvent, reportError, documentMode.

const rt = require('./runtime.cjs');

// Node's timers, captured at load (Vitest captures its safe timers after the environment; fake timers
// installed later must not stall animation frames that were requested before).
const nodeSetTimeout = globalThis.setTimeout;
const nodeClearTimeout = globalThis.clearTimeout;
// NOT read at load: `FormData` (and `performance`) are lazy Node globals; touching FormData's descriptor loads
// undici (~50-70 ms per process or worker), so rsdom ships its own FormData and deletes Node's.

const DEFAULT_URL = 'http://localhost:3000/';
const VERSION = '0.1.0';
const USER_AGENT = `Mozilla/5.0 (${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'}) AppleWebKit/537.36 (KHTML, like Gecko) rsdom/${VERSION}`;

let dom = null;

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

/** Private state of window-plumbing objects, keyed by the object (cold paths only). */
const state = new WeakMap();

// =========================================================================================== Storage

class Storage {
  #m = new Map();

  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  get length() {
    return this.#m.size;
  }

  key(index) {
    const i = Number(index) >>> 0;
    if (i >= this.#m.size) return null;
    let k = 0;
    for (const key of this.#m.keys()) if (k++ === i) return key;
    return null;
  }

  getItem(key) {
    const v = this.#m.get(String(key));
    return v === undefined ? null : v;
  }

  setItem(key, value) {
    this.#m.set(String(key), String(value));
  }

  removeItem(key) {
    this.#m.delete(String(key));
  }

  clear() {
    this.#m.clear();
  }
}
tag(Storage);

// ========================================================================================== Location

/** A same-document URL change (fragment, pushState): updates the document URL. */
function setDocumentURL(win, url) {
  const s = state.get(win);
  s.url = url;
  s.document._url = url.href;
}

function hashChange(win, oldURL, newURL) {
  const E = rt.classes.HashChangeEvent;
  if (typeof E !== 'function' || typeof win.dispatchEvent !== 'function') return;
  nodeSetTimeout(() => {
    try {
      win.dispatchEvent(new E('hashchange', { oldURL, newURL }));
    } catch {
      // a reset env: nothing to notify
    }
  }, 0);
}

/**
 * Navigates `win` to `href`. Like jsdom, only fragment navigations take effect (other navigations are not
 * implemented: the URL stays as it is).
 */
function navigate(win, href) {
  const s = state.get(win);
  let next;
  try {
    next = new URL(String(href), s.url.href);
  } catch {
    throw rt.domError(4, `Failed to set the 'href' property on 'Location': '${href}' is not a valid URL.`);
  }
  const a = new URL(s.url.href);
  const b = new URL(next.href);
  a.hash = '';
  b.hash = '';
  if (a.href === b.href && next.hash !== s.url.hash) {
    const old = s.url.href;
    setDocumentURL(win, next);
    hashChange(win, old, next.href);
  }
}

class Location {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  #s() {
    return state.get(state.get(this).win);
  }

  get href() {
    return this.#s().url.href;
  }

  set href(v) {
    navigate(state.get(this).win, v);
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
    navigate(state.get(this).win, u.href);
  }

  assign(url) {
    navigate(state.get(this).win, url);
  }

  replace(url) {
    navigate(state.get(this).win, url);
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

  get length() {
    return state.get(this).length;
  }

  get state() {
    return state.get(this).state;
  }

  get scrollRestoration() {
    return state.get(this).scroll;
  }

  set scrollRestoration(v) {
    if (v === 'auto' || v === 'manual') state.get(this).scroll = v;
  }

  pushState(data, unused, url = undefined) {
    this.#update(data, url);
    state.get(this).length++;
  }

  replaceState(data, unused, url = undefined) {
    this.#update(data, url);
  }

  #update(data, url) {
    const h = state.get(this);
    const ws = state.get(h.win);
    if (url !== undefined && url !== null) {
      const next = new URL(String(url), ws.url.href);
      if (next.origin !== ws.url.origin) {
        throw new rt.classes.DOMException(`Failed to execute 'pushState' on 'History': A history state object with URL '${next.href}' cannot be created in a document with origin '${ws.url.origin}'.`, 'SecurityError');
      }
      setDocumentURL(h.win, next);
    }
    h.state = data === undefined ? null : structuredClone(data);
  }

  back() {}

  forward() {}

  go() {}
}
tag(History);

// ========================================================================================= Navigator

class Navigator {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  get userAgent() {
    return USER_AGENT;
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

/**
 * Selection stub (ROADMAP: "Selection beyond a stub with anchor/focus" is out of scope). React's
 * SelectEventPlugin reads anchorNode/anchorOffset/focusNode/focusOffset unguarded.
 */
class Selection {
  #anchor = null;
  #aoff = 0;
  #focus = null;
  #foff = 0;
  #ranges = [];

  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
  }

  get anchorNode() {
    return this.#anchor;
  }

  get anchorOffset() {
    return this.#aoff;
  }

  get focusNode() {
    return this.#focus;
  }

  get focusOffset() {
    return this.#foff;
  }

  get isCollapsed() {
    return this.#anchor === this.#focus && this.#aoff === this.#foff;
  }

  get rangeCount() {
    return this.#ranges.length;
  }

  get type() {
    if (this.#anchor === null) return 'None';
    return this.isCollapsed ? 'Caret' : 'Range';
  }

  getRangeAt(index) {
    const r = this.#ranges[index >>> 0];
    if (r === undefined) throw rt.domError(5, `Failed to execute 'getRangeAt' on 'Selection': ${index} is not a valid index.`);
    return r;
  }

  addRange(range) {
    if (this.#ranges.length !== 0) return;
    this.#ranges.push(range);
    this.#anchor = range.startContainer ?? null;
    this.#aoff = range.startOffset ?? 0;
    this.#focus = range.endContainer ?? null;
    this.#foff = range.endOffset ?? 0;
  }

  removeRange(range) {
    const i = this.#ranges.indexOf(range);
    if (i < 0) throw rt.domError(2);
    this.removeAllRanges();
  }

  removeAllRanges() {
    this.#ranges = [];
    this.#anchor = null;
    this.#focus = null;
    this.#aoff = 0;
    this.#foff = 0;
  }

  empty() {
    this.removeAllRanges();
  }

  collapse(node, offset = 0) {
    if (node === null) {
      this.removeAllRanges();
      return;
    }
    this.#ranges = [];
    this.#anchor = this.#focus = node;
    this.#aoff = this.#foff = offset >>> 0;
  }

  setPosition(node, offset = 0) {
    this.collapse(node, offset);
  }

  collapseToStart() {
    this.#focus = this.#anchor;
    this.#foff = this.#aoff;
  }

  collapseToEnd() {
    this.#anchor = this.#focus;
    this.#aoff = this.#foff;
  }

  extend(node, offset = 0) {
    this.#focus = node;
    this.#foff = offset >>> 0;
  }

  setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    this.#ranges = [];
    this.#anchor = anchorNode;
    this.#aoff = anchorOffset >>> 0;
    this.#focus = focusNode;
    this.#foff = focusOffset >>> 0;
  }

  selectAllChildren(node) {
    this.setBaseAndExtent(node, 0, node, node.childNodes.length);
  }

  containsNode() {
    return false;
  }

  deleteFromDocument() {}

  toString() {
    return '';
  }
}
tag(Selection);

function selectionOf(document) {
  return document._sel ?? (document._sel = new Selection(rt.TOKEN));
}

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
 * `CSS.supports(property, value)` / `CSS.supports('(property: value)')`: true for properties rsdom's style
 * engine knows (area A's `cssProp`) with a non-empty value; false otherwise (no value validation).
 */
function cssSupports(a, b = undefined) {
  let prop;
  let value;
  if (b === undefined) {
    const m = /^\s*\(\s*([-\w]+)\s*:\s*([^)]*?)\s*\)\s*$/.exec(String(a));
    if (m === null) return false;
    [, prop, value] = m;
  } else {
    prop = String(a).trim();
    value = String(b).trim();
  }
  if (value === '' || typeof rt.N.cssProp !== 'function') return false;
  if (prop.startsWith('--')) return true;
  return rt.N.cssProp(rt.asciiLower(prop)) !== 0;
}

// ================================================================================ getComputedStyle stub

/**
 * Used only when area A's `rt.getComputedStyle` is absent (branch without the style engine): a read-only
 * object whose properties are '' (DTL's isInaccessible then treats everything as visible).
 */
function getComputedStyleStub(elt) {
  if (!(elt instanceof rt.classes.Element)) {
    throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
  }
  return new Proxy(Object.freeze({ getPropertyValue: () => '', length: 0, item: () => '', cssText: '' }), {
    get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? '' : undefined),
  });
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

/** Area B's window EventTarget (`installWindow(win, document)`), or a no-op stub when events.cjs lacks it. */
function bindEventTarget(win, document) {
  const events = require('./events.cjs');
  if (typeof events.installWindow === 'function') {
    events.installWindow(win, document);
    return true;
  }
  // STUB until area B merges: React's passive-listener probe calls window.addEventListener at import time.
  const def = (k, v) => Object.defineProperty(win, k, { value: v, writable: true, enumerable: true, configurable: true });
  def('addEventListener', function addEventListener() {});
  def('removeEventListener', function removeEventListener() {});
  def('dispatchEvent', function dispatchEvent() {
    return true;
  });
  def('event', undefined);
  return false;
}

/** True when `C` is a usable replacement for a Node global of the same name. */
function exposable(name, C, isGlobal) {
  if (C === undefined || C === null) return false;
  // dom.cjs's EventTarget is a bare base class until area B installs the listener API: never shadow Node's
  // working global EventTarget with it.
  if (name === 'EventTarget' && isGlobal) return typeof C.prototype?.addEventListener === 'function';
  return true;
}

/**
 * Builds the window members onto `options.global` (Vitest env) or a fresh null-prototype object.
 * @param {object} rt runtime API
 * @param {object} d dom.cjs exports
 * @param {object} document the HTMLDocument wrapper
 * @param {{ url?: string, global?: object }} [options]
 */
function makeWindow(_rt, d, document, options = {}) {
  dom = d;
  const win = options.global ?? Object.create(null);
  const isGlobal = options.global !== undefined;
  /**
   * Original descriptors of every key this window defines on a pre-existing object (undefined = the key was
   * absent): `restoreWindow` puts them back. Only the keys we touch are read (never a whole-global snapshot).
   */
  const saved = new Map();
  const save = (k) => {
    if (saved.has(k)) return;
    if (!Object.prototype.hasOwnProperty.call(win, k)) saved.set(k, undefined);
    else if (win === globalThis && LAZY_NATIVE_KEYS.has(k)) {
      // Node's undici-backed lazy V8 data property: reading its descriptor (or redefining it) loads undici
      // (~50-70 ms), `delete` does not. It cannot be brought back without loading undici, so restoreWindow()
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
  const url = new URL(options.url ?? document._url ?? DEFAULT_URL);
  document._url = url.href;
  document._win = win;
  const s = { document, url, rafs: new Map(), rafId: 0, saved };
  state.set(win, s);
  const perf = globalThis.performance;

  // Interface objects (WebIDL: non-enumerable on the global).
  for (const [name, C] of Object.entries(rt.classes)) {
    if (exposable(name, C, isGlobal)) def(name, C, false);
  }
  if (!isGlobal) def('FormData', FormData, false); // a Vitest global comes from rt.classes (tag() above)

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
  state.set(location, { win });
  def('location', location);
  const history = new History(rt.TOKEN);
  state.set(history, { win, length: 1, state: null, scroll: 'auto' });
  def('history', history);
  def('navigator', new Navigator(rt.TOKEN));
  def('screen', new Screen(rt.TOKEN));
  def('localStorage', new Storage(rt.TOKEN));
  def('sessionStorage', new Storage(rt.TOKEN));

  def('innerWidth', 1024);
  def('innerHeight', 768);
  def('outerWidth', 1024);
  def('outerHeight', 768);
  def('devicePixelRatio', 1);
  for (const k of ['scrollX', 'scrollY', 'pageXOffset', 'pageYOffset', 'screenX', 'screenY', 'screenLeft', 'screenTop']) def(k, 0);

  const noop = function () {};
  def('scrollTo', function scrollTo() {});
  def('scroll', function scroll() {});
  def('scrollBy', function scrollBy() {});
  def('alert', function alert() {});
  def('confirm', function confirm() {
    return false;
  });
  def('prompt', function prompt() {
    return null;
  });
  def('print', function print() {});
  def('open', function open() {
    return null;
  });
  def('close', noop);
  def('stop', noop);
  def('focus', noop);
  def('blur', noop);
  def('moveTo', noop);
  def('moveBy', noop);
  def('resizeTo', noop);
  def('resizeBy', noop);

  def('matchMedia', function matchMedia(query) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'matchMedia' on 'Window': 1 argument required, but only 0 present.");
    return new MediaQueryList(rt.TOKEN, String(query));
  });
  def('requestAnimationFrame', function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.");
    }
    const id = ++s.rafId;
    s.rafs.set(id, nodeSetTimeout(() => {
      s.rafs.delete(id);
      try {
        callback(perf.now());
      } catch (err) {
        reportError(win, err);
      }
    }, 16));
    return id;
  });
  def('cancelAnimationFrame', function cancelAnimationFrame(id) {
    const t = s.rafs.get(id);
    if (t !== undefined) {
      nodeClearTimeout(t);
      s.rafs.delete(id);
    }
  });
  def('getComputedStyle', typeof rt.getComputedStyle === 'function' ? rt.getComputedStyle : getComputedStyleStub);
  def('getSelection', function getSelection() {
    return selectionOf(document);
  });
  def('CSS', Object.freeze({ escape: cssEscape, supports: cssSupports }), false);

  if (isGlobal) {
    // Area B defines listener methods, `event` and on* handlers: record their originals (normally absent).
    for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'event']) save(k);
    const before = new Set(Reflect.ownKeys(win));
    s.hasEvents = bindEventTarget(win, document);
    for (const k of Reflect.ownKeys(win)) if (!before.has(k)) saved.set(k, undefined);
  } else {
    s.hasEvents = bindEventTarget(win, document);
  }
  if (isGlobal) {
    // Diagnostics for benches / acceptance tests (non-enumerable): MO delivery stats, native counters.
    def('__rsdom', Object.freeze({
      version: VERSION,
      flags: rt.flags,
      shared: rt.shared,
      moStats: require('./mo.cjs').stats,
      counters: () => JSON.parse(rt.N.counters()),
    }), false);
  }
  require('./mo.cjs').setReporter((err) => reportError(win, err));
  return win;
}

/**
 * HTML "report an exception" for callbacks the window runs (animation frames, MutationObserver callbacks):
 * area B's ErrorEvent path when present (window `error` listeners, then the process), else the process.
 */
function reportError(win, err) {
  const events = require('./events.cjs');
  if (typeof events.reportException === 'function') events.reportException(win, err);
  else process.emit('uncaughtException', err);
}

/** Cancels the window's pending animation-frame callbacks (teardown). */
function closeWindow(win) {
  const s = state.get(win);
  if (s === undefined) return;
  for (const t of s.rafs.values()) nodeClearTimeout(t);
  s.rafs.clear();
}

/**
 * Restores every property `makeWindow` (and the window EventTarget / error routing installed with it) defined
 * on a pre-existing object such as globalThis: original descriptors back, added keys deleted.
 */
function restoreWindow(win) {
  const s = state.get(win);
  if (s === undefined) return;
  for (const [k, d] of s.saved) {
    if (d === undefined || d === LAZY_NATIVE) delete win[k];
    else Object.defineProperty(win, k, d);
  }
  s.saved.clear();
  state.delete(win);
}

// ============================================================================================ install

function install(_rt, d) {
  dom = d;
  rt.define(d.Document, {
    getSelection() {
      return this._win ? selectionOf(this) : null;
    },
    get location() {
      return this._win?.location ?? null;
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
      return '';
    },
    get domain() {
      return this._win ? state.get(this._win)?.url.hostname ?? '' : '';
    },
    get hidden() {
      return false;
    },
    get visibilityState() {
      return 'visible';
    },
    get scrollingElement() {
      return this.documentElement;
    },
  });
}

module.exports = { install, makeWindow, closeWindow, restoreWindow, catchWindowErrors, cssEscape, Storage, Location, History, Navigator, Selection, USER_AGENT };
