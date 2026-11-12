// Window plumbing parity (area C): location, history, storage, cookies, navigator, selection stub, geometry
// constants, rAF, CSS.escape. jsdom (url http://localhost:3000/, pretendToBeVisual) is the oracle.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('window [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('self references and document.defaultView', () => {
    expect(w.window).toBe(w);
    expect(w.self).toBe(w);
    expect(w.top).toBe(w);
    expect(w.parent).toBe(w);
    expect(d.defaultView).toBe(w);
    expect(d.createElement('div').ownerDocument.defaultView).toBe(w);
    const parsed = new w.DOMParser().parseFromString('<p>x</p>', 'text/html');
    if (kind !== 'happy-dom') expect(parsed.defaultView).toBe(null); // PINNED to jsdom: happy-dom links the window
  });

  it('location', () => {
    expect(w.location.href).toBe('http://localhost:3000/');
    expect(w.location.origin).toBe('http://localhost:3000');
    expect(w.location.protocol).toBe('http:');
    expect(w.location.host).toBe('localhost:3000');
    expect(w.location.hostname).toBe('localhost');
    expect(w.location.port).toBe('3000');
    expect(w.location.pathname).toBe('/');
    expect(w.location.search).toBe('');
    expect(w.location.hash).toBe('');
    expect(String(w.location)).toBe('http://localhost:3000/');
    expect(d.location).toBe(w.location);
    w.location.hash = 'sec';
    expect(w.location.hash).toBe('#sec');
    expect(w.location.href).toBe('http://localhost:3000/#sec');
    expect(d.URL).toBe('http://localhost:3000/#sec');
  });

  it('history.pushState / replaceState', () => {
    expect(w.history.length).toBe(1);
    expect(w.history.state).toBe(null);
    w.history.pushState({ n: 1 }, '', '/a?x=1');
    expect(w.location.pathname).toBe('/a');
    expect(w.location.search).toBe('?x=1');
    expect(w.history.state).toEqual({ n: 1 });
    expect(w.history.length).toBe(2);
    w.history.replaceState(null, '', 'b');
    expect(w.location.pathname).toBe('/b');
    expect(w.history.state).toBe(null);
    expect(w.history.length).toBe(2);
    expect(d.URL).toBe('http://localhost:3000/b');
    expect(errName(() => w.history.pushState(null, '', 'http://other.example/'))).toBe('SecurityError');
  });

  it('localStorage / sessionStorage', () => {
    const s = w.localStorage;
    s.clear();
    expect(s.length).toBe(0);
    s.setItem('a', 1);
    s.setItem('b', { toString: () => 'B' });
    expect(s.getItem('a')).toBe('1');
    expect(s.getItem('b')).toBe('B');
    expect(s.getItem('missing')).toBe(null);
    expect(s.length).toBe(2);
    expect(s.key(0)).toBe('a');
    expect(s.key(5)).toBe(null);
    s.removeItem('a');
    expect(s.length).toBe(1);
    s.clear();
    expect(s.length).toBe(0);
    expect(w.sessionStorage).not.toBe(s);
    expect(typeof w.Storage).toBe('function');
    expect(s instanceof w.Storage).toBe(true);
  });

  it('document.cookie', () => {
    d.cookie = 'a=1';
    d.cookie = 'b=two; path=/';
    expect(d.cookie).toBe('a=1; b=two');
    d.cookie = 'a=3';
    if (kind !== 'happy-dom') expect(d.cookie).toBe('a=3; b=two'); // PINNED to jsdom: happy-dom re-appends updated cookies
    d.cookie = 'b=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    if (kind !== 'happy-dom') expect(d.cookie).toBe('a=3'); // PINNED to jsdom: happy-dom keeps expired cookies
  });

  it('navigator, screen and geometry constants', () => {
    expect(w.navigator.userAgent).toMatch(/^Mozilla\/5\.0 /);
    expect(w.navigator.userAgent).not.toMatch(/Chrome|Firefox|Edge/);
    expect(w.navigator.language).toBe('en-US');
    expect(w.navigator.cookieEnabled).toBe(true);
    expect(w.navigator.onLine).toBe(true);
    expect(w.innerWidth).toBe(1024);
    expect(w.innerHeight).toBe(768);
    expect(w.devicePixelRatio).toBe(1);
    expect(w.scrollX).toBe(0);
    expect(w.pageYOffset).toBe(0);
    expect(typeof w.scrollTo).toBe('function');
    w.scrollTo(0, 50);
    if (kind !== 'happy-dom') expect(w.screen.width).toBe(0); // PINNED to jsdom (no screen geometry); happy-dom 1024
    expect(w.screen.colorDepth).toBe(24);
    expect(d.visibilityState).toBe('visible');
    expect(d.hidden).toBe(false);
    expect(d.referrer).toBe('');
  });

  it('getSelection starts empty and collapses', () => {
    const sel = w.getSelection();
    expect(sel).toBe(d.getSelection());
    expect(sel.anchorNode).toBe(null);
    expect(sel.focusNode).toBe(null);
    expect(sel.anchorOffset).toBe(0);
    expect(sel.rangeCount).toBe(0);
    expect(sel.isCollapsed).toBe(true);
    expect(sel.toString()).toBe('');
    expect(errName(() => sel.getRangeAt(0))).toBe('IndexSizeError');
    const p = d.createElement('p');
    d.body.appendChild(p);
    sel.collapse(p, 0);
    expect(sel.anchorNode).toBe(p);
    expect(sel.focusNode).toBe(p);
    sel.removeAllRanges();
    expect(sel.anchorNode).toBe(null);
  });

  it('requestAnimationFrame runs callbacks with a timestamp; cancel works', async () => {
    const t = await new Promise((r) => w.requestAnimationFrame(r));
    expect(typeof t).toBe('number');
    let ran = false;
    const id = w.requestAnimationFrame(() => {
      ran = true;
    });
    if (kind !== 'happy-dom') expect(typeof id).toBe('number'); // PINNED to jsdom: happy-dom returns a Timeout
    w.cancelAnimationFrame(id);
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).toBe(false);
  });

  it('interfaces exposed on the window', () => {
    for (const k of ['Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'HTMLInputElement', 'SVGElement', 'Text', 'DocumentFragment', 'MutationObserver', 'DOMParser']) {
      expect(typeof w[k], k).toBe('function');
    }
    expect(d.createElement('iframe') instanceof w.HTMLIFrameElement).toBe(true);
    if (kind === 'oxidom') {
      // oxidom-only: jsdom has neither matchMedia nor CSS.escape
      expect(w.matchMedia('(min-width: 1px)').matches).toBe(false);
      expect(w.CSS.escape('#a.b')).toBe('\\#a\\.b');
      expect(w.CSS.escape('-1')).toBe('-\\31 ');
      expect(w.CSS.escape('\0')).toBe('�');
    }
  });
});
