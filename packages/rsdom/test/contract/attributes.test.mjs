// Attribute oracles (docs/lab/research/jsdom.md §2.2, §6.7 string reflection, §6.10 case rules / order) on all DOMs.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
const XML = 'http://www.w3.org/XML/1998/namespace';

describe.each(DOMS)('attributes [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('insertion order; re-setting keeps the position; same-value set', () => {
    const e = d.createElement('div');
    e.setAttribute('b', '1');
    e.setAttribute('a', '2');
    e.setAttribute('b', '3');
    expect([...e.attributes].map((x) => `${x.name}=${x.value}`).join(',')).toBe('b=3,a=2');
    e.setAttribute('a', '2');
    expect(e.getAttribute('a')).toBe('2');
    expect(e.getAttributeNames()).toEqual(['b', 'a']);
    expect(e.hasAttributes()).toBe(true);
    expect(d.createElement('p').hasAttributes()).toBe(false);
  });

  it('HTML case rules: lowercase for HTML elements in HTML documents only', () => {
    const e = d.createElement('div');
    e.setAttribute('ARIA-Label', 'x');
    expect(e.getAttributeNames()).toEqual(['aria-label']);
    expect(e.getAttribute('aria-LABEL')).toBe('x');
    expect(e.hasAttribute('ARIA-label')).toBe(true);
    const s = d.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 1 1');
    expect(s.getAttributeNames()).toEqual(['viewBox']);
    expect(s.getAttribute('viewbox')).toBe(null);
    expect(s.getAttribute('viewBox')).toBe('0 0 1 1');
    expect(d.createElement('Div').tagName).toBe('DIV');
    expect(d.createElement('Div').localName).toBe('div');
    expect(d.createElementNS(SVG, 'foreignObject').tagName).toBe('foreignObject');
  });

  it('get/has/remove/toggle', () => {
    const e = d.createElement('div');
    expect(e.getAttribute('nope')).toBe(null);
    expect(e.hasAttribute('nope')).toBe(false);
    e.setAttribute('data-x', 'y');
    e.removeAttribute('data-x');
    expect(e.hasAttribute('data-x')).toBe(false);
    e.removeAttribute('data-x');
    expect(e.toggleAttribute('hidden')).toBe(true);
    expect(e.getAttribute('hidden')).toBe('');
    expect(e.toggleAttribute('hidden', true)).toBe(true);
    expect(e.toggleAttribute('hidden')).toBe(false);
    expect(e.toggleAttribute('hidden', false)).toBe(false);
    expect(e.hasAttribute('hidden')).toBe(false);
    e.setAttribute('n', 5);
    expect(e.getAttribute('n')).toBe('5');
    e.setAttribute('u', undefined);
    expect(e.getAttribute('u')).toBe('undefined');
    e.setAttribute('e', '');
    expect(e.getAttribute('e')).toBe('');
    e.setAttribute('uni', 'ü😀');
    expect(e.getAttribute('uni')).toBe('ü😀');
  });

  it('invalid names throw InvalidCharacterError', () => {
    const e = d.createElement('div');
    expect(errName(() => e.setAttribute('a b', '1'))).toBe('InvalidCharacterError');
    expect(errName(() => e.setAttribute('', '1'))).toBe('InvalidCharacterError');
    expect(errName(() => e.setAttribute('a=b', '1'))).toBe('InvalidCharacterError');
    expect(errName(() => e.toggleAttribute('a>b'))).toBe('InvalidCharacterError');
    if (kind !== 'happy-dom') expect(errName(() => d.createElement('a b'))).toBe('InvalidCharacterError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.createElement(''))).toBe('InvalidCharacterError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.createElement('1a'))).toBe('InvalidCharacterError'); // PINNED to jsdom: happy-dom 21 diverges
    // relaxed (2025) name rules: these are valid now
    expect(errName(() => e.setAttribute('@click', '1'))).toBe('ok');
    if (kind !== 'happy-dom') expect(errName(() => d.createElementNS(null, 'x:y'))).toBe('NamespaceError'); // PINNED to jsdom: happy-dom 21 diverges
  });

  it('id / className reflection', () => {
    const e = d.createElement('div');
    expect(e.id).toBe('');
    expect(e.className).toBe('');
    e.id = 'x';
    e.className = 'a  b';
    expect(e.getAttribute('id')).toBe('x');
    expect(e.getAttribute('class')).toBe('a  b');
    e.setAttribute('class', 'c');
    expect(e.className).toBe('c');
  });

  it('namespaced attributes (xlink, xml)', () => {
    const s = d.createElementNS(SVG, 'use');
    s.setAttributeNS(XLINK, 'xlink:href', '#a');
    expect(s.getAttributeNS(XLINK, 'href')).toBe('#a');
    expect(s.getAttribute('xlink:href')).toBe('#a');
    expect(s.hasAttributeNS(XLINK, 'href')).toBe(true);
    const a = s.attributes[0];
    expect(a.name).toBe('xlink:href');
    expect(a.localName).toBe('href');
    expect(a.prefix).toBe('xlink');
    expect(a.namespaceURI).toBe(XLINK);
    s.setAttributeNS(XML, 'xml:lang', 'en');
    expect(s.getAttributeNS(XML, 'lang')).toBe('en');
    s.removeAttributeNS(XLINK, 'href');
    expect(s.hasAttributeNS(XLINK, 'href')).toBe(false);
    expect(errName(() => s.setAttributeNS(null, 'x:y', '1'))).toBe('NamespaceError');
    if (kind !== 'happy-dom') expect(errName(() => s.setAttributeNS('urn:x', 'xml:y', '1'))).toBe('NamespaceError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => s.setAttributeNS(XLINK, 'xmlns', '1'))).toBe('NamespaceError'); // PINNED to jsdom: happy-dom 21 diverges
  });

  it('NamedNodeMap and Attr identity', () => {
    const e = d.createElement('div');
    e.setAttribute('a', '1');
    e.setAttribute('b', '2');
    const attrs = e.attributes;
    expect(e.attributes).toBe(attrs);
    expect(attrs.length).toBe(2);
    const a0 = attrs[0];
    expect(attrs.item(0)).toBe(a0);
    expect(attrs.getNamedItem('a')).toBe(a0);
    expect(e.getAttributeNode('a')).toBe(a0);
    expect(a0.ownerElement).toBe(e);
    expect(a0.nodeType).toBe(2);
    if (kind !== 'happy-dom') expect(a0.nodeName).toBe('a'); // PINNED to jsdom: happy-dom 21 diverges
    expect(a0.specified).toBe(true);
    expect(Object.prototype.toString.call(attrs)).toBe('[object NamedNodeMap]');
    expect(Object.prototype.toString.call(a0)).toBe('[object Attr]');
    e.setAttribute('c', '3');
    expect(attrs.length).toBe(3);
    a0.value = 'changed';
    expect(e.getAttribute('a')).toBe('changed');
    e.setAttribute('a', 'again');
    if (kind !== 'happy-dom') expect(a0.value).toBe('again'); // PINNED to jsdom: happy-dom 21 diverges
    e.removeAttribute('a');
    if (kind !== 'happy-dom') expect(a0.ownerElement).toBe(null); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(a0.value).toBe('again'); // PINNED to jsdom: happy-dom 21 diverges
    expect(attrs.length).toBe(2);
    expect(attrs.getNamedItem('zzz')).toBe(null);
    const removed = attrs.removeNamedItem('b');
    expect(removed.name).toBe('b');
    expect(errName(() => attrs.removeNamedItem('b'))).toBe('NotFoundError');
  });

  it('createAttribute / setAttributeNode / removeAttributeNode', () => {
    const e = d.createElement('div');
    const at = d.createAttribute('Title');
    expect(at.name).toBe('title');
    at.value = 'hello';
    expect(at.ownerElement).toBe(null);
    expect(e.setAttributeNode(at)).toBe(null);
    expect(e.getAttribute('title')).toBe('hello');
    expect(at.ownerElement).toBe(e);
    const at2 = d.createAttribute('title');
    at2.value = 'second';
    const old = e.setAttributeNode(at2);
    expect(old).toBe(at);
    if (kind !== 'happy-dom') expect(at.ownerElement).toBe(null); // PINNED to jsdom: happy-dom 21 diverges
    expect(e.getAttribute('title')).toBe('second');
    expect(e.removeAttributeNode(at2)).toBe(at2);
    expect(e.hasAttribute('title')).toBe(false);
    if (kind !== 'happy-dom') expect(errName(() => e.removeAttributeNode(at2))).toBe('NotFoundError'); // PINNED to jsdom: happy-dom 21 diverges
  });
});
