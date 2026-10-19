// M0 acceptance: table growth + detach, OUT overflow protocol, destroy/re-init, panic -> Error,
// independent Envs per worker thread, lazily committed table (see also bench/micro/m0-gates.mjs).
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');
const { N } = rt;

afterAll(() => {
  rt.reset();
});

describe('M0: native skeleton', () => {
  it('forced growth (capacity 64) detaches stale views and remaps correctly', () => {
    rt.reset({ capacity: 64 });
    const { document } = createWindow();
    const stale = rt.V.T;
    const gen0 = rt.V.EP[rt.EPI.GEN];
    if (rt.shared) expect(stale.length).toBe(64 * 16);
    const els = [];
    let parent = document.body;
    for (let i = 0; i < 300; i++) {
      const d = document.createElement(i % 2 ? 'div' : 'span');
      d.setAttribute('data-i', String(i));
      parent.appendChild(d);
      els.push(d);
      if (i % 10 === 0) parent = d;
    }
    expect(rt.V.EP[rt.EPI.GEN]).toBeGreaterThan(gen0);
    if (rt.shared) {
      expect(stale.length).toBe(0); // detached, never a use-after-free
      expect(rt.V.T.length).toBeGreaterThanOrEqual(300 * 16);
    }
    for (let i = 1; i < els.length; i++) {
      expect(els[i].getAttribute('data-i')).toBe(String(i));
      expect(els[i].parentNode).toBe(i % 10 === 1 ? els[i - 1] : els[i - 1].parentNode);
    }
    expect(document.body.contains(els[299])).toBe(true);
    expect(N.__tableCap()).toBeGreaterThanOrEqual(512);
    rt.reset();
  });

  it('OUT overflow protocol returns 1M ids correctly', () => {
    const n = N.__outSeq(1_000_000);
    expect(n).toBe(1_000_000);
    expect(rt.V.EP[rt.EPI.OUT_NEED]).toBe(1_000_000);
    const ids = rt.outIds(n);
    expect(ids.length).toBe(1_000_000);
    let ok = true;
    for (let i = 0; i < ids.length; i++) if (ids[i] !== i + 1) ok = false;
    expect(ok).toBe(true);
    // Small results fit without the protocol afterwards.
    expect(N.__outSeq(3)).toBe(3);
    expect(rt.V.EP[rt.EPI.OUT_NEED]).toBe(0);
    expect([...rt.outIds(3)]).toEqual([1, 2, 3]);
  });

  it('destroy() followed by init works ten times', () => {
    for (let k = 0; k < 10; k++) {
      rt.reset();
      const { document } = createWindow();
      const p = document.createElement('p');
      p.textContent = `round ${k}`;
      document.body.appendChild(p);
      expect(document.body.firstChild).toBe(p);
      expect(p.textContent).toBe(`round ${k}`);
      expect(rt.V.EP[rt.EPI.NODE_LEN]).toBeLessThan(20);
    }
  });

  it('a Rust panic becomes a JS Error and the process keeps running', () => {
    expect(() => N.__panic('boom')).toThrowError(/rsdom internal: boom/);
    expect(N.__echo(7)).toBe(7);
    const { document } = createWindow();
    expect(document.createElement('div').tagName).toBe('DIV');
  });

  it('untrusted ids never cause UB', () => {
    expect(N.getAttr(0xfffffff, 1)).toBe(null);
    expect(N.appendChild(0x3fffffff, 0x3ffffffe)).not.toBe(0);
    expect(N.textContentGet(123456789)).toBe(null);
    expect(N.rec(99999999)).toBe(false);
    expect(rt.wrap(0x3fffffff)).toBe(null);
  });

  it('string ingress handles long and non-ASCII strings', () => {
    expect(N.__strLen16('a😀b')).toBe(4);
    const long = 'x'.repeat(509) + '😀'.repeat(3);
    expect(N.__strLen16(long)).toBe(long.length);
    expect(N.__strLen16('é'.repeat(5000))).toBe(5000);
  });

  it('Envs are independent per worker thread (no shared statics)', async () => {
    const facade = fileURLToPath(new URL('../../lib/index.cjs', import.meta.url));
    const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { createWindow, rt } = require(workerData.facade);
      const { document } = createWindow();
      const ids = [];
      for (let i = 0; i < 500; i++) {
        const d = document.createElement('div');
        d.id = 'w' + workerData.n + '-' + i;
        document.body.appendChild(d);
      }
      parentPort.postMessage({
        docId: document._i,
        nodeLen: rt.V.EP[rt.EPI.NODE_LEN],
        found: document.getElementById('w' + workerData.n + '-499') !== null,
        foreign: document.getElementById('w' + (workerData.n + 1) + '-1') !== null,
      });`;
    const results = await Promise.all([0, 1, 2].map((n) => new Promise((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { facade, n } });
      w.once('message', resolve);
      w.once('error', reject);
    })));
    for (const r of results) {
      expect(r.found).toBe(true);
      expect(r.foreign).toBe(false);
    }
    // Same id sequence in every worker: each napi_env got its own fresh Env.
    expect(new Set(results.map((r) => `${r.docId}/${r.nodeLen}`)).size).toBe(1);
  });
});
