'use strict';
// XMLHttpRequest transport (DESIGN §21), loaded by lib/xhr.cjs on the first send(): request bodies, the network
// (one Node fetch per hop, redirects handled here), file: URLs from disk and response decoding. A port of jsdom's
// `performFetch` (refs/jsdom/lib/jsdom/living/xhr/xhr-utils.js) and of the parts of `JSDOMDispatcher`
// (refs/jsdom/lib/jsdom/browser/resources/jsdom-dispatcher.js) XHR goes through: jsdom's CORS model (names-only
// preflight, no Access-Control-Allow-Methods check, no preflight cache), redirect rules, the Basic-auth retry,
// default headers and per-hop cookie gating.
//
// DOM-free: node:* built-ins only, never runtime.cjs (a synchronous-XHR worker can run it unchanged). The caller
// hands DOM-typed bodies over as plain data and keeps cookies behind two closures (`desc.cookies`).
//
// Delivery uses promise and stream continuations only (no timers), started synchronously by `start()` inside
// send(): msw 3 attributes every hop to the XHR through AsyncLocalStorage, and fake timers cannot stall a response.

const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { MIMEType } = require('node:util');

const NodeBlob = globalThis.Blob;
const ENC = new TextEncoder();
const UTF16LE = new TextDecoder('utf-16le', { ignoreBOM: true });
const MAX_REDIRECTS = 20;
/** https://fetch.spec.whatwg.org/#no-cors-safelisted-request-header-name (jsdom checks names only) */
const SAFE_REQUEST = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);
/** https://fetch.spec.whatwg.org/#cors-safelisted-response-header-name */
const SAFE_RESPONSE = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

// ---------------------------------------------------------------------------------------------- bodies

const crlf = (s) => s.replace(/\r(?!\n)|(?<!\r)\n/g, '\r\n');
const escName = (s) => s.replace(/[\n\r"]/g, (c) => (c === '\n' ? '%0A' : c === '\r' ? '%0D' : '%22'));

/**
 * multipart/form-data of an entry list ([name, string | File] pairs), as
 * refs/jsdom/lib/jsdom/living/xhr/multipart-form-data.js: a Blob of strings and the original Files (its size is
 * known without reading them).
 */
function multipart(entries) {
  let boundary = '-'.repeat(26);
  for (let i = 0; i < 24; i++) boundary += Math.floor(Math.random() * 10);
  const parts = [];
  for (const [name, value] of entries) {
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${escName(crlf(name))}"`;
    if (typeof value === 'string') parts.push(`${head}\r\n\r\n${crlf(value)}\r\n`);
    else parts.push(`${head}; filename="${escName(value.name)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`, value, '\r\n');
  }
  parts.push(`--${boundary}--\r\n`);
  return { body: new NodeBlob(parts), type: `multipart/form-data; boundary=${boundary}` };
}

function parseMime(s) {
  try {
    return new MIMEType(s);
  } catch {
    return null;
  }
}

/**
 * Fetch "extract a body" plus the Content-Type rules of XHR send() (steps 4.2-4.4). `kind` / `value` come from
 * xhr.cjs's union conversion: string | usp (URLSearchParams) | blob | arraybuffer | view | formdata (entry list) |
 * document ({ text, html }). `headers` (the author's [name, value] pairs, a copy) is updated in place. Returns the
 * body fetch sends (null | Uint8Array | Blob; empty bodies are null) and its size (upload progress).
 */
function prepareBody(kind, value, headers) {
  if (kind === null) return { body: null, size: 0 };
  let body;
  let type = null;
  switch (kind) {
    case 'string':
      body = ENC.encode(value);
      type = 'text/plain;charset=UTF-8';
      break;
    case 'usp':
      body = ENC.encode(String(value));
      type = 'application/x-www-form-urlencoded;charset=UTF-8';
      break;
    case 'blob':
      body = value;
      if (value.type !== '') type = value.type;
      break;
    case 'arraybuffer':
      body = new Uint8Array(value.slice(0));
      break;
    case 'view':
      // the exact bytes of any view (jsdom converts element by element: DataView and Uint16Array lose data)
      body = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      break;
    case 'formdata':
      ({ body, type } = multipart(value));
      break;
    default:
      body = ENC.encode(value.text);
      type = value.html ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8';
  }
  const ct = headers.find((h) => h[0].toLowerCase() === 'content-type');
  if (ct === undefined) {
    if (type !== null) headers.push(['Content-Type', type]);
  } else if (kind === 'string' || kind === 'document') {
    // an author charset other than UTF-8 is rewritten: the body is UTF-8
    const m = parseMime(ct[1]);
    const cs = m === null ? null : m.params.get('charset');
    if (cs && cs.toLowerCase() !== 'utf-8') {
      m.params.set('charset', 'UTF-8');
      ct[1] = String(m);
    }
  }
  const size = body instanceof NodeBlob ? body.size : body.byteLength;
  return { body: size === 0 ? null : body, size };
}

// ------------------------------------------------------------------------------------------- transport

const has = (h, lc) => h.some((x) => x[0].toLowerCase() === lc);
const del = (h, lc) => {
  for (let i = h.length - 1; i >= 0; i--) if (h[i][0].toLowerCase() === lc) h.splice(i, 1);
};
const set = (h, name, value) => {
  del(h, name.toLowerCase());
  h.push([name, value]);
};

/** jsdom's default request headers, each unless already present. */
function defaults(h, userAgent) {
  if (!has(h, 'user-agent')) h.push(['User-Agent', userAgent]);
  if (!has(h, 'accept-language')) h.push(['Accept-Language', 'en']);
  if (!has(h, 'accept')) h.push(['Accept', '*/*']);
  if (!has(h, 'accept-encoding')) h.push(['Accept-Encoding', 'gzip, deflate']);
}

/** The URL fetch is given: no fragment, no userinfo (fetch refuses URLs with credentials; jsdom never sends them). */
function wire(u) {
  const w = new URL(u.href);
  w.hash = '';
  w.username = '';
  w.password = '';
  return w.href;
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // already errored or aborted
  }
}

/**
 * Starts a request. `desc`: { url, method, headers, body, origin, referrer, userAgent, withCredentials, auth,
 * uploadListener, cookies: { header(href), store(href, setCookieLines) } }. `sink`: onResponse({ status,
 * statusText, url, headers, total, lc }), onData(Uint8Array), then exactly one of onEnd() / onError(message).
 * Nothing is delivered before the first await (never inside send()) and nothing after `abort()`.
 */
function start(fetchImpl, desc, sink) {
  const ac = new AbortController();
  const t = { done: false, file: null };
  run(fetchImpl, desc, sink, ac.signal, t).then(
    () => {
      if (t.done) return;
      t.done = true;
      sink.onEnd();
    },
    (e) => {
      if (t.done) return;
      t.done = true;
      ac.abort();
      t.file?.destroy();
      sink.onError(e instanceof Error ? e.message : String(e));
    },
  );
  return {
    abort() {
      t.done = true;
      ac.abort();
      t.file?.destroy();
    },
  };
}

async function run(fetchImpl, d, sink, signal, t) {
  const url = new URL(d.url);
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return httpFetch(fetchImpl, d, url, sink, signal, t);
    case 'data:':
    case 'blob:': {
      // no CORS, cookies or redirects: undici decodes data: URLs and serves blob: URLs from Node's registry
      const res = await fetchImpl(wire(url), { method: d.method, headers: d.headers, body: d.body, signal });
      return deliver(res, url, d.origin, sink, t);
    }
    case 'file:': {
      await null;
      if (t.done) return undefined;
      // refs/jsdom/lib/jsdom/browser/resources/jsdom-dispatcher.js #dispatchFileURL: 200 'OK' with no headers before
      // the file is opened, so a missing file is readyState 2 then an error
      sink.onResponse({ status: 200, statusText: 'OK', url: wire(url), headers: [], total: 0, lc: false });
      if (t.done) return undefined;
      const stream = fs.createReadStream(fileURLToPath(url));
      t.file = stream;
      return new Promise((resolve, reject) => {
        stream.on('data', (c) => {
          if (!t.done) sink.onData(c);
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    }
    default:
      throw new TypeError(`oxidom: XMLHttpRequest cannot load ${url.protocol} URLs`);
  }
}

/** Access-Control-Allow-Origin / -Credentials of a response (jsdom's checks, messages included). */
function checkCors(res, origin, withCredentials) {
  const acao = res.headers.get('access-control-allow-origin');
  if (acao !== '*' && acao !== origin) throw new Error('Cross origin ' + origin + ' forbidden');
  if (withCredentials && res.headers.get('access-control-allow-credentials') !== 'true') throw new Error('Credentials forbidden');
}

/** jsdom `#dispatchHTTP` over `redirect: 'manual'` fetches: preflight, then up to 20 redirects. */
async function httpFetch(fetchImpl, d, url, sink, signal, t) {
  const { origin, withCredentials } = d;
  const cross = origin !== url.origin;
  // xhr-utils.js performFetch: author headers, then Referer and (cross-origin) Origin
  const headers = d.headers.slice();
  if (d.referrer !== null) set(headers, 'Referer', d.referrer);
  if (cross) set(headers, 'Origin', origin);
  let cur = url;
  let method = d.method;
  let body = d.body;
  let auth = d.auth;
  let effectiveOrigin = origin;
  let challenged = false;

  const unsafe = [];
  for (const [name] of d.headers) if (!SAFE_REQUEST.has(name.toLowerCase())) unsafe.push(name);
  if (cross && (!SIMPLE_METHODS.has(method.toUpperCase()) || unsafe.length > 0 || d.uploadListener)) {
    const ph = [['Origin', origin], ['Access-Control-Request-Method', method]];
    if (unsafe.length > 0) ph.push(['Access-Control-Request-Headers', unsafe.join(', ')]);
    defaults(ph, d.userAgent);
    const res = await fetchImpl(wire(cur), { method: 'OPTIONS', headers: ph, redirect: 'manual', signal });
    await discard(res);
    if (res.status < 200 || res.status > 299) throw new Error('Response for preflight has invalid HTTP status code ' + res.status);
    checkCors(res, origin, withCredentials);
    const acah = new Set((res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/,\s*/));
    if (!acah.has('*')) {
      for (const name of unsafe) if (!acah.has(name.toLowerCase())) throw new Error('Header ' + name + ' forbidden');
    }
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const hopOrigin = cur.origin;
    const h = headers.slice();
    if (challenged && auth !== null) h.push(['Authorization', 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')]);
    defaults(h, d.userAgent);
    // jsdom #doSingleRequest: cookies for same-origin hops (against the effective origin) or with credentials
    const cookies = effectiveOrigin === hopOrigin || withCredentials;
    if (cookies) {
      const c = d.cookies.header(cur.href);
      if (c !== '') h.push(['Cookie', c]);
    }
    const res = await fetchImpl(wire(cur), { method, headers: h, body, redirect: 'manual', signal });
    if (cookies) d.cookies.store(cur.href, res.headers.getSetCookie());

    if (res.status === 401 && auth !== null && !challenged && /^Basic /i.test(res.headers.get('www-authenticate') ?? '')) {
      challenged = true;
      await discard(res);
      continue;
    }

    // an empty Location is no Location (jsdom tests truthiness): the 3xx is the final response
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await discard(res);
      let target;
      try {
        target = new URL(location, cur);
      } catch {
        throw new TypeError('Invalid redirect URL');
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Cannot redirect to non-HTTP(S) URL');
      if (((res.status === 301 || res.status === 302) && method === 'POST') || (res.status === 303 && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = null;
        for (const n of ['content-encoding', 'content-language', 'content-location', 'content-type']) del(headers, n);
      }
      const targetOrigin = target.origin;
      if (hopOrigin !== targetOrigin) {
        del(headers, 'authorization');
        auth = null;
      }
      const targetCross = origin !== targetOrigin;
      if (cross || targetCross) {
        if (origin !== hopOrigin) {
          checkCors(res, origin, withCredentials);
          if (target.username !== '' || target.password !== '') throw new Error('Userinfo forbidden in cors redirect');
          if (hopOrigin !== targetOrigin) effectiveOrigin = 'null';
        }
        if (targetCross || effectiveOrigin === 'null') set(headers, 'Origin', effectiveOrigin);
      }
      cur = target;
      continue;
    }

    if (origin !== hopOrigin || effectiveOrigin === 'null') {
      try {
        checkCors(res, effectiveOrigin, withCredentials);
      } catch (e) {
        await discard(res);
        throw e;
      }
    }
    return deliver(res, cur, origin, sink, t);
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

/** The final response: filtered headers, then the body chunk by chunk. */
async function deliver(res, url, origin, sink, t) {
  let headers = [];
  // undici's header list: lowercased, sorted, values combined (set-cookie is never exposed)
  for (const [k, v] of res.headers) if (k !== 'set-cookie' && k !== 'set-cookie2') headers.push([k, v]);
  if (origin !== url.origin && url.protocol !== 'data:') {
    const aceh = res.headers.get('access-control-expose-headers');
    const exposed = new Set(aceh === null ? [] : aceh.trim().toLowerCase().split(/,[ \t]*/));
    if (!exposed.has('*')) headers = headers.filter(([k]) => SAFE_RESPONSE.has(k) || exposed.has(k));
  }
  // fetch decodes gzip/deflate/br but keeps Content-Length: progress counts decoded bytes, so it is only
  // computable without Content-Encoding (jsdom's rule)
  const ce = res.headers.get('content-encoding');
  const cl = parseInt(res.headers.get('content-length') ?? '0', 10) || 0;
  if (t.done) return;
  sink.onResponse({ status: res.status, statusText: res.statusText, url: wire(url), headers, total: ce === null ? cl : 0, lc: ce === null && cl > 0 });
  if (res.body === null) return;
  for await (const c of res.body) {
    if (t.done) return;
    sink.onData(c);
  }
}

// -------------------------------------------------------------------------------------------- decoding

/** windows-1252 0x80-0x9F (Node 22's TextDecoder decodes them as latin1). */
const W1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * Text of a response: a BOM wins (and is dropped), else the encoding name (xhr.cjs `encodingName`), else UTF-8
 * (unknown labels too).
 */
function decode(b, label) {
  let enc = label ?? 'utf-8';
  let skip = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    enc = 'utf-8';
    skip = 3;
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    enc = 'utf-16be';
    skip = 2;
  } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    enc = 'utf-16le';
    skip = 2;
  }
  // the two encodings TextDecoder refuses: replacement (any input is one U+FFFD) and x-user-defined
  if (enc === 'replacement') return b.length === 0 ? '' : '�';
  if (enc === 'x-user-defined') return mapBytes(b, (c) => (c < 0x80 ? c : 0xf700 + c));
  let d;
  try {
    d = new TextDecoder(enc, { ignoreBOM: true });
  } catch {
    d = new TextDecoder('utf-8', { ignoreBOM: true });
  }
  // Node's windows-1252 decoder is ISO-8859-1 (0x80-0x9F give C1 controls), so map the bytes here
  if (d.encoding === 'windows-1252') return mapBytes(b, (c) => (c >= 0x80 && c < 0xa0 ? W1252[c - 0x80] : c));
  return d.decode(skip === 0 ? b : b.subarray(skip));
}

/** One UTF-16 code unit per byte, decoded in one call (a string built per byte is ~30x slower on large bodies). */
function mapBytes(b, unit) {
  const u = new Uint16Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = unit(b[i]);
  return UTF16LE.decode(u);
}

/** XHR "JSON response": UTF-8 (BOM dropped), null on a parse error. */
function parseJSON(b) {
  try {
    return JSON.parse(new TextDecoder().decode(b));
  } catch {
    return null;
  }
}

/** The parts of a Set-Cookie line the cookie adapter needs (null for an empty one). */
function parseSetCookie(line) {
  const semi = line.indexOf(';');
  const pair = semi < 0 ? line : line.slice(0, semi);
  const eq = pair.indexOf('=');
  const name = (eq < 0 ? '' : pair.slice(0, eq)).trim();
  const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
  if (name === '' && value === '') return null;
  const attrs = semi < 0 ? '' : line.slice(semi).toLowerCase();
  const maxAge = /;\s*max-age\s*=\s*(-?\d+)/.exec(attrs);
  const expires = /;\s*expires\s*=\s*([^;]*)/.exec(attrs);
  return {
    name,
    value,
    httpOnly: /;\s*httponly\s*(?:;|$)/.test(attrs),
    expired: maxAge !== null ? Number(maxAge[1]) <= 0 : expires !== null && Date.parse(expires[1]) <= Date.now(),
  };
}

module.exports = { prepareBody, start, decode, parseJSON, parseSetCookie };
