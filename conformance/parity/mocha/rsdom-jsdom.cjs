'use strict';
// A `JSDOM`-shaped adapter over rsdom, so jsdom's own mocha suites (which build documents with
// `new JSDOM(html, options)`) can run against rsdom. Test infrastructure only: the public `JSDOM` class is
// ROADMAP Stage 2, and this file is the smallest surface the suites need, not a design for it.
//
// What it maps:
// - `new JSDOM(input, { url, contentType, beforeParse, ... })`: a full-document parse (rsdom's parseDocument
//   native, the same one DOMParser uses), wrapped in a window built by window.cjs's makeWindow. Each instance
//   becomes rsdom's main document, like `createWindow()` does. jsdom's default URL is about:blank.
//   jsdom calls `beforeParse` before parsing, with an empty document; rsdom only parses into a new document, so
//   the parsed nodes are taken out of it for the call and put back after it.
// - Option checks and defaults are jsdom's (refs/jsdom/lib/api.js: url, referrer, runScripts, virtualConsole,
//   fromURL's url / contentType). XML content types throw (rsdom has no XML parser yet: ROADMAP Stage 3).
//   Options rsdom has no equivalent for (referrer, runScripts, resources, cookieJar, pretendToBeVisual,
//   storageQuota) go no further, so the tests that depend on them fail on their own assertions; `cookieJar`
//   is only held for the getter (document.cookie does not read it).
// - `serialize()`, `JSDOM.fragment()`, `fromFile()`, `fromURL()` (undici's fetch with jsdom's Accept / Referer
//   headers and `resources.dispatcher`; no cookies, no user agent), `reconfigure({ windowTop, url })`;
//   `nodeLocation()` / `getInternalVMContext()` throw as jsdom does when the option is off.
//   `reconfigure({ url })` changes document.URL only: rsdom's window keeps its URL (location, origin) in
//   window.cjs's private state, which has no setter.
// - `VirtualConsole` (an EventEmitter rsdom never writes to), `CookieJar` (tough-cookie's), `toughCookie`.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const PKG = path.resolve(__dirname, '../../../packages/rsdom/lib');
const facade = require(path.join(PKG, 'index.cjs'));
const { makeWindow } = require(path.join(PKG, 'window.cjs'));
const events = require(path.join(PKG, 'events.cjs'));
const { rt } = facade;

const XML_ESSENCE = /^(?:text\/xml|application\/xml|application\/xhtml\+xml|image\/svg\+xml|[^/]+\/[^;]*\+xml)$/;

function decode(input) {
  if (Buffer.isBuffer(input)) return new TextDecoder().decode(input);
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return new TextDecoder().decode(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  return String(input);
}

class VirtualConsole extends EventEmitter {
  forwardTo() {
    return this;
  }

  sendTo() {
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
  // tough-cookie is jsdom's dependency; without it, tests that need a cookie jar fail on their own
}

class JSDOM {
  #window;
  #virtualConsole;
  #cookieJar;

  constructor(input = '', options = {}) {
    const contentType = options.contentType === undefined ? 'text/html' : String(options.contentType);
    const essence = contentType.split(';')[0].trim().toLowerCase();
    if (XML_ESSENCE.test(essence)) {
      throw new Error(`rsdom adapter: XML documents are not supported (contentType "${contentType}")`);
    }
    if (essence !== 'text/html') {
      throw new RangeError(`The given content type of "${contentType}" was not a HTML or XML content type`);
    }
    // jsdom's normalizeOptions: `new URL(x)` throws a TypeError for anything but an absolute URL
    const url = options.url === undefined ? 'about:blank' : new URL(options.url).href;
    if (options.referrer !== undefined) new URL(options.referrer);
    const runScripts = options.runScripts === undefined ? undefined : String(options.runScripts);
    if (runScripts !== undefined && runScripts !== 'dangerously' && runScripts !== 'outside-only') {
      throw new RangeError('runScripts must be undefined, "dangerously", or "outside-only"');
    }
    this.#cookieJar = options.cookieJar === undefined && CookieJar ? new CookieJar() : options.cookieJar;
    this.#virtualConsole = options.virtualConsole === undefined ? new VirtualConsole() : options.virtualConsole;
    if (!(this.#virtualConsole instanceof VirtualConsole)) {
      throw new TypeError('virtualConsole must be an instance of VirtualConsole');
    }

    const id = rt.checkId(rt.N.parseDocument(decode(input)));
    rt.afterAlloc();
    const document = rt.wrap(id);
    document._url = url;
    rt.N.setMainDocument(id);
    rt.defaultDocument = document;
    const window = makeWindow(rt, facade.dom, document, { url });
    events.installWindow(window, document);
    if (options.beforeParse !== undefined) {
      const nodes = [...document.childNodes];
      for (const n of nodes) document.removeChild(n);
      options.beforeParse(window);
      for (const n of nodes) document.appendChild(n);
    }
    this.#window = window;
  }

  get window() {
    return this.#window;
  }

  get virtualConsole() {
    return this.#virtualConsole;
  }

  get cookieJar() {
    return this.#cookieJar;
  }

  serialize() {
    let out = '';
    for (const n of this.#window.document.childNodes) {
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
    if ('windowTop' in settings) {
      Object.defineProperty(this.#window, 'top', { value: settings.windowTop, configurable: true, writable: true });
    }
    if ('url' in settings) {
      let href;
      try {
        href = new URL(settings.url).href;
      } catch {
        throw new TypeError(`Could not parse "${settings.url}" as a URL`);
      }
      this.#window.document._url = href;
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
    const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
    if (normalized.referrer) headers.Referer = normalized.referrer;
    // undici's own fetch: a `resources.dispatcher` is an undici Agent (jsdom's dependency, like the tests' own)
    const { fetch } = require('undici');
    const res = await fetch(requestURL, { headers, dispatcher: options.resources?.dispatcher });
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

module.exports = { JSDOM, VirtualConsole, CookieJar, toughCookie };
