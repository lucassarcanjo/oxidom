'use strict';
// AREA B (events, ROADMAP M4): EventTarget listener API, Event classes, dispatch, activation behaviour,
// HTMLElement#click, GlobalEventHandlers `on*` accessors and the window's EventTarget (WindowTarget).
//
// Everything here is JS (DESIGN §5): listener lists live on the wrapper (`_ev`: null | [type, Listener[], ...] | Map<type, Listener[]>, see evList),
// Event objects are plain JS objects with #private state. The only N-API crossings of a dispatch are the
// activation-behaviour calls (`preActivate` / `cancelActivation` for checkbox/radio clicks, and whatever
// the default action itself does); the event path is built from the node table's parent links (zero FFI in
// shared mode). Behaviour follows jsdom 30 `EventTarget-impl.js` / `Event-impl.js` (the contract oracle).
//
// Window: the window object (`globalThis` under Vitest, a plain object from createWindow()) is not a Node.
// `installWindow(win, document)` creates a hidden WindowTarget holding its listeners, defines
// addEventListener / removeEventListener / dispatchEvent / `event` / on* accessors on `win`, and stores it
// on the document's browsing context (lib/context.cjs, `ctx.wt`): the last entry of every event path
// through `document` (except `load`).

const rt = require('./runtime.cjs');
const context = require('./context.cjs');

const { V, F, M, K, W } = rt;
const N = rt.N;

/** Atoms used here (static atoms: their ids are stable for the process). */
const A = {};
for (const n of ['input', 'button', 'label', 'a', 'area', 'summary', 'body', 'frameset', 'html', 'open']) {
  A[n] = rt.lookupAtom(n);
}

function isHtml(id, a) {
  const o = V.off(id);
  return (V.T[o + F.META] & (M.KIND | M.NS_MASK)) === K.ELEMENT && V.T[o + F.LOCAL] === a;
}

function wrap(id) {
  if (id === 0) return null;
  const w = W[id];
  return w !== undefined ? w : rt.wrap(id);
}

/** Input type codes (generated from src/forms/types.rs `ty`). */
const { TY } = require('./generated/input-types.cjs');

// ============================================================================== WebIDL conversions

function toLong(v) {
  return Number(v) | 0;
}
function toULong(v) {
  return Number(v) >>> 0;
}
function toShort(v) {
  return (Number(v) << 16) >> 16;
}
function toUShort(v) {
  return Number(v) & 0xffff;
}
function toDouble(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`${what} is not a finite floating-point value.`);
  return n;
}
function toULongLong(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function str(v) {
  return typeof v === 'string' ? v : String(v);
}
function need(len, name) {
  if (len < 1) throw new TypeError(`Failed to construct '${name}': 1 argument required, but only 0 present.`);
}
function initDict(init, name) {
  if (init === undefined || init === null) return EMPTY;
  if (typeof init !== 'object' && typeof init !== 'function') {
    throw new TypeError(`Failed to construct '${name}': The provided value is not of type '${name}Init'.`);
  }
  return init;
}
const EMPTY = Object.freeze({});
const NO_PATH = Object.freeze([]);

// ==================================================================================== Event

/** Dispatch internals with access to Event's private state (assigned in Event's static block). */
let dispatchImpl;
/** Sets the canceled flag regardless of `cancelable` / passive (event-handler return value `false`). */
let forceCancel;
/** True if the event's canceled flag is set (bypasses own-property overrides such as user-event's). */
let isCanceled;

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

class Event {
  #type = '';
  #bubbles = false;
  #cancelable = false;
  #composed = false;
  #target = null;
  #currentTarget = null;
  #phase = 0;
  #stop = false;
  #stopImm = false;
  #canceled = false;
  #inPassive = false;
  #dispatching = false;
  #trusted = false;
  #path = NO_PATH;
  #ts = 0;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'Event');
    this.#type = str(type);
    const d = initDict(eventInitDict, 'Event');
    if (d !== EMPTY) {
      this.#bubbles = !!d.bubbles;
      this.#cancelable = !!d.cancelable;
      this.#composed = !!d.composed;
    }
    this.#ts = Date.now();
  }

  get type() {
    return this.#type;
  }

  get target() {
    return this.#target;
  }

  get srcElement() {
    return this.#target;
  }

  get currentTarget() {
    return this.#currentTarget;
  }

  get eventPhase() {
    return this.#phase;
  }

  get bubbles() {
    return this.#bubbles;
  }

  get cancelable() {
    return this.#cancelable;
  }

  get composed() {
    return this.#composed;
  }

  get defaultPrevented() {
    return this.#canceled;
  }

  get returnValue() {
    return !this.#canceled;
  }

  set returnValue(v) {
    if (!v && this.#cancelable && !this.#inPassive) this.#canceled = true;
  }

  get cancelBubble() {
    return this.#stop;
  }

  set cancelBubble(v) {
    if (v) this.#stop = true;
  }

  get isTrusted() {
    return this.#trusted;
  }

  get timeStamp() {
    return this.#ts;
  }

  stopPropagation() {
    this.#stop = true;
  }

  stopImmediatePropagation() {
    this.#stop = true;
    this.#stopImm = true;
  }

  preventDefault() {
    if (this.#cancelable && !this.#inPassive) this.#canceled = true;
  }

  composedPath() {
    const p = this.#path;
    if (p.length === 0 || this.#currentTarget === null) return [];
    const out = new Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = pub(p[i]);
    return out;
  }

  initEvent(type, bubbles = false, cancelable = false) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'initEvent' on 'Event': 1 argument required, but only 0 present.");
    if (this.#dispatching) return;
    this.#type = str(type);
    this.#stop = false;
    this.#stopImm = false;
    this.#canceled = false;
    this.#trusted = false;
    this.#target = null;
    this.#bubbles = !!bubbles;
    this.#cancelable = !!cancelable;
  }

  static {
    forceCancel = (ev) => {
      ev.#canceled = true;
    };
    isCanceled = (ev) => ev.#canceled;

    /**
     * DOM "dispatch" for a target without shadow trees. `target` is a node wrapper, a WindowTarget or a
     * plain EventTarget. Returns `!canceled`. `trusted`: the UA fires it (`isTrusted`); script
     * `dispatchEvent` and `el.click()` dispatch untrusted events.
     */
    dispatchImpl = (target, ev, trusted = false) => {
      if (ev.#dispatching) throw rt.domError(6, 'Failed to execute \'dispatchEvent\' on \'EventTarget\': The event is already being dispatched.');
      ev.#dispatching = true;
      ev.#trusted = trusted;
      const type = ev.#type;
      const path = [target];
      let win = null;
      let activation = null;
      const isNode = target instanceof rt.classes.Node && target._i !== 0;
      const isClick = type === 'click' && ev instanceof MouseEvent;
      if (isNode) {
        let id = target._i;
        if (isClick && hasActivation(id)) activation = target;
        let last = id;
        for (let p = V.T[V.off(id) + F.PARENT]; ; p = V.T[V.off(p) + F.PARENT]) {
          if (!(p > 0)) { // `> 0`: a stale view (undefined) ends the walk
            // A shadow root's "get the parent" (DESIGN §22): its host for a composed event; a non-composed
            // one stops at the target's own shadow root, the first one this walk reaches. No retargeting.
            if (p !== 0 || !ev.#composed || (V.T[V.off(last) + F.META] & (M.KIND | M.SHADOW)) !== (K.FRAGMENT | M.SHADOW)) break;
            p = rt.N.shadowHost(last);
            if (!(p > 0)) break;
          }
          const w = wrap(p);
          path.push(w);
          if (isClick && activation === null && ev.#bubbles && hasActivation(p)) activation = w;
          last = p;
        }
        if ((V.T[V.off(last) + F.META] & M.KIND) === K.DOCUMENT) {
          const wt = windowTargetOf(wrap(last));
          if (wt !== null) {
            win = wt;
            if (type !== 'load') path.push(wt);
          }
        } else {
          const od = wrap(V.T[V.off(id) + F.OWNER]);
          if (od !== null) win = windowTargetOf(od);
        }
      } else if (target instanceof WindowTarget) {
        win = target;
      } else {
        win = defaultWindowTarget();
      }
      ev.#path = path;
      ev.#target = pub(target);

      let packed = 0;
      if (activation !== null && (V.T[V.off(activation._i) + F.LOCAL]) === A.input) packed = N.preActivate(activation._i);

      for (let i = path.length - 1; i >= 0; i--) {
        ev.#phase = i === 0 ? 2 : 1;
        invoke(path[i], ev, true, win);
      }
      const bubbles = ev.#bubbles;
      for (let i = 0; i < path.length; i++) {
        if (i === 0) ev.#phase = 2;
        else if (!bubbles) break;
        else ev.#phase = 3;
        invoke(path[i], ev, false, win);
      }

      ev.#phase = 0;
      ev.#currentTarget = null;
      ev.#path = NO_PATH;
      ev.#dispatching = false;
      ev.#stop = false;
      ev.#stopImm = false;

      if (activation !== null) {
        if (!ev.#canceled) activationBehavior(activation, ev, packed);
        else if (packed !== 0) N.cancelActivation(activation._i, packed);
      }
      return !ev.#canceled;
    };

    /**
     * HTML "the event handler processing algorithm" for an `on*` listener `l` of `item` (one shared code
     * path instead of a closure per handler: React sets `onclick` on every element with an onClick).
     */
    function callHandler(l, item, ev) {
      const f = l.fn;
      if (typeof f !== 'function') return;
      const self = ev.#currentTarget;
      const special = ev.#type === 'error' && ev instanceof ErrorEvent && item instanceof WindowTarget;
      const ret = special ? f.call(self, ev.message, ev.filename, ev.lineno, ev.colno, ev.error) : f.call(self, ev);
      if (special ? ret === true : ret === false) forceCancel(ev);
    }

    /** DOM "inner invoke" over a snapshot of `item`'s listeners of the event's type. */
    function invoke(item, ev, capturePhase, win) {
      const list = evList(item._ev, ev.#type);
      if (list === undefined || list.length === 0) return;
      if (ev.#stop) return;
      ev.#currentTarget = pub(item);
      const n = list.length;
      // Snapshot (a listener may add/remove listeners); removed ones are flagged and skipped.
      const snap = n === 1 ? null : list.slice();
      for (let i = 0; i < n; i++) {
        const l = snap === null ? list[0] : snap[i];
        if (l.removed || l.capture !== capturePhase) continue;
        if (l.once) removeListener(list, l);
        let prev;
        if (win !== null) {
          prev = win.cur;
          win.cur = ev;
        }
        if (l.passive) ev.#inPassive = true;
        try {
          const cb = l.cb;
          if (l.h) callHandler(l, item, ev);
          else if (typeof cb === 'function') cb.call(ev.#currentTarget, ev);
          else {
            const h = cb.handleEvent;
            if (typeof h !== 'function') throw new TypeError('The listener object has no callable handleEvent property.');
            h.call(cb, ev);
          }
        } catch (e) {
          reportException(win, e);
        }
        ev.#inPassive = false;
        if (win !== null) win.cur = prev;
        if (ev.#stopImm) return;
      }
    }
  }
}
tag(Event);
const PHASES = { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 };
for (const [k, v] of Object.entries(PHASES)) {
  const d = { value: v, writable: false, enumerable: true, configurable: false };
  Object.defineProperty(Event, k, d);
  Object.defineProperty(Event.prototype, k, d);
}

class CustomEvent extends Event {
  #detail = null;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'CustomEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'CustomEvent');
    if (d.detail !== undefined) this.#detail = d.detail;
  }

  get detail() {
    return this.#detail;
  }

  initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
    if (this.eventPhase !== 0) return;
    this.initEvent(type, bubbles, cancelable);
    this.#detail = detail;
  }
}
tag(CustomEvent);

class UIEvent extends Event {
  #view = null;
  #detail = 0;
  #which = 0;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'UIEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'UIEvent');
    if (d !== EMPTY) {
      if (d.detail !== undefined) this.#detail = toLong(d.detail);
      if (d.view !== undefined) this.#view = d.view;
      if (d.which !== undefined) this.#which = toULong(d.which);
    }
  }

  get view() {
    return this.#view;
  }

  get detail() {
    return this.#detail;
  }

  get which() {
    return this.#which;
  }

  initUIEvent(type, bubbles = false, cancelable = false, view = null, detail = 0) {
    if (this.eventPhase !== 0) return;
    this.initEvent(type, bubbles, cancelable);
    this.#view = view;
    this.#detail = toLong(detail);
  }
}
tag(UIEvent);

const MODIFIERS = ['AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'NumLock', 'ScrollLock', 'Super', 'Symbol', 'SymbolLock'];

/** EventModifierInit modifier bits (bit i = MODIFIERS[i]; 1<<10 ctrl, 11 shift, 12 alt, 13 meta). */
function modifierBits(d) {
  let b = 0;
  for (let i = 0; i < MODIFIERS.length; i++) if (d['modifier' + MODIFIERS[i]]) b |= 1 << i;
  if (d.ctrlKey) b |= 1 << 10;
  if (d.shiftKey) b |= 1 << 11;
  if (d.altKey) b |= 1 << 12;
  if (d.metaKey) b |= 1 << 13;
  return b;
}

function modifierState(bits, key) {
  key = str(key);
  if (key === 'Control') return (bits & (1 << 10)) !== 0;
  if (key === 'Shift') return (bits & (1 << 11)) !== 0;
  if (key === 'Alt') return (bits & (1 << 12)) !== 0;
  if (key === 'Meta') return (bits & (1 << 13)) !== 0;
  const i = MODIFIERS.indexOf(key);
  return i >= 0 && (bits & (1 << i)) !== 0;
}

class MouseEvent extends UIEvent {
  #mods = 0;
  #screenX = 0;
  #screenY = 0;
  #clientX = 0;
  #clientY = 0;
  #movementX = 0;
  #movementY = 0;
  #button = 0;
  #buttons = 0;
  #relatedTarget = null;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'MouseEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'MouseEvent');
    if (d !== EMPTY) {
      this.#mods = modifierBits(d);
      if (d.button !== undefined) this.#button = toShort(d.button);
      if (d.buttons !== undefined) this.#buttons = toUShort(d.buttons);
      if (d.clientX !== undefined) this.#clientX = toDouble(d.clientX, 'clientX');
      if (d.clientY !== undefined) this.#clientY = toDouble(d.clientY, 'clientY');
      if (d.movementX !== undefined) this.#movementX = toDouble(d.movementX, 'movementX');
      if (d.movementY !== undefined) this.#movementY = toDouble(d.movementY, 'movementY');
      if (d.relatedTarget !== undefined) this.#relatedTarget = d.relatedTarget;
      if (d.screenX !== undefined) this.#screenX = toDouble(d.screenX, 'screenX');
      if (d.screenY !== undefined) this.#screenY = toDouble(d.screenY, 'screenY');
    }
  }

  get screenX() {
    return this.#screenX;
  }

  get screenY() {
    return this.#screenY;
  }

  get clientX() {
    return this.#clientX;
  }

  get clientY() {
    return this.#clientY;
  }

  get x() {
    return this.#clientX;
  }

  get y() {
    return this.#clientY;
  }

  get pageX() {
    return this.#clientX;
  }

  get pageY() {
    return this.#clientY;
  }

  get offsetX() {
    return this.#clientX;
  }

  get offsetY() {
    return this.#clientY;
  }

  get movementX() {
    return this.#movementX;
  }

  get movementY() {
    return this.#movementY;
  }

  get ctrlKey() {
    return (this.#mods & (1 << 10)) !== 0;
  }

  get shiftKey() {
    return (this.#mods & (1 << 11)) !== 0;
  }

  get altKey() {
    return (this.#mods & (1 << 12)) !== 0;
  }

  get metaKey() {
    return (this.#mods & (1 << 13)) !== 0;
  }

  get button() {
    return this.#button;
  }

  get buttons() {
    return this.#buttons;
  }

  get relatedTarget() {
    return this.#relatedTarget;
  }

  getModifierState(keyArg) {
    return modifierState(this.#mods, keyArg);
  }

  initMouseEvent(type, bubbles = false, cancelable = false, view = null, detail = 0, screenX = 0, screenY = 0,
    clientX = 0, clientY = 0, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false, button = 0,
    relatedTarget = null) {
    if (this.eventPhase !== 0) return;
    this.initUIEvent(type, bubbles, cancelable, view, detail);
    this.#screenX = Number(screenX) | 0;
    this.#screenY = Number(screenY) | 0;
    this.#clientX = Number(clientX) | 0;
    this.#clientY = Number(clientY) | 0;
    this.#mods = (this.#mods & 0x3ff) | (ctrlKey ? 1 << 10 : 0) | (shiftKey ? 1 << 11 : 0) | (altKey ? 1 << 12 : 0)
      | (metaKey ? 1 << 13 : 0);
    this.#button = toShort(button);
    this.#relatedTarget = relatedTarget;
  }
}
tag(MouseEvent);

class PointerEvent extends MouseEvent {
  #pointerId = 0;
  #width = 1;
  #height = 1;
  #pressure = 0;
  #tangentialPressure = 0;
  #tiltX = 0;
  #tiltY = 0;
  #twist = 0;
  #altitudeAngle = 0;
  #azimuthAngle = 0;
  #pointerType = '';
  #isPrimary = false;
  #persistentDeviceId = 0;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'PointerEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'PointerEvent');
    if (d !== EMPTY) {
      if (d.altitudeAngle !== undefined) this.#altitudeAngle = toDouble(d.altitudeAngle, 'altitudeAngle');
      if (d.azimuthAngle !== undefined) this.#azimuthAngle = toDouble(d.azimuthAngle, 'azimuthAngle');
      if (d.height !== undefined) this.#height = toDouble(d.height, 'height');
      if (d.isPrimary !== undefined) this.#isPrimary = !!d.isPrimary;
      if (d.persistentDeviceId !== undefined) this.#persistentDeviceId = toLong(d.persistentDeviceId);
      if (d.pointerId !== undefined) this.#pointerId = toLong(d.pointerId);
      if (d.pointerType !== undefined) this.#pointerType = str(d.pointerType);
      if (d.pressure !== undefined) this.#pressure = Math.fround(toDouble(d.pressure, 'pressure'));
      if (d.tangentialPressure !== undefined) this.#tangentialPressure = Math.fround(toDouble(d.tangentialPressure, 'tangentialPressure'));
      if (d.tiltX !== undefined) this.#tiltX = toLong(d.tiltX);
      if (d.tiltY !== undefined) this.#tiltY = toLong(d.tiltY);
      if (d.twist !== undefined) this.#twist = toLong(d.twist);
      if (d.width !== undefined) this.#width = toDouble(d.width, 'width');
    }
  }

  get pointerId() {
    return this.#pointerId;
  }

  get width() {
    return this.#width;
  }

  get height() {
    return this.#height;
  }

  get pressure() {
    return this.#pressure;
  }

  get tangentialPressure() {
    return this.#tangentialPressure;
  }

  get tiltX() {
    return this.#tiltX;
  }

  get tiltY() {
    return this.#tiltY;
  }

  get twist() {
    return this.#twist;
  }

  get altitudeAngle() {
    return this.#altitudeAngle;
  }

  get azimuthAngle() {
    return this.#azimuthAngle;
  }

  get pointerType() {
    return this.#pointerType;
  }

  get isPrimary() {
    return this.#isPrimary;
  }

  get persistentDeviceId() {
    return this.#persistentDeviceId;
  }

  getCoalescedEvents() {
    return [];
  }

  getPredictedEvents() {
    return [];
  }
}
tag(PointerEvent);

class WheelEvent extends MouseEvent {
  #deltaX = 0;
  #deltaY = 0;
  #deltaZ = 0;
  #deltaMode = 0;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'WheelEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'WheelEvent');
    if (d !== EMPTY) {
      if (d.deltaMode !== undefined) this.#deltaMode = toULong(d.deltaMode);
      if (d.deltaX !== undefined) this.#deltaX = toDouble(d.deltaX, 'deltaX');
      if (d.deltaY !== undefined) this.#deltaY = toDouble(d.deltaY, 'deltaY');
      if (d.deltaZ !== undefined) this.#deltaZ = toDouble(d.deltaZ, 'deltaZ');
    }
  }

  get deltaX() {
    return this.#deltaX;
  }

  get deltaY() {
    return this.#deltaY;
  }

  get deltaZ() {
    return this.#deltaZ;
  }

  get deltaMode() {
    return this.#deltaMode;
  }
}
tag(WheelEvent);
for (const [k, v] of Object.entries({ DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 })) {
  const d = { value: v, writable: false, enumerable: true, configurable: false };
  Object.defineProperty(WheelEvent, k, d);
  Object.defineProperty(WheelEvent.prototype, k, d);
}

class DragEvent extends MouseEvent {
  #dataTransfer = null;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'DragEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'DragEvent');
    if (d.dataTransfer !== undefined) this.#dataTransfer = d.dataTransfer;
  }

  get dataTransfer() {
    return this.#dataTransfer;
  }
}
tag(DragEvent);

class KeyboardEvent extends UIEvent {
  #mods = 0;
  #key = '';
  #code = '';
  #location = 0;
  #repeat = false;
  #isComposing = false;
  #charCode = 0;
  #keyCode = 0;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'KeyboardEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'KeyboardEvent');
    if (d !== EMPTY) {
      this.#mods = modifierBits(d);
      if (d.charCode !== undefined) this.#charCode = toULong(d.charCode);
      if (d.code !== undefined) this.#code = str(d.code);
      if (d.isComposing !== undefined) this.#isComposing = !!d.isComposing;
      if (d.key !== undefined) this.#key = str(d.key);
      if (d.keyCode !== undefined) this.#keyCode = toULong(d.keyCode);
      if (d.location !== undefined) this.#location = toULong(d.location);
      if (d.repeat !== undefined) this.#repeat = !!d.repeat;
    }
  }

  get key() {
    return this.#key;
  }

  get code() {
    return this.#code;
  }

  get location() {
    return this.#location;
  }

  get ctrlKey() {
    return (this.#mods & (1 << 10)) !== 0;
  }

  get shiftKey() {
    return (this.#mods & (1 << 11)) !== 0;
  }

  get altKey() {
    return (this.#mods & (1 << 12)) !== 0;
  }

  get metaKey() {
    return (this.#mods & (1 << 13)) !== 0;
  }

  get repeat() {
    return this.#repeat;
  }

  get isComposing() {
    return this.#isComposing;
  }

  get charCode() {
    return this.#charCode;
  }

  get keyCode() {
    return this.#keyCode;
  }

  getModifierState(keyArg) {
    return modifierState(this.#mods, keyArg);
  }

  initKeyboardEvent(type, bubbles = false, cancelable = false, view = null, key = '', location = 0, ctrlKey = false,
    altKey = false, shiftKey = false, metaKey = false) {
    if (this.eventPhase !== 0) return;
    this.initUIEvent(type, bubbles, cancelable, view, 0);
    this.#key = str(key);
    this.#location = toULong(location);
    this.#mods = (this.#mods & 0x3ff) | (ctrlKey ? 1 << 10 : 0) | (shiftKey ? 1 << 11 : 0) | (altKey ? 1 << 12 : 0)
      | (metaKey ? 1 << 13 : 0);
  }
}
tag(KeyboardEvent);
for (const [k, v] of Object.entries({ DOM_KEY_LOCATION_STANDARD: 0, DOM_KEY_LOCATION_LEFT: 1, DOM_KEY_LOCATION_RIGHT: 2, DOM_KEY_LOCATION_NUMPAD: 3 })) {
  const d = { value: v, writable: false, enumerable: true, configurable: false };
  Object.defineProperty(KeyboardEvent, k, d);
  Object.defineProperty(KeyboardEvent.prototype, k, d);
}

class FocusEvent extends UIEvent {
  #relatedTarget = null;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'FocusEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'FocusEvent');
    if (d.relatedTarget !== undefined) this.#relatedTarget = d.relatedTarget;
  }

  get relatedTarget() {
    return this.#relatedTarget;
  }
}
tag(FocusEvent);

class InputEvent extends UIEvent {
  #data = null;
  #isComposing = false;
  #inputType = '';

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'InputEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'InputEvent');
    if (d !== EMPTY) {
      if (d.data !== undefined && d.data !== null) this.#data = str(d.data);
      if (d.inputType !== undefined) this.#inputType = str(d.inputType);
      if (d.isComposing !== undefined) this.#isComposing = !!d.isComposing;
    }
  }

  get data() {
    return this.#data;
  }

  get isComposing() {
    return this.#isComposing;
  }

  get inputType() {
    return this.#inputType;
  }

  getTargetRanges() {
    return [];
  }
}
tag(InputEvent);

class CompositionEvent extends UIEvent {
  #data = '';

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'CompositionEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'CompositionEvent');
    if (d.data !== undefined) this.#data = str(d.data);
  }

  get data() {
    return this.#data;
  }

  initCompositionEvent(type, bubbles = false, cancelable = false, view = null, data = '') {
    if (this.eventPhase !== 0) return;
    this.initUIEvent(type, bubbles, cancelable, view, 0);
    this.#data = str(data);
  }
}
tag(CompositionEvent);

class TouchEvent extends UIEvent {
  #mods = 0;
  #touches = [];
  #targetTouches = [];
  #changedTouches = [];

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'TouchEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'TouchEvent');
    if (d !== EMPTY) {
      this.#mods = modifierBits(d);
      if (d.changedTouches !== undefined) this.#changedTouches = Array.from(d.changedTouches);
      if (d.targetTouches !== undefined) this.#targetTouches = Array.from(d.targetTouches);
      if (d.touches !== undefined) this.#touches = Array.from(d.touches);
    }
  }

  get touches() {
    return this.#touches;
  }

  get targetTouches() {
    return this.#targetTouches;
  }

  get changedTouches() {
    return this.#changedTouches;
  }

  get ctrlKey() {
    return (this.#mods & (1 << 10)) !== 0;
  }

  get shiftKey() {
    return (this.#mods & (1 << 11)) !== 0;
  }

  get altKey() {
    return (this.#mods & (1 << 12)) !== 0;
  }

  get metaKey() {
    return (this.#mods & (1 << 13)) !== 0;
  }
}
tag(TouchEvent);

class ErrorEvent extends Event {
  #message = '';
  #filename = '';
  #lineno = 0;
  #colno = 0;
  #error = null;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'ErrorEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'ErrorEvent');
    if (d !== EMPTY) {
      if (d.colno !== undefined) this.#colno = toULong(d.colno);
      if (d.error !== undefined) this.#error = d.error;
      if (d.filename !== undefined) this.#filename = str(d.filename);
      if (d.lineno !== undefined) this.#lineno = toULong(d.lineno);
      if (d.message !== undefined) this.#message = str(d.message);
    }
  }

  get message() {
    return this.#message;
  }

  get filename() {
    return this.#filename;
  }

  get lineno() {
    return this.#lineno;
  }

  get colno() {
    return this.#colno;
  }

  get error() {
    return this.#error;
  }
}
tag(ErrorEvent);

class SubmitEvent extends Event {
  #submitter = null;

  constructor(type, eventInitDict = undefined) {
    need(arguments.length, 'SubmitEvent');
    super(type, eventInitDict);
    const d = initDict(eventInitDict, 'SubmitEvent');
    if (d.submitter !== undefined && d.submitter !== null) {
      if (!(d.submitter instanceof rt.classes.HTMLElement)) {
        throw new TypeError("Failed to construct 'SubmitEvent': member submitter is not of type 'HTMLElement'.");
      }
      this.#submitter = d.submitter;
    }
  }

  get submitter() {
    return this.#submitter;
  }
}
tag(SubmitEvent);

/** Event subclasses with a few plain members: [name, Base, [[member, default, convert]...]]. */
function simpleEvent(name, Base, members) {
  const keys = members.map((m) => m[0]);
  const C = {
    [name]: class extends Base {
      constructor(type, eventInitDict = undefined) {
        need(arguments.length, name);
        super(type, eventInitDict);
        const d = initDict(eventInitDict, name);
        const vals = new Array(members.length);
        for (let i = 0; i < members.length; i++) {
          const [k, dflt, conv] = members[i];
          const v = d[k];
          vals[i] = v === undefined ? dflt : conv(v, k);
        }
        STATE.set(this, vals);
      }
    },
  }[name];
  for (let i = 0; i < keys.length; i++) {
    Object.defineProperty(C.prototype, keys[i], {
      get() {
        const v = STATE.get(this);
        // WebIDL brand check (jsdom throws too): only instances have member values
        if (v === undefined) throw new TypeError('Illegal invocation');
        return v[i];
      },
      enumerable: false,
      configurable: true,
    });
  }
  return tag(C, name);
}
/** Member values of the simple event classes (rarely constructed: a WeakMap keeps their shape simple). */
const STATE = new WeakMap();
const any = (v) => v;
const bool = (v) => !!v;
const dbl = (v, k) => toDouble(v, k);

const AnimationEvent = simpleEvent('AnimationEvent', Event, [['animationName', '', str], ['elapsedTime', 0, dbl], ['pseudoElement', '', str]]);
const TransitionEvent = simpleEvent('TransitionEvent', Event, [['propertyName', '', str], ['elapsedTime', 0, dbl], ['pseudoElement', '', str]]);
const ProgressEvent = simpleEvent('ProgressEvent', Event, [['lengthComputable', false, bool], ['loaded', 0, toULongLong], ['total', 0, toULongLong]]);
const PopStateEvent = simpleEvent('PopStateEvent', Event, [['state', null, any]]);
const PageTransitionEvent = simpleEvent('PageTransitionEvent', Event, [['persisted', false, bool]]);
const HashChangeEvent = simpleEvent('HashChangeEvent', Event, [['oldURL', '', str], ['newURL', '', str]]);
const ClipboardEvent = simpleEvent('ClipboardEvent', Event, [['clipboardData', null, any]]);
const StorageEvent = simpleEvent('StorageEvent', Event, [['key', null, (v) => (v === null ? null : str(v))],
  ['oldValue', null, (v) => (v === null ? null : str(v))], ['newValue', null, (v) => (v === null ? null : str(v))],
  ['url', '', str], ['storageArea', null, any]]);

// ============================================================================== EventTarget API

/**
 * Per-target listener lists by event type (`_ev`): a flat [type, list, type, list, ...] array while a
 * target has few types (one small allocation; most elements have one or two), a Map past EV_FLAT_MAX
 * types (React's root container listens to ~80).
 */
const EV_FLAT_MAX = 16; // 8 types

/** The listener list of `type` in a target's `_ev` (undefined if none). */
function evList(m, type) {
  if (m === null || m === undefined) return undefined;
  if (m instanceof Map) return m.get(type);
  for (let i = 0; i < m.length; i += 2) if (m[i] === type) return m[i + 1];
  return undefined;
}

/** Adds an empty listener list for `type` (absent) to target `t`; returns it. */
function evAdd(t, type) {
  const list = [];
  const m = t._ev;
  if (m === null || m === undefined) t._ev = [type, list];
  else if (m instanceof Map) m.set(type, list);
  else if (m.length < EV_FLAT_MAX) m.push(type, list);
  else {
    const map = new Map();
    for (let i = 0; i < m.length; i += 2) map.set(m[i], m[i + 1]);
    map.set(type, list);
    t._ev = map;
  }
  return list;
}

/** One registration (DOM "event listener"). `h` is set for event-handler (`on*`) listeners. */
class Listener {
  constructor(cb, capture, once, passive, signal) {
    this.cb = cb;
    this.capture = capture;
    this.once = once;
    this.passive = passive;
    this.signal = signal;
    this.removed = false;
    this.abort = null;
    this.h = false;
    this.fn = null;
  }
}

function removeListener(list, l) {
  const i = list.indexOf(l);
  if (i >= 0) list.splice(i, 1);
  l.removed = true;
  if (l.abort !== null) {
    l.signal.removeEventListener('abort', l.abort);
    l.abort = null;
  }
}

/** The window object holding listeners for a `window` (hidden; `window` is the public face). */
class WindowTarget {
  constructor(window, document) {
    this._ev = null;
    this.window = window;
    this.document = document;
    /** window.event: the event whose listeners are running (undefined when idle, never null) */
    this.cur = undefined;
    this.reporting = false;
  }
}

/** Public face of a path item (the window object for a WindowTarget). */
function pub(item) {
  return item instanceof WindowTarget ? item.window : item;
}

/** The WindowTarget of `doc`'s browsing context (lib/context.cjs), or null (no context, or no window yet). */
function windowTargetOf(doc) {
  const c = doc._ctx;
  return c === undefined ? null : c.wt;
}

/** The WindowTarget of the current browsing context (for plain EventTargets). */
function defaultWindowTarget() {
  const c = context.current();
  return c === null ? null : c.wt;
}

/** jsdom `defaultPassiveValue`: wheel/touch listeners on window, document, html, body default to passive. */
function defaultPassive(type, target) {
  if (type !== 'touchstart' && type !== 'touchmove' && type !== 'wheel' && type !== 'mousewheel') return false;
  if (target instanceof WindowTarget) return true;
  if (!(target instanceof rt.classes.Node) || target._i === 0) return false;
  const o = V.off(target._i);
  const k = V.T[o + F.META] & M.KIND;
  if (k === K.DOCUMENT) return true;
  if (k !== K.ELEMENT) return false;
  const doc = wrap(V.T[o + F.OWNER]);
  return doc !== null && (doc.documentElement === target || doc.body === target);
}

/** Reads AddEventListenerOptions (WebIDL dictionary order: capture, once, passive, signal). */
function addOptions(options) {
  let capture = false;
  let once = false;
  let passive = null;
  let signal = null;
  if (options !== undefined && options !== null) {
    if (typeof options === 'object' || typeof options === 'function') {
      capture = !!options.capture;
      once = !!options.once;
      const p = options.passive;
      if (p !== undefined) passive = !!p;
      const s = options.signal;
      if (s !== undefined) {
        if (s === null || typeof s !== 'object' || typeof s.aborted !== 'boolean') {
          throw new TypeError("Failed to execute 'addEventListener' on 'EventTarget': member signal is not of type 'AbortSignal'.");
        }
        signal = s;
      }
    } else {
      capture = !!options;
    }
  }
  return { capture, once, passive, signal };
}

function checkCallback(cb, method) {
  if (typeof cb !== 'function' && (typeof cb !== 'object')) {
    throw new TypeError(`Failed to execute '${method}' on 'EventTarget': parameter 2 is not of type 'Object'.`);
  }
}

const EventTargetMethods = {
  addEventListener(type, callback, options = undefined) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only ${arguments.length} present.`);
    type = str(type);
    // AddEventListenerOptions, read inline (no per-call allocation): capture, once, passive, signal.
    let capture = false;
    let once = false;
    let passive = null;
    let signal = null;
    if (typeof options === 'boolean') capture = options;
    else if (options !== undefined && options !== null) {
      if (typeof options === 'object' || typeof options === 'function') {
        const o = addOptions(options);
        capture = o.capture;
        once = o.once;
        passive = o.passive;
        signal = o.signal;
      } else capture = !!options;
    }
    if (callback === null || callback === undefined) return;
    if (typeof callback !== 'function') checkCallback(callback, 'addEventListener');
    if (signal !== null && signal.aborted) return;
    if (passive === null) passive = defaultPassive(type, this);
    let list = evList(this._ev, type);
    if (list === undefined) list = evAdd(this, type);
    else {
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l.cb === callback && l.capture === capture) return;
      }
    }
    const l = new Listener(callback, capture, once, passive, signal);
    list.push(l);
    if (signal !== null) {
      l.abort = () => removeListener(list, l);
      signal.addEventListener('abort', l.abort, { once: true });
    }
  },

  removeEventListener(type, callback, options = undefined) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'removeEventListener' on 'EventTarget': 2 arguments required, but only ${arguments.length} present.`);
    type = str(type);
    const capture = options !== null && typeof options === 'object' ? !!options.capture : !!options;
    if (callback === null || callback === undefined) return;
    checkCallback(callback, 'removeEventListener');
    const list = evList(this._ev, type);
    if (list === undefined) return;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.cb === callback && l.capture === capture && !l.h) {
        removeListener(list, l);
        return;
      }
    }
  },

  dispatchEvent(event) {
    if (!(event instanceof Event)) {
      throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
    }
    if (event.eventPhase !== 0) throw rt.domError(6, "Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.");
    return dispatchImpl(this, event);
  },
};

// ============================================================================= error reporting

/**
 * HTML "report an exception": a cancelable ErrorEvent on the window; if no listener canceled it, the error
 * goes to `process.emit('uncaughtException')` (what Vitest's jsdom environment does with unhandled window
 * errors). There is deliberately no `reportError` (React then takes the same ErrorEvent path).
 */
function reportException(win, error) {
  // Accept the public window too (window.cjs reports rAF / MutationObserver callback errors with it): resolve
  // its hidden WindowTarget so no `reporting` flag lands on the global object.
  if (win !== null && !(win instanceof WindowTarget)) win = context.ofWindow(win)?.wt ?? null;
  if (win !== null && !win.reporting) {
    win.reporting = true;
    let ev;
    try {
      const { file, line, col } = errorLocation(error, win);
      ev = new ErrorEvent('error', {
        cancelable: true,
        message: error && typeof error.message === 'string' ? error.message : `uncaught exception: ${safeString(error)}`,
        filename: file,
        lineno: line,
        colno: col,
        error,
      });
      dispatchImpl(win, ev, true);
    } finally {
      win.reporting = false;
    }
    if (isCanceled(ev)) return;
  }
  process.emit('uncaughtException', error);
}

function safeString(v) {
  try {
    return String(v);
  } catch {
    return '[object]';
  }
}

function errorLocation(error, win) {
  const stack = error && typeof error.stack === 'string' ? error.stack.split('\n') : null;
  if (stack !== null) {
    for (let i = 1; i < stack.length; i++) {
      const m = /at (?:(.+)\s+)?\(?(?:(.+?):(\d+):(\d+)|([^)]+))\)?/.exec(stack[i]);
      if (m !== null && m[2] !== undefined) return { file: m[2], line: parseInt(m[3], 10), col: parseInt(m[4], 10) };
    }
  }
  return { file: win.document !== null ? win.document.URL : '', line: 0, col: 0 };
}

// ============================================================================= activation behaviour

/** Elements with activation behaviour (jsdom `_hasActivationBehavior`); zero FFI. */
function hasActivation(id) {
  const o = V.off(id);
  if ((V.T[o + F.META] & (M.KIND | M.NS_MASK)) !== K.ELEMENT) return false;
  const a = V.T[o + F.LOCAL];
  return a === A.input || a === A.button || a === A.label || a === A.a || a === A.area || a === A.summary;
}

/** Hooks filled by forms.cjs (form submission / reset algorithms). */
const hooks = {
  /** (form, submitter) => void: HTMLFormElement "request submit" from a submit button (if connected). */
  requestSubmit: null,
  /** (form) => void: HTMLFormElement reset from a reset button (if connected). */
  reset: null,
};

function inputType(id) {
  return (V.T[V.off(id) + F.STATE] & rt.S.INPUT_TYPE_MASK) >>> rt.S.INPUT_TYPE_SHIFT;
}

function isConnected(id) {
  return (V.T[V.off(id) + F.META] & M.CONNECTED) !== 0;
}

/**
 * Fires a simple event (`bubbles` / `cancelable` options) and returns dispatch's result. UA-fired events
 * (focus family, activation input/change, label-forwarded click, submit/reset, invalid, ...) are trusted
 * like jsdom's `fireAnEvent`; `el.click()` passes `trusted = false` (a synthetic click is untrusted).
 */
function fire(target, type, init = undefined, Ctor = Event, trusted = true) {
  return dispatchImpl(target, new Ctor(type, init), trusted);
}

function activationBehavior(el, ev, packed) {
  const id = el._i;
  const a = V.T[V.off(id) + F.LOCAL];
  if (a === A.input) {
    const t = inputType(id);
    if (t === TY.CHECKBOX || (t === TY.RADIO && (packed & 8) === 0)) {
      if (isConnected(id)) {
        fire(el, 'input', { bubbles: true });
        fire(el, 'change', { bubbles: true });
      }
      return;
    }
    if (t === TY.RADIO) return;
    if (N.isDisabled(id)) return; // !mutable (readonly does not apply to button types)
    if (t === TY.SUBMIT || t === TY.IMAGE || t === TY.RESET) {
      const form = N.formOwner(id);
      if (form === 0 || !isConnected(form)) return;
      if (t === TY.RESET) hooks.reset?.(wrap(form));
      else hooks.requestSubmit?.(wrap(form), el);
    }
  } else if (a === A.button) {
    const form = N.formOwner(id);
    if (form === 0 || N.isDisabled(id)) return;
    const bt = N.buttonType(id);
    if (!isConnected(form)) return;
    if (bt === TY.SUBMIT) hooks.requestSubmit?.(wrap(form), el);
    else if (bt === TY.RESET) hooks.reset?.(wrap(form));
  } else if (a === A.label) {
    labelActivation(el, ev);
  } else if (a === A.summary) {
    if (!N.isSummaryForDetails(id)) return;
    const details = wrap(V.T[V.off(id) + F.PARENT]);
    if (details.hasAttribute('open')) details.removeAttribute('open');
    else details.setAttribute('open', '');
  }
  // a / area: following hyperlinks is not implemented (no navigation), as in jsdom.
}

/** HTML interactive content (jsdom `isInteractiveContent`). */
function isInteractive(n) {
  if (!(n instanceof rt.classes.Element) || n.namespaceURI !== rt.NS.HTML) return false;
  if (n.hasAttribute('tabindex')) return true;
  switch (n.localName) {
    case 'a':
      return n.hasAttribute('href');
    case 'audio':
    case 'video':
      return n.hasAttribute('controls');
    case 'img':
    case 'object':
      return n.hasAttribute('usemap');
    case 'input':
      return inputType(n._i) !== TY.HIDDEN;
    case 'button':
    case 'details':
    case 'embed':
    case 'iframe':
    case 'label':
    case 'select':
    case 'textarea':
      return true;
    default:
      return false;
  }
}

function labelActivation(label, ev) {
  const target = ev.target;
  if (target !== null && target !== label && label.contains(target)) {
    for (let n = target; n !== null && n !== label; n = n.parentNode) if (isInteractive(n)) return;
  }
  const c = N.labelControl(label._i);
  if (c === 0 || N.isDisabled(c)) return;
  const control = wrap(c);
  if (target !== null && control.contains(target)) return;
  const doc = control.ownerDocument;
  fire(control, 'click', {
    bubbles: true, cancelable: true, view: doc?.defaultView ?? null, screenX: 0, screenY: 0, clientX: 0, clientY: 0,
    button: 0, detail: 1, relatedTarget: null,
  }, MouseEvent);
}

/** Elements whose `click()` is in progress (jsdom `_clickInProgress`). */
const CLICKING = new WeakSet();

function click() {
  if (this._i === 0 || N.isDisabled(this._i) || CLICKING.has(this)) return;
  CLICKING.add(this);
  try {
    const doc = this.ownerDocument;
    fire(this, 'click', {
      bubbles: true, cancelable: true, composed: true, pointerId: -1, view: doc?.defaultView ?? null,
    }, PointerEvent, false);
  } finally {
    CLICKING.delete(this);
  }
}

// ============================================================================ event handlers (on*)

const GLOBAL_EVENTS = [
  'abort', 'auxclick', 'beforeinput', 'beforematch', 'beforetoggle', 'blur', 'cancel', 'canplay', 'canplaythrough',
  'change', 'click', 'close', 'contextlost', 'contextmenu', 'contextrestored', 'copy', 'cuechange', 'cut',
  'dblclick', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'durationchange',
  'emptied', 'ended', 'error', 'focus', 'formdata', 'input', 'invalid', 'keydown', 'keypress', 'keyup', 'load',
  'loadeddata', 'loadedmetadata', 'loadstart', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout',
  'mouseover', 'mouseup', 'paste', 'pause', 'play', 'playing', 'progress', 'ratechange', 'reset', 'resize',
  'scroll', 'scrollend', 'securitypolicyviolation', 'seeked', 'seeking', 'select', 'slotchange', 'stalled',
  'submit', 'suspend', 'timeupdate', 'toggle', 'volumechange', 'waiting', 'webkitanimationend',
  'webkitanimationiteration', 'webkitanimationstart', 'webkittransitionend', 'wheel', 'touchstart', 'touchend',
  'touchmove', 'touchcancel', 'pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerrawupdate',
  'pointerup', 'pointercancel', 'pointerout', 'pointerleave', 'gotpointercapture', 'lostpointercapture',
  // rsdom exposes AnimationEvent / TransitionEvent (React's unprefixed names), so the standard handlers too
  'animationstart', 'animationiteration', 'animationend', 'animationcancel', 'transitionrun', 'transitionstart',
  'transitionend', 'transitioncancel', 'selectionchange', 'selectstart',
];
const WINDOW_EVENTS = [
  'afterprint', 'beforeprint', 'beforeunload', 'hashchange', 'languagechange', 'message', 'messageerror',
  'offline', 'online', 'pagehide', 'pageshow', 'popstate', 'rejectionhandled', 'storage', 'unhandledrejection',
  'unload',
];
const WINDOW_EVENT_SET = new Set(WINDOW_EVENTS);
/** GlobalEventHandlers members that body / frameset forward to the window. */
const BODY_REFLECT = new Set(['blur', 'error', 'focus', 'load', 'resize', 'scroll']);

/** HTML "determine the target of an event handler". */
function handlerTarget(obj, type) {
  if (obj instanceof WindowTarget) return obj;
  if (obj instanceof rt.classes.Element && obj._i !== 0) {
    const a = V.T[V.off(obj._i) + F.LOCAL];
    if ((a === A.body || a === A.frameset) && isHtml(obj._i, a) && (WINDOW_EVENT_SET.has(type) || BODY_REFLECT.has(type))) {
      const doc = obj.ownerDocument;
      return doc !== null ? windowTargetOf(doc) : null;
    }
  }
  return obj;
}

function findHandler(target, type) {
  const list = evList(target._ev, type);
  if (list === undefined) return null;
  for (let i = 0; i < list.length; i++) if (list[i].h) return list[i];
  return null;
}

function getHandler(obj, type) {
  const t = handlerTarget(obj, type);
  if (t === null) return null;
  const l = findHandler(t, type);
  return l === null ? null : l.fn;
}

function setHandler(obj, type, value) {
  const t = handlerTarget(obj, type);
  if (t === null) return;
  // [LegacyTreatNonObjectAsNull]: non-objects become null
  const fn = value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null;
  let l = findHandler(t, type);
  if (l === null) {
    if (fn === null) return;
    const list = evList(t._ev, type) ?? evAdd(t, type);
    // `cb` stays null: dispatch runs the event handler processing algorithm (`callHandler`) on `fn`
    l = new Listener(null, false, false, false, null);
    l.h = true;
    list.push(l);
  }
  l.fn = fn;
}

function defineHandlers(target, names, receiver = null) {
  for (const type of names) {
    Object.defineProperty(target, 'on' + type, {
      get() {
        return getHandler(receiver ?? this, type);
      },
      set(v) {
        setHandler(receiver ?? this, type, v);
      },
      enumerable: true,
      configurable: true,
    });
  }
}

// ============================================================================= window target

/**
 * Makes `win` (the window object: globalThis in the Vitest environment, or createWindow()'s object) an event
 * target linked to `document`, a browsing-context document (lib/context.cjs): listener methods, `event`,
 * `on*` handlers. Idempotent; returns the hidden WindowTarget (also `ctx.wt`). AREA C calls this from its
 * window setup.
 */
function installWindow(win, document) {
  const ctx = document._ctx;
  if (ctx.wt !== null && ctx.wt.window === win) return ctx.wt;
  const wt = new WindowTarget(win, document);
  ctx.wt = wt;
  const methods = {
    addEventListener(type, callback, options) {
      // eslint-disable-next-line prefer-rest-params
      return Reflect.apply(EventTargetMethods.addEventListener, wt, arguments);
    },
    removeEventListener(type, callback, options) {
      // eslint-disable-next-line prefer-rest-params
      return Reflect.apply(EventTargetMethods.removeEventListener, wt, arguments);
    },
    dispatchEvent(event) {
      // eslint-disable-next-line prefer-rest-params
      return Reflect.apply(EventTargetMethods.dispatchEvent, wt, arguments);
    },
  };
  for (const [k, fn] of Object.entries(methods)) {
    Object.defineProperty(win, k, { value: fn, writable: true, enumerable: true, configurable: true });
  }
  Object.defineProperty(win, 'event', {
    get() {
      return wt.cur;
    },
    set(v) {
      Object.defineProperty(win, 'event', { value: v, writable: true, enumerable: true, configurable: true });
    },
    enumerable: true,
    configurable: true,
  });
  defineHandlers(win, GLOBAL_EVENTS, wt);
  defineHandlers(win, WINDOW_EVENTS, wt);
  return wt;
}

// =================================================================================== install

function install(_rt, dom) {
  rt.define(dom.EventTarget, EventTargetMethods);
  rt.define(dom.HTMLElement, { click });
  defineHandlers(dom.HTMLElement.prototype, GLOBAL_EVENTS);
  defineHandlers(dom.SVGElement.prototype, GLOBAL_EVENTS);
  defineHandlers(dom.Document.prototype, [...GLOBAL_EVENTS, 'readystatechange', 'visibilitychange']);
  const Body = rt.classes.HTMLBodyElement;
  if (Body !== undefined) defineHandlers(Body.prototype, WINDOW_EVENTS);
  const FrameSet = rt.classes.HTMLFrameSetElement;
  if (FrameSet !== undefined) defineHandlers(FrameSet.prototype, WINDOW_EVENTS);
}

module.exports = {
  install, installWindow, WindowTarget, hooks, fire, dispatch: (t, e) => dispatchImpl(t, e), reportException,
  Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, DragEvent, KeyboardEvent, FocusEvent, InputEvent,
  CompositionEvent, TouchEvent, ErrorEvent, SubmitEvent, AnimationEvent, TransitionEvent, ProgressEvent,
  PopStateEvent, PageTransitionEvent, HashChangeEvent, ClipboardEvent, StorageEvent, GLOBAL_EVENTS, WINDOW_EVENTS,
  defineHandlers,
};
