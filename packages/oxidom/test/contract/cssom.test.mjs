// CSSOM rule objects (ROADMAP Stage 3 `cssom`, DESIGN §35): document.styleSheets, <style>.sheet, insertRule /
// deleteRule / cssRules as CSS-in-JS libraries use them (emotion, styled-components speedy mode), rule
// objects, constructable sheets and CSS.supports. jsdom is the oracle.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('CSSOM [%s]', (kind) => {
  let w;
  let d;
  let style;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    style = d.createElement('style');
    d.head.appendChild(style);
  });

  it('a connected <style> has a sheet listed in document.styleSheets', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's CSSOM differs here
    expect(style.sheet).toBeInstanceOf(w.CSSStyleSheet);
    expect(d.styleSheets.length).toBe(1);
    expect(d.styleSheets[0]).toBe(style.sheet);
    expect(style.sheet.ownerNode).toBe(style);
    style.remove();
    expect(style.sheet).toBe(null);
    expect(d.styleSheets.length).toBe(0);
  });

  it('cssRules reflect the text; a text change makes a new sheet', () => {
    style.textContent = '.a { color: red } @media screen { .b { color: blue } }';
    const sheet = style.sheet;
    expect(sheet.cssRules.length).toBe(2);
    const [a, m] = sheet.cssRules;
    expect(a.type).toBe(1);
    expect(a.selectorText).toBe('.a');
    expect(a.style.color).toBe('red');
    expect(a.cssText).toBe('.a { color: red; }');
    expect(a.parentStyleSheet).toBe(sheet);
    expect(m).toBeInstanceOf(w.CSSMediaRule);
    expect(m.media.mediaText).toBe('screen');
    expect(m.cssRules[0].parentRule).toBe(m);
    style.textContent = '.c {}';
    if (kind !== 'happy-dom') expect(style.sheet).not.toBe(sheet); // PINNED to jsdom
    expect(style.sheet.cssRules[0].selectorText).toBe('.c');
  });

  it('insertRule / deleteRule drive the cascade (emotion / styled-components speedy mode)', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's CSSOM differs here
    const el = d.createElement('div');
    el.className = 'x';
    d.body.appendChild(el);
    const sheet = style.sheet;
    expect(sheet.insertRule('.x { display: none }', 0)).toBe(0);
    expect(sheet.insertRule('.y { color: red }', sheet.cssRules.length)).toBe(1);
    expect(w.getComputedStyle(el).display).toBe('none');
    sheet.deleteRule(0);
    expect(sheet.cssRules.length).toBe(1);
    expect(w.getComputedStyle(el).display).toBe('block');
    expect(style.textContent).toBe(''); // the CSSOM does not write back to the text
  });

  it('insertRule validates like jsdom', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's CSSOM differs here
    const sheet = style.sheet;
    expect(() => sheet.insertRule('.a {}', 5)).toThrow();
    expect(() => sheet.deleteRule(3)).toThrow();
    sheet.insertRule('.a {}');
    expect(() => sheet.insertRule('@import url(x.css);', 1)).toThrow(); // @import after a style rule
    expect(sheet.insertRule('@import url(x.css);', 0)).toBe(0);
    expect(sheet.cssRules.length).toBe(2);
  });

  it('rule.style writes reach the cascade; selectorText setter re-targets', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's CSSOM differs here
    const el = d.createElement('p');
    d.body.appendChild(el);
    style.textContent = '.nope { display: none }';
    const r = style.sheet.cssRules[0];
    expect(w.getComputedStyle(el).display).toBe('block');
    r.selectorText = 'p';
    expect(r.selectorText).toBe('p');
    expect(w.getComputedStyle(el).display).toBe('none');
    r.style.setProperty('display', 'inline');
    expect(r.style.getPropertyValue('display')).toBe('inline');
    expect(w.getComputedStyle(el).display).toBe('inline');
    r.selectorText = '!!';
    expect(r.selectorText).toBe('p');
  });

  it('@keyframes rules: keyText normalization, appendRule, findRule', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's CSSOM differs here
    style.textContent = '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }';
    const k = style.sheet.cssRules[0];
    expect(k).toBeInstanceOf(w.CSSKeyframesRule);
    expect(k.name).toBe('spin');
    expect([...k.cssRules].map((r) => r.keyText)).toEqual(['0%', '100%']);
    k.appendRule('50% { opacity: 0.5 }');
    expect(k.cssRules.length).toBe(3);
    expect(k.findRule('50%').style.opacity).toBe('0.5');
    k.deleteRule('from');
    expect(k.cssRules.length).toBe(2);
  });

  it('constructable sheets: replaceSync, not in document.styleSheets', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's CSSOM differs here
    const s = new w.CSSStyleSheet();
    s.replaceSync('.a { color: red } .b { color: blue }');
    expect(s.cssRules.length).toBe(2);
    expect(s.ownerNode).toBe(null);
    expect(d.styleSheets.length).toBe(1);
    const old = s.cssRules[0];
    s.replaceSync('');
    expect(s.cssRules.length).toBe(0);
    expect(old.parentStyleSheet).toBe(null);
  });

  it('CSS.supports', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    expect(w.CSS.supports('color', 'red')).toBe(true);
    expect(w.CSS.supports('color', 'nonsense')).toBe(false);
    expect(w.CSS.supports('not-a-property', '1')).toBe(false);
    expect(w.CSS.supports('--anything', 'x')).toBe(true);
    expect(w.CSS.supports('(display: grid) and (not (display: nonsense))')).toBe(true);
    expect(w.CSS.supports('(display: nonsense) or (color: red)')).toBe(true);
    expect(w.CSS.supports('display: grid')).toBe(true);
    expect(Object.prototype.toString.call(w.CSS)).toBe('[object CSS]');
  });

  it('MediaList on a <style media>', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const s = d.createElement('style');
    s.media = 'screen, PRINT';
    d.head.appendChild(s);
    const m = s.sheet.media;
    expect(m.mediaText).toBe('screen, print');
    m.appendMedium('screen');
    expect(m.length).toBe(2);
    m.deleteMedium('screen');
    expect(m.mediaText).toBe('print');
    expect(() => m.deleteMedium('tv')).toThrow();
  });
});
