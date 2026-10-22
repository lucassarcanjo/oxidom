'use strict';
// ShadowRoot and Element.attachShadow, without retargeting (DESIGN §22, ROADMAP Stage 1 `shadow-root`). A port of
// refs/jsdom/lib/jsdom/living/nodes/ShadowRoot-impl.js and the attachShadow / shadowRoot members of Element-impl.js.
//
// The tree state lives in Rust (src/shadow.rs): a shadow root is a fragment record with `M.SHADOW`, a host is an
// element record with the same bit, so `shadowRoot` costs one table read on elements that host nothing. Host and
// mode are cold reads (`shadowHost`, `shadowMode`). getRootNode({ composed }), the event path through hosts and
// the core `materialize` (ShadowRoot wrappers) read the same bit in dom.cjs / events.cjs.

const { N, V, F, M, K, TOKEN, checkId, afterAlloc, mutated, check, define } = require('./runtime.cjs');
const { envGen, alive } = require('./memo.cjs');
const { hitTesting } = require('./observers.cjs');

/** `ShadowRootMode` wire values (src/shadow.rs `mode`). */
const MODE_OPEN = 0;
const MODE_CLOSED = 1;
const MODE_NAMES = ['open', 'closed'];
const SHADOW_ROOT = K.FRAGMENT | M.SHADOW;

/**
 * Env generation of the last successful attachShadow (0 = none yet). Only attachShadow creates shadow roots and
 * nodes are never reclaimed inside an env, so while `alive(shadowGen)` the env may hold one; otherwise no node
 * is in a shadow tree and `document.activeElement` skips the retarget walk.
 */
let shadowGen = 0;

/** True if `id` is a shadow root (zero FFI). */
function isShadowRoot(id) {
  return (V.T[V.off(id) + F.META] & (M.KIND | M.SHADOW)) === SHADOW_ROOT;
}

/** Root of `id`'s tree (not shadow-including). */
function rootOf(id) {
  for (let p = V.T[V.off(id) + F.PARENT]; p > 0; p = V.T[V.off(id) + F.PARENT]) id = p;
  return id;
}

/** DOM "shadow-including inclusive ancestor". */
function isShadowIncludingInclusiveAncestor(anc, id) {
  while (id > 0) {
    if (id === anc) return true;
    const p = V.T[V.off(id) + F.PARENT];
    id = p > 0 ? p : isShadowRoot(id) ? N.shadowHost(id) : 0;
  }
  return false;
}

/** DOM "retarget" of node `a` against node `b` (ids). */
function retarget(a, b) {
  for (;;) {
    const root = rootOf(a);
    if (!isShadowRoot(root) || isShadowIncludingInclusiveAncestor(root, b)) return a;
    a = N.shadowHost(root);
  }
}

/** WebIDL `ShadowRootInit` (jsdom 30: `required ShadowRootMode mode` only). */
function shadowRootInit(init) {
  if (init === undefined || init === null || (typeof init !== 'object' && typeof init !== 'function')) {
    throw new TypeError("Failed to execute 'attachShadow' on 'Element': parameter 1 is not of type 'ShadowRootInit'.");
  }
  const v = init.mode;
  if (v === undefined) {
    throw new TypeError("Failed to execute 'attachShadow' on 'Element': required member mode is undefined.");
  }
  const s = `${v}`;
  const m = s === 'open' ? MODE_OPEN : s === 'closed' ? MODE_CLOSED : -1;
  if (m === -1) {
    throw new TypeError(`Failed to execute 'attachShadow' on 'Element': The provided value '${s}' is not a valid enum value of type ShadowRootMode.`);
  }
  return m;
}

function install(rt, dom) {
  const { DocumentFragment, Element, Document, wrap } = dom;

  class ShadowRoot extends DocumentFragment {
    constructor(t = undefined) {
      if (t !== TOKEN) throw new TypeError('Illegal constructor');
      super(t);
    }

    get mode() {
      return MODE_NAMES[N.shadowMode(this._i)];
    }

    get host() {
      return wrap(N.shadowHost(this._i));
    }

    get innerHTML() {
      return N.innerHTMLGet(this._i);
    }

    set innerHTML(v) {
      check(N.innerHTMLSet(this._i, v === null ? '' : String(v)));
      afterAlloc();
      mutated();
    }

    // DocumentOrShadowRoot (jsdom DocumentOrShadowRoot-impl.js): the document's focused element (or its body),
    // retargeted against this root, if that lands in this tree.
    get activeElement() {
      const doc = this.ownerDocument;
      const candidate = docActiveElement.call(doc);
      if (candidate === null) return null;
      const r = retarget(candidate._i, this._i);
      return rootOf(r) === this._i ? wrap(r) : null;
    }
  }
  Object.defineProperty(ShadowRoot.prototype, Symbol.toStringTag, { value: 'ShadowRoot', configurable: true });
  rt.classes.ShadowRoot = ShadowRoot;
  // DocumentOrShadowRoot hit testing (lib/observers.cjs, DESIGN §24): no boxes, so no hits.
  define(ShadowRoot, hitTesting('ShadowRoot'));

  define(Element, {
    attachShadow(init) {
      if (arguments.length < 1) {
        throw new TypeError("Failed to execute 'attachShadow' on 'Element': 1 argument required, but only 0 present.");
      }
      const mode = shadowRootInit(init);
      const id = checkId(N.attachShadow(this._i, mode), "Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow");
      afterAlloc();
      shadowGen = envGen();
      return wrap(id);
    },

    get shadowRoot() {
      const id = this._i;
      if ((V.T[V.off(id) + F.META] & M.SHADOW) === 0) return null;
      return wrap(N.shadowRootOf(id, true));
    },
  });

  // Document.activeElement retargets a focused element inside a shadow tree to its host (forms.cjs owns the
  // focus lookup; this only adds the retarget step, a parent walk with no FFI unless the element is in one).
  const docActiveElement = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get;
  define(Document, {
    get activeElement() {
      const a = docActiveElement.call(this);
      if (a === null || !alive(shadowGen)) return a;
      const id = a._i;
      return isShadowRoot(rootOf(id)) ? wrap(retarget(id, this._i)) : a;
    },
  });
}

/** True while the env may hold a shadow root (events.cjs takes the composed dispatch path then, DESIGN §42). */
function shadowsExist() {
  return alive(shadowGen);
}

module.exports = { install, isShadowRoot, retarget, rootOf, isShadowIncludingInclusiveAncestor, shadowsExist };
