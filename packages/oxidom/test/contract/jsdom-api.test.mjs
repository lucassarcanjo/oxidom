// The jsdom-compatible programmatic API (ROADMAP Stage 2, DESIGN §31): `new JSDOM(html, options)` from the package
// entry, run side by side with jsdom's own class. jsdom's API test files run in the parity suite (`jsdom-api`).
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const APIS = { jsdom: require('jsdom'), oxidom: require('../../lib/index.cjs') };

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

describe('JSDOM class: several instances [oxidom]', () => {
  const { JSDOM, VirtualConsole, createWindow } = APIS.oxidom;
  const quiet = () => new VirtualConsole();

  it('a JSDOM made while a global window is open does not take over `new Text()`', () => {
    const g = createWindow({ global: {} });
    const doc = g.document;
    new JSDOM('<p>helper</p>', { virtualConsole: quiet() });
    expect(new g.window.Text('a').ownerDocument).toBe(doc);
    g.window.document._ctx.close();
  });

  it('a closed window stays a window, and MutationObserver errors reach the observed instance', async () => {
    const seen = [];
    const vc1 = new VirtualConsole().on('jsdomError', (e) => seen.push(['d1', e.type]));
    const vc2 = new VirtualConsole().on('jsdomError', (e) => seen.push(['d2', e.type]));
    const d1 = new JSDOM('<p>x</p>', { virtualConsole: vc1 });
    new JSDOM('', { virtualConsole: vc2 });
    const p = d1.window.document.querySelector('p');
    new d1.window.MutationObserver(() => {
      throw new Error('mo');
    }).observe(p, { attributes: true });
    p.setAttribute('a', '1');
    await Promise.resolve();
    expect(seen).toEqual([['d1', 'unhandled-exception']]);
    d1.window.close();
    expect(d1.window instanceof d1.window.Window).toBe(true);
    expect(() => p.click()).not.toThrow();
  });

  it('decodes binary input by BOM, content type charset and <meta charset>', () => {
    const text = (input, options = {}) => new JSDOM(input, { virtualConsole: quiet(), ...options }).window.document.querySelector('p').textContent;
    expect(text(Buffer.from('<meta charset=windows-1252><p>caf\xe9', 'latin1'))).toBe('café');
    expect(text(Buffer.from('<p>caf\xe9', 'latin1'), { contentType: 'text/html; charset=iso-8859-1' })).toBe('café');
    expect(text(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>hi', 'utf16le')]))).toBe('hi');
    expect(text(Buffer.from('<p>café', 'utf8'))).toBe('café');
  });
});
