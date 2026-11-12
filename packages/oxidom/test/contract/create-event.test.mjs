// document.createEvent, init*Event and the event classes createEvent needs (ROADMAP Stage 3 `events`, DESIGN §28).
// The upstream coverage is conformance/parity (`--item events`: WPT dom/events and uievents); these cases add what
// legacy test helpers and older libraries do: createEvent + init*Event + dispatchEvent, the initialized flag, the
// view check, and the new classes. Every assertion runs on jsdom, happy-dom and oxidom; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('createEvent [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });

  it('createEvent + initEvent + dispatchEvent, the legacy way', () => {
    const el = d.createElement('div');
    d.body.append(el);
    const seen = [];
    d.body.addEventListener('custom', (e) => seen.push([e.type, e.target === el, e.bubbles, e.cancelable]));
    const e = d.createEvent('Event');
    expect(e).toBeInstanceOf(w.Event);
    if (kind !== 'happy-dom') expect(e.type).toBe(''); // PINNED to jsdom: happy-dom 21 names it 'init'
    e.initEvent('custom', true, true);
    expect(el.dispatchEvent(e)).toBe(true);
    expect(seen).toEqual([['custom', true, true, true]]);
  });

  it('interface names are matched case-insensitively, aliases included', () => {
    const cases = [['MouseEvents', 'MouseEvent'], ['mouseevent', 'MouseEvent'], ['UIEvents', 'UIEvent'], ['HTMLEvents', 'Event'],
      ['KeyboardEvent', 'KeyboardEvent'], ['CustomEvent', 'CustomEvent'], ['FOCUSEVENT', 'FocusEvent'], ['CompositionEvent', 'CompositionEvent']];
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom 21 has no aliases and returns plain Events for some names
      for (const [name, ctor] of cases) expect(d.createEvent(name)).toBeInstanceOf(w[ctor]);
      for (const name of ['MessageEvent', 'StorageEvent', 'HashChangeEvent', 'BeforeUnloadEvent', 'DeviceOrientationEvent', 'DeviceMotionEvent']) {
        expect(Object.prototype.toString.call(d.createEvent(name))).toBe(`[object ${name}]`);
      }
      expect(errName(() => d.createEvent('PointerEvent'))).toBe('NotSupportedError');
    }
    if (kind !== 'happy-dom') expect(errName(() => d.createEvent('NoSuchEvent'))).toBe('NotSupportedError'); // PINNED to jsdom: happy-dom 21 returns an Event
  });

  it.skipIf(kind === 'happy-dom')('an event from createEvent cannot be dispatched before init*Event', () => {
    // PINNED to jsdom: happy-dom 21 has no initialized flag
    const e = d.createEvent('MouseEvents');
    expect(errName(() => d.body.dispatchEvent(e))).toBe('InvalidStateError');
    e.initMouseEvent('click', true, true, w, 1, 0, 0, 5, 6, false, false, true, false, 0, null);
    let got;
    d.body.addEventListener('click', (ev) => { got = [ev.clientX, ev.clientY, ev.shiftKey, ev.view === w, ev.detail]; });
    d.body.dispatchEvent(e);
    expect(got).toEqual([5, 6, true, true, 1]);
  });

  it.skipIf(kind === 'happy-dom')('init*Event methods need their first argument', () => {
    // PINNED to jsdom: happy-dom 21 accepts the calls
    expect(errName(() => d.createEvent('CustomEvent').initCustomEvent())).toBe('TypeError');
    expect(errName(() => d.createEvent('UIEvents').initUIEvent())).toBe('TypeError');
    expect(errName(() => d.createEvent('MouseEvents').initMouseEvent())).toBe('TypeError');
    expect(errName(() => d.createEvent('KeyboardEvent').initKeyboardEvent())).toBe('TypeError');
    const c = d.createEvent('CustomEvent');
    c.initCustomEvent('x', false, false, { a: 1 });
    expect(c.detail).toEqual({ a: 1 });
  });

  it.skipIf(kind === 'happy-dom')('a UIEvent view must be a Window', () => {
    // PINNED to jsdom: happy-dom 21 takes any value
    expect(new w.UIEvent('x', { view: w }).view).toBe(w);
    expect(new w.MouseEvent('x', { view: null }).view).toBe(null);
    expect(errName(() => new w.UIEvent('x', { view: {} }))).toBe('TypeError');
    expect(errName(() => new w.MouseEvent('x', { view: d }))).toBe('TypeError');
    expect(errName(() => d.createEvent('UIEvents').initUIEvent('x', false, false, 7, 0))).toBe('TypeError');
  });

  it.skipIf(kind === 'happy-dom')('MessageEvent, DeviceOrientationEvent and DeviceMotionEvent', () => {
    // PINNED to jsdom: happy-dom 21 lacks the device events and initMessageEvent
    const m = new w.MessageEvent('message', { data: { n: 1 }, origin: 'http://x', source: w });
    expect([m.data, m.origin, m.lastEventId, m.source === w, m.ports]).toEqual([{ n: 1 }, 'http://x', '', true, []]);
    const m2 = d.createEvent('MessageEvent');
    m2.initMessageEvent('message', false, false, 'hi', 'o', 'id', null, []);
    expect([m2.type, m2.data, m2.origin, m2.lastEventId]).toEqual(['message', 'hi', 'o', 'id']);
    const o = new w.DeviceOrientationEvent('deviceorientation', { alpha: 1, absolute: true });
    expect([o.alpha, o.beta, o.gamma, o.absolute]).toEqual([1, null, null, true]);
    const mo = new w.DeviceMotionEvent('devicemotion', { acceleration: { x: 2 }, interval: 16 });
    expect([mo.acceleration.x, mo.acceleration.y, mo.accelerationIncludingGravity, mo.rotationRate, mo.interval]).toEqual([2, null, null, null, 16]);
    expect(errName(() => new w.BeforeUnloadEvent('x'))).toBe('TypeError');
  });
});
