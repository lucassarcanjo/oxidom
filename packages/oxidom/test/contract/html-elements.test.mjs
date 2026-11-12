// HTML element specifics (ROADMAP M5): classList, dataset, reflection (hidden/title/lang/dir/tabIndex),
// URL reflection against http://localhost:3000, zero geometry, image / dialog / details / anchors.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('html elements [%s]', (kind) => {
  let w;
  let d;
  const jsdomLike = kind !== 'happy-dom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('classList (DOMTokenList)', () => {
    const el = d.createElement('div');
    const cl = el.classList;
    expect(el.classList).toBe(cl);
    expect(cl.length).toBe(0);
    cl.add('a', 'b');
    expect([el.className, cl.length, cl[0], cl.item(1), cl.contains('b')]).toEqual(['a b', 2, 'a', 'b', true]);
    cl.remove('a');
    expect(el.getAttribute('class')).toBe('b');
    expect(cl.toggle('c')).toBe(true);
    expect(cl.toggle('c')).toBe(false);
    expect(cl.toggle('d', false)).toBe(false);
    expect(cl.replace('b', 'z')).toBe(true);
    expect(el.className).toBe('z');
    el.className = '  x  y x ';
    expect([cl.length, cl.value, Array.from(cl)]).toEqual([2, '  x  y x ', ['x', 'y']]);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom does not validate tokens
    expect(errName(() => cl.add(''))).toBe('SyntaxError');
    expect(errName(() => cl.add('a b'))).toBe('InvalidCharacterError');
    cl.remove('x', 'y');
    expect(el.getAttribute('class')).toBe('');
    const fresh = d.createElement('p');
    fresh.classList.remove('nothing');
    expect(fresh.hasAttribute('class')).toBe(false);
    expect(Object.prototype.toString.call(cl)).toBe('[object DOMTokenList]');
  });

  it('dataset (DOMStringMap)', () => {
    const el = d.createElement('div');
    el.setAttribute('data-foo-bar', '1');
    el.setAttribute('data-x', '2');
    expect(el.dataset.fooBar).toBe('1');
    expect({ ...el.dataset }).toEqual({ fooBar: '1', x: '2' });
    el.dataset.newOne = 'n';
    expect(el.getAttribute('data-new-one')).toBe('n');
    delete el.dataset.x;
    expect(el.hasAttribute('data-x')).toBe(false);
    expect('fooBar' in el.dataset).toBe(true);
    expect(el.dataset.missing).toBe(undefined);
    expect(Object.keys(el.dataset)).toEqual(['fooBar', 'newOne']);
  });

  it('global attribute reflection', () => {
    const el = d.createElement('div');
    el.hidden = true;
    el.title = 't';
    el.lang = 'en';
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom does not normalise dir
    el.dir = 'RTL';
    expect([el.getAttribute('hidden'), el.getAttribute('title'), el.getAttribute('lang'), el.dir]).toEqual(['', 't', 'en', 'rtl']);
    el.setAttribute('dir', 'weird');
    expect(el.dir).toBe('');
    el.setAttribute('hidden', 'false');
    expect(el.hidden).toBe(true);
    el.hidden = false;
    expect(el.hasAttribute('hidden')).toBe(false);
    expect([el.accessKey, el.title === 't']).toEqual(['', true]);
  });

  it('URL reflection resolves against the document URL', () => {
    const a = d.createElement('a');
    a.setAttribute('href', '/p?q=1#h');
    expect(a.href).toBe('http://localhost:3000/p?q=1#h');
    expect([a.protocol, a.host, a.hostname, a.port, a.pathname, a.search, a.hash, a.origin])
      .toEqual(['http:', 'localhost:3000', 'localhost', '3000', '/p', '?q=1', '#h', 'http://localhost:3000']);
    expect(String(a)).toBe('http://localhost:3000/p?q=1#h');
    expect(d.createElement('a').href).toBe('');
    const img = d.createElement('img');
    img.src = 'pic.png';
    expect([img.src, img.getAttribute('src')]).toEqual(['http://localhost:3000/pic.png', 'pic.png']);
    a.pathname = '/other';
    expect(a.getAttribute('href')).toBe('http://localhost:3000/other?q=1#h');
  });

  it('zero geometry and scroll setters', () => {
    const el = d.createElement('div');
    d.body.appendChild(el);
    const r = el.getBoundingClientRect();
    expect([r.top, r.left, r.width, r.height]).toEqual([0, 0, 0, 0]);
    expect([el.offsetWidth, el.offsetHeight, el.offsetTop, el.offsetLeft, el.clientWidth, el.clientHeight, el.scrollWidth, el.scrollHeight]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([el.scrollTop, el.scrollLeft]).toEqual([0, 0]);
    el.scrollTop = 100; // jsdom stores the value (no layout); oxidom matches
    el.scrollLeft = 5;
    expect([el.scrollTop, el.scrollLeft]).toEqual([100, 5]);
    if (jsdomLike) expect(el.offsetParent).toBe(null); // PINNED to jsdom
  });

  it('details / dialog open, image basics', () => {
    const det = d.createElement('details');
    det.open = true;
    expect(det.getAttribute('open')).toBe('');
    const dlg = d.createElement('dialog');
    expect(dlg.open).toBe(false);
    dlg.open = true;
    expect(dlg.hasAttribute('open')).toBe(true);
    const img = d.createElement('img');
    expect([img.width, img.height, img.naturalWidth, img.complete]).toEqual([0, 0, 0, true]);
    img.width = 10;
    expect([img.width, img.getAttribute('width')]).toEqual([10, '10']);
    img.alt = 'x';
    expect(img.getAttribute('alt')).toBe('x');
  });

  it('summary click toggles its details', () => {
    d.body.innerHTML = '<details id="d"><summary id="s">S</summary>body</details>';
    d.getElementById('s').click();
    expect(d.getElementById('d').open).toBe(true);
    d.getElementById('s').click();
    if (jsdomLike) expect(d.getElementById('d').open).toBe(false); // PINNED to jsdom
  });
});
