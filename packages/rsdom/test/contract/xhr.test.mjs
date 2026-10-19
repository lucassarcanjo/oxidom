// XMLHttpRequest parity (ROADMAP Stage 1 `xhr`): the interface surface, then real requests against a local
// node:http server (test/contract/xhr-server.cjs). jsdom 30 is the oracle: event traces are literals written down
// from jsdom and checked on every DOM. Notation: a number is a readystatechange with that readyState,
// `type(loaded,total,lengthComputable)` a ProgressEvent, `upload.` an event on xhr.upload.
// happy-dom's XHR is structurally different (readyState 3 before 2, no upload events, no timeout, ProgressEvent
// fields undefined on load/loadend, no CORS enforcement): those assertions are pinned to jsdom.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');
const { startServer, header } = require('./xhr-server.cjs');

const PROGRESS = ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];
// captured at load: real macrotasks even if a test installs fake timers
const later = globalThis.setTimeout;
const tick = () => new Promise((r) => later(r, 0));
const sleep = (ms) => new Promise((r) => later(r, ms));

let srv;
let base;
beforeAll(async () => {
  srv = await startServer();
  base = srv.base;
});
afterAll(() => srv.close());

/**
 * Records every readystatechange and progress event of `x` (and of `x.upload` with `upload: true`: an upload
 * listener changes the request). `done` resolves two macrotasks after the first loadend, so stray events after it
 * are caught. `on(entry, x)` runs after each record (to abort / re-open at a given point).
 */
function trace(x, { upload = false, on = null } = {}) {
  const ev = [];
  let resolve;
  const done = new Promise((r) => (resolve = r));
  let ended = false;
  const push = (v) => {
    ev.push(v);
    on?.(v, x);
  };
  x.addEventListener('readystatechange', () => push(x.readyState));
  for (const t of PROGRESS) {
    x.addEventListener(t, (e) => {
      push(`${t}(${e.loaded},${e.total},${e.lengthComputable})`);
      if (t === 'loadend' && !ended) {
        ended = true;
        tick().then(tick).then(() => resolve(ev));
      }
    });
    if (upload) x.upload.addEventListener(t, (e) => push(`upload.${t}(${e.loaded},${e.total},${e.lengthComputable})`));
  }
  return { ev, done };
}

/** One request: open, headers, `setup(x)`, send; resolves after loadend with the xhr and its trace. */
async function request(w, method, url, { body, headers = [], setup, upload, on, user, password } = {}) {
  const x = new w.XMLHttpRequest();
  const t = trace(x, { upload, on });
  if (user !== undefined) x.open(method, url, true, user, password);
  else x.open(method, url);
  for (const [k, v] of headers) x.setRequestHeader(k, v);
  setup?.(x);
  x.send(body);
  await t.done;
  return { x, ev: t.ev };
}

/** `/echo` as the server saw it: { method, url, headers (lowercased -> value), names (raw), body (Buffer) }. */
async function echo(w, method, url = `${base}/echo`, opts = {}) {
  const { x } = await request(w, method, url, opts);
  const j = JSON.parse(x.responseText);
  const rec = { rawHeaders: j.rawHeaders };
  return {
    method: j.method,
    url: j.url,
    h: (name) => header(rec, name),
    names: j.rawHeaders.filter((_, i) => i % 2 === 0),
    body: Buffer.from(j.body, 'base64'),
  };
}

const when = (target, type) => new Promise((r) => target.addEventListener(type, r, { once: true }));

describe.each(DOMS)('XMLHttpRequest surface [%s]', (kind) => {
  const HD = kind === 'happy-dom';

  it('the three interfaces are window members with WebIDL descriptors', () => {
    const w = makeWindow(kind);
    for (const k of ['XMLHttpRequest', 'XMLHttpRequestUpload', 'XMLHttpRequestEventTarget']) {
      const d = Object.getOwnPropertyDescriptor(w, k) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w), k);
      expect(typeof w[k], k).toBe('function');
      if (!HD) expect({ w: d.writable, e: d.enumerable, c: d.configurable }, k).toEqual({ w: true, e: false, c: true }); // PINNED to jsdom: happy-dom defines them on Window.prototype
    }
  });

  it('prototype chain, constructors and constants', () => {
    const w = makeWindow(kind);
    const X = w.XMLHttpRequest;
    if (!HD) {
      // PINNED to jsdom: happy-dom's window classes are per-window subclasses of shared base classes
      expect(Object.getPrototypeOf(X.prototype)).toBe(w.XMLHttpRequestEventTarget.prototype);
      expect(Object.getPrototypeOf(w.XMLHttpRequestUpload.prototype)).toBe(w.XMLHttpRequestEventTarget.prototype);
      expect(Object.getPrototypeOf(w.XMLHttpRequestEventTarget.prototype)).toBe(w.EventTarget.prototype);
    }
    expect(X.length).toBe(0);
    expect(errName(() => X())).toBe('TypeError');
    if (!HD) expect(errName(() => new w.XMLHttpRequestUpload())).toBe('TypeError'); // PINNED to jsdom: happy-dom constructs it
    if (!HD) expect(errName(() => new w.XMLHttpRequestEventTarget())).toBe('TypeError'); // PINNED to jsdom: happy-dom constructs it
    const names = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
    names.forEach((k, i) => {
      expect(X[k]).toBe(i);
      if (HD) return; // PINNED to jsdom: happy-dom has writable static fields only (no prototype constants)
      expect(X.prototype[k]).toBe(i);
      const d = Object.getOwnPropertyDescriptor(X, k);
      expect({ w: d.writable, e: d.enumerable, c: d.configurable }, k).toEqual({ w: false, e: true, c: false });
    });
  });

  it('a new request: brand, own keys, initial state, handlers, [SameObject] upload', () => {
    const w = makeWindow(kind);
    const x = new w.XMLHttpRequest();
    if (!HD) expect(Object.prototype.toString.call(x)).toBe('[object XMLHttpRequest]'); // PINNED to jsdom: happy-dom has no toStringTag
    if (!HD) expect(x instanceof w.EventTarget).toBe(true); // PINNED to jsdom: happy-dom's EventTarget is not the window's
    if (!HD) expect(Object.keys(x)).toEqual([]); // PINNED to jsdom: happy-dom has own fields
    expect(x.readyState).toBe(0);
    expect(x.status).toBe(0);
    expect(x.statusText).toBe('');
    expect(x.responseURL).toBe('');
    expect(x.responseType).toBe('');
    expect(x.response).toBe('');
    expect(x.responseText).toBe('');
    expect(x.responseXML).toBe(null);
    if (!HD) expect(x.timeout).toBe(0); // PINNED to jsdom: happy-dom starts with undefined
    expect(x.withCredentials).toBe(false);
    expect(x.getAllResponseHeaders()).toBe('');
    expect(x.getResponseHeader('content-type')).toBe(null);
    expect('onloadend' in x).toBe(true); // axios picks its loadend path with this check
    if (!HD) expect('onreadystatechange' in x).toBe(true); // PINNED to jsdom: happy-dom has no such accessor
    expect('onprogress' in x.upload).toBe(true);
    if (!HD) {
      // PINNED to jsdom: happy-dom keeps non-function handler values
      x.onload = 5;
      expect(x.onload).toBe(null);
    }
    const f = () => {};
    x.onload = f;
    expect(x.onload).toBe(f);
    expect(x.upload).toBe(x.upload);
    expect(x.upload instanceof w.XMLHttpRequestUpload).toBe(true);
    if (!HD) expect(errName(() => Object.getOwnPropertyDescriptor(w.XMLHttpRequest.prototype, 'status').get.call({}))).toBe('TypeError'); // PINNED to jsdom: happy-dom has no brand checks
    const loaded = Object.getOwnPropertyDescriptor(w.ProgressEvent.prototype, 'loaded');
    if (!HD) expect(errName(() => loaded.get.call({}))).toBe('TypeError'); // PINNED to jsdom: happy-dom has no brand checks
  });

  it('state rules before any request', () => {
    const w = makeWindow(kind);
    const x = new w.XMLHttpRequest();
    x.responseType = 'stream'; // not a valid enum value: ignored
    if (!HD) expect(x.responseType).toBe(''); // PINNED to jsdom: happy-dom stores any string
    x.responseType = 'json';
    expect(x.responseType).toBe('json');
    if (!HD) expect(errName(() => x.responseText)).toBe('InvalidStateError'); // PINNED to jsdom: happy-dom returns ''
    if (!HD) {
      // PINNED to jsdom: happy-dom keeps the raw values (no WebIDL conversions)
      x.withCredentials = 1;
      expect(x.withCredentials).toBe(true);
      x.timeout = 1.9;
      expect(x.timeout).toBe(1);
      x.timeout = -1;
      expect(x.timeout).toBe(4294967295);
    }
    expect(errName(() => x.send())).toBe('InvalidStateError');
    expect(errName(() => x.setRequestHeader('a', 'b'))).toBe('InvalidStateError');
    if (!HD) x.abort(); // PINNED to jsdom: happy-dom's abort() throws before open()
    expect(x.readyState).toBe(0);
  });
});

describe.each(DOMS)('XMLHttpRequest open() and setRequestHeader() [%s]', (kind) => {
  const HD = kind === 'happy-dom';

  it('open(): method token, forbidden methods, URL parsing, readyState 1 fired once', () => {
    const w = makeWindow(kind);
    const x = new w.XMLHttpRequest();
    const ev = [];
    x.onreadystatechange = () => ev.push(x.readyState);
    if (!HD) {
      // PINNED to jsdom: happy-dom does not validate methods
      for (const m of ['', 'G T', 'GET\n', 'é']) expect(errName(() => x.open(m, '/x')), JSON.stringify(m)).toBe('SyntaxError');
      expect(errName(() => x.open('trace', '/x'))).toBe('SecurityError');
      expect(errName(() => x.open('CONNECT', '/x'))).toBe('SecurityError');
      expect(errName(() => x.open('GET', 'http://['))).toBe('SyntaxError');
      expect(errName(() => x.open('GET'))).toBe('TypeError');
      expect(errName(() => x.open('GĀT', '/x'))).toBe('TypeError');
    }
    expect(x.readyState).toBe(0);
    x.open('GET', '/x');
    expect(x.readyState).toBe(1);
    x.open('POST', '/y');
    if (!HD) expect(ev).toEqual([1]); // PINNED to jsdom: happy-dom fires no readystatechange on open()
  });

  it('open() with timeout or responseType set: synchronous requests are refused', () => {
    const w = makeWindow(kind);
    const x = new w.XMLHttpRequest();
    x.timeout = 5;
    if (!HD) expect(errName(() => x.open('GET', '/x', false))).toBe('InvalidAccessError'); // PINNED to jsdom: happy-dom allows it
    if (!HD) expect(errName(() => x.open('GET', '/x', undefined))).toBe('InvalidAccessError'); // PINNED to jsdom: WebIDL boolean, undefined is false
    const y = new w.XMLHttpRequest();
    y.responseType = 'json';
    if (!HD) expect(errName(() => y.open('GET', '/x', false))).toBe('InvalidAccessError'); // PINNED to jsdom: happy-dom allows it
    const z = new w.XMLHttpRequest();
    z.open('GET', '/x', false);
    if (!HD) expect(errName(() => { z.timeout = 1; })).toBe('InvalidAccessError'); // PINNED to jsdom: happy-dom allows it
    if (!HD) expect(errName(() => { z.responseType = 'text'; })).toBe('InvalidAccessError'); // PINNED to jsdom: happy-dom allows it
  });

  it('setRequestHeader(): state, ByteString, token and value checks', async () => {
    const w = makeWindow(kind);
    const x = new w.XMLHttpRequest();
    expect(errName(() => x.setRequestHeader('a', 'b'))).toBe('InvalidStateError');
    x.open('GET', `${base}/echo`);
    if (!HD) {
      // PINNED to jsdom: happy-dom does not validate header names / values
      expect(errName(() => x.setRequestHeader('a', 'Ā'))).toBe('TypeError');
      expect(errName(() => x.setRequestHeader('a b', 'c'))).toBe('SyntaxError');
      expect(errName(() => x.setRequestHeader('a', 'x\r\ny'))).toBe('SyntaxError');
      expect(errName(() => x.setRequestHeader('a'))).toBe('TypeError');
    }
    x.setRequestHeader('X-Ok', ' trimmed\t');
    let inLoadstart = null;
    x.onloadstart = () => {
      inLoadstart = errName(() => x.setRequestHeader('a', 'b'));
    };
    const end = when(x, 'loadend');
    x.send();
    if (!HD) expect(inLoadstart).toBe('InvalidStateError'); // PINNED to jsdom: happy-dom fires loadstart later
    expect(errName(() => x.setRequestHeader('a', 'b'))).toBe('InvalidStateError');
    await end;
  });

  it('forbidden request headers never reach the wire; author headers combine, first casing kept', async () => {
    const w = makeWindow(kind, { url: `${base}/dir/page.html` });
    const r = await echo(w, 'GET', `${base}/echo`, {
      headers: [
        ['Cookie', 'a=1'], ['Host', 'evil'], ['Content-Length', '9'], ['Connection', 'close'], ['Proxy-X', '1'],
        ['Sec-X', '1'], ['Referer', 'http://evil/'], ['X-HTTP-Method-Override', 'get, TRACE'],
        ['THIS-IS-A-TEST', '1'], ['this-is-a-test', '2'], ['X-Empty', ''], ['x-empty', ''],
      ],
    });
    if (!HD) {
      // PINNED to jsdom: happy-dom sends some forbidden headers, lowercases names and keeps only the last value
      expect(r.h('cookie')).toBe(null);
      expect(r.h('content-length')).toBe(null);
      expect(r.h('proxy-x')).toBe(null);
      expect(r.h('sec-x')).toBe(null);
      expect(r.h('x-http-method-override')).toBe(null);
      expect(r.h('referer')).toBe(`${base}/dir/page.html`);
      expect(r.h('connection')).toBe('keep-alive');
      expect(r.names).toContain('THIS-IS-A-TEST');
      expect(r.h('this-is-a-test')).toBe('1, 2');
      expect(r.h('x-empty')).toBe(','); // ', ' combined; Node's parser trims the trailing space
    }
    expect(r.h('host')).toBe(base.slice('http://'.length));
  });

  it('methods: the six standard ones are uppercased, others go out as written', async () => {
    const w = makeWindow(kind, { url: `${base}/dir/page.html` });
    expect((await echo(w, 'get')).method).toBe('GET');
    expect((await echo(w, 'delete')).method).toBe('DELETE');
    // a method Node's HTTP parser knows (it answers unknown ones with 400)
    expect((await echo(w, 'PROPFIND')).method).toBe('PROPFIND');
    // Node's HTTP parser rejects a lowercase `patch` with 400 (jsdom sends it as written too)
    if (!HD) expect((await request(w, 'patch', `${base}/echo`)).x.status).toBe(400); // PINNED to jsdom: happy-dom uppercases it
  });

  it('relative URLs resolve against the document base URL', async () => {
    const w = makeWindow(kind, { url: `${base}/page.html` });
    expect((await echo(w, 'GET', '/echo?q=1')).url).toBe('/echo?q=1');
    const b = w.document.createElement('base');
    b.setAttribute('href', '/dir/');
    w.document.head.append(b);
    const { x } = await request(w, 'GET', 'echo');
    if (!HD) expect(JSON.parse(x.responseText).url).toBe('/dir/echo'); // PINNED to jsdom: happy-dom ignores <base>
  });
});

describe.each(DOMS)('XMLHttpRequest event traces [%s]', (kind) => {
  // PINNED to jsdom for the whole block: happy-dom fires readystatechange 3 before 2, no upload events and
  // ProgressEvents without loaded/total on loadstart/load/loadend, and has no timeout.
  const skip = kind === 'happy-dom';
  const cross = () => makeWindow(kind);

  it('T1/T2: chunked body, without and with Content-Length', async () => {
    if (skip) return;
    expect((await request(cross(), 'GET', `${base}/chunks`)).ev).toEqual([
      1, 'loadstart(0,0,false)', 2, 3, 'progress(5,0,false)', 3, 'progress(10,0,false)', 3, 'progress(15,0,false)', 4,
      'load(15,0,false)', 'loadend(15,0,false)',
    ]);
    expect((await request(cross(), 'GET', `${base}/chunks?len=1`)).ev).toEqual([
      1, 'loadstart(0,0,false)', 2, 3, 'progress(5,15,true)', 3, 'progress(10,15,true)', 3, 'progress(15,15,true)', 4,
      'load(15,15,true)', 'loadend(15,15,true)',
    ]);
  });

  it('T3/T4: no body (204, HEAD with Content-Length)', async () => {
    if (skip) return;
    const a = await request(cross(), 'GET', `${base}/204`);
    expect(a.ev).toEqual([1, 'loadstart(0,0,false)', 2, 'progress(0,0,false)', 4, 'load(0,0,false)', 'loadend(0,0,false)']);
    expect([a.x.status, a.x.statusText, a.x.response]).toEqual([204, 'No Content', '']);
    expect((await request(cross(), 'HEAD', `${base}/head`)).ev).toEqual([
      1, 'loadstart(0,0,false)', 2, 'progress(0,5,true)', 4, 'load(0,5,true)', 'loadend(0,5,true)',
    ]);
  });

  it('T5/T6: upload events (string body; empty ArrayBuffer still fires upload.loadstart)', async () => {
    if (skip) return;
    const a = await request(cross(), 'POST', `${base}/head`, { body: 'hello world!', upload: true });
    expect(a.ev).toEqual([
      1, 'loadstart(0,0,false)', 'upload.loadstart(0,12,true)', 'upload.progress(12,12,true)', 'upload.load(12,12,true)',
      'upload.loadend(12,12,true)', 2, 3, 'progress(5,5,true)', 4, 'load(5,5,true)', 'loadend(5,5,true)',
    ]);
    const b = await request(cross(), 'POST', `${base}/head`, { body: new ArrayBuffer(0), upload: true });
    expect(b.ev).toEqual([
      1, 'loadstart(0,0,false)', 'upload.loadstart(0,0,false)', 'upload.progress(0,0,false)', 'upload.load(0,0,false)',
      'upload.loadend(0,0,false)', 2, 3, 'progress(5,5,true)', 4, 'load(5,5,true)', 'loadend(5,5,true)',
    ]);
    // no upload listener, GET: no upload events, no preflight
    expect((await request(cross(), 'POST', `${base}/head`, { body: 'abc' })).ev).toEqual([
      1, 'loadstart(0,0,false)', 2, 3, 'progress(5,5,true)', 4, 'load(5,5,true)', 'loadend(5,5,true)',
    ]);
  });

  it('T7/T8: network errors', async () => {
    if (skip) return;
    // a closed port on this host
    const net = require('node:net');
    const port = await new Promise((r) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    const a = await request(cross(), 'GET', `http://127.0.0.1:${port}/`);
    expect(a.ev).toEqual([1, 'loadstart(0,0,false)', 4, 'error(0,0,false)', 'loadend(0,0,false)']);
    expect([a.x.status, a.x.readyState, a.x.responseText]).toEqual([0, 4, '']);
    const b = await request(cross(), 'POST', `http://127.0.0.1:${port}/`, { body: 'abc', upload: true });
    expect(b.ev).toEqual([
      1, 'loadstart(0,0,false)', 'upload.loadstart(0,3,true)', 4, 'upload.error(0,0,false)', 'upload.loadend(0,0,false)',
      'error(0,0,false)', 'loadend(0,0,false)',
    ]);
  });

  it('T9/T11: abort right after send() and inside loadstart', async () => {
    if (skip) return;
    const x = new (cross().XMLHttpRequest)();
    const t = trace(x, { upload: true });
    x.open('POST', `${base}/slow`);
    x.send('abc');
    x.abort();
    await t.done;
    expect(t.ev).toEqual([
      1, 'loadstart(0,0,false)', 'upload.loadstart(0,3,true)', 4, 'upload.abort(0,0,false)', 'upload.loadend(0,0,false)',
      'abort(0,0,false)', 'loadend(0,0,false)',
    ]);
    expect(x.readyState).toBe(0);
    const before = srv.hits('/never').length;
    const b = await request(cross(), 'POST', `${base}/never`, {
      body: 'abc',
      upload: true,
      on: (v, y) => v === 'loadstart(0,0,false)' && y.abort(),
    });
    expect(b.ev).toEqual([
      1, 'loadstart(0,0,false)', 4, 'upload.abort(0,0,false)', 'upload.loadend(0,0,false)', 'abort(0,0,false)', 'loadend(0,0,false)',
    ]);
    await sleep(50);
    expect(srv.hits('/never').length).toBe(before);
  });

  it('T10/T14: abort in HEADERS_RECEIVED and after DONE', async () => {
    if (skip) return;
    const a = await request(cross(), 'GET', `${base}/chunks`, { on: (v, y) => v === 2 && y.abort() });
    expect(a.ev).toEqual([1, 'loadstart(0,0,false)', 2, 4, 'abort(0,0,false)', 'loadend(0,0,false)']);
    expect([a.x.readyState, a.x.status, a.x.getAllResponseHeaders(), a.x.responseText]).toEqual([0, 0, '', '']);
    const b = await request(cross(), 'GET', `${base}/head`);
    const ev = [];
    b.x.onreadystatechange = () => ev.push(b.x.readyState);
    b.x.onabort = () => ev.push('abort');
    b.x.abort();
    expect(ev).toEqual([]);
    expect([b.x.readyState, b.x.status, b.x.statusText, b.x.responseText]).toEqual([0, 0, '', '']);
  });

  it('T12/T13: timeout (jsdom: progress before timeout, readyState 0 afterwards)', async () => {
    if (skip) return;
    let inTimeout = null;
    const a = await request(cross(), 'POST', `${base}/hang`, {
      body: 'abc',
      upload: true,
      setup: (x) => {
        x.timeout = 100;
        x.ontimeout = () => (inTimeout = x.readyState);
      },
    });
    expect(a.ev).toEqual([
      1, 'loadstart(0,0,false)', 'upload.loadstart(0,3,true)', 'upload.progress(0,0,false)', 4, 'upload.timeout(0,0,false)',
      'upload.loadend(0,0,false)', 'progress(0,0,false)', 'timeout(0,0,false)', 'loadend(0,0,false)',
    ]);
    expect(inTimeout).toBe(4);
    expect(a.x.readyState).toBe(0);
    const b = await request(cross(), 'GET', `${base}/hang`, { setup: (x) => (x.timeout = 50) });
    expect(b.ev).toEqual([1, 'loadstart(0,0,false)', 'progress(0,0,false)', 4, 'timeout(0,0,false)', 'loadend(0,0,false)']);
  });

  it('T15: open() during LOADING stops the old request; the new one runs a full trace', async () => {
    if (skip) return;
    let reopened = false;
    const { ev } = await request(cross(), 'GET', `${base}/chunks`, {
      on: (v, x) => {
        if (v === 'progress(5,0,false)' && !reopened) {
          reopened = true;
          x.open('GET', `${base}/chunks?len=1`);
          x.send();
        }
      },
    });
    expect(ev).toEqual([
      1, 'loadstart(0,0,false)', 2, 3, 'progress(5,0,false)', 1, 'loadstart(0,0,false)', 2, 3, 'progress(5,15,true)', 3,
      'progress(10,15,true)', 3, 'progress(15,15,true)', 4, 'load(15,15,true)', 'loadend(15,15,true)',
    ]);
  });

  it('a throwing listener is reported on the window and the request carries on', async () => {
    if (skip) return;
    const w = cross();
    const errors = [];
    w.addEventListener('error', (e) => {
      errors.push(e.error?.message);
      e.preventDefault();
    });
    const { ev } = await request(w, 'GET', `${base}/head`, {
      setup: (x) => {
        x.onload = () => {
          throw new Error('boom');
        };
      },
    });
    expect(errors).toEqual(['boom']);
    expect(ev.slice(-2)).toEqual(['load(5,5,true)', 'loadend(5,5,true)']);
  });

  it('responseText grows chunk by chunk; a connection reset is a network error after LOADING', async () => {
    if (skip) return;
    const seen = [];
    await request(cross(), 'GET', `${base}/chunks`, { setup: (x) => (x.onprogress = () => seen.push(x.responseText)) });
    expect(seen).toEqual(['chunk', 'chunkchunk', 'chunkchunkchunk']);
    const r = await request(cross(), 'GET', `${base}/reset`);
    expect(r.ev).toEqual([1, 'loadstart(0,0,false)', 2, 3, 'progress(1,0,false)', 4, 'error(0,0,false)', 'loadend(0,0,false)']);
    expect([r.x.status, r.x.responseText]).toEqual([0, '']);
  });
});

describe.each(DOMS)('XMLHttpRequest requests on the wire [%s]', (kind) => {
  const HD = kind === 'happy-dom';
  const same = () => makeWindow(kind, { url: `${base}/dir/page.html?q=1` });

  it('default headers, Referer, Origin only cross-origin', async () => {
    const w = same();
    const r = await echo(w, 'GET');
    expect(r.h('referer')).toBe(`${base}/dir/page.html?q=1`);
    expect(r.h('accept')).toBe('*/*');
    expect(r.h('origin')).toBe(null);
    if (!HD) {
      // PINNED to jsdom: happy-dom sends its own defaults (no Accept-Language, br, Connection: close)
      expect(r.h('user-agent')).toBe(w.navigator.userAgent);
      expect(r.h('accept-language')).toBe('en');
      expect(r.h('accept-encoding')).toBe('gzip, deflate');
    }
    const c = await echo(makeWindow(kind), 'GET');
    expect(c.h('origin')).toBe('http://localhost:3000');
    expect(c.h('referer')).toBe('http://localhost:3000/');
  });

  it('Content-Length: 0 for a bodiless POST; GET and HEAD drop the body', async () => {
    const w = same();
    if (!HD) expect((await echo(w, 'POST')).h('content-length')).toBe('0'); // PINNED to jsdom: happy-dom sends none
    if (HD) return; // PINNED to jsdom: happy-dom rejects a GET body asynchronously and never ends the request
    const g = await echo(w, 'GET', `${base}/echo`, { body: 'ignored' });
    expect(g.body.length).toBe(0);
    expect(g.h('content-type')).toBe(null);
  });

  it('string bodies: text/plain;charset=UTF-8, author charsets rewritten to UTF-8', async () => {
    const w = same();
    const a = await echo(w, 'POST', `${base}/echo`, { body: 'héllo' });
    expect(a.body.toString()).toBe('héllo');
    expect(a.h('content-type')).toBe('text/plain;charset=UTF-8');
    const b = await echo(w, 'POST', `${base}/echo`, { body: 'x', headers: [['Content-Type', 'text/plain;charset=ascii']] });
    if (!HD) expect(b.h('content-type')).toBe('text/plain;charset=UTF-8'); // PINNED to jsdom: happy-dom keeps the author's
    const c = await echo(w, 'POST', `${base}/echo`, { body: '{}', headers: [['Content-Type', 'application/json; charset=UTF-8']] });
    expect(c.h('content-type')).toBe('application/json; charset=UTF-8');
    const d = await echo(w, 'POST', `${base}/echo`, { body: { a: 1 } });
    expect(d.body.toString()).toBe('[object Object]');
  });

  it('Blob, ArrayBuffer, Uint8Array (offset honoured) and Buffer bodies', async () => {
    const w = same();
    const B = w.Blob ?? Blob; // jsdom only accepts its own realm's Blob; rsdom's window has Node's global one
    const a = await echo(w, 'POST', `${base}/echo`, { body: new B(['blob'], { type: 'text/x-a' }) });
    expect([a.body.toString(), a.h('content-type')]).toEqual(['blob', 'text/x-a']);
    const b = await echo(w, 'POST', `${base}/echo`, { body: new B(['raw']) });
    expect([b.body.toString(), b.h('content-type')]).toEqual(['raw', null]);
    const c = await echo(w, 'PUT', `${base}/echo`, { body: Uint8Array.of(1, 2, 3).buffer });
    expect([...c.body]).toEqual([1, 2, 3]);
    const d = await echo(w, 'PUT', `${base}/echo`, { body: Uint8Array.of(9, 8, 7, 6).subarray(1, 3) });
    if (!HD) expect([...d.body]).toEqual([8, 7]); // PINNED to jsdom: happy-dom sends the whole buffer
    const e = await echo(w, 'PUT', `${base}/echo`, { body: Buffer.from('buf') });
    expect(e.body.toString()).toBe('buf');
  });

  it('FormData: multipart with escaped names, CRLF-normalized values and file parts', async () => {
    const w = same();
    const fd = new w.FormData();
    fd.append('a"b\n', 'line1\nline2');
    fd.append('f', new (w.Blob ?? Blob)(['data']), 'n.txt');
    const r = await echo(w, 'POST', `${base}/echo`, { body: fd });
    const ct = r.h('content-type');
    if (HD) return; // PINNED to jsdom: happy-dom's boundary format and escaping differ
    expect(ct).toMatch(/^multipart\/form-data; boundary=-{26}\d{24}$/);
    const boundary = ct.slice(ct.indexOf('=') + 1);
    expect(r.body.toString()).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="a%22b%0D%0A"\r\n\r\nline1\r\nline2\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="n.txt"\r\nContent-Type: application/octet-stream\r\n\r\ndata\r\n` +
        `--${boundary}--\r\n`,
    );
  });

  it('a Document body is serialized as HTML', async () => {
    const w = same();
    w.document.body.innerHTML = '<p>doc</p>';
    const r = await echo(w, 'POST', `${base}/echo`, { body: w.document });
    if (HD) return; // PINNED to jsdom: happy-dom stringifies the document
    expect(r.h('content-type')).toBe('text/html;charset=UTF-8');
    expect(r.body.toString()).toBe('<!DOCTYPE html><html><head></head><body><p>doc</p></body></html>');
  });
});

describe.each(DOMS)('XMLHttpRequest responses [%s]', (kind) => {
  const HD = kind === 'happy-dom';
  const same = () => makeWindow(kind, { url: `${base}/dir/page.html` });

  it('status, statusText, responseURL', async () => {
    const w = same();
    const { x } = await request(w, 'GET', `${base}/status?code=299&reason=Fine%20Thanks`);
    expect([x.status, x.statusText, x.responseText]).toEqual([299, 'Fine Thanks', 's']);
    expect(x.responseURL).toBe(`${base}/status?code=299&reason=Fine%20Thanks`);
    expect((await request(w, 'GET', `${base}/missing`)).x.status).toBe(404);
  });

  it('getResponseHeader(): combined values, empty values, Set-Cookie hidden', async () => {
    const w = same();
    const { x } = await request(w, 'GET', `${base}/dup`);
    expect(x.getResponseHeader('X-B')).toBe('1, 3');
    expect(x.getResponseHeader('x-a')).toBe('2');
    expect(x.getResponseHeader('x-empty')).toBe('');
    expect(x.getResponseHeader('nope')).toBe(null);
    if (!HD) expect(x.getResponseHeader('set-cookie')).toBe(null); // PINNED to jsdom: happy-dom exposes it
    // the same lines, whatever the order and duplicate-line layout (exact strings: divergences below)
    const lines = new Map();
    for (const l of x.getAllResponseHeaders().split('\r\n')) {
      const i = l.indexOf(': ');
      const k = l.slice(0, i).toLowerCase();
      lines.set(k, lines.has(k) ? `${lines.get(k)}, ${l.slice(i + 2)}` : l.slice(i + 2));
    }
    expect([lines.get('x-a'), lines.get('x-b'), lines.get('x-empty'), lines.has('set-cookie')]).toEqual(['2', '1, 3', '', false]);
  });

  it("responseType 'json'", async () => {
    const w = same();
    const setup = (x) => (x.responseType = 'json');
    const a = await request(w, 'GET', `${base}/json`, { setup });
    expect(a.x.response).toEqual({ a: [1, 2] });
    expect(a.x.response).toBe(a.x.response);
    expect(errName(() => a.x.responseText)).toBe('InvalidStateError');
    expect((await request(w, 'GET', `${base}/json?bad=1`, { setup })).x.response).toBe(null);
    if (HD) return; // PINNED to jsdom: happy-dom keeps the BOM (null) and has no response before DONE
    expect((await request(w, 'GET', `${base}/json?bom=1`, { setup })).x.response).toEqual({ a: [1, 2] });
    const during = [];
    await request(w, 'GET', `${base}/chunks`, { setup: (x) => { setup(x); x.onprogress = () => during.push(x.response); } });
    expect(during).toEqual([null, null, null]);
  });

  it("responseType 'arraybuffer' (partial during LOADING) and 'blob'", async () => {
    const w = same();
    const sizes = [];
    const a = await request(w, 'GET', `${base}/chunks`, {
      setup: (x) => {
        x.responseType = 'arraybuffer';
        x.onprogress = () => sizes.push(x.response.byteLength);
      },
    });
    if (!HD) {
      // PINNED to jsdom: happy-dom has no response before DONE and returns a Buffer
      expect(sizes).toEqual([5, 10, 15]);
      expect(a.x.response instanceof ArrayBuffer || a.x.response instanceof w.ArrayBuffer).toBe(true);
    }
    expect(Buffer.from(a.x.response).toString()).toBe('chunkchunkchunk');
    const b = await request(w, 'GET', `${base}/html`, { setup: (x) => (x.responseType = 'blob') });
    expect(b.x.response.type).toBe('text/html;charset=utf-8');
    expect(await b.x.response.text()).toContain('<title>T</title>');
    const c = await request(w, 'GET', `${base}/html`, {
      setup: (x) => {
        x.responseType = 'blob';
        x.overrideMimeType('text/x-y');
      },
    });
    expect(c.x.response.type).toBe('text/x-y');
  });

  it("responseType 'document' parses HTML; responseXML is null for '' and HTML", async () => {
    const w = same();
    const a = await request(w, 'GET', `${base}/html`, { setup: (x) => (x.responseType = 'document') });
    expect(a.x.responseXML).toBe(a.x.response);
    if (!HD) {
      // PINNED to jsdom: happy-dom returns an empty document with the window URL
      expect(a.x.response.title).toBe('T');
      expect(a.x.response.getElementById('p').textContent).toBe('hi');
      expect(a.x.response.URL).toBe(`${base}/html`);
    }
    const b = await request(w, 'GET', `${base}/html`);
    expect(b.x.responseXML).toBe(null);
    expect(errName(() => { b.x.responseType = 'text'; })).toBe('InvalidStateError');
    // an invalid value is ignored before the state check
    if (!HD) expect(errName(() => { b.x.responseType = 'nonsense'; })).toBe('ok'); // PINNED to jsdom: happy-dom checks the state first
    expect(b.x.responseType).toBe('');
  });

  it('charsets: header, BOM, overrideMimeType, windows-1252 0x80-0x9F', async () => {
    const w = same();
    const t = async (q, setup) => (await request(w, 'GET', `${base}/charset?${q}`, { setup })).x.responseText;
    expect(await t('bytes=c3a9')).toBe('é');
    if (HD) return; // PINNED to jsdom: happy-dom always decodes UTF-8 and keeps the BOM
    expect(await t('cs=windows-1252&bytes=80e993')).toBe('€é“');
    expect(await t('cs=shift_jis&bytes=82a0')).toBe('あ');
    expect(await t('cs=windows-1252&bytes=efbbbfc3a9')).toBe('é');
    expect(await t('cs=utf-8&bytes=c3a9', (x) => x.overrideMimeType('text/plain;charset=windows-1252'))).toBe('Ã©');
    expect(await t('cs=nonsense&bytes=c3a9')).toBe('é');
    // the two encodings TextDecoder refuses (WPT encoding/replacement-encodings.any.html)
    expect(await t('cs=iso-2022-kr&bytes=414243')).toBe('�');
    expect(await t('cs=replacement&bytes=efbbbf41')).toBe('A');
    expect(await t('cs=x-user-defined&bytes=4180ff')).toBe('A');
  });

  it('gzip: decoded text, progress not length-computable', async () => {
    const w = same();
    const p = [];
    const { x } = await request(w, 'GET', `${base}/gzip`, { setup: (y) => (y.onprogress = (e) => p.push([e.loaded, e.lengthComputable])) });
    expect(x.responseText).toBe('hello gzip world');
    if (!HD) expect(p.at(-1)).toEqual([16, false]); // PINNED to jsdom: happy-dom reports the compressed length as total
  });
});

describe.each(DOMS)('XMLHttpRequest URL schemes [%s]', (kind) => {
  const HD = kind === 'happy-dom';

  it('data: URLs', async () => {
    const w = makeWindow(kind);
    const url = 'data:text/plain;charset=utf-8,hi';
    const { x } = await request(w, 'GET', url);
    expect([x.status, x.responseText]).toEqual([200, 'hi']);
    if (!HD) expect([x.statusText, x.getResponseHeader('content-type'), x.responseURL]).toEqual(['OK', 'text/plain;charset=utf-8', url]); // PINNED to jsdom: happy-dom differs
  });

  it('file: URLs (missing file: readyState 2, then an error)', async () => {
    if (HD) return; // PINNED to jsdom: happy-dom refuses file: URLs
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdom-xhr-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'from disk');
    const w = makeWindow(kind);
    const a = await request(w, 'GET', pathToFileURL(file).href);
    expect([a.x.status, a.x.statusText, a.x.responseText, a.x.getAllResponseHeaders()]).toEqual([200, 'OK', 'from disk', '']);
    const b = await request(w, 'GET', pathToFileURL(path.join(dir, 'missing.txt')).href);
    expect(b.ev).toEqual([1, 'loadstart(0,0,false)', 2, 4, 'error(0,0,false)', 'loadend(0,0,false)']);
    fs.rmSync(dir, { recursive: true });
  });

  it('bad ports are network errors', async () => {
    if (HD) return; // PINNED to jsdom: happy-dom connects
    const { ev, x } = await request(makeWindow(kind), 'GET', 'http://127.0.0.1:6000/');
    expect(ev).toEqual([1, 'loadstart(0,0,false)', 4, 'error(0,0,false)', 'loadend(0,0,false)']);
    expect(x.status).toBe(0);
  });
});

describe.each(DOMS)('XMLHttpRequest redirects and authentication [%s]', (kind) => {
  const HD = kind === 'happy-dom';
  const same = () => makeWindow(kind, { url: `${base}/dir/page.html` });

  it('301/302/303 turn POST into GET without Content-Type; 307 keeps method and body', async () => {
    const w = same();
    for (const code of [301, 302, 303]) {
      const r = await echo(w, 'POST', `${base}/redirect?code=${code}`, { body: 'payload' });
      expect([r.method, r.h('content-type'), r.body.length], String(code)).toEqual(['GET', null, 0]);
    }
    const r = await echo(w, 'POST', `${base}/redirect?code=307`, { body: 'payload' });
    expect([r.method, r.h('content-type')]).toEqual(['POST', 'text/plain;charset=UTF-8']);
    if (!HD) expect(r.body.toString()).toBe('payload'); // PINNED to jsdom: happy-dom drops the body on a 307
    const { x } = await request(w, 'GET', `${base}/redirect?code=302`);
    expect(x.responseURL).toBe(`${base}/echo`);
  });

  it('20 redirects are followed, 21 are an error; non-HTTP targets are errors; no Location is final', async () => {
    const w = same();
    expect((await request(w, 'GET', `${base}/redirect?n=20`)).x.status).toBe(200);
    const loop = await request(w, 'GET', `${base}/loop`);
    if (!HD) expect(loop.ev.slice(-3)).toEqual([4, 'error(0,0,false)', 'loadend(0,0,false)']); // PINNED to jsdom: happy-dom's trace differs
    expect(loop.x.status).toBe(0);
    const mail = await request(w, 'GET', `${base}/redirect?to=${encodeURIComponent('mailto:a@b.c')}`);
    expect(mail.x.status).toBe(0);
    expect((await request(w, 'GET', `${base}/redirect?noloc=1`)).x.status).toBe(302);
    if (!HD) expect((await request(w, 'GET', `${base}/redirect?noloc=empty`)).x.status).toBe(302); // PINNED to jsdom: happy-dom follows an empty Location
  });

  it('a cross-origin redirect drops Authorization', async () => {
    const w = same();
    const target = `http://localhost:${new URL(base).port}/echo`;
    const r = await echo(w, 'GET', `${base}/redirect?to=${encodeURIComponent(target)}`, { headers: [['Authorization', 'Bearer t']] });
    if (!HD) expect(r.h('authorization')).toBe(null); // PINNED to jsdom: happy-dom keeps it
    expect(r.h('host')).toBe(`localhost:${new URL(base).port}`);
  });

  it('open() credentials answer a Basic challenge; URL credentials are never sent', async () => {
    const w = same();
    const before = srv.hits('/auth').length;
    const a = await request(w, 'GET', `${base}/auth`, { user: 'u', password: 'p' });
    expect([a.x.status, a.x.responseText]).toEqual([200, 'Basic dTpw']);
    if (!HD) expect(srv.hits('/auth').length - before).toBe(2); // PINNED to jsdom: happy-dom sends credentials upfront
    if (HD) return; // PINNED to jsdom: happy-dom's open() throws on a URL with credentials
    const b = await request(w, 'GET', `${base.replace('//', '//u:p@')}/auth`);
    expect(b.x.status).toBe(401);
  });
});

describe.each(DOMS)('XMLHttpRequest CORS (window at http://localhost:3000) [%s]', (kind) => {
  // PINNED to jsdom for the blocking checks: happy-dom does not enforce CORS on XHR responses
  const HD = kind === 'happy-dom';
  const cross = () => makeWindow(kind);
  const options = () => srv.requests.filter((r) => r.method === 'OPTIONS').length;

  it('a response without Access-Control-Allow-Origin is a network error', async () => {
    const { ev, x } = await request(cross(), 'GET', `${base}/nocors`);
    if (HD) return;
    expect(ev).toEqual([1, 'loadstart(0,0,false)', 4, 'error(0,0,false)', 'loadend(0,0,false)']);
    expect(x.status).toBe(0);
  });

  it('response headers are filtered unless exposed', async () => {
    const w = cross();
    const a = await request(w, 'GET', `${base}/cors?acao=star`);
    expect(a.x.responseText).toBe('cors');
    expect(a.x.getResponseHeader('content-type')).toBe('text/plain');
    if (!HD) expect(a.x.getResponseHeader('x-b')).toBe(null); // PINNED to jsdom: happy-dom exposes everything
    expect((await request(w, 'GET', `${base}/cors?acao=star&aceh=X-B`)).x.getResponseHeader('x-b')).toBe('b');
    expect((await request(w, 'GET', `${base}/cors?acao=star&aceh=*`)).x.getResponseHeader('x-b')).toBe('b');
  });

  it('preflight: only for unsafe header names, non-simple methods or upload listeners', async () => {
    const w = cross();
    let n = options();
    await request(w, 'POST', `${base}/cors?acao=star`, { body: '{}', headers: [['Content-Type', 'application/json']] });
    if (!HD) expect(options() - n).toBe(0); // PINNED to jsdom (names-only safelist): happy-dom preflights a JSON POST
    n = options();
    const a = await request(w, 'GET', `${base}/cors?acao=star`, { headers: [['X-Custom', '1']] });
    expect(a.x.status).toBe(200);
    expect(options() - n).toBe(1);
    const pre = srv.requests.findLast((r) => r.method === 'OPTIONS');
    expect(header(pre, 'access-control-request-method')).toBe('GET');
    if (!HD) expect(header(pre, 'access-control-request-headers')).toBe('X-Custom'); // PINNED to jsdom: happy-dom lowercases
    if (!HD) expect(header(pre, 'origin')).toBe('http://localhost:3000'); // PINNED to jsdom
    n = options();
    expect((await request(w, 'PUT', `${base}/cors?acao=star`, { body: 'x' })).x.status).toBe(200);
    expect(options() - n).toBe(1);
    n = options();
    await request(w, 'POST', `${base}/cors?acao=star`, { body: 'x', upload: true });
    if (!HD) expect(options() - n).toBe(1); // PINNED to jsdom: happy-dom ignores upload listeners
  });

  it('failed preflights and credentials without Access-Control-Allow-Credentials are network errors', async () => {
    const w = cross();
    const st = async (q, opts) => (await request(w, 'GET', `${base}/cors?${q}`, opts)).x.status;
    const custom = { headers: [['X-Custom', '1']] };
    const creds = { setup: (x) => (x.withCredentials = true) };
    if (!HD) {
      // PINNED to jsdom: happy-dom does not enforce CORS
      expect(await st('acao=star&preflight=403', custom)).toBe(0);
      expect(await st('acao=star&preflight=noacah', custom)).toBe(0);
      expect(await st('acao=star', creds)).toBe(0);
    }
    expect(await st('acao=echo&acac=1', creds)).toBe(200);
  });

  it('a same-origin request redirected to a cross-origin URL without CORS fails', async () => {
    const w = makeWindow(kind, { url: `${base}/dir/page.html` });
    const target = `http://localhost:${new URL(base).port}/nocors`;
    const { x } = await request(w, 'GET', `${base}/redirect?to=${encodeURIComponent(target)}`);
    if (!HD) expect(x.status).toBe(0); // PINNED to jsdom: happy-dom does not enforce CORS
  });
});

describe.each(DOMS)('XMLHttpRequest cookies [%s]', (kind) => {
  // PINNED to jsdom: happy-dom's cookie handling for XHR differs (HttpOnly, credentialed cross-origin)
  const HD = kind === 'happy-dom';

  it('same-origin Set-Cookie lands in document.cookie and is sent back; HttpOnly ones are sent but hidden', async () => {
    const w = makeWindow(kind, { url: `${base}/dir/page.html` });
    await request(w, 'GET', `${base}/cookie/set?name=a&v=1`);
    expect(w.document.cookie).toBe('a=1');
    await request(w, 'GET', `${base}/cookie/set?name=ho&v=3&httponly=1`);
    if (!HD) expect(w.document.cookie).toBe('a=1');
    const { x } = await request(w, 'GET', `${base}/cookie/echo`);
    if (!HD) expect(x.responseText).toBe('a=1; ho=3');
  });

  it('credentialed cross-origin requests store and send cookies; preflights carry none', async () => {
    if (HD) return;
    const w = makeWindow(kind);
    const creds = (x) => (x.withCredentials = true);
    await request(w, 'GET', `${base}/cookie/set?name=c&v=2&acao=echo&acac=1`, { setup: creds });
    expect(w.document.cookie).toBe('');
    expect((await request(w, 'GET', `${base}/cookie/echo?acao=echo&acac=1`, { setup: creds })).x.responseText).toBe('c=2');
    expect((await request(w, 'GET', `${base}/cookie/echo?acao=star`)).x.responseText).toBe('');
    await request(w, 'GET', `${base}/cors?acao=echo&acac=1`, { setup: creds, headers: [['X-Custom', '1']] });
    const [pre, get] = srv.hits('/cors?acao=echo&acac=1').slice(-2);
    expect([pre.method, header(pre, 'cookie')]).toEqual(['OPTIONS', null]);
    expect([get.method, header(get, 'cookie')]).toEqual(['GET', 'c=2']);
  });
});

describe('spec-correct divergences from jsdom (asserted)', () => {
  const kinds = DOMS.filter((k) => k !== 'happy-dom');
  const pick = (kind, j, r) => (kind === 'jsdom' ? j : r);

  it.each(kinds)('abort() from readystatechange(3): jsdom fires a stray progress after loadend [%s]', async (kind) => {
    const { ev } = await request(makeWindow(kind), 'GET', `${base}/slow`, { on: (v, x) => v === 3 && x.abort() });
    const common = [1, 'loadstart(0,0,false)', 2, 3, 4, 'abort(0,0,false)', 'loadend(0,0,false)'];
    expect(ev).toEqual(pick(kind, [...common, 'progress(1,0,false)'], common));
  });

  it.each(kinds)('abort() from upload.onload: jsdom still reaches readyState 2 (status 200) [%s]', async (kind) => {
    const { ev, x } = await request(makeWindow(kind, { url: `${base}/dir/page.html` }), 'POST', `${base}/chunks`, {
      body: 'abc',
      upload: true,
      on: (v, y) => v === 'upload.load(3,3,true)' && y.abort(),
    });
    const common = [
      1, 'loadstart(0,0,false)', 'upload.loadstart(0,3,true)', 'upload.progress(3,3,true)', 'upload.load(3,3,true)', 4,
      'abort(0,0,false)', 'loadend(0,0,false)', 'upload.loadend(3,3,true)',
    ];
    expect(ev).toEqual(pick(kind, [...common, 2], common));
    expect([x.readyState, x.status]).toEqual(pick(kind, [2, 200], [0, 0]));
  });

  it.each(kinds)('a timeout set after send() takes effect (jsdom ignores it) [%s]', async (kind) => {
    const x = new (makeWindow(kind).XMLHttpRequest)();
    const t = trace(x);
    x.open('GET', `${base}/hang`);
    x.send();
    x.timeout = 30;
    await sleep(150);
    expect(t.ev).toEqual(pick(kind, [1, 'loadstart(0,0,false)'], [1, 'loadstart(0,0,false)', 'progress(0,0,false)', 4, 'timeout(0,0,false)', 'loadend(0,0,false)']));
    x.abort();
  });

  it.each(kinds)('open() clears the timeout timer (jsdom: the stale timer times out the next request) [%s]', async (kind) => {
    const x = new (makeWindow(kind).XMLHttpRequest)();
    const t = trace(x);
    x.timeout = 200;
    x.open('GET', `${base}/hang`);
    x.send();
    await sleep(100);
    x.open('GET', `${base}/slow`);
    x.send(); // its own timer fires at 300 ms
    await sleep(160);
    const common = [1, 'loadstart(0,0,false)', 'loadstart(0,0,false)', 2, 3, 'progress(1,0,false)'];
    expect(t.ev).toEqual(pick(kind, [...common, 'progress(0,0,false)', 4, 'timeout(0,0,false)', 'loadend(0,0,false)'], common));
    x.abort();
  });

  it.each(kinds)('open() drops credentials of an earlier open() (jsdom answers the challenge with them) [%s]', async (kind) => {
    const x = new (makeWindow(kind, { url: `${base}/dir/page.html` }).XMLHttpRequest)();
    const t = trace(x);
    x.open('GET', `${base}/auth`, true, 'u', 'p');
    x.open('GET', `${base}/auth`);
    x.send();
    await t.done;
    expect([x.status, x.responseText]).toEqual(pick(kind, [200, 'Basic dTpw'], [401, 'no']));
  });

  it.each(kinds)('open() in ontimeout keeps the new request OPENED (jsdom resets to 0) [%s]', async (kind) => {
    const x = new (makeWindow(kind).XMLHttpRequest)();
    const t = trace(x);
    x.open('GET', `${base}/hang`);
    x.timeout = 30;
    x.ontimeout = () => x.open('GET', `${base}/echo`);
    x.send();
    await t.done;
    expect(x.readyState).toBe(pick(kind, 0, 1));
  });

  it.each(kinds)('abort and network errors clear responseURL (jsdom keeps it) [%s]', async (kind) => {
    const w = makeWindow(kind);
    const a = await request(w, 'GET', `${base}/chunks`, { on: (v, x) => v === 2 && x.abort() });
    expect(a.x.responseURL).toBe(pick(kind, `${base}/chunks`, ''));
    const b = await request(w, 'GET', `${base}/head`);
    b.x.abort();
    expect(b.x.responseURL).toBe(pick(kind, `${base}/head`, ''));
  });

  it.each(kinds)('no fragment in Referer and responseURL [%s]', async (kind) => {
    const w = makeWindow(kind, { url: `${base}/dir/page.html#frag` });
    const r = await echo(w, 'GET', `${base}/echo#x`);
    expect(r.h('referer')).toBe(pick(kind, `${base}/dir/page.html#frag`, `${base}/dir/page.html`));
    const { x } = await request(w, 'GET', `${base}/echo#x`);
    expect(x.responseURL).toBe(pick(kind, `${base}/echo#x`, `${base}/echo`));
  });

  it.each(kinds)('typed-array, URLSearchParams and SharedArrayBuffer bodies [%s]', async (kind) => {
    const w = makeWindow(kind, { url: `${base}/dir/page.html` });
    const dv = await echo(w, 'PUT', `${base}/echo`, { body: new DataView(Uint8Array.of(1, 2, 3).buffer) });
    expect([...dv.body]).toEqual(pick(kind, [], [1, 2, 3]));
    const u16 = await echo(w, 'PUT', `${base}/echo`, { body: Uint16Array.of(1, 0x102) });
    expect([...u16.body]).toEqual(pick(kind, [1, 2], [1, 0, 2, 1]));
    const usp = await echo(w, 'POST', `${base}/echo`, { body: new URLSearchParams('a=1&b=2') });
    expect(usp.body.toString()).toBe('a=1&b=2');
    expect(usp.h('content-type')).toBe(pick(kind, 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded;charset=UTF-8'));
    const x = new w.XMLHttpRequest();
    x.open('POST', `${base}/echo`);
    const sab = errName(() => x.send(new SharedArrayBuffer(2)));
    expect(sab).toBe(pick(kind, 'ok', 'TypeError'));
    x.abort();
  });

  it.each(kinds)('blob: URLs load (jsdom: network error) [%s]', async (kind) => {
    const url = URL.createObjectURL(new Blob(['blobby'], { type: 'text/x-b' }));
    const { x } = await request(makeWindow(kind), 'GET', url);
    expect([x.status, x.responseText]).toEqual(pick(kind, [0, ''], [200, 'blobby']));
    URL.revokeObjectURL(url);
  });

  it.each(kinds)('getAllResponseHeaders(): Node fetch sorts and combines; jsdom keeps wire order [%s]', async (kind) => {
    const { x } = await request(makeWindow(kind, { url: `${base}/dir/page.html` }), 'GET', `${base}/dup`);
    const lines = x.getAllResponseHeaders().split('\r\n').filter((l) => /^x-/.test(l));
    expect(lines).toEqual(pick(kind, ['x-b: 1', 'x-b: 3', 'x-a: 2', 'x-empty: '], ['x-a: 2', 'x-b: 1, 3', 'x-empty: ']));
  });

  it.each(kinds)('Node fetch adds sec-fetch-mode [%s]', async (kind) => {
    const r = await echo(makeWindow(kind, { url: `${base}/dir/page.html` }), 'GET');
    expect(r.h('sec-fetch-mode')).toBe(pick(kind, null, 'cors'));
  });

  it.each(kinds)('responseXML for XML types: null without an XML parser [%s]', async (kind) => {
    const { x } = await request(makeWindow(kind, { url: `${base}/dir/page.html` }), 'GET', `${base}/xml`);
    expect(x.responseXML === null).toBe(pick(kind, false, true));
  });
});
