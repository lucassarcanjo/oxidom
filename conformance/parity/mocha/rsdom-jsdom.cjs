'use strict';
// A `JSDOM`-shaped adapter over rsdom, so jsdom's own mocha suites (which build documents with
// `new JSDOM(html, options)`) can run against rsdom. Test infrastructure only: the public `JSDOM` class is
// ROADMAP Stage 2, and this file is the smallest surface the suites need, not a design for it.
//
// What it maps:
// - `new JSDOM(input, { url, contentType, beforeParse, ... })`: a browsing context (lib/context.cjs, DESIGN
//   §18) opened on a full-document parse of `input` (`source`, the parseDocument native DOMParser uses too).
//   Each instance becomes the current context, like `createWindow()` does. jsdom's default URL is about:blank.
// - XML content types throw (rsdom has no XML parser yet: ROADMAP Stage 3); options rsdom has no equivalent
//   for (runScripts, resources, cookieJar, pretendToBeVisual, storageQuota) are accepted and ignored, so the
//   tests that depend on them fail on their own assertions.
// - `serialize()`, `JSDOM.fragment()`, `fromFile()`, `fromURL()` (plain fetch), `reconfigure({ url })`;
//   `nodeLocation()` / `getInternalVMContext()` throw as jsdom does when the option is off.
// - `VirtualConsole` (an EventEmitter rsdom never writes to), `CookieJar` (tough-cookie's), `toughCookie`.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const PKG = path.resolve(__dirname, '../../../packages/rsdom/lib');
const facade = require(path.join(PKG, 'index.cjs'));
const context = require(path.join(PKG, 'context.cjs'));
const { rt } = facade;

const XML_ESSENCE = /^(?:text\/xml|application\/xml|application\/xhtml\+xml|image\/svg\+xml|[^/]+\/[^;]*\+xml)$/;

function decode(input) {
  if (input === undefined) return '';
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
  #ctx;
  #virtualConsole;

  constructor(input = undefined, options = {}) {
    const contentType = options.contentType === undefined ? 'text/html' : String(options.contentType);
    const essence = contentType.split(';')[0].trim().toLowerCase();
    if (XML_ESSENCE.test(essence)) {
      throw new Error(`rsdom adapter: XML documents are not supported (contentType "${contentType}")`);
    }
    if (essence !== 'text/html') {
      throw new RangeError(`The given content type of "${contentType}" was not a HTML or XML content type`);
    }
    let url = 'about:blank';
    if (options.url !== undefined) {
      try {
        url = new URL(String(options.url)).href;
      } catch {
        throw new TypeError(`Could not parse url argument "${options.url}" to JSDOM constructor as an absolute URL`);
      }
    }
    this.#virtualConsole = options.virtualConsole ?? new VirtualConsole();

    this.#ctx = context.open({ url, source: decode(input) });
    if (typeof options.beforeParse === 'function') options.beforeParse(this.#ctx.window);
  }

  get window() {
    return this.#ctx.window;
  }

  get virtualConsole() {
    return this.#virtualConsole;
  }

  get cookieJar() {
    return undefined;
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

  reconfigure(settings = {}) {
    if (settings.url !== undefined) {
      let href;
      try {
        href = new URL(String(settings.url)).href;
      } catch {
        throw new TypeError(`Could not parse url argument "${settings.url}" to reconfigure as an absolute URL`);
      }
      this.#ctx.setURL(new URL(href));
    }
    if ('windowTop' in settings) {
      Object.defineProperty(this.#ctx.window, 'top', { value: settings.windowTop, configurable: true, writable: true });
    }
  }

  static fragment(string) {
    const doc = rt.defaultDocument ?? new JSDOM().window.document;
    const template = doc.createElement('template');
    template.innerHTML = String(string);
    return template.content;
  }

  static async fromFile(filename, options = {}) {
    const buf = await fs.promises.readFile(filename);
    const url = options.url ?? pathToFileURL(path.resolve(filename)).href;
    const contentType = options.contentType ?? (/\.x?html?$/i.test(filename) ? 'text/html' : undefined);
    return new JSDOM(buf, { ...options, url, contentType });
  }

  static async fromURL(url, options = {}) {
    const res = await fetch(String(url));
    if (!res.ok) throw new Error(`Resource was not loaded. Status: ${res.status}`);
    const contentType = res.headers.get('content-type') ?? 'text/html';
    return new JSDOM(Buffer.from(await res.arrayBuffer()), { ...options, url: res.url, contentType });
  }
}

module.exports = { JSDOM, VirtualConsole, CookieJar, toughCookie };
