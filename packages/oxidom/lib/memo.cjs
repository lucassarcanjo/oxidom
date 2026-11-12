'use strict';
// The facade memo protocol (DESIGN §20, CONTRIBUTING §5). JS never authors DOM state: it only memoises Rust
// answers, and every memo is validated by counters that Rust writes (invariant 2). This module owns what all
// memos share, so a call site only states what its memo depends on and how to recompute it:
//
// - The ablation switches (DESIGN §12): `MEMO` (OXIDOM_NO_MEMO=1 turns every memo off) and `PREFILTER`
//   (OXIDOM_NO_PREFILTER=1 turns the selector tag prefilter off). With a switch off, a memo recomputes on every
//   read; results must not change (test/native/memo.test.mjs).
// - Per-node counters: the version words of a node record (`NODE.*`), read with `nodeVersion(id, word)`. A
//   memo stores the word it was filled at and is fresh while `MEMO && stored === nodeVersion(...)`. These sites
//   (getAttribute, character data, input value: the hottest reads, DESIGN §15.2) keep that one compare inline.
// - Epoch-page counters: `deps('TREE', 'ATTR', ...)` names a set of EP slots. `stamp()` copies their values,
//   plus the env generation, into a plain array; `fresh(stamp)` compares slot by slot (exact: no packing into
//   one number, which can collide). Slots are listed from always-needed to conditionally-needed, and
//   `fresh(stamp, n)` checks only the first `n` (the qSA memo needs TEXT / FORM / REC only for some
//   selectors). A stamp from an older env never validates, so a reset cannot resurrect a memo.
// - Env lifetime of objects that cache ids: `envGen()` when created, `alive(gen)` before use.

const rt = require('./runtime.cjs');

const { V, F, EPI, flags } = rt;

/** Memoisation on (OXIDOM_NO_MEMO=1 turns it off). Read once at load, like every ablation flag. */
const MEMO = flags.MEMO;
/** Selector tag prefilter on (OXIDOM_NO_PREFILTER=1 turns it off). */
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

/** Most epoch-page slots one `deps()` set can name (the qSA memo uses all of them). */
const MAX_DEPS = 5;

/**
 * A set of epoch-page slots a memo depends on (see the module comment). Stamps have a fixed layout,
 * `[slot 0 .. slot 4, env generation]`, and both methods are unrolled: the cold `querySelector` path fills
 * and checks a stamp per query, and a loop over the slots plus a growing array cost it ~60 ns (+20%) over
 * the hand-written compares this module replaced. Unused slots stamp EP[GEN] and are never checked.
 */
class Deps {
  constructor(slots) {
    /** number of slots */
    this.n = slots.length;
    /** EP indices, in stamp order (0 = EP[GEN] for unused positions) */
    this.s0 = slots[0];
    this.s1 = slots[1] ?? 0;
    this.s2 = slots[2] ?? 0;
    this.s3 = slots[3] ?? 0;
    this.s4 = slots[4] ?? 0;
  }

  /** Writes the current slot values and env generation into `s` (a fresh stamp when null) and returns it. */
  stamp(s = null) {
    const EP = V.EP;
    if (s === null) return [EP[this.s0], EP[this.s1], EP[this.s2], EP[this.s3], EP[this.s4], V.envGen];
    s[0] = EP[this.s0];
    s[1] = EP[this.s1];
    s[2] = EP[this.s2];
    s[3] = EP[this.s3];
    s[4] = EP[this.s4];
    s[5] = V.envGen;
    return s;
  }

  /** True when memoisation is on and the first `n` slots (default: all) still hold the values in `s`. */
  fresh(s, n = this.n) {
    if (!MEMO || s === null) return false;
    const EP = V.EP;
    return s[5] === V.envGen && s[0] === EP[this.s0]
      && (n < 2 || s[1] === EP[this.s1]) && (n < 3 || s[2] === EP[this.s2])
      && (n < 4 || s[3] === EP[this.s3]) && (n < 5 || s[4] === EP[this.s4]);
  }
}

/** Dependency set over the named epoch-page slots (`EPI` names: 'TREE', 'ATTR', 'TEXT', 'FORM', 'REC', ...). */
function deps(...names) {
  if (names.length === 0 || names.length > MAX_DEPS) {
    throw new Error(`oxidom: a memo depends on 1 to ${MAX_DEPS} epoch-page slots, not ${names.length}`);
  }
  return new Deps(names.map((name) => {
    const i = EPI[name];
    if (i === undefined) throw new Error(`oxidom: unknown epoch-page slot ${name}`);
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
