'use strict';
// The facade memo protocol (DESIGN §16, CONTRIBUTING §5). JS never authors DOM state: it only memoises Rust
// answers, and every memo is validated by counters that Rust writes (invariant 2). This module owns what all
// memos share, so a call site only states what its memo depends on and how to recompute it:
//
// - The ablation switches (DESIGN §12): `MEMO` (RSDOM_NO_MEMO=1 turns every memo off) and `PREFILTER`
//   (RSDOM_NO_PREFILTER=1 turns the selector tag prefilter off). With a switch off, a memo recomputes on every
//   read; results must not change (test/native/memo.test.mjs).
// - Per-node counters: the version words of a node record (`NODE.*`), read with `nodeVersion(id, word)`. A
//   memo stores the word it was filled at and is fresh while `MEMO && stored === nodeVersion(...)`. These sites
//   (getAttribute, character data, input value: the hottest reads, DESIGN §15.2) keep that one compare inline.
// - Epoch-page counters: `deps('TREE', 'ATTR', ...)` names a set of EP slots. `stamp()` copies their values,
//   plus the env generation, into a Uint32Array; `fresh(stamp)` compares slot by slot (exact: no packing into
//   one number, which can collide). Slots are listed from always-needed to conditionally-needed, and
//   `fresh(stamp, n)` checks only the first `n` (the qSA memo needs TEXT / FORM / REC only for some
//   selectors). A stamp from an older env never validates, so a reset cannot resurrect a memo.
// - Env lifetime of objects that cache ids: `envGen()` when created, `alive(gen)` before use.

const rt = require('./runtime.cjs');

const { V, F, EPI, flags } = rt;

/** Memoisation on (RSDOM_NO_MEMO=1 turns it off). Read once at load, like every ablation flag. */
const MEMO = flags.MEMO;
/** Selector tag prefilter on (RSDOM_NO_PREFILTER=1 turns it off). */
const PREFILTER = flags.PREFILTER;

/**
 * Version words of a node record (src/table.rs `NodeRec`), each rewritten by Rust on every change of what it
 * covers: ATTRS = the element's attributes (`attr_ver`), DATA = a character-data node's data (same word),
 * CHILDREN = the node's child list (`child_ver`), FORM = the control's value / selection / checkedness
 * (`form_ver`).
 */
const NODE = Object.freeze({ ATTRS: F.ATTR_VER, DATA: F.DATA_VER, CHILDREN: F.CHILD_VER, FORM: F.FORM_VER });

/** Current version word `word` (`NODE.*`) of node `id`: one table read, no crossing in shared mode. */
function nodeVersion(id, word) {
  return V.T[V.off(id) + word];
}

/** A set of epoch-page slots a memo depends on (see the module comment). */
class Deps {
  constructor(slots) {
    /** EP indices, in the order the stamp stores them */
    this.slots = Uint8Array.from(slots);
    /** number of slots; the stamp holds one more word: the env generation */
    this.n = slots.length;
  }

  /** Writes the current slot values and env generation into `s` (a fresh stamp when null) and returns it. */
  stamp(s = null) {
    const n = this.n;
    if (s === null) s = new Uint32Array(n + 1);
    const EP = V.EP;
    const slots = this.slots;
    for (let i = 0; i < n; i++) s[i] = EP[slots[i]];
    s[n] = V.envGen;
    return s;
  }

  /** True when memoisation is on and the first `n` slots (default: all) still hold the values in `s`. */
  fresh(s, n = this.n) {
    if (!MEMO || s === null || s[this.n] !== V.envGen) return false;
    const EP = V.EP;
    const slots = this.slots;
    for (let i = 0; i < n; i++) if (s[i] !== EP[slots[i]]) return false;
    return true;
  }
}

/** Dependency set over the named epoch-page slots (`EPI` names: 'TREE', 'ATTR', 'TEXT', 'FORM', 'REC', ...). */
function deps(...names) {
  return new Deps(names.map((name) => {
    const i = EPI[name];
    if (i === undefined) throw new Error(`rsdom: unknown epoch-page slot ${name}`);
    return i;
  }));
}

/** Generation of the current env (incremented by every `rt.reset()`). */
function envGen() {
  return V.envGen;
}

/** True while the env that was current at generation `gen` is still alive. */
function alive(gen) {
  return gen === V.envGen;
}

module.exports = { MEMO, PREFILTER, NODE, nodeVersion, deps, envGen, alive };
