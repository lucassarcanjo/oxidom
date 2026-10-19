# rsdom design

> Written during the lab phase (rsdom-lab, milestones M0-M9 in [`lab/ROADMAP.md`](lab/ROADMAP.md)) and kept as the
> architecture reference. Section numbers (`DESIGN §8.2`) are cited throughout the code; keep them stable and append
> new sections instead of renumbering. Forward-looking work is in [`ROADMAP.md`](ROADMAP.md).

rsdom is a DOM for Node.js test environments. The tree lives in Rust and is exposed to Node.js through a Node-API addon built with napi-rs v3. It runs as a Vitest environment for React 19, @testing-library/{react,dom,jest-dom} and user-event tests.

**The question it answers:** can a Rust DOM beat jsdom and happy-dom, and if so, where?

Paths under `refs/` point into upstream checkouts at the pinned versions (`scripts/fetch-refs.sh`). Research notes are in `docs/lab/research/`.

---

## 0. Decision record

Three candidate designs were scored by three judges on performance, correctness and attribution integrity.

| design | perf | correctness | integrity | total |
|---|---|---|---|---|
| **native-arena-direct (NAD)**: direct raw N-API calls into a Rust SoA arena | 6.5 | 8.0 | 8.5 | **23.0** |
| shared-memory-links: zero-copy node table read by JS, N-API writes | 8.5 | 6.5 | 6.5 | 21.5 |
| bulk-native-batched: write-behind command log, barriers, mirrors | 7.5 | 4.5 | 5.0 | 17.0 |

**Chosen design: NAD as the spine, plus the shared-links read path for tree shape, with strict guardrails.**

### Kept from NAD (non-negotiable invariants)
1. **One source of truth.** Every mutable DOM fact lives in the Rust arena: links, attributes, text, form state, selection, focus, inline style, sheets and MutationObserver records. JS never authors DOM state. JS may only *memoise Rust answers*, and each memo is validated by a Rust-maintained version counter.
2. **Rust never calls into JS.** There is no `napi_call_function`, no `napi_coerce_*`, and no property get on user objects inside any callback. That rule is what makes `&mut Env` taken from the callback data pointer sound. All user-value coercion (`String(v)`, `ToNumber`, `!!v`) happens in the facade before the crossing.
3. **All writes are direct and synchronous.** Each one is a raw `extern "C"` callback of about 30-90 ns. There is no command log and there is no JS-side id pre-allocation, so DOMExceptions are thrown synchronously from Rust's own validation.
4. **Bulk algorithms are one crossing each.** This covers selector matching, querySelectorAll, the cascade, getComputedStyle, parse, serialize, textContent, labels, form entries and focusability. Results are returned as u32 ids in a JS-owned out-buffer, so Rust never creates JS arrays or objects.

### Grafted from shared-links
- A **read-only, zero-copy node table**: a Rust-allocated 64 B record per node, exposed as one `Uint32Array`. The JS facade answers identity and shape reads without any FFI: nodeType, localName/tagName, parent and sibling links, childNodes validity, isConnected, `checked`/`selected`/`type`, ownerDocument, the event path, contains and wrapper materialisation.
- The arena stays the single source of truth because **Rust is the only writer**. JS treats the view as read-only by contract, and Rust bounds-checks every id it reads.
- The table is allocated with a large reserved capacity (2^18 nodes, lazily committed), so growth and the ArrayBuffer detach on growth almost never happen.

### Other grafts
- A JS `matches()` tag prefilter (from shared-links and BNB), with the judges' bug fixed (§6.3).
- The epoch page and the OUT buffer from NAD. OUT gets a defined overflow protocol (§3.4).
- getComputedStyle core-property snapshot cached on the wrapper, validated by the STYLE epoch (BNB), using NAD's fine-grained STYLE invalidation rules.
- An epoch-validated, bounded qSA result memo (BNB). It returns a fresh NodeList each time.
- Bulk multi-string egress for `attributes` (BNB `attrsAll`).
- BNB's ablation discipline, generalised: every JS-side shortcut has an env flag, and the bench build counts crossings (§12).

### Rejected
| rejected idea | reason |
|---|---|
| Command log / batching | Saves ≤10-30 ms per suite by its own estimate. String ingress costs as much as a direct call. Introduces two writers and silent stale reads. |
| JS-authoritative form state | Violates "data lives in Rust" and blurs attribution. |
| `#[napi]` classes or methods on hot paths | 320-370 ns per call (`refs/napi-rs/crates/napi/src/bindgen_runtime/native_borrow.rs` L25 `NATIVE_BORROWS`, L353/L452 `Arc<Mutex<NativeBorrowStorage>>`). |
| `napi_wrap`, WeakRef, FinalizationRegistry | Too slow, and they lose React expandos on re-wrap. See docs/lab/research/napi-perf.md. |
| Proxies on nodes, collections, events or style | Trap cost on hot paths; React's many absent-property reads would each hit a trap. |

---

## 1. Repository layout

```
Cargo.toml  Cargo.lock  rustfmt.toml  .cargo/config.toml (no target-cpu=native)   Rust workspace + profiles
package.json  package-lock.json                                                     npm workspaces root
crates/rsdom/                 the native addon crate (napi-rs v3, cdylib + rlib)
  build.rs                    generates atoms, the natives registry and packages/rsdom/lib/generated/*
  data/                       build inputs: atoms/*.txt, events.txt, role-selectors.txt, interfaces.json, css/
  src/
    lib.rs  ffi.rs            module_exports registration, natives! macro, guard, args (primitive-only readers)
    env.rs                    Env (one per napi_env), docs, epoch page, OUT buffer
    table.rs  chunk.rs        NodeTable (zero-copy records), growth/detach
    tree.rs                   insert/remove/replace/adopt/clone, pre-insert validation
    atoms.rs  atom_hash.rs    Interner + static atoms (generated)
    attrs.rs  text.rs  string.rs  node.rs  dom.rs  error.rs  hooks.rs  counters.rs
    parse.rs                  html5ever TreeSink
    serialize.rs
    select/                   selectors 0.41 adapter, prefilter metadata, qSA
    style/                    inline style (cssparser), UA table (generated), cascade, computed memo
    forms/                    FormState, value modes, selection, radio groups, labels, form owner, validity
    focus.rs  mo.rs
  tests/                      proptest differential tree model, parser fuzz
packages/rsdom/               the `rsdom` npm package
  lib/*.cjs                   the JS facade (plain CJS, loaded through createRequire, never through Vite)
  lib/vitest-environment.mjs  the Vitest Environment (`rsdom/vitest-environment`)
  lib/generated/              emitted by build.rs (gitignored)
  native/rsdom.<triple>.node  the addon (gitignored)
  test/contract/              one parity suite run against jsdom, happy-dom and rsdom
  test/native/                rsdom-only tests (protocols, wrappers, epochs, Vitest pools)
packages/vitest-environment-rsdom/   `test.environment: 'rsdom'`
e2e/react-app/                React 19 + Testing Library suite (90 tests), the end-to-end subject
e2e/libraries/                real-library smoke tests (Radix, MUI, react-aria, lit, ...)
bench/micro/  bench/e2e/      benchmark harnesses (phase reporter, runner); bench/results/
conformance/wpt/  conformance/api-surface/   WPT and WebIDL surface comparisons against jsdom
scripts/                      data generators, fetch-refs.sh
```

---

## 2. Rust data model

### 2.1 Env: one per napi_env (one per Vitest worker thread)

`init` runs once per `napi_env`:
- Under `pool: 'threads'` that means once per worker thread.
- Under forks it means once per process.

`init` allocates one `Box<Env>` and passes its raw pointer as the `data` argument of every `napi_create_function`. There are **no mutable statics**. The interner is per-Env, and only the immutable static-atom table is global. Every document in the environment shares one id space: the main document, `createHTMLDocument`, DOMParser output and template contents. That keeps `adoptNode` a field write that preserves wrapper identity.

```rust
pub type NodeId = u32;             // 0 = null; ids < 2^27 (the facade's `id << 4` stays an int32)
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)] #[repr(transparent)]
pub struct Atom(pub u32);          // 0 = none; 1..STATIC_LEN generated by build.rs

pub struct Env {
    pub table: NodeTable,          // zero-copy shared records (Rust = only writer)
    pub elems: Vec<ElementData>,   // indexed by NodeRec.payload for elements
    pub chars: Vec<Str>,           // Text / Comment / PI / CDATA data
    pub docs:  Vec<DocData>,
    pub atoms: Interner,
    pub sels:  SelectorCache,      // SelId -> compiled
    pub style: StyleEngine,        // UA table + author sheets + memo
    pub mo:    MoState,
    pub ep:    EpochPage,          // NonNull<[u32; 16]> into a pinned JS Uint32Array
    pub out:   OutBuf,             // ptr + cap(words) of pinned JS resizable ArrayBuffer + pending Vec<u32>
    pub scratch: String,           // serializer/textContent reuse
    #[cfg(debug_assertions)] pub depth: Cell<u32>, // re-entrancy detector (panics if > 1)
}
```

### 2.2 The shared node table: 64 B per node, 16 × u32

```rust
#[repr(C, align(64))] #[derive(Clone, Copy, Default)]
pub struct NodeRec {
    pub parent: u32, pub first: u32, pub last: u32, pub prev: u32, pub next: u32, // 0..4  O(1) siblings
    pub meta: u32,      // 5: KIND(4b) | NS(2b)<<4 | CONNECTED<<6 | OBSERVED<<7 | HTML_DOC<<8 | IN_TEMPLATE<<9
                        //    | HAS_ID<<10 | HAS_CLASS<<11 | HAS_STYLE<<12 | DISABLED_ATTR<<13
    pub local: u32,     // 6: localName atom (elements), PI target atom; 0 otherwise
    pub child_ver: u32, // 7: bumped on any child-list change of THIS node (live childNodes/children)
    pub owner: u32,     // 8: ownerDocument node id (changes on adopt)
    pub child_len: u32, // 9: number of children (childNodes.length, hasChildNodes)
    pub state: u32,     // 10: CHECKED | SELECTED | INDETERMINATE | DIRTY_* | INPUT_TYPE(5b)<<8 | FOCUSED<<16
    pub attr_ver: u32,  // 11: bumped on any attribute change of this element (className/classList/dataset/type memos)
    pub form_ver: u32,  // 12: bumped on value/checked/selected/selection change (value memo)
    pub payload: u32,   // 13: index into elems/chars/docs (Rust-private meaning)
    pub _res: [u32; 2], // 14-15 reserved (shadow host, attr bloom in P2)
}
const _: () = assert!(core::mem::size_of::<NodeRec>() == 64);
```

**Storage.**
- `NodeTable` owns a `System.alloc_zeroed` block sized for `INITIAL_CAP = 1 << 18` nodes (16 MiB virtual). calloc of a large block maps fresh zero pages, so RSS grows only as nodes are touched; M0 verifies this.
- The block is exported once with `napi_create_external_arraybuffer`, using a no-op finalizer because Rust owns the memory. That gives exactly one ArrayBuffer per allocation (docs/lab/research/napi-perf.md §5).
- Rust accesses the block through `NonNull<NodeRec>` plus `len`/`cap`, never through a long-lived `&mut [NodeRec]` that JS memory could alias. All reads go through `rec(id) -> Option<&NodeRec>`, which bounds-checks and, where relevant, kind-checks. `get_unchecked` is forbidden on ids that came from JS or from the table.

**Growth.** This is the rare path. A suite would need more than 262k live nodes in one env to reach it.
1. Allocate 2× capacity and copy.
2. Create the new external ArrayBuffer and keep a `napi_ref` to it.
3. Call `napi_detach_arraybuffer(old)`. Stale views now read length 0 instead of freed memory.
4. Free the old block.
5. Increment `EP[GEN]`.

Growth can only happen inside **node-allocating calls**: create*, cloneNode, importNode, innerHTML/outerHTML/insertAdjacentHTML setters, a textContent setter, parseFragment and parseDocument. After any of these the facade runs `if (EP[GEN] !== gen) remap()`. No facade code may keep the table view in a local variable across a native call; this is enforced by lint and by a debug assert on `T.length`.

**Fallback.** This applies when `napi_create_external_arraybuffer` returns `napi_no_external_buffers_allowed` (V8 sandbox, Electron), or when `RSDOM_SHARED=0` is set:
- `init` returns `null` instead of the buffer.
- The facade installs the **crossing getter set**: `N.links(id)` fills 5 words into OUT, `N.kindTag(id)` returns a packed kind, ns and atom, and so on. These are memoised on the wrapper against `EP[TREE]`.
- This is NAD's path. It doubles as the ablation that measures what the zero-copy table buys.

### 2.3 Element, text and document payloads

```rust
pub struct Str { s: compact_str::CompactString, ascii: bool, utf16_len: u32 } // ascii => latin1 egress; UTF-16 offsets
pub struct Attr { name: Atom, ns: u8, prefix: Atom, value: Str }

pub struct ElementData {
    pub attrs: SmallVec<[Attr; 2]>,          // insertion order = NamedNodeMap order
    pub id: Atom,                             // cached from `id`
    pub classes: SmallVec<[Atom; 2]>,         // re-split on `class` write
    pub style: Option<Box<InlineStyle>>,      // parsed decls; `style` attr text serialized lazily (dirty flag)
    pub form: Option<Box<FormState>>,         // only form-associated / labelable controls
    pub cs: CsMemo,                           // { epoch: u32, packed: u32 }
}

pub struct FormState {
    pub value: Str, pub dirty_value: bool,    // input/textarea raw value
    pub checked_default_applied: bool,        // checked/selected bits live in NodeRec.state (shared)
    pub sel_start: u32, pub sel_end: u32, pub sel_dir: u8, // UTF-16 code units
    pub input_type: InputType,                // normalized enum, mirrored into NodeRec.state bits
}

pub struct DocData {
    pub root: NodeId, pub html: NodeId, pub head: NodeId, pub body: NodeId,
    pub id_map: FxHashMap<Atom, SmallVec<[NodeId; 1]>>, // duplicates resolved first-in-tree-order lazily
    pub focused: NodeId,                                  // mirrored into EP[FOCUS] for the main doc
    pub observers: u32,                                   // 0 => all MO bookkeeping skipped
    pub sheets: SmallVec<[NodeId; 2]>,                    // connected <style> elements in tree order
    pub quirks: QuirksMode,
}
```

**String decision.** Strings are stored as UTF-8 with an `ascii` flag and a cached `utf16_len`.
- html5ever, cssparser and selectors all need UTF-8.
- ASCII is the overwhelmingly common case. There, egress uses `napi_create_string_latin1` (41-51 ns) and UTF-16 offsets equal byte offsets.
- Non-ASCII strings convert offsets with a linear `char_indices` walk.
- Known divergence: lone surrogates become U+FFFD.

### 2.4 The epoch page (EP)

EP is a JS-allocated `Uint32Array(16)`, pinned with a `napi_ref`. Rust writes it and JS only reads it.

| idx | name | meaning |
|---|---|---|
| 0 | GEN | node-table generation (growth) |
| 1 | TREE | any child-list change in env |
| 2 | ATTR | any attribute change |
| 3 | STYLE | change that can affect computed style (fine-grained rules §8.2) |
| 4 | FORM | any value/checked/selected change |
| 5 | MO_PENDING | MutationObserver records queued |
| 6 | FOCUS | focused node id of the main document (0 → body) |
| 7 | ATOM_LEN | dynamic atoms count (JS syncs lazily) |
| 8 | NODE_LEN | high-water node id |
| 9 | OUT_NEED | words required when an OUT write overflowed |
| 10 | ERR | error code for id-returning calls that return 0 on failure |
| 11-15 | reserved / bench counters | |

---

## 3. Binding strategy: napi-rs v3, raw callbacks

### 3.1 Registration
`#[napi(module_exports)]` is used once (pattern from `refs/napi-rs/examples/napi/src/lib.rs` L76-81). It registers about 95 raw callbacks from a table generated by `build.rs`. The same table also emits `packages/rsdom/lib/generated/native.d.ts`, so the Rust and JS sides cannot drift.

```rust
type RawCb = unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value;

macro_rules! cb {   // fixed arity, env from data ptr, panic guard, debug re-entrancy check
  ($name:ident, $n:literal, |$e:ident, $env:ident, $a:ident| $body:expr) => {
    unsafe extern "C" fn $name($env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      let mut argc = $n; let mut $a = [ptr::null_mut(); $n]; let mut data = ptr::null_mut();
      sys::napi_get_cb_info($env, info, &mut argc, $a.as_mut_ptr(), ptr::null_mut(), &mut data);
      guard($env, || { let $e: &mut Env = &mut *(data as *mut Env); $e.enter(); let r = $body; $e.leave(); r })
    }
  };
}
cb!(n_insert_before, 3, |e, env, a| ret_u32(env, e.insert_before(u32a(env, a[0]), u32a(env, a[1]), u32a(env, a[2]))));
cb!(n_get_attr, 2, |e, env, a| match e.get_attr(u32a(env, a[0]), Atom(u32a(env, a[1]))) {
    Some(s) if s.ascii => ret_latin1(env, s.as_bytes()), Some(s) => ret_utf8(env, s.as_bytes()), None => ret_null(env) });
cb!(n_set_attr, 3, |e, env, a| with_str(env, a[2], |v| ret_u32(env, e.set_attr(u32a(env, a[0]), Atom(u32a(env, a[1])), v))));

#[napi(module_exports)]
pub fn init(exports: Object, env: napi::Env) -> napi::Result<()> {
    let state = Box::into_raw(Box::new(Env::new()));
    for (name, f) in generated::FNS { unsafe { /* napi_create_function(env, name, AUTO, f, state, &mut fv); set_named_property */ } }
    unsafe { sys::napi_add_env_cleanup_hook(env.raw(), Some(free_env), state.cast()); } // last-resort free
    Ok(())
}
```

**Contract rules.**
- Arguments are only u32, bool, JS strings that the facade has already coerced, and `ArrayBuffer`/`TypedArray` (cold `init`/`bindOut` only).
- The `args` module is the only place that touches `napi_get_value_*`, and it exposes only primitive readers.
- Strings coming in use one `napi_get_value_string_utf8` call into a 512 B stack buffer, falling back to the heap for longer strings (about 45 ns).
- Strings going out use latin1 when ASCII and UTF-8 otherwise.
- Return values are u32, i32, bool, string, null or undefined. **Rust never creates objects or arrays.**
- Errors: mutators return `0` on success or a small code, and the facade throws `new DOMException(MSG[c], NAME[c])` in the test realm. Codes: 1 HierarchyRequestError, 2 NotFoundError, 3 InvalidCharacterError, 4 SyntaxError, 5 IndexSizeError, 6 InvalidStateError, 7 NotSupportedError, 8 WrongDocumentError, 9 NamespaceError. Pre-insert validation order follows `refs/jsdom/lib/jsdom/living/nodes/Node-impl.js` (L833-1292 per docs/lab/research/jsdom.md).
- Panics are caught by `catch_unwind` (`panic = "unwind"`) and rethrown as `Error('rsdom internal: …')`. An abort would kill the Vitest worker.
- Ids from JS are untrusted. A bad id returns 0, null or `ERR_NOT_FOUND`. It must never cause UB.

### 3.2 The boundary contract (exported native functions)

Notation: `id` is a node id, `doc` is a document node id, `a` is an atom, `sel` is a selector id, `p` is a CSS property id, `s` is a string, and `→ OUT[n]` means "returns n and writes n words (or n records) into OUT". Functions marked **(G)** can allocate nodes; after calling one, JS must check `EP[GEN]`.

**Lifecycle and infrastructure** (cold)
| fn | signature | notes |
|---|---|---|
| `init` | `(ep: Uint32Array, out: ArrayBuffer) → ArrayBuffer \| null` | pins EP/OUT; returns node table or null (fallback mode) |
| `nodeTable` | `() → ArrayBuffer` | current table after GEN change |
| `bindOut` | `(out: ArrayBuffer) → u32` | re-read OUT ptr/len after JS `resize()`; returns cap words |
| `outRefill` | `() → u32` | copy pending overflow into OUT (after grow) |
| `destroy` | `() → undefined` | detach table, drop Env, re-init a fresh Env in place |
| `intern` | `(s) → a` | validates name production; 0 = InvalidCharacterError |
| `atomsFrom` | `(start: u32) → string` | dynamic atoms ≥ start concatenated; OUT = their UTF-16 lengths (length-prefixed: names may contain NUL) |
| `counters` | `() → string` | bench build only: JSON of per-fn call counts and ns |

**Documents and creation** (all **(G)**)
| fn | signature |
|---|---|
| `createDocument` | `(kind: u32 /*0 html,1 xml-lite*/, title: s \| null) → doc` (html/head/body created) |
| `parseDocument` | `(s) → doc` (DOMParser text/html) |
| `createElement` | `(doc, a, ns: u32) → id` |
| `createElementNS` | `(doc, nsUri: s, qname: s) → id \| 0` (0 ⇒ error code in `EP[ERR]`) |
| `createText` / `createComment` | `(doc, s) → id` |
| `createFragment` | `(doc) → id` |
| `createDoctype` / `createPI` | `(doc, s, s, s) → id` |
| `cloneNode` | `(id, deep: bool) → id` (copies form state per cloning steps) |
| `importNode` | `(doc, id, deep) → id` |

**Tree mutation** (return `0` or an error code)
| fn | signature | notes |
|---|---|---|
| `insertBefore` | `(parent, child, ref /*0=append*/) → code` | validation, move semantics, fragments, CONNECTED pass only on connectivity change, focus fixup, MO records |
| `removeChild` | `(parent, child) → code` | |
| `replaceChild` | `(parent, node, old) → code` | |
| `remove` | `(id) → 0` | ChildNode.remove |
| `adopt` | `(doc, id) → code` | |
| `replaceChildren` | `(parent, count) → code` | ids read from OUT[0..count] (written by JS before the call) |
| `normalize` | `(id) → 0` | |

**Fallback-mode reads** (used only without the shared table)
`links(id) → OUT[5]`, `kindTag(id) → u32`, `children(id, elemsOnly) → OUT[2n]`, `ancestors(id) → OUT[2n]`, `contains(a, b) → bool`.

**Tree algorithms**
| fn | signature |
|---|---|
| `compareDocumentPosition` | `(a, b) → u32` |
| `isEqualNode` | `(a, b) → bool` |
| `textContentGet` | `(id) → string \| null` |
| `textContentSet` **(G)** | `(id, s) → code` (replace-all, one MO record) |
| `dataGet` / `dataSet` | `(id) → s` / `(id, s) → 0` |
| `replaceData` | `(id, off16, count16, s) → code` (append/insert/delete/substringData built on it in JS) |
| `splitText` **(G)** | `(id, off16) → id \| 0` |

**Attributes**
| fn | signature |
|---|---|
| `getAttr` / `hasAttr` | `(id, a) → s \| null` / `bool` |
| `setAttr` | `(id, a, s) → code` |
| `removeAttr` | `(id, a) → bool` |
| `toggleAttr` | `(id, a, force: u32 /*0 none,1 false,2 true*/) → bool` |
| `getAttrNS` / `setAttrNS` / `removeAttrNS` | `(id, nsUri: s, local: a [, qname: s, value: s]) → …` |
| `attrNames` | `(id) → OUT[n atoms]` |
| `attrsAll` | `(id) → s` + `OUT = [n, (nameAtom, nsPrefixWord, start16, len16)×n]` (one crossing for NamedNodeMap / prettyDOM) |
| `classTokens` | `(id) → OUT[n atoms]` (DOMTokenList read; writes go through `setAttr('class')`) |

**Parse and serialize**
| fn | signature |
|---|---|
| `innerHTMLGet` / `outerHTMLGet` | `(id) → s` |
| `innerHTMLSet` **(G)** | `(id, s) → code` |
| `outerHTMLSet` **(G)** | `(id, s) → code` |
| `insertAdjacentHTML` **(G)** | `(id, pos: u32, s) → code` |
| `parseFragment` **(G)** | `(contextId, s) → fragId` (createContextualFragment, template) |

**Selectors**
| fn | signature |
|---|---|
| `compileSel` | `(s) → sel` (0 = SyntaxError) + `OUT = [flags, nTags, tags…]` prefilter metadata |
| `matches` | `(id, sel) → bool` |
| `closest` | `(id, sel) → id` |
| `qs` | `(root, sel) → id` |
| `qsa` | `(root, sel) → OUT[n ids]` |
| `byId` | `(root, a) → id` |
| `byTag` / `byClass` | `(root, a) → OUT[n]` / `(root, s) → OUT[n]` |

**Forms**
| fn | signature |
|---|---|
| `valueGet` / `valueSet` | `(id) → s` / `(id, s) → code` (input value modes, textarea raw value, select value, option value) |
| `setChecked` / `setSelected` / `setIndeterminate` | `(id, bool) → 0` (state bits are shared, so reads are zero-FFI) |
| `selectedIndexGet` / `selectedIndexSet` | `(id) → i32` / `(id, i32) → 0` |
| `options` / `selectedOptions` | `(selectId) → OUT[n]` |
| `selGet` | `(id) → u32 /*0 = n/a*/` + `OUT=[start16, end16, dir]` |
| `selSet` | `(id, start16, end16, dir) → code` |
| `setRangeText` | `(id, s, start16, end16, mode) → code` |
| `preActivate` | `(id) → u32` (packed old state) + `OUT=[radio ids unchecked…]` |
| `cancelActivation` | `(id, packed) → 0` |
| `labels` | `(id) → OUT[n]` |
| `labelControl` / `formOwner` | `(id) → id` |
| `formElements` | `(formId) → OUT[n]` |
| `formReset` | `(formId) → 0` |
| `formEntries` | `(formId, submitter) → s` + OUT offsets (FormData override) |
| `validity` | `(id) → u32 bits` |
| `validationMessage` | `(id) → s` |

**Style**
| fn | signature |
|---|---|
| `styleGet` | `(id, p) → s` |
| `styleSet` | `(id, p, s, important: bool) → 0` |
| `styleRemove` | `(id, p) → s` |
| `styleCssText` / `styleCssTextSet` | `(id) → s` / `(id, s) → 0` |
| `styleLen` / `styleItem` | `(id) → u32` / `(id, i) → p` |
| `cssProp` | `(s) → p` (custom `--x` and unknown names intern; 0 = invalid) |
| `csCore` | `(id) → u32 packed` (display 5b \| visibility 2b \| pointer-events 4b \| opacity==1 1b \| position 3b) |
| `csStr` | `(id, p) → s` |
| `isFocusable` | `(id) → bool` |

**Focus and MutationObserver**
| fn | signature |
|---|---|
| `setFocus` | `(doc, id /*0 = body*/) → prevId` (updates EP[FOCUS], FOCUSED bits) |
| `activeElement` | `(doc) → id` (non-main documents) |
| `observe` | `(observerId, target, optBits, nFilter) → 0` (attributeFilter atoms read from OUT[0..nFilter]) |
| `disconnect` | `(observerId) → 0` |
| `drainRecords` | `() → s` + `OUT = [n, records…]` (oldValues joined in the string) |

### 3.3 Identity and the per-call paths (JS)

```js
const W = [];                                   // id -> wrapper, strong, never shrinks during env
const EP = new Uint32Array(16);
const OUT_AB = new ArrayBuffer(1 << 20, { maxByteLength: 1 << 28 });
let OUT = new Uint32Array(OUT_AB);              // length-tracking
let T = asU32(N.init(EP, OUT_AB)), gen = EP[0]; // T = node table view, stride 16

const wrap = id => id === 0 ? null : (W[id] ?? materialize(id));
function materialize(id) {                      // zero crossings
  const o = id << 4, meta = T[o + 5], kind = meta & 15;
  const C = kind === 1 ? elementClass(meta >>> 4 & 3, T[o + 6]) : TYPE_CLASS[kind];
  MAKING = id; const w = new C(TOKEN); MAKING = 0; return (W[id] = w);
}
// Node.prototype getters (shared-table set)
get parentNode()  { return wrap(T[(this._i << 4)]) }
get nextSibling() { return wrap(T[(this._i << 4) + 4]) }
get nodeType()    { return this._kind }          // immutable fields cached at construction
get isConnected() { return (T[(this._i << 4) + 5] & CONNECTED) !== 0 }
```

- Wrappers are module-level plain classes guarded by a private `TOKEN`; `new HTMLDivElement()` throws "Illegal constructor".
- Every wrapper initialises the same field order (`_ev, _i, _cn, _ch, _cs, _st, _vm, _at`; there is no `_kind`: nodeType is read from the table) so hidden classes stay stable until React adds its expandos. As implemented (§15), wrappers are built by a per-class constructor function, so all eight fields (and React's expandos) are in-object.
- Immutable facts are cached when the wrapper is created: kind, local atom, namespace, and the tagName string from the `UPPER[]` table.
- `ownerDocument` reads `T[o+8]`, so it stays correct after adopt.

### 3.4 OUT buffer protocol (volatile scratch)

- OUT is a JS-allocated resizable ArrayBuffer: 1 MiB initially, up to a 256 MiB maximum. Its data pointer stays stable across `resize()` (verified in docs/lab/research/napi-perf.md §5.3).
- **Rust never writes past the cap it last read.** If a result needs `n > cap` words, Rust keeps it in `out.pending: Vec<u32>`, sets `EP[OUT_NEED] = n`, and returns n.
- The facade checks `if (n > OUT.length) { OUT_AB.resize(align(n*4)); N.bindOut(OUT_AB); N.outRefill(); }` and then reads the result.
- The facade **copies ids out of OUT into a local array before any further crossing**. For example, `materialize` makes no crossings in shared mode, and in fallback mode the result loop copies first.

---

## 4. JS facade

### 4.1 Class hierarchy

All classes are defined once at module level in `packages/rsdom/lib/*.cjs`. `constructor.name` and `Symbol.toStringTag` equal the interface name. pretty-format matches on these (`refs/dom-testing-library/src/DOMElementFilter.ts` L159-180), and jest-dom uses `instanceof window.HTMLElement`.

```
EventTarget
 ├─ Window (globalThis gets EventTarget methods bound to a hidden WindowTarget)
 └─ Node  (constants on Node and Node.prototype: ELEMENT_NODE…, DOCUMENT_POSITION_*)
     ├─ Document ─ HTMLDocument (XMLDocument stub)      ├─ DocumentFragment (ShadowRoot: out of scope)
     ├─ DocumentType                                     ├─ Attr
     ├─ CharacterData ─ Text ─ CDATASection, Comment, ProcessingInstruction
     └─ Element ─ HTMLElement ─ HTML*Element (~70, generated from refs/jsdom/lib/jsdom/living/helpers/create-element.js),
                │              HTMLUnknownElement (unknown tags only)
                ├─ SVGElement ─ SVGGraphicsElement ─ SVGSVGElement …
                └─ MathMLElement
NodeList, HTMLCollection, HTMLOptionsCollection, HTMLFormControlsCollection, NamedNodeMap, DOMTokenList,
DOMStringMap, CSSStyleDeclaration, Range (basic), Selection (stub), MutationObserver, MutationRecord,
DOMParser, FormData (override), Event + subclasses, DOMException (Node's own)
```

### 4.2 What stays in JS and why

| JS | why |
|---|---|
| Wrapper identity table `W[]`, class hierarchy, constants, immutable per-node facts | ~85% of react-dom touches are constant reads (docs/lab/research/react-dom.md); 2 ns field reads |
| EventTarget, listener registry, Event objects, dispatch | listeners are JS functions; React registers 143/root; synthetic events read ~30 props; Rust→JS calls would break invariant #2 |
| MutationObserver objects, callbacks, MutationRecord construction | callbacks are JS; records are produced in Rust |
| Window plumbing: location, navigator, localStorage, matchMedia, rAF (Node timers), innerWidth/Height, getSelection stub, CSS.escape | not DOM tree data |
| Zero-layout geometry (`getBoundingClientRect` zeros, offset*/client*/scroll* 0) | no layout engine |
| Memos of Rust answers (link/kind reads in fallback mode, computed-style core, qSA results, input value string) | always validated by a Rust-written version; each behind an ablation flag |

Everything else is in Rust: tree, attributes, reflection storage, text, form state and selection, focus target, selectors, cascade, parse, serialize, labels, form owner, validity and MO records.

### 4.3 Collections (no Proxies)

- **Static NodeList** (from qSA): an array-like with own numeric properties, `length`, `item`, `forEach`, `entries/keys/values` and `Symbol.iterator`. This satisfies dom-accessibility-api's `ArrayFrom(length, [k])` and pretty-format's `Array.prototype.slice.call`.
- **Live `childNodes`/`children`:** SameObject. As implemented (§15): no own numeric properties; `list[i]` is a getter on the prototype that re-validates against `child_ver` (T[o+7]) on every read, so a list held across a mutation is always current. A cursor cache makes sequential access and iteration O(1) per step; `childNodes.length` is CHILD_LEN. Iteration re-checks on each step, so removing items during iteration skips them the way jsdom does. Internal state is in `#private` fields.
- **getElementsByTagName/ClassName:** live, validated by `EP[TREE]` (+`EP[ATTR]` for class). On a miss they re-run `byTag`/`byClass`.
- **NamedNodeMap / Attr:** validated by `attr_ver` and filled with one `attrsAll` crossing. Attr objects are cached per (element, namespace, local name) so their identity is stable (dom-accessibility-api uses `getAttributeNode`).
- **DOMTokenList / dataset:** read via `classTokens` or `attrsAll`, write via `setAttr`. dataset uses generated accessors plus a small `Proxy`. This is the one Proxy allowed, because `dataset` is cold.

---

## 5. Events (all JS)

- **Listeners.** `this._ev` stays null until the first `addEventListener`, then becomes `Map<type, Listener[]>`. Options supported: `capture`, `passive`, `once`, `signal` (Node AbortSignal). Listeners are deduplicated by (callback, capture). For object listeners, `handleEvent` is looked up at call time. The options object is read so React's passive probe works.
- **Event classes.** Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, KeyboardEvent (key, code, keyCode, charCode, which), FocusEvent, InputEvent, CompositionEvent, ErrorEvent, SubmitEvent, AnimationEvent, TransitionEvent, WheelEvent, DragEvent, ClipboardEvent, TouchEvent, ProgressEvent, PopStateEvent.
  - **No TextEvent, no DataTransfer.**
  - Init dictionaries ignore unknown keys.
  - Objects are plain and extensible, so user-event can shadow `key`/`preventDefault`.
  - `timeStamp = Date.now()`, matching jsdom.
- **Dispatch.**
  1. Build the path by walking `T[o]` parent links into a reused array (about 5 ns per level), then append document and window. `load` is the exception and does not reach window.
  2. Run capture, target and bubble phases, each over a snapshot of the listener list.
  3. `globalThis.event` is set during listener invocation and restored to **`undefined`**.
  4. A listener exception becomes a window `ErrorEvent`. If nothing handles it, it goes to `process.emit('uncaughtException')`, matching `refs/vitest/packages/vitest/src/integrations/env/jsdom.ts` L8-34. There is deliberately no `reportError`.
- **Activation behaviour** follows jsdom's `EventTarget-impl.js` (`refs/jsdom/lib/jsdom/living/events/EventTarget-impl.js`) and `HTMLInputElement-impl.js`. It triggers only on a MouseEvent or PointerEvent `click`.
  - **Checkbox / radio:** `N.preActivate(id)` runs before the listeners. After dispatch, if the event was canceled, `N.cancelActivation`; otherwise fire `input` then `change`.
  - **Submit / reset button:** `requestSubmit` → `SubmitEvent{submitter}`, or `formReset`.
  - **Label:** clicks its control.
  - `HTMLElement.click()` dispatches a PointerEvent with `detail` 0 and does nothing on disabled controls.
- **Focus.**
  1. `focus()` calls `N.isFocusable(id)`: connected, not disabled or in a disabled fieldset, tabindex, no `display:none` ancestor (from the computed memo, without invalidating anything).
  2. `prev = N.setFocus(doc, id)`.
  3. JS fires blur, focusout, focus, focusin with `relatedTarget`. `activeElement` has already moved during blur and focusout.
  4. Removing the focused element: Rust clears `focused` and `EP[FOCUS]`, so `activeElement` becomes body **without** firing blur.
  5. `document.activeElement` reads `wrap(EP[6]) ?? body`, with zero FFI.
- **GlobalEventHandlers `on*` accessors** are generated on HTMLElement.prototype, Document.prototype and window. They default to null, so `'oninput' in document` is true.
- `Element.prototype.moveBefore` is **not** exposed (`refs/react/packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js` L1026-1034).

---

## 6. Selectors

### 6.1 Engine
- `selectors` 0.41 + `cssparser` 0.38 parse every selector and do the general matching. They implement `Element` for `#[derive(Clone, Copy)] ERef<'a> { env: &'a Env, id: NodeId }` (about 30 methods).
- Atom bounds come from a thread-local interner view: `PrecomputedHash` is the atom id, and `ToCss` prints from the interner.
- Non-tree-structural pseudo-classes: `:checked :disabled :enabled :focus :focus-within :focus-visible(=focus) :required :optional :read-only :read-write :placeholder-shown :indeterminate :default :link :any-link :empty :root :scope :target(none)`.
- Unsupported syntax throws SyntaxError. It is never silently truncated, which is a happy-dom pitfall.

### 6.2 Rust fast paths (added before custom compilers)
- A compiled selector records its rightmost-compound requirements: tag atom, id atom, class atoms. These are checked against `NodeRec.local`, `ElementData.id` and `classes` before calling `matches_selector`.
- `#id`-only selectors on a connected root use `id_map`.
- `qsa` performs **one preorder walk** over the links, tests each element against the whole list and writes matching ids into OUT. Output is in document order with no duplicates.
- A custom right-to-left compiler (NAD's `Fast` plan) is P2. It is added only if profiles in M9 show the selectors-crate overhead matters, and it must be differential-tested against the general path on aria-query's role selectors.

### 6.3 JS front-end and prefilter (corrected)

`compileSel` returns `sel` and writes `[flags, nTags, tags…]`:
- `tags` is the set of rightmost type-selector atoms, one per complex selector in the list. If any complex selector has no type selector or uses `*`, `nTags = 0` (no prefilter).
- `TAG_ONLY` is set only if every complex selector is a single compound consisting solely of a type selector.
- No attribute bloom is used in v1. A bloom may only be built from positive presence requirements, never from `:not(...)` parts, and it is P2.

```js
matches(s) {
  const c = SEL.get(s) ?? compile(s);                    // Map<string, {id, tags: Set|null, tagOnly}>
  const o = this._i << 4;
  if (c.tags !== null && (T[o + 5] >>> 4 & 3) === NS_HTML) {   // prefilter only for HTML-namespace elements
    if (!c.tags.has(T[o + 6])) return false;             // ~95% of DTL's role selectors exit here, zero FFI
    if (c.tagOnly) return true;
  }
  return N.matches(this._i, c.id);
}
```

DTL builds role selectors as `${name}${attributes}`, so they always start with a tag (`refs/dom-testing-library/src/role-helpers.js` L80-100) and are called via `node.matches` (L136). The preceding `node.type !== 'text'` check reads `INPUT_TYPE` from `T[o+10]`, also zero FFI.

**qSA memo** (`RSDOM_NO_MEMO=1` disables it):
- A bounded LRU of 64 entries keyed by `(root, sel)`.
- Valid while `EP[TREE]`, `EP[ATTR]` and `EP[FORM]` are unchanged, and `EP[FOCUS]` too when the selector uses `:focus`.
- Each hit returns a **fresh** NodeList built from the cached id array.

---

## 7. Form controls and React value tracking

**Prototype contract** (to be enforced by contract tests run against jsdom, happy-dom and rsdom):
- `value` and `checked` are ES-class `get`/`set` pairs **owned by `HTMLInputElement.prototype`**.
- `value` is owned by `HTMLTextAreaElement.prototype` and `HTMLSelectElement.prototype`.
- `selectionStart`, `selectionEnd`, `selectionDirection`, `setSelectionRange`, `setRangeText` and `select` are on the input and textarea prototypes.
- `el.constructor.prototype === Object.getPrototypeOf(el)`, and instances have no own `value`.
- Why this matters: React's tracker reads `Object.getOwnPropertyDescriptor(node.constructor.prototype, 'value')` (`refs/react/packages/react-dom-bindings/src/client/inputValueTracking.js` L59-60), and DTL's `setNativeValue` reads the same descriptor (`refs/dom-testing-library/src/events.js`).
- There are no per-environment subclasses.

**State in Rust:**
- Normalised input type. It is mirrored into `NodeRec.state`, so `input.type` reads with zero FFI.
- Value modes (value, default, default/on, filename), dirty value flag, and sanitisation per type: line breaks stripped, number, email trim, and so on.
- `checked` and dirty checkedness, `indeterminate`.
- Textarea raw value, with defaultValue taken from child text.
- Option selectedness and dirtiness, select single-selection exclusivity, `selectedIndex` of -1 when nothing matches.
- Radio groups keyed by (name, form owner, tree).
- Selection offsets in UTF-16, moving to the end when the value changes.
- Labels: `for=` plus the wrapping label. Form owner, `form.elements`, fieldset disabled, and `checkValidity` for required, email, pattern, minlength/maxlength and number range, which fires a cancelable `invalid` event from JS.

**Internal reads never go through `element.value`.** React redefines `value` on each instance. Rust reads its own `FormState`.

**Value memo.** `RSDOM_NO_MEMO` disables it. The input/textarea wrapper caches `_vm = [form_ver, string]`. The `value` getter is `T[o+12] === vm[0] ? vm[1] : refresh()`. This removes repeated crossings from controlled-input commits and from user-event typing reads.

---

## 8. CSS: element.style and getComputedStyle

### 8.1 Inline style
- `InlineStyle` holds a `SmallVec<[(PropId u16, Value, important); 4]>`. Values are parsed with cssparser.
- Normalisation: lengths, numbers (a unitless non-zero length is rejected), hex/rgb/hsl/named colours serialised as `rgb(r, g, b)`, keywords, and common shorthands (margin, padding, border, border-width/style/color, overflow, flex, background-color, font-weight). Invalid values are ignored.
- **The same value serializer is used for `element.style` and for computed values**, so jest-dom `toHaveStyle` round-trips. This fixes the jsdom 30 `color: red` / `fontWeight: 'bold'` mismatch (docs/lab/research/testing-library.md).
- The `style` attribute string is serialised lazily, only when something reads it: getAttribute, outerHTML, attributes, or an MO old value.
- `CSSStyleDeclaration` is created lazily per element.
  - It has generated prototype accessors for camelCase, kebab-case, `Webkit*` and `cssFloat`.
  - `setProperty(name, value, priority)` supports `!important`, which React's `hideInstance` uses.
  - `getPropertyValue`, `removeProperty`, `cssText`, `length` and `item` are supported.
  - Unknown names are plain expandos.
  - `'animation' in style` and `'transition' in style` are both true.

### 8.2 Computed style
**Cascade order:**
1. UA table per (ns, tag). It is generated by `build.rs` from `refs/jsdom/lib/jsdom/browser/default-stylesheet.css`, so accessible names match jsdom ("Saved", not "Save d").
2. Built-in rules: `[hidden]`, `input[type=hidden]`, `dialog:not([open])`, `template`, `script`, `style`, `head` → `display: none`.
3. Author `<style>` sheets: a per-document list maintained on insert/remove and re-parsed when the sheet text changes. Rules are bucketed by rightmost id, class or tag, and ordered by specificity and then source order.
4. Inline declarations, honouring `!important`.

Inherited properties are `visibility`, `pointer-events`, `color`, `font-*` and `cursor`. Each takes its value from the parent's memo.

**Memo.** `ElementData.cs = {epoch, packed}` is keyed by `EP[STYLE]`. STYLE is bumped only by:
- tree insert/remove (inheritance);
- writes to `style`, `hidden`, `type`, `open` or `popover` (a `<style type>` write also re-evaluates that sheet);
- `class`/`id` writes, only when author sheets exist; writes of any attribute an author sheet reads, i.e. the
  attributes of its `[attr]` selectors AND the attributes its pseudo-classes read (`PseudoClass::attr_deps`:
  `disabled` for `:disabled`/`:enabled`/`:read-*`, `required`, `readonly`, `contenteditable`, `checked`/`selected`
  for `:default`, `href` for `:link`, `lang` (also `xml:lang`) for `:lang()`, `dir` for `:dir()`, ...);
- character-data writes, only while a sheet uses `:empty` / `:has()` (`sheet_text`);
- `:checked`/`:focus`/validity/value changes, only when a sheet uses a state pseudo-class (`EP[STYLE_DEP]` = 1:
  the memo also validates against `EP[REC]`/`EP[FORM]`; `setCustomValidity` bumps `EP[FORM]` like every other
  validity input);
- `<style>` text changes.

**`aria-*`, `data-*` and text writes never bump STYLE unless a sheet reads them.** `RSDOM_NO_MEMO=1` disables the
Rust memo as well as the facade's `_cs` memo (`StyleState.memo`, read from the environment at env creation).
M9 review: before these rules the memo went stale for attribute- and text-dependent pseudo-classes when no state
pseudo-class was in use (`b.disabled = true` kept `button:disabled { pointer-events: none }` unapplied, and a
`display: none` reached through `:lang()` left a hidden input focusable).

**JS side** (jest-dom destructures `getComputedStyle` unbound, so it is a plain function that ignores `this`):
```js
function getComputedStyle(el, pseudo) {
  if (pseudo) return new PseudoComputedStyle();          // content 'none', display '' (dom-a11y passes ::before/::after)
  const e = EP[STYLE];
  if (el._cse !== e) { el._csc = N.csCore(el._i); el._cse = e; }   // RSDOM_NO_MEMO=1 disables wrapper cache
  return new ComputedStyle(el._i, el._csc);              // display/visibility/pointerEvents/opacity/position = snapshot
}
```
`ComputedStyle` decodes the core fields from the packed u32 with no crossing. Other properties are lazy getters that call `N.csStr(id, p)`.

**Documented divergence:** the core properties behave as a snapshot, the same as jsdom, but non-core properties are read live. Detached elements compute UA defaults, which matches jsdom.

---

## 9. MutationObserver

- `observe()` is O(1). It sets OBSERVED on the target, registers the observer in Rust and increments `doc.observers`. happy-dom does O(subtree) work here, and DTL's waitFor observes `{subtree, childList, attributes, characterData}` on every call (`refs/dom-testing-library/src/wait-for.js` L104).
- **On every mutation:** if `doc.observers == 0`, there is no MO work at all. Otherwise Rust walks ancestors for OBSERVED, checks the options and filters, and appends a compact record: type, target, added/removed id ranges, prev, next, attribute atom, and an old-value index only when requested. It then sets `EP[MO_PENDING]`.
- **Scheduling:** every mutating facade method ends with `if (EP[5] !== 0 && !moQueued) { moQueued = true; queueMicrotask(moTick) }`. That is one typed-array read, and the microtask lands where jsdom's `Promise.resolve().then(notify)` does (`refs/jsdom/lib/jsdom/living/helpers/mutation-observers.js` L164).
- `moTick` calls `drainRecords`, builds `MutationRecord`s in JS and invokes callbacks in observer-creation order. `takeRecords()` and `disconnect()` are supported. Transient registered observers are included.
- **Parser inserts** produce one record per innerHTML set.

---

## 10. Parsing and serialization

- html5ever 0.40 `TreeSink` uses `Handle = NodeId` and writes **straight into the arena**. There is no MO record or epoch bump per node, and no wrapper is created. One CONNECTED pass runs only when the target is connected, followed by one `child_ver`/epoch bump and one MO record.
- `LocalName` is converted to an `Atom` once per element. html5ever's static atoms are mapped through a `phf` table built at build time.
- `<template>` contents get their own inert fragment, flagged IN_TEMPLATE. `<script>` is never executed.
- The serializer is a hand-written single pass over the links into `Env.scratch`, using memchr-based escaping, and returns a latin1 string when the output is ASCII.
- textContent get concatenates Text/CDATA descendants in one pass.
- textContent set replaces all children with one Text node and produces one record.

---

## 11. Interning, memory and teardown

### Interning
- `build.rs` emits about 1,400 static atoms: HTML/SVG/MathML tags, common attributes, `aria-*`, event names and every name in aria-query's role selectors. They go both to Rust constants (`atom::DIV`, `atom::TYPE`, …) and to `packages/rsdom/lib/generated/atoms.cjs`.
- JS keeps `ATOM: Map<string, u32>`, `ATOMS[]` and `UPPER[]`.
- **New names from JS:** `N.intern(s)` returns the id, and JS appends the string it already holds.
- **New names from the parser:** JS calls `atomsFrom(k)` lazily when `EP[ATOM_LEN] > ATOMS.length`, for example when materialising an element whose atom JS does not know yet.
- `setAttribute(name)` lowercases the name only if the element is HTML in an HTML document and the name contains an uppercase letter. It then does one Map hit and passes the u32.

### Memory
- Node ids are monotonic, and nothing is freed while the env lives.
- Cost per element: 64 B table record, about 100-140 B of ElementData, and about 80-120 B for a wrapper if one is materialised. That is roughly 250-320 B per element, against jsdom's 1.6 KB and happy-dom's 3.7 KB.
- Long single-file tests grow monotonically. Reclaiming detached, never-wrapped subtrees with a free-list is out of scope.

### Teardown
`teardown(global)` runs these steps:
1. Cancel the pending MO tick.
2. `N.destroy()`: detach the table AB, drop the Env (one free per Vec), and re-initialise a fresh Env in place so `isolate:false` workers can reuse the module. The facade neuters every wrapper handed out before (`_i = 0`) because ids restart at 1 (§15).
3. `W.length = 0`.
4. Restore the saved global descriptors.

There is no per-node finalizer storm.

### Build profile
```toml
[profile.release]
lto = "fat"
codegen-units = 1
opt-level = 3
panic = "unwind"
strip = "symbols"
[features]
counters = []   # bench build: per-fn call counts + rdtsc/Instant time
```
- No `#[global_allocator]` (the system allocator; see §15 for why mimalloc was dropped). The node table is an anonymous `mmap(MAP_NORESERVE)`, so it is committed lazily.
- Build with `napi build --release --platform -o packages/rsdom/native` (@napi-rs/cli 3.10.8). No `target-cpu=native`.

**Crates** (exact versions pinned at M0 after `cargo search`): napi 3.14 (`napi8`, raw `sys`), napi-derive 3.6, napi-build 2, html5ever 0.40, selectors 0.41, cssparser 0.38, precomputed-hash, rustc-hash 2, smallvec 1.13, compact_str 0.9, bitflags 2, memchr 2. (phf and mimalloc were dropped, §15.) Dev: proptest 1 for the differential tree-op fuzzing against a reference model.

---

## 12. Vitest environment

`packages/rsdom/lib/vitest-environment.mjs` is the path used by `e2e/react-app/vitest.config.ts`.

**Export and loading.**
- It default-exports `{ name: 'rsdom', viteEnvironment: 'client', setup(global, options) → { teardown } }`. The type comes from `vitest/runtime`.
- The facade and the `.node` file are loaded with `createRequire(import.meta.url)`. A static import of `.node` or of CJS fails under Vite (`refs/vitest/packages/vitest/src/integrations/env/loader.ts`, docs/lab/research/vitest-env.md §2).
- Tests reach rsdom only through globals. Importing facade modules from a test would produce a second class identity.

**`setup()`** runs before react-dom is imported:
- It creates the document (html/head/body) and installs about 300 globals as **own data properties** on `globalThis` (about 1-2 ns per read, against 18-28 ns for populateGlobal accessors in `refs/vitest/packages/vitest/src/integrations/env/utils.ts`).
- `window`, `self`, `top` and `parent` are `globalThis`, and `document.defaultView === globalThis`.
- Node's timers, `setImmediate`, `queueMicrotask`, `performance`, `console`, `AbortController`, `MessageChannel`, typed arrays, Blob, URL, fetch, `crypto` and `DOMException` are kept as they are.
- Added: the FormData override, rAF/cAF on Node timers, matchMedia, location (`http://localhost:3000`), localStorage/sessionStorage, navigator.userAgent (no Chrome/Firefox token), `HTMLIFrameElement` and AnimationEvent/TransitionEvent.
- `img.decode()` resolves immediately.

**Options.** Options come from `options.rsdom`: `{ shared: bool, memo: bool, prefilter: bool, counters: bool }`. Env vars `RSDOM_SHARED`, `RSDOM_NO_MEMO`, `RSDOM_NO_PREFILTER` and `RSDOM_COUNTERS` override them.

**Supported pools.** forks and threads, with or without isolate. vm pools are unsupported: there is no `setupVM`, and objects there would come from the wrong realm.

---

## 13. Where we expect to win or lose, and why

These are predictions, to be verified in M8. **Measured values and win/lose verdicts for every row: `docs/BENCHMARKS.md`.** Baselines are the measured numbers in docs/research (same 4-vCPU VM, Node 22.22, about ±15%).

**Cost model for rsdom:**
| primitive | cost |
|---|---|
| raw crossing | about 30 ns |
| string argument | +15-45 ns |
| latin1 return | 41-51 ns |
| table read | 1.5-6 ns (25-30 ns at megamorphic sites) |
| `W[id]` lookup | 1-2 ns |
| wrapper allocation | 5 ns |

| # | operation | jsdom | happy-dom | rsdom predicted | verdict | bench id |
|---|---|---|---|---|---|---|
| 1 | createElement+appendChild+removeChild | 6.6 µs | 4.5 µs | 0.15-0.3 µs | **win 15-40×** | micro/mutate |
| 2 | setAttribute | 1.9 µs | 4.9 µs | 70-120 ns | **win 15-50×** | micro/attr |
| 3 | bottom-up detached build, 1001 nodes, depth 200 | 96-111 ms | 65-69 ms | ≈0.1-0.3 ms (no subtree walks) | **win** | micro/deep |
| 4 | DFS walk via firstChild/nextSibling, steady or interleaved | 130 ns/node | 52 ns/node | 8-15 ns/node (25-30 megamorphic) | **win 2-5× vs happy-dom** | micro/walk |
| 5 | same walk, fallback mode (`RSDOM_SHARED=0`), interleaved with mutations | 130 | 52 | 35-80 ns/node | **lose to happy-dom** (ablation) | micro/walk |
| 6 | getAttribute / textContent of a tiny node | 340 ns | 38-110 ns | 60-100 ns | parity to **lose 2×** vs happy-dom; win 4× vs jsdom | micro/attr |
| 7 | hasAttribute | ~250 ns | ~40 ns | 45-70 ns | **lose ~1.5×** vs happy-dom | micro/attr |
| 8 | input.value get after write | ~300 ns | ~40 ns | 60-80 ns cold; 3-5 ns memo | memo: parity; no-memo: lose | micro/forms |
| 9 | matches(), DTL role selectors | ~2.5 µs | 0.13 µs warm / 4-7 µs cold | 3-10 ns prefiltered; 50-90 ns crossing | **win** (vs happy-dom warm: win only due to the prefilter, a JS effect; report it) | micro/matches |
| 10 | qSA cold, 3k-element table | 0.25-15 ms | 1.6-11 ms | 20-80 µs | **win 30-300×** | micro/qsa |
| 11 | qSA warm, no mutation | ms | 0.26-0.7 µs | 0.3-0.6 µs (memo) / 20-80 µs (no memo) | memo: parity; no memo: **lose** | micro/qsa |
| 12 | getComputedStyle cold after mutation | 150-700 µs | 4-6 ms | 0.1-1 µs | **win 500-5000×** | micro/gcs |
| 13 | focus() | 450-650 µs | 21-26 µs (and wrong) | 0.3-1 µs | **win** | micro/focus |
| 14 | new MouseEvent + dispatch through 20 levels with React-like listeners | 6.9 µs + | ~0.3 µs + | ≈ happy-dom ±20% | **parity** (pure JS both) | micro/event |
| 15 | innerHTML set (parse) | parse5 + 2 objects/node | | 3-8× faster than jsdom, 2-4× faster than happy-dom | **win** | micro/parse |
| 16 | outerHTML get, 3.6k elements | ~52 ms (prettyDOM path) | | 1-3 ms (serialize); prettyDOM total 3-8 ms (pretty-format JS dominates) | **win** | micro/serialize |
| 17 | env setup per file | ~850 ms | ~400 ms | 15-40 ms | **win**, but mostly a *non-Rust* effect (facade size, data-property globals) | e2e phases |
| 18 | MO observe/disconnect on 4k nodes | | ~4 ms each | O(1), ~50 ns | **win** | micro/mo |
| 19 | memory per div | 1.6 KB | 3.7 KB | ~0.3 KB | **win**; no reclaim within a file | micro/mem |

**Whole suite** (app/, 90 tests, 11 files, forks+isolate, 3 workers):
| phase | jsdom | happy-dom | rsdom predicted |
|---|---|---|---|
| environment | ~9.4 s CPU | ~4.5 s CPU | ~0.3 s |
| tests | ~23 s | ~15 s | 6-10 s |
| wall | ~11.7 s | ~10.2 s | 4.5-6.5 s |

- Expected end-to-end result: about **2-2.5× faster than jsdom** and **1.5-2× faster than happy-dom**.
- **The floor is non-DOM JS:** React dev rendering and perf tracks, DTL/dom-accessibility-api filtering, user-event, pretty-format, and worker spawn at about 150-170 ms per file.

**Attribution rules for the report:**
1. Report the environment phase separately from the tests phase, and say plainly that the setup win comes from module graph and facade size, not from Rust.
2. Run the suite with `RSDOM_SHARED=0`, `RSDOM_NO_MEMO=1` and `RSDOM_NO_PREFILTER=1` (one at a time and all off), so wins can be split between Rust algorithms and JS memoisation or shared-memory layout.
3. Use the bench build's crossing counters to check the prediction that the suite totals about 1.5M public DOM calls but only about 0.06-0.15 s of crossing cost.
4. Benchmark only tests that pass on all three DOMs, and interleave mutations with reads, reporting cold and warm separately.

## 14. Top risks (and their guardrails)

1. **Prototype-shape fidelity.** If it is wrong, React and DTL fail silently.
   - Guardrail: a contract test file run against all three DOMs.
2. **The "never re-enter JS" invariant.**
   - Guardrails: the args module exposes primitive readers only, a debug re-entrancy counter, and a review checklist.
   - The node-table growth path calls no JS: it detaches and re-exports. The fallback never resizes a JS buffer from Rust; OUT overflow uses the pending/refill protocol.
3. **Stale caches.** Every JS memo is keyed by a Rust-written counter.
   - Guardrail: proptest random op sequences comparing the facade with `RSDOM_NO_MEMO=1` against a reference model and the jsdom oracles.
4. **Behavioural breadth is the main schedule risk, more than speed.** It covers form semantics, focus rules, CSS normalisation and UA-table parity.
5. **The selectors-crate adapter.** It is an API surface of about 30 methods, and selectors and cssparser versions are coupled.
   - Guardrail: pin exact versions and keep the adapter in one module.
6. **UTF-8 storage against UTF-16 APIs.**
   - Guardrails: an ASCII fast path, plus emoji typing tests with user-event.
7. **No memory reclamation within an env.** This is acceptable for test files and documented.

### 14.1 Divergences found while making the app suite green (M7)

Each one is asserted in a contract test; the full list of older ones is in `rsdom/CONTRIBUTING.md` §8 and the
area status notes (`docs/lab/status/*.md`).

- **Indexed properties of `select`, `select.options` and `form`** (round 1, `test/contract/forms.test.mjs`).
  They are prototype accessors (the live lists' scheme), not Proxy-based legacy platform objects as in jsdom:
  `i in select` is true for any `i` below the accessor bound, indices are not own properties, and
  `Object.defineProperty(select, 0, ...)` is not rejected. Getting, setting, iterating and `Array.from` match
  jsdom. A Proxy wrapper would put a trap on every property access of those elements and break wrapper identity
  inside constructors, for no observable gain in the app or testing-library.
- **`select[i] = option` for an option inside an `<optgroup>`** replaces it in its own parent (Chromium); jsdom
  replaces it as a child of the select and throws `NotFoundError`. Spec-correct divergence.

### 14.2 Divergences and fixes from the M9 correctness review

Asserted in `packages/rsdom/test/contract/m9-review.test.mjs` (jsdom, happy-dom, rsdom) and `test/native/m9-review.test.mjs`.

Fixed (rsdom now matches jsdom): stale computed-style memo for attribute/text-dependent pseudo-classes (§8.2);
`setCustomValidity` not invalidating `:invalid` in qSA and computed style; byte-slice panics in `:lang()` matching
and `parse_time` on non-ASCII input; `moObserve` trusting its filter count (aborting allocation); `<details>`
`toggle` events (coalesced, fired from a task, also for parser-created `<details open>`; EP[MO_PENDING] bit 1);
`isTrusted` true for UA-fired events (focus family, activation input/change, label-forwarded click, submit/reset,
invalid, error reports) while `el.click()` and `dispatchEvent` stay untrusted; editing hosts focusable as `<a>`
without href / non-first `<summary>`; select selectedness reset only when the list of options changes; `cloneNode`
no longer copies the text selection; `normalize()` always queues the characterData record; `<style type=text/foo>`
creates no sheet; `dir=auto` / `<bdi>` directionality (dom-selector's algorithm, first strong character; the strong
RTL set is the Hebrew/Arabic/Syriac/Thaana/NKo blocks and their presentation forms, strong LTR = other alphabetic
characters); `:dir(<any ident>)`, `::slotted()` and `::part()` parse and never match; `:lang(\*-US)` (RFC 4647
extended filtering when the range contains `*`).

Remaining divergences (rsdom follows the spec or browsers where jsdom does not):
- `:empty` ignores empty Text nodes (Selectors 3/4, browsers); jsdom treats `<p>` with an empty Text child as
  non-empty.
- `:lang()` honours `xml:lang` and non-ASCII subtags; jsdom ignores both.
- `dataset` getter / `in` / keys read only null-namespace `data-*` attributes (HTML), so `dataset.k = v` reads
  back `v` even when a namespaced `data-k` exists; jsdom and happy-dom read by qualified name. The setter writes the
  null-namespace attribute in all three.
- Changing a `<style>` element's `type` re-evaluates its sheet; jsdom only re-evaluates on connect / text change.
- `display: revert` resolves to the UA origin's value (browsers: `block` on `<p>`); jsdom returns the string
  `revert`.
- `font-weight: bold` computes to `bold` (rsdom keeps the specified serialization for non-core properties so
  jest-dom `toHaveStyle` round-trips); jsdom returns `700`.
- MutationObserver `attributeFilter` ignores namespaced attributes (DOM spec); jsdom reports them.
- The `toggle` event is a plain `Event` (no `oldState`/`newState`), as in jsdom.
- A panic inside a native (a bug) is turned into a JS Error but the env is not transactional: a mutation can be
  left half-applied. The fuzzers in `tests/fuzz_parsers.rs` cover the parsers that take user strings.
- Environment teardown on `globalThis` leaves no `FormData` global behind (rsdom deletes Node's lazy undici-backed
  `FormData` instead of reading it, §15.2); with `isolate: false` this only matters after the worker's last DOM
  file. rsdom's `FormData` is pure JS (as jsdom's), so `fetch` does not treat it as a multipart body.

## 15. Foundation implementation notes (M0-M2)

What the implementation does differently from, or more precisely than, the sections above. `rsdom/CONTRIBUTING.md`
is the working guide.

- **Registration.** There is no hand-written function table. Each module declares raw callbacks in a
  `natives! { fn name(e, a: u32, s: str) -> Code { ... } }` block (`src/ffi.rs`). The macro emits the
  `extern "C"` callback (fixed-arity `napi_get_cb_info`, `&mut Env` from the data pointer, `catch_unwind`,
  debug re-entrancy check) and the module's `NATIVES` slice. build.rs scans `src/**` for these blocks and
  generates the registry and `packages/rsdom/lib/generated/native.d.ts` from the same header lines.
- **Signatures.** `init(ep: ArrayBuffer(64), out: resizable ArrayBuffer, cap, shared)`; `cap` forces small
  tables for tests and `shared=false` selects the fallback. `parseFragment(ctx, s, doc)` takes the document
  for the body-context case (`ctx = 0`). `toggleAttr` returns 0/1, or `16 + code` on error. Extra natives:
  `getAttrNSA`/`setAttrNSA` (Attr wrappers address attributes by atoms), `nodesToNode` ("convert nodes into a
  node"), `appendChild`, `byId`, `elemNs`/`elemPrefix`, `doctypeField`, `templateContent`, `rec`, and test
  hooks `__echo`/`__panic`/`__outSeq`/`__strLen16`/`__tableCap`.
- **Epoch page.** It adds `EP[11] REC` (bumped on every node-record write) and `EP[12] TEXT` (character-data
  changes). Slots 13-15 are pre-assigned to areas A, B and C.
- **Fallback mode** (`RSDOM_SHARED=0` or no external buffers). JS keeps a mirror `Uint32Array` of records.
  `V.off(id)` re-fetches a record with `N.rec(id)` (16 words via OUT) when the record's cached `EP[REC]` is
  stale. Every getter uses the same code in both modes; only `off` differs. Measured walk cost: 122 ns/node
  in fallback mode against 18 in shared mode.
- **Storage.** The node table is an anonymous `mmap(MAP_NORESERVE)` reservation, so init adds 0 KiB RSS.
  Element and character payloads live in `ChunkVec` (1024-element chunks that are never reallocated).
  `ElementData` is 104 B. Rarely used state (inline style, form state, computed-style memo) sits behind
  `ElementData.ext: Option<Box<ElementExt>>`. The reason: first-touch page faults cost about 2 µs per 4 KiB
  page in this VM, and they dominate node creation because the arena never reclaims memory.
- **Wrappers.** `materialize` builds wrappers with a per-class constructor function (canonical field
  order, superseding the original `Object.create`, §15.1). The classes stay TOKEN-guarded against user
  construction. `Text`, `Comment`, `DocumentFragment` and `Document` are user-constructible through
  `rt.defaultDocument`. Live lists are always current, also when held across mutations (§15.1).
- **jsdom parity pins.** `HTMLDocument === Document` and HTML documents report `[object Document]`, as in
  jsdom 30. MathML elements are `MathMLElement` (spec), where jsdom and happy-dom use `Element`. html5ever
  0.40 implements the 2025 customizable-`<select>` parser changes, so `<div>` inside `<option>` is kept.
- **Hooks.** `src/hooks.rs` fans mutation events out to the area modules (`style`, `forms`, `focus`, `mo`).
  Area owners implement those functions without editing the tree algorithms. The focus fixup (a removed
  focused element moves focus to body without blur) is implemented in `focus.rs`.

### 15.1 Foundation review fixes (2026-10)

Four reviews (Rust soundness, Rust performance, DOM correctness, JS facade) of M0-M2; what changed:

- **Allocator.** mimalloc 0.1.52 builds its v3 sources by default; as `#[global_allocator]` in a dlopen'ed
  addon it segfaulted Node when a worker thread loaded the addon after an earlier worker had exited
  (Vitest `pool: 'threads'` crashed). mimalloc v2 did not crash but both versions measured slower here than
  glibc malloc (create+append+remove 1.46 vs 0.89 µs, innerHTML of the 300-row table 3.2 vs 1.7 ms, 3x the
  sys time from purge/refault). rsdom now uses the system allocator; `test/native/workers.test.mjs` runs six
  sequential workers and a `pool: 'threads'` Vitest smoke run in child processes.
- **Growth inside mutations.** Adopting a `<template>` with contents creates the destination's
  template-contents document, and convert-nodes-into-a-node creates a fragment before validating, so
  insertion natives can grow the table. `rt.mutated()` and the error paths of `rt.check()`/`rt.checkId()`
  remap the view; collection walks test `c > 0`, so a stale view can never spin.
- **Reset.** `rt.reset()` neuters every wrapper (`_i = 0`, the null record) and bumps `V.envGen`; live
  collections created in an older env read as empty; `rt.defaultDocument` is cleared; the dynamic-atom
  interface-class cache is cleared. A wrapper leaked from a previous file (timer, effect) can no longer read
  or write the next file's nodes.
- **Atoms.** One-hash interner: `atom_hash` (src/atom_hash.rs, shared with build.rs) probes a
  build-generated open-addressing static table (with hash fingerprints), then the env's dynamic table; each
  dynamic name is stored once. `atomsFrom` is length-prefixed (names can contain NUL). Class tokens are
  split without cloning the value and sized once. Id values and class tokens are still interned into the
  same atom space (see the deferred items in rsdom/CONTRIBUTING.md §8).
- **Strings.** `Str` caches a Latin-1 flag; egress never uses V8's UTF-8 decoder (ASCII: one-byte copy;
  Latin-1: branchless transcode + one-byte string; otherwise UTF-16). Ingress queries the UTF-16 length
  (O(1)) when the 512-byte stack buffer overflows and copies once into an uninitialised buffer; no UTF-8
  re-validation; the UTF-16 count is a vectorised byte scan. `replaceData`/`appendData` edit in place and
  copy the old value only when a MutationObserver may need it. A string V8 refuses (too long) throws
  `RangeError: Invalid string length`.
- **Data memo.** Character-data nodes use record word 11 (`attr_ver` of elements) as `DATA_VER`, set from
  `EP[TEXT]` on every data change; CharacterData wrappers memoize `data` in `_at` under `_ch = DATA_VER`
  (`RSDOM_NO_MEMO=1` disables). Repeated `textContent`/`data` reads of text nodes cost one table read.
- **Collections.** Live NodeList/HTMLCollection/NamedNodeMap have index getters on the prototype (an
  intermediate prototype for live NodeLists, so static qSA lists keep fast own properties), a cursor
  cache, a hand-written iterator and `#private` state (Vitest `toEqual` compares them like jsdom's).
  ~100-180 ns per indexed read of a live list (jsdom ~195, happy-dom ~145); iteration ~12 ns/item.
- **Tree / parser.** Pre-insert uses the host-including ancestor walk (template contents fragments record
  their host in `payload`), so a template can no longer be inserted into its own contents (that made the
  serializer loop and cloneNode crash). Cloning is fully iterative (template contents go on the same work
  stack). Parsed template contents are re-owned by the template-contents owner document after the parse;
  adopt re-owns nested template contents. `document.replaceChildren` excludes the current children from
  validation (jsdom). `splitText` always creates a Text node. DOMParser documents parse with scripting
  disabled. Void elements serialize no children. The serializer escapes with memchr.
- **Soundness hardening.** `compareDocumentPosition`/`tree_order` tolerate invalid ids; `bindOut` pins the
  buffer it caches; a table replaced by growth is released and mapped `PROT_NONE` (an escaped view faults
  deterministically); `MAX_CAP` is 2^27 so `id << 4` never overflows int32.
- **Fallback mode.** The record mirror is a length-tracking view over a resizable ArrayBuffer, so growing
  it never replaces `V.T` (expressions like `V.T[V.off(id) + k]` evaluate `V.T` first). It costs ~20% on
  the fallback walk (149 vs 122 ns/node); fallback is the ablation mode.
- **Facade shape.** Wrappers are created by per-class constructor functions (all eight fields in-object);
  `W`, `UPPER` and the interface-class tables stay dense; `id`/`className` skip the crossing when HAS_ID /
  HAS_CLASS is clear; `hasAttributes` uses `attrCount`; public interface members are enumerable (WebIDL);
  Attr behaves as a Node (equality, contains, root, lookups, error types, adoptNode keeps it attached);
  `document.body` has a setter; `new Document()` works; required-argument counts are checked on the hot
  creation/insertion methods.

### 15.2 Profile-driven optimisation pass (M9, 2026-10-17)

Each item was measured before/after (release build, idle machine; micro harness single cases or scratch
probes) and kept only when it won without changing behaviour. Ablation flags stay transparent.

- **Environment startup (biggest wall-clock item).** Node 22's `FormData`/`Headers`/`Request`/`Response`/
  `MessageEvent`/`WebSocket`/`EventSource` are lazy V8 data properties: reading their descriptor (the window's
  `save()`) or redefining them loads Node's whole undici bundle (~55-65 ms per worker). `FormData` is now a
  pure-JS class (like jsdom's / happy-dom's) registered in `rt.classes`; `save()` deletes those keys on
  `globalThis` without reading them (`LAZY_NATIVE` marker) and `restoreWindow()` deletes ours (Node's original
  cannot come back without loading undici; isolate: false workers tear down when they stop). The ~1700 CSS
  property accessors are installed on a dictionary-mode prototype (fast-mode transitions were O(n^2): ~22 ms
  and ~13 MB garbage per worker), and the libc probe uses `fs.existsSync` instead of `process.report` when
  only one Linux build exists. Vitest environment phase per file: 121 -> 44 ms (`env-vitest`).
- **Author-rule index (style).** `DocStyle.index` is one `AuthorIndex` over all author sheets (Arc'd, tree
  order): `all` / `core` buckets keyed like `Sheet::candidates` (rightmost id > class > attribute > type >
  universal), plus flat core / per-property lists scanned directly while they hold <= 16 rules. Rules carry
  their bucket and a 64-bit Bloom of declared properties. Rebuilt lazily when the sheet set or a sheet's text
  changes; `prepare()` returns immediately while it is valid. Quirks-mode documents scan the flat lists
  (case-insensitive ids/classes). 800 class-keyed rules: computed `display` 40 -> 1.2 us, `color` 52 -> 1.9 us;
  400 `<style>` elements: core over 3.4k elements 35 -> 1 ms.
- **Selectors.** `Pre::decides`: a compound of only `*`, a lowercase type, one id and <= 4 classes is decided by
  the precheck (ids/classes outside quirks mode); `qsa('*')` has its own walk; `closest` and `qsa` reuse the
  env's `SelectorCaches` when the list does not write them. A lone `#id` no longer uses the case-sensitive id
  map in quirks mode (fix).
- **Same-value attribute sets.** A same-value set of `class`/`id`/`style`/`type`/`hidden`/`open`/`popover`
  goes through `hook_attr_same_value` (MO record + forms attribute change steps only; no Str, no class re-split,
  no style invalidation, no `attr_ver` / `EP[ATTR]` bump). Other attributes keep the normal path (comparing
  every value cost changing sets a few ns for no measurable gain).
- **Select reset.** One allocation-free pass (`scan_options`) yields the options signature, selected count,
  last selected and first enabled option; still O(n) per appended option (27 -> 10 us per option at 4000).
- **Inline style.** `fmt_rgba` without `core::fmt`; the cssText buffer is presized.
- **Facade.** getAttribute/hasAttribute memo per element (`_at.m`, 8 pairs, valid while the element's
  `attr_ver` is unchanged; trade-off: a read right after a write on the same element misses and refills);
  the qSA memo keeps the wrapper array (a fresh NodeList per call, filled top-down); `on*` handlers share one
  invocation path (no closure each) and listener lists are a flat `[type, list]` array up to 8 types.
- **Measured and not kept / not done.** A V8 code cache for the facade (vm.Script + cachedData) was slower
  than plain `require` once its own module loads were counted. A `vitest-environment-rsdom` package instead
  of the path-based environment saved ~5 ms per file (noisy) but needs an installed package and an app config
  change. Not done (ceilings under ~1% of the app suite): per-node STYLE invalidation instead of the global
  epoch on child-list changes (needs a per-node validity key in Rust and JS), the property table / UA sheet
  generated at build time (~0.8 ms per worker, paid by the first `csCore`), lazy CSS accessors (would only move
  cost from the environment phase into the first style access).

## 16. Facade memo protocol (2026-10)

Invariant 2 (§0) allows JS to memoise Rust answers only, each memo validated by a Rust-written counter and
behind an ablation flag (§12). Until this section, every memo re-implemented that protocol by hand: about 17 sites,
three key formulas for "these epoch slots are unchanged" (`TREE + ATTR`, the lossy `TREE * 0x1000 + (ATTR & 0xfff)`
that returned a stale base URL after exactly 4096 attribute writes, and a recommended but non-monotonic
`TREE ^ ATTR`), seven memos without the `RSDOM_NO_MEMO` switch, and two spellings of the env generation.

`lib/memo.cjs` now owns the protocol; a call site only says what its memo depends on and how to recompute it:

- **Switches.** `MEMO` and `PREFILTER` (read once from `rt.flags`). Every memo, including live-collection cursors,
  element counts and query caches, recomputes on every read when its switch is off.
- **Per-node counters.** `NODE.ATTRS` / `DATA` / `CHILDREN` / `FORM` name the record words Rust rewrites
  (`attr_ver`, the character-data `DATA_VER`, `child_ver`, `form_ver`); `nodeVersion(id, word)` is one table read.
  The hottest memos (getAttribute / hasAttribute, `data`, input `value`; §15.2) keep their single compare inline.
- **Epoch-page dependencies.** `deps('TREE', 'ATTR', ...)` names a set of EP slots. A stamp is a `Uint32Array` copy
  of those slots plus the env generation; `fresh(stamp, n)` compares the first `n` slots one by one (exact, no
  packing) and fails for a stamp from an older env, so a reset can never revive a memo. Slots are ordered from
  always-needed to conditionally-needed: the qSA memo stamps TREE, ATTR, TEXT, FORM, REC and checks 2, 3 or 5 of
  them by the selector's flags (§6.3); the computed-style core stamps STYLE, REC, FORM and checks REC and FORM only
  while `EP[STYLE_DEP]` (slot 13, now named in `EPI`) says author sheets select on state (§8.2).
- **Env lifetime.** Objects that cache ids record `envGen()` and test `alive(gen)`.

`test/native/memo.test.mjs` runs one scenario that fills and invalidates every memo kind with memos on and off
(child processes) and asserts identical, literal results, plus the base-URL collision regression.
