// Cross-area contract (integration of A selectors/style, B events/forms/focus, C window): the state area B
// keeps in the node table drives area A's pseudo-classes and memos, A's computed display drives B's
// focusability, and C's window carries A's getComputedStyle, B's FormData entries and the Selection.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('integration [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });
  const $ = (id) => d.getElementById(id);
  const ids = (sel) => [...d.querySelectorAll(sel)].map((e) => e.id);

  it(':checked follows checkedness / selectedness (activation, setters, attribute only as default)', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's option:checked ignores default selectedness
    d.body.innerHTML = '<input id="c" type="checkbox"><input id="k" type="checkbox" checked>'
      + '<select id="s"><option id="o1">a</option><option id="o2">b</option></select>';
    expect(ids(':checked')).toEqual(['k', 'o1']);
    $('c').click();
    expect(ids('input:checked')).toEqual(['c', 'k']);
    $('k').checked = false; // the attribute stays: checkedness is dirty
    expect(ids('input:checked')).toEqual(['c']);
    expect($('k').matches(':checked')).toBe(false);
    $('s').value = 'b';
    expect(ids('option:checked')).toEqual(['o2']);
    $('o1').selected = true;
    expect(ids('option:checked')).toEqual(['o1']);
  });

  it(':focus / :focus-within follow focus() and blur() (qSA memo validated)', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom leaves body matching :focus after blur
    d.body.innerHTML = '<div id="w"><input id="a"><input id="b"></div>';
    expect(ids(':focus')).toEqual([]);
    $('a').focus();
    expect(ids(':focus')).toEqual(['a']);
    expect(ids('div:focus-within, input:focus-within')).toEqual(['w', 'a']);
    $('b').focus();
    expect(ids(':focus')).toEqual(['b']);
    $('b').blur();
    expect(ids(':focus')).toEqual([]);
    expect(ids('div:focus-within, input:focus-within')).toEqual([]);
  });

  it(':placeholder-shown / :valid / :invalid read the current value', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom lacks :placeholder-shown
    d.body.innerHTML = '<form id="f"><input id="i" placeholder="p" required>'
      + '<textarea id="t" placeholder="q" maxlength="3"></textarea></form>';
    expect(ids(':placeholder-shown')).toEqual(['i', 't']);
    expect(ids(':invalid')).toEqual(['f', 'i']);
    $('i').value = 'x';
    expect(ids(':placeholder-shown')).toEqual(['t']);
    expect(ids(':invalid')).toEqual([]);
    $('t').value = 'abcd'; // dom-selector: maxLength >= value.length
    expect(ids(':invalid')).toEqual(['f', 't']);
    expect($('i').matches(':valid')).toBe(true);
  });

  it('display:none (author sheet or inline) makes elements unfocusable', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom focuses inside display:none subtrees
    d.head.innerHTML = '<style>.gone { display: none }</style>';
    d.body.innerHTML = '<div class="gone"><input id="a"></div><div id="h"><input id="b"></div>';
    $('a').focus();
    expect(d.activeElement).toBe(d.body);
    $('b').focus();
    expect(d.activeElement).toBe($('b'));
    $('b').blur();
    $('h').style.display = 'none';
    $('b').focus();
    expect(d.activeElement).toBe(d.body);
    $('h').style.display = '';
    $('b').focus();
    expect(d.activeElement).toBe($('b'));
  });

  it('window.getComputedStyle sees inline style and author sheets', () => {
    // Values whose serialization jsdom and rsdom share (rsdom keeps keywords such as `red` / `bold` so that
    // jest-dom toHaveStyle round-trips; DESIGN §8, a documented divergence from jsdom 30).
    d.head.innerHTML = '<style>#p { color: #f00 }</style>';
    d.body.innerHTML = '<p id="p" style="font-weight: 700">x</p>';
    const cs = w.getComputedStyle($('p'));
    if (kind !== 'happy-dom') expect(cs.color).toBe('rgb(255, 0, 0)'); // PINNED to jsdom: happy-dom keeps #f00
    expect(cs.fontWeight).toBe('700');
    expect(cs.display).toBe('block');
  });

  it('focus collapses the selection to (element, 0)', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom does not touch the selection on focus
    d.body.innerHTML = '<input id="a">';
    $('a').focus();
    const s = w.getSelection();
    expect(s.anchorNode).toBe($('a'));
    expect(s.anchorOffset).toBe(0);
  });

  it('new FormData(form, submitter) lists the form entries', () => {
    d.body.innerHTML = '<form id="f"><input name="a" value="1"><input type="checkbox" name="c" checked>'
      + '<select name="s"><option>x</option><option selected>y</option></select>'
      + '<button id="go" name="go" value="v">go</button></form>';
    const fd = new w.FormData($('f'), $('go'));
    expect([...fd.entries()]).toEqual([['a', '1'], ['c', 'on'], ['s', 'y'], ['go', 'v']]);
  });

  it('FormData list operations (append/set/delete/get/getAll/has, iteration, Blob -> File)', () => {
    const fd = new w.FormData();
    fd.append('a', 1);
    fd.append('b', 'x');
    fd.append('a', '2');
    expect(fd.get('a')).toBe('1');
    expect(fd.getAll('a')).toEqual(['1', '2']);
    expect(fd.get('zz')).toBe(null);
    expect(fd.has('b')).toBe(true);
    fd.set('a', '3');
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's set() keeps the later same-name entries
    expect([...fd]).toEqual([['a', '3'], ['b', 'x']]);
    fd.set('c', '4');
    fd.delete('b');
    expect([...fd.keys()]).toEqual(['a', 'c']);
    expect([...fd.values()]).toEqual(['3', '4']);
    const seen = [];
    fd.forEach((v, k, o) => seen.push([k, v, o === fd]));
    expect(seen).toEqual([['a', '3', true], ['c', '4', true]]);
    const B = w.Blob ?? Blob; // jsdom only accepts its own realm's Blob
    fd.append('f', new B(['hi'], { type: 'text/plain' }), 'n.txt');
    const f = fd.get('f');
    expect([typeof f, f.name, f.size, f.type]).toEqual(['object', 'n.txt', 2, 'text/plain']);
    expect(() => fd.append('only-one')).toThrow(/2 arguments required/); // realm-specific TypeError in jsdom
  });

  it('Event classes from the window dispatch on DOM nodes', () => {
    d.body.innerHTML = '<button id="b">x</button>';
    const seen = [];
    $('b').addEventListener('ping', (e) => seen.push([e.type, e.detail, e instanceof w.Event]));
    $('b').dispatchEvent(new w.CustomEvent('ping', { detail: 7, bubbles: true }));
    expect(seen).toEqual([['ping', 7, true]]);
  });
});
