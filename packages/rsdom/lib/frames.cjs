'use strict';
// Iframes (DESIGN §46, ROADMAP Stage 4 `browsing-contexts` part 2): a port of jsdom 30's HTMLFrameElement-impl.js
// (`loadFrame`, `fireLoadEvent`, `refreshAccessors`, the post-connection, `src` and removing steps) and of the
// `noQueue` path of `Document#close()`.
//
// Each `<iframe>` / `<frame>` connected in a document that has a window gets a child browsing context (lib/context.cjs,
// DESIGN §18) that never becomes current. crate::script queues the frame reactions (`cb::FRAME`, `cb::FRAME_SRC`,
// `cb::FRAME_REMOVED`) on the custom element reaction queue; lib/custom-elements.cjs's drain and lib/scripts.cjs's
// post-parse walk call `loadFrame` and `removed`.
const rt = require('./runtime.cjs');
const context = require('./context.cjs');

/**
 * frame element id -> { child, parent }: its child context and the context it was opened in. Kept once the frame
 * is removed or its parent closes (jsdom keeps `contentDocument`), dropped when the env resets (nodes live until then
 * too: `reclamation`).
 */
const childOf = new Map();
rt.onReset(() => childOf.clear());
/** parent context -> its open child contexts (closed with it) */
const childrenOf = new WeakMap();
/** window -> the number of indexed frame accessors it has (jsdom `_length`) */
const lengthOf = new WeakMap();

const BLANK = '<html><head></head><body></body></html>';

/** HTML "process the iframe attributes": `src` resolved against the document's base URL, else about:blank. */
function frameURL(el) {
  const src = el.getAttributeNS(null, 'src');
  if (src !== null && src !== '') {
    try {
      return new URL(src, el.ownerDocument.baseURI);
    } catch {
      // unparsable: about:blank
    }
  }
  return new URL('about:blank');
}

/** True if `el` has event listeners (jsdom `canDispatchEvents`: a frame with none gets `load` synchronously). */
function hasListeners(el) {
  const m = el._ev;
  if (m === null || m === undefined) return false;
  return m instanceof Map ? m.size > 0 : m.length > 0;
}

/** Opens the child context of a frame in the document of context `pctx`, at `url`, with `source`. */
function openChild(pctx, url, source) {
  const settings = { ...pctx.settings, referrer: pctx.document.URL };
  const options = { url, source, settings, main: false };
  let ctx;
  if (settings.runScripts === undefined) ctx = context.open(options);
  else {
    // a window with a realm of its own, where its scripts run (as a `JSDOM` with `runScripts`)
    ({ ctx } = require('./vm-window.cjs').openVmWindow(options));
    ctx.global = false;
  }
  let kids = childrenOf.get(pctx);
  if (kids === undefined) {
    kids = new Set();
    childrenOf.set(pctx, kids);
    pctx.onClose(() => {
      for (const k of [...kids]) k.close();
    });
  }
  kids.add(ctx);
  ctx.onClose(() => kids.delete(ctx));
  return ctx;
}

/** Defines `win[k] = v` keeping the property's other attributes. */
function setMember(win, k, v) {
  const d = Object.getOwnPropertyDescriptor(win, k);
  Object.defineProperty(win, k, { value: v, writable: true, enumerable: d?.enumerable ?? true, configurable: true });
}

/** jsdom `fireLoadEvent`: `load` on the frame, unless its child context closed meanwhile. */
function fireLoad(el, child) {
  if (!child.closed) require('./events.cjs').fire(el, 'load');
}

/** jsdom `loadFrame` for frame element `id`; `attaching` for the post-connection steps (else `src` changed). */
function loadFrame(id, attaching) {
  const el = rt.wrap(id);
  const pctx = el.ownerDocument._ctx;
  if (pctx === undefined || pctx.closed) return;
  childOf.get(id)?.child.close();
  const url = frameURL(el);
  const blank = url.href === 'about:blank';
  const js = url.protocol === 'javascript:';
  const child = openChild(pctx, js ? pctx.document.URL : url.href, BLANK);
  childOf.set(id, { child, parent: pctx });
  const win = child.window;
  const doc = child.document;
  setMember(win, 'parent', pctx.window);
  setMember(win, 'top', pctx.window.top);
  setMember(win, 'frameElement', el);
  refreshAccessors(pctx);
  const scripts = require('./scripts.cjs');
  if (!blank && !js) {
    // fetched only with `resources: "usable"` (part 3): until then the document stays empty and loading
    while (doc.firstChild !== null) doc.removeChild(doc.firstChild);
    doc._ready = 'loading';
    scripts.bind(child);
    return;
  }
  const noQueue = attaching && !hasListeners(el);
  const events = require('./events.cjs');
  if (noQueue) {
    // jsdom `Document#close(true)`: complete at once; the window's `load` follows in a tick (Window.js)
    doc._ready = 'complete';
    events.fire(doc, 'DOMContentLoaded', { bubbles: true });
    events.fire(doc, 'load');
    process.nextTick(() => {
      if (!child.closed) events.fire(child.wt, 'load');
    });
  }
  scripts.bind(child);
  if (js && !child.closed) {
    const result = evaluateJavaScriptURL(child, url);
    if (typeof result === 'string' && doc.body !== null) doc.body.textContent = result;
  }
  if (noQueue) fireLoad(el, child);
  else scripts.startLoad(child).then(() => fireLoad(el, child));
}

/** jsdom `evaluateJavaScriptURL` (window/navigation.js): the URL's decoded source, run when scripts run. */
function evaluateJavaScriptURL(ctx, url) {
  if (ctx.settings.runScripts !== 'dangerously') return undefined;
  const source = new TextDecoder().decode(percentDecode(url.href.slice('javascript:'.length)));
  try {
    return require('./scripts.cjs').run(ctx, source, url.href);
  } catch (e) {
    require('./events.cjs').reportException(ctx.window, e);
    return undefined;
  }
}

/** URL "percent-decode" a string into bytes. */
function percentDecode(s) {
  const input = Buffer.from(s, 'utf8');
  const out = [];
  const hex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (b === 0x25 && i + 2 < input.length && hex(input[i + 1]) && hex(input[i + 2])) {
      out.push(parseInt(String.fromCharCode(input[i + 1], input[i + 2]), 16));
      i += 2;
    } else out.push(b);
  }
  return Uint8Array.from(out);
}

/** jsdom's frame removing steps for element `id`: closes its child context. */
function removed(id) {
  const e = childOf.get(id);
  if (e === undefined) return;
  e.child.close();
  // the context it was opened in: a frame moved to another document has its new owner already
  if (!e.parent.closed) refreshAccessors(e.parent);
}

/**
 * jsdom `refreshAccessors`: the parent window's `length` and indexed properties are its document's frames with
 * a window, in tree order.
 */
function refreshAccessors(pctx) {
  const win = pctx.window;
  const frames = [];
  for (const f of pctx.document.querySelectorAll('iframe,frame')) {
    if (childOf.get(f._i)?.parent === pctx) frames.push(f);
  }
  const old = lengthOf.get(win);
  if (old === undefined) {
    // a global window's indices go with it (lib/window.cjs restores only the members it defined)
    pctx.onClose(() => {
      for (let i = 0, n = lengthOf.get(win) ?? 0; i < n; i++) delete win[i];
      lengthOf.delete(win);
    });
  }
  for (let i = 0; i < (old ?? 0); i++) delete win[i];
  lengthOf.set(win, frames.length);
  setMember(win, 'length', frames.length);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    Object.defineProperty(win, i, { get: () => contentWindow(f), enumerable: true, configurable: true });
  }
}

function contentDocument(el) {
  return childOf.get(el._i)?.child.document ?? null;
}

function contentWindow(el) {
  return childOf.get(el._i)?.child.window ?? null;
}

function install() {
  const C = rt.classes;
  for (const H of [C.HTMLIFrameElement, C.HTMLFrameElement]) {
    rt.define(H, {
      get contentDocument() {
        return contentDocument(this);
      },
      get contentWindow() {
        return contentWindow(this);
      },
    });
  }
}

module.exports = { install, loadFrame, removed, frameWindow: contentWindow };
