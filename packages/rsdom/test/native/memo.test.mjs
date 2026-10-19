// The facade memo protocol (lib/memo.cjs, DESIGN §16): memos are transparent (RSDOM_NO_MEMO=1 /
// RSDOM_NO_PREFILTER=1 give the same answers) and validated by exact Rust counters.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const FACADE = require.resolve('../../lib/index.cjs');
const { createWindow, rt } = require(FACADE);

describe('memo keys', () => {
  it('base URL: an ATTR advance of exactly 4096 with no tree change still invalidates', () => {
    const { document } = createWindow();
    document.head.innerHTML = '<base href="http://a.test/dir/">';
    document.body.innerHTML = '<a href="x">x</a><i></i>';
    const base = document.querySelector('base');
    const a = document.querySelector('a');
    const i = document.querySelector('i');
    expect(a.href).toBe('http://a.test/dir/x');
    const { EP } = rt.V;
    const tree = EP[rt.EPI.TREE];
    const attr = EP[rt.EPI.ATTR];
    base.setAttribute('href', 'http://b.test/');
    for (let n = 0; EP[rt.EPI.ATTR] - attr < 4096; n++) i.setAttribute('data-n', String(n));
    expect(EP[rt.EPI.ATTR] - attr).toBe(4096);
    expect(EP[rt.EPI.TREE]).toBe(tree);
    expect(a.href).toBe('http://b.test/x');
  });
});

/**
 * One scenario that fills and then invalidates every memo kind: attribute reads, character data, classList,
 * NamedNodeMap, input value and selection, qSA (plain, :checked state, :empty text), matches (prefilter),
 * getElementsBy*, childNodes / children cursors, form collections, base URL and the computed-style core.
 */
const SCENARIO = `
  const { createWindow } = require(${JSON.stringify(FACADE)});
  const { window: w, document: d } = createWindow();
  const out = [];
  const log = (...v) => out.push(v.map(String).join(' '));
  d.head.innerHTML = '<base href="http://a.test/"><style>.hide{display:none} input:checked+span{visibility:hidden}</style>';
  d.body.innerHTML = '<form id=f><input id=i value=ab><input type=checkbox id=c><span id=s>s</span>'
    + '<select id=sel><option>a<option>b</select></form><div id=d class="a b">t<p>1</p><p>2</p></div><a id=l href=x></a><b id=e></b>';
  const [i, c, s, sel, div, link, empty] = ['i', 'c', 's', 'sel', 'd', 'l', 'e'].map((id) => d.getElementById(id));
  const form = d.getElementById('f');
  const text = div.firstChild;
  const byP = d.getElementsByTagName('p');
  const byA = d.getElementsByClassName('a');
  const kids = div.childNodes;
  const elems = div.children;
  const attrs = div.attributes;
  const cl = div.classList;
  const els = form.elements;
  const opts = sel.options;
  const chosen = sel.selectedOptions;
  const read = () => {
    log(div.getAttribute('class'), div.hasAttribute('title'), div.getAttribute('title'));
    log(text.data, text.length);
    log(cl.length, cl.contains('b'), cl.contains('z'));
    log(attrs.length, [...attrs].map((a) => a.name + '=' + a.value).join());
    log(i.value, i.selectionStart, i.selectionEnd);
    log(d.querySelectorAll('.a').length, form.querySelectorAll('input:checked').length, d.querySelectorAll('b:empty').length, d.querySelector('option:checked').text);
    log(div.matches('div'), div.matches('span, div'), div.matches('p'));
    log(byP.length, byA.length, byA[0]?.id);
    log(kids.length, [...kids].map((n) => n.nodeName).join(), kids[1]?.nodeName, kids[2]?.nodeName);
    log(elems.length, elems[0]?.textContent, elems[1]?.textContent);
    log(els.length, opts.length, chosen.length, chosen[0]?.text);
    log(link.href);
    log(w.getComputedStyle(div).display, w.getComputedStyle(s).visibility);
  };
  read();
  read();
  div.setAttribute('class', 'b z hide');
  div.setAttribute('title', 'T');
  text.appendData('u');
  i.value = 'xyz';
  i.setSelectionRange(1, 2);
  c.checked = true;
  empty.textContent = 'filled';
  div.insertBefore(d.createElement('p'), div.children[1]);
  form.append(d.createElement('input'));
  sel.selectedIndex = 1;
  d.querySelector('base').setAttribute('href', 'http://b.test/');
  read();
  read();
  div.lastChild.remove();
  div.removeAttribute('class');
  i.setRangeText('Q', 0, 1);
  read();
  process.stdout.write(JSON.stringify(out));
`;

describe('memo transparency', () => {
  it('every memo kind gives the same answers with RSDOM_NO_MEMO=1 RSDOM_NO_PREFILTER=1', () => {
    const run = (env) => JSON.parse(execFileSync(process.execPath, ['-e', SCENARIO], {
      env: { ...process.env, ...env }, encoding: 'utf8',
    }));
    const on = run({ RSDOM_NO_MEMO: '0', RSDOM_NO_PREFILTER: '0' });
    const off = run({ RSDOM_NO_MEMO: '1', RSDOM_NO_PREFILTER: '1' });
    expect(off).toEqual(on);
    // initial read, a second read (memo hits), after the first batch of changes (twice), after the second batch
    expect(on.slice(13, 26)).toEqual(on.slice(0, 13));
    expect(on.slice(39, 52)).toEqual(on.slice(26, 39));
    expect(on.slice(0, 13)).toEqual([
      'a b false null',
      't 1',
      '2 true false',
      '2 id=d,class=a b',
      'ab 0 0',
      '1 0 1 a',
      'true true false',
      '2 1 d',
      '3 #text,P,P P P',
      '2 1 2',
      '3 2 1 a',
      'http://a.test/x',
      'block visible',
    ]);
    expect(on.slice(26, 39)).toEqual([
      'b z hide true T',
      'tu 2',
      '3 true true',
      '3 id=d,class=b z hide,title=T',
      'xyz 1 2',
      '0 1 0 b',
      'true true false',
      '3 0 undefined',
      '4 #text,P,P,P P P',
      '3 1 ',
      '4 2 1 b',
      'http://b.test/x',
      'none hidden',
    ]);
    expect(on.slice(52)).toEqual([
      'null true T',
      'tu 2',
      '0 false false',
      '2 id=d,title=T',
      'Qyz 0 2',
      '0 1 0 b',
      'true true false',
      '2 0 undefined',
      '3 #text,P,P P P',
      '2 1 ',
      '4 2 1 b',
      'http://b.test/x',
      'block hidden',
    ]);
  });
});
