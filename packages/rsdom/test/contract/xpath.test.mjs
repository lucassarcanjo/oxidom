// XPath (ROADMAP Stage 3 `xpath`, DESIGN §39): document.evaluate, XPathResult and XPathEvaluator, as
// testing-library's xpath helpers, Playwright-style locators and scrapers use them. jsdom is the oracle.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('XPath [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    d.body.innerHTML = '<ul id="l"><li class="a">one</li><li>two</li><li class="a">three</li></ul><button>Save draft</button>';
  });

  it('finds a single node by text', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has no XPath
    const r = d.evaluate("//button[contains(., 'Save')]", d, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    expect(r.resultType).toBe(9);
    expect(r.singleNodeValue).toBe(d.querySelector('button'));
  });

  it('snapshots, iterators, and scalar results', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const { XPathResult } = w;
    const snap = d.evaluate('//li[@class="a"]', d, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    expect(snap.snapshotLength).toBe(2);
    expect(snap.snapshotItem(1).textContent).toBe('three');
    expect(d.evaluate('count(//li)', d, null, XPathResult.NUMBER_TYPE, null).numberValue).toBe(3);
    expect(d.evaluate('string(//li[2])', d, null, XPathResult.STRING_TYPE, null).stringValue).toBe('two');
    expect(d.evaluate('li', d.getElementById('l'), null, XPathResult.ANY_TYPE, null).resultType).toBe(4);
    const it2 = d.evaluate('//li', d, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    expect(it2.iterateNext().textContent).toBe('one');
    expect(it2.invalidIteratorState).toBe(false);
    d.body.append(d.createElement('p'));
    expect(it2.invalidIteratorState).toBe(true);
    expect(() => it2.iterateNext()).toThrow(/mutated/);
    expect(() => snap.numberValue).toThrow(/NUMBER_TYPE/);
  });

  it('an iterator survives mutations outside its document', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const it2 = d.evaluate('//li', d, null, w.XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    const out = [];
    let n;
    while ((n = it2.iterateNext())) {
      const s = d.createElement('span'); // detached: not the document's tree
      s.setAttribute('data-x', n.textContent);
      out.push(s);
    }
    expect(out.map((s) => s.dataset.x)).toEqual(['one', 'two', 'three']);
    const other = d.implementation.createHTMLDocument('');
    const it3 = d.evaluate('//li', d, null, w.XPathResult.UNORDERED_NODE_ITERATOR_TYPE, null);
    other.body.append(other.createElement('p'));
    expect(it3.invalidIteratorState).toBe(false);
    d.querySelector('li').className = 'b';
    expect(it3.invalidIteratorState).toBe(true);
  });

  it('XPathEvaluator and createExpression', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const expr = new w.XPathEvaluator().createExpression('//li[last()]');
    expect(expr.evaluate(d, w.XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue.textContent).toBe('three');
    expect(d.createExpression('//li').evaluate(d, 7).snapshotLength).toBe(3);
  });

  it('works on parsed XML documents', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    const x = new w.DOMParser().parseFromString('<r><item n="1"/><item n="2"/></r>', 'application/xml');
    expect(x.evaluate('sum(//item/@n)', x, null, w.XPathResult.NUMBER_TYPE, null).numberValue).toBe(3);
  });
});
