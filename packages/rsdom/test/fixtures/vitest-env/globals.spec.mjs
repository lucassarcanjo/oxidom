// The rsdom environment's globals (DESIGN §12): own data properties, window === globalThis, Node's runtime
// globals kept, window plumbing.
import { test, expect } from 'vitest';
import { performance as nodePerformance } from 'node:perf_hooks';

const own = (k) => Object.getOwnPropertyDescriptor(globalThis, k);

test('window aliases and document', () => {
  for (const k of ['window', 'self', 'top', 'parent', 'frames']) expect(globalThis[k]).toBe(globalThis);
  expect(document.defaultView).toBe(globalThis);
  expect(document.body.ownerDocument.defaultView).toBe(window);
  expect(document.documentElement.tagName).toBe('HTML');
  expect(document.location).toBe(location);
});

test('globals are own data properties (not accessors)', () => {
  for (const k of ['document', 'window', 'HTMLElement', 'Node', 'MutationObserver', 'getComputedStyle', 'navigator', 'location']) {
    const d = own(k);
    expect(d, k).toBeDefined();
    expect('value' in d, k).toBe(true);
    expect(d.writable && d.configurable, k).toBe(true);
  }
});

test("Node's runtime globals are kept", () => {
  expect(performance).toBe(nodePerformance);
  expect(typeof setImmediate).toBe('function');
  expect(typeof queueMicrotask).toBe('function');
  expect(typeof MessageChannel).toBe('function');
  expect(typeof AbortController).toBe('function');
  expect(typeof structuredClone).toBe('function');
  expect(typeof fetch).toBe('function');
  expect(typeof Blob).toBe('function');
  expect(new URL('/x', location.href).href).toBe('http://localhost:3000/x');
  expect(typeof crypto.randomUUID).toBe('function');
  expect(new DOMException('m', 'NotFoundError').name).toBe('NotFoundError');
});

test('interfaces build the nodes (instanceof through defaultView)', () => {
  const el = document.createElement('div');
  expect(el).toBeInstanceOf(HTMLElement);
  expect(el).toBeInstanceOf(window.Node);
  expect(document.createElementNS('http://www.w3.org/2000/svg', 'svg')).toBeInstanceOf(SVGElement);
  expect(typeof HTMLIFrameElement).toBe('function');
  expect(document.createElement('iframe')).toBeInstanceOf(HTMLIFrameElement);
  expect(Object.prototype.toString.call(el)).toBe('[object HTMLDivElement]');
  expect(new DOMParser().parseFromString('<p>x</p>', 'text/html').body.textContent).toBe('x');
});

test('window plumbing', async () => {
  expect(location.href).toBe('http://localhost:3000/start?q=1#top');
  expect(location.protocol).toBe('http:');
  expect(location.origin).toBe('http://localhost:3000');
  expect(document.URL).toBe(location.href);
  location.hash = '#next';
  expect(location.href).toBe('http://localhost:3000/start?q=1#next');
  location.href = 'http://example.com/'; // cross-document navigation: not implemented (jsdom keeps the URL too)
  expect(location.host).toBe('localhost:3000');
  history.pushState({ a: 1 }, '', '/other');
  expect(location.pathname).toBe('/other');
  expect(document.URL).toBe('http://localhost:3000/other');
  expect(history.state).toEqual({ a: 1 });
  expect(() => history.pushState(null, '', 'http://example.com/')).toThrow(DOMException);
  expect(navigator.userAgent).not.toMatch(/Chrome|Firefox|Edge/);
  expect(navigator.language).toBe('en-US');
  localStorage.setItem('k', 1);
  expect(localStorage.getItem('k')).toBe('1');
  expect(localStorage.length).toBe(1);
  expect(localStorage.key(0)).toBe('k');
  localStorage.clear();
  expect(sessionStorage.getItem('k')).toBe(null);
  expect(innerWidth).toBe(1024);
  expect(innerHeight).toBe(768);
  expect(devicePixelRatio).toBe(1);
  expect(screen.colorDepth).toBe(24);
  expect(matchMedia('(min-width: 100px)').matches).toBe(false);
  expect(matchMedia('(min-width: 100px)').media).toBe('(min-width: 100px)');
  scrollTo(0, 100);
  expect(CSS.escape('a b#1')).toBe('a\\ b\\#1');
  expect(CSS.escape('1x')).toBe('\\31 x');
  const sel = getSelection();
  expect(sel).toBe(document.getSelection());
  expect(sel.anchorNode).toBe(null);
  expect(sel.rangeCount).toBe(0);
  const t = await new Promise((r) => requestAnimationFrame(r));
  expect(typeof t).toBe('number');
  const id = requestAnimationFrame(() => {
    throw new Error('cancelled frame ran');
  });
  cancelAnimationFrame(id);
  document.cookie = 'a=1; path=/';
  document.cookie = 'b=2';
  expect(document.cookie).toBe('a=1; b=2');
  document.cookie = 'a=; max-age=0';
  expect(document.cookie).toBe('b=2');
});

test('XMLHttpRequest globals (axios picks its xhr adapter, msw 3 patches the configurable global)', () => {
  for (const k of ['XMLHttpRequest', 'XMLHttpRequestUpload', 'XMLHttpRequestEventTarget']) {
    const d = own(k);
    expect(d, k).toBeDefined();
    expect({ value: 'value' in d, w: d.writable, e: d.enumerable, c: d.configurable }, k).toEqual({ value: true, w: true, e: false, c: true });
  }
  const x = new XMLHttpRequest();
  expect(x.upload).toBeInstanceOf(XMLHttpRequestUpload);
  expect(x).toBeInstanceOf(EventTarget);
  expect('onloadend' in x).toBe(true);
  x.open('GET', '/x');
  expect(x.readyState).toBe(XMLHttpRequest.OPENED);
});

test('React feature-detection prerequisites', () => {
  expect(window.event).toBe(undefined);
  expect('documentMode' in document).toBe(false);
  expect('TextEvent' in window).toBe(false);
  expect('reportError' in window).toBe(false);
  expect(typeof window.addEventListener).toBe('function');
  expect(typeof FormData).toBe('function');
  expect(new FormData()).toBeInstanceOf(FormData);
});

test('unimplemented names are not defined', () => {
  for (const k of ['customElements', 'DataTransfer', 'requestIdleCallback']) {
    expect(k in globalThis, k).toBe(false);
  }
});

test("observers are globals a test's own polyfill replaces (DESIGN §24)", () => {
  expect(typeof ResizeObserver).toBe('function');
  expect(window.IntersectionObserver).toBe(IntersectionObserver);
  const Mine = class {};
  globalThis.ResizeObserver = Mine;
  expect(window.ResizeObserver).toBe(Mine);
  expect(new ResizeObserver()).toBeInstanceOf(Mine);
});

test('diagnostics handle', () => {
  expect(typeof __rsdom.moStats.ticks).toBe('number');
  expect(typeof __rsdom.counters().enabled).toBe('boolean');
  expect(Object.keys(globalThis)).not.toContain('__rsdom');
});
