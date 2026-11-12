// M2 acceptance: parse + serialize round-trip corpus compared against jsdom 30.1.3 (parse5) output,
// plus innerHTML / outerHTML / insertAdjacentHTML / template / DOMParser / createContextualFragment behaviour.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const SVG = 'http://www.w3.org/2000/svg';

export const CORPUS = [
  'hello',
  '<b>bold</b> and <i>italic</i>',
  'a &amp; b &lt; c &gt; d "quotes" \'apos\'',
  '&nbsp;&copy;&eacute;&#x1F600;&#169;&unknown;&amp',
  '<p>unclosed<p>second',
  '<table><tr><td>x</table>',
  '<table><td>cell</td></table>',
  '<table><caption>c</caption><colgroup><col></colgroup><thead><tr><th>h</th></tr></thead><tbody><tr><td>1</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
  '<table>text<tr><td>x</td></tr></table>',
  "<br><hr><img src='a.png' alt='x'><input type=text value=v><meta charset=utf-8><link rel=stylesheet href=x><wbr>",
  '<area><base><col><embed><param><source><track><keygen>',
  '<br></br><p></p>',
  "<svg viewBox='0 0 10 10'><circle cx=5 cy=5 r=4 /><foreignObject><div>html</div></foreignObject></svg>",
  '<svg><clippath></clippath><lineargradient gradientunits=x></lineargradient><textpath></textpath></svg>',
  '<math><mi>x</mi><mo>=</mo><mn>1</mn></math>',
  '<!-- comment --><div><!--inner--></div><!---->',
  "<div title='a &quot;q&quot; &amp; <b>  '>x</div>",
  '<div data-x="a\'b" class=c id=i hidden></div>',
  '<template><tr><td>in template</td></tr></template>',
  '<template><template><b>nested</b></template>after</template>',
  '<select><option>a<option selected>b</select>',
  '<ul><li>1<li>2<li>3</ul>',
  '<dl><dt>t<dd>d</dl>',
  '<script>if (a < b && c) {}</script>',
  '<style>a > b { color: red } /* & */</style>',
  '<textarea>  <b>not tags</b> &amp; </textarea>',
  '<pre>\nleading newline</pre><pre>\n\ntwo</pre>',
  '<noscript><b>x</b></noscript>',
  '<iframe><b>raw</b></iframe>',
  '<xmp><b>&amp;</xmp>',
  "<a href='/x?a=1&b=2'>link</a>",
  '<a><a>nested anchors</a></a>',
  '<b><i>misnested</b></i>',
  '<p><div>block in p</div></p>',
  '<button><button>x</button></button>',
  '<form><input name=q><button>go</button></form>',
  '<label for=i>L</label><input id=i>',
  'ü ñ 漢字 😀 emoji',
  '<span> nbsp </span>',
  '<div><span>a</span>\n  <span>b</span>\n</div>',
  '<h1>t</h1><h2>u</h2><h6>v</h6>',
  '<custom-element some-attr>x</custom-element><x-y></x-y>',
  "<DIV CLASS='Up' ID=X>case</DIV>",
  '<p>a</p><!--x-->text<?pi data?>',
  '<img src=x onerror=alert(1)>',
  '<object><param name=a value=b></object>',
  '<details open><summary>s</summary>body</details>',
  '<input type=checkbox checked><input type=radio name=r>',
  '<frameset><frame></frameset>',
  '</p>stray',
  '<svg><style>a<b</style><title>t&amp;</title></svg>',
  "<math><annotation-xml encoding='text/html'><div>x</div></annotation-xml></math>",
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<plaintext><b>rest &amp;',
  '<div id=a><div id=b><div id=c>deep</div></div></div>',
  '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"></use></svg>',
  '<table><tbody><tr><td><table><tr><td>inner</td></tr></table></td></tr></tbody></table>',
  '<select><optgroup label=g><option value=1>one</option></optgroup></select>',
  '<html><body>ignored html/body tags</body></html>',
  '<head><title>x</title></head>',
];

const CONTEXTS = [
  ['table', '<tr><td>1</td></tr>'],
  ['tr', '<td>a</td><td>b</td>'],
  ['tbody', '<tr><td>x'],
  ['select', '<option>x<option>y'],
  ['textarea', '<b>raw</b> &amp;'],
  ['style', 'a<b &amp;'],
  ['script', 'x < 1 && y'],
  ['ul', '<li>x<li>y'],
  ['template', '<td>x</td><tr>y</tr>'],
  ['title', '<b>t</b>'],
  ['colgroup', '<col span=2>'],
  ['html', '<head></head><body>b</body>'],
];

/**
 * Known parser-version divergences: html5ever 0.40 implements the 2025 "customizable <select>" parser
 * changes (other elements allowed inside <select>/<option>); parse5 7 (jsdom 30) drops them. oxidom keeps
 * html5ever's (current-spec) tree. Asserted explicitly so a change is noticed.
 */
const DIVERGENCES = [
  ['select', '<option>x<option>y<div>no</div>', '<option>x</option><option>y<div>no</div></option>', '<option>x</option><option>yno</option>'],
];

const DOCUMENTS = [
  '<!DOCTYPE html><html><head><title>T</title></head><body><p>x</p></body></html>',
  '<title>only title</title>',
  '<p>no doctype',
  '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x',
  '<!doctype html><body class=b><script>x</script><div id=d>d</div>',
  '',
];

const jsdom = makeWindow('jsdom');

function inner(w, html, ctx = 'div', ns = null) {
  const el = ns ? w.document.createElementNS(ns, ctx) : w.document.createElement(ctx);
  el.innerHTML = html;
  return el.innerHTML;
}

describe('parse/serialize corpus vs jsdom', () => {
  it(`has at least 40 snippets (${CORPUS.length})`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
  });
  for (const kind of DOMS.filter((k) => k !== 'jsdom')) {
    describe(kind, () => {
      const w = makeWindow(kind);
      it.each(CORPUS.map((s, i) => [i, s]))('snippet %i', (_i, html) => {
        const got = inner(w, html);
        const want = inner(jsdom, html);
        if (kind === 'oxidom') expect(got).toBe(want);
      });
      it.each(CONTEXTS)('context <%s>', (ctx, html) => {
        if (kind === 'oxidom') expect(inner(w, html, ctx)).toBe(inner(jsdom, html, ctx));
      });
      it.each(DIVERGENCES)('documented divergence in <%s>: %s', (ctx, html, oxidomOut, jsdomOut) => {
        expect(inner(jsdom, html, ctx)).toBe(jsdomOut);
        if (kind === 'oxidom') expect(inner(w, html, ctx)).toBe(oxidomOut);
      });
      it('svg context', () => {
        const html = '<circle r=1 /><p>breakout</p><foreignObject><b>x</b></foreignObject>';
        if (kind === 'oxidom') expect(inner(w, html, 'svg', SVG)).toBe(inner(jsdom, html, 'svg', SVG));
      });
      it.each(DOCUMENTS.map((s, i) => [i, s]))('DOMParser document %i', (_i, html) => {
        const a = new w.DOMParser().parseFromString(html, 'text/html');
        const b = new jsdom.DOMParser().parseFromString(html, 'text/html');
        if (kind !== 'oxidom') return;
        expect(a.documentElement.outerHTML).toBe(b.documentElement.outerHTML);
        expect(a.doctype?.name ?? null).toBe(b.doctype?.name ?? null);
        expect(a.doctype?.publicId ?? null).toBe(b.doctype?.publicId ?? null);
        expect(a.compatMode).toBe(b.compatMode);
        expect(a.title).toBe(b.title);
        expect(a.body?.tagName).toBe(b.body?.tagName);
      });
    });
  }
});

describe.each(DOMS)('parse/serialize APIs [%s]', (kind) => {
  it('outerHTML get/set, escaping of attributes and text', () => {
    const d = makeWindow(kind).document;
    const div = d.createElement('div');
    div.setAttribute('title', 'a"b&<');
    div.textContent = '<a&b>  "';
    expect(div.outerHTML).toBe('<div title="a&quot;b&amp;<">&lt;a&amp;b&gt; &nbsp;"</div>');
    const p = d.createElement('p');
    p.append(div);
    div.outerHTML = '<i>1</i><b>2</b>';
    expect(p.innerHTML).toBe('<i>1</i><b>2</b>');
    expect(div.parentNode).toBe(null);
    // detached element: outerHTML setter is a no-op
    div.outerHTML = '<u></u>';
    expect(div.outerHTML.startsWith('<div')).toBe(true);
    if (kind !== 'happy-dom') expect(errName(() => { d.documentElement.outerHTML = '<p>'; })).toBe('NoModificationAllowedError'); // PINNED to jsdom
  });

  it('insertAdjacentHTML positions', () => {
    const d = makeWindow(kind).document;
    const p = d.createElement('p');
    const s = d.createElement('span');
    s.textContent = 'x';
    p.append(s);
    s.insertAdjacentHTML('beforebegin', '<i>1</i>');
    s.insertAdjacentHTML('afterbegin', '<i>2</i>');
    s.insertAdjacentHTML('beforeend', '<i>3</i>');
    s.insertAdjacentHTML('afterend', '<i>4</i>');
    expect(p.innerHTML).toBe('<i>1</i><span><i>2</i>x<i>3</i></span><i>4</i>');
    if (kind !== 'happy-dom') expect(errName(() => s.insertAdjacentHTML('nowhere', 'x'))).toBe('SyntaxError'); // PINNED: happy-dom 21 loops forever on an invalid position
    const lone = d.createElement('div');
    if (kind !== 'happy-dom') expect(errName(() => lone.insertAdjacentHTML('afterend', 'x'))).toBe('NoModificationAllowedError'); // PINNED to jsdom
    s.insertAdjacentText('afterbegin', '<t>');
    expect(s.firstChild.data).toBe('<t>');
    const e = d.createElement('em');
    expect(s.insertAdjacentElement('beforeend', e)).toBe(e);
    expect(s.lastChild).toBe(e);
  });

  it('innerHTML creates nodes with the right document, classes and wrappers', () => {
    const w = makeWindow(kind);
    const d = w.document;
    d.body.innerHTML = '<div id=a class="x y"><input type=checkbox><svg><rect/></svg></div>';
    const a = d.getElementById('a');
    expect(a.ownerDocument).toBe(d);
    expect(a.isConnected).toBe(true);
    expect(a.className).toBe('x y');
    expect(a.firstChild).toBeInstanceOf(w.HTMLInputElement);
    expect(a.lastChild.namespaceURI).toBe(SVG);
    expect(a.lastChild.firstChild.tagName).toBe('rect');
    d.body.innerHTML = '';
    expect(d.body.childNodes.length).toBe(0);
    expect(a.isConnected).toBe(false);
    expect(d.getElementById('a')).toBe(null);
    expect(a.parentNode).toBe(null);
  });

  it('template.content', () => {
    const d = makeWindow(kind).document;
    const t = d.createElement('template');
    t.innerHTML = '<p>in</p>';
    expect(t.childNodes.length).toBe(0);
    expect(t.content.nodeType).toBe(11);
    expect(t.content.firstChild.tagName).toBe('P');
    expect(t.content).toBe(t.content);
    expect(t.innerHTML).toBe('<p>in</p>');
    if (kind !== 'happy-dom') expect(t.content.ownerDocument).not.toBe(d); // PINNED to jsdom: happy-dom 21 diverges
    d.body.innerHTML = '<template id=tt><b>x</b></template>';
    const tt = d.getElementById('tt');
    expect(tt.content.firstChild.textContent).toBe('x');
    expect(tt.content.getElementById).toBeTypeOf('function');
  });

  it('createContextualFragment (RTL asFragment) and parsing never runs scripts', () => {
    const w = makeWindow(kind);
    const d = w.document;
    w.__ran = false;
    const f = d.createRange().createContextualFragment('<div>a</div><script>window.__ran = true</script>');
    expect(f.nodeType).toBe(11);
    expect(f.firstChild.textContent).toBe('a');
    d.body.innerHTML = '<script>window.__ran = true</script>';
    expect(w.__ran).toBe(false);
  });

  it('textContent / innerHTML on deep trees', () => {
    const d = makeWindow(kind).document;
    const div = d.createElement('div');
    div.innerHTML = '<span>'.repeat(300) + 'x';
    expect(div.textContent).toBe('x');
    expect(div.innerHTML.length).toBe(300 * '<span></span>'.length + 1);
  });
});
