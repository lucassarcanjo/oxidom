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

// Live ranges (DOM §5.5): every mutation path moves the boundary points. In rsdom the steps run inside the Rust
// mutation natives (src/range.rs), so the paths that are whole operations there (innerHTML, textContent,
// replaceChildren, normalize, adoptNode, moves by insertion) get their own cases.
describe.each(DOMS)('Range live updates and contents [%s]', (kind) => {
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
  const pts = (r) => [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
  // PINNED to jsdom: happy-dom 21 does not update ranges on most mutations
  const live = kind !== 'happy-dom';

  it('insertion and removal move offsets and points inside removed nodes', () => {
    if (!live) return;
    const r = range(root, 1, root, 3);
    root.insertBefore(d.createElement('i'), $('p1'));
    expect(pts(r)).toEqual([root, 2, root, 4]);
    const inner = range($('b').firstChild, 1, $('p2'), 1);
    $('p1').remove();
    expect(pts(inner)).toEqual([root, 1, $('p2'), 1]); // the start was inside p1; the end's container is not
    expect(pts(r)).toEqual([root, 1, root, 3]);
    const f = d.createDocumentFragment();
    f.append(d.createElement('s'), d.createElement('s'));
    root.insertBefore(f, root.firstChild);
    expect(pts(r)).toEqual([root, 3, root, 5]);
  });

  it('innerHTML, textContent and replaceChildren remove every child step by step', () => {
    if (!live) return;
    const r = range($('b').firstChild, 1, root, 3);
    root.innerHTML = '<i>x</i>';
    expect(pts(r)).toEqual([root, 0, root, 0]);
    const t = range(root.firstChild.firstChild, 1, root, 1);
    root.textContent = 'plain';
    expect(pts(t)).toEqual([root, 0, root, 0]);
    const s = range(root.firstChild, 2, root.firstChild, 4);
    root.replaceChildren(d.createElement('a'), d.createElement('a'));
    expect(pts(s)).toEqual([root, 0, root, 0]);
  });

  it('character data changes clamp and shift offsets', () => {
    if (!live) return;
    const t = $('p2').firstChild; // "four"
    const r = range(t, 1, t, 3);
    t.insertData(0, 'XX');
    expect(pts(r)).toEqual([t, 3, t, 5]);
    t.deleteData(2, 2); // "XXur": 3 falls inside the deleted span
    expect(pts(r)).toEqual([t, 2, t, 3]);
    t.data = 'new';
    expect(pts(r)).toEqual([t, 0, t, 0]);
    const s = range(t, 3, t, 3);
    t.appendData('er');
    expect(s.startOffset).toBe(3);
  });

  it('splitText and normalize carry points across the split and the merge', () => {
    if (!live) return;
    const t = $('p1').firstChild; // "one "
    const r = range(t, 1, t, 3);
    const after = range($('p1'), 1, $('p1'), 1);
    const tail = t.splitText(2);
    expect(pts(r)).toEqual([t, 1, tail, 1]);
    expect(pts(after)).toEqual([$('p1'), 2, $('p1'), 2]);
    $('p1').normalize();
    expect(pts(r)).toEqual([t, 1, t, 3]);
    // (p1, 2) sits after the merged node, not at its index: the removal shifts it down
    expect(pts(after)).toEqual([$('p1'), 1, $('p1'), 1]);
  });

  it('adopting a detached subtree into another document keeps its ranges live', () => {
    if (!live) return;
    const div = d.createElement('div');
    div.innerHTML = '<span>a</span><span>b</span>';
    const r = range(div, 1, div, 2);
    const other = d.implementation.createHTMLDocument('');
    other.adoptNode(div);
    div.insertBefore(other.createElement('i'), div.firstChild);
    expect(pts(r)).toEqual([div, 2, div, 3]);
    other.body.append(div);
    div.firstChild.remove();
    expect(pts(r)).toEqual([div, 1, div, 2]);
    // a node moved out of the range's subtree by insertion elsewhere is a removal
    const moved = range(div.lastChild.firstChild, 0, div.lastChild.firstChild, 1);
    other.body.prepend(div.lastChild);
    expect(pts(moved)).toEqual([div, 1, div, 1]);
  });

  it('cloneContents / extractContents / deleteContents', () => {
    const r = range($('p1').firstChild, 2, $('p2').firstChild, 2);
    const holder = d.createElement('div');
    holder.append(r.cloneContents());
    expect(holder.innerHTML).toBe('<p id="p1">e <b id="b">two</b> three</p><!--c--><p id="p2">fo</p>');
    expect(root.innerHTML).toBe('<p id="p1">one <b id="b">two</b> three</p><!--c--><p id="p2">four</p>');
    const x = d.createElement('div');
    x.append(r.extractContents());
    expect(x.innerHTML).toBe('<p id="p1">e <b id="b">two</b> three</p><!--c--><p id="p2">fo</p>');
    expect(root.innerHTML).toBe('<p id="p1">on</p><p id="p2">ur</p>');
    expect(pts(r)).toEqual([root, 1, root, 1]);
    const del = range(root.lastChild.firstChild, 0, root.lastChild.firstChild, 1);
    del.deleteContents();
    expect(root.lastChild.textContent).toBe('r');
    if (live) expect(del.collapsed).toBe(true); // PINNED to jsdom: happy-dom does not collapse after deleteContents
    if (live) expect(errName(() => range(d, 0, d, 2).extractContents())).toBe('HierarchyRequestError'); // the doctype. PINNED to jsdom: happy-dom extracts it
  });

  it('insertNode and surroundContents', () => {
    const t = $('p2').firstChild;
    const r = range(t, 2, t, 2);
    const i = d.createElement('i');
    r.insertNode(i);
    expect($('p2').innerHTML).toBe('fo<i></i>ur');
    if (live) expect(pts(r)).toEqual([t, 2, $('p2'), 2]);
    const s = range($('p2').lastChild, 0, $('p2').lastChild, 2);
    const u = d.createElement('u');
    s.surroundContents(u);
    expect($('p2').innerHTML).toBe('fo<i></i><u>ur</u>');
    // extraction leaves an empty Text where "ur" was; insertNode splits it at 0, so <u> lands at index 3
    if (kind !== 'happy-dom') expect(pts(s)).toEqual([$('p2'), 3, $('p2'), 4]); // PINNED to jsdom: happy-dom selects index 2
    expect(errName(() => range($('p1').firstChild, 1, $('b').firstChild, 1).surroundContents(d.createElement('em')))).toBe('InvalidStateError');
    expect(errName(() => range(root.childNodes[1], 0, root.childNodes[1], 0).insertNode(d.createElement('em')))).toBe('HierarchyRequestError');
    expect(errName(() => range(root, 0, root, 0).insertNode(root))).toBe('HierarchyRequestError');
  });
});
