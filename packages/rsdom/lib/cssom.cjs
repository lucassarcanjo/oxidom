'use strict';
// CSSOM rule objects (DESIGN §35, ROADMAP Stage 3 `cssom`): StyleSheet / CSSStyleSheet, StyleSheetList,
// CSSRuleList, MediaList and the CSSRule family, `styleEl.sheet` and `document.styleSheets`. A port of jsdom 30's
// refs/jsdom/lib/jsdom/living/css/*-impl.js over the rule tree in Rust (src/style/cssom.rs).
//
// - Rust owns the rules (invariant 2): kinds, preludes, child lists and declaration blocks. A sheet is a sheet id,
//   a rule a (sheet id, rule handle) pair; wrappers keep them in `INT` (a WeakMap, so `toEqual` sees no own
//   keys) with the env generation, and a wrapper from an older env reads as empty.
// - jsdom's string rules stay here: cssText assembly, keyframe selectors, page selectors, MediaList parsing and
//   the `selectorText` / `keyText` validation; the facade writes the result back through `omSetStr`.
// - Sheet wrappers are cached by id, rule wrappers per sheet by handle, so `sheet.cssRules[0] === sheet.cssRules[0]`
//   and a rule keeps its identity across insertions. CSSRuleList, StyleSheetList and MediaList read Rust on every
//   access (cold paths), with prototype index getters like the core lists (collections.cjs).

const { N, TOKEN, check, outIds, define } = require('./runtime.cjs');
const { envGen, alive } = require('./memo.cjs');
const { installIndices } = require('./collections.cjs');

/** Rule kinds (src/style/cssom.rs `kind`). */
const K = Object.freeze({
  STYLE: 1, IMPORT: 3, MEDIA: 4, FONT_FACE: 5, PAGE: 6, KEYFRAMES: 7, KEYFRAME: 8, NAMESPACE: 10,
  COUNTER_STYLE: 11, SUPPORTS: 12, LAYER_BLOCK: 20, LAYER_STATEMENT: 21, CONTAINER: 22, SCOPE: 23,
  NESTED_DECLARATIONS: 24,
});
/** Rule string fields (src/style/cssom.rs `field`). */
const FA = 0;
const FB = 1;
const FC = 2;
const FD = 3;
const FMEDIA = 4;

/** jsdom css-values.js GLOBAL_KEYS (serializeCustomIdent). */
const GLOBAL_KEYS = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const KEYFRAMES_EXCLUSIONS = new Set(['none']);
const COUNTER_STYLE_EXCLUSIONS = new Set(['none', 'decimal', 'disc', 'square', 'circle', 'disclosure-open', 'disclosure-closed']);
const CONTAINER_NAME_EXCLUSIONS = new Set(['none', 'and', 'not', 'or']);
const COUNTER_DESCRIPTORS = ['system', 'symbols', 'additiveSymbols', 'negative', 'prefix', 'suffix', 'range', 'pad', 'speakAs', 'fallback'];
const VALID_PAGE_PSEUDOS = new Set(['first', 'left', 'right', 'blank']);

const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** csstree `string.encode`: a double-quoted CSS string. */
function encodeString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (c === 0xa || c === 0xd || c === 0xc || (c < 0x20 && c !== 9) || c === 0x7f) out += '\\' + c.toString(16) + ' ';
    else out += ch;
  }
  return out + '"';
}

/** csstree `ident.encode` (CSSOM "serialize an identifier"). */
function encodeIdent(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '�';
    else if ((c >= 1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) || (i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) {
      out += '\\' + c.toString(16) + ' ';
    } else if (i === 0 && c === 0x2d && s.length === 1) out += '\\-';
    else if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) out += s[i];
    else out += '\\' + s[i];
  }
  return out;
}

/** jsdom css-values.js `serializeCustomIdent`. */
function serializeCustomIdent(name, exclusions) {
  const l = lower(name);
  if (GLOBAL_KEYS.has(l) || l === 'default' || exclusions?.has(l)) return encodeString(name);
  return encodeIdent(name);
}

// ------------------------------------------------------------------------------------------ keyframes

/** jsdom CSSKeyframeRule-impl.js `normalizeSelector`. */
function normalizeKeySelector(sel) {
  const l = lower(sel);
  if (l === 'from') return '0%';
  if (l === 'to') return '100%';
  return String(parseFloat(sel)) + '%';
}

/** jsdom `normalizeKeyText`. */
function normalizeKeyText(text) {
  return text.split(',').map((s) => normalizeKeySelector(s.trim())).join(', ');
}

/** csstree `<keyframe-selector>`: `from`, `to` or a `<percentage>` (jsdom `validateKeyframeSelector`). */
function validKeySelector(sel) {
  if (/^(from|to)$/i.test(sel)) return true;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%$/.test(sel)) return false;
  const n = parseFloat(sel);
  return n >= 0 && n <= 100; // `<percentage [0,100]>`
}

function argRequired(method, iface) {
  return new TypeError(`Failed to execute '${method}' on '${iface}': 1 argument required, but only 0 present.`);
}

/** jsdom MediaList `canonicalize`: a medium compared without insignificant whitespace. */
function canonicalMedium(m) {
  return m.replace(/\s*([():,])\s*/g, '$1');
}

// ------------------------------------------------------------------------------------------ page

/** jsdom CSSPageRule-impl.js `parsePageSelector`: the normalized selector, or null when invalid. */
function parsePageSelector(value) {
  const t = value.trim();
  if (t === '') return '';
  const m = /^([a-zA-Z_\-\\][a-zA-Z0-9_\-\\]*)?((?::[a-zA-Z]+)*)$/.exec(t);
  if (m === null) return null;
  const name = m[1] || '';
  const pseudo = m[2] || '';
  if (!name && !pseudo) return null;
  if (!pseudo) return name;
  const ps = pseudo.slice(1).split(':');
  if (!ps.every((p) => VALID_PAGE_PSEUDOS.has(lower(p)))) return null;
  return name + ps.map((p) => `:${lower(p)}`).join('');
}

// ------------------------------------------------------------------------------------------ media

/**
 * A media query as csstree would accept it (jsdom MediaList-impl.js `parseSingleMedium`): `[not|only]? type
 * [and condition]?` or a condition of parenthesized features joined by `and` / `or` (`not` in front). A
 * `<general-enclosed>` part (a function, e.g. `layer()`) makes it invalid. Returns the lowercased
 * whitespace-collapsed text, or null.
 */
function parseMedium(text) {
  const t = text.trim();
  if (t === '') return null;
  const norm = lower(t.replace(/\s+/g, ' '));
  // tokens: idents, parenthesized groups (balanced), and anything else (invalid)
  const toks = [];
  let i = 0;
  while (i < norm.length) {
    const c = norm[i];
    if (c === ' ') {
      i++;
    } else if (c === '(') {
      let d = 0;
      let j = i;
      for (; j < norm.length; j++) {
        if (norm[j] === '(') d++;
        else if (norm[j] === ')' && --d === 0) break;
      }
      if (d !== 0) return null;
      const inner = norm.slice(i + 1, j);
      if (/[a-z0-9_-]\(/.test(inner) && !/^\s*[a-z-]+\s*:/.test(inner)) return null;
      toks.push({ g: inner });
      i = j + 1;
    } else {
      const m = /^-?[a-z_][a-z0-9_-]*/.exec(norm.slice(i));
      if (m === null) return null;
      if (norm[i + m[0].length] === '(') return null; // a function: <general-enclosed>
      toks.push({ id: m[0] });
      i += m[0].length;
    }
  }
  let k = 0;
  const isId = (x, n) => x !== undefined && x.id === n;
  const condition = () => {
    if (isId(toks[k], 'not')) k++;
    if (toks[k]?.g === undefined) return false;
    k++;
    while (k < toks.length) {
      if (!isId(toks[k], 'and') && !isId(toks[k], 'or')) return false;
      k++;
      if (toks[k]?.g === undefined) return false;
      k++;
    }
    return true;
  };
  if (toks[0]?.id !== undefined && toks[0].id !== 'not') {
    if (toks[0].id === 'only') k++;
    if (toks[k]?.id === undefined || ['and', 'or', 'not', 'only'].includes(toks[k].id)) return null;
    k++;
    if (k === toks.length) return norm;
    if (!isId(toks[k], 'and')) return null;
    k++;
    return condition() ? norm : null;
  }
  if (isId(toks[0], 'not') && toks[1]?.id !== undefined) {
    k = 1;
    if (['and', 'or', 'not', 'only'].includes(toks[k].id)) return null;
    k++;
    if (k === toks.length) return norm;
    if (!isId(toks[k], 'and')) return null;
    k++;
    return condition() ? norm : null;
  }
  return condition() ? norm : null;
}

/** A media list text as jsdom's MediaList stores it: each medium normalized, invalid ones `not all`. */
function mediaItems(text) {
  if (text === '') return [];
  return text.split(',').map((p) => parseMedium(p) ?? 'not all');
}

/** jsdom `evaluateMediaList`. */
function evaluateMedia(items) {
  return items.length === 0 || items.some((q) => q === 'all' || q === 'screen');
}

// ------------------------------------------------------------------------------------------ install

function install(rt, dom) {
  const { wrap } = dom;
  const C = rt.classes;

  /** wrapper -> { g: env generation, s: sheet id, r: rule handle, ... } */
  const INT = new WeakMap();
  /** sheet id -> CSSStyleSheet wrapper (this env) */
  let SHEETS = new Map();
  rt.onReset(() => {
    SHEETS = new Map();
  });

  /** Internal state of a CSSOM wrapper (TypeError for anything else). */
  function st(x) {
    const s = INT.get(x);
    if (s === undefined) throw new TypeError('Illegal invocation');
    return s;
  }
  /** Sheet id of a wrapper's state (0 once its env is gone). */
  const sid = (s) => (alive(s.g) ? s.s : 0);

  // ---------------------------------------------------------------------------------------- MediaList

  class MediaList {
    constructor(t = undefined) {
      if (t !== TOKEN) throw new TypeError('Illegal constructor');
    }

    _items() {
      const s = st(this);
      return mediaItems(N.omStr(sid(s), s.r, s.f));
    }

    _write(items) {
      const s = st(this);
      N.omSetStr(sid(s), s.r, s.f, items.join(', '));
    }

    get mediaText() {
      return this._items().join(', ');
    }

    set mediaText(v) {
      this._write(mediaItems(v === null ? '' : String(v)));
    }

    get length() {
      const n = this._items().length;
      if (n > IDX.ml) IDX.ml = installIndices(MediaList.prototype, IDX.ml, n);
      return n;
    }

    _get(i) {
      return this._items()[i];
    }

    item(index) {
      return this._items()[index >>> 0] ?? null;
    }

    appendMedium(medium) {
      if (arguments.length === 0) throw argRequired('appendMedium', 'MediaList');
      const m = parseMedium(String(medium)) ?? 'not all';
      const items = this._items();
      const c = canonicalMedium(m);
      if (items.some((x) => canonicalMedium(x) === c)) return;
      items.push(m);
      this._write(items);
    }

    deleteMedium(medium) {
      if (arguments.length === 0) throw argRequired('deleteMedium', 'MediaList');
      const c = canonicalMedium(parseMedium(String(medium)) ?? 'not all');
      const items = this._items();
      const kept = items.filter((x) => canonicalMedium(x) !== c);
      if (kept.length === items.length) throw rt.domError(2, `"${medium}" was not found in the media list.`);
      this._write(kept);
    }

    toString() {
      return this.mediaText;
    }

    *[Symbol.iterator]() {
      yield* this._items();
    }
  }

  /** A MediaList over string field `f` of rule `r` (0 + FMEDIA: the sheet's own media). */
  function mediaList(s, r, f) {
    const m = new MediaList(TOKEN);
    INT.set(m, { g: s.g, s: s.s, r, f });
    return m;
  }

  const IDX = { ml: 0, rl: 0, sl: 0, kf: 0 };
  IDX.ml = installIndices(MediaList.prototype, 0, 16);

  // ---------------------------------------------------------------------------------------- CSSRuleList

  class CSSRuleList {
    constructor(t = undefined) {
      if (t !== TOKEN) throw new TypeError('Illegal constructor');
    }

    _handles() {
      const s = st(this);
      const id = sid(s);
      if (id === 0) return [];
      return Array.from(outIds(N.omRules(id, s.r)));
    }

    get length() {
      const n = this._handles().length;
      if (n > IDX.rl) IDX.rl = installIndices(CSSRuleList.prototype, IDX.rl, n);
      return n;
    }

    _get(i) {
      const h = this._handles()[i];
      return h === undefined ? undefined : ruleWrapper(st(this), h);
    }

    item(index) {
      return this._get(index >>> 0) ?? null;
    }

    *[Symbol.iterator]() {
      const s = st(this);
      for (const h of this._handles()) yield ruleWrapper(s, h);
    }
  }
  IDX.rl = installIndices(CSSRuleList.prototype, 0, 32);

  /** The (SameObject) rule list of a sheet or rule state. */
  function ruleList(s) {
    if (s.list === undefined) {
      const l = new CSSRuleList(TOKEN);
      INT.set(l, { g: s.g, s: s.s, r: s.r ?? 0, sheet: s.sheet ?? s });
      s.list = l;
    }
    return s.list;
  }

  // ---------------------------------------------------------------------------------------- sheets

  let constructing = 0;

  class StyleSheet {
    constructor(t = undefined) {
      if (t !== TOKEN && constructing === 0) throw new TypeError('Illegal constructor');
    }

    get type() {
      st(this);
      return 'text/css';
    }

    get href() {
      st(this);
      return null;
    }

    get ownerNode() {
      const s = st(this);
      const id = sid(s);
      return id === 0 || s.ownerRule ? null : wrap(N.omOwner(id));
    }

    get parentStyleSheet() {
      const s = st(this);
      return s.ownerRule ? s.ownerRule.parentStyleSheet : null;
    }

    get title() {
      const s = st(this);
      return s.title ?? null;
    }

    get media() {
      const s = st(this);
      return s.media ?? (s.media = mediaList(s, 0, FMEDIA));
    }

    set media(v) {
      this.media.mediaText = v;
    }

    get disabled() {
      const s = st(this);
      return N.omFlag(sid(s), 0);
    }

    set disabled(v) {
      const s = st(this);
      N.omSetDisabled(sid(s), !!v);
    }
  }

  class CSSStyleSheet extends StyleSheet {
    constructor(options = undefined) {
      if (constructing !== 0) {
        super(TOKEN);
        INT.set(this, { g: envGen(), s: constructing, rules: [], w: this });
        return;
      }
      super(TOKEN);
      if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'function') {
        throw new TypeError("Failed to construct 'CSSStyleSheet': The provided value is not of type 'CSSStyleSheetInit'.");
      }
      const o = options ?? {};
      let media = o.media ?? '';
      if (media instanceof MediaList) media = media.mediaText;
      const items = mediaItems(String(media));
      const id = N.omCreate(items.join(', '), !!o.disabled, true);
      const s = { g: envGen(), s: id, rules: [], w: this };
      INT.set(this, s);
      SHEETS.set(id, this);
    }

    get ownerRule() {
      return st(this).ownerRule ?? null;
    }

    get cssRules() {
      return ruleList(st(this));
    }

    get rules() {
      return this.cssRules;
    }

    insertRule(rule, index = 0) {
      const s = st(this);
      if (arguments.length === 0) throw new TypeError("Failed to execute 'insertRule' on 'CSSStyleSheet': 1 argument required, but only 0 present.");
      if (s.busy) throw notAllowed('The stylesheet is currently being modified.');
      const i = Number(index) >>> 0;
      check(N.omInsert(sid(s), 0, String(rule), i));
      return i;
    }

    deleteRule(index) {
      const s = st(this);
      if (arguments.length === 0) throw new TypeError("Failed to execute 'deleteRule' on 'CSSStyleSheet': 1 argument required, but only 0 present.");
      if (s.busy) throw notAllowed('The stylesheet is currently being modified.');
      check(N.omDelete(sid(s), 0, Number(index) >>> 0));
    }

    addRule(selector = 'undefined', style = 'undefined', index = undefined) {
      const i = index === undefined ? this.cssRules.length : index;
      this.insertRule(`${selector} { ${style} }`, i);
      return -1;
    }

    removeRule(index = 0) {
      this.deleteRule(index);
    }

    replaceSync(text) {
      const s = st(this);
      if (!N.omFlag(sid(s), 1)) throw notAllowed('Cannot call replaceSync on non-constructed CSSStyleSheet.');
      if (s.busy) throw notAllowed('The stylesheet is currently being modified.');
      N.omReplace(sid(s), String(text).toWellFormed());
    }

    replace(text) {
      const s = st(this);
      if (!N.omFlag(sid(s), 1)) return Promise.reject(notAllowed('Cannot call replace on non-constructed CSSStyleSheet.'));
      if (s.busy) return Promise.reject(notAllowed('The stylesheet is currently being modified.'));
      s.busy = true;
      const t = String(text).toWellFormed();
      return new Promise((resolve) => {
        queueMicrotask(() => {
          N.omReplace(sid(s), t);
          s.busy = false;
          resolve(this);
        });
      });
    }
  }

  function notAllowed(msg) {
    const D = rt.domError(1).constructor;
    return new D(msg, 'NotAllowedError');
  }

  /** The CSSStyleSheet wrapper of sheet id `id` (cached; null for 0). */
  function sheetWrapper(id, init) {
    if (id === 0) return null;
    let w = SHEETS.get(id);
    if (w === undefined) {
      constructing = id;
      try {
        w = new CSSStyleSheet();
      } finally {
        constructing = 0;
      }
      if (init !== undefined) Object.assign(st(w), init);
      SHEETS.set(id, w);
    }
    return w;
  }

  // ---------------------------------------------------------------------------------------- rules

  class CSSRule {
    constructor(t = undefined) {
      if (t !== TOKEN) throw new TypeError('Illegal constructor');
    }

    get cssText() {
      return this._text();
    }

    set cssText(_) {
      // per spec, setting cssText does nothing
    }

    _text() {
      return '';
    }

    get parentRule() {
      const s = st(this);
      const p = N.omParent(sid(s), s.r);
      return p === 0 ? null : ruleWrapper(s.sheet, p);
    }

    get parentStyleSheet() {
      const s = st(this);
      return N.omAttached(sid(s), s.r) ? s.sheet.w : null;
    }

    get type() {
      const k = N.omKind(sid(st(this)), st(this).r);
      return k < 20 ? k : 0;
    }

    _str(f) {
      const s = st(this);
      return N.omStr(sid(s), s.r, f);
    }

    _has(f) {
      const s = st(this);
      return N.omHas(sid(s), s.r, f);
    }

    _set(f, v) {
      const s = st(this);
      N.omSetStr(sid(s), s.r, f, v);
    }
  }
  const RULE_CONSTANTS = {
    STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4, FONT_FACE_RULE: 5, PAGE_RULE: 6,
    KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, MARGIN_RULE: 9, NAMESPACE_RULE: 10, COUNTER_STYLE_RULE: 11,
    SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14,
  };
  for (const [k, v] of Object.entries(RULE_CONSTANTS)) {
    Object.defineProperty(CSSRule, k, { value: v, enumerable: true });
    Object.defineProperty(CSSRule.prototype, k, { value: v, enumerable: true });
  }

  /** jsdom CSSGroupingRule-impl.js `serializeGroupingRuleBody`. */
  function groupBody(rule) {
    let body = '{\n';
    for (const r of rule.cssRules) {
      const t = r.cssText;
      if (t) body += `  ${t}\n`;
    }
    return body + '}';
  }

  class CSSGroupingRule extends CSSRule {
    get cssRules() {
      return ruleList(st(this));
    }

    insertRule(rule, index = 0) {
      const s = st(this);
      if (arguments.length === 0) throw new TypeError("Failed to execute 'insertRule' on 'CSSGroupingRule': 1 argument required, but only 0 present.");
      const i = Number(index) >>> 0;
      check(N.omInsert(sid(s), s.r, String(rule), i));
      return i;
    }

    deleteRule(index) {
      const s = st(this);
      if (arguments.length === 0) throw new TypeError("Failed to execute 'deleteRule' on 'CSSGroupingRule': 1 argument required, but only 0 present.");
      check(N.omDelete(sid(s), s.r, Number(index) >>> 0));
    }
  }

  class CSSConditionRule extends CSSGroupingRule {
    get conditionText() {
      return this._str(FA);
    }
  }

  class CSSMediaRule extends CSSConditionRule {
    get media() {
      const s = st(this);
      return s.media ?? (s.media = mediaList(s, s.r, FA));
    }

    set media(v) {
      this.media.mediaText = v;
    }

    get matches() {
      return evaluateMedia(this.media._items());
    }

    get conditionText() {
      return this.media.mediaText;
    }

    _text() {
      return `@media ${this.media.mediaText} ${groupBody(this)}`;
    }
  }

  class CSSSupportsRule extends CSSConditionRule {
    get matches() {
      return supportsMatches(this._str(FA));
    }

    _text() {
      return `@supports ${this._str(FA)} ${groupBody(this)}`;
    }
  }

  class CSSContainerRule extends CSSConditionRule {
    get containerName() {
      return this._str(FA);
    }

    get containerQuery() {
      return this._str(FB);
    }

    get conditionText() {
      const n = this._str(FA);
      return n ? `${serializeCustomIdent(n, CONTAINER_NAME_EXCLUSIONS)} ${this._str(FB)}` : this._str(FB);
    }

    _text() {
      return `@container ${this.conditionText} ${groupBody(this)}`;
    }
  }

  class CSSLayerBlockRule extends CSSGroupingRule {
    get name() {
      return this._str(FA);
    }

    _text() {
      const n = this._str(FA);
      return `@layer${n ? ` ${n}` : ''} ${groupBody(this)}`;
    }
  }

  class CSSScopeRule extends CSSGroupingRule {
    get start() {
      return this._has(FC) ? this._str(FC) : null;
    }

    get end() {
      return this._has(FD) ? this._str(FD) : null;
    }

    _text() {
      let p = '';
      if (this.start) p += ` (${this.start})`;
      if (this.end) p += ` to (${this.end})`;
      return `@scope${p} ${groupBody(this)}`;
    }
  }

  /** `rule.style` (SameObject): a declaration block in Rust (lib/style.cjs, kind "rule"). */
  function ruleStyle(rule, properties) {
    const s = st(rule);
    return s.style ?? (s.style = rt.style.ruleStyle(rule, properties));
  }

  class CSSStyleRule extends CSSGroupingRule {
    get selectorText() {
      return this._str(FA);
    }

    set selectorText(v) {
      const s = st(this);
      const t = String(v);
      const nested = N.omParent(sid(s), s.r) !== 0 && isNested(s);
      if (t.trim() === '' || !N.omValidSelector(t, nested)) return;
      this._set(FA, t);
    }

    get style() {
      return ruleStyle(this, true);
    }

    set style(v) {
      this.style.cssText = v;
    }

    _text() {
      const sel = this.selectorText;
      const styleText = this.style.cssText;
      const rules = Array.from(this.cssRules);
      if (rules.length === 0) return styleText ? `${sel} { ${styleText} }` : `${sel} { }`;
      let body = styleText ? `\n  ${styleText}` : '';
      for (const r of rules) {
        const t = r.cssText;
        if (t) body += `\n  ${t}`;
      }
      return `${sel} {${body}\n}`;
    }
  }

  /** The rule (state `s`) is inside a style rule (CSS nesting context). */
  function isNested(s) {
    const id = sid(s);
    for (let p = N.omParent(id, s.r); p !== 0; p = N.omParent(id, p)) {
      if (N.omKind(id, p) === K.STYLE) return true;
    }
    return false;
  }

  class CSSNestedDeclarations extends CSSRule {
    get style() {
      return ruleStyle(this, true);
    }

    set style(v) {
      this.style.cssText = v;
    }

    _text() {
      return this.style.cssText;
    }
  }

  class CSSImportRule extends CSSRule {
    get href() {
      return this._str(FA);
    }

    get media() {
      const s = st(this);
      return s.media ?? (s.media = mediaList(s, s.r, FB));
    }

    set media(v) {
      this.media.mediaText = v;
    }

    get styleSheet() {
      const s = st(this);
      if (s.styleSheet === undefined) {
        const id = N.omCreate('', false, false);
        s.styleSheet = sheetWrapper(id, { ownerRule: this, media: this.media });
      }
      return s.styleSheet;
    }

    get layerName() {
      return this._has(FC) ? this._str(FC) : null;
    }

    get supportsText() {
      return this._has(FD) ? this._str(FD) : null;
    }

    _text() {
      let t = `@import url(${encodeString(this.href)})`;
      const layer = this.layerName;
      if (layer !== null) t += layer ? ` layer(${layer})` : ' layer';
      const sup = this.supportsText;
      if (sup !== null) t += ` supports(${sup})`;
      const m = this.media.mediaText;
      if (m) t += ` ${m}`;
      return t + ';';
    }
  }

  class CSSNamespaceRule extends CSSRule {
    get namespaceURI() {
      return this._str(FB);
    }

    get prefix() {
      return this._str(FA);
    }

    _text() {
      const url = `url(${encodeString(this.namespaceURI)})`;
      const p = this.prefix;
      return p ? `@namespace ${p} ${url};` : `@namespace ${url};`;
    }
  }

  class CSSFontFaceRule extends CSSRule {
    get style() {
      return ruleStyle(this, false);
    }

    _text() {
      return `@font-face { ${this.style.cssText} }`;
    }
  }

  class CSSPageRule extends CSSGroupingRule {
    get selectorText() {
      return this._str(FA);
    }

    set selectorText(v) {
      const p = parsePageSelector(String(v));
      if (p !== null) this._set(FA, p);
    }

    get style() {
      return ruleStyle(this, false);
    }

    set style(v) {
      this.style.cssText = v;
    }

    _text() {
      const sel = this.selectorText ? ` ${this.selectorText}` : '';
      const t = this.style.cssText;
      return t ? `@page${sel} { ${t} }` : `@page${sel} { }`;
    }
  }

  class CSSKeyframeRule extends CSSRule {
    get keyText() {
      return normalizeKeyText(this._str(FA));
    }

    set keyText(v) {
      const out = [];
      for (const sel of String(v).split(',').map((x) => x.trim())) {
        if (!validKeySelector(sel)) throw rt.domError(4, 'Invalid keyframe selector.');
        out.push(normalizeKeySelector(sel));
      }
      this._set(FA, out.join(', '));
    }

    get style() {
      return ruleStyle(this, true);
    }

    set style(v) {
      this.style.cssText = v;
    }

    _text() {
      return `${this.keyText} { ${this.style.cssText} }`;
    }
  }

  class CSSKeyframesRule extends CSSRule {
    get name() {
      return this._str(FA);
    }

    set name(v) {
      this._set(FA, String(v));
    }

    get cssRules() {
      return ruleList(st(this));
    }

    get length() {
      const n = this.cssRules.length;
      if (n > IDX.kf) IDX.kf = installIndices(CSSKeyframesRule.prototype, IDX.kf, n);
      return n;
    }

    _get(i) {
      return this.cssRules._get(i);
    }

    appendRule(rule) {
      const s = st(this);
      N.omAppendKeyframe(sid(s), s.r, String(rule));
    }

    _find(select) {
      const k = normalizeKeyText(String(select));
      const rules = Array.from(this.cssRules);
      for (let i = rules.length - 1; i >= 0; i--) if (rules[i].keyText === k) return i;
      return -1;
    }

    deleteRule(select) {
      const k = normalizeKeyText(String(select));
      const i = Array.from(this.cssRules).findIndex((r) => r.keyText === k);
      if (i !== -1) {
        const s = st(this);
        N.omDelete(sid(s), s.r, i);
      }
    }

    findRule(select) {
      const i = this._find(select);
      return i === -1 ? null : this.cssRules._get(i);
    }

    _text() {
      const rules = Array.from(this.cssRules, (r) => r.cssText).join(' ');
      return `@keyframes ${serializeCustomIdent(this.name, KEYFRAMES_EXCLUSIONS)} { ${rules} }`;
    }
  }
  IDX.kf = installIndices(CSSKeyframesRule.prototype, 0, 16);

  class CSSCounterStyleRule extends CSSRule {
    get name() {
      return this._str(FA);
    }

    set name(v) {
      this._set(FA, String(v));
    }

    _text() {
      const parts = [];
      for (const d of COUNTER_DESCRIPTORS) {
        if (this[d]) parts.push(`${d.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${this[d]};`);
      }
      return `@counter-style ${serializeCustomIdent(this.name, COUNTER_STYLE_EXCLUSIONS)} { ${parts.join(' ')} }`;
    }
  }

  class CSSLayerStatementRule extends CSSRule {
    get nameList() {
      const s = st(this);
      if (s.names === undefined) s.names = Object.freeze(this._str(FA).split(', ').filter(Boolean));
      return s.names;
    }

    _text() {
      return `@layer ${this.nameList.join(', ')};`;
    }
  }

  const CLASS_OF = new Map([
    [K.STYLE, CSSStyleRule], [K.IMPORT, CSSImportRule], [K.MEDIA, CSSMediaRule], [K.FONT_FACE, CSSFontFaceRule],
    [K.PAGE, CSSPageRule], [K.KEYFRAMES, CSSKeyframesRule], [K.KEYFRAME, CSSKeyframeRule],
    [K.NAMESPACE, CSSNamespaceRule], [K.COUNTER_STYLE, CSSCounterStyleRule], [K.SUPPORTS, CSSSupportsRule],
    [K.LAYER_BLOCK, CSSLayerBlockRule], [K.LAYER_STATEMENT, CSSLayerStatementRule], [K.CONTAINER, CSSContainerRule],
    [K.SCOPE, CSSScopeRule], [K.NESTED_DECLARATIONS, CSSNestedDeclarations],
  ]);

  /** The wrapper of rule handle `h` of the sheet of state `s` (cached per sheet). */
  function ruleWrapper(s, h) {
    const sheet = s.sheet ?? s;
    const cache = sheet.rules ?? (sheet.rules = []);
    let w = cache[h];
    if (w !== undefined) return w;
    const Cls = CLASS_OF.get(N.omKind(sid(sheet), h)) ?? CSSRule;
    w = new Cls(TOKEN);
    INT.set(w, { g: sheet.g, s: sheet.s, r: h, sheet });
    if (Cls === CSSCounterStyleRule) {
      for (const d of COUNTER_DESCRIPTORS) {
        w[d] = N.omDesc(sid(sheet), h, d.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
      }
    }
    cache[h] = w;
    return w;
  }

  // ---------------------------------------------------------------------------------------- StyleSheetList

  class StyleSheetList {
    constructor(t = undefined) {
      if (t !== TOKEN) throw new TypeError('Illegal constructor');
    }

    _ids() {
      const s = st(this);
      const doc = s.doc;
      if (doc._i === 0 || !alive(s.g) || doc.defaultView === null) return [];
      return Array.from(outIds(N.omDocSheets(doc._i)));
    }

    get length() {
      const n = this._ids().length;
      if (n > IDX.sl) IDX.sl = installIndices(StyleSheetList.prototype, IDX.sl, n);
      return n;
    }

    _get(i) {
      const id = this._ids()[i];
      return id === undefined ? undefined : sheetWrapper(id, sheetInit(id));
    }

    item(index) {
      return this._get(index >>> 0) ?? null;
    }

    *[Symbol.iterator]() {
      for (const id of this._ids()) yield sheetWrapper(id, sheetInit(id));
    }
  }
  IDX.sl = installIndices(StyleSheetList.prototype, 0, 16);

  /** State a `<style>` sheet's wrapper starts with: its title (jsdom reads the attribute at creation). */
  function sheetInit(id) {
    const owner = wrap(N.omOwner(id));
    return { title: owner?.getAttribute('title') || null };
  }

  const STYLE_SHEET_LISTS = new WeakMap();
  define(dom.Document, {
    get styleSheets() {
      let l = STYLE_SHEET_LISTS.get(this);
      if (l === undefined || !alive(INT.get(l).g)) {
        l = new StyleSheetList(TOKEN);
        INT.set(l, { g: envGen(), doc: this });
        STYLE_SHEET_LISTS.set(this, l);
      }
      return l;
    },
  });

  // ---------------------------------------------------------------------------------------- elements

  const Style = C.HTMLStyleElement;
  define(Style, {
    get sheet() {
      if (this._i === 0 || this.ownerDocument?.defaultView === null) return null;
      const id = N.omSheetOf(this._i);
      return id === 0 ? null : sheetWrapper(id, sheetInit(id));
    },
    get disabled() {
      return this.sheet?.disabled ?? false;
    },
    set disabled(v) {
      const s = this.sheet;
      if (s !== null) s.disabled = v;
    },
  });
  if (!Object.prototype.hasOwnProperty.call(Style.prototype, 'media')) dom.reflectString(Style, 'media');
  if (!Object.prototype.hasOwnProperty.call(Style.prototype, 'type')) dom.reflectString(Style, 'type');
  if (C.HTMLLinkElement !== undefined) {
    define(C.HTMLLinkElement, {
      get sheet() {
        return null;
      },
    });
  }

  // ---------------------------------------------------------------------------------------- registry

  const classes = {
    MediaList, CSSRuleList, StyleSheet, CSSStyleSheet, StyleSheetList, CSSRule, CSSGroupingRule, CSSConditionRule,
    CSSMediaRule, CSSSupportsRule, CSSContainerRule, CSSLayerBlockRule, CSSScopeRule, CSSStyleRule,
    CSSNestedDeclarations, CSSImportRule, CSSNamespaceRule, CSSFontFaceRule, CSSPageRule, CSSKeyframeRule,
    CSSKeyframesRule, CSSCounterStyleRule, CSSLayerStatementRule,
  };
  for (const [name, Cls] of Object.entries(classes)) {
    Object.defineProperty(Cls.prototype, Symbol.toStringTag, { value: name, configurable: true });
    rt.classes[name] = Cls;
  }
  Object.defineProperty(MediaList.prototype, 'toString', { enumerable: true });

  /** (sheet id, rule handle) of a rule wrapper, for lib/style.cjs's rule declarations (0, 0 once gone). */
  rt.cssom = {
    ref(rule) {
      const s = st(rule);
      return [sid(s), s.r];
    },
  };

  function supportsMatches(text) {
    // eslint-disable-next-line global-require
    return require('./window.cjs').supportsCondition(text);
  }
}

module.exports = { install, mediaItems, parseMedium, normalizeKeyText, parsePageSelector };
