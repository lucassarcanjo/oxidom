// Selection (ROADMAP Stage 3, lib/selection.cjs, DESIGN §29). The upstream coverage is conformance/parity
// (`--item selection`: WPT selection/); these cases pin what editors (tiptap, lexical) and user-event rely on: the
// added Range is the selection's own (identity and live updates through it), backwards selections, the error
// types, containsNode / toString, and the selectionchange task. Every assertion runs on jsdom, happy-dom and
// rsdom; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('Selection [%s]', (kind) => {
  let w;
  let d;
  let s;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    d.body.innerHTML = '<div id="root"><p id="p1">one <b id="b">two</b> three</p><p id="p2">four</p></div>';
    s = w.getSelection();
    s.removeAllRanges();
  });
  const $ = (id) => d.getElementById(id);
  const point = () => [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset];

  it('starts empty', () => {
    expect(s).toBe(d.getSelection());
    expect(point()).toEqual([null, 0, null, 0]);
    expect(s.rangeCount).toBe(0);
    expect(s.type).toBe('None');
    expect(s.isCollapsed).toBe(true);
    expect(s.toString()).toBe('');
    expect(errName(() => s.getRangeAt(0))).toBe('IndexSizeError');
    if (kind !== 'happy-dom') expect(Object.prototype.toString.call(s)).toBe('[object Selection]'); // PINNED to jsdom: happy-dom has no toStringTag
  });

  it('addRange keeps the Range object, and later changes to it move the selection', () => {
    const r = d.createRange();
    const t = $('p1').firstChild;
    r.setStart(t, 1);
    r.setEnd(t, 3);
    s.addRange(r);
    expect(s.getRangeAt(0)).toBe(r);
    expect(point()).toEqual([t, 1, t, 3]);
    expect(s.type).toBe('Range');
    expect(s.toString()).toBe('ne');
    r.setEnd($('p2').firstChild, 2);
    expect(s.focusNode).toBe($('p2').firstChild);
    expect(s.toString()).toBe('ne two threefo');
    // a second range is ignored (one range per selection)
    const r2 = d.createRange();
    r2.selectNode($('p2'));
    s.addRange(r2);
    expect(s.rangeCount).toBe(1);
    expect(s.getRangeAt(0)).toBe(r);
    expect(errName(() => s.getRangeAt(1))).toBe('IndexSizeError');
  });

  it('removeRange needs the selection range; removeAllRanges and empty clear it', () => {
    const r = d.createRange();
    r.selectNodeContents($('b'));
    s.addRange(r);
    if (kind !== 'happy-dom') expect(errName(() => s.removeRange(d.createRange()))).toBe('NotFoundError'); // PINNED to jsdom: happy-dom ignores it
    if (kind !== 'happy-dom') expect(errName(() => s.removeRange({}))).toBe('TypeError'); // PINNED to jsdom: happy-dom throws NotFoundError
    s.removeRange(r);
    expect(s.rangeCount).toBe(0);
    s.addRange(r);
    s.empty();
    expect(s.rangeCount).toBe(0);
  });

  it('collapse and setPosition make a new collapsed range; collapse(null) empties', () => {
    const t = $('p1').firstChild;
    s.collapse(t, 2);
    expect(point()).toEqual([t, 2, t, 2]);
    expect(s.type).toBe('Caret');
    const r = s.getRangeAt(0);
    expect(r.collapsed).toBe(true);
    s.setPosition($('root'), 1);
    expect(s.getRangeAt(0)).not.toBe(r);
    expect(point()).toEqual([$('root'), 1, $('root'), 1]);
    s.collapse(null);
    expect(s.rangeCount).toBe(0);
    expect(errName(() => s.collapse(t, 99))).toBe('IndexSizeError');
    if (kind !== 'happy-dom') expect(errName(() => s.collapse(d.doctype, 0))).toBe('InvalidNodeTypeError'); // PINNED to jsdom: happy-dom accepts it
    // a node outside the document is ignored
    s.collapse(t, 1);
    s.collapse(d.createElement('div'), 0);
    if (kind !== 'happy-dom') expect(point()).toEqual([t, 1, t, 1]); // PINNED to jsdom: happy-dom collapses there
  });

  it('extend keeps the anchor and can make the selection backwards', () => {
    const t1 = $('p1').firstChild;
    const t2 = $('p2').firstChild;
    expect(errName(() => s.extend(t1, 0))).toBe('InvalidStateError');
    s.collapse(t2, 2);
    s.extend(t1, 1);
    expect(point()).toEqual([t2, 2, t1, 1]);
    const r = s.getRangeAt(0);
    expect([r.startContainer, r.startOffset, r.endContainer, r.endOffset]).toEqual([t1, 1, t2, 2]);
    expect(s.toString()).toBe('ne two threefo');
    s.extend(t2, 4);
    expect(point()).toEqual([t2, 2, t2, 4]);
    expect(s.toString()).toBe('ur');
  });

  it('setBaseAndExtent orders the range and remembers the direction', () => {
    const t1 = $('p1').firstChild;
    const b = $('b').firstChild;
    s.setBaseAndExtent(b, 3, t1, 0);
    expect(point()).toEqual([b, 3, t1, 0]);
    const r = s.getRangeAt(0);
    expect([r.startContainer, r.startOffset, r.endContainer, r.endOffset]).toEqual([t1, 0, b, 3]);
    expect(s.toString()).toBe('one two');
    expect(errName(() => s.setBaseAndExtent(t1, 99, t1, 0))).toBe('IndexSizeError');
    expect(errName(() => s.setBaseAndExtent(t1, 0))).toBe('TypeError');
  });

  it('collapseToStart / collapseToEnd, and their error when empty', () => {
    const t1 = $('p1').firstChild;
    const t2 = $('p2').firstChild;
    s.setBaseAndExtent(t2, 1, t1, 2);
    s.collapseToStart();
    expect(point()).toEqual([t1, 2, t1, 2]);
    s.setBaseAndExtent(t2, 1, t1, 2);
    s.collapseToEnd();
    expect(point()).toEqual([t2, 1, t2, 1]);
    s.removeAllRanges();
    expect(errName(() => s.collapseToStart())).toBe('InvalidStateError');
    expect(errName(() => s.collapseToEnd())).toBe('InvalidStateError');
  });

  it('selectAllChildren and containsNode', () => {
    s.selectAllChildren($('root'));
    expect(point()).toEqual([$('root'), 0, $('root'), 2]);
    expect(s.toString()).toBe('one two threefour');
    expect(s.containsNode($('p1'))).toBe(true);
    expect(s.containsNode($('b'))).toBe(true);
    s.selectAllChildren($('p1'));
    expect(s.containsNode($('b'))).toBe(true);
    expect(s.containsNode($('p2'))).toBe(false);
    // jsdom's partial containment is "starts before the node or ends after it", so a node wholly after the range
    // counts (the spec's "partially contained" would say false); rsdom follows jsdom
    if (kind !== 'happy-dom') expect(s.containsNode($('p2'), true)).toBe(true); // PINNED to jsdom: happy-dom says false
    expect(s.containsNode($('p2').firstChild, false)).toBe(false);
    const t = $('p1').firstChild;
    s.setBaseAndExtent(t, 1, $('b').firstChild, 1);
    expect(s.containsNode($('b'))).toBe(false);
    expect(s.containsNode($('b'), true)).toBe(true);
  });

  it('fires selectionchange on the document in a later task, only when the range changes', async () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom fires no selectionchange
    let n = 0;
    d.addEventListener('selectionchange', (e) => {
      n++;
      expect(e.bubbles).toBe(false);
    });
    s.collapse($('p1'), 0);
    expect(n).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(1);
    s.collapse($('p1'), 0); // same point: no change
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(1);
    s.removeAllRanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(2);
  });
});
