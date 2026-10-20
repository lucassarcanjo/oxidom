'use strict';
// XMLHttpRequest (ROADMAP Stage 1 `xhr`, DESIGN §21): XMLHttpRequestEventTarget, XMLHttpRequestUpload and the
// asynchronous XMLHttpRequest. Ported from refs/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js (jsdom 30, the
// oracle).
//
// Facade state only (CONTRIBUTING §7): each request object keeps one fixed-shape XhrState in `#x`, and the only DOM
// objects it creates are response Documents (through DOMParser). Events go through area B (`events.fire`: trusted,
// `window.event` set, a throwing listener is reported on the window and the request carries on).
//
// Network: `FETCH` is Node's fetch as it was when the facade loaded (in the Vitest environment that is setup(),
// before any setup file), so whatever patches globalThis.fetch later (vi.stubGlobal, fetch spies, msw's
// FetchInterceptor) never sees XHR traffic, as with jsdom, which calls undici directly; socket-level mocks (msw 3)
// and undici's global dispatcher do see it. Reading the reference does not load undici, the first call does.
// lib/xhr-fetch.cjs (loaded on the first send()) holds bodies, CORS, redirects and the response pump. The first
// fetch call happens synchronously inside send() and later hops are its continuations, never timers: msw 3 finds
// the initiating XHR through AsyncLocalStorage.
//
// Event order and state follow jsdom's traces, timeout quirks included (progress before timeout, readyState back
// to 0 after loadend, response kept). Fixed on purpose (asserted in test/contract/xhr.test.mjs): no transport
// callback of a request fires anything after its loadend or abort (events of the step being dispatched, such as
// load/loadend after readystatechange(4), still fire, as in jsdom); abort and network errors clear responseURL; responseURL and Referer have no
// fragment; typed-array, URLSearchParams and SharedArrayBuffer bodies follow the spec; a timeout set after send()
// takes effect and a stale one never aborts the next request; open() drops stored credentials; blob: URLs load.
// Not supported: synchronous requests (send() throws NetworkError, jsdom's failure shape) and responseXML for XML
// types (no XML parser, CONTRIBUTING §8).

const rt = require('./runtime.cjs');
const { EventTarget } = require('./dom.cjs');
const events = require('./events.cjs');
const forms = require('./forms.cjs');
const { USER_AGENT } = require('./window.cjs');
const { types, MIMEType } = require('node:util');

/** Node's fetch when the facade loaded (a plain function: reading it does not load undici). */
const FETCH = globalThis.fetch;
/** node:buffer's Blob (File included), not one of Node's lazy undici globals. */
const NodeBlob = globalThis.Blob;
let net = null;
/** lib/xhr-fetch.cjs, loaded by the first send(). */
const loadNet = () => (net ??= require('./xhr-fetch.cjs'));
/** Tokens of the requests whose transport is running (teardown aborts them). */
const ACTIVE = new Set();

const UNSENT = 0;
const OPENED = 1;
const HEADERS_RECEIVED = 2;
const LOADING = 3;
const DONE = 4;

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
/** https://fetch.spec.whatwg.org/#forbidden-request-header (refs/jsdom/lib/jsdom/living/fetch/header-types.js) */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method', 'x-http-method-override', 'x-method-override']);
const RESPONSE_TYPES = new Set(['', 'arraybuffer', 'blob', 'document', 'json', 'text']);
const PROGRESS_EVENTS = ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

// ============================================================================== WebIDL conversions

function need(argc, n, method) {
  if (argc < n) {
    throw new TypeError(`Failed to execute '${method}' on 'XMLHttpRequest': ${n} argument${n > 1 ? 's' : ''} required, but only ${argc} present.`);
  }
}

function byteString(v, i, method) {
  const s = typeof v === 'string' ? v : String(v);
  if (/[^\x00-\xff]/.test(s)) throw new TypeError(`Failed to execute '${method}' on 'XMLHttpRequest': parameter ${i} is not a valid ByteString.`);
  return s;
}

function usv(v) {
  return (typeof v === 'string' ? v : String(v)).toWellFormed();
}

const invalidAccess = () => new rt.classes.DOMException('The object does not support the operation or argument.', 'InvalidAccessError');

/** https://fetch.spec.whatwg.org/#header-value-get-decode-and-split (quoted strings kept whole). */
function splitValues(v) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < v.length) cur += v[++i];
      else if (c === '"') quoted = false;
    } else if (c === ',') {
      out.push(cur.replace(/^[\t ]+|[\t ]+$/g, ''));
      cur = '';
    } else {
      if (c === '"') quoted = true;
      cur += c;
    }
  }
  out.push(cur.replace(/^[\t ]+|[\t ]+$/g, ''));
  return out;
}

function forbiddenHeader(name, value) {
  const lc = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lc) || lc.startsWith('proxy-') || lc.startsWith('sec-')) return true;
  return METHOD_OVERRIDE_HEADERS.has(lc) && splitValues(value).some((m) => FORBIDDEN_METHODS.has(m.toUpperCase()));
}

function parseMime(s) {
  if (s === null) return null;
  try {
    return new MIMEType(s);
  } catch {
    return null;
  }
}

/** https://encoding.spec.whatwg.org/#names-and-labels: the replacement encoding's labels. */
const REPLACEMENT_LABELS = new Set([
  'csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext', 'iso-2022-kr', 'replacement',
]);

/**
 * Encoding name of a charset label, or null for an unknown one (jsdom `labelToName`). TextDecoder refuses the
 * replacement and x-user-defined encodings, which XHR decodes too (xhr-fetch.cjs `decode`).
 */
function encodingName(label) {
  const l = label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (REPLACEMENT_LABELS.has(l)) return 'replacement';
  if (l === 'x-user-defined') return l;
  try {
    return new TextDecoder(l).encoding;
  } catch {
    return null;
  }
}

// ======================================================================================= state

/**
 * One request object's state, created in one literal (stable shape). `req` is the in-flight request token
 * `{ s, handle, timer, clearTimer, start, total, lc, last }`: `open()`, `abort()`, the timeout and teardown drop it
 * (`cancel`), and every transport callback first checks `s.req === r`, so a superseded request's transport fires
 * nothing more (the rest of an event group already being dispatched still fires, as in jsdom).
 */
function newState(xhr) {
  return {
    xhr,
    upload: new XMLHttpRequestUpload(rt.TOKEN),
    doc: rt.defaultDocument,
    state: UNSENT,
    send: false,
    sync: false,
    /** bumped by every open() */
    gen: 0,
    method: '',
    url: null,
    auth: null,
    /** author request headers: [name, value] pairs, combined case-insensitively (first casing kept) */
    headers: [],
    timeout: 0,
    withCredentials: false,
    responseType: '',
    overrideMime: null,
    overrideCharset: null,
    uploadListener: false,
    uploadComplete: false,
    uploadTotal: 0,
    req: null,
    status: 0,
    statusText: '',
    responseURL: '',
    /** [lowercased name, value] pairs, already filtered (set-cookie, CORS) */
    resHeaders: [],
    /** received body chunks; null = no response */
    chunks: null,
    received: 0,
    bytesCache: null,
    textCache: null,
    respCache: null,
    xmlCache: null,
  };
}

function clearCaches(s) {
  s.bytesCache = null;
  s.textCache = null;
  s.respCache = null;
  s.xmlCache = null;
}

/** XHR "set a response to a network error" (also clears responseURL, which jsdom keeps). */
function setNetworkError(s) {
  s.status = 0;
  s.statusText = '';
  s.responseURL = '';
  s.resHeaders = [];
  s.chunks = null;
  s.received = 0;
  clearCaches(s);
}

/** True once the owner document is gone (teardown neutered it, or its window context closed). */
function destroyed(doc) {
  return doc === null || doc._i === 0 || doc._ctx?.closed === true;
}

function fireP(target, type, loaded = 0, total = 0, lc = false) {
  events.fire(target, type, { lengthComputable: lc, loaded, total }, events.ProgressEvent);
}

function fireRS(s) {
  events.fire(s.xhr, 'readystatechange');
}

function rsChange(s, n) {
  if (s.state === n) return;
  s.state = n;
  fireRS(s);
}

/** Request `r` of `s` is over: no longer current, timeout timer cleared. */
function finish(s, r) {
  s.req = null;
  ACTIVE.delete(r);
  if (r.timer !== null) {
    r.clearTimer(r.timer);
    r.timer = null;
  }
}

/** Drops the in-flight request (no events): stops its transport and its timeout timer. */
function cancel(s) {
  const r = s.req;
  if (r === null) return;
  finish(s, r);
  if (r.handle !== null) r.handle.abort();
}

/** XHR "request error steps" (jsdom `requestErrorSteps`) for 'abort' and 'error'. */
function errorSteps(s, type) {
  s.state = DONE;
  s.send = false;
  setNetworkError(s);
  fireRS(s);
  if (!s.uploadComplete) {
    s.uploadComplete = true;
    if (s.uploadListener) {
      fireP(s.upload, type);
      fireP(s.upload, 'loadend');
    }
  }
  fireP(s.xhr, type);
  fireP(s.xhr, 'loadend');
}

/** XHR "handle errors" with the fatal flag (jsdom's `_abortError` path): teardown, no events. */
function fatal(s) {
  cancel(s);
  s.state = DONE;
  s.send = false;
  setNetworkError(s);
}

/**
 * Aborts, without events, every in-flight request owned by `doc` (all of them for null): `rt.reset()` (Vitest
 * teardown) and a window context's close. Exported for a future window.stop() / window.close().
 */
function abortRequests(doc) {
  for (const r of [...ACTIVE]) if (doc === null || r.s.doc === doc) fatal(r.s);
}

const HOOKED = new WeakSet();

/** A window context that announces its close (`doc._ctx.onClose(fn)`) aborts its document's requests. */
function hookContext(doc) {
  const ctx = doc._ctx;
  if (ctx === undefined || ctx === null || typeof ctx.onClose !== 'function' || HOOKED.has(doc)) return;
  HOOKED.add(doc);
  ctx.onClose(() => abortRequests(doc));
}

// ===================================================================================== timeout

/** Arms the request's timeout with the timer functions of the moment (fake timers drive it, as in jsdom). */
function arm(s, r, delay) {
  const setTimer = globalThis.setTimeout;
  r.clearTimer = globalThis.clearTimeout;
  r.timer = setTimer(() => onTimeout(s, r), delay);
}

/**
 * jsdom's `_timeoutFn`, event for event: upload progress/timeout/loadend whenever the upload is incomplete (listener
 * or not), progress before timeout, readyState reset to 0 after loadend, response kept. The reset is skipped when
 * a handler opened a new request.
 */
function onTimeout(s, r) {
  if (s.req !== r) return;
  r.timer = null;
  const gen = s.gen;
  cancel(s);
  s.send = false;
  let changed = false;
  if (!s.uploadComplete) {
    fireP(s.upload, 'progress');
    rsChange(s, DONE);
    fireP(s.upload, 'timeout');
    fireP(s.upload, 'loadend');
    changed = true;
  }
  fireP(s.xhr, 'progress');
  if (!changed) rsChange(s, DONE);
  fireP(s.xhr, 'timeout');
  fireP(s.xhr, 'loadend');
  if (s.gen === gen && s.state === DONE) s.state = UNSENT;
}

// ===================================================================================== send

/** Fragment serialization of a Document body (HTML serializer, CONTRIBUTING §8). */
function serializeDocument(doc) {
  let out = '';
  for (let c = doc.firstChild; c !== null; c = c.nextSibling) {
    const t = c.nodeType;
    if (t === rt.K.DOCTYPE) out += `<!DOCTYPE ${c.name}>`;
    else if (t === rt.K.ELEMENT) out += c.outerHTML;
    else if (t === rt.K.COMMENT) out += `<!--${c.data}-->`;
    else if (t === rt.K.PI) out += `<?${c.target} ${c.data}>`;
  }
  return out;
}

function docHost(doc) {
  try {
    return new URL(doc.URL).hostname;
  } catch {
    return '';
  }
}

/**
 * Per-document side jar for the cookies `document.cookie` cannot hold: HttpOnly ones and other hosts' (a
 * credentialed `localhost:3000` -> `127.0.0.1` API). doc -> Map<hostname, Map<name, value>>; keyed by host like
 * tough-cookie's domain matching, Path/Domain/Secure/SameSite ignored.
 */
const JAR = new WeakMap();
// Document.prototype's cookie accessor (window.cjs), captured at install: a test stubbing document.cookie on the
// instance must not change what XHR sends or stores (jsdom's XHR uses its jar, never document.cookie)
let COOKIE = null;

function sideJar(doc, host) {
  let m = JAR.get(doc);
  if (m === undefined) JAR.set(doc, (m = new Map()));
  let h = m.get(host);
  if (h === undefined) m.set(host, (h = new Map()));
  return h;
}

/** The cookie closures the transport calls per hop (`desc.cookies`). */
function cookieAdapter(doc) {
  return {
    header(href) {
      const host = new URL(href).hostname;
      const parts = [];
      if (host === docHost(doc)) {
        const c = COOKIE.get.call(doc);
        if (c !== '') parts.push(c);
      }
      const side = JAR.get(doc)?.get(host);
      if (side !== undefined) for (const [k, v] of side) parts.push(k === '' ? v : `${k}=${v}`);
      return parts.join('; ');
    },
    store(href, lines) {
      const host = new URL(href).hostname;
      const same = host === docHost(doc);
      for (const line of lines) {
        const c = net.parseSetCookie(line);
        if (c === null) continue;
        if (same && !c.httpOnly) {
          COOKIE.set.call(doc, line); // the setter handles expiry
          JAR.get(doc)?.get(host)?.delete(c.name);
          continue;
        }
        // an HttpOnly cookie replaces a script-visible one of the same name
        if (same) COOKIE.set.call(doc, `${c.name}=; max-age=0`);
        const side = sideJar(doc, host);
        if (c.expired) side.delete(c.name);
        else side.set(c.name, c.value);
      }
    },
  };
}

/** The transport's request descriptor (plain data plus the cookie closures). */
function describe(s, headers, body) {
  const doc = s.doc;
  let origin = 'null';
  let referrer = null;
  try {
    const u = new URL(doc.URL);
    origin = u.origin;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      u.hash = '';
      referrer = u.href;
    }
  } catch {
    // opaque origin, no referrer
  }
  return {
    url: s.url.href,
    method: s.method,
    headers,
    body,
    origin,
    referrer,
    userAgent: USER_AGENT,
    withCredentials: s.withCredentials,
    auth: s.auth,
    uploadListener: s.uploadListener,
    cookies: cookieAdapter(doc),
  };
}

/** Transport callbacks of request `r`; each one first checks that `r` is still the request of `s`. */
function makeSink(s, r) {
  return {
    onResponse(i) {
      if (s.req !== r) return;
      if (!s.uploadComplete) {
        s.uploadComplete = true;
        if (s.uploadListener) {
          const n = s.uploadTotal;
          fireP(s.upload, 'progress', n, n, n > 0);
          fireP(s.upload, 'load', n, n, n > 0);
          fireP(s.upload, 'loadend', n, n, n > 0);
          if (s.req !== r) return;
        }
      }
      s.responseURL = i.url;
      s.status = i.status;
      s.statusText = i.statusText;
      s.resHeaders = i.headers;
      r.total = i.total;
      r.lc = i.lc;
      r.last = undefined;
      s.chunks = [];
      s.received = 0;
      clearCaches(s);
      rsChange(s, HEADERS_RECEIVED);
    },
    onData(c) {
      if (s.req !== r) return;
      s.chunks.push(c);
      s.received += c.length;
      clearCaches(s);
      if (s.state === HEADERS_RECEIVED) s.state = LOADING;
      fireRS(s);
      if (s.req !== r) return;
      if (r.last !== s.received) {
        r.last = s.received;
        fireP(s.xhr, 'progress', s.received, r.total, r.lc);
      }
    },
    onEnd() {
      if (s.req !== r) return;
      const loaded = s.received;
      if (r.last !== loaded) {
        r.last = loaded;
        fireP(s.xhr, 'progress', loaded, r.total, r.lc);
        if (s.req !== r) return;
      }
      finish(s, r);
      s.send = false;
      rsChange(s, DONE);
      // load and loadend fire even if an onreadystatechange handler aborted (jsdom, spec)
      fireP(s.xhr, 'load', loaded, r.total, r.lc);
      fireP(s.xhr, 'loadend', loaded, r.total, r.lc);
    },
    onError() {
      if (s.req !== r) return;
      finish(s, r);
      errorSteps(s, 'error');
    },
  };
}

// =================================================================================== responses

function header(s, lc) {
  for (const h of s.resHeaders) if (h[0] === lc) return h[1];
  return null;
}

function finalMime(s) {
  return s.overrideMime ?? header(s, 'content-type');
}

function finalCharset(s) {
  if (s.overrideCharset !== null) return s.overrideCharset;
  const cs = parseMime(header(s, 'content-type'))?.params.get('charset');
  return cs ? encodingName(cs) : null;
}

/** The body received so far as one Uint8Array (chunks are merged so repeated reads stay linear). */
function bytes(s) {
  if (s.bytesCache !== null) return s.bytesCache;
  const c = s.chunks;
  let b;
  if (c.length === 1) b = c[0];
  else {
    b = new Uint8Array(s.received);
    let o = 0;
    for (const x of c) {
      b.set(x, o);
      o += x.length;
    }
    s.chunks = [b];
  }
  s.bytesCache = b;
  return b;
}

function text(s) {
  if ((s.state !== LOADING && s.state !== DONE) || s.chunks === null) return '';
  if (s.textCache === null) s.textCache = loadNet().decode(bytes(s), finalCharset(s));
  return s.textCache;
}

/** responseXML: HTML documents only (XML types are null: no XML parser); null for responseType ''. */
function documentResponse(s) {
  if (s.state !== DONE || s.chunks === null || s.received === 0) return null;
  if (s.xmlCache !== null) return s.xmlCache;
  const m = parseMime(finalMime(s));
  if (m === null || m.essence !== 'text/html' || s.responseType === '') return null;
  const t = loadNet().decode(bytes(s), finalCharset(s));
  if (t === '') return null;
  const d = new rt.classes.DOMParser().parseFromString(t, 'text/html');
  d._url = s.responseURL;
  d._ct = 'text/html';
  s.xmlCache = d;
  return d;
}

// =================================================================================== classes

class XMLHttpRequestEventTarget extends EventTarget {
  constructor(t = undefined) {
    if (t !== rt.TOKEN) illegal();
    super();
    // `Object.keys(xhr)` is [] as in jsdom: the listener registry is not an enumerable own property
    Object.defineProperty(this, '_ev', { value: null, writable: true, enumerable: false, configurable: true });
  }
}

class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}

// No new.target check: msw 3 constructs through a Proxy (newTarget), msw 2 shadows members on the instance. Internal
// code never reads the public accessors or calls `this.send`: everything goes through `#x`.
class XMLHttpRequest extends XMLHttpRequestEventTarget {
  #x;

  constructor() {
    super(rt.TOKEN);
    this.#x = newState(this);
  }

  open(method, url, async = undefined, username = undefined, password = undefined) {
    const s = this.#x;
    const argc = arguments.length;
    need(argc, 2, 'open');
    method = byteString(method, 1, 'open');
    url = usv(url);
    // WebIDL boolean: an explicit undefined is false (synchronous), as in jsdom
    const isAsync = argc < 3 ? true : !!async;
    const user = username === undefined || username === null ? null : usv(username);
    const pass = password === undefined || password === null ? null : usv(password);
    if (destroyed(s.doc)) throw rt.domError(6);
    if (!TOKEN_RE.test(method)) throw rt.domError(4);
    const upper = method.toUpperCase();
    if (FORBIDDEN_METHODS.has(upper)) throw new rt.classes.DOMException('The operation is insecure.', 'SecurityError');
    cancel(s);
    if (NORMALIZED_METHODS.has(upper)) method = upper;
    s.sync = !isAsync;
    if (s.sync && (s.responseType !== '' || s.timeout !== 0)) throw invalidAccess();
    let u;
    try {
      u = new URL(url, forms.baseURL(s.doc));
    } catch {
      throw rt.domError(4);
    }
    s.auth = null;
    if (user || (pass && u.username === '')) {
      s.auth = { user: user ?? '', pass: pass ?? '' };
      u.username = '';
      u.password = '';
    }
    s.gen++;
    s.method = method;
    s.url = u;
    s.headers = [];
    s.send = false;
    s.uploadListener = false;
    setNetworkError(s);
    rsChange(s, OPENED);
  }

  setRequestHeader(name, value) {
    const s = this.#x;
    need(arguments.length, 2, 'setRequestHeader');
    name = byteString(name, 1, 'setRequestHeader');
    value = byteString(value, 2, 'setRequestHeader');
    if (s.state !== OPENED) throw rt.domError(6, 'setRequestHeader() can only be called in the OPENED state.');
    if (s.send) throw rt.domError(6, 'setRequestHeader() cannot be called after send()');
    value = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!TOKEN_RE.test(name)) throw rt.domError(4, 'Invalid header name');
    if (/[\0\r\n]/.test(value)) throw rt.domError(4, 'Invalid header value');
    if (forbiddenHeader(name, value)) return;
    const lc = name.toLowerCase();
    for (const h of s.headers) {
      if (h[0].toLowerCase() === lc) {
        h[1] += ', ' + value;
        return;
      }
    }
    s.headers.push([name, value]);
  }

  send(body = null) {
    const s = this.#x;
    // the union conversion runs first: a toString() it calls may re-enter
    let kind = null;
    let value = null;
    if (body !== null && body !== undefined) {
      value = body;
      if (body instanceof rt.classes.Document) kind = 'document';
      else if (body instanceof NodeBlob) kind = 'blob';
      else if (types.isSharedArrayBuffer(body) || (ArrayBuffer.isView(body) && types.isSharedArrayBuffer(body.buffer))) {
        throw new TypeError("Failed to execute 'send' on 'XMLHttpRequest': The provided ArrayBuffer value must not be shared.");
      } else if (types.isArrayBuffer(body)) kind = 'arraybuffer';
      else if (ArrayBuffer.isView(body)) kind = 'view';
      else if (body instanceof rt.classes.FormData) kind = 'formdata';
      else if (body instanceof URLSearchParams) kind = 'usp';
      else {
        kind = 'string';
        value = usv(body);
      }
    }
    if (destroyed(s.doc)) throw rt.domError(6);
    if (s.state !== OPENED || s.send) throw rt.domError(6);
    if (s.method === 'GET' || s.method === 'HEAD') {
      kind = null;
      value = null;
    }
    // DOM-typed bodies become plain data here: the transport stays DOM-free
    if (kind === 'document') value = { text: serializeDocument(value), html: value.contentType === 'text/html' };
    else if (kind === 'formdata') value = [...rt.classes.FormData.prototype.entries.call(value)];
    const headers = s.headers.map((h) => [h[0], h[1]]);
    const n = loadNet();
    const { body: payload, size } = n.prepareBody(kind, value, headers);
    s.uploadListener = s.upload._ev !== null;
    // jsdom tests the converted body, not its bytes: send(new ArrayBuffer(0)) still has upload events
    s.uploadComplete = kind === null || value === '';
    s.uploadTotal = size;
    if (s.sync) {
      s.state = DONE;
      setNetworkError(s);
      throw new rt.classes.DOMException('rsdom: synchronous XMLHttpRequest (open(method, url, false)) is not supported; use an asynchronous request', 'NetworkError');
    }
    const r = { s, handle: null, timer: null, clearTimer: null, start: Date.now(), total: 0, lc: false, last: undefined };
    s.req = r;
    s.send = true;
    fireP(s.xhr, 'loadstart');
    // re-read: an abort() in the loadstart handler completes the upload
    if (!s.uploadComplete && s.uploadListener) fireP(s.upload, 'loadstart', 0, size, size > 0);
    if (s.req !== r || s.state !== OPENED || !s.send) return;
    r.handle = n.start(FETCH, describe(s, headers, payload), makeSink(s, r));
    ACTIVE.add(r);
    hookContext(s.doc);
    // a timeout set in a loadstart listener has armed already
    if (s.timeout > 0 && r.timer === null) arm(s, r, s.timeout);
  }

  abort() {
    const s = this.#x;
    cancel(s);
    if ((s.state === OPENED && s.send) || s.state === HEADERS_RECEIVED || s.state === LOADING) errorSteps(s, 'abort');
    if (s.state === DONE) {
      s.state = UNSENT;
      setNetworkError(s);
    }
  }

  getResponseHeader(name) {
    const s = this.#x;
    need(arguments.length, 1, 'getResponseHeader');
    name = byteString(name, 1, 'getResponseHeader');
    if (s.state === UNSENT || s.state === OPENED) return null;
    return header(s, name.toLowerCase());
  }

  getAllResponseHeaders() {
    const s = this.#x;
    if (s.state === UNSENT || s.state === OPENED) return '';
    return s.resHeaders.map((h) => `${h[0]}: ${h[1]}`).join('\r\n');
  }

  overrideMimeType(mime) {
    const s = this.#x;
    need(arguments.length, 1, 'overrideMimeType');
    mime = String(mime);
    if (s.state === LOADING || s.state === DONE) throw rt.domError(6);
    s.overrideMime = 'application/octet-stream';
    const m = parseMime(mime);
    if (m !== null) {
      s.overrideMime = m.essence;
      // a later call without a charset keeps the earlier one (jsdom)
      const cs = m.params.get('charset');
      if (cs) s.overrideCharset = encodingName(cs);
    }
  }

  get readyState() {
    return this.#x.state;
  }

  get timeout() {
    return this.#x.timeout;
  }

  set timeout(v) {
    const s = this.#x;
    if (s.sync) throw invalidAccess();
    s.timeout = +v >>> 0;
    const r = s.req;
    if (r === null) return;
    if (r.timer !== null) {
      r.clearTimer(r.timer);
      r.timer = null;
    }
    // relative to the send() start, also when the timeout was 0 at send() (jsdom ignores that case)
    if (s.timeout > 0) arm(s, r, Math.max(0, s.timeout - (Date.now() - r.start)));
  }

  get withCredentials() {
    return this.#x.withCredentials;
  }

  set withCredentials(v) {
    const s = this.#x;
    if ((s.state !== UNSENT && s.state !== OPENED) || s.send) throw rt.domError(6);
    s.withCredentials = !!v;
  }

  get upload() {
    return this.#x.upload;
  }

  get responseURL() {
    return this.#x.responseURL;
  }

  get status() {
    return this.#x.status;
  }

  get statusText() {
    return this.#x.statusText;
  }

  get responseType() {
    return this.#x.responseType;
  }

  set responseType(v) {
    const s = this.#x;
    v = String(v);
    if (!RESPONSE_TYPES.has(v)) return;
    if (s.state === LOADING || s.state === DONE) throw rt.domError(6);
    if (s.state === OPENED && s.sync) throw invalidAccess();
    s.responseType = v;
    s.respCache = null;
  }

  get response() {
    const s = this.#x;
    const type = s.responseType;
    if (type === '' || type === 'text') return text(s);
    if (type === 'document') return documentResponse(s);
    if (s.respCache !== null) return s.respCache;
    if (s.chunks === null) return null;
    let res;
    if (type === 'arraybuffer') {
      const b = bytes(s);
      res = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    } else if (type === 'blob') {
      res = new NodeBlob([bytes(s)], { type: finalMime(s) ?? '' });
    } else {
      if (s.state !== DONE || s.received === 0) return null;
      res = loadNet().parseJSON(bytes(s));
    }
    s.respCache = res;
    return res;
  }

  get responseText() {
    const s = this.#x;
    if (s.responseType !== '' && s.responseType !== 'text') throw rt.domError(6);
    return text(s);
  }

  get responseXML() {
    const s = this.#x;
    if (s.responseType !== '' && s.responseType !== 'document') throw rt.domError(6);
    return documentResponse(s);
  }
}

for (const [k, v] of Object.entries({ UNSENT, OPENED, HEADERS_RECEIVED, LOADING, DONE })) {
  const d = { value: v, writable: false, enumerable: true, configurable: false };
  Object.defineProperty(XMLHttpRequest, k, d);
  Object.defineProperty(XMLHttpRequest.prototype, k, d);
}

// ===================================================================================== install

function install(_rt, _dom) {
  tag(XMLHttpRequestEventTarget);
  tag(XMLHttpRequestUpload);
  tag(XMLHttpRequest);
  events.defineHandlers(XMLHttpRequestEventTarget.prototype, PROGRESS_EVENTS);
  events.defineHandlers(XMLHttpRequest.prototype, ['readystatechange']);
  COOKIE = Object.getOwnPropertyDescriptor(_dom.Document.prototype, 'cookie');
  rt.onReset(() => abortRequests(null));
}

module.exports = { install, XMLHttpRequest, XMLHttpRequestUpload, XMLHttpRequestEventTarget, abortRequests };
