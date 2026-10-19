// Child-list module contract (DESIGN §16): children-changed steps run once per insert/remove step (a
// <select> resets its selectedness at each option insertion and removal, also inside replace-all), and the
// quiet path for fresh nodes (cloneNode, createHTMLDocument, DOMParser) settles them like jsdom's bottom-up
// construction: a cloned <select> resets against all of its options, nothing queues a MutationObserver
// record, and a cloned document's id map is populated.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

const flush = () => new Promise((r) => setTimeout(r, 0));

describe.each(DOMS)('child-list [%s]', (kind) => {
  let w;
  let d;
  const jsdomLike = kind !== 'happy-dom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  function select(html) {
    const s = d.createElement('select');
    s.innerHTML = html;
    return s;
  }
  const selected = (s) => Array.from(s.options, (o) => o.selected);

  it('cloneNode(true) runs the select reset against the complete option list', () => {
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom never resets a cloned select (selectedIndex -1)
    const plain = select('<option>a</option><option>b</option>').cloneNode(true);
    expect(plain.selectedIndex).toBe(0);
    expect(selected(plain)).toEqual([true, false]);

    const two = select('<option selected>a</option><option selected>b</option>').cloneNode(true);
    expect(selected(two)).toEqual([false, true]);
    expect(two.value).toBe('b');

    // The optgroup's options precede the direct option in tree order: the reset sees them all.
    const grouped = select('<optgroup><option>o1</option></optgroup><option>x</option>').cloneNode(true);
    expect(grouped.selectedIndex).toBe(0);
    expect(grouped.value).toBe('o1');

    const disabledFirst = select('<option disabled>a</option><option>b</option>').cloneNode(true);
    expect(disabledFirst.selectedIndex).toBe(1);
  });

  it('a clone takes selectedness from attributes, not from the source\'s user selection', () => {
    const s = select('<option>a</option><option>b</option><option>c</option>');
    s.selectedIndex = 2;
    const c = s.cloneNode(true);
    if (jsdomLike) expect(c.selectedIndex).toBe(0); // PINNED to jsdom: happy-dom copies the selection
    const viaImport = d.importNode(s, true);
    if (jsdomLike) expect(viaImport.selectedIndex).toBe(0); // PINNED to jsdom (as above)
  });

  it('replace-all resets the select at every removal (options auto-selected on the way out stay selected)', () => {
    const html = '<option id="a" selected>A</option><option id="b">B</option><option id="c">C</option>';
    const cases = {
      textContent: (s) => { s.textContent = ''; },
      innerHTML: (s) => { s.innerHTML = '<option id="x">X</option>'; },
      replaceChildren: (s) => { s.replaceChildren(); },
    };
    for (const [name, run] of Object.entries(cases)) {
      d.body.innerHTML = `<select id="s">${html}</select>`;
      const s = d.getElementById('s');
      const old = ['a', 'b', 'c'].map((id) => d.getElementById(id));
      run(s);
      // PINNED to jsdom: happy-dom resets once, after the whole replacement
      if (jsdomLike) expect(old.map((o) => o.selected), name).toEqual([true, true, true]);
      if (name === 'innerHTML') expect(s.selectedIndex).toBe(0);
    }
  });

  it('removing options one by one moves the selection like jsdom', () => {
    d.body.innerHTML = '<select id="s"><option id="a" selected>A</option><option id="b">B</option>'
      + '<option id="c">C</option></select>';
    const s = d.getElementById('s');
    const [a, b, c] = ['a', 'b', 'c'].map((id) => d.getElementById(id));
    a.remove();
    expect([a.selected, b.selected, c.selected]).toEqual([true, true, false]);
    expect(s.selectedIndex).toBe(0);
    s.removeChild(b);
    expect(c.selected).toBe(true);
    expect(s.value).toBe('C');
  });

  it('fresh nodes queue no records; inserting the clone queues one', async () => {
    d.body.innerHTML = '<div id="src"><p><b>x</b></p><select><option>a</option></select></div>';
    const records = [];
    const mo = new w.MutationObserver((rs) => records.push(...rs));
    mo.observe(d, { childList: true, subtree: true });
    const copy = d.getElementById('src').cloneNode(true);
    d.implementation.createHTMLDocument('t');
    new w.DOMParser().parseFromString('<p>p</p>', 'text/html');
    await flush();
    expect(records.length).toBe(0);
    d.body.appendChild(copy);
    await flush();
    expect(records.length).toBe(1);
    expect(records[0].addedNodes[0]).toBe(copy);
    mo.disconnect();
  });

  it('a cloned document is connected and indexes its ids; a cloned element is not', () => {
    d.body.innerHTML = '<div id="k"><span id="inner">s</span></div>';
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom's cloned document finds no ids
    const docCopy = d.cloneNode(true);
    const k = docCopy.getElementById('k');
    expect(k).not.toBe(null);
    expect(k).not.toBe(d.getElementById('k'));
    expect(k.isConnected).toBe(true);
    expect(k.ownerDocument).toBe(docCopy);
    expect(docCopy.getElementById('inner').parentNode).toBe(k);

    const elCopy = d.getElementById('k').cloneNode(true);
    expect(elCopy.isConnected).toBe(false);
    expect(d.getElementById('inner')).not.toBe(elCopy.firstChild);

    // The document copy's nodes are in its own id map only.
    d.getElementById('k').remove();
    expect(d.getElementById('k')).toBe(null);
    expect(docCopy.getElementById('k')).toBe(k);
    d.body.replaceChildren(elCopy);
    expect(d.getElementById('inner')).toBe(elCopy.firstChild);
  });

  it('createHTMLDocument builds a connected skeleton', () => {
    const doc = d.implementation.createHTMLDocument('T');
    if (jsdomLike) expect(doc.title).toBe('T'); // PINNED to jsdom: happy-dom returns ''
    expect(doc.head.isConnected).toBe(true);
    expect(doc.body.isConnected).toBe(true);
    // PINNED to jsdom: happy-dom creates no doctype
    if (jsdomLike) expect(Array.from(doc.childNodes, (n) => n.nodeName)).toEqual(['html', 'HTML']);
    expect(Array.from(doc.documentElement.childNodes, (n) => n.nodeName)).toEqual(['HEAD', 'BODY']);
    if (jsdomLike) expect(doc.head.firstChild.nodeName).toBe('TITLE'); // PINNED to jsdom: happy-dom has no <title>
  });
});
