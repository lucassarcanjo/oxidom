'use strict';
// Reflected IDL attributes (ROADMAP Stage 3 `reflection`, DESIGN §37): every `[Reflect*]` attribute jsdom
// declares, ARIAMixin included, from the table scripts/gen-interfaces.mjs extracts out of jsdom's webidl
// (data/interfaces.json `reflect`, refs/jsdom/lib/jsdom/living/nodes/*.webidl and aria/ARIAMixin.webidl).
// Installed last: an accessor another area already defines on the interface (forms.cjs and others, often
// with behaviour beyond the attribute) wins, and this fills in the rest. The accessors are jsdom's
// generated ones (webidl2js reflection), through Element.prototype.getAttribute / setAttribute.

const rt = require('./runtime.cjs');
const forms = require('./forms.cjs');
const { reflect } = require('./generated/interfaces.cjs');
const { parseFloatingPoint } = require('./input-number.cjs');

const { reflectStr, reflectBool, reflectLong, reflectURL, parseInteger } = forms;
const MAX = 2147483647;

// Element.prototype's attribute methods (set by install()), not the instance's: see forms.cjs `getAttr`.
let getAttr;
let setAttr;
let removeAttr;

function define(C, prop, get, set) {
  Object.defineProperty(C.prototype, prop, { get, set, enumerable: false, configurable: true });
}

/** DOMString? (ARIA, crossOrigin): null when absent; null / undefined removes the attribute. */
function reflectNullable(C, prop, attr) {
  define(
    C,
    prop,
    function get() {
      return getAttr.call(this, attr);
    },
    function set(v) {
      if (v === null || v === undefined) removeAttr.call(this, attr);
      else setAttr.call(this, attr, v);
    },
  );
}

/** [LegacyNullToEmptyString] DOMString (the legacy colour attributes). */
function reflectNullToEmpty(C, prop, attr) {
  define(
    C,
    prop,
    function get() {
      return getAttr.call(this, attr) ?? '';
    },
    function set(v) {
      setAttr.call(this, attr, v === null ? '' : v);
    },
  );
}

/** `unsigned long`, with ReflectRange clamping and ReflectPositive(WithFallback) (0 is invalid). */
function reflectUnsigned(C, prop, attr, o) {
  const dflt = o.d ?? 0;
  const low = o.pos || o.posFb ? 1 : 0;
  define(
    C,
    prop,
    function get() {
      const v = getAttr.call(this, attr);
      if (v === null) return dflt;
      const n = parseInteger(v);
      if (n === null || n < 0) return dflt;
      if (o.range !== undefined) return Math.min(Math.max(n, o.range[0]), o.range[1]);
      return n >= low && n <= MAX ? n : dflt;
    },
    function set(v) {
      const n = Number(v) >>> 0;
      if (o.pos && n === 0) throw rt.domError(5, `The value ${n} cannot be set for the ${prop} property.`);
      setAttr.call(this, attr, String(n >= low && n <= MAX ? n : dflt));
    },
  );
}

/** Enumerated attributes jsdom implements by hand rather than with [Reflect]. */
function installEnumerated(C) {
  const SCOPES = new Set(['row', 'col', 'rowgroup', 'colgroup']);
  define(
    C.HTMLTableCellElement,
    'scope',
    function get() {
      const v = getAttr.call(this, 'scope');
      if (v === null) return '';
      const l = rt.asciiLower(v);
      return SCOPES.has(l) ? l : '';
    },
    function set(v) {
      setAttr.call(this, 'scope', v);
    },
  );
  // jsdom Document-impl.js: the document element's `dir`.
  define(
    C.Document,
    'dir',
    function get() {
      const e = this.documentElement;
      return e instanceof C.HTMLElement ? e.dir : '';
    },
    function set(v) {
      const e = this.documentElement;
      if (e instanceof C.HTMLElement) e.dir = v;
    },
  );
}

/** `double` with ReflectPositive (progress `max`): non-positive values are ignored. */
function reflectDouble(C, prop, attr, o) {
  const dflt = o.d ?? 0;
  define(
    C,
    prop,
    function get() {
      const v = getAttr.call(this, attr);
      const n = v === null ? null : parseFloatingPoint(v);
      return n === null || (o.pos && n <= 0) ? dflt : n;
    },
    function set(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new TypeError(`Failed to set the '${prop}' property: The provided double value is non-finite.`);
      if (!o.pos || n > 0) setAttr.call(this, attr, String(n));
    },
  );
}

function install(_rt, dom) {
  ({ getAttribute: getAttr, setAttribute: setAttr, removeAttribute: removeAttr } = dom.Element.prototype);
  installEnumerated(rt.classes);
  for (const [iface, list] of Object.entries(reflect)) {
    const C = rt.classes[iface];
    if (C === undefined) continue;
    for (const [prop, attr, kind, o = {}] of list) {
      if (Object.hasOwn(C.prototype, prop)) continue;
      switch (kind) {
        case 'str':
          reflectStr(C, prop, attr);
          break;
        case 'str?':
          reflectNullable(C, prop, attr);
          break;
        case 'str0':
          reflectNullToEmpty(C, prop, attr);
          break;
        case 'url':
          reflectURL(C, prop, attr);
          break;
        case 'bool':
          reflectBool(C, prop, attr);
          break;
        case 'long':
          reflectLong(C, prop, attr, o.d ?? (o.nonNeg ? -1 : 0), o.nonNeg === true);
          break;
        case 'ulong':
          reflectUnsigned(C, prop, attr, o);
          break;
        case 'double':
          reflectDouble(C, prop, attr, o);
          break;
        default:
          throw new Error(`rsdom: no reflection for ${iface}.${prop} (${kind})`);
      }
    }
  }
}

module.exports = { install };
