'use strict';
// The jsdom-compatible programmatic API (ROADMAP Stage 2, DESIGN §31): `new JSDOM(html, options)`, its
// `window`, `serialize()`, `reconfigure()`, `JSDOM.fragment()`, `JSDOM.fromFile()` / `JSDOM.fromURL()`, and
// `VirtualConsole`. Option checks and defaults follow jsdom 30's refs/jsdom/lib/api.js.
//
// Each instance is a browsing context (lib/context.cjs, DESIGN §18) opened on a full-document parse of its
// input, in this thread's one env. Opening it makes it the current context, like `createWindow()`: what
// `new Text()` & co create nodes in. Several instances stay usable side by side; they share one set of
// interface objects (`dom1.window.Node === dom2.window.Node`), which jsdom does not.
//
// What maps onto the context's settings: `pretendToBeVisual` (animation frames, `document.hidden`),
// `storageQuota`, `referrer`, `resources.userAgent`, and `virtualConsole` (default: one forwarding to Node's
// console, as in jsdom), which receives the window's `console` calls, jsdomErrors for not-implemented window
// methods and uncaught exceptions no `error` listener cancelled.
//
// Not implemented: XML content types (no XML parser yet: ROADMAP Stage 3 `xml`), `runScripts` (validated, then
// ignored: rsdom never runs scripts, so `getInternalVMContext()` throws as jsdom does without it),
// `includeNodeLocations` (`nodeLocation()` throws as jsdom does without it), subresource loading (`resources`
// beyond `userAgent`), and a cookie jar `document.cookie` reads (`cookieJar` is held for the getter only;
// `CookieJar` is tough-cookie's when that package is installed, as it is next to jsdom).
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const rt = require('./runtime.cjs');
const context = require('./context.cjs');

const XML_ESSENCE = /^(?:text\/xml|application\/xml|application\/xhtml\+xml|image\/svg\+xml|[^/]+\/[^;]*\+xml)$/;

/**
 * jsdom's decoding of binary input (HTML "determine the character encoding", simplified): a BOM, then the
 * content type's `charset`, then a `<meta charset>` / `http-equiv` prescan of the first 1024 bytes, else UTF-8
 * (jsdom's default is windows-1252 only for a missing charset on a `fromURL()` response; rsdom keeps UTF-8).
 */
function decode(input, contentType) {
  let bytes;
  if (Buffer.isBuffer(input)) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else return String(input);
  return new TextDecoder(sniffEncoding(bytes, contentType)).decode(bytes);
}

function sniffEncoding(bytes, contentType) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const label = (s) => {
    const m = s && /charset\s*=\s*["']?([^"'\s;>]+)/i.exec(s);
    if (m === null || !m) return null;
    try {
      // TextDecoder resolves WHATWG labels (latin1 -> windows-1252); HTML treats a UTF-16 meta as UTF-8
      const enc = new TextDecoder(m[1]).encoding;
      return enc.startsWith('utf-16') ? 'utf-8' : enc;
    } catch {
      return null;
    }
  };
  const fromType = label(contentType);
  if (fromType !== null) return fromType;
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const enc = label(m[0]);
    if (enc !== null) return enc;
  }
  return 'utf-8';
}

/** jsdom's VirtualConsole (refs/jsdom/lib/jsdom/virtual-console.js). */
class VirtualConsole extends EventEmitter {
  constructor() {
    super();
    // an "error" event with no listener would throw
    this.on('error', () => {});
  }

  forwardTo(anyConsole, { jsdomErrors } = {}) {
    for (const method of Object.keys(anyConsole)) {
      if (typeof anyConsole[method] === 'function') {
        this.on(method, (...args) => anyConsole[method](...args));
      }
    }
    const forward = (e) => {
      if (e.type === 'unhandled-exception') anyConsole.error(e.cause.stack);
      else anyConsole.error(e.message);
    };
    if (jsdomErrors === undefined) {
      this.on('jsdomError', forward);
    } else if (Array.isArray(jsdomErrors)) {
      this.on('jsdomError', (e) => {
        if (jsdomErrors.includes(e.type)) forward(e);
      });
    } else if (jsdomErrors !== 'none') {
      throw new TypeError('Invalid jsdomErrors option');
    }
    return this;
  }
}

let CookieJar;
let toughCookie;
try {
  toughCookie = require('tough-cookie');
  CookieJar = class CookieJar extends toughCookie.CookieJar {
    constructor(store, options) {
      super(store, { looseMode: true, ...options });
    }
  };
} catch {
  // tough-cookie is jsdom's dependency, not rsdom's: without it there is no CookieJar
}

function undiciFetch(dispatcher) {
  if (dispatcher !== undefined) {
    try {
      return require('undici').fetch;
    } catch {
      // no undici installed: Node's fetch
    }
  }
  return fetch;
}

/** jsdom's content type check; rsdom has no XML parser yet. Returns the content type as a string. */
function checkContentType(type) {
  const contentType = type === undefined ? 'text/html' : String(type);
  const essence = contentType.split(';')[0].trim().toLowerCase();
  if (XML_ESSENCE.test(essence)) {
    throw new Error(`rsdom: XML documents are not supported (contentType "${contentType}")`);
  }
  if (essence !== 'text/html') {
    throw new RangeError(`The given content type of "${contentType}" was not a HTML or XML content type`);
  }
  return contentType;
}

/** An open context `adopt()` hands to the JSDOM constructor, or null. */
let adopting = null;

class JSDOM {
  #ctx;
  #virtualConsole;
  #cookieJar;

  constructor(input = '', options = {}) {
    if (adopting !== null) {
      this.#ctx = adopting.ctx;
      this.#virtualConsole = adopting.virtualConsole;
      this.#cookieJar = CookieJar ? new CookieJar() : undefined;
      return;
    }
    const contentType = checkContentType(options.contentType);
    // jsdom's normalizeOptions: `new URL(x)` throws a TypeError for anything but an absolute URL
    const url = options.url === undefined ? 'about:blank' : new URL(options.url).href;
    const referrer = options.referrer === undefined ? '' : new URL(options.referrer).href;
    const runScripts = options.runScripts === undefined ? undefined : String(options.runScripts);
    if (runScripts !== undefined && runScripts !== 'dangerously' && runScripts !== 'outside-only') {
      throw new RangeError('runScripts must be undefined, "dangerously", or "outside-only"');
    }
    const resources = options.resources === undefined || options.resources === 'usable' ? {} : options.resources;
    if (typeof resources !== 'object' || resources === null) {
      throw new TypeError('resources must be undefined, "usable", or an object');
    }
    this.#cookieJar = options.cookieJar === undefined && CookieJar ? new CookieJar() : options.cookieJar;
    this.#virtualConsole = options.virtualConsole === undefined ? new VirtualConsole().forwardTo(console) : options.virtualConsole;
    if (!(this.#virtualConsole instanceof VirtualConsole)) {
      throw new TypeError('virtualConsole must be an instance of VirtualConsole');
    }

    const ctx = context.open({
      url,
      source: decode(input, contentType),
      settings: {
        pretendToBeVisual: Boolean(options.pretendToBeVisual),
        storageQuota: options.storageQuota === undefined ? 5000000 : Number(options.storageQuota),
        userAgent: resources.userAgent === undefined ? null : String(resources.userAgent),
        referrer,
        virtualConsole: this.#virtualConsole,
        closable: true,
      },
      // A `JSDOM` made inside a Vitest test (a sanitizer's helper document) must not take over what `new Text()`
      // & co create nodes in on the global window; between plain instances, the newest is current
      main: context.current()?.global !== true,
    });
    if (options.beforeParse !== undefined) {
      // jsdom calls it with an empty document, before parsing; rsdom parses into a new document, so the
      // parsed nodes are taken out for the call and put back after it
      const { document } = ctx;
      const nodes = [...document.childNodes];
      for (const n of nodes) document.removeChild(n);
      options.beforeParse(ctx.window);
      for (const n of nodes) document.appendChild(n);
    }
    this.#ctx = ctx;
  }

  get window() {
    return this.#ctx.window;
  }

  get virtualConsole() {
    return this.#virtualConsole;
  }

  get cookieJar() {
    return this.#cookieJar;
  }

  serialize() {
    let out = '';
    for (const n of this.#ctx.document.childNodes) {
      if (n.nodeType === 10) out += `<!DOCTYPE ${n.name}>`;
      else if (n.nodeType === 8) out += `<!--${n.data}-->`;
      else if (n.nodeType === 7) out += `<?${n.target} ${n.data}>`;
      else if (n.nodeType === 1) out += n.outerHTML;
    }
    return out;
  }

  nodeLocation() {
    throw new Error('Location information was not saved for this jsdom. Use includeNodeLocations during creation.');
  }

  getInternalVMContext() {
    throw new TypeError('This jsdom was not configured to allow script running. Use the runScripts option during creation.');
  }

  reconfigure(settings) {
    // On the Vitest global, `top` stays the global: Vitest's jsdom environment copies the window's members once,
    // so reconfiguring `windowTop` there only changes jsdom's hidden window
    if ('windowTop' in settings && !this.#ctx.global) {
      Object.defineProperty(this.#ctx.window, 'top', { value: settings.windowTop, configurable: true, writable: true });
    }
    if ('url' in settings) {
      let href;
      try {
        href = new URL(settings.url).href;
      } catch {
        throw new TypeError(`Could not parse "${settings.url}" as a URL`);
      }
      this.#ctx.setURL(new URL(href));
    }
  }

  static fragment(string = '') {
    const doc = rt.defaultDocument ?? new JSDOM().window.document;
    const template = doc.createElement('template');
    template.innerHTML = string;
    return template.content;
  }

  static async fromFile(filename, options = {}) {
    // jsdom's normalizeFromFileOptions
    const normalized = { ...options };
    if (normalized.contentType === undefined) {
      const ext = path.extname(filename);
      if (ext === '.xhtml' || ext === '.xht' || ext === '.xml') normalized.contentType = 'application/xhtml+xml';
    }
    if (normalized.url === undefined) normalized.url = pathToFileURL(path.resolve(filename)).href;
    return new JSDOM(await fs.promises.readFile(filename), normalized);
  }

  static async fromURL(url, options = {}) {
    // jsdom's normalizeFromURLOptions and the initial request of its fromURL
    if (options.url !== undefined) throw new TypeError('Cannot supply a url option when using fromURL');
    if (options.contentType !== undefined) throw new TypeError('Cannot supply a contentType option when using fromURL');
    const normalized = { ...options };
    if (options.referrer !== undefined) normalized.referrer = new URL(options.referrer).href;
    if (options.cookieJar === undefined && CookieJar) normalized.cookieJar = new CookieJar();
    const requestURL = new URL(url).href;
    const userAgent = options.resources?.userAgent ?? require('./window.cjs').USER_AGENT;
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
      'User-Agent': String(userAgent),
    };
    if (normalized.referrer) headers.Referer = normalized.referrer;
    // A `resources.dispatcher` is an undici Dispatcher, as in jsdom: use the installed undici's fetch with it
    // (Node's bundled undici may be another version, which rejects it), else Node's fetch
    const dispatcher = options.resources?.dispatcher;
    const res = await undiciFetch(dispatcher)(requestURL, { headers, dispatcher });
    if (!res.ok) throw new Error(`Resource was not loaded. Status: ${res.status}`);
    // Response.url has no fragment; jsdom keeps the request's (fetch: a redirect target inherits it)
    const hash = requestURL.indexOf('#');
    return new JSDOM(Buffer.from(await res.arrayBuffer()), {
      ...normalized,
      url: res.url + (hash < 0 ? '' : requestURL.slice(hash)),
      contentType: res.headers.get('content-type') || undefined,
    });
  }
}

/**
 * A `JSDOM` for an already open context: the Vitest environment's `jsdom` global (what Vitest's jsdom
 * environment exposes, for `jsdom.reconfigure({ url })` and `jsdom.serialize()`).
 */
function adopt(ctx, virtualConsole) {
  adopting = { ctx, virtualConsole };
  try {
    return new JSDOM();
  } finally {
    adopting = null;
  }
}

module.exports = { JSDOM, VirtualConsole, CookieJar, toughCookie, adopt, checkContentType };
