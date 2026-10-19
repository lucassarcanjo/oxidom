// Prototype & identity contract (DESIGN §14 risk 1; ROADMAP M1 acceptance): pretty-format matches on
// constructor.name / Symbol.toStringTag, jest-dom uses instanceof, React stores expandos on nodes.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');
const interfaces = require('../../lib/generated/interfaces.cjs');

const SVG = 'http://www.w3.org/2000/svg';

// Every HTML tag from the jsdom interface table, plus unknown / custom / legacy names.
const HTML_TAGS = [
  ...Object.values(interfaces.html).flat(),
  ...interfaces.plainHtml,
  ...interfaces.unknownHtml,
  'foo', 'my-widget', 'x-y', 'blink',
];
const SVG_TAGS = [...Object.values(interfaces.svg).flat(), 'circle', 'path', 'foreignObject', 'unknownThing'];

describe('interface names match jsdom', () => {
  const jsdom = makeWindow('jsdom').document;
  const want = new Map(HTML_TAGS.map((t) => [t, jsdom.createElement(t).constructor.name]));
  const wantSvg = new Map(SVG_TAGS.map((t) => [t, jsdom.createElementNS(SVG, t).constructor.name]));
  for (const kind of DOMS.filter((k) => k !== 'jsdom')) {
    it(`${kind}: HTML element classes`, () => {
      const d = makeWindow(kind).document;
      const diff = [];
      for (const [t, name] of want) {
        const got = d.createElement(t).constructor.name;
        if (got !== name) diff.push(`${t}: ${got} != ${name}`);
      }
      // happy-dom 21 deviates on a few legacy/unknown names; jsdom is the oracle (rsdom must match).
      if (kind === 'rsdom') expect(diff).toEqual([]);
    });
    it(`${kind}: SVG element classes`, () => {
      const d = makeWindow(kind).document;
      const diff = [];
      for (const [t, name] of wantSvg) {
        const got = d.createElementNS(SVG, t).constructor.name;
        if (got !== name) diff.push(`${t}: ${got} != ${name}`);
      }
      if (kind === 'rsdom') expect(diff).toEqual([]);
    });
  }
});

describe.each(DOMS)('prototype & identity [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('identity: el === el.parentNode.firstChild, expandos survive', () => {
    const el = d.createElement('div');
    d.body.appendChild(el);
    expect(el.parentNode.firstChild).toBe(el);
    expect(d.body.childNodes[0]).toBe(el);
    el.__reactFiber$abc = { tag: 5 };
    el.__reactProps$abc = { onClick() {} };
    const again = d.body.firstChild;
    expect(again.__reactFiber$abc.tag).toBe(5);
    expect(typeof again.__reactProps$abc.onClick).toBe('function');
    const t = d.createTextNode('x');
    el.appendChild(t);
    expect(el.firstChild).toBe(t);
    expect(t.parentNode).toBe(el);
  });

  it('toString tags and constructor names', () => {
    const div = d.createElement('div');
    expect(Object.prototype.toString.call(div)).toBe('[object HTMLDivElement]');
    expect(div.constructor.name).toBe('HTMLDivElement');
    expect(div.constructor).toBe(w.HTMLDivElement);
    expect(div.constructor.prototype).toBe(Object.getPrototypeOf(div));
    expect(Object.prototype.toString.call(d.createTextNode(''))).toBe('[object Text]');
    expect(Object.prototype.toString.call(d.createComment(''))).toBe('[object Comment]');
    expect(Object.prototype.toString.call(d.createDocumentFragment())).toBe('[object DocumentFragment]');
    // jsdom: HTMLDocument === Document, so the document reports [object Document] (happy-dom: HTMLDocument).
    if (kind !== 'happy-dom') expect(Object.prototype.toString.call(d)).toBe('[object Document]');
    expect(d instanceof w.HTMLDocument).toBe(true);
    expect(Object.prototype.toString.call(d.doctype)).toBe('[object DocumentType]');
    expect(Object.prototype.toString.call(d.body.childNodes)).toBe('[object NodeList]');
    expect(Object.prototype.toString.call(d.body.children)).toBe('[object HTMLCollection]');
    expect(d.createElementNS(SVG, 'svg').constructor.name).toBe('SVGSVGElement');
  });

  it('instanceof chain', () => {
    const input = d.createElement('input');
    expect(input instanceof w.HTMLInputElement).toBe(true);
    expect(input instanceof w.HTMLElement).toBe(true);
    expect(input instanceof w.Element).toBe(true);
    expect(input instanceof w.Node).toBe(true);
    if (kind !== 'happy-dom') expect(input instanceof w.EventTarget).toBe(true); // PINNED to jsdom: happy-dom 21 diverges
    expect(d.createTextNode('') instanceof w.CharacterData).toBe(true);
    expect(d.createTextNode('') instanceof w.Text).toBe(true);
    if (kind !== 'happy-dom') expect(d instanceof w.Document).toBe(true); // PINNED to jsdom: happy-dom 21 diverges
    expect(d.createElementNS(SVG, 'g') instanceof w.SVGElement).toBe(true);
    expect(d.createElementNS(SVG, 'g') instanceof w.SVGGraphicsElement).toBe(true);
    expect(d.createElementNS(SVG, 'g') instanceof w.HTMLElement).toBe(false);
    expect(d.createElement('audio') instanceof w.HTMLMediaElement).toBe(true);
    expect(d.createElement('foo') instanceof w.HTMLUnknownElement).toBe(true);
    expect(d.createElement('my-el') instanceof w.HTMLUnknownElement).toBe(false);
    expect(Object.getPrototypeOf(w.HTMLDivElement)).toBe(w.HTMLElement);
  });

  it('node constants on Node and Node.prototype', () => {
    expect(w.Node.ELEMENT_NODE).toBe(1);
    expect(w.Node.prototype.ELEMENT_NODE).toBe(1);
    expect(w.Node.TEXT_NODE).toBe(3);
    expect(w.Node.DOCUMENT_FRAGMENT_NODE).toBe(11);
    expect(w.Node.DOCUMENT_POSITION_CONTAINED_BY).toBe(16);
    expect(d.createElement('div').ELEMENT_NODE).toBe(1);
    expect(d.createElement('div').nodeType).toBe(1);
    expect(d.createTextNode('').nodeType).toBe(3);
    expect(d.createComment('').nodeType).toBe(8);
    expect(d.nodeType).toBe(9);
    expect(d.doctype.nodeType).toBe(10);
    expect(d.createDocumentFragment().nodeType).toBe(11);
  });

  it('illegal constructors; constructible Text / Comment / DocumentFragment', () => {
    expect(errName(() => new w.HTMLDivElement())).toBe('TypeError');
    expect(errName(() => new w.Element())).toBe('TypeError');
    expect(errName(() => new w.Node())).toBe('TypeError');
  });

  it('node names and facts', () => {
    expect(d.createElement('div').nodeName).toBe('DIV');
    expect(d.createTextNode('').nodeName).toBe('#text');
    if (kind !== 'happy-dom') expect(d.createDocumentFragment().nodeName).toBe('#document-fragment'); // PINNED to jsdom: happy-dom 21 diverges
    const div = d.createElement('div');
    expect(div.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(div.prefix).toBe(null);
    const s = d.createElementNS(SVG, 'svg:rect');
    expect(s.prefix).toBe('svg');
    expect(s.localName).toBe('rect');
    expect(s.tagName).toBe('svg:rect');
    expect(s.namespaceURI).toBe(SVG);
    const n = d.createElementNS(null, 'plain');
    expect(n.namespaceURI).toBe(null);
    expect(n.tagName).toBe('plain');
    const up = d.createElementNS('http://www.w3.org/1999/xhtml', 'DIV');
    expect(up.localName).toBe('DIV');
    expect(up.tagName).toBe('DIV');
    expect(div.nodeValue).toBe(null);
  });

  it('own properties: no own value/childNodes on instances', () => {
    const div = d.createElement('div');
    expect(Object.prototype.hasOwnProperty.call(div, 'childNodes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(div, 'parentNode')).toBe(false);
    expect(Object.getOwnPropertyDescriptor(w.Node.prototype, 'parentNode').get).toBeTypeOf('function');
    expect(Object.getOwnPropertyDescriptor(w.Node.prototype, 'parentNode').set).toBe(undefined);
    expect(Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent').set).toBeTypeOf('function');
  });
});
