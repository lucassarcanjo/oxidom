'use strict';
// Browsing contexts (DESIGN §18): one per window. A context owns its window object, its document, the
// document's URL (the only copy: `document.URL`, `location` and `history` all read `ctx.url`), the timers
// the window starts (animation frames, history traversal tasks), what it installed on a pre-existing global, and
// its teardown: `close()` runs it in the right order.
//
// An env (one per thread, DESIGN §2.1) holds any number of open contexts. rsdom has ONE set of interface
// objects per env (`rt.classes`), not one per window, so what a constructor or a plain EventTarget belongs
// to is resolved through the CURRENT context: `new Text()`, `new Option()`, `new Range()`, `new Document()`
// URLs, the focus fast path (Rust's main document mirrors the current document's focus into EP[FOCUS]),
// plain-EventTarget dispatch and MutationObserver callback errors. Opening a context makes it current
// (unless `main: false`); closing the current one makes the previous open one current again. `rt.reset()`
// closes every open context.
//
// The document's link is its `_ctx` wrapper field (documents of `createHTMLDocument()`, `new Document()`,
// `DOMParser` or `cloneNode()` have none: their URL is the `_url` field).
//
// Loaded by dom.cjs before any area installs: this file requires only runtime.cjs at load and the window
// and event areas lazily, when a context is opened.

const rt = require('./runtime.cjs');

/** The URL of a context opened without one (`createWindow()`, the Vitest environment). */
const DEFAULT_URL = 'http://localhost:3000/';

// Node's timers, captured at load: Vitest captures its safe timers after the environment, and fake timers
// installed later must not stall animation frames requested before.
const nodeSetTimeout = globalThis.setTimeout;
const nodeClearTimeout = globalThis.clearTimeout;
const nodeSetImmediate = globalThis.setImmediate;
const nodeClearImmediate = globalThis.clearImmediate;

/** Every open context, in opening order. */
const open = new Set();
/** Open contexts that were made current, oldest first: the last one is current. */
const stack = [];
/** The current context (`stack.at(-1)`), or null. */
let cur = null;
/** window object -> its open context */
const byWindow = new WeakMap();
/** windows of closed, non-global contexts */
const closedWindows = new WeakSet();

class BrowsingContext {
  #timers = new Set();
  #tasks = new Set();
  #cleanups = [];

  constructor(document, url) {
    /** the context's document (an HTMLDocument wrapper) */
    this.document = document;
    /** the document's URL (a URL object); `setURL` changes it */
    this.url = url;
    /** the window object (a fresh object, or the pre-existing global it was installed on) */
    this.window = null;
    /** the window's hidden EventTarget (events.cjs `installWindow`) */
    this.wt = null;
    /** the session history (lib/history.cjs, DESIGN §23), created with the window */
    this.history = null;
    this.closed = false;
    /**
     * jsdom's window settings (`new JSDOM()` options, lib/jsdom.cjs): `pretendToBeVisual` (animation frames,
     * `document.hidden`), `storageQuota`, `userAgent`, `referrer`, and `virtualConsole` (when set: the
     * window's `console`, not-implemented reports and uncaught exceptions go to it, not to the process), and
     * `closable` (`window.close()` closes the context; a no-op for `createWindow()` and the Vitest global), and
     * `runScripts` (undefined, "outside-only" or "dangerously": lib/scripts.cjs, DESIGN §45).
     */
    this.settings = {
      pretendToBeVisual: true,
      storageQuota: 5000000,
      userAgent: null,
      referrer: '',
      virtualConsole: null,
      closable: false,
      runScripts: undefined,
    };
    /** the window is installed on a pre-existing global (the Vitest environment) */
    this.global = false;
    /** the vm context whose global is the window (lib/vm-window.cjs), where scripts run */
    this.vmContext = undefined;
  }

  /** A same-document URL change (fragment navigation, pushState / replaceState). */
  setURL(url) {
    this.url = url;
  }

  /** `setTimeout(fn, ms)` on Node's timer, cancelled by `close()`. Returns the handle for `clearTimer`. */
  setTimer(fn, ms) {
    const timers = this.#timers;
    const t = nodeSetTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  clearTimer(t) {
    if (this.#timers.delete(t)) nodeClearTimeout(t);
  }

  /**
   * HTML "queue a task" the way jsdom's `Document#_queueATask` does it: `setImmediate` on Node's timer,
   * cancelled by `close()`. Returns the handle for `cancelTask`. Session history traversal (lib/history.cjs,
   * DESIGN §23) runs on it.
   */
  queueTask(fn) {
    const tasks = this.#tasks;
    const t = nodeSetImmediate(() => {
      tasks.delete(t);
      fn();
    });
    tasks.add(t);
    return t;
  }

  cancelTask(t) {
    if (this.#tasks.delete(t)) nodeClearImmediate(t);
  }

  /** Teardown work; `close()` runs it in reverse order of registration (last installed, first undone). */
  onClose(fn) {
    this.#cleanups.push(fn);
  }

  /**
   * Closes the context: cancels its timers, undoes what it installed (error routing, then the globals),
   * forgets it, and makes the previous open context current again if this one was current. Idempotent.
   */
  close() {
    if (!this.#teardown()) return;
    const i = stack.indexOf(this);
    if (i >= 0) {
      stack.splice(i, 1);
      if (cur === this) {
        cur = stack.length === 0 ? null : stack[stack.length - 1];
        if (cur !== null) rt.N.setMainDocument(cur.document._i);
      }
    }
  }

  /** Teardown without touching the env (reset() drops it). False if already closed. */
  #teardown() {
    if (this.closed) return false;
    this.closed = true;
    for (const t of this.#timers) nodeClearTimeout(t);
    this.#timers.clear();
    for (const t of this.#tasks) nodeClearImmediate(t);
    this.#tasks.clear();
    const cleanups = this.#cleanups;
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
    cleanups.length = 0;
    open.delete(this);
    if (this.window !== null && byWindow.get(this.window) === this) {
      byWindow.delete(this.window);
      // A closed window stays a window (`instanceof Window`, an event's `view`), as in jsdom; except a global
      // one, whose object goes back to being the plain global
      if (!this.global) closedWindows.add(this.window);
    }
    return true;
  }

  static {
    rt.onReset(() => {
      // Newest first, so globals installed over an older context's come back in the right order.
      for (const c of [...open].reverse()) c.#teardown();
      stack.length = 0;
      cur = null;
    });
  }
}

/**
 * Opens a browsing context: a new HTML document (html/head/body) and its window.
 * - `url`: the document URL (default DEFAULT_URL);
 * - `html`: body markup, set as `documentElement.innerHTML`;
 * - `source`: a whole HTML document (doctype, `<html>` attributes and all) parsed as the context's document,
 *   as `new JSDOM(source)` does; excludes `html`;
 * - `xml`: an XML content type: the document is an XML document of that type and `source` is parsed as XML;
 * - `main: false`: the context does not become current;
 * - `global`: install the window's members on this object (the Vitest environment passes globalThis) instead
 *   of a fresh null-prototype object; `close()` restores the object's original properties;
 * - `ownTimers`: the window gets its own `setTimeout` & co (integer handles, cancelled by `close()`) even on a
 *   `global` (the Jest environment's vm context, which has no timers of its own);
 * - `catchErrors`: Vitest's window error routing (unhandled ErrorEvents become uncaught exceptions);
 * - `settings`: overrides of `BrowsingContext#settings` (the `JSDOM` class's options).
 * @param {{ url?: string, html?: string, source?: string, xml?: string, main?: boolean, global?: object, ownTimers?: boolean, catchErrors?: boolean, settings?: object }} [options]
 * @returns {BrowsingContext}
 */
function openContext(options = {}) {
  const url = new URL(options.url ?? DEFAULT_URL);
  if (options.xml !== undefined && options.html !== undefined) {
    throw new TypeError('rsdom: context.open() takes `source` (the whole document) for an XML document, not `html`');
  }
  if (options.source !== undefined && options.html !== undefined) {
    throw new TypeError('rsdom: context.open() takes `html` (body markup) or `source` (a whole document), not both');
  }
  let document;
  if (options.xml !== undefined) {
    // An XML document (`new JSDOM(x, { contentType })` with an XML type, DESIGN §38); a well-formedness error throws
    const xml = require('./xml.cjs');
    document = xml.newXmlDocument(options.xml, url.href);
    if (options.source !== undefined) xml.parseInto(document, String(options.source), { fileName: url.href });
  } else {
    // the HTML parser's scripting flag: `<noscript>` holds raw text in a document that runs scripts (DESIGN §45)
    const scripting = options.settings?.runScripts === 'dangerously' ? 1 : 0;
    const id = rt.checkId(options.source === undefined ? rt.N.createDocument(0, null) : rt.N.parseDocument(String(options.source), scripting));
    rt.afterAlloc();
    document = rt.wrap(id);
  }
  const ctx = new BrowsingContext(document, url);
  if (options.settings !== undefined) Object.assign(ctx.settings, options.settings);
  ctx.global = options.global !== undefined;
  document._ctx = ctx;
  open.add(ctx);
  if (options.main !== false) {
    stack.push(ctx);
    cur = ctx;
    rt.N.setMainDocument(document._i);
  }
  if (options.html !== undefined) document.documentElement.innerHTML = options.html;
  const window = require('./window.cjs');
  ctx.window = window.makeWindow(ctx, options.global, options.ownTimers === true);
  byWindow.set(ctx.window, ctx);
  if (options.catchErrors === true) ctx.onClose(window.catchWindowErrors(ctx.window));
  return ctx;
}

/** The current context, or null. */
function current() {
  return cur;
}

/** The current context's document (what `new Text()` & co create nodes in), or null. */
function currentDocument() {
  return cur === null ? null : cur.document;
}

/** The open context whose window is `win`, or undefined. */
function ofWindow(win) {
  return byWindow.get(win);
}

/**
 * HTML "report an exception" for a callback with no window of its own (MutationObserver callbacks): the
 * current context's window (area B's ErrorEvent path), else the process.
 */
function reportError(err) {
  if (cur !== null) require('./events.cjs').reportException(cur.window, err);
  else process.emit('uncaughtException', err);
}

// The runtime's `defaultDocument` (CONTRIBUTING §5) is the current context's document, read-only.
Object.defineProperty(rt, 'defaultDocument', { get: currentDocument, enumerable: true, configurable: true });

/** True for a window object: an open context's, or a closed non-global one's (`instanceof Window`, event views). */
function isWindow(v) {
  return byWindow.has(v) || closedWindows.has(v);
}

module.exports = { DEFAULT_URL, BrowsingContext, open: openContext, current, currentDocument, ofWindow, isWindow, reportError };
