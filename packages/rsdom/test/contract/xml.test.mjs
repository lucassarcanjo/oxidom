// XML documents (ROADMAP Stage 3 `xml`, DESIGN §38): DOMParser for XML types, XMLSerializer, innerHTML /
// outerHTML on XML documents, and JSDOM's XML content types, as SVG tooling and XML-config tests use them.
// jsdom is the oracle.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('XML documents [%s]', (kind) => {
  let w;
  beforeEach(() => {
    w = makeWindow(kind);
  });

  it('DOMParser parses XML with namespaces, CDATA, comments and PIs', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom rejects this document
    const src = '<r xmlns="urn:r" xmlns:x="urn:x" a="1"><x:c>t<![CDATA[<cd>]]></x:c><!--c--><?pi d?></r>';
    const d = new w.DOMParser().parseFromString(src, 'application/xml');
    const r = d.documentElement;
    expect(r.namespaceURI).toBe('urn:r');
    expect(r.getAttribute('a')).toBe('1');
    const c = r.firstChild;
    expect([c.localName, c.prefix, c.namespaceURI]).toEqual(['c', 'x', 'urn:x']);
    expect(c.childNodes[1].nodeType).toBe(4); // CDATA
    expect(r.childNodes[1].nodeType).toBe(8);
    expect(r.childNodes[2].target).toBe('pi');
    expect(new w.XMLSerializer().serializeToString(d)).toBe(src);
  });

  it('a malformed document gives a parsererror document', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's error document differs
    const d = new w.DOMParser().parseFromString('<a><b></a>', 'text/xml');
    const e = d.documentElement;
    expect(e.localName).toBe('parsererror');
    expect(e.namespaceURI).toBe('http://www.mozilla.org/newlayout/xml/parsererror.xml');
    expect(e.textContent).toMatch(/unexpected close tag/);
  });

  it('SVG parsed as image/svg+xml has SVG elements and is case-preserving', () => {
    const d = new w.DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><linearGradient id="g"/></svg>', 'image/svg+xml');
    expect(d.documentElement).toBeInstanceOf(w.SVGElement);
    expect(d.getElementsByTagName('linearGradient').length).toBe(1);
    expect(d.documentElement.getAttribute('viewBox')).toBe('0 0 1 1');
  });

  it('innerHTML / outerHTML on an XML document serialize and parse as XML', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const d = new w.DOMParser().parseFromString('<r xmlns:p="urn:p"><a/></r>', 'application/xml');
    const r = d.documentElement;
    expect(r.innerHTML).toBe('<a/>');
    r.innerHTML = '<p:b k="&lt;"/>text';
    expect(r.firstChild.namespaceURI).toBe('urn:p'); // the prefix resolves through the context element
    expect(r.outerHTML).toBe('<r xmlns:p="urn:p"><p:b k="&lt;"/>text</r>');
    expect(() => {
      r.innerHTML = '<unclosed>';
    }).toThrow(/unclosed tag/);
  });

  it('createElement in an XML document keeps the name whole', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const d = new w.DOMParser().parseFromString('<r/>', 'application/xml');
    const e = d.createElement('a:B');
    expect([e.localName, e.prefix, e.namespaceURI, e.tagName]).toEqual(['a:B', null, null, 'a:B']);
  });
});

describe('JSDOM with an XML content type', () => {
  it('parses the input as XML', () => {
    const { JSDOM } = require('../../lib/index.cjs');
    const dom = new JSDOM('<?xml version="1.0"?><cfg xmlns="urn:c"><Item Name="x"/></cfg>', { contentType: 'application/xml' });
    const d = dom.window.document;
    expect(d.contentType).toBe('application/xml');
    expect(d.getElementsByTagName('Item')[0].getAttribute('Name')).toBe('x');
    expect(dom.serialize()).toBe('<cfg xmlns="urn:c"><Item Name="x"/></cfg>');
    expect(() => new JSDOM('<a>', { contentType: 'text/xml' })).toThrow(/unclosed tag/);
  });
});
