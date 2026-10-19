'use strict';
// AREA A (style, ROADMAP M5 style part + M6 computed style): CSSStyleDeclaration / CSSStyleProperties
// (`element.style`, cached in the wrapper field `_st`) and getComputedStyle (core snapshot memo in the
// wrapper field `_cs`, validated by EP[STYLE]).
//
// - The declaration block lives in Rust (src/style/inline.rs); this is a thin CSSOM facade. Property ids
//   come from data/css/properties.tsv (the same file Rust embeds), so both sides agree.
// - Generated prototype accessors for every property jsdom knows: kebab-case, camelCase and the
//   Webkit*/webkit* aliases of -webkit-* properties, plus cssFloat. Unknown names stay plain expandos.
// - getComputedStyle(el, pseudo) is a plain function that ignores `this` (jest-dom destructures it):
//   exported as `rt.getComputedStyle` for the window area (C) to install. It returns a read-only
//   declaration whose core properties (display, visibility, pointer-events, opacity, position) are a
//   snapshot of one `csCore` crossing (memoised per element against EP[STYLE], and EP[REC]/EP[FORM] when
//   author sheets select on state: EP[STYLE_DEP]; lib/memo.cjs); other properties are read live through `csStr`
//   (documented divergence: jsdom's declaration is a full snapshot). RSDOM_NO_MEMO=1 disables the memo.
//   Pseudo-elements get a declaration with `content: none` and empty values.

/** Core layout (src/style/cascade.rs `pack`). */
const DISPLAY_KW = ['inline', 'block', 'none', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid',
  'contents', 'list-item', 'table', 'inline-table', 'table-row', 'table-cell', 'table-column',
  'table-column-group', 'table-header-group', 'table-footer-group', 'table-row-group', 'table-caption',
  'flow-root', 'ruby', 'ruby-text'];
const VISIBILITY_KW = ['visible', 'hidden', 'collapse'];
const POINTER_EVENTS_KW = ['auto', 'none', 'visiblepainted', 'visiblefill', 'visiblestroke', 'visible', 'painted',
  'fill', 'stroke', 'all', 'bounding-box'];
const POSITION_KW = ['static', 'relative', 'absolute', 'fixed', 'sticky'];
const OPACITY_ONE = 1 << 11;
const CUSTOM_BASE = 0x10000;

/** Property table: NAMES[id] = kebab name (crates/rsdom/data/css/properties.tsv line order). */
const NAMES = require('./generated/css-properties.cjs');
const ID = new Map(NAMES.map((n, i) => [n, i]));

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function install(rt, dom) {
  const { N, V, EPI, TOKEN } = rt;
  const { Element, HTMLElement, SVGElement, MathMLElement } = dom;
  const { installIndices } = require('./collections.cjs');
  const { MEMO, deps } = require('./memo.cjs');
  /**
   * The core snapshot depends on EP[STYLE]; while author sheets select on element state (EP[STYLE_DEP] != 0,
   * src/style/mod.rs) also on form state and any record write. Stamps hold all three slots.
   */
  const CORE_DEPS = deps('STYLE', 'REC', 'FORM');

  const P = (n) => ID.get(n);
  const DISPLAY = P('display');
  const VISIBILITY = P('visibility');
  const POINTER_EVENTS = P('pointer-events');
  const OPACITY = P('opacity');
  const POSITION = P('position');
  const CONTENT = P('content');
  const FLOAT = P('float');

  /** Custom property name -> id (interned in Rust; env-specific, cleared on reset). */
  let CUSTOM = new Map();
  rt.onReset(() => {
    CUSTOM = new Map();
  });

  /** Property id of a CSSOM name, or -1 (unknown property). */
  function pidOf(name) {
    if (typeof name !== 'string') name = String(name);
    let p = ID.get(name);
    if (p !== undefined) return p;
    if (name.startsWith('--')) {
      p = CUSTOM.get(name);
      if (p === undefined) {
        p = N.cssProp(name);
        if (p === 0) return -1;
        rt.syncAtoms();
        CUSTOM.set(name, p);
      }
      return p;
    }
    p = ID.get(rt.asciiLower(name));
    return p === undefined ? -1 : p;
  }

  const KIND_INLINE = 0;
  const KIND_COMPUTED = 1;
  const KIND_PSEUDO = 2;

  function readOnly() {
    return rt.domError(10, 'These styles are computed, and the properties are therefore read-only.');
  }

  class CSSStyleDeclaration {
    // Internal state is #private: Vitest's toEqual / pretty-format see no own keys (like jsdom's).
    /** owner element wrapper (its `_i` is read on every call: a reset neuters it) */
    #o;
    /** 0 inline, 1 computed, 2 pseudo-element */
    #k;
    /** computed: packed core snapshot */
    #c;
    /** computed: declared property names (lazy snapshot for length/item) */
    #p = null;

    constructor(t = undefined, owner = null, kind = KIND_INLINE, core = 0) {
      if (t !== TOKEN) throw new TypeError('Illegal constructor');
      this.#o = owner;
      this.#k = kind;
      this.#c = core;
    }

    /** value by property id */
    _pv(p) {
      const k = this.#k;
      if (k === KIND_INLINE) return N.styleGet(this.#o._i, p);
      if (k === KIND_PSEUDO) return p === CONTENT ? 'none' : '';
      const c = this.#c;
      if (c !== 0) {
        let i;
        switch (p) {
          case DISPLAY: i = c & 31; if (i < DISPLAY_KW.length) return DISPLAY_KW[i]; break;
          case VISIBILITY: i = (c >>> 5) & 3; if (i < 3) return VISIBILITY_KW[i]; break;
          case POINTER_EVENTS: i = (c >>> 7) & 15; if (i < POINTER_EVENTS_KW.length) return POINTER_EVENTS_KW[i]; break;
          case POSITION: i = (c >>> 12) & 7; if (i < POSITION_KW.length) return POSITION_KW[i]; break;
          case OPACITY: if ((c & OPACITY_ONE) !== 0) return '1'; break;
          default:
        }
      }
      return N.csStr(this.#o._i, p);
    }

    /** set by property id ('' removes) */
    _sp(p, value, important) {
      if (this.#k !== KIND_INLINE) throw readOnly();
      const id = this.#o._i;
      if (value === '') N.styleRemove(id, p);
      else N.styleSet(id, p, value, important);
      rt.mutated();
    }

    _declared() {
      if (this.#p === null) {
        if (this.#k === KIND_PSEUDO) this.#p = [];
        else {
          const ids = rt.outIds(N.csProps(this.#o._i));
          this.#p = Array.from(ids, (p) => NAMES[p]);
        }
        if (this.#p.length > IDX.n) IDX.n = installIndices(CSSStyleDeclaration.prototype, IDX.n, this.#p.length);
      }
      return this.#p;
    }

    _get(i) {
      if (this.#k !== KIND_INLINE) return this._declared()[i];
      const n = this.length;
      return i >= 0 && i < n ? N.styleItem(this.#o._i, i) : undefined;
    }

    get cssText() {
      if (this.#k !== KIND_INLINE) return '';
      return N.styleCssText(this.#o._i);
    }

    set cssText(v) {
      if (this.#k !== KIND_INLINE) throw readOnly();
      N.styleCssTextSet(this.#o._i, v === null ? '' : String(v));
      rt.mutated();
    }

    get length() {
      if (this.#k !== KIND_INLINE) return this._declared().length;
      const n = N.styleLen(this.#o._i);
      if (n > IDX.n) IDX.n = installIndices(CSSStyleDeclaration.prototype, IDX.n, n);
      return n;
    }

    item(index) {
      return this._get(index >>> 0) ?? '';
    }

    getPropertyValue(property) {
      const p = pidOf(property);
      return p < 0 ? '' : this._pv(p);
    }

    getPropertyPriority(property) {
      if (this.#k !== KIND_INLINE) return '';
      const p = pidOf(property);
      return p >= 0 && N.stylePriority(this.#o._i, p) ? 'important' : '';
    }

    setProperty(property, value, priority = '') {
      if (this.#k !== KIND_INLINE) throw readOnly();
      const p = pidOf(property);
      if (p < 0) return;
      const v = value === null || value === undefined ? '' : String(value);
      this._sp(p, v, String(priority).toLowerCase() === 'important');
    }

    removeProperty(property) {
      if (this.#k !== KIND_INLINE) throw readOnly();
      const p = pidOf(property);
      if (p < 0) return '';
      const old = N.styleRemove(this.#o._i, p);
      rt.mutated();
      return old;
    }

    get parentRule() {
      return null;
    }

    get cssFloat() {
      return this._pv(FLOAT);
    }

    set cssFloat(v) {
      this._sp(FLOAT, v === null ? '' : String(v), false);
    }

    [Symbol.iterator]() {
      let i = 0;
      const self = this;
      return {
        next() {
          const v = self._get(i++);
          return v === undefined ? { value: undefined, done: true } : { value: v, done: false };
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    }
  }
  Object.defineProperty(CSSStyleDeclaration.prototype, Symbol.toStringTag, { value: 'CSSStyleDeclaration', configurable: true });
  rt.classes.CSSStyleDeclaration = CSSStyleDeclaration;

  // jsdom 30: instances are CSSStyleProperties (property accessors live on its prototype).
  class CSSStyleProperties extends CSSStyleDeclaration {}
  Object.defineProperty(CSSStyleProperties.prototype, Symbol.toStringTag, { value: 'CSSStyleProperties', configurable: true });
  rt.classes.CSSStyleProperties = CSSStyleProperties;

  const IDX = { n: installIndices(CSSStyleDeclaration.prototype, 0, 32) };

  // Generated property accessors (jsdom's 1638 descriptor names).
  const proto = CSSStyleProperties.prototype;
  // ~1700 accessors added one by one to a fast-mode prototype cost O(n^2) map transitions (~25 ms and
  // ~13 MB of garbage per worker). Adding and deleting a property first switches the prototype to
  // dictionary mode, which it ends in anyway (lookups are unchanged); the loop then takes ~5 ms.
  proto.__rsdom_dict = 0;
  delete proto.__rsdom_dict;
  const define = (name, p) => {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return;
    Object.defineProperty(proto, name, {
      get() {
        return this._pv(p);
      },
      set(v) {
        this._sp(p, v === null ? '' : String(v), false);
      },
      enumerable: true,
      configurable: true,
    });
  };
  for (let p = 0; p < NAMES.length; p++) {
    const n = NAMES[p];
    define(n, p);
    if (n.startsWith('-webkit-')) {
      const c = camel(n.slice(8));
      const C = c[0].toUpperCase() + c.slice(1);
      define(`Webkit${C}`, p);
      define(`webkit${C}`, p);
    } else {
      define(camel(n), p);
    }
  }

  // element.style (ElementCSSInlineStyle on HTML, SVG and MathML elements); `el.style = text` sets cssText.
  const styleAccessor = {
    get style() {
      return this._st ?? (this._st = new CSSStyleProperties(TOKEN, this, KIND_INLINE, 0));
    },
    set style(v) {
      this.style.cssText = v;
    },
  };
  rt.define(HTMLElement, styleAccessor);
  rt.define(SVGElement, styleAccessor);
  rt.define(MathMLElement, styleAccessor);

  /** The core snapshot of element `el`, memoised on the wrapper (`_cs` = { k: CORE_DEPS stamp, c }). */
  function core(el) {
    const id = el._i;
    if (!MEMO) return N.csCore(id);
    const m = el._cs;
    if (m !== null && CORE_DEPS.fresh(m.k, V.EP[EPI.STYLE_DEP] === 0 ? 1 : 3)) return m.c;
    const c = N.csCore(id);
    if (m === null) el._cs = { k: CORE_DEPS.stamp(), c };
    else {
      CORE_DEPS.stamp(m.k);
      m.c = c;
    }
    return c;
  }

  /**
   * window.getComputedStyle(elt, pseudoElt): an unbound plain function (`this` is ignored).
   * @param {Element} elt
   * @param {string|null} [pseudoElt]
   */
  function getComputedStyle(elt, pseudoElt = undefined) {
    if (!(elt instanceof Element)) {
      throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
    }
    if (pseudoElt !== undefined && pseudoElt !== null && String(pseudoElt) !== '') {
      return new CSSStyleProperties(TOKEN, elt, KIND_PSEUDO, 0);
    }
    return new CSSStyleProperties(TOKEN, elt, KIND_COMPUTED, core(elt));
  }

  rt.getComputedStyle = getComputedStyle;
  rt.style = { pidOf, NAMES, core };
  module.exports.getComputedStyle = getComputedStyle;
}

module.exports = { install, getComputedStyle: null, NAMES };
