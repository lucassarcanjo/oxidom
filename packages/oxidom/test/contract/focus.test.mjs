// Focus contract (ROADMAP M5): event order oracle (docs/lab/research/jsdom.md §6.9), focusability, activeElement,
// focus fixup on removal (no blur), tabIndex defaults.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('focus [%s]', (kind) => {
  let w;
  let d;
  const jsdomLike = kind !== 'happy-dom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    d.body.innerHTML = '<input id="a"><input id="b"><div id="plain">p</div><div id="ti" tabindex="-1">t</div>'
      + '<button id="dis" disabled>x</button><a id="link" href="/x">l</a><a id="nolink">n</a>';
  });
  const $ = (id) => d.getElementById(id);

  function record() {
    const log = [];
    const name = (n) => (n === null ? 'null' : n.id || n.nodeName);
    for (const type of ['focus', 'blur', 'focusin', 'focusout']) {
      d.addEventListener(type, (e) => {
        log.push(`${type}:${name(e.target)} active=${name(d.activeElement)} related=${name(e.relatedTarget)}`
          + ` ${e.constructor.name} bubbles=${e.bubbles}`);
      }, true);
    }
    return log;
  }

  it('event order oracle: blur -> focusout -> focus -> focusin with relatedTarget', () => {
    const log = record();
    expect(d.activeElement).toBe(d.body);
    $('a').focus();
    $('b').focus();
    $('b').blur();
    const expected = [
      'focus:a active=a related=null FocusEvent bubbles=false',
      'focusin:a active=a related=null FocusEvent bubbles=true',
      'blur:a active=BODY related=b FocusEvent bubbles=false',
      'focusout:a active=BODY related=b FocusEvent bubbles=true',
      'focus:b active=b related=a FocusEvent bubbles=false',
      'focusin:b active=b related=a FocusEvent bubbles=true',
      'blur:b active=BODY related=null FocusEvent bubbles=false',
      'focusout:b active=BODY related=null FocusEvent bubbles=true',
    ];
    if (jsdomLike) expect(log).toEqual(expected); // PINNED to jsdom: happy-dom updates activeElement later
    expect(d.activeElement).toBe(d.body);
  });

  it('focusing the focused element is a no-op; blur of a non-focused element is a no-op', () => {
    $('a').focus();
    const log = record();
    $('a').focus();
    $('b').blur();
    expect(log).toEqual([]);
    expect(d.activeElement).toBe($('a'));
  });

  it('focusability gates', () => {
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom focuses any element
    $('plain').focus();
    expect(d.activeElement).toBe(d.body);
    $('ti').focus();
    expect(d.activeElement).toBe($('ti'));
    $('dis').focus();
    expect(d.activeElement).toBe($('ti'));
    $('link').focus();
    expect(d.activeElement).toBe($('link'));
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom focuses detached / href-less anchors
      $('nolink').focus();
      expect(d.activeElement).toBe($('link'));
      const detached = d.createElement('input');
      detached.focus();
      expect(d.activeElement).toBe($('link'));
    }
    const fs = d.createElement('fieldset');
    fs.disabled = true;
    const inner = d.createElement('input');
    fs.appendChild(inner);
    d.body.appendChild(fs);
    inner.focus();
    if (jsdomLike) expect(d.activeElement).toBe($('link')); // PINNED to jsdom
  });

  it('removing the focused element (or an ancestor) moves focus to body without blur', () => {
    d.body.innerHTML = '<div id="wrap"><input id="x"></div><input id="y">';
    $('x').focus();
    expect(d.activeElement).toBe($('x'));
    let blurred = 0;
    $('x').addEventListener('blur', () => blurred++);
    $('x').addEventListener('focusout', () => blurred++);
    $('wrap').remove();
    expect(d.activeElement).toBe(d.body);
    expect(blurred).toBe(0);
    $('y').focus();
    $('y').remove();
    expect(d.activeElement).toBe(d.body);
    // re-inserting does not restore focus
    d.body.appendChild($('y') ?? d.createElement('input'));
    expect(d.activeElement).toBe(d.body);
  });

  it('a blur listener that moves focus wins', () => {
    $('a').focus();
    $('a').addEventListener('blur', () => $('link').focus());
    $('b').focus();
    if (jsdomLike) expect(d.activeElement).toBe($('link')); // PINNED to jsdom
  });

  it('tabIndex defaults and reflection', () => {
    const mk = (t) => d.createElement(t).tabIndex;
    expect([mk('input'), mk('button'), mk('a'), mk('select'), mk('textarea'), mk('div'), mk('span')]).toEqual([0, 0, 0, 0, 0, -1, -1]);
    const div = d.createElement('div');
    div.setAttribute('tabindex', 'abc');
    if (jsdomLike) expect(div.tabIndex).toBe(0); // PINNED to jsdom
    div.tabIndex = 3;
    expect([div.tabIndex, div.getAttribute('tabindex')]).toEqual([3, '3']);
  });

  it('focus() exists on HTMLElement.prototype and SVGElement.prototype', () => {
    expect(Object.prototype.hasOwnProperty.call(w.HTMLElement.prototype, 'focus')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(w.HTMLElement.prototype, 'blur')).toBe(true);
    if (jsdomLike) expect(typeof w.SVGElement.prototype.focus).toBe('function'); // PINNED to jsdom
  });
});
