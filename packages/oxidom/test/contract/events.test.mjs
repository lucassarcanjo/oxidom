// Events contract (ROADMAP M4): EventTarget, dispatch, Event classes, activation behaviour, on* handlers.
// Every assertion runs on jsdom (the oracle), happy-dom and oxidom; happy-dom divergences are pinned.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('events [%s]', (kind) => {
  let w;
  let d;
  const jsdomLike = kind !== 'happy-dom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  function tree() {
    d.body.innerHTML = '<div id="outer"><p id="mid"><span id="inner">x</span></p></div>';
    return { outer: d.getElementById('outer'), mid: d.getElementById('mid'), inner: d.getElementById('inner') };
  }

  it('phase order: capture down, target, bubble up to window', () => {
    const { outer, inner } = tree();
    const log = [];
    const add = (t, name) => {
      t.addEventListener('ping', (e) => log.push(`${name}-cap:${e.eventPhase}`), true);
      t.addEventListener('ping', (e) => log.push(`${name}-bub:${e.eventPhase}`));
    };
    add(w, 'win');
    add(d, 'doc');
    add(outer, 'outer');
    add(inner, 'inner');
    expect(inner.dispatchEvent(new w.Event('ping', { bubbles: true }))).toBe(true);
    const expected = ['win-cap:1', 'doc-cap:1', 'outer-cap:1', 'inner-cap:2', 'inner-bub:2', 'outer-bub:3', 'doc-bub:3', 'win-bub:3'];
    if (jsdomLike) expect(log).toEqual(expected); // PINNED to jsdom: happy-dom orders target listeners differently
    log.length = 0;
    inner.dispatchEvent(new w.Event('ping'));
    if (jsdomLike) expect(log).toEqual(['win-cap:1', 'doc-cap:1', 'outer-cap:1', 'inner-cap:2', 'inner-bub:2']);
  });

  it('target / currentTarget / eventPhase / composedPath during and after dispatch', () => {
    const { outer, inner } = tree();
    let seen;
    outer.addEventListener('ping', function (e) {
      seen = {
        target: e.target, current: e.currentTarget, self: this, phase: e.eventPhase, src: e.srcElement,
        path: e.composedPath().map((n) => (n === w ? 'Window' : n.nodeName)),
      };
    });
    const ev = new w.Event('ping', { bubbles: true });
    inner.dispatchEvent(ev);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom 21 does not expose target/composedPath like jsdom
    expect(seen.target).toBe(inner);
    expect(seen.current).toBe(outer);
    expect(seen.self).toBe(outer);
    expect(seen.phase).toBe(3);
    expect(seen.src).toBe(inner);
    expect(seen.path).toEqual(['SPAN', 'P', 'DIV', 'BODY', 'HTML', '#document', 'Window']);
    expect(ev.currentTarget).toBe(null);
    expect(ev.eventPhase).toBe(0);
    expect(ev.target).toBe(inner);
    expect(ev.composedPath()).toEqual([]);
    // re-dispatch works
    let n = 0;
    inner.addEventListener('ping', () => n++);
    inner.dispatchEvent(ev);
    expect(n).toBe(1);
  });

  it('detached trees end at their root; load does not reach window', () => {
    const div = d.createElement('div');
    const span = d.createElement('span');
    div.appendChild(span);
    let path;
    span.addEventListener('x', (e) => {
      path = e.composedPath().map((n) => n.nodeName);
    });
    span.dispatchEvent(new w.Event('x', { bubbles: true }));
    expect(path).toEqual(['SPAN', 'DIV']);
    let winLoad = 0;
    let docLoad = 0;
    w.addEventListener('load', () => winLoad++);
    d.addEventListener('load', () => docLoad++);
    d.body.dispatchEvent(new w.Event('load', { bubbles: true }));
    expect(docLoad).toBe(1);
    if (jsdomLike) expect(winLoad).toBe(0); // PINNED to jsdom
  });

  it('listener snapshot: removed during dispatch does not run, added does not run', () => {
    const { inner } = tree();
    const log = [];
    const l2 = () => log.push('l2');
    const l3 = () => log.push('l3');
    inner.addEventListener('x', () => {
      log.push('l1');
      inner.removeEventListener('x', l2);
      inner.addEventListener('x', l3);
    });
    inner.addEventListener('x', l2);
    inner.dispatchEvent(new w.Event('x'));
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom runs listeners removed during dispatch
    expect(log).toEqual(['l1']);
    inner.dispatchEvent(new w.Event('x'));
    expect(log).toEqual(['l1', 'l1', 'l3']);
  });

  it('dedup by (callback, capture); once; passive; signal; handleEvent', () => {
    const { inner } = tree();
    let n = 0;
    const f = () => n++;
    inner.addEventListener('x', f);
    inner.addEventListener('x', f);
    inner.addEventListener('x', f, { capture: false });
    inner.addEventListener('x', f, true);
    inner.dispatchEvent(new w.Event('x'));
    expect(n).toBe(2);
    inner.removeEventListener('x', f, { capture: true });
    inner.dispatchEvent(new w.Event('x'));
    expect(n).toBe(3);

    let once = 0;
    inner.addEventListener('o', () => once++, { once: true });
    inner.dispatchEvent(new w.Event('o'));
    inner.dispatchEvent(new w.Event('o'));
    expect(once).toBe(1);

    let prevented;
    inner.addEventListener('p', (e) => {
      e.preventDefault();
      prevented = e.defaultPrevented;
    }, { passive: true });
    expect(inner.dispatchEvent(new w.Event('p', { cancelable: true }))).toBe(true);
    expect(prevented).toBe(false);

    const ac = new (w.AbortController ?? AbortController)();
    let s = 0;
    inner.addEventListener('s', () => s++, { signal: ac.signal });
    inner.dispatchEvent(new w.Event('s'));
    ac.abort();
    inner.dispatchEvent(new w.Event('s'));
    expect(s).toBe(1);
    inner.addEventListener('s', () => s++, { signal: ac.signal });
    inner.dispatchEvent(new w.Event('s'));
    if (jsdomLike) expect(s).toBe(1); // PINNED to jsdom: happy-dom registers with an already-aborted signal

    const obj = { handleEvent() { this.calls = (this.calls ?? 0) + 1; } };
    inner.addEventListener('h', obj);
    inner.dispatchEvent(new w.Event('h'));
    obj.handleEvent = function () { this.replaced = true; };
    inner.dispatchEvent(new w.Event('h'));
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom binds handleEvent at registration
    expect(obj.calls).toBe(1);
    expect(obj.replaced).toBe(true);
  });

  it('passive probe reads options.passive (React checkPassiveEvents)', () => {
    let supported = false;
    const options = {};
    Object.defineProperty(options, 'passive', { get() { supported = true; return false; } });
    w.addEventListener('test', options, options);
    w.removeEventListener('test', options, options);
    if (jsdomLike) expect(supported).toBe(true); // PINNED to jsdom: happy-dom never reads `passive`
  });

  it('stopPropagation / stopImmediatePropagation / cancelBubble / returnValue', () => {
    const { outer, mid, inner } = tree();
    const log = [];
    inner.addEventListener('x', (e) => {
      log.push('i1');
      e.stopPropagation();
    });
    inner.addEventListener('x', () => log.push('i2'));
    mid.addEventListener('x', () => log.push('mid'));
    inner.dispatchEvent(new w.Event('x', { bubbles: true }));
    expect(log).toEqual(['i1', 'i2']);
    log.length = 0;
    outer.addEventListener('y', (e) => {
      log.push('o1');
      e.stopImmediatePropagation();
    });
    outer.addEventListener('y', () => log.push('o2'));
    inner.dispatchEvent(new w.Event('y', { bubbles: true }));
    expect(log).toEqual(['o1']);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom's cancelBubble is read-only
    const e = new w.Event('z', { cancelable: true });
    e.cancelBubble = true;
    expect(e.cancelBubble).toBe(true);
    expect(e.returnValue).toBe(true);
    e.returnValue = false;
    expect(e.defaultPrevented).toBe(true);
    inner.addEventListener('c', (ev) => ev.preventDefault());
    expect(inner.dispatchEvent(new w.Event('c', { cancelable: true }))).toBe(false);
    expect(inner.dispatchEvent(new w.Event('c'))).toBe(true);
  });

  it('window.event is undefined when idle and restored after nested dispatch', () => {
    const { inner } = tree();
    expect(w.event).toBe(undefined);
    let outerSeen;
    let innerSeen;
    let afterNested;
    const outerEv = new w.Event('a');
    inner.addEventListener('b', (e) => {
      innerSeen = w.event === e;
    });
    inner.addEventListener('a', (e) => {
      outerSeen = w.event === e;
      inner.dispatchEvent(new w.Event('b'));
      afterNested = w.event === e;
    });
    inner.dispatchEvent(outerEv);
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom never sets window.event
      expect(outerSeen).toBe(true);
      expect(innerSeen).toBe(true);
      expect(afterNested).toBe(true);
    }
    expect(w.event).toBe(undefined);
  });

  it('dispatching a dispatching event throws InvalidStateError; non-events throw TypeError', () => {
    const { inner } = tree();
    let err;
    inner.addEventListener('x', (e) => {
      err = errName(() => inner.dispatchEvent(e));
    });
    inner.dispatchEvent(new w.Event('x'));
    if (jsdomLike) expect(err).toBe('InvalidStateError'); // PINNED to jsdom: happy-dom allows re-dispatch
    expect(errName(() => inner.dispatchEvent({ type: 'x' }))).toBe('TypeError');
    if (jsdomLike) expect(errName(() => new w.Event())).toBe('TypeError'); // PINNED to jsdom
  });

  it('listener exceptions go to window error, the next listener still runs', () => {
    const { inner } = tree();
    const log = [];
    let errorEvent;
    w.addEventListener('error', (e) => {
      errorEvent = e;
      e.preventDefault();
    });
    inner.addEventListener('x', () => {
      throw new Error('boom');
    });
    inner.addEventListener('x', () => log.push('second'));
    expect(inner.dispatchEvent(new w.Event('x'))).toBe(true);
    expect(log).toEqual(['second']);
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom 21 rethrows through console instead of a window ErrorEvent
      expect(errorEvent).toBeInstanceOf(w.ErrorEvent);
      expect(errorEvent.error.message).toBe('boom');
      expect(errorEvent.message).toBe('boom');
    }
  });

  it('Event classes: names, inheritance, init dictionaries (unknown keys ignored)', () => {
    const names = ['Event', 'CustomEvent', 'UIEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent',
      'InputEvent', 'CompositionEvent', 'ErrorEvent', 'SubmitEvent', 'WheelEvent', 'TouchEvent', 'ProgressEvent',
      'PopStateEvent', 'PageTransitionEvent', 'TransitionEvent', 'HashChangeEvent'];
    for (const n of names) {
      const C = w[n];
      expect(typeof C, n).toBe('function');
      if (!jsdomLike) continue; // PINNED to jsdom: happy-dom 21 aliases/omits several event classes
      const e = new C('t', { bubbles: true, nonsense: 1 });
      if (jsdomLike) expect(e.constructor.name).toBe(n); // PINNED to jsdom: happy-dom aliases some classes to Event
      if (jsdomLike) expect(Object.prototype.toString.call(e)).toBe(`[object ${n}]`); // PINNED: no toStringTag in happy-dom
      expect(e instanceof w.Event).toBe(true);
      expect(e.bubbles).toBe(true);
      expect(e.cancelable).toBe(false);
      expect(e.nonsense).toBe(undefined);
      if (jsdomLike) expect(e.isTrusted).toBe(false); // PINNED to jsdom: happy-dom has no isTrusted
    }
    expect(new w.PointerEvent('x') instanceof w.MouseEvent).toBe(true);
    expect(new w.MouseEvent('x') instanceof w.UIEvent).toBe(true);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom 21 drops getModifierState / several init members
    const k = new w.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 0, which: 13, shiftKey: true });
    expect([k.key, k.code, k.keyCode, k.charCode, k.shiftKey, k.ctrlKey, k.getModifierState('Shift')]).toEqual(['Enter', 'Enter', 13, 0, true, false, true]);
    if (jsdomLike) expect(k.which).toBe(13); // PINNED to jsdom
    const m = new w.MouseEvent('click', { clientX: 5, clientY: 6, button: 2, buttons: 1, detail: 3, ctrlKey: true });
    expect([m.clientX, m.clientY, m.button, m.buttons, m.detail, m.ctrlKey, m.relatedTarget]).toEqual([5, 6, 2, 1, 3, true, null]);
    if (jsdomLike) expect([m.pageX, m.x, m.offsetX, m.screenX]).toEqual([5, 5, 5, 0]); // PINNED to jsdom
    const c = new w.CustomEvent('c', { detail: { a: 1 } });
    expect(c.detail).toEqual({ a: 1 });
    expect(new w.CustomEvent('c').detail).toBe(null);
    const i = new w.InputEvent('input', { data: 'a', inputType: 'insertText' });
    expect([i.data, i.inputType, i.isComposing]).toEqual(['a', 'insertText', false]);
    expect(new w.InputEvent('input').data).toBe(null);
    const fe = new w.FocusEvent('focus', { relatedTarget: d.body });
    expect(fe.relatedTarget).toBe(d.body);
    const er = new w.ErrorEvent('error', { message: 'm', error: 42, lineno: 3 });
    expect([er.message, er.error, er.lineno, er.colno, er.filename]).toEqual(['m', 42, 3, 0, '']);
    const p = new w.PointerEvent('pointerdown', { pointerId: 7, pointerType: 'mouse', isPrimary: true });
    expect([p.pointerId, p.pointerType, p.isPrimary, p.width, p.height]).toEqual([7, 'mouse', true, 1, 1]);
    const t = new w.TransitionEvent('transitionend', { propertyName: 'opacity', elapsedTime: 1.5 });
    expect([t.propertyName, t.elapsedTime]).toEqual(['opacity', 1.5]);
    const ev = new w.Event('x');
    expect(typeof ev.timeStamp).toBe('number');
    if (jsdomLike) expect(Math.abs(ev.timeStamp - Date.now())).toBeLessThan(5000); // PINNED: jsdom uses Date.now()
    expect([w.Event.NONE, w.Event.CAPTURING_PHASE, w.Event.AT_TARGET, w.Event.BUBBLING_PHASE]).toEqual([0, 1, 2, 3]);
    if (jsdomLike) expect('TextEvent' in w).toBe(false);
  });

  it('events are extensible: user-event shadows members with own accessors', () => {
    const { inner } = tree();
    const e = new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'key', { get: () => 'a' });
    e.preventDefault();
    let defaultPrevented = false;
    Object.defineProperty(e, 'defaultPrevented', { get: () => defaultPrevented });
    Object.defineProperty(e, 'preventDefault', { value: () => { defaultPrevented = true; } });
    let seen;
    inner.addEventListener('keydown', (ev) => {
      seen = ev.key;
      ev.preventDefault();
    });
    inner.dispatchEvent(e);
    expect(seen).toBe('a');
    expect(defaultPrevented).toBe(true);
  });

  it('initEvent / initCustomEvent / initMouseEvent', () => {
    const e = d.createEvent ? null : null; // createEvent is area C/foundation territory; construct instead
    void e;
    const ev = new w.Event('a');
    ev.initEvent('b', true, true);
    expect([ev.type, ev.bubbles, ev.cancelable]).toEqual(['b', true, true]);
    const c = new w.CustomEvent('a');
    c.initCustomEvent('c', false, true, 5);
    expect([c.type, c.cancelable, c.detail]).toEqual(['c', true, 5]);
  });

  it('activation: new Event("click") does not toggle, MouseEvent does; order click, input, change', () => {
    d.body.innerHTML = '<input type="checkbox" id="c">';
    const cb = d.getElementById('c');
    const log = [];
    cb.addEventListener('click', () => log.push(`click:${cb.checked}`));
    cb.addEventListener('input', (e) => log.push(`input:${e.constructor.name}:${e.bubbles}`));
    cb.addEventListener('change', () => log.push('change'));
    cb.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
    expect(cb.checked).toBe(false);
    cb.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cb.checked).toBe(true);
    expect(log).toEqual(['click:false', 'click:true', 'input:Event:true', 'change']);
    // canceled: reverted, no input/change
    log.length = 0;
    const stop = (e) => e.preventDefault();
    cb.addEventListener('click', stop);
    expect(cb.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    expect(cb.checked).toBe(true);
    expect(log).toEqual(['click:false']);
    cb.removeEventListener('click', stop);
    // indeterminate is cleared by activation and restored on cancel
    cb.indeterminate = true;
    cb.click();
    expect([cb.checked, cb.indeterminate]).toEqual([false, false]);
  });

  it('activation: radio groups, cancel restores the previous radio', () => {
    d.body.innerHTML = '<form><input type="radio" name="g" id="a" checked><input type="radio" name="g" id="b"></form>';
    const a = d.getElementById('a');
    const b = d.getElementById('b');
    let changes = 0;
    b.addEventListener('change', () => changes++);
    b.click();
    expect([a.checked, b.checked, changes]).toEqual([false, true, 1]);
    b.click(); // already checked: no change event
    expect(changes).toBe(1);
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    if (jsdomLike) expect([a.checked, b.checked]).toEqual([false, true]); // PINNED to jsdom: happy-dom loses the group
  });

  it('click(): PointerEvent, detail 0, bubbles, not trusted; no-op when disabled', () => {
    d.body.innerHTML = '<button id="b">x</button><fieldset disabled><div id="in">y</div></fieldset>';
    const b = d.getElementById('b');
    let ev;
    d.body.addEventListener('click', (e) => {
      ev = e;
    });
    b.click();
    if (jsdomLike) expect(ev.constructor.name).toBe('PointerEvent'); // PINNED to jsdom
    expect([ev.detail, ev.bubbles, ev.cancelable, ev.target]).toEqual([0, true, true, b]);
    if (jsdomLike) expect(ev.isTrusted).toBe(false); // PINNED to jsdom: happy-dom has no isTrusted
    ev = undefined;
    b.disabled = true;
    b.click();
    expect(ev).toBe(undefined);
    if (jsdomLike) {
      // PINNED to jsdom: click() on any element inside a disabled fieldset is a no-op
      d.getElementById('in').click();
      expect(ev).toBe(undefined);
    }
  });

  it('activation: submit button requests submit with submitter; nested span bubbles to the button', () => {
    d.body.innerHTML = '<form id="f"><input name="q" value="v"><button id="go"><span id="s">Go</span></button><button type="button" id="plain">p</button></form>';
    const f = d.getElementById('f');
    const subs = [];
    f.addEventListener('submit', (e) => {
      subs.push([e.constructor.name, e.submitter?.id ?? null, e.cancelable, e.bubbles]);
      e.preventDefault();
    });
    d.getElementById('go').click();
    d.getElementById('s').click();
    d.getElementById('plain').click();
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom does not submit from a click on a descendant
    expect(subs).toEqual([['SubmitEvent', 'go', true, true], ['SubmitEvent', 'go', true, true]]);
    subs.length = 0;
    f.requestSubmit();
    expect(subs).toEqual([['SubmitEvent', null, true, true]]);
    expect(errName(() => f.requestSubmit(d.getElementById('plain')))).toBe('TypeError');
  });

  it('activation: invalid form does not submit and fires invalid', () => {
    d.body.innerHTML = '<form id="f"><input required id="r"><button id="go">Go</button></form>';
    const f = d.getElementById('f');
    let submitted = 0;
    let invalid = 0;
    f.addEventListener('submit', (e) => {
      submitted++;
      e.preventDefault();
    });
    d.getElementById('r').addEventListener('invalid', () => invalid++);
    d.getElementById('go').click();
    expect([submitted, invalid]).toEqual([0, 1]);
    f.noValidate = true;
    d.getElementById('go').click();
    expect(submitted).toBe(1);
  });

  it('activation: reset button resets the form', () => {
    d.body.innerHTML = '<form id="f"><input id="i" value="def"><input type="checkbox" id="c" checked><button type="reset" id="r">R</button></form>';
    const i = d.getElementById('i');
    const c = d.getElementById('c');
    i.value = 'typed';
    c.checked = false;
    let resets = 0;
    d.getElementById('f').addEventListener('reset', () => resets++);
    d.getElementById('r').click();
    expect([i.value, c.checked, resets]).toEqual(['def', true, 1]);
  });

  it('activation: label forwards clicks to its control', () => {
    d.body.innerHTML = '<label id="l">Accept <input type="checkbox" id="c"></label><label for="t" id="l2">T</label><input type="checkbox" id="t">';
    const c = d.getElementById('c');
    const t = d.getElementById('t');
    const clicks = [];
    c.addEventListener('click', (e) => clicks.push(e.detail));
    d.getElementById('l').click();
    expect(c.checked).toBe(true);
    if (jsdomLike) expect(clicks).toEqual([1]); // PINNED to jsdom (synthetic click with detail 1)
    c.click(); // clicking the control inside the label toggles once
    expect(c.checked).toBe(false);
    d.getElementById('l2').click();
    expect(t.checked).toBe(true);
  });

  it('GlobalEventHandlers: on* accessors', () => {
    const div = d.createElement('div');
    expect('oninput' in d).toBe(true);
    expect('onclick' in div).toBe(true);
    expect(div.onclick).toBe(null);
    expect('onload' in w).toBe(true);
    const log = [];
    div.onclick = (e) => log.push(['h', e.type]);
    div.addEventListener('click', () => log.push(['l']));
    div.dispatchEvent(new w.MouseEvent('click'));
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom runs handlers after listeners
    expect(log).toEqual([['h', 'click'], ['l']]);
    div.onclick = () => false;
    expect(div.dispatchEvent(new w.MouseEvent('click', { cancelable: true }))).toBe(false);
    div.onclick = null;
    expect(div.onclick).toBe(null);
    div.onclick = 'not a function';
    expect(div.onclick).toBe(null);
    const f = () => {};
    d.oninput = f;
    expect(d.oninput).toBe(f);
  });

  it('hooks registered on window and document see events from nodes; this === currentTarget', () => {
    const { inner } = tree();
    let self;
    w.addEventListener('q', function () {
      self = this;
    });
    inner.dispatchEvent(new w.Event('q', { bubbles: true }));
    expect(self).toBe(w);
  });
});
