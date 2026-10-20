// Range and StaticRange (ROADMAP Stage 3, lib/range.cjs, DESIGN §25). The upstream coverage is conformance/parity
// (`--item ranges`: WPT dom/ranges); these cases pin what editors and testing libraries rely on: setting and
// comparing boundary points across subtrees, the error types, toString over mixed content, and Attr-rooted ranges.
// Every assertion runs on jsdom, happy-dom and rsdom; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('Range comparison and stringification [%s]', (kind) => {
  let w;
  let d;
  let root;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    d.body.innerHTML = '<div id="root"><p id="p1">one <b id="b">two</b> three</p><!--c--><p id="p2">four</p></div>';
    root = d.getElementById('root');
  });
  const $ = (id) => d.getElementById(id);
  const range = (sc, so, ec, eo) => {
    const r = d.createRange();
    r.setStart(sc, so);
    r.setEnd(ec, eo);
    return r;
  };

  it('starts collapsed at the document and exposes the comparison constants', () => {
    const r = new w.Range();
    expect(r.startContainer).toBe(d);
    expect(r.endOffset).toBe(0);
    expect(r.collapsed).toBe(true);
    expect(r.commonAncestorContainer).toBe(d);
    expect([w.Range.START_TO_START, w.Range.START_TO_END, w.Range.END_TO_END, w.Range.END_TO_START]).toEqual([0, 1, 2, 3]);
    expect(r.END_TO_START).toBe(3);
    if (kind !== 'happy-dom') expect(Object.prototype.toString.call(r)).toBe('[object Range]'); // PINNED to jsdom: happy-dom has no toStringTag
  });

  it('setStart / setEnd validate and collapse when out of order or out of root', () => {
    const r = range($('p1').firstChild, 1, $('p2').firstChild, 2);
    expect(r.commonAncestorContainer).toBe(root);
    expect(errName(() => r.setStart($('p1').firstChild, 99))).toBe('IndexSizeError');
    expect(errName(() => r.setEnd(d.doctype, 0))).toBe('InvalidNodeTypeError');
    if (kind !== 'happy-dom') expect(errName(() => r.setStart({}, 0))).toBe('TypeError'); // PINNED to jsdom: happy-dom does not check the argument type
    // a start after the end collapses the range at the new start
    r.setStart($('p2').firstChild, 3);
    expect(r.collapsed).toBe(true);
    expect(r.endContainer).toBe($('p2').firstChild);
    // an end in another tree collapses the range at the new end
    const detached = d.createElement('div');
    r.setEnd(detached, 0);
    expect(r.startContainer).toBe(detached);
    expect(r.collapsed).toBe(true);
    expect(errName(() => r.setStartBefore(detached))).toBe('InvalidNodeTypeError');
    expect(errName(() => r.selectNode(d))).toBe('InvalidNodeTypeError');
  });

  it('setStartBefore / setEndAfter / selectNode / selectNodeContents', () => {
    const r = d.createRange();
    r.setStartBefore($('b'));
    r.setEndAfter($('b'));
    expect([r.startContainer, r.startOffset, r.endContainer, r.endOffset]).toEqual([$('p1'), 1, $('p1'), 2]);
    r.selectNode($('p2'));
    expect([r.startContainer, r.startOffset, r.endOffset]).toEqual([root, 2, 3]);
    r.selectNodeContents($('p1').firstChild);
    expect([r.startOffset, r.endOffset]).toEqual([0, 4]);
    r.selectNodeContents(root);
    expect(r.endOffset).toBe(3);
    r.collapse(true);
    expect([r.endContainer, r.endOffset]).toEqual([root, 0]);
  });

  it('compareBoundaryPoints orders points across subtrees', () => {
    const a = range($('p1').firstChild, 0, $('b').firstChild, 1);
    const b = range($('b'), 0, $('p2'), 1);
    expect(a.compareBoundaryPoints(w.Range.START_TO_START, b)).toBe(-1);
    expect(a.compareBoundaryPoints(w.Range.END_TO_END, b)).toBe(-1);
    expect(a.compareBoundaryPoints(w.Range.START_TO_END, b)).toBe(1); // a's end vs b's start
    expect(a.compareBoundaryPoints(w.Range.END_TO_START, b)).toBe(-1); // a's start vs b's end
    expect(b.compareBoundaryPoints(w.Range.START_TO_START, a)).toBe(1);
    expect(a.compareBoundaryPoints(w.Range.START_TO_START, a.cloneRange())).toBe(0);
    // a container against one of its descendants: the offset decides
    const c = range($('p1'), 1, $('p1'), 1);
    expect(c.compareBoundaryPoints(w.Range.START_TO_START, b)).toBe(-1);
    c.setStart($('p1'), 2);
    expect(c.compareBoundaryPoints(w.Range.START_TO_START, b)).toBe(1);
    expect(errName(() => a.compareBoundaryPoints(4, b))).toBe('NotSupportedError');
    if (kind !== 'happy-dom') expect(a.compareBoundaryPoints(65536, b)).toBe(-1); // PINNED to jsdom: unsigned short wraps
    const other = d.createRange();
    other.selectNodeContents(d.createElement('div'));
    if (kind !== 'happy-dom') expect(errName(() => a.compareBoundaryPoints(0, other))).toBe('WrongDocumentError'); // PINNED to jsdom: happy-dom compares across trees
  });

  it('comparePoint / isPointInRange / intersectsNode', () => {
    const r = range($('p1').firstChild, 2, $('p2').firstChild, 2);
    expect(r.comparePoint($('p1'), 0)).toBe(-1);
    expect(r.comparePoint($('b'), 0)).toBe(0);
    expect(r.comparePoint($('p2').firstChild, 2)).toBe(0);
    expect(r.comparePoint(root, 3)).toBe(1);
    expect(r.isPointInRange($('b').firstChild, 1)).toBe(true);
    expect(r.isPointInRange(root, 0)).toBe(false);
    expect(r.isPointInRange(d.createElement('i'), 0)).toBe(false);
    if (kind !== 'happy-dom') expect(errName(() => r.comparePoint(d.createElement('i'), 0))).toBe('WrongDocumentError'); // PINNED to jsdom: happy-dom compares across trees
    expect(errName(() => r.comparePoint($('b'), 5))).toBe('IndexSizeError');
    expect(errName(() => r.isPointInRange($('b'), 5))).toBe('IndexSizeError');
    expect(r.intersectsNode($('b'))).toBe(true);
    expect(r.intersectsNode(root)).toBe(true);
    expect(r.intersectsNode(root.childNodes[1])).toBe(true); // the comment between the paragraphs
    const s = range($('p2').firstChild, 0, $('p2').firstChild, 1);
    expect(s.intersectsNode($('p1'))).toBe(false);
    if (kind !== 'happy-dom') expect(s.intersectsNode(d.createElement('i'))).toBe(false); // PINNED to jsdom: happy-dom intersects across trees
    if (kind !== 'happy-dom') expect(s.intersectsNode(d)).toBe(true); // no parent. PINNED to jsdom: happy-dom returns false
  });

  it('toString concatenates the Text data between the boundary points', () => {
    expect(range($('p1').firstChild, 2, $('p2').firstChild, 2).toString()).toBe('e two threefo');
    expect(range($('b').firstChild, 1, $('b').firstChild, 3).toString()).toBe('wo');
    expect(range(root, 0, root, 3).toString()).toBe('one two threefour');
    expect(String(range(root, 1, root, 2))).toBe(''); // only a comment
    expect(range(root.childNodes[1], 0, root.childNodes[1], 1).toString()).toBe('');
  });

  it('Attr-rooted ranges', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom does not collapse a range set into another root
    const attr = d.createAttribute('title');
    const r = d.createRange();
    r.setStart(attr, 0);
    expect(r.startContainer).toBe(attr);
    expect(r.endContainer).toBe(attr); // another root: collapsed there
    expect(r.commonAncestorContainer).toBe(attr);
    expect(r.toString()).toBe('');
    expect(errName(() => r.setStart(attr, 1))).toBe('IndexSizeError');
    expect(r.isPointInRange(d.body, 0)).toBe(false);
    expect(r.comparePoint(attr, 0)).toBe(0);
  });

  it('StaticRange', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21 has no StaticRange
    const t = $('p1').firstChild;
    const s = new w.StaticRange({ startContainer: t, startOffset: 3, endContainer: $('p2'), endOffset: 99 });
    expect([s.startContainer, s.startOffset, s.endContainer, s.endOffset, s.collapsed]).toEqual([t, 3, $('p2'), 99, false]);
    expect(s instanceof w.AbstractRange).toBe(true);
    expect(d.createRange() instanceof w.AbstractRange).toBe(true);
    expect(errName(() => new w.StaticRange({ startContainer: d.doctype, startOffset: 0, endContainer: t, endOffset: 0 }))).toBe('InvalidNodeTypeError');
    expect(errName(() => new w.StaticRange({ startContainer: t, startOffset: 0 }))).toBe('TypeError');
    expect(errName(() => new w.AbstractRange())).toBe('TypeError');
  });
});
