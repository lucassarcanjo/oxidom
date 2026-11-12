'use strict';
// AREA C (MutationObserver, DESIGN §9, ROADMAP M6): MutationObserver / MutationRecord, microtask delivery,
// takeRecords, disconnect. Records are produced in Rust (src/mo.rs) by the mutation algorithms; this module
// only schedules delivery and turns the drained words into MutationRecord objects.
//
// Scheduling: `rt.mutated()` (the epilogue of every mutating facade method) calls our pending handler when
// EP[MO_PENDING] != 0; it queues ONE microtask per burst (DOM "queue a mutation observer microtask").
// Delivery (DOM "notify mutation observers"): observers in creation order (ids are assigned here in
// creation order); each `moTake(after, max)` crossing takes the queue of the next observer with records and
// removes the transient registrations of the observers it passed, exactly the spec's per-observer steps.
// Crossings per delivery: (observers with records) + 1.

const rt = require('./runtime.cjs');
const context = require('./context.cjs');
const { shadowsExist } = require('./shadow.cjs');

const { N, V, EPI, TOKEN } = rt;

/** Node's queueMicrotask, captured at load (Vitest never fakes it; user code cannot replace it under us). */
const enqueue = globalThis.queueMicrotask.bind(globalThis);

const TYPES = ['', 'attributes', 'characterData', 'childList'];
const O = { CHILD_LIST: 1, ATTRIBUTES: 2, CHAR_DATA: 4, SUBTREE: 8, ATTR_OLD: 16, CHAR_OLD: 32, FILTER: 64 };
const HEADER = 3;
const REC_WORDS = 12;

/** Next observer id (creation order). */
let nextId = 1;
/** id -> observer, for observers that may still receive records (registered, or records pending). */
const live = new Map();
let queued = false;
/** Diagnostics (tests / benches): delivery microtasks run and `moTake` crossings made. */
const stats = { ticks: 0, takes: 0, records: 0 };

let dom = null;

function illegal() {
  throw new TypeError('Illegal constructor');
}

// ===================================================================================== MutationRecord

/**
 * A record is a view over the drained words of its batch (`#w`, copied out of OUT once per delivery) at
 * record offset `#b`: construction is a few field writes; NodeLists, names and wrappers are built only when
 * read (DTL's waitFor never reads them). After an env reset the record reads as empty (no stale ids).
 */
class MutationRecord {
  #w;
  #b;
  #olds;
  #gen;
  #added = null;
  #removed = null;

  constructor(t = undefined, w, b, olds) {
    if (t !== TOKEN) illegal();
    this.#w = w;
    this.#b = b;
    this.#olds = olds;
    this.#gen = V.envGen;
  }

  #node(k) {
    return this.#gen === V.envGen ? rt.wrap(this.#w[this.#b + k]) : null;
  }

  #list(k) {
    const w = this.#w;
    const b = this.#b;
    const start = HEADER + w[2] * REC_WORDS + w[b + k];
    const ids = this.#gen === V.envGen ? w.subarray(start, start + w[b + k + 1]) : w.subarray(0, 0);
    return dom.staticNodeListFromIds(ids);
  }

  get type() {
    return TYPES[this.#w[this.#b] & 15];
  }

  get target() {
    return this.#node(1);
  }

  get addedNodes() {
    return this.#added ?? (this.#added = this.#list(2));
  }

  get removedNodes() {
    return this.#removed ?? (this.#removed = this.#list(4));
  }

  get previousSibling() {
    return this.#node(6);
  }

  get nextSibling() {
    return this.#node(7);
  }

  get attributeName() {
    const w = this.#w;
    return (w[this.#b] & 15) === 1 ? rt.atomName(w[this.#b + 8]) : null;
  }

  get attributeNamespace() {
    const a = this.#w[this.#b + 9];
    return a === 0 ? null : rt.atomName(a);
  }

  get oldValue() {
    const w = this.#w;
    const b = this.#b;
    return (w[b] & 16) !== 0 ? this.#olds.slice(w[b + 10], w[b + 10] + w[b + 11]) : null;
  }
}
Object.defineProperty(MutationRecord.prototype, Symbol.toStringTag, { value: 'MutationRecord', configurable: true });

/** Words of the last `moTake` / `moRecords` call (copied out of OUT before any other crossing). */
function readOut() {
  const n = V.EP[EPI.OUT_NEED] || V.OUT[0];
  return rt.outIds(n);
}

/** Builds the MutationRecords of one drained batch `w` (moTake/moRecords layout, src/mo.rs `mo_encode`). */
function decode(w, olds) {
  const cnt = w[2];
  const out = new Array(cnt);
  for (let i = 0; i < cnt; i++) out[i] = new MutationRecord(TOKEN, w, HEADER + i * REC_WORDS, olds);
  stats.records += cnt;
  return out;
}

// =================================================================================== MutationObserver

/** Invokes an observer's callback (set by the class's static block: it reads the private callback). */
let deliver = null;

/** WebIDL boolean dictionary member: undefined = absent. */
function opt(v) {
  return v === undefined ? undefined : !!v;
}

class MutationObserver {
  #id;
  #cb;
  /** the browsing context of the first observed node's document (where callback errors are reported) */
  #ctx = undefined;

  constructor(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to construct 'MutationObserver': parameter 1 is not of type 'Function'.");
    }
    this.#id = nextId++;
    this.#cb = callback;
  }

  observe(target, options = undefined) {
    const id = dom.nodeArg(target, 'observe', 'MutationObserver');
    this.#ctx ??= (target.ownerDocument ?? target)._ctx;
    if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'function') {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 2 is not of type 'MutationObserverInit'.");
    }
    const o = options ?? {};
    // WebIDL dictionary conversion order: members in lexicographic order.
    const attributeFilterRaw = o.attributeFilter;
    const attributeOldValue = opt(o.attributeOldValue);
    let attributes = opt(o.attributes);
    let characterData = opt(o.characterData);
    const characterDataOldValue = opt(o.characterDataOldValue);
    const childList = !!o.childList;
    const subtree = !!o.subtree;
    let filter;
    if (attributeFilterRaw !== undefined) {
      if (attributeFilterRaw === null || typeof attributeFilterRaw !== 'object' || typeof attributeFilterRaw[Symbol.iterator] !== 'function') {
        throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The provided value cannot be converted to a sequence.");
      }
      filter = Array.from(attributeFilterRaw, String);
    }
    if ((attributeOldValue !== undefined || filter !== undefined) && attributes === undefined) attributes = true;
    if (characterDataOldValue !== undefined && characterData === undefined) characterData = true;
    const fail = (msg) => new TypeError(`Failed to execute 'observe' on 'MutationObserver': ${msg}`);
    if (!childList && !attributes && !characterData) {
      throw fail("The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    }
    if (attributeOldValue && !attributes) {
      throw fail("The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
    }
    if (filter !== undefined && !attributes) {
      throw fail("The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
    }
    if (characterDataOldValue && !characterData) {
      throw fail("The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
    }
    let bits = 0;
    if (childList) bits |= O.CHILD_LIST;
    if (attributes) bits |= O.ATTRIBUTES;
    if (characterData) bits |= O.CHAR_DATA;
    if (subtree) bits |= O.SUBTREE;
    if (attributeOldValue) bits |= O.ATTR_OLD;
    if (characterDataOldValue) bits |= O.CHAR_OLD;
    let n = 0;
    if (filter !== undefined) {
      bits |= O.FILTER;
      const atoms = filter.map((s) => rt.internAtom(s));
      n = atoms.length;
      rt.writeOut(atoms);
    }
    rt.check(N.moObserve(this.#id, id, bits, n));
    live.set(this.#id, this);
  }

  disconnect() {
    N.moDisconnect(this.#id);
    live.delete(this.#id);
  }

  takeRecords() {
    const s = N.moRecords(this.#id);
    return decode(readOut(), s);
  }

  static {
    deliver = (mo, records) => {
      try {
        mo.#cb.call(mo, records, mo);
      } catch (err) {
        // "report the exception": the observed document's window (several `JSDOM` instances may be open), else
        // the current browsing context's window, else the process
        const c = mo.#ctx;
        if (c !== undefined && !c.closed) require('./events.cjs').reportException(c.window, err);
        else context.reportError(err);
      }
    };
  }
}
Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, { value: 'MutationObserver', configurable: true });

// ============================================================================================ delivery

function onPending() {
  if (!queued) {
    queued = true;
    enqueue(tick);
  }
}

/** DOM "notify mutation observers". */
function tick() {
  queued = false;
  stats.ticks++;
  // DOM "notify mutation observers" step 3: the signal slot list is taken before the callbacks run
  const ns = shadowsExist() ? N.slotTakeSignals() : 0;
  const signals = ns === 0 ? null : Array.from(rt.outIds(ns));
  const max = nextId - 1;
  let after = 0;
  for (;;) {
    const s = N.moTake(after, max);
    stats.takes++;
    const w = readOut();
    const obs = w[1];
    if (obs === 0) break;
    after = obs;
    const records = decode(w, s);
    const mo = live.get(obs);
    if (mo !== undefined && records.length !== 0) deliver(mo, records);
  }
  if (signals !== null) fireSlotChanges(signals);
}

/** Step 6: a trusted, bubbling `slotchange` at each signalled slot (src/slots.rs, DESIGN §42). */
function fireSlotChanges(slots) {
  const events = require('./events.cjs');
  for (const id of slots) {
    const slot = rt.wrap(id);
    if (slot !== null) events.fire(slot, 'slotchange', { bubbles: true });
  }
}

function install(_rt, d) {
  dom = d;
  rt.classes.MutationObserver = MutationObserver;
  rt.classes.MutationRecord = MutationRecord;
  rt.setMoPendingHandler(onPending);
  rt.onReset(() => {
    live.clear();
    nextId = 1;
    queued = false;
  });
}

module.exports = { install, MutationObserver, MutationRecord, stats };
