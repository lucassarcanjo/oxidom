// Regression tests for the foundation review fixes (tree validity with templates, template-contents
// ownership, Attr-as-Node, live collections, CharacterData, document metadata, WebIDL shape). Every
// assertion runs on every DOM; jsdom is the oracle, happy-dom divergences are pinned.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';

describe.each(DOMS)('foundation review fixes [%s]', (kind) => {
  const win = () => makeWindow(kind);

  it('pre-insert: a template cannot be inserted into its own contents (host-including ancestor)', () => {
    const d = win().document;
    const t = d.createElement('template');
    if (kind !== 'happy-dom') expect(errName(() => t.content.appendChild(t))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom allows it
    const t2 = d.createElement('template');
    const x = d.createElement('div');
    t2.content.append(x);
    if (kind !== 'happy-dom') expect(errName(() => x.append(t2))).toBe('HierarchyRequestError'); // PINNED to jsdom
    // step 2 (ancestor) is checked before step 3 (child not found)
    if (kind !== 'happy-dom') expect(errName(() => x.replaceChild(t2, d.createElement('b')))).toBe('HierarchyRequestError'); // PINNED to jsdom
    // nested templates
    const outer = d.createElement('template');
    const inner = d.createElement('template');
    outer.content.append(inner);
    if (kind !== 'happy-dom') expect(errName(() => inner.content.append(outer))).toBe('HierarchyRequestError'); // PINNED to jsdom
    // the refused insert left a serializable, clonable tree
    expect(t2.outerHTML).toBe('<template><div></div></template>');
    expect(t2.cloneNode(true).outerHTML).toBe('<template><div></div></template>');
  });

  it('parsed template contents are owned by the template contents owner document', () => {
    const d = win().document;
    d.body.innerHTML = '<template><p>x<template><i>y</i></template></p></template>';
    const t = d.body.firstChild;
    const p = t.content.firstChild;
    expect(p.ownerDocument).toBe(t.content.ownerDocument);
    if (kind !== 'happy-dom') expect(p.ownerDocument === d).toBe(false); // PINNED to jsdom: happy-dom uses the main document
    if (kind !== 'happy-dom') expect(p.ownerDocument.defaultView).toBe(null); // PINNED to jsdom
    const inner = p.lastChild;
    if (kind === 'happy-dom') return; // PINNED to jsdom (as above)
    expect(inner.content.firstChild.ownerDocument).toBe(t.content.ownerDocument);
    const dp = new (win().DOMParser)().parseFromString('<body><template><b>z</b></template>', 'text/html');
    const dt = dp.body.firstChild;
    expect(dt.content.firstChild.ownerDocument).toBe(dt.content.ownerDocument);
    expect(dt.content.firstChild.ownerDocument === dp).toBe(false);
  });

  it('adopting a template re-owns nested template contents', () => {
    const d = win().document;
    const d2 = d.implementation.createHTMLDocument('');
    const t = d2.createElement('template');
    const t2 = d2.createElement('template');
    t.content.append(t2);
    const p = d2.createElement('p');
    t2.content.append(p);
    d.body.append(t);
    if (kind !== 'happy-dom') { // PINNED to jsdom: happy-dom keeps template contents in the old document
      expect(t2.content.ownerDocument).toBe(t.content.ownerDocument);
      expect(p.ownerDocument).toBe(t.content.ownerDocument);
    }
  });

  it('document.replaceChildren(newRoot) excludes the current children from validation', () => {
    const d = win().document;
    const doc = d.implementation.createHTMLDocument('x');
    const html = doc.createElement('html');
    if (kind !== 'happy-dom') { // PINNED to jsdom
      expect(errName(() => doc.replaceChildren(html))).toBe('ok');
      expect(doc.documentElement).toBe(html);
    }
    if (kind !== 'happy-dom') expect(errName(() => doc.replaceChildren(doc.createElement('a'), doc.createElement('b')))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom throws a plain Error
  });

  it('splitText on a CDATASection creates a Text node', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom keeps CDATASection
    const d = win().document;
    const x = d.implementation.createDocument(null, 'r');
    const c = x.createCDATASection('abcd');
    x.documentElement.append(c);
    const n = c.splitText(1);
    if (kind !== 'happy-dom') expect([n.nodeType, n.constructor.name]).toEqual([3, 'Text']); // PINNED to jsdom
    expect(c.data).toBe('a');
    expect(n.data).toBe('bcd');
  });

  it('DOMParser documents parse <noscript> with scripting disabled', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom parses noscript as markup everywhere
    const w = win();
    const doc = new w.DOMParser().parseFromString('<noscript><b>x</b>a&amp;b</noscript>', 'text/html');
    if (kind !== 'happy-dom') expect(doc.body.innerHTML).toBe('<b>x</b>a&amp;b'); // PINNED to jsdom
    // ... while the window document (scripting enabled) keeps noscript as raw text
    const div = w.document.createElement('div');
    div.innerHTML = '<noscript><b>x</b></noscript>';
    expect(div.firstChild.childNodes.length).toBe(1);
    expect(div.firstChild.firstChild.nodeType).toBe(3);
  });

  it('document metadata: clone keeps the URL; content type by namespace; XHTML createElement', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom reports application/xml for every XML document
    const w = win();
    const d = w.document;
    expect(d.cloneNode(true).URL).toBe('http://localhost:3000/');
    expect(d.implementation.createDocument(SVG, 'svg').contentType).toBe('image/svg+xml');
    expect(d.implementation.createDocument(XHTML, 'html').contentType).toBe('application/xhtml+xml');
    expect(d.implementation.createDocument(null, 'r').contentType).toBe('application/xml');
    const x = d.implementation.createDocument(XHTML, 'html');
    const e = x.createElement('DIV');
    if (kind !== 'happy-dom') { // PINNED to jsdom
      expect([e.namespaceURI, e.localName, e.constructor.name]).toEqual([XHTML, 'DIV', 'HTMLUnknownElement']);
    }
    const nd = new w.Document();
    expect(Object.prototype.toString.call(nd)).toBe('[object Document]');
    expect(nd instanceof w.XMLDocument).toBe(false);
    expect(nd.contentType).toBe('application/xml');
  });

  it('a void element serializes no children (innerHTML)', () => {
    const d = win().document;
    const br = d.createElement('br');
    br.appendChild(d.createTextNode('x'));
    br.appendChild(d.createElement('i'));
    if (kind !== 'happy-dom') expect(br.innerHTML).toBe(''); // PINNED to jsdom
    expect(br.outerHTML).toBe('<br>');
  });

  it('Attr as a Node: equality, contains, root, null setters, lookups, error types, adoptNode', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's Attr is not a full Node
    const d = win().document;
    const a = d.createAttribute('x');
    const b = d.createAttribute('x');
    expect(a.isEqualNode(b)).toBe(true);
    expect(d.body.contains(a)).toBe(false);
    expect(a.contains(a)).toBe(true);
    a.textContent = null;
    expect(a.value).toBe('');
    a.nodeValue = null;
    expect(a.value).toBe('');
    a.textContent = undefined;
    if (kind !== 'happy-dom') expect(a.value).toBe(''); // PINNED to jsdom
    a.value = null;
    expect(a.value).toBe('null'); // Attr.value is a plain DOMString
    d.body.setAttribute('y', '1');
    const attached = d.body.getAttributeNode('y');
    if (kind !== 'happy-dom') expect(attached.getRootNode()).toBe(attached); // PINNED to jsdom
    const e = d.createElementNS('urn:x', 'p:e');
    d.body.append(e);
    e.setAttribute('z', '1');
    const za = e.getAttributeNode('z');
    if (kind !== 'happy-dom') expect([za.lookupNamespaceURI('p'), za.lookupPrefix('urn:x'), za.isDefaultNamespace(null)]).toEqual(['urn:x', 'p', false]); // PINNED to jsdom
    if (kind !== 'happy-dom') { // PINNED to jsdom
      expect(errName(() => d.body.removeChild(attached))).toBe('NotFoundError');
      expect(errName(() => b.appendChild(d.createElement('i')))).toBe('HierarchyRequestError');
    }
    const el = d.createElement('div');
    el.setAttribute('w', '1');
    const wa = el.getAttributeNode('w');
    d.adoptNode(wa);
    if (kind !== 'happy-dom') expect([wa.ownerElement === el, el.hasAttribute('w')]).toEqual([true, true]); // PINNED to jsdom
  });

  it('Attr identity with the same qualified name in two namespaces', () => {
    const e = win().document.createElement('div');
    e.setAttributeNS('urn:a', 'p:x', '1');
    e.setAttributeNS('urn:b', 'p:x', '2');
    expect(e.attributes[0]).toBe(e.getAttributeNodeNS('urn:a', 'x'));
    expect(e.attributes[1]).toBe(e.getAttributeNodeNS('urn:b', 'x'));
    expect(e.attributes[0].value).toBe('1');
    e.removeAttribute('p:x'); // removes the first one
    expect(e.getAttributeNS('urn:a', 'x')).toBe(null);
    expect(e.getAttributeNS('urn:b', 'x')).toBe('2');
  });

  it('live collections held across mutations are current without touching length', () => {
    const d = win().document;
    d.body.innerHTML = '<i>A</i><i>B</i>';
    const ch = d.body.children;
    expect(ch.length).toBe(2);
    d.body.firstChild.remove();
    expect(ch[0].textContent).toBe('B');
    expect(ch[1]).toBe(undefined);
    const ul = d.createElement('ul');
    const kids = ul.children;
    const nodes = ul.childNodes;
    expect(kids.length).toBe(0);
    ul.append(d.createElement('li'), 'text', d.createElement('li'));
    expect(kids[0].tagName).toBe('LI');
    expect(kids[1]).toBe(ul.lastChild);
    expect(nodes[1].nodeType).toBe(3);
    expect(nodes[3]).toBe(undefined);
    nodes.length; // eslint-disable-line no-unused-expressions
    ul.firstChild.remove();
    expect(nodes[0].nodeType).toBe(3);
    // writes to indices are ignored
    if (kind !== 'happy-dom') { // PINNED to jsdom: happy-dom accepts index writes
      expect(() => { 'use strict'; nodes[0] = 5; }).toThrow(TypeError);
      expect(typeof nodes[0]).toBe('object');
    }
    // sequential, reverse and random access and iteration over a larger list
    const big = d.createElement('ol');
    for (let i = 0; i < 600; i++) big.append(d.createElement('li'), d.createTextNode(String(i)));
    const cn = big.childNodes;
    const items = big.children;
    expect(cn.length).toBe(1200);
    expect(items.length).toBe(600);
    expect(cn[1199].data).toBe('599');
    expect(cn[601].data).toBe('300');
    expect(items[599]).toBe(cn[1198]);
    expect(items[300]).toBe(cn[600]);
    let n = 0;
    for (const x of items) if (x.tagName === 'LI') n++;
    expect(n).toBe(600);
    expect(Array.from(cn).length).toBe(1200);
    expect([...cn.keys()].slice(0, 3)).toEqual([0, 1, 2]);
    expect(cn.item(5000)).toBe(null);
  });

  it('live collections compare equal with toEqual and expose no internal fields', () => {
    const d = win().document;
    const ul1 = d.createElement('ul');
    const ul2 = d.createElement('ul');
    ul1.innerHTML = '<li>a</li><li>b</li>';
    ul2.innerHTML = '<li>a</li><li>b</li>';
    expect(ul1.children).toEqual(ul2.children);
    expect(ul1.childNodes).toEqual(ul2.childNodes);
    const a = d.createElement('div');
    const b = d.createElement('div');
    a.setAttribute('x', '1');
    b.setAttribute('x', '1');
    expect(a.attributes).toEqual(b.attributes);
    expect(a.getAttributeNode('x')).toEqual(b.getAttributeNode('x'));
    if (kind !== 'happy-dom') expect(Object.keys(ul1.childNodes).filter((k) => !/^\d+$/.test(k))).toEqual([]); // PINNED to jsdom
    expect(Object.keys(ul1.children).filter((k) => !/^\d+$/.test(k))).toEqual([]);
  });

  it('CharacterData: data setter keeps undefined, nodeValue/textContent map null and undefined to ""', () => {
    const d = win().document;
    const t = d.createTextNode('a');
    t.data = undefined;
    expect(t.data).toBe('undefined');
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom stores 'null'
    t.data = null;
    expect(t.data).toBe('');
    t.data = 'x';
    t.nodeValue = null;
    expect(t.data).toBe('');
    t.data = 'x';
    t.textContent = undefined;
    expect(t.data).toBe('');
  });

  it('CharacterData reads are always current (data memo invalidation)', () => {
    const d = win().document;
    const p = d.createElement('p');
    const t = d.createTextNode('Grüße');
    p.append(t);
    expect(t.data).toBe('Grüße');
    t.appendData(' aus');
    expect(t.data).toBe('Grüße aus');
    expect(t.length).toBe(9);
    t.insertData(0, '¡');
    t.deleteData(1, 1);
    expect(t.nodeValue).toBe('¡rüße aus');
    t.replaceData(1, 4, 'Hallo');
    expect(t.textContent).toBe('¡Hallo aus');
    const tail = t.splitText(6);
    expect([t.data, tail.data]).toEqual(['¡Hallo', ' aus']);
    p.normalize();
    expect(t.data).toBe('¡Hallo aus');
    p.textContent = '日本';
    expect(p.firstChild.data).toBe('日本');
    p.firstChild.data = '😀x';
    expect([p.firstChild.data, p.firstChild.length]).toEqual(['😀x', 3]);
    const c = t.cloneNode();
    expect(c.data).toBe('¡Hallo aus');
  });

  it('WebIDL shape: constructor lengths, required arguments, document.body setter, enumerable members', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom differs in all of these
    const w = win();
    const d = w.document;
    if (kind !== 'happy-dom') { // PINNED to jsdom
      expect([w.Node.length, w.Text.length, w.Comment.length, w.DocumentFragment.length]).toEqual([0, 0, 0, 0]);
      expect(errName(() => d.body.insertBefore(d.createElement('i')))).toBe('TypeError');
      expect(errName(() => d.createTextNode())).toBe('TypeError');
    }
    const nb = d.createElement('body');
    nb.id = 'nb';
    d.body = nb;
    expect(d.body.id).toBe('nb');
    expect(errName(() => { d.body = d.createElement('div'); })).toBe('HierarchyRequestError');
    const names = [];
    for (const k in d.createElement('div')) names.push(k);
    expect(names).toContain('appendChild');
    expect(names).toContain('firstChild');
    expect(names).toContain('tagName');
  });
});

/** Divergences where rsdom follows the specs and jsdom (parse5 / its serializer) does not; asserted. */
describe('spec-correct divergences from jsdom (asserted)', () => {
  const jsdom = makeWindow('jsdom').document;
  const rs = DOMS.includes('rsdom') ? makeWindow('rsdom').document : null;
  const both = (fn) => [fn(jsdom), rs && fn(rs)];

  it('processing instructions serialize as <?target data> (HTML fragment serializing)', () => {
    const [j, r] = both((d) => {
      const x = d.implementation.createDocument(null, 'r');
      const div = d.createElement('div');
      div.append(x.createProcessingInstruction('x', 'y'));
      return div.innerHTML;
    });
    expect(j).toBe('');
    if (rs) expect(r).toBe('<?x y>');
  });

  it('SVG elements serialize their local name, not the qualified name', () => {
    const [j, r] = both((d) => {
      const div = d.createElement('div');
      div.append(d.createElementNS(SVG, 'svg:rect'));
      return div.innerHTML;
    });
    expect(j).toBe('<svg:rect></svg:rect>');
    if (rs) expect(r).toBe('<rect></rect>');
  });

  it('every U+0000 in foreign content becomes one U+FFFD (html5ever)', () => {
    const [j, r] = both((d) => {
      const div = d.createElement('div');
      div.innerHTML = '<svg>a\0\0b</svg>';
      return div.innerHTML;
    });
    expect(j).toBe('<svg>a�b</svg>');
    if (rs) expect(r).toBe('<svg>a��b</svg>');
  });

  it('compareDocumentPosition between an element and its attribute', () => {
    const [j, r] = both((d) => {
      const e = d.createElement('div');
      e.setAttribute('a', '1');
      const a = e.getAttributeNode('a');
      return [a.compareDocumentPosition(e), e.compareDocumentPosition(a)];
    });
    expect(j).toEqual([0, 0]);
    if (rs) expect(r).toEqual([10, 20]);
  });

  it('elements of XML documents use the XML serializer (DESIGN §38)', () => {
    const [j, r] = both((d) => {
      const x = d.implementation.createDocument(null, 'Foo');
      x.documentElement.setAttribute('a', '<&"');
      x.documentElement.append(x.createElement('br'));
      return x.documentElement.outerHTML;
    });
    expect(j).toBe('<Foo a="&lt;&amp;&quot;"><br/></Foo>');
    if (rs) expect(r).toBe(j);
  });

  it('lone surrogates round-trip, and an offset inside a surrogate pair splits it (DESIGN §44)', () => {
    const [j, r] = both((d) => {
      const t = d.createTextNode('a😀b');
      t.deleteData(1, 1);
      const split = [t.data.length, t.data.charCodeAt(1)];
      t.insertData(1, '\ud83d');
      const el = d.createElement('p');
      el.setAttribute('title', 'x\udc00');
      el.id = '\ud800';
      el.append('\udbff!');
      return [...split, t.data, el.getAttribute('title'), el.outerHTML, d.createTextNode('a😀b').splitText(2).data];
    });
    expect(j).toEqual([3, 0xde00, 'a😀b', 'x\udc00', '<p title="x\udc00" id="\ud800">\udbff!</p>', '\ude00b']);
    if (rs) expect(r).toEqual(j);
  });
});
