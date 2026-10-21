// getComputedStyle (ROADMAP M6 computed-style items): UA defaults (jsdom's default stylesheet), [hidden],
// inheritance, inline !important, author <style> sheets, snapshot semantics, pseudo-elements, and the
// jest-dom / dom-accessibility-api consumers. jsdom is the oracle except where documented (computed
// values keep the specified serialization so jest-dom toHaveStyle round-trips).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, pkgDir } = require('./adapter.cjs');

const interfaces = require('../../lib/generated/interfaces.cjs');
const HTML_TAGS = [...new Set([...Object.values(interfaces.html).flat(), ...interfaces.plainHtml])]
  .filter((t) => !['html', 'head', 'body', 'frameset', 'frame', 'noscript', 'image'].includes(t));

/** The window's getComputedStyle (area C installs area A's on the rsdom window). */
function windowWithGcs(kind) {
  const w = makeWindow(kind);
  expect(typeof w.getComputedStyle).toBe('function');
  return w;
}

describe.each(DOMS)('getComputedStyle [%s]', (kind) => {
  let w;
  let d;
  let gcs;
  beforeEach(() => {
    w = windowWithGcs(kind);
    d = w.document;
    gcs = (el, p) => w.getComputedStyle(el, p);
  });

  it('UA display of every HTML element matches jsdom', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has its own (partial) defaults table
    const o = windowWithGcs('jsdom');
    const diffs = [];
    for (const tag of HTML_TAGS) {
      const a = o.document.createElement(tag);
      o.document.body.appendChild(a);
      const b = d.createElement(tag);
      d.body.appendChild(b);
      for (const p of ['display', 'visibility', 'position', 'pointer-events', 'opacity']) {
        const want = o.getComputedStyle(a).getPropertyValue(p);
        const got = gcs(b).getPropertyValue(p);
        if (got !== want) diffs.push(`${tag} ${p}: got ${got} want ${want}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('[hidden], input[type=hidden], dialog, template/script/style display:none', () => {
    d.body.innerHTML = '<p id=h hidden><span id=hs>x</span></p><input id=ih type=HIDDEN><input id=it><dialog id=dl></dialog>'
      + '<dialog id=dlo open></dialog><details id=det><summary id=sum>s</summary></details><div id=d hidden="until-found"></div>';
    const g = (id) => gcs(d.getElementById(id)).display;
    if (kind !== 'happy-dom') {
      expect(g('h')).toBe('none');
      // PINNED to jsdom: happy-dom ignores the hidden attribute and dialog/input[type=hidden] UA rules
      expect(g('hs')).toBe('inline');
      expect(g('ih')).toBe('none');
      expect(g('dl')).toBe('none');
      expect(g('dlo')).toBe('block');
      expect(g('sum')).toBe('list-item');
      expect(g('d')).toBe('block');
      expect(gcs(d.createElement('template')).display).toBe('none');
    }
    expect(g('it')).toBe('inline-block');
    // detached: UA defaults, like jsdom (PINNED: happy-dom returns '')
    if (kind !== 'happy-dom') expect(gcs(d.createElement('div')).display).toBe('block');
    d.getElementById('h').removeAttribute('hidden');
    expect(g('h')).toBe('block');
  });

  it('inheritance: visibility, pointer-events, color; display is not inherited', () => {
    d.body.innerHTML = '<div id=o style="visibility: hidden; pointer-events: none; color: rgb(1, 2, 3); display: flex"><span id=i>x</span></div>';
    const i = d.getElementById('i');
    expect(gcs(i).visibility).toBe('hidden');
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom does not inherit pointer-events
    expect(gcs(i).pointerEvents).toBe('none');
    expect(gcs(i).color).toBe('rgb(1, 2, 3)');
    expect(gcs(i).display).toBe('inline');
    i.style.visibility = 'visible';
    expect(gcs(i).visibility).toBe('visible');
    expect(gcs(i).getPropertyValue('visibility')).toBe('visible');
  });

  it('inline style and !important', () => {
    d.body.innerHTML = '<style>#x { display: grid !important } .y { display: flex }</style><div id=x class=y style="display: block"></div><div id=z class=y style="display: block"></div>';
    if (kind !== 'happy-dom') {
      expect(gcs(d.getElementById('x')).display).toBe('grid');
    }
    expect(gcs(d.getElementById('z')).display).toBe('block');
    d.getElementById('z').style.setProperty('display', 'none', 'important');
    expect(gcs(d.getElementById('z')).display).toBe('none');
  });

  it('author <style> sheets: tag, class, id, descendant and child combinators, specificity, order, @media', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's cascade differs (no [hidden] etc.)
    d.head.innerHTML = '<style>p { display: flex } .a { display: grid } div > .b { visibility: hidden } '
      + 'section p { display: contents } #i { position: absolute } .late { display: block } .late { display: table } '
      + '@media print { .m { display: none } } @media screen { .s { display: none } }</style>';
    d.body.innerHTML = '<p id=p></p><p class=a id=pa></p><div><span class=b id=sb></span></div><section><p id=sp></p></section>'
      + '<b id=i></b><i class=late id=late></i><i class=m id=m></i><i class=s id=s></i><p class="a" hidden id=ph></p>';
    const g = (id, p = 'display') => gcs(d.getElementById(id)).getPropertyValue(p);
    expect(g('p')).toBe('flex');
    expect(g('pa')).toBe('grid');
    expect(g('sb', 'visibility')).toBe('hidden');
    expect(g('sp')).toBe('contents');
    expect(g('i', 'position')).toBe('absolute');
    expect(g('late')).toBe('table');
    expect(g('m')).toBe('inline');
    expect(g('s')).toBe('none');
    expect(g('ph')).toBe('none'); // UA [hidden] has higher specificity than .a (jsdom cascade)
    // sheet text changes and removal re-cascade
    const style = d.head.querySelector('style');
    style.textContent = '.a { display: inline-block }';
    expect(g('pa')).toBe('inline-block');
    expect(g('p')).toBe('block');
    style.remove();
    expect(g('pa')).toBe('block');
    d.getElementById('pa').className = 'b';
  });

  it('class / id / attribute writes re-cascade while sheets exist', () => {
    if (kind === 'happy-dom') return;
    d.head.innerHTML = '<style>.on { display: none } [data-open="false"] { visibility: hidden }</style>';
    d.body.innerHTML = '<div id=x></div>';
    const x = d.getElementById('x');
    expect(gcs(x).display).toBe('block');
    x.className = 'on';
    expect(gcs(x).display).toBe('none');
    x.setAttribute('data-open', 'false');
    expect(gcs(x).visibility).toBe('hidden');
    x.setAttribute('data-open', 'true');
    expect(gcs(x).visibility).toBe('visible');
  });

  it('snapshot semantics for core properties; unbound function; pseudo-elements', () => {
    d.body.innerHTML = '<div id=x></div>';
    const x = d.getElementById('x');
    const cs = gcs(x);
    x.style.display = 'none';
    if (kind !== 'happy-dom') expect(cs.display).toBe('block'); // PINNED to jsdom: a snapshot (happy-dom is live)
    expect(gcs(x).display).toBe('none');
    const { getComputedStyle } = w; // jest-dom destructures it
    expect(getComputedStyle(x).display).toBe('none');
    if (kind === 'rsdom') {
      expect(getComputedStyle(x, '::before').content).toBe('none');
      expect(() => getComputedStyle({})).toThrow(TypeError);
      expect(() => { cs.color = 'red'; }).toThrow();
    }
  });

  it('resolved values for unspecified properties match jsdom', () => {
    if (kind === 'happy-dom') return;
    d.body.innerHTML = '<div id=d><span id=s>x</span></div><h1 id=h>t<b id=b>b</b></h1><a id=a href="#">l</a><td id=td></td>';
    const props = ['color', 'font-size', 'font-weight', 'background-color', 'margin', 'margin-top', 'padding', 'border',
      'border-top-width', 'width', 'height', 'z-index', 'float', 'line-height', 'text-align', 'cursor', 'box-sizing',
      'overflow', 'flex', 'transform', 'content', 'font-family', 'gap', 'outline'];
    const o = windowWithGcs('jsdom');
    o.document.body.innerHTML = d.body.innerHTML;
    const diffs = [];
    for (const id of ['d', 's', 'h', 'b', 'a']) {
      for (const p of props) {
        const want = o.getComputedStyle(o.document.getElementById(id)).getPropertyValue(p);
        const got = gcs(d.getElementById(id)).getPropertyValue(p);
        if (got !== want) diffs.push(`#${id} ${p}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('computed colours, font weights and lengths resolve like jsdom (ROADMAP computed-values)', () => {
    if (kind === 'happy-dom') return;
    const html = '<style>.g { color: grey } .t { background-color: transparent; border-top-color: Canvas }</style>' +
      '<div id=p class=g style="font-size: 20px"><p id=c class=t style="width: 2em; height: 3rem; margin-left: 1in; ' +
      'padding-top: 10vh; text-indent: 10pt; line-height: 1.5; font-weight: bold; outline-color: currentcolor"></p></div>';
    const read = (doc, win) => {
      doc.body.innerHTML = html;
      const out = {};
      for (const id of ['p', 'c']) {
        const cs = win.getComputedStyle(doc.getElementById(id));
        for (const p of ['color', 'background-color', 'border-top-color', 'outline-color', 'column-rule-color', 'width',
          'height', 'margin-left', 'padding-top', 'text-indent', 'line-height', 'font-weight', 'font']) {
          out[`#${id} ${p}`] = cs.getPropertyValue(p);
        }
      }
      return out;
    };
    const o = windowWithGcs('jsdom');
    const got = read(d, { getComputedStyle: gcs });
    expect(got).toEqual(read(o.document, o));
    expect(got['#c color']).toBe('rgb(128, 128, 128)');
    expect(got['#c width']).toBe('40px');
  });

  it('rem reads the root from detached elements; vw/vh follow innerWidth/innerHeight', () => {
    if (kind === 'happy-dom') return;
    const run = (doc, win) => {
      doc.documentElement.style.fontSize = '10px';
      const det = doc.createElement('div');
      det.style.width = '2rem';
      const before = win.getComputedStyle(det).width;
      doc.documentElement.style.fontSize = '30px';
      const v = doc.createElement('div');
      v.style.cssText = 'width: 10vw; height: 10vh';
      doc.body.appendChild(v);
      win.innerWidth = 500;
      win.innerHeight = 400;
      const cs = win.getComputedStyle(v);
      return [before, win.getComputedStyle(det).width, cs.width, cs.height];
    };
    const o = windowWithGcs('jsdom');
    const got = run(d, w);
    expect(got).toEqual(run(o.document, o));
    expect(got).toEqual(['20px', '60px', '50px', '40px']);
  });

  it('jest-dom toHaveStyle: keyword colours and weights do not round-trip, as on jsdom 30', async () => {
    const matchersPath = path.join(pkgDir('@testing-library/jest-dom'), 'dist/matchers.js');
    const matchers = require(matchersPath);
    d.body.innerHTML = '<div id=x style="color: red; font-weight: bold; background-color: #1e1e1e; padding: 8px 12px; border-width: 1px"></div>';
    const x = d.getElementById('x');
    const run = (css) => matchers.toHaveStyle.call({ isNot: false, utils: { matcherHint: () => '', printExpected: String, printReceived: String, RECEIVED_COLOR: String, EXPECTED_COLOR: String }, equals: Object.is }, x, css).pass;
    const colorRed = run('color: red');
    const bold = run({ fontWeight: 'bold' });
    if (kind !== 'happy-dom') {
      // computed values resolve (rgb(255, 0, 0) / 700) while copy.style keeps the keywords, so
      // `.not.toHaveStyle('color: red')` passes on a red element: rsdom keeps that jsdom behaviour
      expect([colorRed, bold]).toEqual([false, false]);
    } else {
      expect([colorRed, bold]).toEqual([true, true]); // PINNED: happy-dom computes specified values
    }
    expect(run('background-color: #1e1e1e')).toBe(true);
    if (kind !== 'happy-dom') expect(run({ backgroundColor: 'rgb(30, 30, 30)' })).toBe(true); // PINNED: happy-dom keeps hex
    if (kind !== 'happy-dom') expect(run('padding: 8px 12px')).toBe(true);
    expect(run('color: blue')).toBe(false);
  });

  it('accessible name of <button>Save<span>d</span></button> is "Saved" (UA display values)', () => {
    const api = path.join(pkgDir('dom-accessibility-api'), 'dist/index.js');
    const { computeAccessibleName } = require(api);
    d.body.innerHTML = '<button id=b>Save<span>d</span></button><button id=c>Save<div>d</div></button><button id=h>A<span hidden>B</span></button>';
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom computes `display: block` for <span> inside <button>
      expect(computeAccessibleName(d.getElementById('b'))).toBe('Saved');
      expect(computeAccessibleName(d.getElementById('c'))).toBe('Save d');
      expect(computeAccessibleName(d.getElementById('h'))).toBe('A');
    }
  });
});
