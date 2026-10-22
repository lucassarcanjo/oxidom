// Custom elements (ROADMAP Stage 4 `custom-elements`, DESIGN §43). The upstream coverage is conformance/parity
// (`--item custom-elements`: WPT custom-elements/*); these cases cover what component libraries rely on: define
// and upgrade (parser, innerHTML, `new`, createElement, clone), the reaction order of the lifecycle callbacks,
// observedAttributes, whenDefined, customized built-ins and `:defined`. Every assertion runs on jsdom, happy-dom
// and rsdom unless pinned; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

// PINNED to jsdom: happy-dom 21 runs callbacks at different points (e.g. connectedCallback before attributeChanged
// on parse) and has no `is` value for createElement.
describe.each(DOMS.filter((k) => k !== 'happy-dom'))('custom elements [%s]', (kind) => {
  let w;
  let d;
  let log;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    log = [];
  });

  /** A logging custom element class observing `observed`. */
  function logging(base = w.HTMLElement, observed = ['a']) {
    return class extends base {
      static get observedAttributes() {
        return observed;
      }
      constructor() {
        super();
        log.push(['ctor', this.localName, this.isConnected]);
      }
      connectedCallback() {
        log.push(['connected', this.localName]);
      }
      disconnectedCallback() {
        log.push(['disconnected', this.localName]);
      }
      adoptedCallback(o, n) {
        log.push(['adopted', this.localName, o === n]);
      }
      attributeChangedCallback(name, old, value) {
        log.push(['attr', name, old, value]);
      }
    };
  }

  it('upgrades parsed elements on define, in document order, then creates new ones synchronously', () => {
    d.body.innerHTML = '<x-a id=one a=1 b=2><x-a id=two></x-a></x-a>';
    const one = d.getElementById('one');
    expect(one).toBeInstanceOf(w.HTMLElement);
    expect(one.constructor).toBe(w.HTMLElement);
    const XA = logging();
    w.customElements.define('x-a', XA);
    expect(one).toBeInstanceOf(XA);
    expect(log).toEqual([
      ['ctor', 'x-a', true],
      ['attr', 'a', null, '1'],
      ['connected', 'x-a'],
      ['ctor', 'x-a', true],
      ['connected', 'x-a'],
    ]);
    log.length = 0;
    const made = d.createElement('x-a');
    expect(made).toBeInstanceOf(XA);
    const viaNew = new XA();
    expect(viaNew.localName).toBe('x-a');
    d.body.innerHTML = '<x-a a=z></x-a>';
    expect(log).toEqual([
      ['ctor', 'x-a', false],
      ['ctor', 'x-a', false],
      // fragment parsing creates in an inert document: the new element is upgraded once inserted, and its
      // reactions come before those of the removed ones (jsdom)
      ['ctor', 'x-a', true],
      ['attr', 'a', null, 'z'],
      ['connected', 'x-a'],
      ['disconnected', 'x-a'],
      ['disconnected', 'x-a'],
    ]);
    expect(w.customElements.get('x-a')).toBe(XA);
    expect(w.customElements.getName(XA)).toBe('x-a');
    expect(w.customElements.get('x-b')).toBe(undefined);
  });

  it('runs callbacks for observed attributes, moves, removals and adoption', () => {
    w.customElements.define('x-b', logging(w.HTMLElement, ['a', 'c']));
    const el = d.createElement('x-b');
    log.length = 0;
    el.setAttribute('a', '1');
    el.setAttribute('b', '1');
    el.setAttribute('a', '1');
    el.toggleAttribute('c');
    el.removeAttribute('a');
    d.body.append(el);
    d.body.append(el);
    el.remove();
    d.implementation.createHTMLDocument('').body.append(el);
    expect(log).toEqual([
      ['attr', 'a', null, '1'],
      ['attr', 'a', '1', '1'],
      ['attr', 'c', null, ''],
      ['attr', 'a', '1', null],
      ['connected', 'x-b'],
      ['disconnected', 'x-b'],
      ['connected', 'x-b'],
      ['disconnected', 'x-b'],
      ['adopted', 'x-b', false],
      ['connected', 'x-b'],
    ]);
  });

  it('reactions run before the DOM call returns, even from inside a callback', () => {
    const order = [];
    w.customElements.define('x-c', class extends w.HTMLElement {
      connectedCallback() {
        order.push(`in ${this.id}`);
        if (this.id === 'outer') this.append(Object.assign(d.createElement('x-c'), { id: 'inner' }));
        order.push(`out ${this.id}`);
      }
    });
    d.body.append(Object.assign(d.createElement('x-c'), { id: 'outer' }));
    order.push('returned');
    expect(order).toEqual(['in outer', 'in inner', 'out inner', 'out outer', 'returned']);
  });

  it('whenDefined, upgrade() and clone construct the right class', async () => {
    const pending = w.customElements.whenDefined('x-d');
    expect(w.customElements.whenDefined('x-d')).toBe(pending);
    const loose = d.createElement('x-d');
    const XD = class extends w.HTMLElement {};
    w.customElements.define('x-d', XD);
    expect(await pending).toBe(XD);
    // not connected: define does not upgrade it, upgrade() does
    expect(loose).not.toBeInstanceOf(XD);
    w.customElements.upgrade(loose);
    expect(loose).toBeInstanceOf(XD);
    expect(loose.cloneNode()).toBeInstanceOf(XD);
    expect(await w.customElements.whenDefined('x-d')).toBe(XD);
  });

  it('customized built-ins use the is value, and :defined follows the element state', () => {
    d.body.innerHTML = '<p is=x-p id=p></p><x-e id=e></x-e><div id=v></div>';
    const ids = () => [...d.body.querySelectorAll(':defined')].map((e) => e.id).join(',');
    expect(ids()).toBe('v');
    const XP = class extends w.HTMLParagraphElement {};
    w.customElements.define('x-p', XP, { extends: 'p' });
    expect(d.getElementById('p')).toBeInstanceOf(XP);
    expect(ids()).toBe('p,v');
    const made = d.createElement('p', { is: 'x-p' });
    expect(made).toBeInstanceOf(XP);
    expect(made.outerHTML).toBe('<p is="x-p"></p>');
    expect(d.getElementById('e').matches(':not(:defined)')).toBe(true);
    w.customElements.define('x-e', class extends w.HTMLElement {});
    expect(d.getElementById('e').matches(':defined')).toBe(true);
  });

  it('rejects bad names, duplicates and failed constructors like jsdom', () => {
    const C = class extends w.HTMLElement {};
    expect(errName(() => w.customElements.define('nohyphen', C))).toBe('SyntaxError');
    expect(errName(() => w.customElements.define('font-face', C))).toBe('SyntaxError');
    w.customElements.define('x-f', C);
    expect(errName(() => w.customElements.define('x-g', C))).toBe('NotSupportedError');
    expect(errName(() => w.customElements.define('x-f', class extends w.HTMLElement {}))).toBe('NotSupportedError');
    expect(errName(() => new w.HTMLElement())).toBe('TypeError');
    expect(errName(() => w.customElements.define('x-h', () => {}))).toBe('TypeError');
    // a constructor that throws during an upgrade leaves the element "failed" (reported, not thrown)
    d.body.innerHTML = '<x-i></x-i>';
    const errors = [];
    w.addEventListener('error', (e) => {
      errors.push(e.error.message);
      e.preventDefault();
    });
    w.customElements.define('x-i', class extends w.HTMLElement {
      constructor() {
        super();
        throw new Error('boom');
      }
    });
    expect(errors).toEqual(['boom']);
  });
});
