// Browsing contexts (lib/context.cjs, DESIGN §18): several windows in one env, the current context and what
// follows it (constructors, the focus fast path, MutationObserver error reporting), the URL as one copy,
// and teardown (close() / rt.reset() cancel the context's timers and restore a global).
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');
const context = require('../../lib/context.cjs');

const close = (w) => context.ofWindow(w).close();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => rt.reset());

describe('the current browsing context', () => {
  it('closing the current context makes the previous one current again', () => {
    const a = createWindow({ url: 'http://a.test/' });
    const b = createWindow({ url: 'http://b.test/' });
    // one set of interface objects per env: constructors follow the current context
    expect(new a.window.Text('x').ownerDocument).toBe(b.document);
    close(b.window);
    expect(rt.defaultDocument).toBe(a.document);
    expect(new a.window.Text('x').ownerDocument).toBe(a.document);
    expect(new a.window.Comment('x').ownerDocument).toBe(a.document);
    expect(new a.window.DocumentFragment().ownerDocument).toBe(a.document);
    expect(new a.window.Option('o').ownerDocument).toBe(a.document);
    expect(new a.window.Image().ownerDocument).toBe(a.document);
    expect(new a.window.Range().startContainer).toBe(a.document);
    expect(new a.window.Document().URL).toBe('http://a.test/');
    expect(new a.window.DOMParser().parseFromString('<p>', 'text/html').URL).toBe('http://a.test/');
  });

  it('closing an older context leaves the current one; closing the last leaves none', () => {
    const a = createWindow();
    const b = createWindow();
    close(a.window);
    expect(rt.defaultDocument).toBe(b.document);
    const cb = context.ofWindow(b.window);
    cb.close();
    expect(context.ofWindow(b.window)).toBe(undefined); // closed contexts are forgotten
    cb.close(); // idempotent
    expect(cb.closed).toBe(true);
    expect(rt.defaultDocument).toBe(null);
    expect(() => new b.window.Text('x')).toThrow(TypeError);
  });

  it('main: false opens a context without making it current', () => {
    const a = createWindow();
    const s = createWindow({ main: false });
    expect(rt.defaultDocument).toBe(a.document);
    expect(s.document.defaultView).toBe(s.window);
    close(s.window);
    expect(rt.defaultDocument).toBe(a.document);
  });

  it('the focus fast path (EP[FOCUS]) follows the current context back', () => {
    const a = createWindow();
    const input = a.document.createElement('input');
    a.document.body.append(input);
    input.focus();
    expect(rt.V.EP[rt.EPI.FOCUS]).toBe(input._i);
    const b = createWindow();
    expect(rt.V.EP[rt.EPI.FOCUS]).toBe(0); // b's main document has nothing focused
    expect(a.document.activeElement).toBe(input);
    close(b.window);
    expect(rt.V.EP[rt.EPI.FOCUS]).toBe(input._i);
    expect(a.document.activeElement).toBe(input);
    input.blur();
    expect(a.document.activeElement).toBe(a.document.body);
  });

  it('MutationObserver callback errors go to the current window', async () => {
    const a = createWindow();
    const b = createWindow();
    close(b.window);
    const seen = [];
    a.window.addEventListener('error', (e) => {
      seen.push(e.error.message);
      e.preventDefault();
    });
    const mo = new a.window.MutationObserver(() => {
      throw new Error('boom');
    });
    mo.observe(a.document.body, { childList: true });
    a.document.body.append(a.document.createElement('p'));
    await sleep(0);
    expect(seen).toEqual(['boom']);
  });
});

describe('the document URL', () => {
  it('is one copy: document.URL, location and history agree', () => {
    const { window: w, document: d } = createWindow({ url: 'http://localhost:3000/start?q=1' });
    expect(d.URL).toBe(w.location.href);
    w.history.pushState(null, '', '/next');
    expect([d.URL, w.location.href, w.location.pathname]).toEqual(['http://localhost:3000/next', 'http://localhost:3000/next', '/next']);
    w.location.hash = 'h';
    expect([d.URL, d.documentURI, w.location.hash]).toEqual(['http://localhost:3000/next#h', 'http://localhost:3000/next#h', '#h']);
    w.history.replaceState(null, '', '?r=2');
    expect(d.URL).toBe(w.location.href);
    expect(d.domain).toBe('localhost');
  });

  it('a clone keeps the URL but has no window', () => {
    const { window: w, document: d } = createWindow({ url: 'http://localhost:3000/a' });
    w.history.pushState(null, '', '/b');
    const c = d.cloneNode();
    expect(c.URL).toBe('http://localhost:3000/b');
    expect(c.defaultView).toBe(null);
    expect(c.location).toBe(null);
  });
});

describe('a whole-document source', () => {
  it('is parsed as the context document, doctype and <html> attributes included', () => {
    const ctx = context.open({ url: 'about:blank', source: '<!DOCTYPE html><html lang="pt"><head><title>t</title></head><body><p id=x>hi</p></body></html>' });
    const d = ctx.window.document;
    expect(d).toBe(ctx.document);
    expect(rt.defaultDocument).toBe(d);
    expect(d.doctype.name).toBe('html');
    expect(d.documentElement.getAttribute('lang')).toBe('pt');
    expect(d.title).toBe('t');
    expect(d.getElementById('x').textContent).toBe('hi');
    expect(d.URL).toBe('about:blank');
    expect(ctx.window.document.defaultView).toBe(ctx.window);
  });

  it('cannot be combined with body markup', () => {
    expect(() => context.open({ source: '<p>a</p>', html: '<p>b</p>' })).toThrow(TypeError);
  });
});

describe('teardown', () => {
  it('close() cancels pending animation frames and hashchange tasks', async () => {
    const { window: w } = createWindow();
    let frames = 0;
    let hashchanges = 0;
    w.requestAnimationFrame(() => frames++);
    w.addEventListener('hashchange', () => hashchanges++);
    w.location.hash = '#x';
    close(w);
    await sleep(40);
    expect([frames, hashchanges]).toEqual([0, 0]);
  });

  it('close() cancels queued history traversals (DESIGN §23)', async () => {
    const { window: w } = createWindow();
    let popstates = 0;
    w.addEventListener('popstate', () => popstates++);
    w.history.pushState(1, '', '/a');
    w.history.back();
    close(w);
    await sleep(40);
    expect(popstates).toBe(0);
  });

  it('rt.reset() closes every open context (its timers too)', async () => {
    const { window: w } = createWindow();
    let frames = 0;
    let hashchanges = 0;
    w.requestAnimationFrame(() => frames++);
    w.addEventListener('hashchange', () => hashchanges++);
    w.location.hash = '#x';
    rt.reset();
    expect(context.current()).toBe(null);
    expect(context.ofWindow(w)).toBe(undefined);
    await sleep(40);
    expect([frames, hashchanges]).toEqual([0, 0]);
  });

  it('an open context still delivers its timers', async () => {
    const { window: w } = createWindow();
    const got = [];
    w.requestAnimationFrame(() => got.push('frame'));
    w.addEventListener('hashchange', (e) => got.push(e.newURL));
    w.location.hash = '#x';
    await sleep(40);
    expect(got.sort()).toEqual(['frame', 'http://localhost:3000/#x']);
  });

  it('closing a context on a pre-existing global restores it; reset() does the same for an open one', () => {
    const g = { keep: 1 };
    const keys = Reflect.ownKeys(g);
    context.open({ global: g });
    expect(g.window).toBe(g);
    expect(g.document.defaultView).toBe(g);
    context.ofWindow(g).close();
    expect(Reflect.ownKeys(g)).toEqual(keys);

    const h = { keep: 2 };
    context.open({ global: h, catchErrors: true });
    expect(typeof h.addEventListener).toBe('function');
    rt.reset();
    expect(Reflect.ownKeys(h)).toEqual(['keep']);
  });
});
