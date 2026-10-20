// rsdom-only checks for XMLHttpRequest (lib/xhr.cjs, lib/xhr-fetch.cjs): what loads when, teardown, the fetch
// captured at facade load, the msw 3 (AsyncLocalStorage) and msw 2 (instance shadowing) contracts emulated without
// msw, synchronous send(), fake timers and the window-context close hook. Event notation as in
// test/contract/xhr.test.mjs.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');
const { startServer } = require('../contract/xhr-server.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROGRESS = ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];
// captured at load: real macrotasks while a test has fake timers installed
const later = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => later(r, ms));
const readyState = Object.getOwnPropertyDescriptor(require('../../lib/xhr.cjs').XMLHttpRequest.prototype, 'readyState').get;

let srv;
let base;
beforeAll(async () => {
  srv = await startServer();
  base = srv.base;
});
afterAll(() => srv.close());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Records readystatechange (through the prototype getter: msw 2 shadows `readyState`) and progress events. */
function trace(x) {
  const ev = [];
  let resolve;
  const done = new Promise((r) => (resolve = r));
  x.addEventListener('readystatechange', () => ev.push(readyState.call(x)));
  for (const t of PROGRESS) {
    x.addEventListener(t, (e) => {
      ev.push(`${t}(${e.loaded},${e.total},${e.lengthComputable})`);
      if (t === 'loadend') later(() => resolve(ev), 20);
    });
  }
  return { ev, done };
}

describe('module loading', () => {
  it('construct, open, setRequestHeader and accessors load nothing; the first send() loads the transport', () => {
    const facade = path.join(root, 'lib/index.cjs');
    const code = `
      const { createWindow } = require(${JSON.stringify(facade)});
      createWindow({ global: globalThis });
      const loaded = () => ({
        undici: process.moduleLoadList.some((m) => m.includes('undici')),
        http: process.moduleLoadList.includes('NativeModule http'),
        xhrFetch: Object.keys(require.cache).some((k) => k.endsWith('xhr-fetch.cjs')),
      });
      const x = new XMLHttpRequest();
      x.open('POST', '/x');
      x.setRequestHeader('X-A', '1');
      const probe = ['onloadend' in x, x.upload instanceof XMLHttpRequestUpload, x.responseText, x.response, x.status];
      const before = loaded();
      const srv = require('node:http').createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end('ok');
      });
      srv.listen(0, '127.0.0.1', () => {
        const y = new XMLHttpRequest();
        y.open('GET', 'http://127.0.0.1:' + srv.address().port + '/');
        y.onload = () => {
          const { undici, xhrFetch } = loaded(); // node:http: this script's own server
          process.stdout.write(JSON.stringify({ probe, before, after: { undici, xhrFetch }, text: y.responseText }));
          srv.close();
        };
        y.send();
      });`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      probe: [true, true, '', '', 0],
      before: { undici: false, http: false, xhrFetch: false },
      after: { undici: true, xhrFetch: true },
      text: 'ok',
    });
  });
});

describe('teardown', () => {
  it('rt.reset() aborts in-flight requests without events; the dead document refuses open()', async () => {
    createWindow({ url: 'http://localhost:3000/' });
    const { XMLHttpRequest } = rt.classes;
    const x = new XMLHttpRequest();
    const t = trace(x);
    x.open('GET', `${base}/chunks`); // two more chunks and the end follow the first one
    x.send();
    await new Promise((r) => x.addEventListener('progress', r, { once: true }));
    const seen = t.ev.length;
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      rt.reset();
      await sleep(100);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(t.ev.length).toBe(seen);
    expect(uncaught).toEqual([]);
    expect([x.readyState, x.status, x.responseText]).toEqual([4, 0, '']);
    expect(() => x.open('GET', `${base}/echo`)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    // constructed while there is no main document: no owner document at all
    expect(rt.defaultDocument).toBe(null);
    const y = new XMLHttpRequest();
    expect(() => y.open('GET', `${base}/echo`)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
  });
});

describe('transport capture', () => {
  it('a fetch stub installed after the facade loaded never sees XHR traffic', async () => {
    const { window } = createWindow({ url: `${base}/page.html` });
    const stub = vi.fn(() => Promise.reject(new Error('stubbed')));
    vi.stubGlobal('fetch', stub);
    const before = srv.hits('/echo?stub').length;
    const x = new window.XMLHttpRequest();
    const t = trace(x);
    x.open('GET', `${base}/echo?stub`);
    x.send();
    await t.done;
    expect(x.status).toBe(200);
    expect(srv.hits('/echo?stub').length - before).toBe(1);
    expect(stub).not.toHaveBeenCalled();
  });

  it('msw 3 contract: every hop (preflight, redirect, final) connects inside the context send() ran in', async () => {
    // Connection: close on every response, so each hop opens its own socket
    const server = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') res.writeHead(204).end();
      else if (req.url === '/r') res.writeHead(302, { Location: '/final' }).end();
      else res.end('final');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const als = new AsyncLocalStorage();
    const seen = [];
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      seen.push(als.getStore());
      return connect.apply(this, args);
    };
    try {
      const { window } = createWindow({ url: 'http://localhost:3000/' });
      const x = new window.XMLHttpRequest();
      const t = trace(x);
      x.open('GET', `http://127.0.0.1:${server.address().port}/r`);
      x.setRequestHeader('X-Custom', '1'); // cross-origin + unsafe header: preflight
      const ctx = { initiator: x };
      als.run(ctx, () => x.send());
      await t.done;
      expect([x.status, x.responseText]).toEqual([200, 'final']);
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen.every((s) => s === ctx)).toBe(true);
    } finally {
      net.Socket.prototype.connect = connect;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('msw 2 shape: Proxy newTarget, prototype members copied onto the instance, shadowed state, own send', async () => {
    const { window } = createWindow({ url: `${base}/page.html` });
    const X = window.XMLHttpRequest;
    const x = Reflect.construct(X, [], new Proxy(X, {}));
    for (const k of Reflect.ownKeys(X.prototype)) {
      if (k !== 'constructor') Reflect.defineProperty(x, k, Object.getOwnPropertyDescriptor(X.prototype, k));
    }
    const upload = x.upload;
    Object.defineProperty(x, 'readyState', { value: 4, writable: true, configurable: true });
    Object.defineProperty(x, 'status', { value: 999, writable: true, configurable: true });
    Object.defineProperty(x, 'upload', { value: new Proxy(upload, {}), writable: true, configurable: true });
    const send = x.send;
    let sends = 0;
    x.send = function (...args) {
      sends++;
      return send.apply(this, args);
    };
    const t = trace(x);
    x.open('GET', `${base}/head`);
    x.setRequestHeader('x-interceptors-internal-request-id', '1');
    x.send();
    await t.done;
    expect(sends).toBe(1);
    expect(t.ev).toEqual([1, 'loadstart(0,0,false)', 2, 3, 'progress(5,5,true)', 4, 'load(5,5,true)', 'loadend(5,5,true)']);
    expect([x.readyState, x.status]).toEqual([4, 999]);
    expect(Object.getOwnPropertyDescriptor(X.prototype, 'status').get.call(x)).toBe(200);
    expect(X.prototype.getAllResponseHeaders.call(x)).toMatch(/^access-control-allow-headers: \*\r\n/);
    expect(X.prototype.getResponseHeader.call(x, 'content-length')).toBe('5');
    expect(Object.getOwnPropertyDescriptor(X.prototype, 'upload').get.call(x)).toBe(upload);
  });
});

describe('synchronous requests', () => {
  it('send() throws NetworkError, fires nothing, sends nothing and leaves readyState 4', () => {
    const { window } = createWindow({ url: `${base}/page.html` });
    const x = new window.XMLHttpRequest();
    const ev = [];
    x.onreadystatechange = () => ev.push(x.readyState);
    for (const t of PROGRESS) x.addEventListener(t, () => ev.push(t));
    x.open('GET', `${base}/echo?sync`, false);
    expect(ev).toEqual([1]);
    expect(() => x.send()).toThrow(expect.objectContaining({ name: 'NetworkError' }));
    expect(ev).toEqual([1]);
    expect([x.readyState, x.status, x.responseText]).toEqual([4, 0, '']);
    expect(srv.hits('/echo?sync')).toEqual([]);
    expect(() => x.send()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
  });
});

describe('fake timers', () => {
  it('responses arrive with fake timers installed (no timer on the delivery path)', async () => {
    const { window } = createWindow({ url: `${base}/page.html` });
    vi.useFakeTimers();
    const x = new window.XMLHttpRequest();
    const t = trace(x);
    x.open('GET', `${base}/head`);
    x.send();
    await t.done;
    expect(t.ev.at(-1)).toBe('loadend(5,5,true)');
  });

  it('xhr.timeout uses the timer functions of the moment: vi.advanceTimersByTime() drives it', async () => {
    const { window } = createWindow({ url: 'http://localhost:3000/' });
    vi.useFakeTimers();
    const x = new window.XMLHttpRequest();
    const t = trace(x);
    x.open('GET', `${base}/hang`);
    x.timeout = 1000;
    x.send();
    vi.advanceTimersByTime(999);
    expect(t.ev).toEqual([1, 'loadstart(0,0,false)']);
    vi.advanceTimersByTime(1);
    expect(t.ev).toEqual([1, 'loadstart(0,0,false)', 'progress(0,0,false)', 4, 'timeout(0,0,false)', 'loadend(0,0,false)']);
    expect(x.readyState).toBe(0);
  });

  it('open() clears a timer armed before fake timers were installed; the new request is not timed out', async () => {
    const { window } = createWindow({ url: 'http://localhost:3000/' });
    const realClear = vi.fn(globalThis.clearTimeout);
    vi.stubGlobal('clearTimeout', realClear);
    const x = new window.XMLHttpRequest();
    const t = trace(x);
    x.timeout = 40;
    x.open('GET', `${base}/hang`);
    x.send(); // armed with the real setTimeout
    vi.useFakeTimers();
    x.open('GET', `${base}/hang`); // cleared with the real clearTimeout it was armed with, not the fake one
    expect(realClear).toHaveBeenCalledTimes(1);
    x.send(); // armed with the fake setTimeout, which never advances
    await sleep(120);
    expect(t.ev).toEqual([1, 'loadstart(0,0,false)', 'loadstart(0,0,false)']);
    expect(x.readyState).toBe(1);
    x.abort();
  });

  it('a timeout set in a loadstart listener arms one timer, cleared by abort()', () => {
    const { window } = createWindow({ url: 'http://localhost:3000/' });
    vi.useFakeTimers();
    const x = new window.XMLHttpRequest();
    x.open('GET', `${base}/hang`);
    x.onloadstart = () => {
      x.timeout = 5000;
    };
    x.send();
    expect(vi.getTimerCount()).toBe(1);
    x.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('cookies', () => {
  it('a document.cookie stub on the instance changes neither what XHR sends nor what it stores', async () => {
    const { window } = createWindow({ url: `${base}/page.html` });
    const send = (path) =>
      new Promise((resolve) => {
        const x = new window.XMLHttpRequest();
        x.open('GET', `${base}${path}`);
        x.onloadend = () => resolve([x.status, x.responseText]);
        x.send();
      });
    Object.defineProperty(window.document, 'cookie', { get: () => 'stub=1', configurable: true });
    expect(await send('/cookie/set?name=sid&v=7')).toEqual([200, 'set']);
    expect(await send('/cookie/echo')).toEqual([200, 'sid=7']);
    delete window.document.cookie;
    expect(window.document.cookie).toBe('sid=7');
  });
});

describe('window context close hook', () => {
  it('doc._ctx.onClose is registered once per document and aborts its requests without events', async () => {
    const { window, document } = createWindow({ url: 'http://localhost:3000/' });
    const fns = [];
    document._ctx = { closed: false, onClose: (fn) => fns.push(fn) };
    try {
      const a = new window.XMLHttpRequest();
      const b = new window.XMLHttpRequest();
      const ta = trace(a);
      const tb = trace(b);
      a.open('GET', `${base}/hang`);
      a.send();
      b.open('GET', `${base}/chunks`);
      b.send();
      expect(fns.length).toBe(1);
      await new Promise((r) => b.addEventListener('progress', r, { once: true }));
      const seen = [ta.ev.length, tb.ev.length];
      fns[0]();
      await sleep(100);
      expect([ta.ev.length, tb.ev.length]).toEqual(seen);
      expect([a.readyState, b.readyState, b.responseText]).toEqual([4, 4, '']);
      // a closed context is a destroyed document
      document._ctx.closed = true;
      expect(() => a.open('GET', `${base}/echo`)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    } finally {
      delete document._ctx;
    }
  });
});
