'use strict';
// Inert observers and scrolling APIs (ROADMAP Stage 1 `observers`, DESIGN §24): ResizeObserver, IntersectionObserver
// (with their entry interfaces), Element#scrollIntoView / scroll / scrollTo / scrollBy, pointer capture and
// Element#checkVisibility. jsdom has none of them, so test setups shim them by hand; these replace the shims.
//
// No layout exists, so the observers validate their arguments as the specs say and then never fire:
// takeRecords() is always empty. That is what the documented shims do (e2e/libraries/tests/setup.ts) and what
// happy-dom does, and every library in e2e/libraries works with it (DESIGN §24 has the survey). A test's own
// polyfill still wins: the interface objects are ordinary writable, configurable window members (lib/window.cjs
// installs `rt.classes`), and the Element methods are writable prototype properties.
//
// Facade only: no Rust state. Scroll offsets go through the scrollTop/scrollLeft accessors (area B keeps the last
// value assigned, as jsdom does); pointer capture is a per-document Map pointerId -> element.

const rt = require('./runtime.cjs');

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

function need(argc, n, method, iface) {
  if (argc < n) {
    throw new TypeError(`Failed to execute '${method}' on '${iface}': ${n} argument${n > 1 ? 's' : ''} required, but only ${argc} present.`);
  }
}

let Element = null;
let Document = null;

function elementArg(v, method, iface) {
  if (!(v instanceof Element)) {
    throw new TypeError(`Failed to execute '${method}' on '${iface}': parameter 1 is not of type 'Element'.`);
  }
  return v;
}

function callbackArg(cb, iface) {
  if (typeof cb !== 'function') {
    throw new TypeError(`Failed to construct '${iface}': parameter 1 is not of type 'Function'.`);
  }
  return cb;
}

/** WebIDL dictionary conversion: undefined/null -> {}, other non-objects -> TypeError. */
function dict(v, what) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' && typeof v !== 'function') throw new TypeError(`${what} is not an object.`);
  return v;
}

// ======================================================================================= ResizeObserver

const BOXES = new Set(['content-box', 'border-box', 'device-pixel-content-box']);

// https://drafts.csswg.org/resize-observer/#resize-observer-interface
class ResizeObserver {
  #cb;
  /** observed elements (the spec's observation targets); never measured */
  #targets = new Set();

  constructor(callback) {
    need(arguments.length, 1, 'constructor', 'ResizeObserver');
    this.#cb = callbackArg(callback, 'ResizeObserver');
  }

  observe(target, options = undefined) {
    need(arguments.length, 1, 'observe', 'ResizeObserver');
    elementArg(target, 'observe', 'ResizeObserver');
    const box = dict(options, "Failed to execute 'observe' on 'ResizeObserver': parameter 2").box;
    if (box !== undefined && !BOXES.has(String(box))) {
      throw new TypeError(`Failed to execute 'observe' on 'ResizeObserver': The provided value '${String(box)}' is not a valid enum value of type ResizeObserverBoxOptions.`);
    }
    this.#targets.add(target);
  }

  unobserve(target) {
    need(arguments.length, 1, 'unobserve', 'ResizeObserver');
    this.#targets.delete(elementArg(target, 'unobserve', 'ResizeObserver'));
  }

  disconnect() {
    this.#targets.clear();
  }
}

/** Never created by rsdom (nothing is measured); exposed for feature detection and instanceof checks. */
class ResizeObserverEntry {
  constructor() {
    illegal();
  }
}

class ResizeObserverSize {
  constructor() {
    illegal();
  }
}

// ================================================================================= IntersectionObserver

/** px per absolute CSS length unit (css-values-4 §6.2). */
const ABS_UNITS = { px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, in: 96, pt: 4 / 3, pc: 16 };
const MARGIN_TOKEN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)$/i;

/**
 * https://w3c.github.io/IntersectionObserver/#parse-a-margin: 1-4 tokens, each an absolute length or a percentage,
 * expanded to [top, right, bottom, left] and serialized (`rootMargin` / `scrollMargin` getters). SyntaxError otherwise.
 */
function parseMargin(v, name) {
  const tokens = String(v).trim().split(/\s+/).filter(Boolean);
  const fail = () => {
    throw new rt.classes.DOMException(`Failed to construct 'IntersectionObserver': ${name} must be specified in pixels or percent.`, 'SyntaxError');
  };
  if (tokens.length === 0) return '0px 0px 0px 0px';
  if (tokens.length > 4) fail();
  const out = tokens.map((t) => {
    const m = MARGIN_TOKEN.exec(t);
    if (m === null) fail();
    if (m[2] === '%') return `${Number(m[1])}%`;
    const k = ABS_UNITS[m[2].toLowerCase()];
    if (k === undefined) fail();
    return `${Number(m[1]) * k}px`;
  });
  const [top, right = top, bottom = top, left = right] = out;
  return `${top} ${right} ${bottom} ${left}`;
}

function parseThresholds(v) {
  const list = v === undefined ? [0] : typeof v === 'object' && v !== null && Symbol.iterator in v ? [...v] : [v];
  const out = list.map((t) => {
    const n = Number(t);
    if (!Number.isFinite(n)) {
      throw new TypeError("Failed to construct 'IntersectionObserver': The provided double value is non-finite.");
    }
    if (n < 0 || n > 1) {
      throw new RangeError("Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1");
    }
    return n;
  });
  out.sort((a, b) => a - b);
  return Object.freeze(out.length === 0 ? [0] : out);
}

// https://w3c.github.io/IntersectionObserver/#intersection-observer-interface
class IntersectionObserver {
  #cb;
  #root;
  #rootMargin;
  #scrollMargin;
  #thresholds;
  #targets = new Set();

  constructor(callback, options = undefined) {
    need(arguments.length, 1, 'constructor', 'IntersectionObserver');
    this.#cb = callbackArg(callback, 'IntersectionObserver');
    const o = dict(options, "Failed to construct 'IntersectionObserver': The provided value");
    const root = o.root ?? null;
    if (root !== null && !(root instanceof Element) && !(root instanceof Document)) {
      throw new TypeError("Failed to construct 'IntersectionObserver': The provided value is not of type '(Document or Element)'.");
    }
    this.#root = root;
    this.#rootMargin = parseMargin(o.rootMargin ?? '0px', 'rootMargin');
    this.#scrollMargin = parseMargin(o.scrollMargin ?? '0px', 'scrollMargin');
    this.#thresholds = parseThresholds(o.threshold);
  }

  get root() {
    return this.#root;
  }

  get rootMargin() {
    return this.#rootMargin;
  }

  get scrollMargin() {
    return this.#scrollMargin;
  }

  get thresholds() {
    return this.#thresholds;
  }

  observe(target) {
    need(arguments.length, 1, 'observe', 'IntersectionObserver');
    this.#targets.add(elementArg(target, 'observe', 'IntersectionObserver'));
  }

  unobserve(target) {
    need(arguments.length, 1, 'unobserve', 'IntersectionObserver');
    this.#targets.delete(elementArg(target, 'unobserve', 'IntersectionObserver'));
  }

  disconnect() {
    this.#targets.clear();
  }

  takeRecords() {
    // Touch a private field so a foreign `this` throws, as the other members do.
    void this.#targets;
    return [];
  }
}

/** A read-only rect from a DOMRectInit (rsdom has no DOMRect classes yet: ROADMAP `geometry`). */
function rectFrom(init) {
  const d = dict(init, 'DOMRectInit');
  const x = Number(d.x ?? 0);
  const y = Number(d.y ?? 0);
  const width = Number(d.width ?? 0);
  const height = Number(d.height ?? 0);
  const r = {
    x, y, width, height,
    top: Math.min(y, y + height), right: Math.max(x, x + width), bottom: Math.max(y, y + height), left: Math.min(x, x + width),
  };
  return Object.freeze({ ...r, toJSON: () => ({ ...r }) });
}

// Constructible (the spec gives it a constructor); rsdom itself never queues one.
class IntersectionObserverEntry {
  #e;

  constructor(init) {
    need(arguments.length, 1, 'constructor', 'IntersectionObserverEntry');
    const d = dict(init, "Failed to construct 'IntersectionObserverEntry': parameter 1");
    for (const k of ['time', 'boundingClientRect', 'intersectionRect', 'target']) {
      if (d[k] === undefined) {
        throw new TypeError(`Failed to construct 'IntersectionObserverEntry': required member ${k} is undefined.`);
      }
    }
    this.#e = {
      time: Number(d.time),
      rootBounds: d.rootBounds === undefined || d.rootBounds === null ? null : rectFrom(d.rootBounds),
      boundingClientRect: rectFrom(d.boundingClientRect),
      intersectionRect: rectFrom(d.intersectionRect),
      isIntersecting: !!d.isIntersecting,
      isVisible: !!d.isVisible,
      intersectionRatio: Number(d.intersectionRatio ?? 0),
      target: elementArg(d.target, 'constructor', 'IntersectionObserverEntry'),
    };
  }

  get time() { return this.#e.time; }
  get rootBounds() { return this.#e.rootBounds; }
  get boundingClientRect() { return this.#e.boundingClientRect; }
  get intersectionRect() { return this.#e.intersectionRect; }
  get isIntersecting() { return this.#e.isIntersecting; }
  get isVisible() { return this.#e.isVisible; }
  get intersectionRatio() { return this.#e.intersectionRatio; }
  get target() { return this.#e.target; }
}

// ==================================================================================== Element scrolling

/** "Normalize non-finite values" (cssom-view): NaN and ±Infinity become 0. */
function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The (x, y) / (options) overloads of scroll, scrollTo and scrollBy: [left, top] with undefined for a member the
 * options omit. A single non-object argument is a ScrollToOptions conversion error, as in browsers.
 */
function scrollArgs(args, method) {
  if (args.length === 0) return [undefined, undefined];
  if (args.length === 1) {
    const o = args[0];
    if (o !== undefined && o !== null && typeof o !== 'object' && typeof o !== 'function') {
      throw new TypeError(`Failed to execute '${method}' on 'Element': The provided value is not of type 'ScrollToOptions'.`);
    }
    const d = o ?? {};
    return [d.left === undefined ? undefined : finite(d.left), d.top === undefined ? undefined : finite(d.top)];
  }
  return [finite(args[0]), finite(args[1])];
}

function scrollElementTo(el, args, method) {
  const [left, top] = scrollArgs(args, method);
  if (left !== undefined) el.scrollLeft = left;
  if (top !== undefined) el.scrollTop = top;
}

// ====================================================================================== pointer capture

/** document -> Map(pointerId -> element holding the capture). */
const captures = new WeakMap();

/** WebIDL `long` (ToInt32). */
function pointerId(v) {
  return Number(v) | 0;
}

// ====================================================================================== checkVisibility

/**
 * https://drafts.csswg.org/cssom-view/#dom-element-checkvisibility, with display/opacity/visibility from
 * getComputedStyle (no boxes exist). content-visibility is not computed by area A, so ancestors with
 * `content-visibility: hidden` do not hide.
 */
function checkVisibility(el, options) {
  if (!el.isConnected || el.ownerDocument._ctx === undefined) return false;
  const o = dict(options, "Failed to execute 'checkVisibility' on 'Element': parameter 1");
  const opacity = !!(o.opacityProperty || o.checkOpacity);
  const visibility = !!(o.visibilityProperty || o.checkVisibilityCSS);
  const cs = rt.getComputedStyle;
  const own = cs(el);
  // display: contents generates no box of its own.
  if (own.display === 'none' || own.display === 'contents') return false;
  if (visibility && own.visibility !== 'visible') return false;
  for (let a = el; a !== null; a = a.parentElement) {
    const s = a === el ? own : cs(a);
    if (s.display === 'none') return false;
    if (opacity && s.opacity === '0') return false;
  }
  return true;
}

// ========================================================================================= hit testing

/**
 * DocumentOrShadowRoot#elementFromPoint / elementsFromPoint (cssom-view). No boxes exist, so no point hits an
 * element: null and [], as happy-dom's elementFromPoint returns. ProseMirror's posAtCoords then falls back to its
 * own walk over getBoundingClientRect; without the method its mousedown handler throws (e2e/libraries tiptap).
 * The arguments are WebIDL `double`s: missing or non-finite ones throw.
 */
function hitTesting(iface) {
  function coords(argc, x, y, method) {
    need(argc, 2, method, iface);
    // Unary plus is WebIDL ToNumber: it throws on BigInt and Symbol, which Number() would accept or convert.
    if (!Number.isFinite(+x) || !Number.isFinite(+y)) {
      throw new TypeError(`Failed to execute '${method}' on '${iface}': The provided double value is non-finite.`);
    }
  }
  return {
    elementFromPoint(x, y) {
      coords(arguments.length, x, y, 'elementFromPoint');
      return null;
    },
    elementsFromPoint(x, y) {
      coords(arguments.length, x, y, 'elementsFromPoint');
      return [];
    },
  };
}

// ============================================================================================== install

function install(_rt, dom) {
  ({ Element, Document } = dom);
  tag(ResizeObserver);
  tag(ResizeObserverEntry);
  tag(ResizeObserverSize);
  tag(IntersectionObserver);
  tag(IntersectionObserverEntry);

  rt.define(Element, {
    // No layout, nothing to scroll into view; arguments are accepted as browsers accept them.
    scrollIntoView(_arg = undefined) {},
    scroll(...args) {
      scrollElementTo(this, args, 'scroll');
    },
    scrollTo(...args) {
      scrollElementTo(this, args, 'scrollTo');
    },
    scrollBy(...args) {
      const [left, top] = scrollArgs(args, 'scrollBy');
      if (left !== undefined) this.scrollLeft += left;
      if (top !== undefined) this.scrollTop += top;
    },

    // https://w3c.github.io/pointerevents/#element-interface. No pointer is tracked, so every pointerId counts as
    // active (no NotFoundError) and the got/lostpointercapture events are not fired.
    setPointerCapture(id) {
      need(arguments.length, 1, 'setPointerCapture', 'Element');
      const p = pointerId(id);
      if (!this.isConnected) {
        throw new rt.classes.DOMException("Failed to execute 'setPointerCapture' on 'Element': InvalidStateError", 'InvalidStateError');
      }
      const doc = this.ownerDocument;
      let m = captures.get(doc);
      if (m === undefined) captures.set(doc, (m = new Map()));
      m.set(p, this);
    },
    releasePointerCapture(id) {
      need(arguments.length, 1, 'releasePointerCapture', 'Element');
      const p = pointerId(id);
      const m = captures.get(this.ownerDocument);
      if (m !== undefined && m.get(p) === this) m.delete(p);
    },
    hasPointerCapture(id) {
      need(arguments.length, 1, 'hasPointerCapture', 'Element');
      const p = pointerId(id);
      const m = captures.get(this.ownerDocument);
      if (m === undefined || m.get(p) !== this) return false;
      // Removing the element from the tree releases its capture implicitly.
      if (this.isConnected) return true;
      m.delete(p);
      return false;
    },

    checkVisibility(options = undefined) {
      return checkVisibility(this, options);
    },
  });

  // ShadowRoot gets the same pair from lib/shadow.cjs, which installs after this area.
  rt.define(Document, hitTesting('Document'));
}

module.exports = { install, hitTesting, ResizeObserver, IntersectionObserver, IntersectionObserverEntry };
