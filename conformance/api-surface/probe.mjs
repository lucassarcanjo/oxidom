// Step 2 of the surface census: installs ONE DOM on globalThis exactly the way Vitest 5 does (jsdom /
// happy-dom: vitest's builtinEnvironments from e2e/react-app/node_modules/vitest; oxidom: packages/oxidom/lib/vitest-environment.mjs
// setup(globalThis)), then dumps raw facts about the global object and every interface it can reach.
// No judgement happens here; analyze.mjs compares the dumps against the jsdom WebIDL.
//
//   node probe.mjs jsdom|happy-dom|oxidom   -> results/runtime-<kind>.json
//
// Run each DOM in its own process (run.sh does that), so nothing leaks between them.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lab = path.resolve(here, '../..'); // repository root
const kind = process.argv[2];
if (!['jsdom', 'happy-dom', 'oxidom'].includes(kind)) throw new Error('usage: node probe.mjs jsdom|happy-dom|oxidom');

const idl = JSON.parse(fs.readFileSync(path.join(here, 'results/idl.json'), 'utf8'));

// ---- Baseline: plain Node globalThis, captured by descriptor (never invoking Node's lazy getters).
const baselineNames = Object.getOwnPropertyNames(globalThis);
const baselineDesc = new Map(baselineNames.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
// JS-language globals of a fresh realm (Object, Array, ...): what a vm context has without any host.
const realmBuiltins = new Set(vm.runInNewContext('Object.getOwnPropertyNames(globalThis)'));

// ---- Environment setup, as Vitest does it.
const vitestRuntime = path.join(lab, 'node_modules/vitest/dist/runtime.js');
const rt = await import(pathToFileURL(vitestRuntime).href);
let env;
if (kind === 'oxidom') env = (await import(pathToFileURL(path.join(lab, 'packages/oxidom/lib/vitest-environment.mjs')).href)).default;
else env = rt.builtinEnvironments[kind];
const t0 = performance.now();
const handle = await env.setup(globalThis, {});
const setupMs = performance.now() - t0;

const versions = {};
for (const p of ['vitest', 'jsdom', 'happy-dom']) {
  try {
    versions[p] = JSON.parse(fs.readFileSync(path.join(lab, 'node_modules', p, 'package.json'), 'utf8')).version;
  } catch {}
}
try {
  versions.oxidom = JSON.parse(fs.readFileSync(path.join(lab, 'packages/oxidom/package.json'), 'utf8')).version;
} catch {}

// ---- Helpers
const WK = new Map(
  Object.getOwnPropertyNames(Symbol)
    .filter((k) => typeof Symbol[k] === 'symbol')
    .map((k) => [Symbol[k], `@@${k}`]),
);
function keyName(k) {
  if (typeof k === 'string') return k;
  if (WK.has(k)) return WK.get(k);
  return null; // private/internal symbols are not API
}
function ownKeys(o) {
  try {
    return Reflect.ownKeys(o).map(keyName).filter((k) => k !== null);
  } catch {
    return [];
  }
}
const isRealmProto = (o) => {
  // Object.prototype / Function.prototype of ANY realm (jsdom runs in a vm context with its own Object).
  try {
    return Object.getPrototypeOf(o) === null && Object.prototype.hasOwnProperty.call(o, 'hasOwnProperty') && Object.prototype.hasOwnProperty.call(o, 'isPrototypeOf');
  } catch {
    return false;
  }
};
const isFunctionProto = (o) => {
  try {
    return typeof o === 'function' && Object.prototype.hasOwnProperty.call(o, 'call') && Object.prototype.hasOwnProperty.call(o, 'apply') && o.name === '';
  } catch {
    return false;
  }
};
/** [{ label, own: [...] }] from o up to (excluding) the realm's Object.prototype. */
function chain(o, stop = isRealmProto) {
  const out = [];
  let cur = o;
  let guard = 0;
  while (cur != null && !stop(cur) && guard++ < 40) {
    let label = '';
    try {
      const c = Object.prototype.hasOwnProperty.call(cur, 'constructor') ? cur.constructor : null;
      label = typeof c === 'function' ? c.name : '';
    } catch {}
    out.push({ label, own: ownKeys(cur) });
    try {
      cur = Object.getPrototypeOf(cur);
    } catch {
      break;
    }
  }
  return out;
}
function safeGet(o, k) {
  try {
    return { ok: true, v: o[k] };
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) };
  }
}
const isClassLike = (k) => /^[A-Z]/.test(k);

/** Tries `new C()` with no arguments: 'ok' | 'needs-args' (TypeError about arguments) | 'illegal' | other error text. */
function construct(C) {
  try {
    new C();
    return 'ok';
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/illegal constructor|not a constructor|cannot be constructed|abstract|Illegal invocation|is not constructable|Invalid constructor/i.test(msg)) return `illegal: ${msg.slice(0, 100)}`;
    if (/argument|required|not enough|Failed to construct|must be|parameter|undefined is not|invalid/i.test(msg)) return `needs-args: ${msg.slice(0, 100)}`;
    return `error: ${msg.slice(0, 100)}`;
  }
}

/** Was global[k] left as plain Node had it (same descriptor value / same accessor)? */
function fromNode(k) {
  const b = baselineDesc.get(k);
  if (!b) return false;
  const n = Object.getOwnPropertyDescriptor(globalThis, k);
  if (!n) return false;
  if ('value' in b && 'value' in n) return b.value === n.value;
  if (b.get && n.get) return b.get === n.get;
  // Node lazy getter replaced by data property or vice versa: compare values when safe.
  return false;
}

function describeValue(k) {
  const g = safeGet(globalThis, k);
  if (!g.ok) return { present: true, getterThrows: g.err };
  const v = g.v;
  const rec = { present: k in globalThis, type: v === null ? 'null' : typeof v, fromNode: fromNode(k) };
  if (typeof v === 'function') {
    rec.name = v.name;
    rec.staticChain = chain(v, isFunctionProto);
    if (v.prototype && typeof v.prototype === 'object') rec.protoChain = chain(v.prototype);
  } else if (v && typeof v === 'object') {
    rec.objectChain = chain(v);
  }
  return rec;
}

// ---- Names to describe: every IDL interface, legacy factory functions, plus every own global after setup.
const idlNames = new Set();
for (const i of idl.interfaces) {
  idlNames.add(i.name);
  for (const f of i.legacyFactory) idlNames.add(f);
}
const afterNames = Object.getOwnPropertyNames(globalThis);
const globals = {};
for (const k of new Set([...idlNames, ...afterNames])) {
  if (!(k in globalThis)) {
    globals[k] = { present: false };
    continue;
  }
  // Skip describing plain Node / JS builtins that the DOM did not touch (keeps the dump small) unless IDL.
  if (!idlNames.has(k) && !isClassLike(k) && baselineDesc.has(k) && fromNode(k)) {
    globals[k] = { present: true, fromNode: true, skipped: true };
    continue;
  }
  globals[k] = describeValue(k);
}

// Constructibility for IDL interfaces that are exposed (and legacy factory functions).
for (const k of idlNames) {
  const r = globals[k];
  if (r?.type === 'function') r.construct = construct(globalThis[k]);
}

// ---- Instances, for [LegacyUnforgeable] members (own instance properties) and [Global] Window members.
const instances = {};
function inst(label, f) {
  try {
    const o = f();
    instances[label] = o == null ? { missing: true } : { chain: chain(o) };
  } catch (e) {
    instances[label] = { error: String(e?.message ?? e).slice(0, 200) };
  }
}
inst('window', () => globalThis);
inst('document', () => document);
inst('location', () => location);
inst('history', () => history);
inst('navigator', () => navigator);
inst('screen', () => screen);
inst('event', () => new Event('x'));
inst('body', () => document.body);
inst('input', () => document.createElement('input'));
inst('svg', () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
inst('text', () => document.createTextNode('x'));
inst('style', () => document.body.style);
inst('localStorage', () => globalThis.localStorage);

// ---- One representative instance per IDL interface where we can make one, recording only the instance's OWN
// keys: happy-dom declares many members as class fields (own instance properties, e.g. MouseEvent.clientX),
// which a prototype-only check would miss. An instance counts for interface I only if
// Object.getPrototypeOf(instance) === I.prototype (the most-derived interface), so parents are not credited.
const instanceOwn = {};
function offer(label, f) {
  let o;
  try {
    o = f();
  } catch {
    return;
  }
  if (o == null || (typeof o !== 'object' && typeof o !== 'function')) return;
  let proto;
  try {
    proto = Object.getPrototypeOf(o);
  } catch {
    return;
  }
  for (const i of idl.interfaces) {
    if (instanceOwn[i.name]?.exact) continue;
    let C;
    try {
      C = globalThis[i.name];
    } catch {
      continue;
    }
    if (typeof C !== 'function' || !C.prototype) continue;
    if (proto === C.prototype) instanceOwn[i.name] = { via: label, exact: true, own: ownKeys(o) };
  }
  // Fallback: credit interfaces that are only reachable as an ancestor (happy-dom's global Document is a
  // per-window subclass, so `document` is not a direct instance of it). Exact matches found later win.
  for (const i of idl.interfaces) {
    if (instanceOwn[i.name]) continue;
    let C;
    try {
      C = globalThis[i.name];
    } catch {
      continue;
    }
    if (typeof C !== 'function' || !C.prototype || i.name === 'EventTarget' || i.name === 'Node' || i.name === 'Element' || i.name === 'HTMLElement') continue;
    try {
      if (o instanceof C) instanceOwn[i.name] = { via: `${label} (instanceof)`, exact: false, own: ownKeys(o) };
    } catch {}
  }
}
const HTML_TAGS = 'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr xyz-unknown blink'.split(' ');
for (const t of HTML_TAGS) offer(`createElement(${t})`, () => document.createElement(t));
for (const t of 'svg g defs desc metadata title symbol switch rect circle path text use'.split(' ')) offer(`createElementNS(svg,${t})`, () => document.createElementNS('http://www.w3.org/2000/svg', t));
const tmpEl = (() => {
  try {
    const d = document.createElement('div');
    d.innerHTML = '<form id="f"><input name="a" type="radio"><input name="a" type="radio"><select><option>x</option></select></form><p>t</p>';
    document.body.appendChild(d);
    return d;
  } catch {
    return null;
  }
})();
const factories = [
  ['document', () => document],
  ['document.implementation', () => document.implementation],
  ['createDocument', () => document.implementation.createDocument(null, null, null)],
  ['createRange', () => document.createRange()],
  ['getSelection', () => globalThis.getSelection()],
  ['createTreeWalker', () => document.createTreeWalker(document)],
  ['createNodeIterator', () => document.createNodeIterator(document)],
  ['location', () => globalThis.location],
  ['history', () => globalThis.history],
  ['navigator', () => globalThis.navigator],
  ['navigator.plugins', () => navigator.plugins],
  ['navigator.mimeTypes', () => navigator.mimeTypes],
  ['screen', () => globalThis.screen],
  ['locationbar', () => globalThis.locationbar],
  ['external', () => globalThis.external],
  ['localStorage', () => globalThis.localStorage],
  ['performance', () => globalThis.performance],
  ['crypto', () => globalThis.crypto],
  ['customElements', () => globalThis.customElements],
  ['body.style', () => document.body.style],
  ['getComputedStyle', () => globalThis.getComputedStyle(document.body)],
  ['classList', () => document.body.classList],
  ['dataset', () => document.body.dataset],
  ['attributes', () => tmpEl.attributes],
  ['attr', () => (document.body.setAttribute('data-x', '1'), document.body.getAttributeNode('data-x'))],
  ['childNodes', () => document.body.childNodes],
  ['children', () => document.body.children],
  ['form.elements', () => tmpEl.querySelector('form').elements],
  ['RadioNodeList', () => tmpEl.querySelector('form').elements.namedItem('a')],
  ['select.options', () => tmpEl.querySelector('select').options],
  ['validity', () => document.createElement('input').validity],
  ['files', () => document.createElement('input').files],
  ['text', () => document.createTextNode('x')],
  ['comment', () => document.createComment('x')],
  ['fragment', () => document.createDocumentFragment()],
  ['pi', () => document.createProcessingInstruction('x', 'y')],
  ['cdata', () => document.implementation.createDocument(null, null, null).createCDATASection('x')],
  ['doctype', () => document.doctype ?? document.implementation.createDocumentType('html', '', '')],
  ['attachShadow', () => document.createElement('div').attachShadow({ mode: 'open' })],
  ['MutationObserver', () => new MutationObserver(() => {})],
  ['MutationRecord', () => {
    const mo = new MutationObserver(() => {});
    const d = document.createElement('div');
    mo.observe(d, { attributes: true });
    d.setAttribute('a', '1');
    const r = mo.takeRecords()[0];
    mo.disconnect();
    return r;
  }],
  ['getBoundingClientRect', () => document.body.getBoundingClientRect()],
  ['DOMRectReadOnly', () => new DOMRectReadOnly()],
  ['styleSheets', () => document.styleSheets],
  ['style.sheet', () => {
    const s = document.createElement('style');
    s.textContent = '@media screen { a { color: red } } b { color: blue }';
    document.head.appendChild(s);
    return s.sheet;
  }],
  ['sheet.media', () => document.head.querySelector('style').sheet.media],
  ['sheet.cssRules', () => document.head.querySelector('style').sheet.cssRules],
  ['cssRules[0]', () => document.head.querySelector('style').sheet.cssRules[0]],
  ['cssRules[1]', () => document.head.querySelector('style').sheet.cssRules[1]],
  ['xhr.upload', () => new XMLHttpRequest().upload],
  ['AbortController.signal', () => new AbortController().signal],
  ['StaticRange', () => new StaticRange({ startContainer: document.body, startOffset: 0, endContainer: document.body, endOffset: 0 })],
  ['File', () => new File([], 'a.txt')],
  ['Blob', () => new Blob([])],
];
for (const [label, f] of factories) offer(label, f);
// Instances whose interface object is NOT on the global (e.g. happy-dom's classList is a DOMTokenList but
// globalThis.DOMTokenList is undefined): informational only, never counted as presence.
const hiddenInstances = {};
for (const [label, f] of [...factories, ...HTML_TAGS.map((t) => [`createElement(${t})`, () => document.createElement(t)])]) {
  try {
    const o = f();
    if (o == null || typeof o !== 'object') continue;
    const name = Object.getPrototypeOf(o)?.constructor?.name;
    if (!name || hiddenInstances[name]) continue;
    const C = globalThis[name];
    if (typeof C === 'function' && C.prototype === Object.getPrototypeOf(o)) continue;
    hiddenInstances[name] = { via: label, chain: chain(o) };
  } catch {}
}
// Generic constructors: new C(), new C('x'), new C('x', {}) for the rest (covers all Event subclasses).
for (const i of idl.interfaces) {
  if (instanceOwn[i.name]?.exact || i.kind !== 'interface') continue;
  for (const args of [['x'], [], ['x', {}]]) {
    if (instanceOwn[i.name]?.exact) break;
    offer(`new ${i.name}(${args.map((a) => JSON.stringify(a)).join(', ')})`, () => new globalThis[i.name](...args));
  }
}

// The Window surface per DOM: names reachable on globalThis (own or inherited, string keys).
// Vitest's populateGlobal defines a getter for every name in its KEYS list even when the DOM lacks it (the
// getter then returns undefined, e.g. `matchMedia` under jsdom), so a key alone is not presence. A name counts
// when its value is not undefined, or when the DOM's real window object has the key (window.event is
// legitimately undefined outside dispatch).
function underlyingWindow() {
  if (kind === 'jsdom') return globalThis.jsdom?.window ?? null;
  if (kind === 'oxidom') return globalThis;
  try {
    for (const sym of Object.getOwnPropertySymbols(document)) {
      const v = document[sym];
      if (v && typeof v === 'object' && 'happyDOM' in v && 'document' in v) return v;
    }
  } catch {}
  return null;
}
const realWin = underlyingWindow();
const windowKeys = new Set();
for (let o = globalThis, i = 0; o && !isRealmProto(o) && i < 40; o = Object.getPrototypeOf(o), i++) for (const k of ownKeys(o)) windowKeys.add(k);
const windowNames = new Set();
const windowUndefinedKeys = [];
for (const k of windowKeys) {
  const g = safeGet(globalThis, k);
  let inReal = false;
  try {
    inReal = realWin != null && k in realWin;
  } catch {}
  if (!g.ok || g.v !== undefined || inReal) windowNames.add(k);
  else windowUndefinedKeys.push(k);
}

// jsdom only: its real Window object (vitest copies only some keys onto globalThis). Used to derive the
// hand-written (non-WebIDL) Window members of jsdom/browser/Window.js.
let jsdomWindow = null;
if (kind === 'jsdom' && globalThis.jsdom?.window) {
  const w = globalThis.jsdom.window;
  jsdomWindow = { chain: chain(w) };
  // jsdom-only global interfaces not in living/*.webidl (URL, URLSearchParams, CSSStyleProperties, XPath*, HTMLDocument)
  jsdomWindow.interfaces = {};
  for (const k of Object.getOwnPropertyNames(w)) {
    if (!isClassLike(k) || idlNames.has(k) || realmBuiltins.has(k)) continue;
    const v = safeGet(w, k).v;
    if (typeof v !== 'function') continue;
    jsdomWindow.interfaces[k] = { staticChain: chain(v, isFunctionProto), protoChain: v.prototype ? chain(v.prototype) : [] };
  }
}

const out = {
  kind,
  generated: new Date().toISOString(),
  node: process.version,
  versions,
  setupMs: Math.round(setupMs),
  baselineNames,
  realmBuiltins: [...realmBuiltins],
  globals,
  instances,
  instanceOwn,
  hiddenInstances,
  windowNames: [...windowNames],
  windowUndefinedKeys,
  realWindowFound: realWin != null,
  jsdomWindow,
};
fs.writeFileSync(path.join(here, `results/runtime-${kind}.json`), JSON.stringify(out));
await handle.teardown(globalThis);
console.log(`${kind}: ${Object.keys(globals).length} names described, setup ${Math.round(setupMs)} ms`);
process.exit(0);
