// Reflected IDL attributes and ARIAMixin (ROADMAP Stage 3 `reflection`, DESIGN §37), the HTML table API and the
// HTMLDocument collections, as component tests and table-rendering libraries use them. jsdom is the oracle.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('reflection [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('ARIA attributes reflect as nullable strings', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has no ARIAMixin
    const el = d.createElement('button');
    expect(el.ariaLabel).toBe(null);
    expect(el.role).toBe(null);
    el.ariaLabel = 'Close';
    el.ariaExpanded = 'false';
    el.role = 'switch';
    expect(el.getAttribute('aria-label')).toBe('Close');
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(el.getAttribute('role')).toBe('switch');
    el.ariaLabel = null;
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('numeric reflection: defaults, clamping and invalid values', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const td = d.createElement('td');
    expect(td.colSpan).toBe(1);
    td.setAttribute('colspan', '5000');
    expect(td.colSpan).toBe(1000);
    td.setAttribute('colspan', '0');
    expect(td.colSpan).toBe(1);
    td.rowSpan = 3;
    expect(td.getAttribute('rowspan')).toBe('3');
    const canvas = d.createElement('canvas');
    expect([canvas.width, canvas.height]).toEqual([300, 150]);
    canvas.width = 640;
    expect(canvas.getAttribute('width')).toBe('640');
    const ol = d.createElement('ol');
    expect(ol.start).toBe(1);
    ol.setAttribute('start', '-3');
    expect(ol.start).toBe(-3);
    expect(ol.reversed).toBe(false);
  });

  it('string, URL and boolean reflection on the remaining elements', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const q = d.createElement('blockquote');
    q.cite = 'notes.html';
    expect(q.cite).toBe('http://localhost:3000/notes.html');
    expect(q.getAttribute('cite')).toBe('notes.html');
    const video = d.createElement('video');
    video.muted = false;
    video.defaultMuted = true;
    expect(video.getAttribute('muted')).toBe('');
    expect(video.controls).toBe(false);
    const body = d.body;
    body.bgColor = null; // [LegacyNullToEmptyString]
    expect(body.getAttribute('bgcolor')).toBe('');
    const meta = d.createElement('meta');
    meta.httpEquiv = 'refresh';
    expect(meta.getAttribute('http-equiv')).toBe('refresh');
  });

  it('enumerated attributes: th.scope, document.dir', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const th = d.createElement('th');
    th.setAttribute('scope', 'COL');
    expect(th.scope).toBe('col');
    th.setAttribute('scope', 'bogus');
    expect(th.scope).toBe('');
    d.documentElement.setAttribute('dir', 'RTL');
    expect(d.dir).toBe('rtl');
    d.dir = 'ltr';
    expect(d.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('reflection ignores getAttribute / setAttribute overridden on the instance', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const el = d.createElement('div');
    el.getAttribute = () => 'overridden';
    el.setAttribute = () => {};
    el.title = 'real';
    expect(el.title).toBe('real');
    expect(el.attributes.getNamedItem('title').value).toBe('real');
  });

  it('table API: rows, tBodies, insertRow / insertCell, rowIndex / cellIndex', () => {
    const t = d.createElement('table');
    t.innerHTML = '<caption>c</caption><tbody><tr><td>a</td><td>b</td></tr></tbody>';
    const rows = t.rows;
    expect(rows.length).toBe(1);
    expect(t.tBodies.length).toBe(1);
    expect(t.caption.textContent).toBe('c');
    const head = t.createTHead();
    expect(head.previousSibling).toBe(t.caption);
    const hr = head.insertRow();
    hr.insertCell().textContent = 'h';
    expect(rows.length).toBe(2); // live
    expect(rows[0]).toBe(hr);
    const last = t.insertRow(-1);
    expect(last.rowIndex).toBe(2);
    expect(last.sectionRowIndex).toBe(1);
    expect(t.rows[1].cells[1].cellIndex).toBe(1);
    t.deleteRow(0);
    expect(rows.length).toBe(2);
    expect(t.rows).toBe(rows);
    expect(() => t.insertRow(9)).toThrow(/index/i);
    t.deleteCaption();
    expect(t.caption).toBe(null);
  });

  it('insertRow on an empty table creates a tbody', () => {
    const t = d.createElement('table');
    const tr = t.insertRow();
    expect(tr.parentNode.localName).toBe('tbody');
    expect(tr.rowIndex).toBe(0);
    expect(d.createElement('tr').rowIndex).toBe(-1);
  });

  it('HTMLDocument collections: images, links, anchors, forms', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has no document.images & co
    d.body.innerHTML = '<img><a href="/x" name="top">x</a><a>no href</a><map><area href="/y"></map><form></form>';
    expect(d.images.length).toBe(1);
    expect(d.links.length).toBe(2);
    expect(d.anchors.length).toBe(1);
    expect(d.forms.length).toBe(1);
    expect(d.querySelector('map').areas.length).toBe(1);
    const links = d.links;
    d.body.append(Object.assign(d.createElement('a'), { href: '/z' }));
    expect(links.length).toBe(3);
    expect(d.links).toBe(links); // [SameObject]
  });
});
