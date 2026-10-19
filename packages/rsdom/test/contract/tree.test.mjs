// Tree oracles ported from docs/lab/research/jsdom.md §6.1-6.6 (observed jsdom 30.1.3 behaviour) plus the M1 P1
// tree APIs. Every assertion runs on jsdom, happy-dom and rsdom; jsdom wins disagreements (commented).
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('tree [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });
  const el = (t = 'div') => d.createElement(t);

  it('document skeleton', () => {
    expect(d.documentElement.tagName).toBe('HTML');
    expect(d.head.tagName).toBe('HEAD');
    expect(d.body.tagName).toBe('BODY');
    expect(d.doctype.name).toBe('html');
    expect(d.documentElement.parentNode).toBe(d);
    expect(d.body.parentElement).toBe(d.documentElement);
    expect(d.documentElement.parentElement).toBe(null);
    expect(d.ownerDocument).toBe(null);
    expect(d.body.ownerDocument).toBe(d);
    expect(d.nodeName).toBe('#document');
    if (kind !== 'happy-dom') expect(d.textContent).toBe(null); // PINNED to jsdom: happy-dom 21 diverges
    expect(d.isConnected).toBe(true);
  });

  it('6.1 pre-insert validity: error kinds and order', () => {
    const p = el();
    const c1 = el('span');
    p.append(c1);
    // insertBefore(c1, c1) is a no-op and does not throw
    expect(errName(() => p.insertBefore(c1, c1))).toBe('ok');
    expect(p.firstChild).toBe(c1);
    expect(p.childNodes.length).toBe(1);
    if (kind !== 'happy-dom') expect(errName(() => c1.appendChild(p))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => p.appendChild(p))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => p.insertBefore(el('b'), el('i')))).toBe('NotFoundError'); // PINNED to jsdom: happy-dom 21 diverges
    // step 2 (ancestor) is checked before step 3 (reference child)
    if (kind !== 'happy-dom') expect(errName(() => c1.insertBefore(p, el('i')))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.appendChild(d.createTextNode('x')))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.appendChild(el('x')))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => p.appendChild(d.implementation.createDocumentType('html', '', '')))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.createTextNode('t').appendChild(el()))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    expect(errName(() => p.appendChild({}))).toBe('TypeError');
    if (kind !== 'happy-dom') expect(errName(() => p.removeChild(el('x')))).toBe('NotFoundError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => p.appendChild(d))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
  });

  it('6.1 document constraints with replaceChild / doctype placement', () => {
    const html = d.documentElement;
    // replacing the only element child with another element is allowed (child excluded)
    const other = el('html');
    if (kind !== 'happy-dom') expect(d.replaceChild(other, html)).toBe(html); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(d.documentElement).toBe(other); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') d.replaceChild(html, other); // PINNED to jsdom: happy-dom 21 diverges
    // a second doctype is rejected
    if (kind !== 'happy-dom') expect(errName(() => d.insertBefore(d.implementation.createDocumentType('x', '', ''), html))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    // doctype after the element is rejected
    const dt = d.doctype;
    d.removeChild(dt);
    if (kind !== 'happy-dom') expect(errName(() => d.appendChild(dt))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    d.insertBefore(dt, html);
    expect(d.firstChild).toBe(dt);
    // a fragment with two elements cannot go into a document
    const f = d.createDocumentFragment();
    f.append(el('a'), el('b'));
    d.removeChild(html);
    if (kind !== 'happy-dom') expect(errName(() => d.appendChild(f))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
    d.appendChild(html);
  });

  it('6.2 moves and fragments', () => {
    const p = el();
    const [a, b, c] = [el('a'), el('b'), el('i')];
    p.append(a, b, c);
    p.insertBefore(c, a);
    expect([...p.childNodes].map((n) => n.localName)).toEqual(['i', 'a', 'b']);
    const q = el();
    q.appendChild(a);
    expect(a.parentNode).toBe(q);
    expect(p.childNodes.length).toBe(2);
    const f = d.createDocumentFragment();
    f.append('a', el('b'));
    const r = p.appendChild(f);
    expect(r).toBe(f);
    expect(f.childNodes.length).toBe(0);
    expect(p.childNodes.length).toBe(4);
    expect(p.lastChild.parentNode).toBe(p);
    expect(f.firstChild).toBe(null);
  });

  it('6.3 adopt across documents', () => {
    const other = d.implementation.createHTMLDocument('o');
    if (kind !== 'happy-dom') expect(other.title).toBe('o'); // PINNED to jsdom: happy-dom 21 diverges
    const foreign = other.createElement('div');
    const t = other.createTextNode('x');
    foreign.appendChild(t);
    expect(foreign.ownerDocument).toBe(other);
    d.body.appendChild(foreign);
    expect(foreign.ownerDocument).toBe(d);
    expect(t.ownerDocument).toBe(d);
    const g = other.createElement('p');
    expect(d.adoptNode(g)).toBe(g);
    expect(g.ownerDocument).toBe(d);
    if (kind !== 'happy-dom') expect(errName(() => d.adoptNode(other))).toBe('NotSupportedError'); // PINNED to jsdom: happy-dom 21 diverges
    const imported = d.importNode(other.body, true);
    expect(imported.ownerDocument).toBe(d);
    expect(imported.parentNode).toBe(null);
  });

  it('6.4 live collections: SameObject, live length, iteration while removing skips', () => {
    const ul = el('ul');
    const kids = ul.children;
    const nodes = ul.childNodes;
    ul.append(el('li'), 't', el('li'));
    expect(kids.length).toBe(2);
    expect(nodes.length).toBe(3);
    expect(ul.children).toBe(kids);
    expect(ul.childNodes).toBe(nodes);
    expect(nodes[1].nodeType).toBe(3);
    expect(nodes.item(5)).toBe(null);
    const u = el('ul');
    for (let i = 0; i < 4; i++) u.append(el('li'));
    let n = 0;
    for (const c of u.children) {
      c.remove();
      n++;
    }
    expect(n).toBe(2);
    expect(u.children.length).toBe(2);
    const seen = [];
    u.childNodes.forEach((c, i) => seen.push(i));
    expect(seen).toEqual([0, 1]);
    expect(Object.prototype.toString.call(nodes)).toBe('[object NodeList]');
    expect(Object.prototype.toString.call(kids)).toBe('[object HTMLCollection]');
    expect(Array.from(u.childNodes).length).toBe(2);
    expect([...u.childNodes.keys()]).toEqual([0, 1]);
    expect(typeof kids.forEach).toBe('undefined');
  });

  it('6.6 textContent setter and getter', () => {
    const div = el();
    d.body.append(div);
    div.innerHTML = '<b>1</b>2<i>3</i>';
    expect(div.textContent).toBe('123');
    div.textContent = 'hello';
    expect(div.childNodes.length).toBe(1);
    expect(div.firstChild.nodeType).toBe(3);
    div.textContent = '';
    expect(div.childNodes.length).toBe(0);
    div.textContent = null;
    expect(div.textContent).toBe('');
    if (kind !== 'happy-dom') expect(d.textContent).toBe(null); // PINNED to jsdom: happy-dom 21 diverges
    const c = el();
    c.append('a', d.createComment('c'), 'b');
    expect(c.textContent).toBe('ab');
    if (kind !== 'happy-dom') expect(d.doctype.textContent).toBe(null); // PINNED to jsdom: happy-dom 21 diverges
    const t = d.createTextNode('x');
    t.textContent = 'y';
    expect(t.data).toBe('y');
  });

  it('CharacterData with UTF-16 offsets', () => {
    const t = d.createTextNode('a😀b');
    expect(t.length).toBe(4);
    expect(d.createTextNode('😀').length).toBe(2);
    expect(t.substringData(1, 2)).toBe('😀');
    t.appendData('c');
    t.insertData(0, 'z');
    expect(t.data).toBe('za😀bc');
    t.deleteData(2, 2);
    expect(t.data).toBe('zabc');
    t.replaceData(1, 1, 'XY');
    expect(t.data).toBe('zXYbc');
    if (kind !== 'happy-dom') expect(errName(() => t.substringData(99, 1))).toBe('IndexSizeError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => t.insertData(99, 'x'))).toBe('IndexSizeError'); // PINNED to jsdom: happy-dom 21 diverges
    t.nodeValue = 'nv';
    expect(t.data).toBe('nv');
    expect(t.nodeValue).toBe('nv');
    const cm = d.createComment('c');
    expect(cm.nodeName).toBe('#comment');
    expect(cm.data).toBe('c');
    const pi = d.createProcessingInstruction('xml-stylesheet', 'href="a"');
    expect(pi.target).toBe('xml-stylesheet');
    if (kind !== 'happy-dom') expect(pi.nodeName).toBe('xml-stylesheet'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.createProcessingInstruction('1x', ''))).toBe('InvalidCharacterError'); // PINNED to jsdom: happy-dom 21 diverges
    if (kind !== 'happy-dom') expect(errName(() => d.createCDATASection('x'))).toBe('NotSupportedError'); // PINNED to jsdom: happy-dom 21 diverges
  });

  it('splitText, normalize, wholeText', () => {
    const p = el('p');
    const t = d.createTextNode('hello world');
    p.append(t);
    const r = t.splitText(5);
    expect(t.data).toBe('hello');
    expect(r.data).toBe(' world');
    expect(t.nextSibling).toBe(r);
    expect(t.wholeText).toBe('hello world');
    expect(errName(() => t.splitText(99))).toBe('IndexSizeError');
    p.append(d.createTextNode(''), el('b'), 'x', 'y');
    p.normalize();
    expect([...p.childNodes].map((n) => n.nodeName)).toEqual(['#text', 'B', '#text']);
    expect(p.firstChild).toBe(t);
    expect(t.data).toBe('hello world');
    expect(p.lastChild.data).toBe('xy');
  });

  it('cloneNode / isEqualNode / isSameNode', () => {
    const p = el('p');
    p.setAttribute('a', '1');
    p.append('t', el('b'));
    p.lastChild.setAttribute('x', 'y');
    const shallow = p.cloneNode();
    expect(shallow.childNodes.length).toBe(0);
    expect(shallow.getAttribute('a')).toBe('1');
    const deep = p.cloneNode(true);
    expect(deep.childNodes.length).toBe(2);
    expect(deep.lastChild.getAttribute('x')).toBe('y');
    expect(deep.isEqualNode(p)).toBe(true);
    expect(deep.isSameNode(p)).toBe(false);
    expect(p.isSameNode(p)).toBe(true);
    deep.lastChild.setAttribute('x', 'z');
    expect(deep.isEqualNode(p)).toBe(false);
    if (kind !== 'happy-dom') expect(p.isEqualNode(null)).toBe(false); // PINNED to jsdom: happy-dom 21 diverges
    const q = el('p');
    q.setAttribute('a', '1');
    q.append('t');
    const r = el('p');
    r.append('t');
    r.setAttribute('a', '1');
    expect(q.isEqualNode(r)).toBe(true);
    expect(d.createTextNode('a').isEqualNode(d.createTextNode('a'))).toBe(true);
    expect(d.createTextNode('a').isEqualNode(d.createComment('a'))).toBe(false);
    const t = el('template');
    t.innerHTML = '<i>x</i>';
    const tc = t.cloneNode(true);
    expect(tc.content.firstChild.localName).toBe('i');
    expect(t.cloneNode(false).content.childNodes.length).toBe(0);
  });

  it('compareDocumentPosition / contains / getRootNode', () => {
    const a = el();
    const b = el();
    d.body.append(a, b);
    const c = el();
    a.append(c);
    expect(a.compareDocumentPosition(b)).toBe(w.Node.DOCUMENT_POSITION_FOLLOWING);
    expect(b.compareDocumentPosition(a)).toBe(w.Node.DOCUMENT_POSITION_PRECEDING);
    expect(c.compareDocumentPosition(a)).toBe(w.Node.DOCUMENT_POSITION_CONTAINS | w.Node.DOCUMENT_POSITION_PRECEDING);
    expect(a.compareDocumentPosition(c)).toBe(w.Node.DOCUMENT_POSITION_CONTAINED_BY | w.Node.DOCUMENT_POSITION_FOLLOWING);
    expect(c.compareDocumentPosition(b)).toBe(w.Node.DOCUMENT_POSITION_FOLLOWING);
    expect(a.compareDocumentPosition(a)).toBe(0);
    const detached = el();
    expect(detached.compareDocumentPosition(a) & w.Node.DOCUMENT_POSITION_DISCONNECTED).toBeTruthy();
    expect(detached.compareDocumentPosition(a) & w.Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC).toBeTruthy();
    expect(d.body.contains(c)).toBe(true);
    expect(c.contains(c)).toBe(true);
    expect(c.contains(null)).toBe(false);
    expect(c.contains(a)).toBe(false);
    expect(c.getRootNode()).toBe(d);
    const x = el();
    const y = el();
    x.append(y);
    expect(y.getRootNode()).toBe(x);
    expect(y.isConnected).toBe(false);
    expect(c.isConnected).toBe(true);
  });

  it('ParentNode / ChildNode convenience methods', () => {
    const p = el();
    const [a, b, c] = [el('a'), el('b'), el('i')];
    p.append(a, 'x', b);
    expect(p.childNodes.length).toBe(3);
    p.prepend('s', c);
    expect([...p.childNodes].map((n) => n.nodeName)).toEqual(['#text', 'I', 'A', '#text', 'B']);
    a.before('1', '2');
    a.after('3');
    expect([...p.childNodes].map((n) => n.nodeName)).toEqual(['#text', 'I', '#text', '#text', 'A', '#text', '#text', 'B']);
    b.replaceWith(el('u'), 'z');
    expect(p.lastChild.data).toBe('z');
    expect(b.parentNode).toBe(null);
    c.remove();
    expect(c.parentNode).toBe(null);
    p.replaceChildren(el('q'), 'w');
    expect([...p.childNodes].map((n) => n.nodeName)).toEqual(['Q', '#text']);
    p.replaceChildren();
    expect(p.childNodes.length).toBe(0);
    // a node can be its own viable sibling target
    p.append(a, b);
    a.after(a, b);
    expect([...p.children]).toEqual([a, b]);
    expect(p.firstElementChild).toBe(a);
    expect(p.lastElementChild).toBe(b);
    expect(p.childElementCount).toBe(2);
    expect(a.nextElementSibling).toBe(b);
    expect(b.previousElementSibling).toBe(a);
    expect(a.previousElementSibling).toBe(null);
    if (kind !== 'happy-dom') expect(errName(() => p.append(p))).toBe('HierarchyRequestError'); // PINNED to jsdom: happy-dom 21 diverges
  });

  it('getElementById: connected only via document, fragment lookup, duplicates in tree order', () => {
    const a = el();
    a.id = 'dup';
    const b = el();
    b.id = 'dup';
    d.body.append(b);
    d.body.prepend(a);
    if (kind !== 'happy-dom') expect(d.getElementById('dup')).toBe(a); // PINNED to jsdom: happy-dom 21 diverges
    a.remove();
    expect(d.getElementById('dup')).toBe(b);
    b.id = 'other';
    expect(d.getElementById('dup')).toBe(null);
    expect(d.getElementById('other')).toBe(b);
    b.removeAttribute('id');
    expect(d.getElementById('other')).toBe(null);
    const f = d.createDocumentFragment();
    const c = el();
    c.id = 'inside';
    f.append(c);
    expect(f.getElementById('inside')).toBe(c);
    expect(d.getElementById('inside')).toBe(null);
    expect(d.getElementById('never-used-id')).toBe(null);
  });

  it('document title, createHTMLDocument, DOMParser', () => {
    d.title = '  My   Title ';
    if (kind !== 'happy-dom') expect(d.title).toBe('My Title'); // PINNED to jsdom: happy-dom 21 diverges
    expect(d.head.lastChild.tagName).toBe('TITLE');
    const doc = new w.DOMParser().parseFromString('<p id=x>hi</p>', 'text/html');
    expect(doc.body.firstChild.id).toBe('x');
    expect(doc.getElementById('x').textContent).toBe('hi');
    expect(doc.documentElement.tagName).toBe('HTML');
  });
});
