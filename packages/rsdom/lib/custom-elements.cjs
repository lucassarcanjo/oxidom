'use strict';
// Custom elements (ROADMAP Stage 4 `custom-elements`, DESIGN §43): CustomElementRegistry, the HTML element
// constructors' [HTMLConstructor] steps, synchronous construction in createElement, upgrades, and the reaction
// runner. A port of refs/jsdom/lib/jsdom/living/custom-elements/CustomElementRegistry-impl.js,
// helpers/custom-elements.js and helpers/html-constructor.js.
//
// Element states, definitions' callback bits and observed attributes, and the reaction queue live in Rust
// (src/ce.rs): the mutation algorithms enqueue reactions there and set bit 2 of EP[MO_PENDING], so the
// `mutated()` epilogue of the mutating facade method drains them here ([CEReactions] post-steps).

const rt = require('./runtime.cjs');
const interfaces = require('./generated/interfaces.cjs');
const { envGen, alive } = require('./memo.cjs');

const { N, V, F, M, K, EPI, TOKEN, afterAlloc, mutated, atomName } = rt;

/** Lifecycle callback bits and the upgrade reaction kind (src/ce.rs `cb`). */
const CB = { connectedCallback: 1, disconnectedCallback: 2, adoptedCallback: 4, attributeChangedCallback: 8 };
const CB_NAMES = Object.keys(CB);
const UPGRADE = 16;
/** crate::script's reaction kinds on the same queue (DESIGN §45): handled by lib/scripts.cjs */
const SCRIPT = 64;
const HANDLER = 128;
/** Frame reactions (crate::ce `cb::FRAME*`, DESIGN §46): connected, `src` changed, removed. */
const FRAME = 256;
const FRAME_SRC = 512;
const FRAME_REMOVED = 1024;
/** Definition flag next to the callback bits (src/ce.rs `cb::FORM_ASSOCIATED`): form-associated, so labelable. */
const FORM_ASSOCIATED = 32;
/** Custom element states (src/ce.rs `state`). */
const ST = { UNCUSTOMIZED: 0, UNDEFINED: 1, FAILED: 2, PRECUSTOMIZED: 3, CUSTOM: 4 };
const ALREADY_CONSTRUCTED = Symbol('already-constructed-marker');
const NULL_LEN = 0xffffffff;

let dom = null;
/** Definition id -> definition. */
const byId = [];
/** Constructor -> definition (the latest one: every window shares the interface classes). */
const byCtor = new Map();
let nextReg = 1;
/** Element id -> its reactions not yet invoked (jsdom's per-element `_ceReactionQueue`). */
const pendingOf = new Map();
/** Element id -> its ElementInternals (HTML "attached internals"). */
const internalsOf = new Map();
/** Shadow root ids attached while their host was precustomized or custom (jsdom `_availableToElementInternals`). */
const internalsShadows = new Set();

function illegal() {
  throw new TypeError('Illegal constructor');
}

const RESERVED = new Set(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph']);
// PCENChar (is-potential-custom-element-name, which jsdom uses)
const PCEN = /^[a-z][-.0-9_a-z·À-ÖØ-öø-ͽͿ-῿‌‍‿⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}]*$/u;
/** HTML "valid custom element name". */
function isValidCustomElementName(name) {
  return name.includes('-') && PCEN.test(name) && !RESERVED.has(name);
}

/** The HTML element interface name for `localName` (jsdom `getHTMLElementInterface`). */
const IFACE_OF = new Map();
for (const [iface, tags] of Object.entries(interfaces.html)) for (const t of tags) IFACE_OF.set(t, iface);
for (const t of interfaces.plainHtml) IFACE_OF.set(t, 'HTMLElement');
function htmlInterfaceName(localName) {
  return IFACE_OF.get(localName) ?? (isValidCustomElementName(localName) ? 'HTMLElement' : 'HTMLUnknownElement');
}

/** WebIDL `sequence<DOMString>` from an iterable (jsdom `convertToSequenceDOMString`). */
function stringSequence(obj) {
  if (!obj || !obj[Symbol.iterator]) throw new TypeError('Invalid Sequence');
  return Array.from(obj, (v) => {
    if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return String(v);
  });
}

/** True if `value` can be called with `new` (jsdom's Proxy probe). */
function isConstructor(value) {
  if (typeof value !== 'function') return false;
  try {
    // eslint-disable-next-line no-new
    new new Proxy(value, { construct: () => ({}) })();
    return true;
  } catch {
    return false;
  }
}

/** The window of node `id`'s document, for error reporting (the current one for a window-less document). */
function windowOf(id) {
  const doc = rt.wrap(V.T[V.off(id) + F.OWNER]);
  const ctx = doc?._ctx;
  return ctx !== undefined ? ctx.window : require('./context.cjs').current()?.window;
}

function report(id, err) {
  const win = windowOf(id);
  if (win !== undefined) require('./events.cjs').reportException(win, err);
  else throw err;
}

// ========================================================================================== registry

class CustomElementRegistry {
  #ctx;
  #reg;
  /** env generation of `#reg`: a registry kept past `rt.reset()` must not define into the next env's registry */
  #gen;
  /** name -> definition */
  #defs = new Map();
  #running = false;
  /** name -> { promise, resolve } */
  #when = new Map();

  constructor(t = undefined, ctx = undefined) {
    if (t !== TOKEN) illegal();
    this.#ctx = ctx;
    this.#gen = envGen();
    this.#reg = nextReg++;
    N.ceBindDoc(ctx.document._i, this.#reg);
  }

  /** HTML "look up a custom element definition" in this registry. */
  _lookup(localName, isValue) {
    const a = this.#defs.get(localName);
    if (a !== undefined && a.localName === localName) return a;
    if (isValue === null || isValue === undefined) return null;
    const d = this.#defs.get(isValue);
    return d !== undefined && d.localName === localName ? d : null;
  }

  define(name, constructor, options = undefined) {
    if (arguments.length < 2) {
      throw new TypeError(`Failed to execute 'define' on 'CustomElementRegistry': 2 arguments required, but only ${arguments.length} present.`);
    }
    name = String(name);
    if (typeof constructor !== 'function') {
      throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': parameter 2 is not of type 'Function'.");
    }
    if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'function') {
      throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': parameter 3 is not of type 'ElementDefinitionOptions'.");
    }
    const ext = options === undefined || options === null ? undefined : options.extends;
    const extendsOption = ext === undefined ? null : String(ext);
    if (!isConstructor(constructor)) throw new TypeError('Constructor argument is not a constructor.');
    if (!isValidCustomElementName(name)) {
      throw new rt.classes.DOMException('Name argument is not a valid custom element name.', 'SyntaxError');
    }
    if (!alive(this.#gen)) return; // the window is gone (a callback or timer outliving its test)
    if (this.#defs.has(name)) {
      throw new rt.classes.DOMException('This name has already been registered in the registry.', 'NotSupportedError');
    }
    for (const d of this.#defs.values()) {
      if (d.ctor === constructor) {
        throw new rt.classes.DOMException('This constructor has already been registered in the registry.', 'NotSupportedError');
      }
    }
    let localName = name;
    if (extendsOption !== null) {
      if (isValidCustomElementName(extendsOption)) {
        throw new rt.classes.DOMException("Option extends value can't be a valid custom element name.", 'NotSupportedError');
      }
      if (htmlInterfaceName(extendsOption) === 'HTMLUnknownElement') {
        throw new rt.classes.DOMException(`${extendsOption} is an HTMLUnknownElement.`, 'NotSupportedError');
      }
      localName = extendsOption;
    }
    if (this.#running) throw new rt.classes.DOMException('Invalid nested custom element definition.', 'NotSupportedError');
    this.#running = true;
    const callbacks = { connectedCallback: null, disconnectedCallback: null, adoptedCallback: null, attributeChangedCallback: null };
    let observed = [];
    let disabled = [];
    let formAssociated = false;
    try {
      const { prototype } = constructor;
      if (typeof prototype !== 'object') throw new TypeError('Invalid constructor prototype.');
      for (const k of CB_NAMES) {
        const v = prototype[k];
        if (v !== undefined) {
          if (typeof v !== 'function') throw new TypeError(`The lifecycle callback "${k}" is not a function.`);
          callbacks[k] = v;
        }
      }
      if (callbacks.attributeChangedCallback !== null) {
        const o = constructor.observedAttributes;
        if (o !== undefined) observed = stringSequence(o);
      }
      const df = constructor.disabledFeatures;
      if (df) disabled = stringSequence(df);
      formAssociated = Boolean(constructor.formAssociated);
    } finally {
      this.#running = false;
    }
    let mask = 0;
    for (const k of CB_NAMES) if (callbacks[k] !== null) mask |= CB[k];
    if (formAssociated) mask |= FORM_ASSOCIATED;
    const def = {
      name, localName, ctor: constructor, callbacks, observed, formAssociated, registry: this, ctx: this.#ctx,
      disableShadow: disabled.includes('shadow'), disableInternals: disabled.includes('internals'),
      stack: [], id: 0,
    };
    this.#defs.set(name, def);
    byCtor.set(constructor, def);
    // Rust registers it and enqueues the upgrade candidates (crate::ce `ce_define`)
    def.id = N.ceDefine(this.#reg, name, localName, mask, observed.join('\0'));
    byId[def.id] = def;
    afterAlloc();
    const w = this.#when.get(name);
    if (w !== undefined) {
      this.#when.delete(name);
      w.resolve(constructor);
    }
    mutated();
  }

  get(name) {
    return this.#defs.get(String(name))?.ctor;
  }

  getName(constructor) {
    if (typeof constructor !== 'function') {
      throw new TypeError("Failed to execute 'getName' on 'CustomElementRegistry': parameter 1 is not of type 'Function'.");
    }
    for (const d of this.#defs.values()) if (d.ctor === constructor) return d.name;
    return null;
  }

  whenDefined(name) {
    name = String(name);
    if (!isValidCustomElementName(name)) {
      return Promise.reject(new rt.classes.DOMException('Name argument is not a valid custom element name.', 'SyntaxError'));
    }
    const d = this.#defs.get(name);
    if (d !== undefined) return Promise.resolve(d.ctor);
    let w = this.#when.get(name);
    if (w === undefined) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      w = { promise, resolve };
      this.#when.set(name, w);
    }
    return w.promise;
  }

  upgrade(root) {
    if (!(root instanceof rt.classes.Node) || root._i === 0) {
      throw new TypeError("Failed to execute 'upgrade' on 'CustomElementRegistry': parameter 1 is not of type 'Node'.");
    }
    if (!alive(this.#gen)) return;
    N.ceUpgradeTree(root._i);
    mutated();
  }
}
Object.defineProperty(CustomElementRegistry.prototype, Symbol.toStringTag, { value: 'CustomElementRegistry', configurable: true });

/** The registry of browsing context `ctx` (window.customElements), created with its window. */
function registryFor(ctx) {
  ctx.ceRegistry = new CustomElementRegistry(TOKEN, ctx);
  return ctx.ceRegistry;
}

/** The definition for (`doc`, HTML, `localName`, `isValue`), or null (HTML "look up a custom element definition"). */
function lookup(doc, localName, isValue) {
  if (byId.length === 0) return null;
  const ctx = doc._ctx;
  if (ctx === undefined) return null;
  return ctx.ceRegistry?._lookup(localName, isValue) ?? null;
}

// ====================================================================================== construction

/** The rsdom interface class `C` extends (its name is the [HTMLConstructor]'s interface). */
function interfaceOf(C) {
  for (let p = C; p !== null && p !== undefined; p = Object.getPrototypeOf(p)) {
    if (INTERFACE_CLASSES.has(p)) return p;
  }
  return null;
}
let INTERFACE_CLASSES = new Set();

/** HTML [HTMLConstructor] steps for `newTarget` (jsdom helpers/html-constructor.js). */
function htmlConstructor(newTarget) {
  if (newTarget === undefined) throw new TypeError("Failed to construct 'HTMLElement': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
  const def = byCtor.get(newTarget);
  if (def === undefined || INTERFACE_CLASSES.has(newTarget)) illegal();
  const iface = interfaceOf(newTarget);
  const ifaceName = iface === null ? 'HTMLElement' : iface.name;
  let isValue = null;
  if (def.localName === def.name) {
    if (ifaceName !== 'HTMLElement') throw new TypeError('Invalid constructor, autonomous custom element should extend from HTMLElement');
  } else {
    if (htmlInterfaceName(def.localName) !== ifaceName) {
      throw new TypeError(`${def.localName} is not valid local name for ${ifaceName}`);
    }
    isValue = def.name;
  }
  let { prototype } = newTarget;
  if (prototype === null || typeof prototype !== 'object') prototype = rt.classes.HTMLElement.prototype;
  const { stack } = def;
  if (stack.length === 0) {
    const id = N.ceCreate(def.ctx.document._i, def.localName, def.id, isValue ?? '');
    afterAlloc();
    const el = rt.wrap(id);
    Object.setPrototypeOf(el, prototype);
    return el;
  }
  const top = stack[stack.length - 1];
  if (top === ALREADY_CONSTRUCTED) throw new TypeError('This instance is already constructed');
  const el = rt.wrap(top);
  Object.setPrototypeOf(el, prototype);
  stack[stack.length - 1] = ALREADY_CONSTRUCTED;
  return el;
}

/**
 * DOM "create an element" with the synchronous custom elements flag and a definition (createElement,
 * createElementNS): runs the constructor, or makes an undefined element and upgrades it for a customized
 * built-in. Returns the wrapper.
 */
function createSync(doc, def, localName, isValue, prefix = null) {
  const el = construct(doc, def, localName, isValue);
  // step 5.1.3.9 / 5.2.4: the prefix is set after the constructor returns
  if (prefix !== null) {
    N.ceSetPrefix(el._i, prefix);
    dom.dropNsx(el._i);
  }
  return el;
}

function construct(doc, def, localName, isValue) {
  if (def.name !== localName) {
    const id = rt.checkId(N.createElement(doc._i, rt.elementAtom(localName), 0));
    afterAlloc();
    N.ceSetIs(id, isValue);
    upgradeNow(def, id);
    return rt.wrap(id);
  }
  try {
    const el = Reflect.construct(def.ctor, []);
    const id = el instanceof rt.classes.Element ? el._i : 0;
    if (id === 0 || (V.T[V.off(id) + F.META] & M.NS_MASK) !== 0) {
      throw new TypeError('Internal error: Invalid custom element.');
    }
    const fail = (m) => {
      throw new rt.classes.DOMException(m, 'NotSupportedError');
    };
    if (N.attrCount(id) !== 0) fail('Unexpected attributes.');
    if (V.T[V.off(id) + F.FIRST] !== 0) fail('Unexpected child nodes.');
    if (V.T[V.off(id) + F.PARENT] !== 0) fail('Unexpected element parent.');
    if (V.T[V.off(id) + F.OWNER] !== doc._i) fail('Unexpected element owner document.');
    if (el.localName !== localName) fail('Unexpected element local name.');
    return el;
  } catch (err) {
    report(doc._i, err);
    const id = N.createElement(doc._i, rt.elementAtom(localName), 0);
    afterAlloc();
    N.ceSetState(id, ST.FAILED, 0);
    const w = rt.wrap(id);
    Object.setPrototypeOf(w, rt.classes.HTMLUnknownElement.prototype);
    return w;
  }
}

/** Runs an upgrade outside the reaction queue (synchronous customized built-ins), then its reactions. */
function upgradeNow(def, id) {
  pendingOf.set(id, [{ kind: UPGRADE, def }]);
  runElement(id);
}

/** HTML "upgrade an element" (jsdom `upgradeElement`); `queue` is the element's reaction queue. */
function upgradeElement(def, id, queue) {
  if (N.ceState(id) !== ST.UNDEFINED) return;
  N.ceSetState(id, ST.FAILED, def.id);
  if (def.callbacks.attributeChangedCallback !== null) {
    const el = rt.wrap(id);
    for (const a of Array.from(el.attributes)) {
      if (def.observed.includes(a.localName)) {
        queue.push({ kind: CB.attributeChangedCallback, args: [a.localName, null, a.value, a.namespaceURI] });
      }
    }
  }
  if ((V.T[V.off(id) + F.META] & M.CONNECTED) !== 0 && def.callbacks.connectedCallback !== null) {
    queue.push({ kind: CB.connectedCallback, args: [] });
  }
  def.stack.push(id);
  let error;
  let failed = false;
  try {
    if (def.disableShadow && (V.T[V.off(id) + F.META] & M.SHADOW) !== 0) {
      throw new rt.classes.DOMException("Can't upgrade a custom element with a shadow root if shadow is disabled", 'NotSupportedError');
    }
    N.ceSetState(id, ST.PRECUSTOMIZED, def.id);
    const r = Reflect.construct(def.ctor, []);
    if (r !== rt.wrap(id)) throw new TypeError('Invalid custom element constructor return value');
  } catch (e) {
    failed = true;
    error = e;
  }
  def.stack.pop();
  if (failed) {
    N.ceSetState(id, ST.FAILED, 0);
    queue.length = 0;
    throw error;
  }
  N.ceSetState(id, ST.CUSTOM, def.id);
}

// =================================================================================== ElementInternals

/**
 * ElementInternals (refs/jsdom/lib/jsdom/living/custom-elements/ElementInternals-impl.js): jsdom 30 implements
 * `shadowRoot`, `labels` and ARIAMixin, whose reflection goes to a per-element map instead of attributes.
 */
class ElementInternals {
  /** the target element's wrapper (its `_i` is 0 once its env is reset) */
  #el;
  /** ARIAMixin content attribute name -> value (jsdom `_internalContentAttributeMap`) */
  #aria = new Map();

  constructor(t = undefined, el = undefined) {
    if (t !== TOKEN) illegal();
    this.#el = el;
  }

  get shadowRoot() {
    const id = this.#el._i;
    if (id === 0 || (V.T[V.off(id) + F.META] & M.SHADOW) === 0) return null;
    const root = N.shadowRootOf(id, false);
    return internalsShadows.has(root) ? rt.wrap(root) : null;
  }

  get labels() {
    const id = this.#el._i;
    const def = id === 0 ? undefined : byId[N.ceDef(id)];
    if (def === undefined || !def.formAssociated) {
      throw new rt.classes.DOMException("Accesing an ElementInternal's labels property is only supported for form-associated custom elements", 'NotSupportedError');
    }
    const n = N.labels(id);
    return dom.staticNodeListFromIds(rt.outIds(n === 0xffffffff ? 0 : n));
  }

  static _aria(prop, attr) {
    Object.defineProperty(ElementInternals.prototype, prop, {
      get() {
        return this.#aria.get(attr) ?? null;
      },
      set(v) {
        if (v === null || v === undefined) this.#aria.delete(attr);
        else this.#aria.set(attr, String(v));
      },
      enumerable: true,
      configurable: true,
    });
  }
}
Object.defineProperty(ElementInternals.prototype, Symbol.toStringTag, { value: 'ElementInternals', configurable: true });
// ARIAMixin: the nullable-string ARIA reflections Element has (role and aria-*)
for (const [prop, attr, kind] of interfaces.reflect.Element) {
  if (kind === 'str?' && (attr === 'role' || attr.startsWith('aria-'))) ElementInternals._aria(prop, attr);
}
delete ElementInternals._aria;

/** HTMLElement.attachInternals() (jsdom HTMLElement-impl.js). */
function attachInternals() {
  if (!(this instanceof rt.classes.HTMLElement)) {
    throw new TypeError("'attachInternals' called on an object that is not a valid instance of HTMLElement.");
  }
  const id = this._i;
  const fail = (m) => {
    throw new rt.classes.DOMException(m, 'NotSupportedError');
  };
  if (N.ceIs(id) !== null) fail('Unable to attach ElementInternals to a customized built-in element.');
  const def = (V.T[V.off(id) + F.META] & M.NS_MASK) === 0 ? lookup(rt.wrap(V.T[V.off(id) + F.OWNER]), this.localName, null) : null;
  if (def === null) fail('Unable to attach ElementInternals to non-custom elements.');
  if (def.disableInternals) fail('ElementInternals is disabled by disabledFeature static field.');
  if (internalsOf.has(id)) fail('ElementInternals for the specified element was already attached.');
  const st = N.ceState(id);
  if (st !== ST.PRECUSTOMIZED && st !== ST.CUSTOM) {
    fail('The attachInternals() function cannot be called prior to the execution of the custom element constructor.');
  }
  const internals = new ElementInternals(TOKEN, this);
  internalsOf.set(id, internals);
  return internals;
}

/** HTML elements that may host a shadow root (DOM "valid shadow host name"). */
const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);

/** attachShadow step 3 (jsdom Element-impl.js): a definition with `disabledFeatures: ['shadow']` refuses. */
function shadowBefore(host) {
  const id = host._i;
  if (byId.length === 0 || (V.T[V.off(id) + F.META] & (M.KIND | M.NS_MASK)) !== K.ELEMENT) return;
  const name = host.localName;
  const custom = isValidCustomElementName(name);
  if (!custom && !SHADOW_HOSTS.has(name)) return; // the native refuses it with the host-name error
  const isValue = N.ceIs(id);
  if (!custom && isValue === null) return;
  const def = lookup(rt.wrap(V.T[V.off(id) + F.OWNER]), name, isValue);
  if (def !== null && def.disableShadow) {
    throw new rt.classes.DOMException('Shadow root cannot be create on a custom element with disabled shadow', 'NotSupportedError');
  }
}

/** A root attached while its host is precustomized or custom is available to the host's internals. */
function shadowAfter(host, root) {
  if (byId.length === 0) return;
  const st = N.ceState(host);
  if (st === ST.PRECUSTOMIZED || st === ST.CUSTOM) internalsShadows.add(root);
}

// ========================================================================================= reactions

const CALLBACK_OF = { [CB.connectedCallback]: 'connectedCallback', [CB.disconnectedCallback]: 'disconnectedCallback', [CB.adoptedCallback]: 'adoptedCallback', [CB.attributeChangedCallback]: 'attributeChangedCallback' };

/** Invokes element `id`'s queued reactions (one element of HTML "invoke custom element reactions"). */
function runElement(id) {
  const queue = pendingOf.get(id);
  if (queue === undefined) return;
  try {
    while (queue.length > 0) {
      const r = queue.shift();
      if (r.kind === UPGRADE) {
        upgradeElement(r.def, id, queue);
      } else if (r.kind === SCRIPT) {
        require('./scripts.cjs').postConnection(id);
      } else if (r.kind === HANDLER) {
        require('./scripts.cjs').handlerChanged(id, r.args[0]);
      } else if (r.kind === FRAME || r.kind === FRAME_SRC) {
        require('./frames.cjs').loadFrame(id, r.kind === FRAME);
      } else if (r.kind === FRAME_REMOVED) {
        require('./frames.cjs').removed(id);
      } else {
        const def = byId[N.ceDef(id)];
        const fn = def?.callbacks[CALLBACK_OF[r.kind]];
        if (typeof fn === 'function') fn.apply(rt.wrap(id), r.args);
      }
    }
  } catch (err) {
    report(id, err);
  }
  if (queue.length === 0 && pendingOf.get(id) === queue) pendingOf.delete(id);
}

/** Drains the Rust reaction queue (bit 2 of EP[MO_PENDING]) and invokes it: the [CEReactions] post-steps. */
function drain() {
  const s = N.ceTake();
  const total = V.EP[EPI.OUT_NEED] || V.OUT[0];
  const w = rt.outIds(total);
  const n = w[1];
  const order = new Set();
  for (let i = 0; i < n; i++) {
    const o = 2 + i * 8;
    const id = w[o];
    const kind = w[o + 1];
    let r;
    if (kind === UPGRADE) r = { kind, def: byId[w[o + 2]] };
    else if (kind === CB.attributeChangedCallback) {
      const str = (start, len) => (len === NULL_LEN ? null : s.slice(start, start + len));
      const ns = w[o + 3];
      r = { kind, args: [atomName(w[o + 2]), str(w[o + 4], w[o + 5]), str(w[o + 6], w[o + 7]), ns === 0 ? null : atomName(ns)] };
    } else if (kind === CB.adoptedCallback) r = { kind, args: [rt.wrap(w[o + 2]), rt.wrap(w[o + 3])] };
    else if (kind === HANDLER) r = { kind, args: [atomName(w[o + 2])] };
    else r = { kind, args: [] };
    let q = pendingOf.get(id);
    if (q === undefined) {
      q = [];
      pendingOf.set(id, q);
    }
    order.add(id);
    q.push(r);
  }
  for (const id of order) runElement(id);
}

function install(_rt, d) {
  dom = d;
  rt.classes.CustomElementRegistry = CustomElementRegistry;
  rt.classes.ElementInternals = ElementInternals;
  Object.defineProperty(rt.classes.HTMLElement.prototype, 'attachInternals', { value: attachInternals, writable: true, enumerable: true, configurable: true });
  const shadow = require('./shadow.cjs');
  shadow.ceHooks.before = shadowBefore;
  shadow.ceHooks.after = shadowAfter;
  INTERFACE_CLASSES = new Set(Object.values(rt.classes).filter((C) => typeof C === 'function'));
  rt.setCeHandler(drain);
  rt.onReset(() => {
    byId.length = 0;
    byCtor.clear();
    pendingOf.clear();
    internalsOf.clear();
    internalsShadows.clear();
    nextReg = 1;
  });
}

module.exports = { install, registryFor, lookup, htmlConstructor, createSync, isValidCustomElementName, ST };
