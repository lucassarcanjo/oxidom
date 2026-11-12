// M9 review regressions (correctness / soundness findings), run on jsdom, happy-dom and oxidom.
// Every memo case reads once BEFORE the mutation (warming oxidom's Rust CsMemo, the facade `_cs` memo and
// the qSA memo) and once after: a memo that is not invalidated by the mutation returns the old value.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('M9 review: computed-style / qSA memo invalidation [%s]', (kind) => {
  let w;
  let d;
  const cs = (el, p) => w.getComputedStyle(el)[p];
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  // [sheet rule, body html, target id, property, mutation, expected before, expected after]
  const CASES = [
    ['button:disabled{pointer-events:none}', '<button id=t>x</button>', 'pointerEvents', (t) => (t.disabled = true), 'auto', 'none'],
    ['fieldset:disabled input{display:none}', '<fieldset id=f><input id=t></fieldset>', 'display', (t, dd) => dd.getElementById('f').setAttribute('disabled', ''), 'inline-block', 'none'],
    ['input:enabled{display:none}', '<input id=t disabled>', 'display', (t) => (t.disabled = false), 'inline-block', 'none'],
    ['div:lang(fr){display:none}', '<section id=s><div id=t>x</div></section>', 'display', (t, dd) => dd.getElementById('s').setAttribute('lang', 'fr'), 'block', 'none'],
    ['span:dir(rtl){opacity:0.5}', '<div id=s><span id=t>x</span></div>', 'opacity', (t, dd) => dd.getElementById('s').setAttribute('dir', 'rtl'), '1', '0.5'],
    ['div:read-write{position:absolute}', '<div id=t>x</div>', 'position', (t) => t.setAttribute('contenteditable', ''), 'static', 'absolute'],
    ['input:read-only{position:absolute}', '<input id=t>', 'position', (t) => (t.readOnly = true), 'static', 'absolute'],
    ['a:link{position:fixed}', '<a id=t>a</a>', 'position', (t) => t.setAttribute('href', '#'), 'static', 'fixed'],
    ['input:required{display:none}', '<input id=t>', 'display', (t) => (t.required = true), 'inline-block', 'none'],
    ['input:optional{display:none}', '<input id=t required>', 'display', (t) => (t.required = false), 'inline-block', 'none'],
    ['input:default{display:none}', '<input id=t type=checkbox>', 'display', (t) => (t.defaultChecked = true), 'inline-block', 'none'],
    ['option:default{display:none}', '<select><option>a</option><option id=t>b</option></select>', 'display', (t) => (t.defaultSelected = true), 'inline', 'none'],
    ['p:empty{visibility:hidden}', '<p id=t></p>', 'visibility', (t, dd) => {
      t.appendChild(dd.createTextNode(''));
      // re-warm after the child-list change, then change only the data
      w.getComputedStyle(t).visibility;
      t.firstChild.data = 'x';
    }, 'hidden', 'visible'],
    ['div:has(> p:empty){display:none}', '<div id=t><p>x</p></div>', 'display', (t) => {
      t.firstChild.firstChild.data = 'y';
      w.getComputedStyle(t).display;
      t.firstChild.firstChild.remove();
    }, 'block', 'none'],
  ];

  it.each(CASES)('%s', (rule, body, prop, mut, before, after) => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's computed style ignores most of these pseudo-classes
    d.head.innerHTML = `<style>${rule}</style>`;
    d.body.innerHTML = body;
    const t = d.getElementById('t');
    expect(cs(t, prop)).toBe(before);
    mut(t, d);
    expect(cs(t, prop)).toBe(after);
  });

  it(':lang() via xml:lang (namespaced attribute) invalidates the memo', () => {
    d.head.innerHTML = '<style>div:lang(fr){display:none}</style>';
    d.body.innerHTML = '<div id=t>x</div>';
    const t = d.getElementById('t');
    expect(cs(t, 'display')).toBe('block');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'fr');
    // oxidom honours xml:lang (Selectors 4); jsdom and happy-dom do not. Either way the computed style must
    // agree with matches() right after the write.
    if (kind === 'oxidom') expect(t.matches(':lang(fr)')).toBe(true);
    if (kind !== 'happy-dom') expect(cs(t, 'display')).toBe(t.matches(':lang(fr)') ? 'none' : 'block');
  });

  it('a stale display:none memo does not make a hidden control focusable', () => {
    d.head.innerHTML = '<style>div:lang(fr){display:none}</style>';
    d.body.innerHTML = '<div id=x><input id=i></div>';
    const i = d.getElementById('i');
    i.focus();
    expect(d.activeElement).toBe(i);
    i.blur();
    d.getElementById('x').setAttribute('lang', 'fr');
    i.focus();
    if (kind !== 'happy-dom') expect(d.activeElement).not.toBe(i); // PINNED to jsdom: happy-dom ignores display
  });

  it('setCustomValidity invalidates :invalid / :valid in qSA, matches() and computed style', () => {
    d.head.innerHTML = '<style>input:invalid{display:none}</style>';
    d.body.innerHTML = '<form id=f><input id=i value=x></form>';
    const i = d.getElementById('i');
    const f = d.getElementById('f');
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's :invalid ignores custom validity
    expect(d.querySelectorAll(':invalid').length).toBe(0);
    expect(d.querySelectorAll(':valid').length).toBe(2);
    expect(cs(i, 'display')).toBe('inline-block');
    i.setCustomValidity('bad');
    expect(i.matches(':invalid')).toBe(true);
    expect(d.querySelectorAll(':invalid').length).toBe(2); // input + form
    expect(d.querySelector('form:invalid')).toBe(f);
    expect(d.querySelectorAll(':valid').length).toBe(0);
    expect(cs(i, 'display')).toBe('none');
    i.setCustomValidity('');
    expect(d.querySelectorAll(':invalid').length).toBe(0);
    expect(cs(i, 'display')).toBe('inline-block');
  });
});

describe.each(DOMS)('M9 review: non-ASCII user strings never break parsers [%s]', (kind) => {
  let d;
  beforeEach(() => {
    d = makeWindow(kind).document;
  });

  it(':lang() matching with a multi-byte lang value', () => {
    d.head.innerHTML = '<style>:lang(x){color:red}</style>';
    d.body.innerHTML = '<div lang="éa"><p id=p>t</p></div><div lang="x-é"><p id=q>u</p></div>';
    const m = d.querySelector(':lang(x)'); // used to throw 'oxidom internal: ... not a char boundary'
    if (kind === 'oxidom') expect(m).toBe(d.getElementById('q').parentNode); // jsdom: null (it rejects the non-ASCII subtag)
    const p = d.getElementById('p');
    expect(p.matches(':lang(é)')).toBe(false);
    expect(d.defaultView.getComputedStyle(p).display).toBe('block');
  });

  it('time / datetime-local values with non-ASCII characters in fixed-width fields sanitize to ""', () => {
    const i = d.createElement('input');
    i.type = 'time';
    for (const v of ['00:0é', '0é:00', '12:3😀', '00:00:0é']) {
      i.value = v;
      expect(i.value).toBe('');
      if (kind !== 'happy-dom') expect(i.valueAsNumber).toBeNaN();
    }
    i.setAttribute('min', '00:0é');
    i.value = '10:00';
    expect(i.value).toBe('10:00');
    if (kind !== 'happy-dom') expect(i.checkValidity()).toBe(true);
    const j = d.createElement('input');
    j.setAttribute('value', '2024-01-01T00:0é');
    j.setAttribute('type', 'datetime-local');
    expect(j.type).toBe('datetime-local');
    if (kind !== 'happy-dom') expect(j.value).toBe(''); // PINNED to jsdom: happy-dom does not sanitize
    d.body.innerHTML = '<input id=t type=time value="12:3😀"><span id=after></span>';
    if (kind !== 'happy-dom') expect(d.getElementById('t').value).toBe(''); // PINNED to jsdom
    expect(d.getElementById('after')).not.toBe(null);
  });
});

describe.each(DOMS)('M9 review: DOM differential fixes [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });
  const later = () => new Promise((r) => setTimeout(r, 30));

  it('<details> fires one coalesced, non-bubbling toggle event from a task', async () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has no details toggle task
    d.body.innerHTML = '<details id=dt><summary id=sm>s</summary>t</details><details id=p open></details>';
    const dt = d.getElementById('dt');
    const log = [];
    d.addEventListener('toggle', (e) => log.push(`${e.target.id}:${e.target.open}:${e.bubbles}:${e.isTrusted}`), true);
    d.getElementById('sm').click();
    expect(dt.open).toBe(true);
    dt.open = false;
    dt.setAttribute('open', '');
    dt.setAttribute('open', 'x'); // a value change is not an add/remove
    expect(log).toEqual([]); // async
    await later();
    // #p: parser-created <details open> (the parser appends attributes: the change steps run)
    expect(log).toEqual(['p:true:false:true', 'dt:true:false:true']);
    log.length = 0;
    dt.removeAttribute('open');
    await later();
    expect(log).toEqual(['dt:false:false:true']);
    // parser-created <details open> (the parser appends attributes: attribute change steps run)
    log.length = 0;
    d.body.innerHTML = '<details id=q open></details>';
    await later();
    expect(log).toEqual(['q:true:false:true']);
  });

  it('isTrusted: UA-fired events are trusted, el.click() and dispatchEvent are not', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has no isTrusted
    d.body.innerHTML = '<form><label id=l>x<input type=checkbox id=c></label><input id=t><button id=b>s</button></form>';
    const log = [];
    for (const t of ['click', 'input', 'change', 'focus', 'focusin', 'blur', 'focusout', 'submit', 'x']) {
      d.addEventListener(t, (e) => {
        log.push(`${t}@${e.target.id || e.target.tagName}:${e.isTrusted}`);
        if (t === 'submit') e.preventDefault();
      }, true);
    }
    d.getElementById('l').click();
    d.getElementById('t').focus();
    d.getElementById('t').blur();
    d.getElementById('b').click();
    d.body.dispatchEvent(new w.Event('x'));
    expect(log).toEqual([
      'click@l:false', 'click@c:true', 'input@c:true', 'change@c:true', 'focus@t:true', 'focusin@t:true',
      'blur@t:true', 'focusout@t:true', 'click@b:false', 'submit@FORM:true', 'x@BODY:false',
    ]);
  });

  it('editing hosts are focusable even as <a> without href or a non-first <summary>', () => {
    const cases = [
      '<a id=t contenteditable=""></a>',
      '<div contenteditable=""><a id=t contenteditable=false></a></div>',
      '<details><summary>a</summary><summary id=t contenteditable>b</summary></details>',
    ];
    for (const h of cases) {
      d.body.innerHTML = h;
      const t = d.getElementById('t');
      t.focus();
      if (kind !== 'happy-dom') expect(d.activeElement, h).toBe(t); // PINNED to jsdom
      t.blur();
    }
  });

  it('select selectedness is reset only when its list of options changes', () => {
    d.body.innerHTML = '<select id=s><option>a</option><option>b</option></select>';
    const s = d.getElementById('s');
    s.selectedIndex = -1;
    s.appendChild(d.createElement('span'));
    if (kind !== 'happy-dom') expect(s.selectedIndex).toBe(-1); // PINNED to jsdom
    s.appendChild(d.createComment('x'));
    if (kind !== 'happy-dom') expect(s.selectedIndex).toBe(-1);
    const og = d.createElement('optgroup');
    s.appendChild(og);
    if (kind !== 'happy-dom') expect(s.selectedIndex).toBe(-1);
    og.appendChild(d.createElement('option'));
    expect(s.selectedIndex).toBe(0);
    s.selectedIndex = -1;
    s.appendChild(d.createElement('option'));
    expect(s.selectedIndex).toBe(0);
  });

  it('cloneNode does not copy the selection of input / textarea', () => {
    const ta = d.createElement('textarea');
    ta.value = 'abc';
    expect(ta.selectionStart).toBe(3);
    const c1 = ta.cloneNode(true);
    expect(c1.value).toBe('abc');
    if (kind !== 'happy-dom') expect([c1.selectionStart, c1.selectionEnd]).toEqual([0, 0]); // PINNED to jsdom
    const i = d.createElement('input');
    i.value = 'abcd';
    i.setSelectionRange(1, 2);
    const c2 = i.cloneNode();
    expect(c2.value).toBe('abcd');
    if (kind !== 'happy-dom') expect([c2.selectionStart, c2.selectionEnd]).toEqual([0, 0]);
  });

  it('dataset reads and writes the null-namespace data-* attribute only', () => {
    const f = d.createElement('div');
    f.setAttributeNS('urn:x', 'data-k', 'a');
    // HTML: the DOMStringMap getter / names consider null-namespace attributes only. jsdom and happy-dom
    // read by qualified name (so jsdom's own setter, which writes the null-namespace attribute, is not
    // read back); oxidom follows the spec for both.
    if (kind === 'oxidom') {
      expect(f.dataset.k).toBe(undefined);
      expect('k' in f.dataset).toBe(false);
      expect(Object.keys(f.dataset)).toEqual([]);
    }
    f.dataset.k = 'v';
    expect(Array.from(f.attributes, (a) => `${a.namespaceURI}|${a.name}=${a.value}`)).toEqual(['urn:x|data-k=a', 'null|data-k=v']);
    if (kind === 'oxidom') expect(f.dataset.k).toBe('v');
    expect(() => {
      f.dataset['a b'] = 'x';
    }).toThrow();
  });

  it('normalize() queues the characterData record even when there is nothing to append', async () => {
    const p = d.createElement('p');
    d.body.appendChild(p);
    const a = d.createTextNode('a');
    p.append(a, d.createTextNode(''));
    const mo = new w.MutationObserver(() => {});
    mo.observe(p, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    p.normalize();
    const recs = mo.takeRecords().map((r) => `${r.type}:${r.target === a ? 'a' : r.target.nodeName}:${r.oldValue}`);
    if (kind !== 'happy-dom') expect(recs).toEqual(['characterData:a:a', 'childList:P:null']); // PINNED to jsdom
    mo.disconnect();
  });

  it('<style type=text/foo> creates no sheet; changing type re-evaluates it', () => {
    d.head.innerHTML = '<style id=st type="text/foo">p{display:none}</style>';
    d.body.innerHTML = '<p id=p>x</p>';
    const p = d.getElementById('p');
    const cs = () => w.getComputedStyle(p).display;
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom applies any <style> type
    expect(cs()).toBe('block');
    // jsdom only re-evaluates a style block on connect / text change, not on a `type` change
    if (kind === 'jsdom') return;
    d.getElementById('st').setAttribute('type', 'TEXT/CSS');
    expect(cs()).toBe('none');
    d.getElementById('st').setAttribute('type', 'text/plain');
    expect(cs()).toBe('block');
  });

  it(':dir(): dir=auto directionality, any identifier parses, ::slotted/::part never match, :lang(*-US)', () => {
    d.body.innerHTML = '<div id=a dir=auto>שלום</div><input id=b dir=auto value="ש"><div id=c dir=auto>abc</div>'
      + '<p lang=en-US id=u>x</p><p lang=fr id=f>y</p>';
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom has no :dir(auto) / extended :lang ranges
      expect(['a', 'b', 'c'].map((id) => d.getElementById(id).matches(':dir(rtl)'))).toEqual([true, true, false]);
      d.getElementById('b').value = 'x';
      expect(d.getElementById('b').matches(':dir(rtl)')).toBe(false);
      expect(d.querySelectorAll(':lang(\\*-US)').length).toBe(1);
      expect(d.querySelectorAll(':dir(foo)').length).toBe(0);
      expect(d.querySelectorAll('::slotted(p)').length).toBe(0);
      expect(d.querySelectorAll('::part(x)').length).toBe(0);
    }
  });
});
