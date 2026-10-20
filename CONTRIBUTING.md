# Contributing to rsdom

rsdom is a DOM whose tree lives in Rust (an arena per napi_env) and is exposed to Node through raw
Node-API callbacks plus a read-only zero-copy node table. The goal is a drop-in replacement for jsdom in test
environments. The architecture is [`docs/DESIGN.md`](docs/DESIGN.md); what comes next is
[`docs/ROADMAP.md`](docs/ROADMAP.md).

**Paths in this file:** Rust paths (`src/`, `tests/`, `data/`, `build.rs`) are relative to `crates/rsdom/`; JS paths
(`lib/`, `test/`) are relative to `packages/rsdom/`. Everything else is relative to the repository root.

## 1. Setup, build, test

Requirements: Rust (stable, edition 2024, `rust-version` 1.85+) and Node.js 22+.

```bash
npm ci                    # installs every workspace (packages/*, e2e/react-app) into the root node_modules
npm run build             # release addon -> packages/rsdom/native/rsdom.<triple>.node (~45 s cold, fat LTO)
npm run build:debug       # debug addon (overflow checks + re-entrancy guard); same output path
npm run test:rust         # cargo test: Rust unit tests + proptest differential test (10k sequences)
npm run test:js           # vitest: test/contract (jsdom / happy-dom / rsdom parity) + test/native (rsdom only)
npm run test:fallback     # the same suite with RSDOM_SHARED=0 (crossing-getter fallback); must stay green
npm run test:e2e          # e2e/react-app: 90 React + Testing Library tests under `environment: 'rsdom'`
npm test                  # all of the above except the fallback run
npm run test:parity       # jsdom's own test suite on rsdom, against conformance/parity/expectations (~4 min;
                          # needs scripts/fetch-refs.sh --wpt)
npm run lint              # cargo clippy --all-targets -D warnings && cargo fmt --check
npm run check             # lint, npm test, test:fallback, test:parity, scoreboard freshness: run it before merging
npm run bench:m0          # M0 gates; bench/README.md lists every harness
```

- GitHub Actions is disabled for this repository, so nothing runs these checks automatically. Before merging, run
  `npm run check` (after `npm run build` and `scripts/fetch-refs.sh --wpt`). `.github/workflows/ci.yml` defines the
  same checks for when Actions is turned back on. It also checks that `conformance/parity/results/summary.md` is
  current: `--update` regenerates it, but after editing `conformance/parity/expectations/` by hand, run
  `node conformance/parity/report.mjs` and commit the result.
- The facade loads whatever addon is in `packages/rsdom/native/` (last build wins). `RSDOM_NATIVE=/abs/path.node`
  overrides.
- `RSDOM_CONTRACT_DOMS=rsdom,jsdom npm run test:js` restricts the DOMs; `PROPTEST_CASES=100000 cargo test --release
  --test prop_tree` for the long fuzz run.
- `e2e/react-app` also runs on the other DOMs: `npm run test:jsdom -w e2e/react-app` (or `test:happy-dom`).
- `e2e/libraries` (real-library smoke tests) has its own dependencies: `e2e/libraries/run.sh`.
- `refs/` (gitignored) holds upstream checkouts at the pinned versions: `scripts/fetch-refs.sh` (jsdom),
  `scripts/fetch-refs.sh --wpt` (also web-platform-tests at the commit jsdom pins) or `scripts/fetch-refs.sh --all`. Code comments cite paths in it (`refs/jsdom/lib/jsdom/living/...`).
  `scripts/gen-interfaces.mjs` and `conformance/*` read it; their outputs are committed.
- `lib/generated/` is gitignored and rewritten by every cargo build (atoms, interfaces, events, CSS property names,
  native.d.ts). After a merge, just rebuild; never hand-edit generated files. If you delete the directory, touch
  `build.rs` (cargo only reruns the build script when its inputs change).
- Commit messages: conventional (`feat(select): ...`, `fix(forms): ...`, `docs: ...`).

## 2. Code map

The lab built rsdom in three parallel areas; code comments still say "area A/B/C", and their resource
allocations below still hold.

| path | area | notes |
|---|---|---|
| `src/{lib,ffi,env,table,chunk,atoms,string,node,error,dom,tree,attrs,text,parse,serialize,hooks}.rs`, `build.rs` | foundation | the hot paths and the JS contract; keep changes small, isolated (append rather than reorder) and called out in the commit message |
| `lib/{runtime,dom,collections,native,index}.cjs` | foundation | extend through `install(rt, dom)` instead of editing |
| `src/select/**`, `src/style/**`, `lib/select.cjs`, `lib/style.cjs` | **A** selectors, inline style, getComputedStyle | |
| `src/forms/**`, `src/focus.rs`, `lib/events.cjs`, `lib/forms.cjs` | **B** events, forms, focus, labels, validity, classList, dataset | `src/forms/element_state.rs` is the one home of the HTML control predicates (disabled, input type, submit button, summary, validity) that selector matching, focus and the facade ask (DESIGN §19) |
| `src/mo.rs`, `lib/mo.cjs`, `lib/context.cjs`, `lib/window.cjs`, `lib/vitest-environment.mjs`, `bench/**` | **C** browsing contexts, window, globals, Vitest environment, MutationObserver, bench harness | |
| `src/shadow.rs`, `lib/shadow.cjs` | ShadowRoot and `attachShadow`, without retargeting (DESIGN §22) | a shadow root is a fragment record with `meta::SHADOW` (bit 20, also set on its host) and its host in `payload`; connect / disconnect / adopt walks are shadow-including, the id map holds document-tree elements only |
| `lib/xhr.cjs`, `lib/xhr-fetch.cjs` | XMLHttpRequest (DESIGN §21) | facade only; `xhr-fetch.cjs` (bodies, network, decoding) loads on the first `send()` and stays DOM-free: `node:*` built-ins only, never `runtime.cjs` |
| `lib/history.cjs` | session history (DESIGN §23) | facade only; one `SessionHistory` per browsing context (`ctx.history`), driven by `History` and `Location` in `window.cjs` |
| `data/atoms/NN-*.txt` | everyone | prefer a **new file** for a new feature (`40-select.txt`, `41-style.txt`, ...) over editing an existing one |
| `test/contract/<area>*.test.mjs`, `test/native/<area>*.test.mjs`, `bench/micro/<area>*.mjs` | the area | new files per feature |

Reserved bit/slot ranges (declare constants in your own module; add a one-line comment in `src/node.rs` /
`src/env.rs` only if you must publish them to JS). A new feature that needs one claims it here first:

| resource | A | B | C |
|---|---|---|---|
| `NodeRec.meta` free bits (16..31) | 16-19 (20: `meta::SHADOW`, DESIGN §22) | 21-25 | 26-31 |
| `NodeRec.state` (forms/focus layout is fixed by DESIGN §2.2) | - | all of `state` | - |
| `NodeRec.res[0..2]` (words 14-15) | `res[0]` (e.g. attribute bloom) | - | `res[1]` |
| epoch page slots 13-15 | 13 | 14 | 15 (bench counters) |
| wrapper fields | `_cs`, `_st` | `_ev`, `_vm` | - |

## 3. Adding a native function (Rust side)

Each module declares its own natives; **there is no central list**. build.rs scans `src/**/*.rs` for
`natives! {` blocks, generates the registry (`$OUT_DIR/natives.rs`) and `lib/generated/native.d.ts` from the
same headers, so Rust and JS cannot drift. A new file containing a `natives!` block is registered
automatically; its module must be reachable from the crate root with at least `pub(crate)` visibility
(e.g. `pub(crate) mod qsa;` in `src/select/mod.rs`).

```rust
natives! {
    /// querySelectorAll: matching ids in document order into OUT; returns the count.
    fn qsa(e, root: u32, sel: u32) -> u32 {
        e.qsa_into_out(root, sel)
    }
    /// Cold infrastructure only: `[env]` also binds the raw napi_env.
    fn bindSomething(e [env], buf: any) -> () {
        e.bind_something(env, buf)
    }
}
```

Rules (the macro enforces most of them; build.rs parses the header):
- The header `fn name(e, a: kind, ...) -> Ret {` is ONE line. The block ends with `}` alone at column 0.
- Argument kinds: `u32 i32 f64 bool str ostr buf any` (`str` -> `&str`, `ostr` -> `Option<&str>` for
  `string | null`, `buf` -> `(*mut u8, usize)` of an ArrayBuffer, `any` -> raw napi_value). The facade coerces
  user values (`String(v)`, `!!v`, `>>> 0`) BEFORE the call; Rust never coerces or calls into JS.
- Return types: `u32 i32 f64 bool () Code NodeId Atom &str &Str Option<&str> Option<&Str> Value TableBuf`.
  ASCII strings leave as latin1 automatically. **Never create JS objects or arrays.**
- Bodies are expressions: no `return` (it would exit the internal closure). Put logic in an `impl Env` method.
- Native names are unique crate-wide (build.rs panics on duplicates).
- Errors: mutators return `Code` (`code(result)`, 0 = ok, see `src/error.rs`); id-returning natives return
  `e.id_or_fail(result)` (0 + `EP[ERR]`). The facade throws `DOMException` (`rt.check` / `rt.checkId`).
- Multi-value results: fill `e.ids` (reused Vec) then `e.write_ids()`, or `e.write_out(&words)`; return the
  count. OUT has an overflow protocol (`pending` + `EP[OUT_NEED]`); JS must read with `rt.outIds(n)`.
  Multi-id inputs: JS `rt.writeOut(ids)`, Rust `e.out.read_vec(n)`.
- Strings out: build into `e.scratch` (`std::mem::take` / put back) and return `&e.scratch`.
- Ids from JS are untrusted: use `e.rec(id)` (returns the all-zero null record for bad ids), `e.elem(id)`,
  `e.char_data(id)`, `e.doc_data(id)` (Options), `e.require_doc(doc)?`, `e.table.contains(id)`. Never index
  unchecked. `e.rec_mut(id)` is only for ids you already validated (it panics otherwise -> JS Error).
- Node-allocating natives may grow the table (EP[GEN]); the facade must call `rt.afterAlloc()` after them.
  Mutation natives can allocate too (adopting a `<template>` creates the destination's template-contents
  document; convert-nodes-into-a-node creates a fragment before validating): `rt.mutated()` and the error
  paths of `rt.check()` / `rt.checkId()` remap, so every mutating facade method must still end with
  `rt.mutated()` and use `check`/`checkId` for errors.
- `unsafe` stays in `ffi.rs` / `table.rs` / `env.rs` (the FFI and shared-memory edge), each block with a
  `// SAFETY:` comment (clippy `undocumented_unsafe_blocks` is on). Area code should need none.
- A panic in a native becomes `Error('rsdom internal: ...')` in JS; debug builds also assert no re-entrancy.

## 4. Rust state and hook points (no tree.rs edits needed)

State slots that already exist for each area (fill in the structs in your module):

| where | type | owner |
|---|---|---|
| `Env.sel` | `select::SelectState` | A |
| `Env.style`, `DocData.style` | `style::StyleState`, `style::DocStyle` | A |
| `ElementExt.style`, `ElementExt.cs` (via `e.elem_mut(id)?.ext_mut()`) | `style::InlineStyle`, `style::CsMemo` | A |
| `Env.forms`, `ElementExt.form` | `forms::FormsState`, `forms::FormState` | B |
| `Env.focus`, `DocData.focused`, `state::FOCUSED`, `EP[FOCUS]` | `focus::FocusState` | B |
| `Env.mo`, `DocData.observers`, `meta::OBSERVED`, `EP[MO_PENDING]` | `mo::MoState` | C |
| `Env.traversal` (NodeIterator pointers, moved by `Env::remove`) | `traversal::TraversalState` | traversal (`lib/traversal.cjs`) |
| `Env.ranges` (live Range boundary points, moved by `insert` / `remove` and the text.rs edits) | `range::RangeState` | ranges (`lib/range.cjs`, DESIGN §25) |
| `Env.shadow`, `ElementExt.shadow`, `meta::SHADOW` | `shadow::ShadowState` (shadow root modes) | shadow (`lib/shadow.cjs`) |

Add per-element fields to `ElementExt` (boxed, allocated on demand), never to `ElementData` (kept small: fresh
memory per element is the dominant creation cost in this VM, ~2 µs per first-touched 4 KiB page).

Mutation paths call these hooks (see `src/hooks.rs`); implement the functions in YOUR module:

| hook (module fn) | called when |
|---|---|
| `style::on_node_connected` / `forms::on_node_connected` | for each inclusive descendant of a subtree that became connected |
| `focus::on_node_disconnected` (implemented: focus fixup) / `style::…` / `forms::…` | each inclusive descendant of a subtree that became disconnected |
| `style::on_children_changed` / `forms::on_children_changed` | DOM "children changed steps": after each insert or remove step on a parent (after `child_ver`/`EP[TREE]` bump). Replace-all runs them once per removed child and once for the insertion, as jsdom does (a `<select>` resets its selectedness at every option insertion and removal); a `FreshTree` runs them once per parent when it finishes |
| `style::on_attr_changed` / `forms::on_attr_changed` | after every attribute set/remove, incl. same-value sets (after `attr_ver`/`EP[ATTR]` bump); a same-value set of `class`/`id`/`style`/`type`/`hidden`/`open`/`popover` only calls `forms::on_attr_changed` and queues the MO record (`hook_attr_same_value`: no bump, no style hook) |
| `style::on_char_data_changed` / `forms::on_char_data_changed` | after Text/Comment/PI data changes (after `EP[TEXT]` bump and the node's `DATA_VER` update) |
| `forms::on_cloned` | cloning steps (`cloneNode`/`importNode`) per element |
| `mo::queue_child_list` / `queue_attribute` / `queue_char_data` | at the spec'd record points; they must return immediately when no observer is registered (`e.mo.nregs == 0`). `queue_char_data`'s `old` is only filled when `mo::active(target)` (replaceData skips the copy otherwise): keep `active` and the queue functions consistent |

`style::on_attr_changed` / `on_children_changed` currently bump `EP[STYLE]` with the DESIGN §8.2 default rules;
area A refines them. All child-list changes go through the child-list module in `src/tree.rs` (DESIGN §17): the
`insert` / `remove` primitives and the operations composed from them, and `FreshTree` for nodes created inside the
same native call (document creation, cloning). The parser links nodes raw, settles them with `hook_parsed`, then
runs ONE tree operation (`replace_all`, `replace_child`, `pre_insert`) or `FreshTree::take_linked` (documents), so
per-node hooks never fire for parsed nodes and the connected pass covers the new subtree. Do not link nodes into a
tree any other way.

Useful foundation APIs: `e.next_in_subtree(n, root)` (preorder walk), `e.children_vec(p)`,
`e.is_inclusive_ancestor`, `e.tree_order(a, b)`, `e.get_element_by_id(root, atom)`, `e.get_attr(el, atom)`,
`e.elem(el).classes`, `e.local(el)`, `e.ns_of(el)`, `e.is_html_elem(el, atom::INPUT)`, `e.text_content(id)`,
`e.intern(s)` (keeps `EP[ATOM_LEN]` in sync), `atom::*` constants (generated from `data/atoms`).

## 5. JS facade conventions

Each area file exports `install(rt, dom)`; `lib/index.cjs` calls them once in the order
select -> style -> forms -> events -> mo -> window -> xhr -> observers -> shadow, after the core classes exist.

- `rt` (`lib/runtime.cjs`): `N` (natives), `V` (hot holder: `V.T` table view, `V.EP`, `V.OUT`, `V.off(id)`),
  `F`/`M`/`S`/`K`/`EPI`/`NSC`/`NS` constants, `W` (id -> wrapper), `wrap(id)`, `field(id, F.X)`, `afterAlloc()`,
  `mutated()`, `outIds(n)`, `writeOut(ids)`, `check(code)`, `checkId(id)`, `domError(code, msg)`, atoms
  (`lookupAtom` (no intern, 0 = unknown), `internAtom`, `elementAtom`, `attrNameAtom`, `atomName`, `upperAtom`),
  `define(C, obj)` (copies getters/setters/methods non-enumerably onto `C.prototype`), `classes` (registry of
  every interface constructor; window.cjs exposes all of them), `flags` (`SHARED`, `MEMO`, `PREFILTER`),
  `onReset(fn)`, `setMoPendingHandler(fn)`, `setDOMException(ctor)`, `defaultDocument` (read-only: the
  current browsing context's document).
- Browsing contexts (`lib/context.cjs`, DESIGN §18): `context.open(options)` makes a window + document,
  `ctx.close()` tears it down (timers, error routing, restored globals), `rt.reset()` closes them all. Code
  that needs "the window" without a node to ask (constructors such as `new Text()`, plain EventTargets,
  callback error reporting) uses `context.currentDocument()` / `context.current()`; a document's window is
  `doc._ctx` (`ctx.window`, `ctx.wt`, `ctx.url`). Timers a window starts go through `ctx.setTimer` so
  `close()` cancels them.
- `dom` (`lib/dom.cjs` exports): every core class, `wrap`, `nodeArg(v, method)` (argument validation),
  `convertNodes`, `staticNodeListFromIds`, `isHtml(id, atom)`, `firstDescendant`, `attrLookup` / `attrSetAtom`,
  `reflectString` / `reflectBool` / `reflectLong` / `defineAccessor`, mixins `ParentNode`, `ChildNode`,
  `NonDocumentTypeChildNode`; collections: `require('./collections.cjs')` (`liveQueryCollection(src)` for
  getElementsBy*); memos: `require('./memo.cjs')` (below).
- New interfaces: plain classes; constructors that must not be user-constructible check `rt.TOKEN`; set
  `Symbol.toStringTag` and register in `rt.classes[name]` (exact `constructor.name` matters for pretty-format).
- Read node facts with zero FFI: `const o = rt.V.off(id); rt.V.T[o + rt.F.STATE]`. Never keep `V.T` in a
  variable across a native call (growth replaces it; fallback mode refreshes records lazily). Link walks
  test `c > 0` (not `c !== 0`), so a stale view ends the loop instead of spinning.
- Character data: record word 11 is `F.DATA_VER` (the `attr_ver` slot of elements), changed by every data
  change. CharacterData wrappers memoize `data` in `_at` keyed by `_ch` (they have no children/attributes).
- Never write `rt.W` directly (it is kept dense); use `rt.wrap(id)`. `rt.reset()` neuters every wrapper
  (`_i = 0`) and bumps the env generation; JS caches keyed by ids or dynamic atoms must be cleared in
  `rt.onReset`, and objects that cache ids record `memo.envGen()` and check `memo.alive(gen)` (the core
  collections do).
- Collections: live lists have NO own numeric properties (index getters live on the prototype, always
  current); static lists (`staticNodeListFromIds`) have own ones. Their internal state is `#private`
  (Vitest `toEqual` compares own entries). `liveQueryCollection({ deps, items })`: `deps` is a
  `memo.deps(...)` set, `items()` may return any iterable. `_sync()` still exists on every collection.
- Attr wrappers are cached per element by (namespace atom, local atom) in `el._at.map` (key `local` for no
  namespace, `"ns:local"` otherwise).
- `rt.define` gives WebIDL descriptors: public (non-`_`) names are enumerable, `_x` and symbols are not;
  `index.cjs` calls `rt.exposeMembers()` after all areas installed.
- Mutating facade methods end with `rt.mutated()`; node-allocating calls are followed by `rt.afterAlloc()`.
- Copy OUT results with `rt.outIds(n)` before ANY further native call (materializing a wrapper in fallback
  mode is itself a native call).
- Every JS memo goes through `lib/memo.cjs` (DESIGN §20): it is validated by Rust-written counters, per node
  (`nodeVersion(id, NODE.ATTRS | DATA | CHILDREN | FORM)`) or on the epoch page (`deps('TREE', 'ATTR', ...)`:
  `stamp()` / `fresh(stamp)` compare slot by slot; never pack counters into one number), and it is off when
  the module's `MEMO` (or `PREFILTER`) switch is. test/native/memo.test.mjs runs one scenario per memo kind
  with memos on and off: extend it with a new memo.
- Do not add per-instance fields in constructors (hidden-class stability); use the reserved wrapper fields
  (§2 table) or a side `Map`/`WeakMap`.

## 6. Tests

- Contract tests (`test/contract/*.test.mjs`) run every assertion on jsdom, happy-dom and rsdom through
  `makeWindow(kind)` (`test/contract/adapter.cjs`); `createWindow()` does not install globals.
- jsdom is the oracle. Where happy-dom diverges, pin the assertion:
  `if (kind !== 'happy-dom') expect(...) // PINNED to jsdom: <reason>`.
- rsdom-only checks (protocols, wrappers, epochs) go to `test/native/`. `test/native/workers.test.mjs` also
  runs `test/fixtures/pool-threads` (Vitest `pool: 'threads'`, one fresh worker thread per file) in a child
  process: loading the addon on a new thread after another exited must keep working.
- The parity suite (`conformance/parity`, `npm run test:parity`) runs jsdom's own test suite against rsdom: WPT
  files from the 67 of jsdom's 127 `to-run.yaml` DIRs relevant to a DOM environment (`INCLUDE` in
  `conformance/wpt/select.mjs`), jsdom's to-upstream WPT tests, its legacy mocha tests and its API tests, about
  2,600 files. `conformance/parity/expectations/*.yaml` lists what rsdom fails; anything else must pass, and a run
  also fails when a listed failure starts passing, so progress gets locked in. `--update` rewrites the
  expectations for the files that ran; commit that diff with the change that caused it. Nothing runs the suite
  automatically (§1): run it before merging. Its README has the workflow.
- Everything must pass with `RSDOM_SHARED=0` too. Rust logic gets unit tests next to the code; tree-shaped
  invariants can extend `tests/prop_tree.rs`.
- Known, asserted divergences: MathML elements are `MathMLElement` (spec) where jsdom/happy-dom use `Element`;
  html5ever implements the 2025 customizable-`<select>` parser rules (see `DIVERGENCES` in
  `test/contract/parse-serialize.test.mjs`); XMLHttpRequest fixes some jsdom bugs and inherits a few Node fetch
  behaviours ("spec-correct divergences" in `test/contract/xhr.test.mjs`, DESIGN §21); events are not retargeted
  across shadow boundaries until Stage 4 `shadow-dom` (`test/contract/shadow-root.test.mjs`, DESIGN §22).

## 7. Invariants (do not break)

1. Rust never calls into JS (no `napi_call_function`, no coercion, no property gets on user objects).
2. JS never authors DOM state; it only memoises Rust answers validated by Rust counters.
3. Rust is the only writer of the node table; ids read back from it are bounds-checked.
4. No mutable statics: all state hangs off the per-napi_env `Env` (worker threads are independent).
5. Wrapper identity: one wrapper per node id for the env's lifetime (`W[id]`); expandos must survive.
6. Node ids are monotonic and never reused within an env (`destroy()` / `rt.reset()` starts over, and
   neuters every wrapper of the old env first).
7. Table growth only inside natives that allocate nodes (creation, parsing, cloning, and mutations that adopt
   templates or build fragments), detaching the old ArrayBuffer before retiring the old block (released and
   mapped `PROT_NONE`); the facade remaps in `afterAlloc()`, `mutated()` and the `check` error paths.

If you must touch a foundation file, keep the change small, isolated (append rather than reorder) and
mention it in the commit message so the other areas can rebase easily.

## 8. Known limitations and deferred review items

Recorded after the foundation review (DESIGN §15.1); asserted where testable
(`test/contract/foundation-fixes.test.mjs`, "spec-correct divergences").

- **Lone surrogates / offsets inside surrogate pairs.** Strings are stored as UTF-8: lone surrogates become
  U+FFFD on ingress, and a CharacterData offset that falls inside a surrogate pair rounds down to the start
  of the code point, so `deleteData`/`insertData`/`replaceData`/`splitText` at such offsets edit whole code
  points (`'a😀b'.deleteData(1, 1)` removes nothing in rsdom; jsdom removes the high surrogate). A full fix
  needs WTF-8 or UTF-16 storage for character data.
- **XML serialization.** Elements of XML documents use the HTML serializer (`<br></br>`, unescaped `<` in
  attribute values) and `innerHTML =` on them uses the HTML fragment parser.
- **Index getters bound.** Live-list index getters are installed up to the largest length any list access
  has seen (at least 256). A list held across a mutation that grows it past that bound and then indexed past
  it without any `length`/`item`/iteration/getter access returns `undefined`.
  The same accessors serve `select[i]`, `select.options[i]` (with the indexed setter) and `form[i]` (bound grown
  by their `length` getters). They live on prototypes, so `i in list` is true below the bound and indices are not
  own properties (jsdom's legacy platform objects are Proxies with own index properties).
- **Node reclamation (deferred).** Records and payloads of removed nodes are never reused: ids are never
  reused (invariant 6) and a removed subtree can be re-inserted while any wrapper of it is alive, which Rust
  cannot see. A free list needs a wrapper-liveness protocol (e.g. FinalizationRegistry -> Rust) and is
  deferred to the M8/M9 performance work. Dropping mimalloc removed most of the measured sys time (create +
  append + remove: 1.39 -> ~0.8 µs).
- **Value atoms (deferred).** `id` values and class tokens are interned in the same atom space as names
  (and mirrored to JS lazily), so unique ids (React `useId`) grow the atom tables until `reset()`. Moving
  them to a separate, non-mirrored value space changes the `ElementData.id`/`classes`/`classTokens`
  contract of areas A and B; to be decided with them.
- **OUT buffer.** OUT is a JS-owned resizable ArrayBuffer; `rt.V.OUT.buffer.transfer()` (facade-internal
  objects only) would leave Rust writing into a backing store it no longer pins. `bindOut` pins whatever it
  is given.
- **WebIDL brand checks.** Prototype getters do not brand-check `this` (`Node.prototype.firstChild` on a
  non-node returns null instead of throwing TypeError); a hot-path cost not worth paying. Cold paths do: the
  getters of the simple event classes (ProgressEvent, ...) and the XMLHttpRequest methods and attributes (not the
  shared `on*` handlers) throw TypeError.

## 9. Adding a DOM feature, end to end

1. Pick the item in [`docs/ROADMAP.md`](docs/ROADMAP.md) (the measured need behind each one is in
   [`docs/PARITY.md`](docs/PARITY.md) §3). Read jsdom's implementation in `refs/jsdom` and the WPT files for the area.
   `npm run test:parity -- --item <id>` runs the item's scope in the parity suite (`conformance/parity/roadmap.yaml`);
   its entries in `conformance/parity/expectations/` are the failing upstream tests you are about to fix. An item
   with `tests: []` has no tests in the suite's selection (`--item` reports `no test matches`); its contract tests
   carry it.
2. Write the contract test first (`test/contract/`): every assertion runs on jsdom, happy-dom and rsdom, and jsdom is
   the oracle. A case where jsdom itself is wrong against the spec gets a comment and an explicit divergence.
3. Decide where the state lives. State that must survive or react to tree mutations goes to Rust (a new
   module with its own `natives!` block, hooks from §4); pure API surface over existing state stays in the facade
   (a new `lib/<feature>.cjs` installed from `lib/index.cjs`). Unused features must cost nothing on the hot paths.
4. Run `npm test` and `npm run test:fallback`; for anything on a hot path also `npm run bench:micro` and compare with
   `bench/results/micro.md`.
5. `npm run test:parity -- --update --item <id>` locks in what now passes and regenerates the scoreboard
   (`conformance/parity/results/summary.md`); then `npm run check`, which runs the whole parity suite with the other
   checks, since a fix in one area can move another.
6. Tick the roadmap item, and record architecture decisions in `docs/DESIGN.md` (append sections; code cites the
   section numbers).
