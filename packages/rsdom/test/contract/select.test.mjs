// Selectors (ROADMAP M3): querySelector(All), matches, closest, getElementsBy* on all DOMs, plus a
// differential run of ~150 selectors against jsdom (the oracle) on a mixed fixture.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const FIXTURE = `
<header id="top" class="bar main" lang="en-US">
  <nav><ul id="menu"><li class="item first"><a id="home" href="/">Home</a></li><li class="item"><a id="nolink">x</a></li>
  <li class="item last" data-x="a b c"><a href="#q" id="q" target="_blank" rel="noopener">Q</a></li></ul></nav>
</header>
<main id="m">
  <form id="f" name="login">
    <fieldset id="fs" disabled><legend id="lg"><input id="inleg" name="u"></legend><input id="infs" type="text"></fieldset>
    <label for="email" id="lab">Email</label>
    <input id="email" type="email" required placeholder="you@x" name="email">
    <input id="pw" type="password" readonly value="x">
    <input id="cb" type="checkbox" checked><input id="cb2" type="CHECKBOX">
    <input id="r1" type="radio" name="g"><input id="r2" type="radio" name="g">
    <input id="hid" type="hidden"><input id="num" type="number" min="1" max="3">
    <select id="sel"><optgroup label="o" disabled><option id="o1">1</option></optgroup><option id="o2" selected>2</option></select>
    <select id="multi" multiple size="3"></select>
    <textarea id="ta" placeholder="t"></textarea><textarea id="ta2">filled</textarea>
    <button id="b1">Go</button><button id="b2" type="button" disabled>No</button><button id="b3" type="reset">R</button>
  </form>
  <table id="t"><caption>c</caption><thead><tr><th scope="col" id="th1">A</th><th id="th2">B</th></tr></thead>
    <tbody><tr id="tr1" class="row odd"><td>1</td><td></td></tr><tr id="tr2" class="row even"><td>2</td><td><!--c--></td></tr>
    <tr id="tr3" class="row odd"><td> </td><td><span></span></td></tr></tbody></table>
  <p id="p1" dir="rtl">one <b>two</b> <i>three</i></p><p id="p2" class="Mixed">x</p><p id="p3" hidden>h</p>
  <div id="ce" contenteditable><span id="ces">e</span></div><div id="cef" contenteditable="false"></div>
  <details id="det" open><summary>s</summary></details><dialog id="dlg"></dialog>
  <img id="img1" alt=""><img id="img2" alt="pic"><img id="img3">
  <svg id="svg" viewBox="0 0 1 1"><g id="g1" class="shape"><circle id="c1" r="1"/></g><foreignObject id="fo"></foreignObject></svg>
  <my-el id="custom"></my-el><progress id="prog"></progress>
</main>
<footer id="foot"><p id="last">end</p></footer>`;

/** Differential selectors: rsdom (and happy-dom where it agrees) must equal jsdom. */
const SELECTORS = [
  '*', 'p', 'P', 'li', 'a', 'svg', 'circle', 'foreignObject', 'foreignobject', 'g', 'my-el',
  '#m', '#q', '#nope', '.item', '.item.first', '.row.odd', '.mixed', '.Mixed', '.shape',
  'ul > li', 'ul li a', 'main p', 'header ~ main', 'li + li', 'tr ~ tr', 'nav a[href]', 'form > *',
  'li:first-child', 'li:last-child', 'li:only-child', 'td:nth-child(2)', 'tr:nth-child(odd)', 'tr:nth-child(2n)',
  'tr:nth-last-child(1)', 'li:nth-child(-n+2)', 'p:nth-of-type(2)', 'p:first-of-type', 'p:last-of-type',
  'td:only-of-type', 'b:only-child', ':nth-child(2 of .row)', 'td:empty', 'span:empty', ':root', 'html:root',
  '[href]', '[href="/"]', '[href^="#"]', '[href$="q"]', '[href*="q"]', '[data-x~="b"]', '[lang|="en"]',
  '[data-x="A B C" i]', '[type="checkbox"]', '[type="checkbox" s]', 'input[type="text"]', '[class="row odd"]',
  'a:not([href])', 'input:not([type])', 'li:not(.first, .last)', ':not(div):not(p) > span', 'input:not([list])',
  ':is(h1, p, li).item', ':where(p, td)', 'div:has(> span)', 'tr:has(td:empty)', 'form:has(input[required])',
  'p:has(+ p)', 'li:has(~ li)', ':has(b) > i', 'section:has(p)',
  ':checked', 'input:checked', 'option:checked', ':disabled', ':enabled', 'input:enabled', 'button:disabled',
  'option:disabled', 'fieldset:disabled', ':required', ':optional', 'input:read-only', 'input:read-write',
  ':read-write', 'textarea:read-write', ':placeholder-shown', ':indeterminate', ':default', ':link', ':any-link',
  'a:visited', 'a:hover', ':focus', ':focus-within', ':focus-visible', ':target', ':defined', ':lang(en)',
  ':lang(fr)', ':dir(rtl)', 'p:dir(ltr)', ':open', ':valid', ':invalid', 'input:invalid', 'form:invalid',
  'details[open] > summary', 'dialog:not([open])', 'select:not([multiple]):not([size])', 'select[size]',
  'img[alt=""]', 'img:not([alt])', 'img[alt]:not([alt=""])', 'th[scope="col"]', 'input[list]:not([list=""])',
  'form[name]:not([name=""])', 'svg g > circle', 'svg *', '*|circle', '[viewBox]', '[viewbox]',
  'td, th', 'a, a', 'p, #p1', 'b, i, b', 'thead th, tbody td:first-child', 'main > :last-child',
  '::before', 'p::after', 'p:before', ':scope', ':scope > header',
];

const id = (n) => (n === null ? null : n.id || n.localName);

describe.each(DOMS)('selectors [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    d.body.innerHTML = FIXTURE;
  });

  it('querySelector / querySelectorAll basics, document order, no duplicates', () => {
    expect(id(d.querySelector('li a'))).toBe('home');
    expect([...d.querySelectorAll('b, p, i')].map(id)).toEqual(['p1', 'b', 'i', 'p2', 'p3', 'last']);
    expect([...d.querySelectorAll('a, a, [href]')].map(id)).toEqual(['home', 'nolink', 'q']);
    expect(d.querySelector('#nope')).toBe(null);
    expect(d.querySelectorAll('#nope').length).toBe(0);
    const ul = d.getElementById('menu');
    expect([...ul.querySelectorAll('a')].map(id)).toEqual(['home', 'nolink', 'q']);
    // Combinators may match ancestors outside the root; results are descendants only (spec, browsers).
    // PINNED to the spec: jsdom 30 and happy-dom return [] for some of these (jsdom: 'nav a' matches
    // but 'nav li > a' / '#top a' do not), an engine bug rather than a semantic choice.
    if (kind === 'rsdom') {
      expect([...ul.querySelectorAll('nav li > a')].map(id)).toEqual(['home', 'nolink', 'q']);
      expect([...ul.querySelectorAll('#top a')].map(id)).toEqual(['home', 'nolink', 'q']);
    }
    if (kind !== 'happy-dom') expect([...ul.querySelectorAll('nav a')].map(id)).toEqual(['home', 'nolink', 'q']);
    expect([...ul.querySelectorAll('ul')].map(id)).toEqual([]);
    const frag = d.createDocumentFragment();
    frag.appendChild(d.createElement('div')).id = 'fd';
    expect(id(frag.querySelector('div'))).toBe('fd');
    expect(frag.querySelectorAll('*').length).toBe(1);
  });

  it(':heading / :heading() with headingoffset and headingreset (Selectors 5, whatwg/html#11086)', () => {
    // PINNED to the spec: jsdom 30 (dom-selector) and happy-dom do not support :heading.
    if (kind !== 'rsdom') return;
    d.body.innerHTML =
      '<h1 id="a"></h1><h7 id="b"></h7><div headingoffset="2"><h1 id="c"></h1><h6 id="d"></h6>' +
      '<section headingreset><h2 id="e"></h2></section><h1 id="f" headingoffset="1" headingreset></h1></div>';
    const q = (s) => [...d.querySelectorAll(s)].map(id);
    expect(q(':heading')).toEqual(['a', 'c', 'd', 'e', 'f']);
    expect(q(':heading(1)')).toEqual(['a']);
    expect(q(':heading(3)')).toEqual(['c']);
    expect(q(':heading(8)')).toEqual(['d']); // h6 + 2
    expect(q(':heading(2)')).toEqual(['e', 'f']);
    const c = d.getElementById('c');
    c.headingReset = true;
    expect(c.matches(':heading(1)')).toBe(true);
    c.headingOffset = 20;
    expect(c.getAttribute('headingoffset')).toBe('20');
    expect(c.headingOffset).toBe(8);
    expect(c.matches(':heading(9)')).toBe(true);
    expect(() => d.querySelector(':heading(a)')).toThrow();
  });

  it('static NodeList from querySelectorAll; fresh object each call', () => {
    const a = d.querySelectorAll('li');
    const b = d.querySelectorAll('li');
    if (kind !== 'happy-dom') expect(a).not.toBe(b); // PINNED to jsdom: happy-dom caches the NodeList
    expect(a.length).toBe(3);
    expect(a[0]).toBe(b[0]);
    expect(Object.prototype.toString.call(a)).toBe('[object NodeList]');
    d.getElementById('menu').appendChild(d.createElement('li'));
    expect(a.length).toBe(3);
    expect(d.querySelectorAll('li').length).toBe(4);
    d.getElementById('home').remove();
    expect(d.querySelectorAll('li a').length).toBe(2);
  });

  it('matches / closest / webkitMatchesSelector', () => {
    const a = d.getElementById('home');
    expect(a.matches('a')).toBe(true);
    expect(a.matches('li > a[href="/"]')).toBe(true);
    expect(a.matches('div')).toBe(false);
    expect(a.matches(':scope')).toBe(true);
    if (kind !== 'happy-dom') expect(a.webkitMatchesSelector('a')).toBe(true); // PINNED: missing in happy-dom
    expect(id(a.closest('ul'))).toBe('menu');
    expect(id(a.closest('a'))).toBe('home');
    expect(id(a.closest('header.bar'))).toBe('top');
    expect(a.closest('table')).toBe(null);
    expect(id(d.getElementById('c1').closest('svg'))).toBe('svg');
  });

  it('SyntaxError for invalid selectors (never truncated)', () => {
    for (const s of ['', 'a,', '>a', 'a!b', 'div ~', '[x|y]', 'ns|a', ':not()', '#1a', '.1a', 'a)', 'p]', ':nope', '::nope']) {
      if (kind === 'happy-dom' && [':nope', '::nope'].includes(s)) continue; // PINNED to jsdom: happy-dom accepts these
      expect(errName(() => d.querySelectorAll(s)), s).toMatch(/SyntaxError|DOMException/);
      // PINNED: jsdom's matches() accepts namespace prefixes it rejects in querySelectorAll
      if (kind !== 'jsdom' || !s.includes('|')) expect(errName(() => d.body.matches(s)), s).toMatch(/SyntaxError|DOMException/);
    }
    // CSS syntax closes blocks and strings at EOF: `[a`, `:not(a`, `[a="b` are valid (jsdom, browsers).
    if (kind !== 'happy-dom') {
      expect(d.querySelectorAll('[href').length).toBe(2);
      expect(d.querySelectorAll('li:not(.first').length).toBe(2);
      expect(errName(() => d.querySelector('a!'))).toBe('SyntaxError');
      expect(errName(() => d.body.closest('a,'))).toBe('SyntaxError');
    }
    if (kind !== 'happy-dom') expect(errName(() => d.body.matches())).toBe('TypeError'); // PINNED: happy-dom accepts no argument
    // WebIDL DOMString conversion: null -> "null" (a valid type selector)
    expect(d.querySelector(null)).toBe(null);
  });

  it('getElementsByTagName / ClassName are live', () => {
    const lis = d.getElementsByTagName('li');
    const items = d.getElementsByClassName('item');
    const all = d.getElementsByTagName('*');
    const n = all.length;
    expect(lis.length).toBe(3);
    expect(items.length).toBe(3);
    const li = d.createElement('li');
    li.className = 'item';
    d.getElementById('menu').appendChild(li);
    expect(lis.length).toBe(4);
    expect(items.length).toBe(4);
    expect(all.length).toBe(n + 1);
    li.className = 'other';
    expect(items.length).toBe(3);
    expect(lis[3]).toBe(li);
    expect(d.getElementsByClassName('row odd').length).toBe(2);
    if (kind !== 'happy-dom') expect(d.getElementsByClassName('  ').length).toBe(0); // PINNED: happy-dom throws
    expect(d.getElementsByTagName('LI').length).toBe(4);
    expect(d.getElementsByTagName('foreignObject').length).toBe(1);
    if (kind !== 'happy-dom') expect(d.getElementsByTagName('foreignobject').length).toBe(0); // PINNED: happy-dom is case-insensitive
    const ul = d.getElementById('menu');
    expect(ul.getElementsByTagName('a').length).toBe(3);
    expect(ul.getElementsByClassName('first')[0].tagName).toBe('LI');
    expect(Object.prototype.toString.call(lis)).toBe('[object HTMLCollection]');
    expect(d.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'circle').length).toBe(1);
    expect(d.getElementsByTagNameNS('*', 'circle').length).toBe(1);
    if (kind !== 'happy-dom') expect(d.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'circle').length).toBe(0); // PINNED: happy-dom throws
  });

  it('getElementsByName', () => {
    const l = d.getElementsByName('g');
    expect(l.length).toBe(2);
    expect(Object.prototype.toString.call(l)).toBe('[object NodeList]');
    expect(d.getElementsByName('login')[0].id).toBe('f');
    expect(d.getElementsByName('none').length).toBe(0);
  });

  it('id lookup: duplicates resolve to the first in tree order', () => {
    const a = d.createElement('p');
    a.id = 'dup';
    const b = d.createElement('p');
    b.id = 'dup';
    d.body.appendChild(b);
    d.body.insertBefore(a, d.body.firstChild);
    expect(d.querySelector('#dup')).toBe(a);
    expect([...d.querySelectorAll('#dup')]).toEqual([a, b]);
    if (kind !== 'happy-dom') expect(d.getElementById('dup')).toBe(a); // PINNED: happy-dom returns the first inserted
    a.remove();
    expect(d.querySelector('#dup')).toBe(b);
    const det = d.createElement('div');
    det.innerHTML = '<p id="x1"></p><p id="x1" class="k"></p>';
    expect(det.querySelector('#x1')).toBe(det.firstChild);
    expect(det.querySelectorAll('#x1').length).toBe(2);
  });

  it('results follow mutations (memo validation)', () => {
    const q = () => [...d.querySelectorAll('.row.odd')].map(id);
    expect(q()).toEqual(['tr1', 'tr3']);
    d.getElementById('tr2').setAttribute('class', 'row even odd');
    expect(q()).toEqual(['tr1', 'tr2', 'tr3']);
    d.getElementById('tr1').remove();
    expect(q()).toEqual(['tr2', 'tr3']);
    d.getElementById('tr3').setAttribute('class', 'row');
    expect(q()).toEqual(['tr2']);
    const empty = () => [...d.querySelectorAll('td:empty')].length;
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's :empty ignores text appended later
    const n = empty();
    d.querySelector('td:empty').appendChild(d.createTextNode('x'));
    expect(empty()).toBe(n - 1);
    const t = d.querySelector('td').firstChild;
    expect(d.querySelector('td').matches(':empty')).toBe(false);
    t.data = '';
    // PINNED to the spec: jsdom 30 caches :empty across character-data changes
    if (kind !== 'jsdom') expect(d.querySelector('td').matches(':empty')).toBe(true);
    const tr = d.querySelector('tr');
    const fresh = d.querySelector('tr');
    expect(tr).toBe(fresh);
  });

  it('differential: every selector agrees with jsdom (querySelectorAll + matches on every element)', () => {
    if (kind === 'jsdom') return;
    const o = makeWindow('jsdom').document;
    o.body.innerHTML = FIXTURE;
    const selectors = SELECTORS;
    const els = [...d.querySelectorAll('*')];
    const oels = [...o.querySelectorAll('*')];
    expect(els.length).toBe(oels.length);
    const diffs = [];
    for (const s of selectors) {
      let got;
      let want;
      try { want = [...o.querySelectorAll(s)].map(id).join(','); } catch (e) { want = e.name; }
      try { got = [...d.querySelectorAll(s)].map(id).join(','); } catch (e) { got = e.name; }
      if (got !== want) diffs.push(`qsa ${s}: got ${got} want ${want}`);
      for (let i = 0; i < els.length; i++) {
        let g;
        let x;
        try { x = oels[i].matches(s); } catch (e) { x = e.name; }
        try { g = els[i].matches(s); } catch (e) { g = e.name; }
        if (g !== x) diffs.push(`matches ${s} on #${id(els[i])}: got ${g} want ${x}`);
      }
    }
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom diverges on many pseudo-classes
    expect(diffs).toEqual([]);
  });
});
