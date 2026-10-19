# napi-rs v3 performance research: fastest bindings for a Rust-resident DOM

Status: research and measurement notes for rsdom (Rust DOM exposed to Node via napi-rs, used as a Vitest environment).
Date: 2026-10-16. Measured on Node v22.22.0 (V8 12.4.254.21-node.33), napi 3.14.2, napi-derive 3.6.12
(napi-derive-backend 6.1.5), napi-sys 3.4.0, Rust 1.97, Intel Xeon 2.8 GHz, 4 vCPU shared VM.

Every reference-repo claim cites a path relative to `refs`. The macro code generator
(`napi-derive-backend`) and `napi-sys` are not in the sparse checkout, so those cites point at the cargo registry copy
(`~/.cargo/registry/src/index.crates.io-*/napi-derive-backend-6.1.5/...`).

Probe sources and raw outputs: `rsdom-lab/docs/research/napi-probes/` (crate + `bench*.cjs` + `results-*.txt`).

---

## 0. TL;DR (what to do)

1. **Do not use `#[napi]` classes for DOM nodes, and do not use `#[napi]` functions on hot paths.** In napi 3.14,
   every generated callback with at least one argument allocates an `Arc<Mutex<NativeBorrowStorage>>` and pushes and pops
   thread-local scope stacks. Every `&self`/`&mut self` method also takes a **process-global `Mutex<HashMap>`** and
   checks the object's type tag. Measured cost per call:
   - raw `extern "C"` callback: ~27-32 ns
   - `#[napi] fn(u32)->u32`: ~65-75 ns
   - `#[napi]` class method: **~320-370 ns**
   - creating a `#[napi]` class instance from Rust: **~1.8-2.0 µs**
2. **Register hand-written `unsafe extern "C"` callbacks** through `napi::sys` from a `#[napi(module_exports)]` init
   hook (snippet in §3). Use `#[napi]` only for cold APIs such as `parseHTML`, `createDocument` and `serialize`.
3. **The handle is a `u32` node index, with 0 meaning null.** Keep ids at or below 2^30 so V8 represents them as
   Smis. Returning `0xFFFFFFFF` allocates a HeapNumber (+8 ns plus GC churn).
4. **JS wrappers are plain JS classes** holding `this._i = id`. Keep identity in a **dense JS array**
   `wrappers[id]`: allocating a wrapper costs ~5 ns and the lookup ~1-2 ns. Avoid `napi_wrap` (~700 ns per wrapper
   including GC finalization), `napi_add_finalizer` (~250 ns) and WeakRef identity caches (~800 ns to create, slow
   `deref` in sync loops).
5. **Free memory per document, not per node.** Each document is an arena; Vitest env `teardown()` calls
   `destroyDocument()`, which drops the arena and detaches every exported view. Tests are short-lived, so per-node
   GC integration is unnecessary.
6. **Strings:**
   - Tag, attribute and other names are **atoms (u32)**. JS mirrors the atom table (`atoms[id]`), so reading a name
     costs one u32 crossing or zero crossings, never a string crossing.
   - For Rust to JS, use `napi_create_string_latin1` when the bytes are ASCII (~41 ns for "DIV", ~51 ns for 123 B)
     and utf8 or utf16 otherwise.
   - For JS to Rust, use `napi_get_value_string_utf8` into a **stack buffer** with a heap fallback (~42-48 ns),
     never `String` (~150-260 ns).
   - External strings (~170-180 ns) are slower at DOM-typical sizes.
7. **Zero-copy reads are the big lever.** Expose the tree's structure-of-arrays columns (`parent`, `firstChild`,
   `nextSibling`, `nodeType`, `localName` atom, ...) to JS as `Uint32Array`s over Rust memory. Measured on a
   4096-node tree:

   | Tree walk method | ns/node |
   |---|---|
   | Zero-copy column views | **5.5** |
   | Per-node calls | 78 |
   | Batched "children into shared buffer" | 40 |
   | happy-dom 21.0.3 | 52 |
   | jsdom 30.1.3 | 130 |

   On Node 22 `napi_create_external_arraybuffer` **works** (the V8 sandbox is off: `process.config.variables.v8_enable_sandbox=0`).
   Guard against `Vec` reallocation with a generation counter, and call `napi_detach_arraybuffer` on old views
   (verified: they become length 0 and read `undefined`, never use-after-free). The portable fallback, which also
   works under a sandbox, is **JS-allocated resizable ArrayBuffers** (`new ArrayBuffer(n, {maxByteLength})`). Their
   data pointer was **verified stable across `resize()`** (4 KB to 256 MB), so Rust can keep a raw pointer to them.
8. **Build:**
   - `lto="fat"`, `codegen-units=1`, `opt-level=3`.
   - Keep `panic="unwind"` and wrap each raw callback in `catch_unwind`. This costs nothing measurable and avoids
     killing the Vitest worker on a Rust bug.
   - Use mimalloc as `#[global_allocator]`.
   - Skip `target-cpu=native` except for local-only experiments.
   - `@napi-rs/cli` 3.10.8 `napi build --release --platform -o <dir>` works locally (verified) with no publishing.

For context, jsdom and happy-dom on the same machine (see §2.6):

| Operation | jsdom | happy-dom |
|---|---|---|
| `getAttribute` | 340 ns | 110 ns |
| `setAttribute` | 1.9 µs | 4.9 µs |
| `createElement` + `appendChild` + `removeChild` | 6.6 µs | 4.5 µs |

A raw crossing costs 30-70 ns, so rsdom has plenty of headroom on writes and queries. Reads (`tagName` is 8 ns in
happy-dom) only win if they avoid crossings, which means using views and atom tables.

---

## 1. Methodology

- A throwaway crate (`napi-probes/src/lib.rs`) with `#[napi]` functions and classes alongside hand-registered raw
  `extern "C"` callbacks. Built with `lto="fat"`, `codegen-units=1`, `opt-level=3`, `panic="abort"`, and napi features
  `napi10` without `dyn-symbols`. An extra variant uses `panic=unwind` plus `dyn-symbols`.
- JS harness: each case runs its own monomorphic loop of 10M iterations (2M for the slow cases) after 2 warmup runs
  of 200k. Each case is timed 3 times (5 in `bench2`) with `process.hrtime.bigint()`, and the tables report the best
  and median ns per operation. Results feed a sink, so V8 cannot dead-code-eliminate the call.
- The VM is shared and noisy: run-to-run variance is about ±15%. Compare orders of magnitude, not single-digit
  nanoseconds.

---

## 2. Measured results (Node 22.22.0, ns per op, best / median)

### 2.1 Call overhead

| Case | best | median |
|---|---:|---:|
| JS empty loop iteration | 0.9 | 0.9 |
| JS plain fn call (inlined) | 1.3 | 1.3 |
| JS `Uint32Array` read | 1.4 | 1.6 |
| JS `atoms[id]` string-table lookup | 1.4 | 1.5 |
| **raw `extern "C"` fn(u32)->u32** | **27-32** | 29-34 |
| raw fn(u32,u32)->u32 | 36 | 38-43 |
| raw fn(u32)->undefined (no result value) | 25 | 26 |
| raw fn + `catch_unwind` wrapper (panic=unwind build) | 28-36 | 35-37 |
| raw fn returning `0xFFFFFFFF` (HeapNumber) | 40 | 42 |
| `#[napi] fn()->u32` (0 args, so no borrow scope) | 27-31 | 28-34 |
| `#[napi] fn(u32)->u32` | 64-75 | 66-84 |
| `#[napi] fn(u32,u32)->u32` | 69-83 | 72-90 |
| `#[napi] fn(f64)->f64` / `fn(u32)->bool` | 61-78 | 61-79 |
| `#[napi]` class method `&self` (u32)->u32 | **318-368** | 341-395 |
| `#[napi]` class method `&mut self` (u32,u32) | **329-344** | 337-365 |
| `#[napi] fn` returning a new `#[napi]` class instance | **1811-2019** | 1934-2107 |
| JS `new JsNode(id)` (plain wrapper) | 5 | 5-7 |
| raw: create `{id,type}` object via `napi_create_object` + `napi_set_named_property` | ~500 | 535-571 |
| raw: same with pre-created property keys (`node_api_create_property_key_latin1`) + `napi_set_property` | 416 | 453 |

The macro tax is about 35-45 ns per call. The 0-arg `#[napi]` fn costs the same as a raw fn, which isolates the
cost to the borrow-scope machinery (§3.1).

### 2.2 Strings, Rust to JS

| Case | best | median |
|---|---:|---:|
| `#[napi] -> String` "DIV" (heap alloc) | 103-111 | 114-118 |
| `#[napi] -> &'static str` "DIV" | 86 | 88-93 |
| raw `napi_create_string_latin1` "DIV" | 40-44 | 46-50 |
| raw `napi_create_string_utf8` "DIV" | 47-52 | 54-58 |
| raw cached JS string through `napi_ref` (needs module API v10, §4.4) | **33** | 37 |
| raw cached string via ref'd array + `napi_get_element` (v8-compatible) | 87-100 | 96-115 |
| **raw returns atom id u32 + JS `atoms[id]`** | **29-33** | 37 |
| `#[napi] -> &'static str` 123 B | 114-161 | 119-181 |
| raw latin1, 123 B | 51-54 | 55-67 |
| raw utf8, 123 B | 70-76 | 83-84 |
| raw utf16, 123 B | 81-83 | 84-85 |
| raw `node_api_create_external_string_latin1`, 123 B static | 167-180 | 174-184 |

### 2.3 Strings, JS to Rust

| Case | best | median |
|---|---:|---:|
| `#[napi] fn(String)`, short (5-11 chars) | 147-163 | 156-164 |
| `#[napi] fn(JsString).into_utf8()`, short | 151-153 | 155-167 |
| raw utf8 into 256 B stack buffer, short | 43-48 | 44-49 |
| raw latin1 into stack buffer, short | 40-47 | 43-49 |
| raw utf16 into stack buffer, short | 41-48 | 45-56 |
| `#[napi] fn(String)`, 123 B | 252-266 | 253-267 |
| raw utf8 into stack buffer, 123 B | 49-55 | 49-57 |
| raw latin1 into stack buffer, 123 B | 42-45 | 43-46 |
| raw `setAttribute(u32 node, u32 nameAtom, str value)` | 65-67 | 69-88 |

### 2.4 Tree walk (4096-node 4-ary tree, DFS, ns per visited node)

| Strategy | best | median |
|---|---:|---:|
| per-node raw calls (`firstChild`/`nextSibling`) | 78-86 | 82-88 |
| one call per parent writing child ids into a JS-allocated shared buffer | 40-43 | 41-43 |
| **zero-copy external `Uint32Array` views over the Rust `Vec<u32>` columns** | **5.5** | 7.9 |
| command buffer: JS writes (op,a,b) triples, one Rust call per 4096 ops | 3.3 / op | 5.8 / op |

### 2.5 GC and identity (with `--expose-gc`, 1M allocations, GC time included)

| Case | best | median |
|---|---:|---:|
| allocate plain JS wrapper | 1.4 | 2.5 |
| allocate wrapper + `napi_wrap(obj, ptr, finalizer)` | 704 | 787 |
| allocate wrapper + `napi_add_finalizer` | 246 | 248 |
| allocate wrapper + `FinalizationRegistry.register` | 100 | 101 |
| allocate wrapper + `new WeakRef` | 823 | 979 |
| identity lookup: dense `array[id]` (100k objects, random-ish index with `%`) | 18 | 20 |
| identity lookup: `Map.get(id)` | 64 | 71 |
| identity lookup: `WeakRef[id].deref()` | 409 | 449 |

The `array[id]` figure is dominated by the modulo and cache misses over 100k objects; with sequential ids it is ~1-2 ns.
WeakRef `deref()` (and the constructor) adds its target to V8's KeepDuringJob set, which only clears at the microtask
checkpoint. Synchronous test code that derefs many WeakRefs therefore pays a hash-set insert on each call.

### 2.6 Context: the same primitives in jsdom 30.1.3 and happy-dom 21.0.3

| Op | jsdom | happy-dom |
|---|---:|---:|
| walk `firstChild`/`nextSibling` (ns/node) | 130 | 52 |
| `el.tagName` | 49 | 8 |
| `el.getAttribute('data-i')` | 339 | 110 |
| `el.setAttribute('title', v)` | 1855 | 4922 |
| `createElement('div')` + `appendChild` + `removeChild` | 6614 | 4452 |
| `root.querySelectorAll('span[data-i]')` over 4096 nodes (per call) | 1,904,822 | 264* |

\* happy-dom caches `querySelectorAll` results per selector until a mutation invalidates them. Repeated identical
queries are therefore almost free. **Benchmarks must account for this** (mutate between queries, or compare
cold-query cost).

---

## 3. Per-call overhead: where it goes and how to avoid it

### 3.1 What `#[napi]` generates (napi-derive 3.6.12 / backend 6.1.5)

The generated callback (`napi-derive-backend-6.1.5/src/codegen/fn.rs` ~L300-L330) runs these steps in order:

1. `CallbackInfo::<N>::new(env, cb, None, false)` performs one `napi_get_cb_info`
   (`napi-rs/crates/napi/src/bindgen_runtime/callback_info.rs` L25-L75).
2. `NativeBorrowScope::new()` **heap-allocates `Arc::new(Mutex::new(NativeBorrowStorage{..}))`** and pushes onto
   the thread-local `NATIVE_BORROW_SCOPES` `RefCell<Vec>`
   (`napi-rs/crates/napi/src/bindgen_runtime/native_borrow.rs` L370-L395, `new_inner`).
3. The argument conversions run (`FromNapiValue`; for `u32` this is one `napi_get_value_uint32`).
4. `_napi_native_borrow_scope.finish()` pops the TLS stack (native_borrow.rs L399-L413).
5. `NativeBorrowBarrier::new()` performs a TLS push and a `mem::take` of another TLS `Vec` (native_borrow.rs L300-L337).
6. The user function runs, then `ToNapiValue`, then the drops run in reverse.

Steps 2, 4 and 5 are skipped only for **0-argument, non-method, non-async** functions (fn.rs ~L318-L330), which is
why `#[napi] fn()->u32` measures the same as a raw callback.

For class methods (`&self`/`&mut self`) the codegen also emits (fn.rs ~L405-L430):

- `cb.unwrap_raw::<T>()`, which calls `napi_unwrap` and then **`validate_type_tag`** (`napi_check_object_type_tag`)
  and `check_class_identity` (callback_info.rs L313-L345; class_identity.rs L92-L131).
- `register_native_borrow_with_value`, which calls `NativeBorrowGuard::acquire`. That function **locks the
  process-global `static NATIVE_BORROWS: LazyLock<Mutex<HashMap<usize, NativeBorrowState>>>`**, inserts an entry,
  and on drop locks it again and removes the entry (native_borrow.rs L25-L26, L688-L745, L762-L835).

This runtime borrow checker is new in the 3.1x line. It is sound (it rejects re-entrant `&mut self` aliasing) but it
costs about 300 ns per method call. Under the Vitest `threads` pool it is also a global lock shared by all workers.

Constructing a class instance from Rust (`CallbackInfo::_construct`, callback_info.rs L85-L140) does all of this:

- `Box` allocation
- `napi_wrap` with a finalizer
- `Arc::new(Cell::new(Box<dyn FnOnce>))`
- `add_ref` into the thread-local `REFERENCE_MAP`
- type-tag stamping

That is ~1.9 µs per instance. One instance per DOM node would make the binding slower than jsdom.

`catch_unwind` is opt-in (`#[napi(catch_unwind)]`, fn.rs L357-L366), so it is not part of the default cost.

### 3.2 Raw callbacks: the fast path

Node-API itself (V8 `FunctionTemplate` callback, then napi `CallbackWrapper`, then the env's exception scope) costs
roughly 25 ns per call on this box. That is the floor for any Node-API addon.

Node 22 does **not** expose V8 Fast API calls (`v8::CFunction`) to Node-API addons. Getting below ~25 ns would need a
non-ABI-stable C++ shim against V8 headers (rebuilt per Node major), with Rust linked as a staticlib. That is not
recommended for this experiment; mention it as the "nuclear option".

Pattern (compiles against napi 3.14.2; full version in `napi-probes/src/lib.rs`):

```rust
use napi::{bindgen_prelude::*, sys};
use napi_derive::napi;
use std::{ffi::CStr, ptr};

type RawCb = unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value;

macro_rules! args {                       // fixed-arity napi_get_cb_info, no allocation
  ($env:ident, $info:ident, $n:literal) => {{
    let mut argc: usize = $n;
    let mut argv: [sys::napi_value; $n] = [ptr::null_mut(); $n];
    sys::napi_get_cb_info($env, $info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), ptr::null_mut());
    argv   // missing args are napi `undefined`, so get_u32 yields 0 = null node: still memory-safe
  }};
}
#[inline(always)] unsafe fn get_u32(env: sys::napi_env, v: sys::napi_value) -> u32 {
  let mut out = 0; sys::napi_get_value_uint32(env, v, &mut out); out   // non-number -> 0
}
#[inline(always)] unsafe fn ret_u32(env: sys::napi_env, v: u32) -> sys::napi_value {
  let mut out = ptr::null_mut(); sys::napi_create_uint32(env, v, &mut out); out
}

/// Panic boundary: zero-cost on the happy path (measured), turns a Rust bug into a JS exception
/// instead of aborting the Vitest worker. Requires panic = "unwind".
#[inline(always)]
unsafe fn guard(env: sys::napi_env, f: impl FnOnce() -> sys::napi_value) -> sys::napi_value {
  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
    Ok(v) => v,
    Err(_) => { sys::napi_throw_error(env, ptr::null(), c"rsdom: internal panic".as_ptr()); ptr::null_mut() }
  }
}

unsafe extern "C" fn first_child(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  guard(env, || {
    let [node] = args!(env, info, 1);
    let id = get_u32(env, node);
    with_doc(|d| ret_u32(env, d.first_child(id)))      // d.first_child bounds-checks `id`
  })
}

#[napi(module_exports)]                                   // runs once per env (main thread or worker)
pub fn init(exports: Object, env: Env) -> Result<()> {
  const FNS: &[(&CStr, RawCb)] = &[(c"firstChild", first_child) /* , ... */];
  unsafe {
    for (name, cb) in FNS {
      let mut f = ptr::null_mut();
      sys::napi_create_function(env.raw(), name.as_ptr(), -1, Some(*cb), ptr::null_mut(), &mut f);
      sys::napi_set_named_property(env.raw(), exports.raw(), name.as_ptr(), f);
    }
  }
  Ok(())
}
```

Notes:

- `#[napi(module_exports)]` is the supported hook for touching the exports object
  (`napi-rs/examples/napi/src/lib.rs` L76-L81; the codegen is `napi-derive-backend-6.1.5/src/codegen/fn.rs` L53-L81).
  `Env` parameters are injected automatically.
- Use **fixed arity** and return `ptr::null_mut()` (`undefined`) when there is no result, which saves ~3-5 ns.
- Ignore `napi_status` on the hot path only where the failure mode is still memory-safe, for example
  `get_u32 -> 0 -> null node`. Every id that comes from JS **must be bounds-checked** in Rust. The facade is our
  code, but user code can call internal functions with garbage.
- Pass the `data` pointer of `napi_create_function` (`void*`) if a callback needs per-env state without TLS.
- `dyn-symbols` (a default napi feature, `napi-rs/crates/napi/Cargo.toml` `default = ["napi4","dyn-symbols"]`)
  routes every `napi_*` call through a static function-pointer table (`napi-sys-3.4.0/src/lib.rs` L1-L100). That is
  equivalent to a PLT call; the measured difference was within noise (32 ns vs 37 ns). Keep the default unless
  profiling says otherwise; it is required on Windows.

### 3.3 Handles

- The node handle is a `u32` index into the document arena, with **0 = null** (reserve slot 0). Never use a
  `0xFFFFFFFF` sentinel. Values above 2^31-1 become HeapNumbers when created (`napi_create_uint32`), measured at
  +8 ns and a GC allocation per return. Keep ids at or below 2^30 so they are Smis even under pointer compression.
- Multiple documents (DOMParser, `createHTMLDocument`, templates) can be handled two ways. One is to pack the doc
  index into the high bits (for example 8 bits doc + 24 bits node); the other is a thread-local "current document"
  that Rust switches when the JS facade calls into another document. Either way each call takes one u32 argument,
  which is cheaper than passing two (+7-9 ns per extra argument).
- Prefer `u32`/`bool` returns. `napi_get_boolean` returns cached singletons. `napi_create_double` allocates a
  HeapNumber for non-integral or out-of-Smi values.
- For multi-value results, write into a shared buffer (§5) instead of creating arrays or objects. Creating an object
  through Node-API costs ~400-500 ns (`napi_set_named_property` creates and internalizes the key string on every
  call; even cached keys plus `napi_set_property` go through V8's generic runtime path).

---

## 4. Strings

### 4.1 Rust to JS

- napi-rs `String`/`&str` `ToNapiValue` uses `napi_create_string_utf8` (`napi-rs/crates/napi/src/bindgen_runtime/js_values/string.rs`
  L20-L50, L89-L102). V8 must scan and decode UTF-8.
- Latin1 is a straight one-byte copy. `Latin1String`/`Utf16String` exist (string.rs L105-L280), but they own a `Vec`
  and go through the macro tax. Raw calls are better.
- Measured, short "DIV": latin1 41 ns, utf8 47-52 ns. At 123 B: latin1 51-54, utf8 70-76, utf16 81-83.
- **Rule:** keep every Rust string with an `is_ascii` bit (computed when the string is written; `str::is_ascii` is
  SIMD-fast). Emit **latin1 when ASCII**, otherwise utf16 if the string is stored as UTF-16, otherwise utf8. Most
  DOM test strings (class names, test ids, short text) are ASCII.
- **External strings** (`node_api_create_external_string_latin1/utf16`,
  `napi-rs/crates/napi/src/js_values/string/latin1.rs` L9-L60 and L353-L395) measured **slower** (167-180 ns at
  123 B). V8 allocates an ExternalString resource and tracks it, and it copies anyway for short strings and in
  sandbox or pointer-compression builds. They only make sense for large, immutable payloads such as a big `innerHTML`
  source or `<style>` text.
- `RawCString` (string.rs L288-L313) avoids allocation for C strings, but still costs the macro tax when returned
  from `#[napi]`.

### 4.2 Atoms and interning (largest win for names)

Tag names, attribute names, `type` values, roles and so on are **atom ids (u32)**.

- **Rust side.** Use a per-thread interner: `Vec<Box<str>>` plus `FxHashMap<Box<str>, u32>`, pre-seeded with all
  HTML tag and attribute names in a fixed order so the ids are compile-time constants.
  `string_cache`/`web_atoms` (used by html5ever) are fine for the parser, but their dynamic atoms go through a global
  set of `parking_lot::Mutex` buckets with SeqCst refcounts on clone and drop
  (`~/.cargo/registry/src/*/string_cache-0.11.0/src/dynamic_set.rs` L10-L90, `src/atom.rs` L308-L321). Convert
  html5ever `LocalName` into our u32 atom once per parsed element.
- **JS side.** Keep `const atoms = []` as a lazily filled mirror of the table: when `id >= atoms.length`, make one
  call `atomName(id)` and cache the result. Pre-fill the static atoms at load as one big string split on `\0`.
  `el.tagName` then becomes `atomsUpper[tagAtomView[id]]`, with zero crossings when the column is a view and one u32
  crossing otherwise.
- **JS to Rust names.** Keep `const atomIds = new Map()` keyed by string. `setAttribute(name, v)` looks the name up
  in JS (a Map hit on an internalized string costs ~10-20 ns) and passes a u32. Only unknown names cross as strings
  once, through `internAtom(str) -> u32`.
- Returning a string from Rust through a JS-held table is as fast as returning a u32 (29-33 ns) and avoids string
  creation entirely.

### 4.3 JS to Rust

- napi-rs `String: FromNapiValue` calls `napi_get_value_string_utf8` **twice** (once for length, once to copy), then
  heap-allocates (string.rs L51-L86). `JsString::into_utf8` does the same (`js_values/string/mod.rs` L97-L120).
  Measured cost: 150-260 ns.
- Raw: one call into a stack buffer, ~42-55 ns. Write the code like this:

```rust
unsafe fn with_str<R>(env: sys::napi_env, v: sys::napi_value, f: impl FnOnce(&str) -> R) -> R {
  let mut buf = [0u8; 512];
  let mut len = 0usize;
  sys::napi_get_value_string_utf8(env, v, buf.as_mut_ptr().cast(), buf.len(), &mut len);
  if len < buf.len() - 1 {                                   // fit (napi always NUL-terminates)
    return f(std::str::from_utf8_unchecked(&buf[..len]));   // V8 writes valid UTF-8 (lone surrogates -> U+FFFD)
  }
  let mut need = 0usize;                                     // slow path: query length, heap buffer
  sys::napi_get_value_string_utf8(env, v, ptr::null_mut(), 0, &mut need);
  let mut heap = vec![0u8; need + 1];
  sys::napi_get_value_string_utf8(env, v, heap.as_mut_ptr().cast(), heap.len(), &mut len);
  f(std::str::from_utf8_unchecked(&heap[..len]))
}
```

- `napi_get_value_string_latin1` is slightly faster, but it **silently truncates** code points above U+00FF. Use it
  only where the input is guaranteed one-byte, such as values from our own atom table. Use utf8 for user strings.
  Lone surrogates are replaced with U+FFFD by utf8 conversion; use utf16 if exact round-tripping of lone surrogates
  ever matters (it basically never does for DOM tests).
- Strings built by concatenation in JS are ConsStrings, and V8 flattens them on first conversion (a one-time
  allocation).
- For bulk input (for example a whole `innerHTML` payload), `TextEncoder.encodeInto` into a shared `Uint8Array` is an
  alternative, but for single short strings direct Node-API is already fine.

### 4.4 Module API version 10: cache JS strings in Rust (optional trick)

napi-rs does **not** export `node_api_module_get_api_version_v1`, so Node treats napi-rs addons as Node-API module
version 8 (`napi-rs/crates/napi/src/threadsafe_function.rs` L855-L858). At version 8,
**`napi_create_reference` rejects primitives**, so Rust cannot hold a reference to a JS string.

Exporting the symbol ourselves works with napi 3.14 (verified: `r_ret_cached` returns the cached string in 33 ns,
versus `undefined` without the export):

```rust
#[no_mangle]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 { 10 }
```

This also changes other version-gated behaviour in Node. Validate with the full test suite before relying on it. The
JS-side atom table gives the same speed without the trick, so treat it as optional.

---

## 5. Zero-copy memory between Rust and JS

### 5.1 External ArrayBuffer over Rust memory (fastest reads)

The Rust tree uses a structure-of-arrays layout: `Vec<u32>` columns `parent`, `first_child`, `last_child`,
`prev_sibling`, `next_sibling`, `local_name`, plus a `Vec<u8>` `node_type`. Each column is exposed once per
allocation:

```rust
unsafe extern "C" fn noop_fin(_: sys::napi_env, _: *mut c_void, _: *mut c_void) {}
// returns a Uint32Array over v[..len]; Rust keeps ownership (finalizer is a no-op)
unsafe fn view_u32(env: sys::napi_env, v: &mut Vec<u32>) -> Result<sys::napi_value, sys::napi_status> {
  let mut ab = ptr::null_mut();
  let st = sys::napi_create_external_arraybuffer(env, v.as_mut_ptr().cast(), v.capacity() * 4,
                                                 Some(noop_fin), ptr::null_mut(), &mut ab);
  if st != sys::Status::napi_ok { return Err(st) }        // napi_no_external_buffers_allowed under V8 sandbox
  let mut ta = ptr::null_mut();
  sys::napi_create_typedarray(env, sys::TypedarrayType::uint32_array, v.capacity(), ab, 0, &mut ta);
  Ok(ta)
}
```

- **Node 22 status: allowed.** `process.config.variables` reports `v8_enable_sandbox=0` and
  `v8_enable_pointer_compression=0` on v22.22.0, and the probe created and read external views successfully.
- **Electron** (sandbox on) returns `napi_no_external_buffers_allowed`. napi-rs handles this by falling back to a
  copying `napi_create_arraybuffer` in every `from_data`/`from_external` path
  (`napi-rs/crates/napi/src/bindgen_runtime/js_values/arraybuffer.rs` L195-L250 and L1160-L1230;
  `buffer.rs` L36-L90 calls this "the same path Electron uses"). A copy breaks the "view of live Rust memory" design,
  so rsdom must detect the status and switch to §5.3, never to a silent copy.
- Node may build with the sandbox or pointer compression in the future (experimental "pointer-compression" Node
  builds exist), so the fallback is worth keeping.
- **Vec reallocation is the hazard.** The view's pointer dangles after `push` grows the Vec. The defences are:
  1. **Reserve big capacity up front**, for example `Vec::with_capacity(1 << 20)` per column, which is 4 MB of
     *virtual* memory. Linux commits pages lazily, so reallocation essentially never happens in tests. Export views
     sized by **capacity** and read the live length from a header.
  2. **Generation counter.** Keep a small header `Uint32Array` with `[generation, nodeCount, ...]`, either
     JS-allocated or itself an external view of a `Box<[u32; 16]>` that never moves. When any column reallocates,
     Rust bumps `generation`. The JS facade checks `if (H[0] !== gen) refreshViews()` once per public DOM call; that
     check is one typed-array load (~1 ns).
  3. **Detach old views before freeing the old allocation.** Rust keeps a `napi_ref` to each exported ArrayBuffer
     and calls `napi_detach_arraybuffer` on the old ones during the reallocating call (env is available there).
     Verified on Node 22: after detach the view has `.length === 0` and reads `undefined`. A stale view is therefore
     a logic bug, never a use-after-free. napi-rs notes that V8 only allows detaching external buffers
     (arraybuffer.rs L365-L372), which is exactly our case.
- Creating multiple external ArrayBuffers over the same pointer: older Node versions hit a V8 backing-store registry
  CHECK, and napi-rs debug builds still panic on it ("Share the same data between different buffers is not
  allowed", arraybuffer.rs L200-L210, referencing nodejs/node#32463). Node 22.22 tolerated 1000+ duplicates in the
  probe, but **create exactly one view per allocation and cache it** anyway.
- Safety model: JS can *write* into these views. Rust must treat column contents as untrusted when it follows links,
  so use `get()` or check indices, never `get_unchecked` on ids read back from shared memory. There is no data race:
  JS never runs while Rust is inside a callback, unless Rust calls into JS, so never hold borrows across
  `napi_call_function`.
- At document teardown, detach all views **first** and then drop the Vec.
- External memory is invisible to V8's heap accounting. Call `napi_adjust_external_memory` with the arena size
  occasionally if GC pressure ever matters (it should not for per-file arenas).

### 5.2 JS-allocated ArrayBuffer, Rust writes into it

- `new ArrayBuffer(n)` is always off-heap with a stable backing store. Rust reads its pointer with
  `napi_get_arraybuffer_info` and pins it with `napi_create_reference(…, 1)`; the probe's `r_register_out` does
  exactly this. Rust can then write results into it in later calls without creating any JS values.
- Small typed arrays such as `new Uint8Array(16)` can start on V8's heap, but `napi_get_arraybuffer_info` forces them
  off-heap. The probe verified the pointer is stable across `gc()` after that. Prefer passing explicit `ArrayBuffer`s
  anyway.
- Measured use: "write all child ids of node X into the shared buffer, return count" took the tree walk from 78 to
  40 ns per node. Use the same pattern for `querySelectorAll` (write matching ids, return count), `childNodes`
  snapshots, `getBoundingClientRect` (f64 x4) and similar.

### 5.3 Resizable ArrayBuffer: portable, growable, stable pointer (the sandbox-safe primary option)

`new ArrayBuffer(initial, { maxByteLength })` (ES2024, available in Node 20+) makes V8 reserve virtual memory for
`maxByteLength` and commit pages in place on `resize()`. **Verified on Node 22.22: the data pointer from
`napi_get_arraybuffer_info` was identical at 4 KB, 1 MB and 256 MB.** Length-tracking views (`new Uint32Array(rab)`
without a length) grow automatically.

The columns can therefore live in JS-allocated resizable buffers that Rust manipulates through raw pointers:

- It works with the sandbox on (Electron, possible future Node).
- No generation counter is needed for growth: Rust or JS calls `rab.resize()`, which is rare and amortized doubling;
  Rust can call it through `napi_call_function` on the cached `resize` method.
- Memory is accounted to V8 as external ArrayBuffer memory.

Trade-off: the backing store is allocated by V8's allocator, not Rust's. Rust still owns the logic and all
non-column data (strings, attribute lists, selector caches), so the tree still "lives in Rust", but the raw columns
sit in V8-allocated pages. The sandbox reservation limit (on the order of a TB) is not a concern.

Recommendation:

- **Primary on Node 22:** external views over Rust `Vec`s with reserved capacity (§5.1), because Rust owns all the
  memory.
- **Fallback:** resizable JS buffers, selected automatically when `napi_create_external_arraybuffer` returns
  `napi_no_external_buffers_allowed`.
- Both expose the same `Uint32Array` interface to the facade.

### 5.4 Command buffers (writes)

JS can write `(op, a, b)` u32 triples into a shared `Uint32Array` and flush with one call, measured at ~3-6 ns per op.
React needs return values synchronously (`createElement` returns a node), so JS would have to **pre-allocate node
ids** (mirror the arena's next-id counter) and Rust would have to flush before any read that depends on Rust state.
That breaks synchronous exception semantics: `appendChild` cycles must throw `HierarchyRequestError` at call time, and
`setAttribute` must throw `InvalidCharacterError` for invalid names.

Keep this as a phase-2 optimisation. Direct raw calls (30-70 ns) are already 30-100x cheaper than jsdom or happy-dom
writes (1.9-6.6 µs).

---

## 6. GC integration and lifetimes

### Options ranked by cost

1. **Arena per document, no per-node GC (recommended).**
   - Nodes are freed only when the document is destroyed.
   - JS keeps wrappers in a dense array `wrappers[id]` (strong refs). Identity is exact and costs ~1-2 ns, and a
     wrapper is created lazily on first access.
   - Teardown: `destroyDocument(doc)` detaches the views, drops the arena (one free per column plus string heaps)
     and sets `wrappers.length = 0`.
   - Nodes removed from the tree stay allocated until teardown. A React test file creates thousands to hundreds of
     thousands of nodes, which is a few MB.
   - jsdom and happy-dom also keep wrappers alive while the tree references them, so this matches expected
     semantics: `el === el.parentNode.firstChild` holds.
2. **FinalizationRegistry (if long-running files ever leak too much).**
   - `registry.register(wrapper, id)` costs ~100 ns per wrapper.
   - Collected ids are pushed into a JS `Uint32Array` and freed in Rust in batches with one call per 4096 ids
     (probe `r_free_batch`).
   - A Rust node may only be freed when it has no wrapper, is detached from any tree, and is unreferenced by
     Rust-side structures (Range, NodeIterator, MutationObserver records, `form.elements` caches). That needs a
     refcount or a mark pass, so defer it.
   - With FinalizationRegistry the identity cache must not hold strong refs. That means a WeakRef array, which is
     slow (§2.5), or a mark scheme. A cheaper middle ground: keep strong refs only for nodes connected to the
     document and weak handling only for detached subtrees.
3. **`napi_add_finalizer` (~250 ns) or `napi_wrap` with a finalizer (~700 ns).** Avoid for per-node use.
   - These are fine for a handful of objects (the Document handle itself, a Rust-side `MutationObserver`).
   - Node 22 defers non-"pure" finalizers out of the GC pass, so there is extra latency before memory is freed.
4. **`#[napi]` class instances (~1.9 µs each plus ~330 ns per method).** Never use them for nodes.

### Environment and teardown wiring

- Vitest's built-in envs return `teardown()`, which calls `window.close()`
  (`vitest/packages/vitest/src/integrations/env/jsdom.ts` L169-L174, `happy-dom.ts` L4-L10 and L43-L44). rsdom's env
  does the same and calls `destroyDocument`.
- The default pool is **`forks`** (`vitest/docs/config/pool.md` L8-L9). Each child process `dlopen`s the `.node`
  once and runs many test files sequentially, so the arena-per-document model reuses allocator memory nicely,
  especially with mimalloc.
- `threads` pool: each worker is a separate Node env and thread, and `#[napi(module_exports)]` runs once per env.
  - Use **`thread_local!`** state, or `napi_set_instance_data` / napi-rs `Env::set_instance_data`, for documents
    and interners. **Never use process-global `static Mutex` state on hot paths**: it is contended across workers
    and it is exactly what makes napi-rs class methods slow.
  - Vitest's docs warn that some native libraries segfault in `threads` (pool.md L17). rsdom must be thread-safe in
    the sense of "no shared mutable statics".
- `vmThreads`/`vmForks`: the addon's JS objects belong to the main context, while the test globals live in a vm
  context. Create JS objects only in the facade, which is evaluated inside the test context, so `instanceof` and
  prototypes are right. Rust should never create user-visible JS objects (§3.3 says the same for speed reasons).
- Env exit: napi-rs registers an env cleanup hook (`napi-rs/crates/napi/src/bindgen_runtime/module_register.rs`
  ~L312-L330). Rust TLS destructors run at thread exit. Make sure no external ArrayBuffer outlives the memory it
  points to: detach on teardown, or deliberately leak the arena at process exit, which is harmless.

---

## 7. Build configuration

```toml
# rsdom/Cargo.toml
[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3.14", default-features = false, features = ["napi10"] }  # + "dyn-symbols" if building for Windows
napi-derive = "3.6"
mimalloc = { version = "0.1", default-features = false }

[build-dependencies]
napi-build = "2.6"

[profile.release]
opt-level = 3
lto = "fat"            # napi-rs's own workspace uses lto = true (refs: napi-rs/Cargo.toml [profile.release])
codegen-units = 1
panic = "unwind"       # keep: catch_unwind at the boundary is free; "abort" kills the Vitest worker on any bug
debug = false
strip = "symbols"

[profile.profiling]    # for `perf record` / samply
inherits = "release"
debug = "line-tables-only"
strip = "none"
```

```rust
// lib.rs
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;   // affects Rust allocations only, not Node's malloc
```

```rust
// build.rs
fn main() { napi_build::setup(); }
```

- **mimalloc**: napi-rs's own example offers `mimalloc-safe` and `snmalloc-rs` features
  (`napi-rs/examples/napi/Cargo.toml` `[features] mimalloc/snmalloc`). Expect gains for many small allocations
  (attribute value `String`s, `SmallVec` spills, selector parsing), not for call overhead. Memory handed to V8 as an
  external buffer is freed by our own finalizer and therefore by the same allocator, which is fine.
- **`panic = "abort"`** gives slightly smaller and faster code because there are no landing pads. The benefit is
  small; we measured no call-overhead difference attributable to unwind. Use it only for pure benchmark builds.
  Unwinding out of an `extern "C"` function aborts anyway (Rust ≥1.81), so raw callbacks need `catch_unwind` to get
  JS exceptions instead of aborts.
- **`target-cpu=native`** (`.cargo/config.toml`: `[target.x86_64-unknown-linux-gnu] rustflags=["-C","target-cpu=native"]`)
  makes the binary non-portable: it can SIGILL on another CI machine. Gains are limited to auto-vectorized loops;
  `memchr`/`simdutf`-style crates already do runtime dispatch. If wanted, use `-C target-cpu=x86-64-v3` as a portable
  middle ground. Changing RUSTFLAGS invalidates the whole cargo cache.
- **Local build with `@napi-rs/cli` (latest 3.10.8). Verified:**
  - `npm i -D @napi-rs/cli@3`
  - add `"napi": { "binaryName": "rsdom" }` to package.json
  - `npx napi build --release --platform -o <dir> [--manifest-path rsdom/Cargo.toml] [--features …] [--esm]`
  - This produces `<binaryName>.linux-x64-gnu.node`, an `index.js` platform loader and `index.d.ts`, with no
    publishing.
  - Raw `extern "C"` exports do **not** appear in the generated `.d.ts`, so hand-write a small `native.d.ts` for the
    internal API.
  - Without the CLI: `cargo build --release && cp target/release/librsdom.so rsdom.node`, then `require('./rsdom.node')`.
    For local experiments this is simpler and the CLI adds little.
- Build times on this box: a cold build of the napi-rs dependency set took ~22 s, and incremental builds with fat
  LTO about 6 s.

---

## 8. Crates

| Need | Crate (version in cargo cache) | Assessment |
|---|---|---|
| HTML parsing (`innerHTML`, `DOMParser`, initial document) | **html5ever 0.40.1** / markup5ever 0.40.0 / web_atoms 0.3.0 / tendril 0.5.1 | Spec-compliant tree builder. Implement `TreeSink` (`~/.cargo/registry/src/*/markup5ever-0.40.0/interface/tree_builder.rs` L137+) with `type Handle = u32` (a NodeId) over the arena. The trait takes `&self`, so wrap the arena in `RefCell` during the parse. `elem_name()` must return a borrowed `ExpandedName`, so keep the parser's own `QualName` per element in a side table during the parse, or store `LocalName`s. Convert atoms to rsdom u32 atoms in `create_element`. `<template>` contents need `get_template_contents`. Use `parse_fragment` for `innerHTML`. |
| CSS selector parsing and matching | **selectors 0.41.0** + **cssparser 0.38.0** (+ servo_arc, precomputed-hash) | Servo/Stylo's engine supports Level 4 (`:is`, `:where`, `:not(list)`, `:has`, `:nth-child(An+B of S)`), bloom filters and nth-index caches. Cost is integration: implement `SelectorImpl` (~10 associated types; atoms must implement `PrecomputedHash`), `Parser` (non-tree-structural pseudo-classes such as `:checked`, `:disabled`, `:focus`, `:hover`, `:enabled`, `:required`, `:read-only`, `:placeholder-shown`, `:focus-visible`, `:focus-within`) and `Element` (~30 methods, `selectors-0.41.0/tree.rs` L46-L183). Match with `matches_selector_list` (`matching.rs` L123) and `MatchingContext::new(...)` (`context.rs` L200). Cache parsed `SelectorList`s by selector string (testing-library re-queries the same selectors constantly, and happy-dom caches results too, §2.6). |
| (alternative) hand-written matcher | none | A ~600-line matcher for compound selectors (type/id/class/attribute ops) with descendant and child combinators plus a few pseudos covers most testing-library and jest-dom traffic and is easy to make atom-fast. Falling back to an "unsupported selector" error breaks user code. **Recommend `selectors`** for correctness, plus a fast path for the hottest simple selectors (`*`, `[data-testid="x"]`, `#id`, `tag`). |
| Interning | own `FxHashMap` + `Vec<Box<str>>` interner (rustc-hash 2.1.3 cached); `string_cache` 0.11 only at the html5ever boundary | See §4.2 for the global-mutex caveat on dynamic atoms. |
| Small vectors | **smallvec 1.16.3** | Attribute lists (`SmallVec<[Attr; 4]>`) and class lists. Child lists are linked through sibling columns, so no Vec is needed. |
| Arena / ids | plain `Vec` columns (SoA) + free list; **slab 0.4.12** if per-node free is needed | `indextree`/`slotmap` add generation and indirection overhead and use an AoS layout that cannot be exposed as typed-array columns. A hand-rolled SoA arena is both faster and view-friendly. Use a generation check only for debug builds or the FinalizationRegistry mode. |
| Hashing | **rustc-hash 2.1.3** (`FxHashMap`), **nohash-hasher 0.2.0** for u32 keys | `id`-attribute index (`getElementById`), atom maps. |
| Allocator | **mimalloc 0.1.52** | See §7. |
| UTF-16 lengths | std (`str::encode_utf16().count()`), or a cached per-string utf16 length | DOM APIs (`.length`, `substringData`, selection offsets) are UTF-16-indexed. Store an `is_ascii` flag so byte length equals UTF-16 length in the common case. |

---

## 9. Recommended binding architecture (summary)

```text
JS facade (plain classes, evaluated in the test's global/vm context)
  Node/Element/HTMLInputElement/... { _i: u32 }      wrappers[id] identity array
  atoms[] / atomIds Map                               header view H (generation, counts)
  column views: parent, firstChild, nextSibling, prevSibling, lastChild, nodeType, localName
        |   reads: views (0 crossings, ~1-5 ns)            writes and queries: raw calls (25-70 ns)
        v
Raw extern "C" Node-API callbacks (registered in #[napi(module_exports)])  -- no #[napi] on hot paths
        v
Rust core (thread_local per env): Document arena { SoA columns (reserved capacity), attrs, text, atoms,
  id index, selector cache }; html5ever TreeSink; selectors::Element impl; serializer
```

**Read paths:**

- `parentNode`, `firstChild`, `nextSibling`, `nodeType`, `tagName`, `localName`, `childNodes` iteration and
  `contains()` read the views directly.
- `getAttribute` is one call that returns a latin1 or utf8 string. The facade may cache the value per (node,
  attrVersion) if a per-node version column is exported.
- `textContent` is one call.
- `querySelectorAll` / `matches` / `closest` are one call each, writing ids into a shared out-buffer.

**Write paths:**

- `createElement(atomId)` returns an id.
- `appendChild` / `insertBefore` / `removeChild` take ids and return 0, or an error code that the facade turns into
  a `DOMException`.
- `setAttribute(id, atom, value)`.

**Events and mutation observers** can live in JS. Event dispatch needs the propagation path, which is a parent-chain
walk via views. Rust only reports what changed, for example through a mutation-record ring buffer in shared memory.

---

## 10. Pitfalls checklist

- `#[napi]` class methods cost ~300+ ns each because of the global `Mutex<HashMap>` borrow tracking (native_borrow.rs
  L25) and the type-tag check. Do not model nodes as `#[napi]` classes.
- `#[napi]` fns with arguments allocate an `Arc<Mutex<_>>` per call. Use raw callbacks for anything called per node.
- napi-rs addons are Node-API module version 8 by default, so `napi_create_reference` fails on strings and other
  primitives (threadsafe_function.rs L855-L858).
- `0xFFFFFFFF` or any id above 2^31-1 becomes a HeapNumber. Use 0 as null.
- `napi_get_value_string_latin1` truncates non-Latin1 input, so use utf8 for user-provided strings.
- External ArrayBuffers are forbidden under the V8 sandbox (Electron, maybe future Node). napi-rs silently copies in
  that case. Detect `napi_no_external_buffers_allowed` and switch to resizable JS buffers.
- A `Vec` reallocation invalidates exported views. Reserve capacity, bump the generation, and detach old buffers
  before freeing.
- Exporting the same memory as two ArrayBuffers crashed older Node versions, and napi-rs debug builds panic on it.
  Export one view per allocation.
- Shared views are JS-writable, so Rust must bounds-check every id it reads from them.
- `panic = "abort"` turns any Rust bug into a crashed Vitest worker with lost results. Prefer unwind plus
  `catch_unwind`.
- happy-dom caches `querySelectorAll` results, so a naive benchmark of repeated queries shows ~0.3 µs per query.
  Benchmarks must mutate between queries or measure cold queries.
- WeakRef-based identity caches are slow in synchronous loops because of KeepDuringJob. Use a dense array.
- Node-API object creation (`napi_create_object` + properties) costs ~400-500 ns. Never build result objects in Rust;
  return ids or counts and let JS build objects.
- Do not use process-global statics on hot paths: Vitest `threads` pools run several envs in one process.
- Creating JS objects in Rust under `vmThreads` gives them the wrong realm (prototypes and `instanceof`). Keep object
  creation in the facade.
