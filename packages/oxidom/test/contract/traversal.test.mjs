// TreeWalker / NodeIterator / NodeFilter (ROADMAP Stage 1, lib/traversal.cjs). The upstream coverage is
// conformance/parity (`--item traversal`: WPT dom/traversal, jsdom's node-iterator.js); these cases add what
// component libraries do with a TreeWalker (focus scopes walking tabbables) and the removal paths that run
// inside oxidom natives (innerHTML / outerHTML, textContent, replaceChildren, normalize, moves by insertion,
// convert-nodes-into-a-node and adoptNode, calls that fail part-way), where NodeIterator's pre-removing steps
// are oxidom-specific. Every assertion runs on jsdom, happy-dom and oxidom; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('traversal [%s]', (kind) => {
  let w;
  let d;
  let NF;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    NF = w.NodeFilter;
  });
  const ids = (nodes) => nodes.map((n) => (n === null ? null : n.id || n.nodeName));
  const collect = (step) => {
    const out = [];
    for (let n = step(); n !== null; n = step()) out.push(n);
    return out;
  };

  it('NodeFilter constants and interface objects', () => {
    expect(NF.FILTER_ACCEPT).toBe(1);
    expect(NF.FILTER_REJECT).toBe(2);
    expect(NF.FILTER_SKIP).toBe(3);
    if (kind !== 'happy-dom') expect(NF.SHOW_ALL).toBe(0xffffffff); // PINNED to jsdom: happy-dom 21 has -1
    expect(NF.SHOW_ELEMENT).toBe(1);
    expect(NF.SHOW_TEXT).toBe(4);
    expect(NF.SHOW_COMMENT).toBe(0x80);
    expect(NF.SHOW_DOCUMENT_FRAGMENT).toBe(0x400);
    if (kind !== 'happy-dom') expect(errName(() => new w.TreeWalker())).toBe('TypeError'); // PINNED to jsdom: happy-dom 21 throws a DOMException
    if (kind !== 'happy-dom') expect(errName(() => new w.NodeIterator())).toBe('TypeError'); // PINNED to jsdom: happy-dom 21 throws a DOMException
    const tw = d.createTreeWalker(d.body);
    expect(tw).toBeInstanceOf(w.TreeWalker);
    if (kind !== 'happy-dom') expect(Object.prototype.toString.call(tw)).toBe('[object TreeWalker]'); // PINNED to jsdom: happy-dom 21 has no toStringTag
    expect(tw.root).toBe(d.body);
    expect(tw.currentNode).toBe(d.body);
    if (kind !== 'happy-dom') expect(tw.whatToShow).toBe(0xffffffff); // PINNED to jsdom: happy-dom 21 has -1
    expect(tw.filter).toBe(null);
    const ni = d.createNodeIterator(d.body, NF.SHOW_ELEMENT);
    expect(ni).toBeInstanceOf(w.NodeIterator);
    expect(ni.whatToShow).toBe(1);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21 has no referenceNode and throws DOMExceptions below
    expect(ni.referenceNode).toBe(d.body);
    expect(ni.pointerBeforeReferenceNode).toBe(true);
    expect(errName(() => d.createTreeWalker())).toBe('TypeError');
    expect(errName(() => d.createTreeWalker({}))).toBe('TypeError');
    expect(d.createTreeWalker(d.body, -1).whatToShow).toBe(0xffffffff); // unsigned long conversion
  });

  it('TreeWalker walks elements in document order with a focus-scope style filter', () => {
    d.body.innerHTML = `<div id="scope"><button id="a">a</button><span id="s">text<input id="b" tabindex="-1"></span>
      <div id="hidden" hidden><input id="c"></div><a id="d" href="#">d</a><textarea id="e"></textarea></div>`;
    const scope = d.getElementById('scope');
    const tabbable = (n) => (n.matches('button, input, a[href], textarea') && n.tabIndex >= 0 ? NF.FILTER_ACCEPT : NF.FILTER_SKIP);
    const walker = d.createTreeWalker(scope, NF.SHOW_ELEMENT, {
      acceptNode: (n) => (n.hidden ? NF.FILTER_REJECT : tabbable(n)),
    });
    expect(ids(collect(() => walker.nextNode()))).toEqual(['a', 'd', 'e']);
    expect(walker.currentNode.id).toBe('e');
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21's previousNode() returns null here
    expect(ids(collect(() => walker.previousNode()))).toEqual(['d', 'a']);
    // a function filter, and walking back from a currentNode set by hand
    const fw = d.createTreeWalker(scope, NF.SHOW_ELEMENT, (n) => (n.localName === 'input' ? NF.FILTER_ACCEPT : NF.FILTER_SKIP));
    fw.currentNode = d.getElementById('e');
    expect(ids([fw.previousNode(), fw.previousNode(), fw.previousNode()])).toEqual(['c', 'b', null]);
  });

  it('TreeWalker child/sibling/parent steps with SKIP and REJECT', () => {
    d.body.innerHTML = '<div id="r"><p id="p1"><b id="b1"></b><i id="i1"></i></p><p id="p2"><b id="b2"></b></p><p id="p3"></p></div>';
    const r = d.getElementById('r');
    const skipP = d.createTreeWalker(r, NF.SHOW_ELEMENT, (n) => (n.localName === 'p' ? NF.FILTER_SKIP : NF.FILTER_ACCEPT));
    expect(skipP.firstChild().id).toBe('b1'); // descends into skipped nodes
    expect(skipP.nextSibling().id).toBe('i1');
    expect(skipP.nextSibling().id).toBe('b2'); // through the skipped parent's sibling
    expect(skipP.parentNode().id).toBe('r');
    expect(skipP.lastChild().id).toBe('b2'); // p3 is empty and skipped
    const rejectP = d.createTreeWalker(r, NF.SHOW_ELEMENT, (n) => (n.localName === 'p' ? NF.FILTER_REJECT : NF.FILTER_ACCEPT));
    expect(rejectP.firstChild()).toBe(null); // rejected subtrees are not entered
    expect(rejectP.nextNode()).toBe(null);
    const all = d.createTreeWalker(r, NF.SHOW_ELEMENT);
    expect(ids(collect(() => all.nextNode()))).toEqual(['p1', 'b1', 'i1', 'p2', 'b2', 'p3']);
    expect(all.nextSibling()).toBe(null);
    expect(all.parentNode()).toBe(r);
    expect(all.parentNode()).toBe(null); // never above the root
  });

  it('whatToShow selects node types; SHOW_TEXT / SHOW_COMMENT', () => {
    d.body.innerHTML = '<div id="r">a<!--c1--><span>b</span><!--c2-->c</div>';
    const r = d.getElementById('r');
    const tw = d.createTreeWalker(r, NF.SHOW_TEXT);
    expect(collect(() => tw.nextNode()).map((n) => n.data)).toEqual(['a', 'b', 'c']);
    const cw = d.createTreeWalker(r, NF.SHOW_COMMENT);
    expect(collect(() => cw.nextNode()).map((n) => n.data)).toEqual(['c1', 'c2']);
    const ni = d.createNodeIterator(r, NF.SHOW_TEXT | NF.SHOW_COMMENT);
    expect(collect(() => ni.nextNode()).map((n) => n.data)).toEqual(['a', 'c1', 'b', 'c2', 'c']);
  });

  it('filter callback protocol: acceptNode is read on every call, errors propagate, recursion throws', () => {
    d.body.innerHTML = '<div id="r"><p id="x"></p><p id="y"></p></div>';
    const r = d.getElementById('r');
    let gets = 0;
    const tw = d.createTreeWalker(r, NF.SHOW_ELEMENT, {
      get acceptNode() {
        gets++;
        return () => NF.FILTER_ACCEPT;
      },
    });
    tw.nextNode();
    tw.nextNode();
    expect(gets).toBe(2);
    const missing = d.createTreeWalker(r, NF.SHOW_ELEMENT, {});
    expect(errName(() => missing.nextNode())).toBe('TypeError');
    expect(missing.currentNode).toBe(r);
    const boom = new Error('boom');
    const thrower = d.createTreeWalker(r, NF.SHOW_ELEMENT, () => {
      throw boom;
    });
    expect(() => thrower.firstChild()).toThrow(boom);
    expect(thrower.currentNode).toBe(r);
    let inner = null;
    const rec = d.createNodeIterator(r, NF.SHOW_ELEMENT, () => {
      inner = errName(() => rec.nextNode());
      return NF.FILTER_ACCEPT;
    });
    rec.nextNode();
    if (kind !== 'happy-dom') expect(inner).toBe('InvalidStateError'); // PINNED to jsdom: happy-dom 21 allows recursive filtering
    // the result is converted to unsigned short: 65537 -> 1 (FILTER_ACCEPT)
    const big = d.createTreeWalker(r, NF.SHOW_ELEMENT, () => 65537);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21 compares the raw value
    expect(big.firstChild().id).toBe('x');
    // the conversion is part of the callback call: re-entering from valueOf() throws too
    inner = null;
    const viaValueOf = d.createTreeWalker(r, NF.SHOW_ELEMENT, () => ({
      valueOf() {
        inner = errName(() => viaValueOf.nextNode());
        return NF.FILTER_ACCEPT;
      },
    }));
    expect(viaValueOf.firstChild().id).toBe('x');
    expect(inner).toBe('InvalidStateError');
  });

  it('a filter that sets currentNode: firstChild() stops at the current node as it is then', () => {
    d.body.innerHTML = '<div id="r"><div id="a"><span id="a1"></span></div><div id="b"></div></div>';
    const b = d.getElementById('b');
    const tw = d.createTreeWalker(d.getElementById('r'), NF.SHOW_ELEMENT, (n) => {
      if (n.id !== 'a1') return NF.FILTER_ACCEPT;
      tw.currentNode = b;
      return NF.FILTER_REJECT;
    });
    tw.currentNode = d.getElementById('a');
    expect(tw.firstChild()).toBe(b); // climbs out of a, which is no longer the current node
    expect(tw.currentNode).toBe(b);
  });

  it('NodeIterator walks forward and back, the pointer flips', () => {
    d.body.innerHTML = '<div id="r"><a id="a"></a><b id="b"><i id="i"></i></b><c id="c"></c></div>';
    const r = d.getElementById('r');
    const ni = d.createNodeIterator(r, NF.SHOW_ELEMENT);
    expect(ids(collect(() => ni.nextNode()))).toEqual(['r', 'a', 'b', 'i', 'c']);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21's NodeIterator has no referenceNode / pointer
    expect(ni.referenceNode.id).toBe('c');
    expect(ni.pointerBeforeReferenceNode).toBe(false);
    expect(ni.previousNode().id).toBe('c');
    expect(ni.pointerBeforeReferenceNode).toBe(true);
    expect(ids(collect(() => ni.previousNode()))).toEqual(['i', 'b', 'a', 'r']);
    expect(ni.detach()).toBe(undefined);
  });

  describe('NodeIterator pre-removing steps', () => {
    // PINNED to jsdom: happy-dom 21's NodeIterator has no referenceNode and no pre-removing steps
    const skip = kind === 'happy-dom';
    let r;
    let ni;
    beforeEach(() => {
      d.body.innerHTML = '<div id="r"><p id="p1"><b id="b1"></b></p><p id="p2"><b id="b2"></b></p><p id="p3"></p></div>';
      r = d.getElementById('r');
      ni = d.createNodeIterator(r, NF.SHOW_ELEMENT);
    });
    const advanceTo = (id) => {
      while (ni.nextNode().id !== id);
    };

    it('removeChild of the reference (pointer after) moves it back', () => {
      if (skip) return;
      advanceTo('b1');
      d.getElementById('p1').remove();
      expect(ni.referenceNode.id).toBe('r');
      expect(ni.pointerBeforeReferenceNode).toBe(false);
      expect(ni.nextNode().id).toBe('p2');
    });

    it('removeChild of the reference (pointer before) moves it forward', () => {
      if (skip) return;
      advanceTo('p2');
      ni.previousNode(); // pointer before p2
      r.removeChild(d.getElementById('p2'));
      expect(ni.referenceNode.id).toBe('p3');
      expect(ni.pointerBeforeReferenceNode).toBe(true);
      expect(ni.nextNode().id).toBe('p3');
    });

    it('innerHTML replacing the subtree (removal inside the parser native)', () => {
      if (skip) return;
      advanceTo('b2');
      r.innerHTML = '<em id="e"></em>';
      expect(ni.referenceNode).toBe(r);
      expect(ni.pointerBeforeReferenceNode).toBe(false);
      expect(ni.nextNode().id).toBe('e');
    });

    it('textContent and replaceChildren (replace-all natives)', () => {
      if (skip) return;
      advanceTo('p2');
      d.getElementById('p2').textContent = 'x';
      expect(ni.referenceNode.id).toBe('p2'); // only p2's children were removed
      advanceTo('p3');
      r.replaceChildren(d.createElement('hr'));
      expect(ni.referenceNode).toBe(r);
      expect(ni.nextNode().localName).toBe('hr');
    });

    it('moving the reference elsewhere (appendChild) counts as a removal', () => {
      if (skip) return;
      advanceTo('b1');
      d.body.appendChild(d.getElementById('p1'));
      expect(ni.referenceNode).toBe(r);
      expect(ni.nextNode().id).toBe('p2');
    });

    it('normalize removing the reference text node', () => {
      if (skip) return;
      const t = d.createNodeIterator(r, NF.SHOW_TEXT);
      const p3 = d.getElementById('p3');
      p3.append('a', 'b', '');
      expect(t.nextNode().data).toBe('a');
      expect(t.nextNode().data).toBe('b');
      p3.normalize();
      expect(t.referenceNode.data).toBe('ab');
      expect(t.nextNode()).toBe(null);
    });

    it('outerHTML, replaceChild and adoptNode remove the reference', () => {
      if (skip) return;
      advanceTo('b1');
      d.getElementById('p1').outerHTML = '<i id="n"></i>';
      expect(ni.referenceNode).toBe(r);
      expect(ni.pointerBeforeReferenceNode).toBe(false);
      expect(ni.nextNode().id).toBe('n');
      advanceTo('b2');
      r.replaceChild(d.createElement('hr'), d.getElementById('p2'));
      expect(ni.referenceNode.id).toBe('n');
      expect(ni.pointerBeforeReferenceNode).toBe(false);
      expect(ni.nextNode().localName).toBe('hr');
      d.implementation.createHTMLDocument('').adoptNode(ni.referenceNode); // the hr
      expect(ni.referenceNode.id).toBe('n');
      expect(ids(collect(() => ni.nextNode()))).toEqual(['p3']);
    });

    it('moving the reference with several nodes (convert nodes into a fragment)', () => {
      if (skip) return;
      advanceTo('b1');
      d.body.append(d.getElementById('p1'), 'x');
      expect(ni.referenceNode).toBe(r);
      expect(ni.nextNode().id).toBe('p2');
      advanceTo('b2');
      d.getElementById('p3').before(d.getElementById('b2'), 'y');
      expect(ni.referenceNode.id).toBe('p2');
      expect(ni.nextNode().id).toBe('b2'); // now r's child, before p3
      d.getElementById('b2').replaceWith('a', 'b');
      expect(ni.referenceNode.id).toBe('p2');
      expect(ni.pointerBeforeReferenceNode).toBe(false);
      expect(ni.nextNode().id).toBe('p3');
    });

    it('a call that fails before removing anything leaves the iterator where it was', () => {
      if (skip) return;
      advanceTo('b1');
      const p1 = d.getElementById('p1');
      const b1 = d.getElementById('b1');
      // these two fail validation after the pre-removing steps for moving p1 have moved the iterator out of it
      expect(errName(() => b1.appendChild(p1))).toBe('HierarchyRequestError');
      expect(ni.referenceNode).toBe(b1);
      expect(errName(() => d.getElementById('p3').insertBefore(p1, d.getElementById('b2')))).toBe('NotFoundError');
      expect(ni.referenceNode).toBe(b1);
      expect(errName(() => d.getElementById('p2').removeChild(b1))).toBe('NotFoundError'); // not a child: no steps
      expect(ni.referenceNode).toBe(b1);
      expect(ni.pointerBeforeReferenceNode).toBe(false);
      expect(ni.nextNode().id).toBe('p2');
    });

    it('a call that fails part-way keeps the steps for the removals it did', () => {
      if (skip) return;
      advanceTo('b1');
      const p1 = d.getElementById('p1');
      // p1 is moved into the conversion fragment, then the doctype fails the call
      expect(errName(() => d.body.append(p1, d.implementation.createDocumentType('html', '', '')))).toBe('HierarchyRequestError');
      expect(p1.parentNode.nodeType).toBe(11);
      expect(ni.referenceNode).toBe(r);
      expect(ni.nextNode().id).toBe('p2');
      // replaceChildren on a document: the converted nodes move, the replace-all then fails (two elements)
      const o = d.implementation.createHTMLDocument('');
      o.body.innerHTML = '<p id="q1"></p><p id="q2"></p>';
      const oi = o.createNodeIterator(o, NF.SHOW_ELEMENT);
      while (oi.nextNode().id !== 'q1');
      expect(errName(() => o.replaceChildren(o.getElementById('q1'), o.createElement('x')))).toBe('HierarchyRequestError');
      expect(o.documentElement.parentNode).toBe(o); // the children it would have replaced are still there
      expect(oi.referenceNode).toBe(o.body);
      expect(oi.pointerBeforeReferenceNode).toBe(false);
      expect(oi.nextNode().id).toBe('q2');
    });

    it("another document's iterators follow the removals in that document", () => {
      if (skip) return;
      const o = d.implementation.createHTMLDocument('');
      o.body.innerHTML = '<p id="q1"></p><p id="q2"></p><p id="q3"></p>';
      const oi = o.createNodeIterator(o.body, NF.SHOW_ELEMENT);
      oi.nextNode();
      oi.nextNode();
      advanceTo('b1');
      d.getElementById('p1').remove(); // only ni moves
      expect(oi.referenceNode.id).toBe('q1');
      // moving q1 into a document without iterators is still a removal from o
      d.implementation.createHTMLDocument('').body.appendChild(o.getElementById('q1'));
      expect(oi.referenceNode).toBe(o.body);
      expect(oi.nextNode().id).toBe('q2');
      d.getElementById('p2').appendChild(o.getElementById('q2'));
      expect(oi.referenceNode).toBe(o.body);
      expect(oi.nextNode().id).toBe('q3');
      expect(ni.referenceNode).toBe(r);
      expect(ids(collect(() => ni.nextNode()))).toEqual(['p2', 'b2', 'q2', 'p3']);
    });
  });
});
