'use strict';
// DOMRect and the small interfaces behind the remaining Window members (ROADMAP Stage 3 `geometry`, DESIGN §40),
// ported from refs/jsdom/lib/jsdom/living/geometry/DOMRect{,ReadOnly}-impl.js, living/window/{BarProp,External}-impl.js
// and living/navigator/{Plugin,PluginArray,MimeType,MimeTypeArray}-impl.js. Facade state only: none of these
// touches the tree. lib/window.cjs creates the per-window instances (`locationbar`, `external`,
// `navigator.plugins`, ...). getBoundingClientRect() and getClientRects() keep returning a plain object and an
// array, as jsdom's do.

const rt = require('./runtime.cjs');

const { TOKEN } = rt;

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

/** WebIDL `unrestricted double` (webidl-conversions' messages). */
function udbl(v, context) {
  if (typeof v === 'bigint') throw new TypeError(`${context} is a BigInt which cannot be converted to a number.`);
  return Number(v);
}

// ========================================================================================== DOMRect

/** The [x, y, width, height] array of a rect (set in DOMRectReadOnly's static block; DOMRect's setters write it). */
let rectOf;
/** True for DOMRectReadOnly instances (DOMRect's included). */
let isRect;

/** The rect's values, after jsdom's brand check for getter `k`. */
function v(r, k) {
  if (!isRect(r)) throw new TypeError(`'get ${k}' called on an object that is not a valid instance of DOMRectReadOnly.`);
  return rectOf(r);
}

/** DOMRectInit, members in WebIDL dictionary order (height, width, x, y). */
function rectInit(other, method, iface) {
  const r = [0, 0, 0, 0];
  if (other === undefined || other === null) return r;
  if (typeof other !== 'object' && typeof other !== 'function') {
    throw new TypeError(`Failed to execute '${method}' on '${iface}': parameter 1 is not an object.`);
  }
  const ctx = (k) => `Failed to execute '${method}' on '${iface}': parameter 1 has member '${k}' that`;
  const keys = ['height', 'width', 'x', 'y'];
  const at = [3, 2, 0, 1];
  for (let i = 0; i < 4; i++) {
    const v = other[keys[i]];
    if (v !== undefined) r[at[i]] = udbl(v, ctx(keys[i]));
  }
  return r;
}

class DOMRectReadOnly {
  #v;

  constructor(x = undefined, y = undefined, width = undefined, height = undefined) {
    const name = new.target === DOMRect ? 'DOMRect' : 'DOMRectReadOnly';
    const arg = (v, i) => (v === undefined ? 0 : udbl(v, `Failed to construct '${name}': parameter ${i}`));
    this.#v = [arg(x, 1), arg(y, 2), arg(width, 3), arg(height, 4)];
  }

  static {
    rectOf = (r) => r.#v;
    isRect = (r) => r !== null && typeof r === 'object' && #v in r;
  }

  static fromRect(other = undefined) {
    const [x, y, w, h] = rectInit(other, 'fromRect', 'DOMRectReadOnly');
    return new DOMRectReadOnly(x, y, w, h);
  }

  toJSON() {
    if (!isRect(this)) throw new TypeError("'toJSON' called on an object that is not a valid instance of DOMRectReadOnly.");
    return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left };
  }

  get x() {
    return v(this, 'x')[0];
  }

  get y() {
    return v(this, 'y')[1];
  }

  get width() {
    return v(this, 'width')[2];
  }

  get height() {
    return v(this, 'height')[3];
  }

  // Math.min / Math.max carry NaN through, as jsdom's do (w3c/fxtf-drafts#222)
  get top() {
    const [, y, , h] = v(this, 'top');
    return Math.min(y, y + h);
  }

  get right() {
    const [x, , w] = v(this, 'right');
    return Math.max(x, x + w);
  }

  get bottom() {
    const [, y, , h] = v(this, 'bottom');
    return Math.max(y, y + h);
  }

  get left() {
    const [x, , w] = v(this, 'left');
    return Math.min(x, x + w);
  }
}
tag(DOMRectReadOnly);

class DOMRect extends DOMRectReadOnly {
  static fromRect(other = undefined) {
    const [x, y, w, h] = rectInit(other, 'fromRect', 'DOMRect');
    return new DOMRect(x, y, w, h);
  }
}
// x / y / width / height become read-write: own accessors whose getters are DOMRectReadOnly's
for (const [i, k] of ['x', 'y', 'width', 'height'].entries()) {
  const get = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, k).get;
  const acc = {
    get [k]() {
      if (!(this instanceof DOMRect)) throw new TypeError(`'get ${k}' called on an object that is not a valid instance of DOMRect.`);
      return get.call(this);
    },
    set [k](v) {
      if (!(this instanceof DOMRect)) throw new TypeError(`'set ${k}' called on an object that is not a valid instance of DOMRect.`);
      rectOf(this)[i] = udbl(v, `Failed to set the '${k}' property on 'DOMRect': The provided value`);
    },
  };
  Object.defineProperty(DOMRect.prototype, k, { ...Object.getOwnPropertyDescriptor(acc, k), enumerable: false, configurable: true });
}
tag(DOMRect);

// ================================================================================ BarProp, External

/** Instances made by the TOKEN constructors below (jsdom's brand checks; none of these is on a hot path). */
const BRAND = new WeakSet();

/** jsdom's brand check: `what` is `'get x'` for a getter, the method name otherwise. */
function brand(o, what, iface) {
  if (!BRAND.has(o)) throw new TypeError(`'${what}' called on an object that is not a valid instance of ${iface}.`);
}

/** BarProp (`locationbar`, `menubar`, ...): `visible` is always true, as in jsdom. */
class BarProp {
  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
    BRAND.add(this);
  }

  get visible() {
    brand(this, 'get visible', 'BarProp');
    return true;
  }
}
tag(BarProp);

/** `window.external`: both methods do nothing (HTML obsolete features). */
class External {
  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
    BRAND.add(this);
  }

  AddSearchProvider() {
    brand(this, 'AddSearchProvider', 'External');
  }

  IsSearchProviderInstalled() {
    brand(this, 'IsSearchProviderInstalled', 'External');
  }
}
tag(External);

// ======================================================================== plugins and MIME types

function needArg(len, method, iface) {
  if (len < 1) throw new TypeError(`Failed to execute '${method}' on '${iface}': 1 argument required, but only 0 present.`);
}

/** An interface no instance of which ever exists (jsdom reports no plugins): every member fails its brand check. */
function emptyInterface(name, getters, methods) {
  const C = { [name]: class { constructor() { illegal(); } } }[name];
  for (const k of methods) {
    Object.defineProperty(C.prototype, k, {
      value: { [k]() { brand(this, k, name); } }[k],
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  for (const k of getters) {
    Object.defineProperty(C.prototype, k, {
      get: Object.getOwnPropertyDescriptor({ get [k]() { brand(this, `get ${k}`, name); return undefined; } }, k).get,
      enumerable: false,
      configurable: true,
    });
  }
  return tag(C);
}
emptyInterface('Plugin', ['name', 'description', 'filename', 'length'], ['item', 'namedItem']);
emptyInterface('MimeType', ['type', 'description', 'suffixes', 'enabledPlugin'], []);

/** `navigator.plugins`: always empty. */
class PluginArray {
  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
    BRAND.add(this);
  }

  refresh() {
    brand(this, 'refresh', 'PluginArray');
  }

  item(index) {
    brand(this, 'item', 'PluginArray');
    needArg(arguments.length, 'item', 'PluginArray');
    return null;
  }

  namedItem(name) {
    brand(this, 'namedItem', 'PluginArray');
    needArg(arguments.length, 'namedItem', 'PluginArray');
    return null;
  }

  get length() {
    brand(this, 'get length', 'PluginArray');
    return 0;
  }

}
Object.defineProperty(PluginArray.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true });
tag(PluginArray);

/** `navigator.mimeTypes`: always empty. */
class MimeTypeArray {
  constructor(t = undefined) {
    if (t !== TOKEN) illegal();
    BRAND.add(this);
  }

  item(index) {
    brand(this, 'item', 'MimeTypeArray');
    needArg(arguments.length, 'item', 'MimeTypeArray');
    return null;
  }

  namedItem(name) {
    brand(this, 'namedItem', 'MimeTypeArray');
    needArg(arguments.length, 'namedItem', 'MimeTypeArray');
    return null;
  }

  get length() {
    brand(this, 'get length', 'MimeTypeArray');
    return 0;
  }

}
Object.defineProperty(MimeTypeArray.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true });
tag(MimeTypeArray);

function install() {
  // WebIDL static operations are enumerable
  for (const C of [DOMRectReadOnly, DOMRect]) Object.defineProperty(C, 'fromRect', { enumerable: true });
  // Document's legacy no-op methods (jsdom's Document-impl.js; the Window's are in lib/window.cjs)
  const D = rt.classes.Document.prototype;
  for (const k of ['captureEvents', 'releaseEvents']) {
    Object.defineProperty(D, k, { value: { [k]() {} }[k], writable: true, enumerable: false, configurable: true });
  }
}

module.exports = { install, DOMRect, DOMRectReadOnly, BarProp, External, PluginArray, MimeTypeArray };
