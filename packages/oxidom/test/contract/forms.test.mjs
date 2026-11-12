// Form controls contract (ROADMAP M5): prototype shape (React value tracking, DTL setNativeValue, user-event
// interceptors), the jsdom form oracle (docs/lab/research/jsdom.md §6.8), value modes, sanitization, selection,
// select/option, labels, form, fieldset, constraint validation. jsdom is the oracle; happy-dom pins inline.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('forms [%s]', (kind) => {
  let w;
  let d;
  const jsdomLike = kind !== 'happy-dom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });
  const $ = (id) => d.getElementById(id);

  it('prototype contract: own value/checked accessors on the immediate prototypes', () => {
    for (const [C, props] of [
      [w.HTMLInputElement, ['value', 'checked', 'selectionStart', 'selectionEnd']],
      [w.HTMLTextAreaElement, ['value', 'selectionStart', 'selectionEnd']],
      [w.HTMLSelectElement, ['value']],
    ]) {
      for (const p of props) {
        const desc = Object.getOwnPropertyDescriptor(C.prototype, p);
        expect(typeof desc?.get, `${C.name}.${p} get`).toBe('function');
        expect(typeof desc?.set, `${C.name}.${p} set`).toBe('function');
        expect(desc.configurable).toBe(true);
      }
    }
    for (const C of [w.HTMLInputElement, w.HTMLTextAreaElement]) {
      for (const m of ['setSelectionRange', 'setRangeText', 'select']) {
        expect(typeof Object.getOwnPropertyDescriptor(C.prototype, m)?.value, `${C.name}.${m}`).toBe('function');
      }
    }
    const input = d.createElement('input');
    expect(Object.prototype.hasOwnProperty.call(input, 'value')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input, 'checked')).toBe(false);
    expect(input.constructor.prototype).toBe(Object.getPrototypeOf(input));
    expect(Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'value')).toBe(undefined);
  });

  it("React's trackValueOnNode pattern works", () => {
    const node = d.createElement('input');
    d.body.appendChild(node);
    // react-dom-bindings/src/client/inputValueTracking.js
    const valueField = 'value';
    const descriptor = Object.getOwnPropertyDescriptor(node.constructor.prototype, valueField);
    let currentValue = '' + node[valueField];
    const { get, set } = descriptor;
    Object.defineProperty(node, valueField, {
      configurable: true,
      get() {
        return get.call(this);
      },
      set(value) {
        currentValue = '' + value;
        set.call(this, value);
      },
    });
    Object.defineProperty(node, valueField, { enumerable: descriptor.enumerable });
    const tracker = {
      getValue: () => currentValue,
      setValue: (v) => {
        currentValue = '' + v;
      },
    };
    node.value = 'a';
    expect(tracker.getValue()).toBe('a');
    expect(node.value).toBe('a');
    // DTL setNativeValue: the prototype setter bypasses the tracker
    const protoSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set;
    const ownSetter = Object.getOwnPropertyDescriptor(node, 'value').set;
    expect(protoSetter).not.toBe(ownSetter);
    protoSetter.call(node, 'b');
    expect(node.value).toBe('b');
    expect(tracker.getValue()).toBe('a'); // React sees a change
    delete node.value; // stopTracking
    expect(node.value).toBe('b');
  });

  it('value / defaultValue / attribute oracle (jsdom.md §6.8)', () => {
    const i = d.createElement('input');
    i.setAttribute('value', 'a');
    expect([i.value, i.defaultValue, i.getAttribute('value')]).toEqual(['a', 'a', 'a']);
    i.value = 'typed';
    expect([i.value, i.defaultValue, i.getAttribute('value')]).toEqual(['typed', 'a', 'a']);
    i.setAttribute('value', 'b');
    expect([i.value, i.defaultValue, i.getAttribute('value')]).toEqual(['typed', 'b', 'b']);
    i.defaultValue = 'c';
    expect([i.value, i.defaultValue, i.getAttribute('value')]).toEqual(['typed', 'c', 'c']);
    const j = d.createElement('input');
    j.defaultValue = 'x';
    expect([j.value, j.defaultValue, j.getAttribute('value')]).toEqual(['x', 'x', 'x']);
    j.value = null;
    expect(j.value).toBe('');
  });

  it('value modes and type normalisation', () => {
    const i = d.createElement('input');
    expect(i.type).toBe('text');
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom lowercases the type attribute itself
    i.type = 'CheckBox';
    expect([i.type, i.getAttribute('type'), i.value]).toEqual(['checkbox', 'CheckBox', 'on']);
    i.value = 'yes';
    expect(i.getAttribute('value')).toBe('yes');
    i.setAttribute('type', 'bogus');
    expect(i.type).toBe('text');
    const h = d.createElement('input');
    h.type = 'hidden';
    h.value = 'secret';
    expect([h.value, h.getAttribute('value')]).toEqual(['secret', 'secret']);
    const t = d.createElement('input');
    t.value = 'kept';
    t.type = 'hidden';
    expect(t.getAttribute('value')).toBe('kept');
    const b = d.createElement('button');
    expect(b.type).toBe('submit');
    b.type = 'RESET';
    expect([b.type, b.getAttribute('type')]).toEqual(['reset', 'reset']);
    b.setAttribute('type', 'nope');
    expect(b.type).toBe('submit');
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom 21 does not implement file input value semantics
      const f = d.createElement('input');
      f.type = 'file';
      expect(f.value).toBe('');
      f.value = '';
      expect(errName(() => { f.value = 'x'; })).toBe('InvalidStateError');
      expect(f.files.length).toBe(0);
    }
  });

  it('sanitization per type', () => {
    const mk = (type, v) => {
      const i = d.createElement('input');
      i.type = type;
      i.value = v;
      return i.value;
    };
    expect(mk('text', 'a\nb\rc')).toBe('abc');
    expect(mk('number', 'abc')).toBe('');
    expect(mk('number', '1.5')).toBe('1.5');
    expect(mk('email', '  a@b.c \n')).toBe('a@b.c');
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom skips these sanitization rules
      expect(mk('number', '1e3')).toBe('1e3');
      expect(mk('color', '#ABCDEF')).toBe('#abcdef');
      expect(mk('color', 'red')).toBe('#000000');
      expect(mk('date', '2024-02-30')).toBe('');
      expect(mk('date', '2024-02-29')).toBe('2024-02-29');
      expect(mk('time', '12:30')).toBe('12:30');
      expect(mk('url', ' http://x.y/ ')).toBe('http://x.y/');
      const r = d.createElement('input');
      r.type = 'range';
      expect(r.value).toBe('50');
      r.value = '500';
      expect(r.value).toBe('100');
      expect(mk('datetime-local', '2020-01-01 10:00:00')).toBe('2020-01-01T10:00');
    }
  });

  it('checked / defaultChecked / dirty checkedness / radio groups', () => {
    const c = d.createElement('input');
    c.type = 'checkbox';
    c.defaultChecked = true;
    expect([c.checked, c.hasAttribute('checked')]).toEqual([true, true]);
    c.checked = false;
    c.defaultChecked = true;
    expect(c.checked).toBe(false);
    // React's initInput: checked then toggle defaultChecked twice
    const r = d.createElement('input');
    r.type = 'checkbox';
    r.checked = true;
    r.defaultChecked = !r.defaultChecked;
    r.defaultChecked = false;
    expect(r.checked).toBe(true);
    d.body.innerHTML = '<form><input type=radio name=g id=r1 checked><input type=radio name=g id=r2></form>'
      + '<input type=radio name=g id=r3 checked>';
    $('r2').checked = true;
    expect([$('r1').checked, $('r2').checked, $('r3').checked]).toEqual([false, true, true]);
    $('r1').checked = true;
    expect([$('r1').checked, $('r2').checked]).toEqual([true, false]);
  });

  it('textarea: defaultValue is child text, dirty value, CRLF normalisation', () => {
    const t = d.createElement('textarea');
    t.textContent = 'dv';
    expect([t.value, t.defaultValue, t.type]).toEqual(['dv', 'dv', 'textarea']);
    t.value = 'x';
    t.textContent = 'dv2';
    expect([t.value, t.defaultValue]).toEqual(['x', 'dv2']);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom keeps CR/CRLF in the API value
    const u = d.createElement('textarea');
    u.value = 'a\r\nb\rc';
    expect(u.value).toBe('a\nb\nc');
    expect(u.textLength).toBe(5);
    d.body.innerHTML = '<textarea id="ta">line1\nline2</textarea>';
    expect($('ta').value).toBe('line1\nline2');
    u.defaultValue = 'new';
    expect(u.textContent).toBe('new');
  });

  it('select / option oracle', () => {
    d.body.innerHTML = '<select id="s"><option value="av">A</option><option value="bv">B</option><option>  Text   only </option></select>';
    const s = $('s');
    const [a, b, c] = Array.from(s.options);
    expect([s.value, s.selectedIndex, a.selected]).toEqual(['av', 0, true]);
    s.value = 'bv';
    expect([b.selected, b.hasAttribute('selected'), s.selectedIndex, a.selected]).toEqual([true, false, 1, false]);
    s.value = 'nope';
    expect([s.value, s.selectedIndex]).toEqual(['', -1]);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom does not strip/collapse option text
    expect([c.value, c.text, c.index]).toEqual(['Text only', 'Text only', 2]);
    s.selectedIndex = 2;
    expect(s.value).toBe('Text only');
    a.selected = true;
    expect([a.selected, c.selected, s.selectedIndex]).toEqual([true, false, 0]);
    expect(s.options.length).toBe(3);
    expect(s.length).toBe(3);
    expect(s.type).toBe('select-one');
    expect(Array.from(s.selectedOptions)).toEqual([a]);
    a.defaultSelected = true;
    expect(a.getAttribute('selected')).toBe('');
    // multiple
    const m = d.createElement('select');
    m.multiple = true;
    m.innerHTML = '<option>1</option><option>2</option>';
    expect([m.type, m.selectedIndex]).toEqual(['select-multiple', -1]);
    m.options[0].selected = true;
    m.options[1].selected = true;
    expect(m.selectedOptions.length).toBe(2);
    // options added later: the first option of a single select is selected
    const n = d.createElement('select');
    const o1 = d.createElement('option');
    o1.textContent = 'x';
    n.appendChild(o1);
    expect([n.selectedIndex, o1.selected]).toEqual([0, true]);
    const o2 = d.createElement('option');
    o2.setAttribute('selected', '');
    n.appendChild(o2);
    expect([o1.selected, o2.selected, n.selectedIndex]).toEqual([false, true, 1]);
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom lacks size / optgroup handling
      expect(n.size).toBe(0);
      n.innerHTML = '<optgroup label="g"><option>in</option></optgroup><option>out</option>';
      expect([n.options.length, n.value]).toEqual([2, 'in']);
    }
  });

  it('select / options indexed properties (jest-dom toHaveDisplayValue: Array.from(select))', () => {
    d.body.innerHTML = '<select id="s"><option value="a">A</option><optgroup label="g"><option value="b">B</option></optgroup></select>';
    const s = $('s');
    const [a, b] = s.querySelectorAll('option');
    expect([s[0], s[1], s[2], s[-1], s.options[1]]).toEqual([a, b, undefined, undefined, b]);
    expect(s[0]).toBe(a);
    // jest-dom getValues / getSelectValues
    b.selected = true;
    expect(Array.from(s).filter((o) => o.selected).map((o) => o.textContent)).toEqual(['B']);
    // live: no own index properties to resync
    const c = d.createElement('option');
    c.textContent = 'C';
    s.appendChild(c);
    expect([s.length, s[2]]).toEqual([3, c]);
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom's HTMLSelectElement is not iterable (WebIDL gives indexed+length interfaces
      // Array.prototype.values as @@iterator) and its indexed setter does not replace/remove
      expect([...s]).toEqual([a, b, c]);
      // indexed setter: null removes, existing index replaces, past the end pads
      s[0] = null;
      expect(Array.from(s, (o) => o.textContent)).toEqual(['B', 'C']);
      const z = d.createElement('option');
      z.textContent = 'Z';
      s[1] = z;
      expect([z.parentNode, c.parentNode, Array.from(s, (o) => o.textContent)]).toEqual([s, null, ['B', 'Z']]);
      const e = d.createElement('option');
      e.textContent = 'E';
      s.options[4] = e;
      expect(Array.from(s, (o) => o.textContent)).toEqual(['B', 'Z', '', '', 'E']);
      // replacing an option inside an <optgroup>: SPEC-CORRECT DIVERGENCE. jsdom replaces it as a child of the
      // select and throws NotFoundError; browsers (Chromium's HTMLSelectElement::SetOption -> ReplaceWith)
      // and oxidom replace it in its own parent.
      const y = d.createElement('option');
      y.textContent = 'Y';
      if (kind === 'jsdom') expect(errName(() => (s[0] = y))).toBe('NotFoundError');
      else {
        s[0] = y;
        expect([y.parentNode.tagName, Array.from(s, (o) => o.textContent)]).toEqual(['OPTGROUP', ['Y', 'Z', '', '', 'E']]);
      }
      s[9] = undefined; // nullable: remove(9) is a no-op
      expect(s.length).toBe(5);
    }
    expect(errName(() => {
      'use strict';
      s[0] = 5;
    })).toBe(kind === 'happy-dom' ? 'Error' : 'TypeError'); // PINNED to jsdom: happy-dom throws a plain Error
    // long selects (country lists): indices past the initial bound
    const big = d.createElement('select');
    for (let i = 0; i < 300; i++) big.appendChild(d.createElement('option')).textContent = `o${i}`;
    expect([big.length, big[299]?.textContent, big[300]]).toEqual([300, 'o299', undefined]);
  });

  it('form indexed getter is form.elements[i] (live, read-only)', () => {
    d.body.innerHTML = '<form id="f"><input name="a"><fieldset><select name="b"></select></fieldset><img name="i"><button>x</button></form>';
    const f = $('f');
    expect([f.length, f[0]?.tagName, f[1]?.tagName, f[2]?.tagName, f[3]?.tagName, f[4]]).toEqual([4, 'INPUT', 'FIELDSET', 'SELECT', 'BUTTON', undefined]);
    f.appendChild(d.createElement('textarea'));
    expect(f[4]?.tagName).toBe('TEXTAREA');
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom's form is not iterable and keeps assigned indices
      expect([...f].map((e) => e.tagName)).toEqual(['INPUT', 'FIELDSET', 'SELECT', 'BUTTON', 'TEXTAREA']);
      expect(errName(() => {
        f[0] = 1;
      })).toBe('TypeError');
      expect(f[0].tagName).toBe('INPUT');
    }
  });

  it('option constructor and label', () => {
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom's Option ignores defaultSelected
    const o = new w.Option('T', 'v', true, false);
    expect([o.text, o.value, o.defaultSelected, o.selected, o instanceof w.HTMLOptionElement]).toEqual(['T', 'v', true, false, true]);
    expect(o.label).toBe('T');
    o.label = 'L';
    expect(o.label).toBe('L');
  });

  it('selection API in UTF-16 code units', () => {
    const i = d.createElement('input');
    d.body.appendChild(i);
    i.value = 'a😀b';
    expect([i.selectionStart, i.selectionEnd, i.selectionDirection]).toEqual([4, 4, 'none']);
    i.setSelectionRange(1, 3);
    expect([i.selectionStart, i.selectionEnd]).toEqual([1, 3]);
    i.setSelectionRange(2, 10, 'backward');
    expect([i.selectionStart, i.selectionEnd, i.selectionDirection]).toEqual([2, 4, 'backward']);
    i.selectionStart = 3;
    expect([i.selectionStart, i.selectionEnd]).toEqual([3, 4]);
    i.selectionEnd = 1;
    expect([i.selectionStart, i.selectionEnd]).toEqual([1, 1]);
    i.select();
    expect([i.selectionStart, i.selectionEnd]).toEqual([0, 4]);
    i.value = 'hello world';
    i.setSelectionRange(6, 11);
    i.setRangeText('there');
    expect(i.value).toBe('hello there');
    expect([i.selectionStart, i.selectionEnd]).toEqual([6, 11]);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom's setRangeText ignores the selection mode
    i.setRangeText('X', 0, 5, 'end');
    expect([i.value, i.selectionStart, i.selectionEnd]).toEqual(['X there', 1, 1]);
    i.setRangeText('YY', 0, 1, 'select');
    expect([i.value, i.selectionStart, i.selectionEnd]).toEqual(['YY there', 0, 2]);
    expect(errName(() => i.setRangeText('z', 3, 1))).toBe('IndexSizeError');
    const e = d.createElement('input');
    e.type = 'email';
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom returns numbers for types without selection
      expect([e.selectionStart, e.selectionEnd, e.selectionDirection]).toEqual([null, null, null]);
      expect(errName(() => e.setSelectionRange(0, 0))).toBe('InvalidStateError');
      expect(errName(() => { e.selectionStart = 0; })).toBe('InvalidStateError');
    }
    const t = d.createElement('textarea');
    t.value = 'abc';
    expect([t.selectionStart, t.selectionEnd]).toEqual([3, 3]);
  });

  it('labels, control, htmlFor, form owner, form.elements', () => {
    d.body.innerHTML = '<form id="f" name="fn"><label id="l1" for="a">A</label><input id="a" name="x">'
      + '<label id="l2">B <select id="b"></select></label><input type="image" id="img"><fieldset id="fs"><textarea id="t"></textarea></fieldset>'
      + '<button id="btn">go</button></form><input id="outside" form="f"><label for="nobody" id="l3">?</label>';
    expect($('l1').control).toBe($('a'));
    expect($('l1').htmlFor).toBe('a');
    expect($('l2').control).toBe($('b'));
    expect($('l3').control).toBe(null);
    expect(Array.from($('a').labels)).toEqual([$('l1')]);
    expect(Array.from($('b').labels)).toEqual([$('l2')]);
    expect($('a').form).toBe($('f'));
    expect($('outside').form).toBe($('f'));
    expect($('l1').form).toBe($('f'));
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom includes image buttons in form.elements
    const ids = Array.from($('f').elements).map((e) => e.id);
    expect(ids).toEqual(['a', 'b', 'fs', 't', 'btn', 'outside']);
    expect($('f').length).toBe(6);
    expect($('f').elements.namedItem('x')).toBe($('a'));
    expect($('fs').elements.length).toBe(1);
    const hidden = d.createElement('input');
    hidden.type = 'hidden';
    expect(hidden.labels).toBe(null);
    if (jsdomLike) expect(d.createElement('div').labels).toBe(undefined); // PINNED to jsdom
    expect($('f').method).toBe('get');
    $('f').method = 'POST';
    expect($('f').method).toBe('post');
    expect($('f').action).toBe('http://localhost:3000/');
    $('f').setAttribute('action', '/submit?x=1');
    expect($('f').action).toBe('http://localhost:3000/submit?x=1');
  });

  it('form.reset restores defaults; reset is cancelable', () => {
    d.body.innerHTML = '<form id="f"><input id="i" value="d"><input type="checkbox" id="c"><textarea id="t">tx</textarea>'
      + '<select id="s"><option>a</option><option selected>b</option></select></form>';
    $('i').value = 'x';
    $('c').checked = true;
    $('t').value = 'changed';
    $('s').value = 'a';
    $('f').reset();
    expect([$('i').value, $('c').checked, $('t').value, $('s').value]).toEqual(['d', false, 'tx', 'b']);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom's reset event is not cancelable
    $('i').value = 'y';
    $('f').addEventListener('reset', (e) => e.preventDefault());
    $('f').reset();
    expect($('i').value).toBe('y');
  });

  it('fieldset disabled semantics', () => {
    d.body.innerHTML = '<fieldset id="fs" disabled><legend><input id="inLegend"></legend><input id="in" required></fieldset>';
    const fs = $('fs');
    expect(fs.disabled).toBe(true);
    expect(fs.type).toBe('fieldset');
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom ignores fieldset ancestry for validation
      expect($('in').willValidate).toBe(false);
      expect($('inLegend').willValidate).toBe(true);
      expect($('in').checkValidity()).toBe(true);
    }
    fs.disabled = false;
    expect($('in').willValidate).toBe(true);
  });

  it('constraint validation: validity flags, checkValidity fires invalid, messages', () => {
    const i = d.createElement('input');
    d.body.appendChild(i);
    i.required = true;
    expect([i.validity.valueMissing, i.validity.valid, i.willValidate]).toEqual([true, false, true]);
    let invalid = 0;
    i.addEventListener('invalid', (e) => {
      invalid++;
      expect([e.bubbles, e.cancelable]).toEqual([false, true]);
    });
    expect(i.checkValidity()).toBe(false);
    expect(i.reportValidity()).toBe(false);
    expect(invalid).toBe(2);
    expect(i.validationMessage).not.toBe('');
    i.value = 'x';
    expect([i.validity.valid, i.checkValidity(), i.validationMessage]).toEqual([true, true, '']);
    i.type = 'email';
    expect([i.validity.typeMismatch, i.validity.valid]).toEqual([true, false]);
    i.value = 'a@b.co';
    expect(i.validity.typeMismatch).toBe(false);
    i.type = 'text';
    i.setAttribute('pattern', '[a-z]+');
    i.value = 'abc';
    expect(i.validity.patternMismatch).toBe(false);
    i.value = 'ABC';
    expect(i.validity.patternMismatch).toBe(true);
    i.removeAttribute('pattern');
    i.setCustomValidity('custom!');
    expect([i.validity.customError, i.validity.valid, i.validationMessage]).toEqual([true, false, 'custom!']);
    i.setCustomValidity('');
    expect(i.validity.valid).toBe(true);
    const n = d.createElement('input');
    n.type = 'number';
    n.min = '2';
    n.max = '5';
    n.value = '7';
    expect([n.validity.rangeOverflow, n.validity.rangeUnderflow]).toEqual([true, false]);
    n.value = '1';
    expect([n.validity.rangeOverflow, n.validity.rangeUnderflow]).toEqual([false, true]);
    n.value = '3';
    expect(n.validity.valid).toBe(true);
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom computes tooLong/stepMismatch differently
      n.value = '2.5';
      expect(n.validity.stepMismatch).toBe(true);
      const t = d.createElement('input');
      t.maxLength = 2;
      t.value = 'abcdef';
      expect([t.validity.tooLong, t.validity.valid]).toEqual([false, true]);
      expect(errName(() => { t.maxLength = -1; })).toBe('IndexSizeError');
      expect([d.createElement('input').maxLength, d.createElement('textarea').minLength]).toEqual([-1, -1]);
      expect(i.validationMessage).toBe('');
      i.value = '';
      expect(i.validationMessage).toBe('Constraints not satisfied');
    }
    const cb = d.createElement('input');
    cb.type = 'checkbox';
    cb.required = true;
    expect(cb.validity.valueMissing).toBe(true);
    cb.checked = true;
    expect(cb.validity.valueMissing).toBe(false);
    const s = d.createElement('select');
    s.required = true;
    s.innerHTML = '<option value="">Pick</option><option>A</option>';
    expect(s.validity.valueMissing).toBe(true);
    s.selectedIndex = 1;
    expect(s.validity.valueMissing).toBe(false);
    const ta = d.createElement('textarea');
    ta.required = true;
    expect(ta.validity.valueMissing).toBe(true);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom validates button[type=button]
    const btn = d.createElement('button');
    btn.type = 'button';
    expect(btn.willValidate).toBe(false);
    d.body.innerHTML = '<form id="f"><input required id="r"></form>';
    expect($('f').checkValidity()).toBe(false);
    $('r').value = 'ok';
    expect($('f').checkValidity()).toBe(true);
  });

  it('reflection on form controls', () => {
    const i = d.createElement('input');
    i.name = 'n';
    i.placeholder = 'p';
    i.readOnly = true;
    i.disabled = true;
    expect([i.getAttribute('name'), i.getAttribute('placeholder'), i.hasAttribute('readonly'), i.hasAttribute('disabled')])
      .toEqual(['n', 'p', true, true]);
    i.indeterminate = true;
    expect([i.indeterminate, i.hasAttribute('indeterminate')]).toEqual([true, false]);
    expect(i.size).toBe(20);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom reflects rows/cols as strings
    const t = d.createElement('textarea');
    expect([t.rows, t.cols]).toEqual([2, 20]);
    const o = d.createElement('output');
    o.textContent = 'def';
    o.value = 'now';
    expect([o.value, o.defaultValue, o.type]).toEqual(['now', 'def', 'output']);
  });

  it('stepUp / stepDown with decimal steps, min / max and dates (jsdom _stepUpdate)', () => {
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom steps differently
    const i = d.createElement('input');
    i.type = 'number';
    i.step = '0.1';
    i.value = '0.1';
    i.stepUp(2);
    expect(i.value).toBe('0.3'); // Decimal arithmetic, not 0.30000000000000004
    i.min = '0';
    i.max = '0.35';
    i.stepUp(5);
    expect(i.value).toBe('0.3');
    i.stepDown(10);
    expect(i.value).toBe('0');
    i.value = '0.15';
    i.stepUp();
    expect(i.value).toBe('0.2'); // a misaligned value snaps to the step first
    const date = d.createElement('input');
    date.type = 'date';
    date.value = '2024-02-28';
    date.stepUp(2);
    expect(date.value).toBe('2024-03-01');
    // jsdom's #setValue: the dirty flag stays clear, so the value still follows the attribute
    const r = d.createElement('input');
    r.type = 'range';
    r.max = '10';
    r.valueAsNumber = 100; // stored raw, not sanitized
    expect(r.value).toBe('100');
    r.stepDown();
    r.setAttribute('value', '7');
    expect(r.value).toBe('7');
    const t = d.createElement('input');
    t.type = 'text';
    expect(() => t.stepUp()).toThrow();
    i.step = 'any';
    expect(() => i.stepUp()).toThrow();
  });

  it('valueAsNumber / valueAsDate across the date types', () => {
    if (!jsdomLike) return; // PINNED to jsdom
    const i = d.createElement('input');
    i.type = 'month';
    i.valueAsNumber = 12 * 54 + 2;
    expect(i.value).toBe('2024-03');
    expect(i.valueAsDate.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    i.type = 'week';
    i.valueAsDate = new Date(Date.UTC(2024, 0, 4));
    expect(i.value).toBe('2024-W01');
    i.type = 'time';
    i.valueAsNumber = 3_723_500;
    expect(i.value).toBe('01:02:03.5');
    i.type = 'datetime-local';
    i.valueAsNumber = Date.UTC(2020, 5, 1, 12, 30);
    expect(i.value).toBe('2020-06-01T12:30');
    expect(i.valueAsDate).toBe(null);
    expect(() => {
      i.valueAsDate = new Date();
    }).toThrow();
    i.type = 'date';
    expect(() => {
      i.valueAsDate = 5;
    }).toThrow(/Date|object/);
    i.valueAsDate = null;
    expect(i.value).toBe('');
    i.value = '2020-01-01';
    i.valueAsDate = undefined; // WebIDL object?: undefined is null
    expect(i.value).toBe('');
  });

  it('meter and progress values are clamped from their attributes', () => {
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom does not clamp
    const m = d.createElement('meter');
    m.setAttribute('min', '5');
    m.setAttribute('max', '2');
    m.setAttribute('value', '-3');
    expect([m.min, m.max, m.value, m.low, m.high, m.optimum]).toEqual([5, 5, 5, 5, 5, 5]);
    m.max = 15;
    m.low = 7.5;
    expect([m.max, m.low, m.high, m.optimum]).toEqual([15, 7.5, 15, 10]);
    expect(m.getAttribute('low')).toBe('7.5');
    expect(() => (m.value = NaN)).toThrow(/finite/);
    const p = d.createElement('progress');
    expect([p.value, p.max, p.position]).toEqual([0, 1, -1]);
    p.value = 3;
    p.max = 4;
    expect([p.value, p.max, p.position]).toEqual([3, 4, 0.75]);
    p.max = -1; // [ReflectPositive]: ignored
    expect(p.max).toBe(4);
    d.body.innerHTML = '<label>L <progress id="pr"></progress></label>';
    expect($('pr').labels.length).toBe(1);
  });
});
