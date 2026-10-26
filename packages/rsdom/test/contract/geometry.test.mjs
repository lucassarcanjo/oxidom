// DOMRect and the remaining Window members (ROADMAP Stage 3 `geometry`, DESIGN §40), as layout mocks
// (`new DOMRect(...)` in getBoundingClientRect stubs), floating-ui and postMessage-based code use them.
// jsdom is the oracle.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('geometry and Window members [%s]', (kind) => {
  let w;
  beforeEach(() => {
    w = makeWindow(kind);
  });

  it('DOMRect: edges, toJSON, fromRect, read-only base class', () => {
    const r = new w.DOMRect(10, 20, -4, 8);
    expect([r.top, r.right, r.bottom, r.left]).toEqual([20, 10, 28, 6]);
    r.width = 30;
    expect(r.right).toBe(40);
    expect(r.toJSON()).toEqual({ x: 10, y: 20, width: 30, height: 8, top: 20, right: 40, bottom: 28, left: 10 });
    expect(w.DOMRect.fromRect({ x: 1, height: 2 })).toBeInstanceOf(w.DOMRectReadOnly);
    const ro = new w.DOMRectReadOnly(1, 2, 3, 4);
    expect(() => {
      'use strict';
      ro.x = 9;
    }).toThrow(TypeError);
    expect(ro.x).toBe(1);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's has no @@toStringTag
    expect(String(r)).toBe('[object DOMRect]');
  });

  it('postMessage dispatches a message event on the window asynchronously', async () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom sets origin and source
    const got = [];
    w.addEventListener('message', (e) => got.push([e.data, e.origin, e.source, e.isTrusted]));
    w.postMessage({ a: 1 }, '*');
    w.postMessage('dropped', 'http://other.example'); // another origin: not delivered
    expect(got).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([[{ a: 1 }, '', null, true]]);
    expect(() => w.postMessage(1)).toThrow(/2 arguments/);
  });

  it('bars, external, plugins, name, length, status, Audio', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom lacks most of these
    expect(w.locationbar.visible).toBe(true);
    expect(w.toolbar).toBeInstanceOf(w.BarProp);
    expect(w.external.IsSearchProviderInstalled()).toBe(undefined);
    expect(w.navigator.plugins.length).toBe(0);
    expect(w.navigator.plugins).toBe(w.navigator.plugins);
    expect(w.navigator.mimeTypes.namedItem('application/pdf')).toBe(null);
    expect([w.name, w.length, w.status]).toEqual(['', 0, '']);
    const a = new w.Audio('song.mp3');
    expect(a).toBeInstanceOf(w.HTMLAudioElement);
    expect(a.getAttribute('preload')).toBe('auto');
    expect(a.getAttribute('src')).toBe('song.mp3');
  });

  it('CloseEvent, PromiseRejectionEvent, BlobEvent', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const c = new w.CloseEvent('close', { code: 1000, reason: 'bye', wasClean: true });
    expect([c.code, c.reason, c.wasClean]).toEqual([1000, 'bye', true]);
    const p = Promise.resolve();
    expect(new w.PromiseRejectionEvent('unhandledrejection', { promise: p, reason: 'x' }).promise).toBe(p);
    expect(() => new w.PromiseRejectionEvent('unhandledrejection', {})).toThrow(/promise is required/);
    expect(new w.BlobEvent('dataavailable', { data: new w.Blob(['a']) }).data.size).toBe(1);
  });
});
