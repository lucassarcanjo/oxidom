// The jsdom-compatible programmatic API (ROADMAP Stage 2, DESIGN §31): `new JSDOM(html, options)` from the package
// entry, run side by side with jsdom's own class. jsdom's API test files run in the parity suite (`jsdom-api`).
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const APIS = { jsdom: require('jsdom'), rsdom: require('../../lib/index.cjs') };

describe.each(Object.keys(APIS))('JSDOM class [%s]', (kind) => {
  const { JSDOM, VirtualConsole } = APIS[kind];
  const quiet = () => new VirtualConsole();

  it('parses a whole document and serializes it back', () => {
    const dom = new JSDOM('<!DOCTYPE html><html lang=en><p id=x>hi</p>', { url: 'https://example.com/a?b#c', virtualConsole: quiet() });
    const { document, location } = dom.window;
    expect(document.documentElement.lang).toBe('en');
    expect(document.getElementById('x').textContent).toBe('hi');
    expect(location.href).toBe('https://example.com/a?b#c');
    expect(dom.window instanceof dom.window.Window).toBe(true);
    expect(dom.serialize()).toBe('<!DOCTYPE html><html lang="en"><head></head><body><p id="x">hi</p></body></html>');
    expect(JSDOM.fragment('<b>1</b><i>2</i>').childNodes.length).toBe(2);
  });

  it('checks options like jsdom', () => {
    expect(() => new JSDOM('', { url: 'relative' })).toThrow(TypeError);
    expect(() => new JSDOM('', { contentType: 'text/plain' })).toThrow(RangeError);
    expect(() => new JSDOM('', { runScripts: 'sometimes' })).toThrow(RangeError);
    expect(() => new JSDOM('', { virtualConsole: console })).toThrow(TypeError);
    expect(() => new VirtualConsole().forwardTo(console, { jsdomErrors: 'some' })).toThrow(TypeError);
  });

  it('pretendToBeVisual gates animation frames and page visibility', () => {
    const hidden = new JSDOM('', { virtualConsole: quiet() }).window;
    expect([typeof hidden.requestAnimationFrame, hidden.document.hidden, hidden.document.visibilityState])
      .toEqual(['undefined', true, 'prerender']);
    const visual = new JSDOM('', { pretendToBeVisual: true, virtualConsole: quiet() }).window;
    expect([typeof visual.requestAnimationFrame, visual.document.hidden, visual.document.visibilityState])
      .toEqual(['function', false, 'visible']);
  });

  it('referrer, user agent and storage quota options', () => {
    const { window } = new JSDOM('', {
      url: 'https://example.com/',
      referrer: 'https://REF.example/x',
      resources: { userAgent: 'test agent' },
      storageQuota: 10,
      virtualConsole: quiet(),
    });
    expect(window.document.referrer).toBe('https://ref.example/x');
    expect(window.navigator.userAgent).toBe('test agent');
    window.localStorage.setItem('k', '12345678');
    expect(() => window.localStorage.setItem('k', '1234567890')).toThrow();
  });

  it('the window console, not-implemented methods and uncaught errors go to the virtual console', async () => {
    const vc = new VirtualConsole();
    const seen = [];
    vc.on('log', (...args) => seen.push(['log', ...args]));
    vc.on('jsdomError', (e) => seen.push([e.type, e.message]));
    const { window } = new JSDOM('', { virtualConsole: vc });
    window.console.log('a', 1);
    window.alert('x');
    window.setTimeout(() => {
      throw new Error('boom');
    }, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([
      ['log', 'a', 1],
      ['not-implemented', "Not implemented: Window's alert() method"],
      ['unhandled-exception', 'Uncaught [Error: boom]'],
    ]);
  });

  it('window.close() cancels timers and makes new ones return 0', async () => {
    const { window } = new JSDOM('', { pretendToBeVisual: true, virtualConsole: quiet() });
    let ran = false;
    window.setTimeout(() => {
      ran = true;
    }, 0);
    window.close();
    expect(window.setTimeout(() => {}, 0)).toBe(0);
    expect(window.requestAnimationFrame(() => {})).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);
  });
});
