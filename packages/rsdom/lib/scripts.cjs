'use strict';
// Script execution (DESIGN §45, ROADMAP Stage 4 `browsing-contexts` part 1): a port of jsdom 30's
// HTMLScriptElement-impl.js (`_eval`, `_postConnectionSteps`, `processJavaScript`), `_globalEventChanged`
// (GlobalEventHandlers-impl.js) and the load steps of `Document#close()` / Window.js.
//
// A document runs scripts when its browsing context's `settings.runScripts` is "dangerously" and Rust knows it
// (`scriptBindDoc`, bound by `bind()` once the window exists). crate::script queues what mutations owe script
// elements and `on*` attributes on the custom element reaction queue; lib/custom-elements.cjs's drain calls
// `postConnection` and `handlerChanged`. The document parse queues nothing: `runParsed()` walks it once.
//
// Scripts run in the window's realm: `vm.runInContext` on a vm-context window (`ctx.vmContext`: a `JSDOM` with
// `runScripts`, the Jest environment), `vm.runInThisContext` on the Vitest global. `<script src>` waits for
// resource loading (part 3).
const vm = require('node:vm');

const rt = require('./runtime.cjs');

const { N } = rt;

/** Script element flags (crate::script). */
const PARSER_INSERTED = 1;
const STARTED = 2;

/** jsdom's JavaScript MIME types (HTMLScriptElement-impl.js `jsMIMETypes`). */
const JS_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const trimAscii = (s) => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');

/** The open context of `el`'s document if it runs scripts (jsdom `_canRunScript`), else null. */
function scriptingContext(el) {
  const ctx = el.ownerDocument?._ctx;
  return ctx !== undefined && !ctx.closed && ctx.settings.runScripts === 'dangerously' ? ctx : null;
}

/** jsdom `_getTypeString`. */
function typeString(el) {
  const type = el.getAttributeNS(null, 'type');
  const lang = el.getAttributeNS(null, 'language');
  if (type === '' || (type === null && (lang === '' || lang === null))) return 'text/javascript';
  if (type !== null) return trimAscii(type);
  return 'text/' + lang;
}

/** The script's child text content (HTML "child text content"). */
function childText(el) {
  let s = '';
  for (let c = el.firstChild; c !== null; c = c.nextSibling) if (c.nodeType === 3) s += c.data;
  return s;
}

/** Runs `code` in context `ctx`'s realm. */
function run(ctx, code, filename) {
  const options = { filename, displayErrors: false };
  return ctx.vmContext === undefined ? vm.runInThisContext(code, options) : vm.runInContext(code, ctx.vmContext, options);
}

/** jsdom `processJavaScript`: runs inline `code` of `el` with `document.currentScript` set. */
function execute(ctx, el, code) {
  const doc = el.ownerDocument;
  const old = doc._currentScript;
  doc._currentScript = el.getRootNode() instanceof rt.classes.ShadowRoot ? null : el;
  try {
    run(ctx, code, doc.URL);
  } catch (e) {
    require('./events.cjs').reportException(ctx.window, e);
  } finally {
    doc._currentScript = old;
  }
}

/** jsdom `_eval` ("prepare the script element", loosely) for script element `id`. */
function evalScript(id) {
  const f = N.scriptFlags(id);
  if ((f & STARTED) !== 0) return;
  const el = rt.wrap(id);
  const notStarted = f & ~PARSER_INSERTED;
  const hasSrc = el.hasAttributeNS(null, 'src');
  const text = childText(el);
  if ((!hasSrc && text.length === 0) || !el.isConnected || !JS_TYPES.has(asciiLower(typeString(el)))) {
    // jsdom clears "parser-inserted" on these early returns (a later insertion can then run the script)
    N.scriptSetFlags(id, notStarted);
    return;
  }
  N.scriptSetFlags(id, f | STARTED);
  if (el.hasAttributeNS(null, 'event') && el.hasAttributeNS(null, 'for')) {
    const forValue = asciiLower(trimAscii(el.getAttributeNS(null, 'for')));
    const event = asciiLower(trimAscii(el.getAttributeNS(null, 'event')));
    if (forValue !== 'window' || (event !== 'onload' && event !== 'onload()')) return;
  }
  const ctx = scriptingContext(el);
  if (ctx === null || hasSrc) return; // `src`: resource loading, part 3
  execute(ctx, el, text);
}

/** jsdom `_postConnectionSteps` (the `cb::SCRIPT` reaction): a script the parser did not insert runs. */
function postConnection(id) {
  if ((N.scriptFlags(id) & PARSER_INSERTED) === 0) evalScript(id);
}

/** jsdom `_globalEventChanged` (the `cb::HANDLER` reaction) for content attribute `name` (`on...`) of `id`. */
function handlerChanged(id, name) {
  const el = rt.wrap(id);
  if (!(name in el) || scriptingContext(el) === null) return;
  const events = require('./events.cjs');
  const value = el.getAttributeNS(null, name);
  events.setHandler(el, name.slice(2), value === null ? null : new events.InlineBody(value));
}

/**
 * Binds `ctx`'s document as one that runs scripts, if its settings say so, and unbinds it on close. Then runs
 * what the document parse left: its `on*` attributes and its scripts, in tree order (the parser's order).
 */
function bind(ctx) {
  if (ctx.settings.runScripts !== 'dangerously') return;
  const doc = ctx.document;
  N.scriptBindDoc(doc._i, 1);
  ctx.onClose(() => N.scriptBindDoc(doc._i, 0));
  const w = rt.outIds(N.scriptParsed(doc._i));
  for (let i = 0; i < w.length; i += 3) {
    if (w[i] === 128) handlerChanged(w[i + 1], rt.atomName(w[i + 2]));
    else evalScript(w[i + 1]);
  }
}

/**
 * The load steps of a `JSDOM` document (jsdom `Document#close()`, Window.js): "loading" until, in microtasks,
 * "interactive" + DOMContentLoaded, then "complete" + the document's `load`, then the window's `load` and
 * `pageshow`. Each step is skipped once the context is closed.
 */
function startLoad(ctx) {
  const doc = ctx.document;
  const events = require('./events.cjs');
  const setReady = (state) => {
    doc._ready = state;
    events.fire(doc, 'readystatechange');
  };
  doc._ready = 'loading';
  Promise.resolve().then(() => {
    if (ctx.closed) return;
    setReady('interactive');
    events.fire(doc, 'DOMContentLoaded', { bubbles: true });
  }).then(() => {
    if (ctx.closed) return;
    setReady('complete');
    events.fire(doc, 'load');
    if (ctx.closed) return;
    events.fire(ctx.wt, 'load');
    if (ctx.closed) return;
    events.fire(ctx.wt, 'pageshow', { persisted: false }, events.PageTransitionEvent);
  });
}

module.exports = { postConnection, handlerChanged, bind, startLoad, run };
