# Area C status: window/globals, Vitest environment, MutationObserver, counters, benchmark harness

Branch `feat/area-c-window-env-bench`. ROADMAP M6 (window, globals, Vitest environment, MutationObserver; not
getComputedStyle, which is area A), the M7 counters item and the M8 harness. Selectors/style are area A,
events/forms/focus area B.

## What is implemented

**MutationObserver** (`src/mo.rs`, `packages/oxidom/lib/mo.cjs`; DESIGN §9)
- `observe` is O(1): one registration in `MoState.regs`, the `OBSERVED` meta bit on the target, an env-wide
  registration count. No subtree walk (happy-dom walks the subtree on every `observe`; DTL's `waitFor` calls it
  on every wait). `disconnect` is O(nodes that observer registered on).
- Zero cost without registrations: every `queue_*` hook returns after one load, and `replaceData` does not
  even copy the old data (`mo::active`). The registration count is env-wide instead of `DocData.observers`
  (cheaper to test, and it stays correct when an observed node is adopted into another document);
  `DocData.observers` is unused.
- With registrations: one walk over the target's inclusive ancestors (table reads; a hash lookup only on nodes
  with `OBSERVED`), DOM "queue a mutation record" semantics (subtree, childList, attributes, attributeFilter,
  attributeOldValue, characterData, characterDataOldValue, implied attributes/characterData), one record per
  interested observer in a per-observer queue (node lists and old values in per-observer pools).
- Transient registered observers (DOM "remove" step 13) in a flat list, marked by meta bit 26 (`mo::TRANSIENT`,
  area C range) so the list is only scanned for nodes that carry one; removed per observer at its notification
  turn, on re-observe of the source and on disconnect. jsdom 30 does not implement them (asserted divergence).
- Parser inserts produce one record per `innerHTML`/`textContent` set (foundation's single tree operation).
- Delivery: `rt.mutated()` sees `EP[MO_PENDING]` and the facade queues ONE microtask per burst (Node's
  `queueMicrotask`, captured at load). The microtask runs DOM "notify mutation observers" with
  `moTake(after, max)`: each crossing takes the queue of the next observer (creation order = id order) that
  has records and drops the transient registrations of the observers it passed, so records queued by an
  earlier callback reach later observers in the same round and observers created during delivery wait.
  Crossings per delivery = observers with records + 1. `takeRecords()` = `moRecords(id)`.
- `MutationRecord` is a view over the drained words of its batch (one `Uint32Array` copy per delivery):
  NodeLists, wrappers and attribute names are built on first read (DTL's `waitFor` never reads them); after an
  env reset a held record reads as empty. Callback exceptions go to the window's error reporting (area B's
  `reportException`: `error` event, then `process.emit('uncaughtException')`).
- Cost (release, this VM, noisy): queueing ~100 ns per record in Rust (`cargo test --release --lib
  mo::tests::cost_probe -- --ignored --nocapture`); append + remove under a subtree observer incl. building the
  records with `takeRecords()` ~1.2 us per pair vs ~0.6 us without an observer (jsdom ~10 us, happy-dom ~9 us).

**Window and globals** (`packages/oxidom/lib/window.cjs`; DESIGN §12)
- `makeWindow` installs onto `options.global` (the Vitest environment passes `globalThis`) or builds a
  null-prototype object (`createWindow()`). Every member is an own DATA property (writable, configurable;
  non-enumerable on the global, like `populateGlobal`'s).
- Every interface constructor in `rt.classes` is installed generically, so areas A/B classes (Event classes,
  `Option`, `Image`, `CSSStyleDeclaration`, `DOMTokenList`, ...) appear without edits here. On a branch without
  area B, dom.cjs's bare `EventTarget` never shadows Node's global one.
- `window/self/top/parent/frames` = the window, `document.defaultView === window`, `opener`/`frameElement`
  null, `origin`, `Location` (http://localhost:3000/ or `options.url`; fragment navigations and
  `history.pushState/replaceState` change the URL and `document.URL`; other navigations are not implemented,
  like jsdom), `History`, `Navigator` (UA `Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko)
  oxidom/0.1.0`: no Chrome/Firefox token), `Screen` (jsdom parity: sizes 0), `localStorage`/`sessionStorage`
  (`Storage`), `matchMedia` (`MediaQueryList`, `matches` always false: no media-query evaluation),
  `requestAnimationFrame`/`cancelAnimationFrame` on Node timers (16 ms, numeric ids, cancelled at teardown,
  callback errors reported on the window), `getComputedStyle` (area A's `rt.getComputedStyle`; a stub returning
  '' for every property when absent), `getSelection` + `document.getSelection` (a `Selection` stub with
  anchor/focus, collapse, ranges), `CSS.escape` (CSSOM serialize-an-identifier) and `CSS.supports` (area A's
  property table), `FormData(form, submitter)` (subclass of Node's FormData filled from area B's
  `formEntries`; on `createWindow()` resolved on first access), `innerWidth` 1024 / `innerHeight` 768 /
  outer sizes / `devicePixelRatio` 1 / scroll offsets 0, no-op `scrollTo`/`scroll`/`scrollBy`/`alert`/
  `print`/`focus`/`blur`/..., `confirm` false, `prompt`/`open` null.
- Document additions: `location`, `cookie` (per-document jar: name=value, max-age/expires deletion),
  `referrer` '', `domain`, `hidden` false, `visibilityState` 'visible', `scrollingElement`, `getSelection`.
- The window EventTarget is area B's `installWindow(win, document)` (a no-op stub when events.cjs lacks it);
  Vitest's `catchWindowErrors` equivalent routes unhandled window `ErrorEvent`s to `uncaughtException` once.
- Kept as Node's: timers, `setImmediate`, `queueMicrotask`, `performance`, `console`, `AbortController`/
  `AbortSignal`, `MessageChannel`, typed arrays, `Blob`, `File`, `URL`, `fetch`, `crypto`, `DOMException`,
  `structuredClone`. Not defined (feature detection must not be fooled): `customElements`, `ResizeObserver`,
  `IntersectionObserver`, `DataTransfer`, `requestIdleCallback`, `TextEvent`, `reportError`, `documentMode`.
- `__oxidom` (non-enumerable diagnostics): `moStats` (ticks / takes / records), `counters()`, flags.

**Vitest environment** (`packages/oxidom/lib/vitest-environment.mjs`; docs/lab/research/vitest-env.md)
- `{ name: 'oxidom', viteEnvironment: 'client', prewarmModules: false, setup(global, options) -> { teardown } }`.
  Facade and addon via `createRequire(import.meta.url)`; tests reach oxidom only through globals.
- Options `environmentOptions.oxidom = { url, html, shared, memo, prefilter, counters }`; `OXIDOM_SHARED=0`,
  `OXIDOM_NO_MEMO=1`, `OXIDOM_NO_PREFILTER=1`, `OXIDOM_COUNTERS=1` win (set before the facade loads in the worker).
- Teardown: window error routing removed, animation frames cancelled, every global the window defined restored
  to its original descriptor (only the keys it defines are read: a whole-global descriptor snapshot would
  trigger Node's lazy web globals), then `rt.reset()` (one `destroy`, every wrapper neutered). With
  `OXIDOM_COUNTERS=1` the worker's counters are appended as one JSON line to `OXIDOM_COUNTERS_OUT`.
- Setup cost (bare process, integrated build): ~66 ms including module loading; area A's `style.cjs`
  install is ~24 ms of it, the window itself a few ms (~25 ms in total on the C branch alone).

**Counters** (`src/counters.rs`, cargo feature `counters`)
- The `natives!` macro (foundation, cfg-gated lines only) times each call from argument reading to result
  conversion and counts it per native in `Env.counters` (one pointer-keyed hash update). `counters()` returns
  `{"enabled","calls","ns","fns":{name:[calls,ns]}}`; `countersReset()`; `countersEnabled()`. Without the
  feature no timing code is emitted and `Counters` is zero-sized.
- `npm run build:counters` builds into `native/counters/` (own target dir); the environment loads it when
  `OXIDOM_COUNTERS=1`.

**Benchmark harness** (`bench/README.md`)
- `bench/micro/run.mjs`: every case in one fresh process per DOM, warm-up + median of >= 7 samples, JSON +
  markdown, n/a with a reason when an API is missing; all DESIGN §13 micro rows plus React render/update and
  Testing Library role queries through each DOM's Vitest environment.
- `bench/e2e/run.mjs` + `phase-reporter.mjs`: the app suite N times per DOM, interleaved, per-phase sums,
  per-file times, matrix forks / threads / threads+isolate:false / serial, oxidom ablations, "common passing
  files" accounting, optional counters run.

## Tests

- `test/contract/mo.test.mjs` (jsdom oracle): record shapes for every mutation kind (append/insert/remove with
  siblings, replaceChild, remove(), before/after, replaceChildren, moves, fragments, innerHTML/textContent,
  attributes with old values / same-value sets / toggleAttribute / filters / namespaces, characterData via
  data/appendData/replaceData/nodeValue/textContent/splitText, non-ASCII old values), options validation,
  re-observe, creation order, cross-observer delivery within one round, takeRecords/disconnect, transient
  observers, record objects, throwing callbacks. happy-dom's MO diverges almost everywhere (documented in the
  file): it only runs a delivery smoke test.
- `test/contract/window.test.mjs`: location, history, storage, cookies, navigator, geometry, selection stub,
  rAF, interfaces (happy-dom divergences pinned).
- `test/native/mo.test.mjs`: zero cost without observers, O(1) observe (no wrappers created), one microtask
  and observers-with-records + 1 crossings per delivery, OUT overflow for 300k removed nodes, reset.
- `test/native/vitest-env.test.mjs`: Environment shape; setup/teardown on a stand-in global restores every
  descriptor and neuters the DOM; the fixture `test/fixtures/vitest-env` (globals, window plumbing, DTL
  `waitFor`/`findByText` through MO with a 10 s polling interval, three files sharing one DOM) under forks,
  threads, threads + `isolate: false` + 1 worker, and `OXIDOM_SHARED=0`.
- Rust unit tests in `src/mo.rs` (records, filters, old values, transients per observer, re-observe,
  disconnect, take ordering/range, invalid arguments) and `src/counters.rs`.
- Everything green with `OXIDOM_SHARED=0`; `cargo clippy --all-targets -D warnings` (also with
  `--features counters`), `cargo fmt --check`, `cargo test`.

## Integration preview (A + B + C)

Not committed as code: the area A (`cd0951b`) and area B (`97750fa`) branch diffs applied on top of this branch
in a scratch copy, built and tested:
- the full oxidom suite (26 files, 661 tests) passes, also with `OXIDOM_SHARED=0`;
- `DOM_ENV=oxidom npx vitest run src/__tests__/Counter.test.tsx` passes (7/7);
- the app suite: **89/90** under forks+isolate, threads, threads+isolate:false, and 1 worker, and with
  `OXIDOM_SHARED=0`, `OXIDOM_NO_MEMO=1 OXIDOM_NO_PREFILTER=1`. The one failure is area B's: jest-dom
  `toHaveDisplayValue` does `Array.from(select)`, which needs `select.length` + indexed access (B's documented
  "`select[index]` not implemented");
- the vitest-env fixture including DTL `waitFor`/`findByText` resolving via MO (13/13).
Results of that build: `bench/results/preview/` (see below).

### Preview results (`bench/results/`, noisy shared VM: indicative only)

DESIGN §13 rows, predicted vs measured (median of 7; jsdom / happy-dom / oxidom):

| # | operation | predicted oxidom | jsdom | happy-dom | oxidom | verdict |
|---|---|---|---:|---:|---:|---|
| 1 | create + append + remove | 0.15-0.3 us | 4.35 us | 1.85 us | 0.87 us | win 2.1x vs happy-dom; prediction missed (JS facade + fresh memory per node) |
| 2 | setAttribute | 70-120 ns | 617 ns | 1418 ns | 156 ns | win 4x |
| 3 | bottom-up build, 1001 nodes, depth 200 | 0.1-0.3 ms | 84.5 ms | 6.4 ms | 0.65 ms | win 9.8x (prediction missed 2x) |
| 4 | DFS walk (steady / interleaved) | 8-15 ns/node | 159 / 187 | 68 / 85 | 18 / 19 | win 3.8-4.5x |
| 6 | getAttribute unchanged | 60-100 ns, lose 2x | 192 ns | 28 ns | 105 ns | **lose 3.7x** vs happy-dom (crossing), win vs jsdom |
| 7 | hasAttribute unchanged | 45-70 ns, lose 1.5x | 196 ns | 23 ns | 62 ns | **lose 2.7x** vs happy-dom |
| 9 | DTL role selectors, matches() | 3-10 ns prefiltered | 2695 ns | 137 ns | 24 ns/call | win 5.8x (JS prefilter effect, area A) |
| 10 | qSA cold, 2.7k-element table | 20-80 us | 3374 us | 2260 us | 59 us | win 38x |
| 11 | qSA warm, no mutation | 0.3-0.6 us (memo) | 180 us | 0.30 us | 12.7 us | **lose 43x** vs happy-dom (it returns a cached list; oxidom builds a fresh 300-item NodeList per hit) |
| 12 | getComputedStyle cold after mutation | 0.1-1 us | 522 us | 1271 us | 2.6 us | win 200x (prediction missed 2.5x) |
| 13 | focus() | 0.3-1 us | 178 us | 9.7 us | 1.4 us | win 6.8x |
| 14 | MouseEvent dispatch, 20 levels | parity | 20.2 us | 16.2 us | 3.4 us | win 4.7x (pure JS design, area B) |
| 15 | innerHTML set, 300 rows | 3-8x vs jsdom | 47.3 ms | 49.1 ms | 3.4 ms | win 14x |
| 16 | outerHTML get | 1-3 ms | 1.59 ms | 4.08 ms | 0.17 ms | win 9.4x |
| 17 | env setup (fresh process) | 15-40 ms | 739 ms | 296 ms | 66 ms | win 4.4x; a non-Rust effect (facade size, data-property globals); 24 ms of it is area A's style install, ~25 ms on the C branch alone |
| 18 | MO observe + disconnect, 4k subtree | ~50 ns | 2.4 us | 988 us | 0.44 us (±166%, GC) | win 5.4x vs jsdom, 2200x vs happy-dom |
| 18b | append + remove under a subtree observer (+ records) | - | 9.8 us | 8.3 us | 1.29 us | win 6.5x |
| 18c | 50 append/remove pairs -> one MO delivery | - | 472 us | 365 us | 70 us | win 5.2x |
| 19 | memory per retained div | ~0.3 KB | 1994 B | 6582 B | 364 B RSS (98 B V8 heap) | win 5.5x |
| - | React 19 createRoot + render 1000 rows / update | - | 189 / 58 ms | 254 / 75 ms | 74 / 45 ms | win 2.6x / 1.3x (React's own work dominates updates) |
| - | DTL getAllByRole('row'), 1000 rows / getByRole(name) | - | 278 / 226 ms | 15.0 / 18.3 ms | 2.6 / 6.5 ms | win 5.7x / 2.8x |

Whole suite (`e2e/react-app/`, 3 workers; oxidom 89/90, "common" = the 10 files passing everywhere), medians:

| config | jsdom wall | happy-dom wall | oxidom wall | tests (common) jsdom / happy / oxidom | environment Σ jsdom / happy / oxidom |
|---|---:|---:|---:|---|---|
| forks + isolate (default) | 13.3 s | 10.8 s | **4.9 s** | 20.9 / 14.3 / 5.0 s | 10.2 / 4.7 / 1.7 s |
| threads + isolate | 13.0 s | 10.9 s | **5.0 s** | 20.3 / 14.3 / 5.1 s | 9.3 / 4.3 / 1.4 s |
| threads, isolate: false | 11.6 s | 9.9 s | **3.8 s** | 16.1 / 12.2 / 4.1 s | (Pitfall A) |
| threads, isolate: false, 1 worker | 16.5 s | 13.6 s | **5.3 s** | 13.3 / 10.7 / 2.9 s | 0.71 / 0.30 / 0.11 s |

- oxidom is ~2.7x faster than jsdom and ~2.2x faster than happy-dom in wall time with the default pool
  (prediction: 2-2.5x / 1.5-2x), ~3.1x / 2.6x serially. DataTable.heavy: 11.5 s / 9.4 s / 2.6 s.
- Ablations (serial, tests (common)): all shortcuts on 2.95 s; `OXIDOM_SHARED=0` 3.37 s (+14%);
  `OXIDOM_NO_MEMO=1` 3.00 s; `OXIDOM_NO_PREFILTER=1` 2.97 s; all off 3.06 s. The JS memo and prefilter are worth
  little end to end; the zero-copy table ~10-15%; the bulk of the win is Rust-side algorithms plus the JS
  design of events and records (dispatch is pure JS in every DOM).
- Environment phase: oxidom pays ~140-170 ms per file under 3 parallel workers and ~110 ms serially, although
  the environment itself sets up in ~66 ms in a bare process (micro row 17): the rest is Vitest loading a
  *path* environment through its Vite module runner. Built-in environments skip that; publishing oxidom as a
  `vitest-environment-oxidom` package (externalized, ROADMAP M6 P1) should remove most of it.
- Native crossings (counters build, forks run): 634k native calls, 221 ms inside natives in total (incl.
  ~13 ms of timer overhead), 464k calls / 157 ms of them in DataTable.heavy. Prediction: ~1.5M calls,
  0.06-0.15 s. Fewer calls than predicted (zero-FFI table reads and memos absorb more), more time per call;
  top: `setAttr` 103k calls at 569 ns average (vs ~156 ns in the micro: MutationObserver records while
  `waitFor` observes, plus style/forms hooks; an M9 profiling target), `qsa` 5.4k x 5.3 us, `createElement`
  99k x 278 ns, `appendChild` 101k x 209 ns, `csCore` 10k x 1.8 us.

## Divergences and decisions (documented)

- Transient registered observers and the namespaced-attribute `attributeFilter` rule follow the DOM spec;
  jsdom 30 lacks the former and matches filters against local name OR namespace (asserted per DOM).
- `MediaQueryList.matches` is always false; `Selection` is a stub (no Range mutation, no selection changes
  from focus or typing); navigation other than fragments / `pushState` is not implemented (jsdom parity).
- `screen` sizes are 0 (jsdom parity; happy-dom reports 1024x768).
- A `MutationRecord` held across `rt.reset()` reads as empty; a held wrapper is neutered (foundation).
- `DocData.observers` is unused (env-wide registration count, see above).

## Cross-area contracts

- AREA A: `rt.getComputedStyle` (installed as `window.getComputedStyle`, unbound), `rt.N.cssProp` (used by
  `CSS.supports`), `rt.classes.*` (installed generically). Perf note: `style.cjs` install takes ~24 ms per
  environment setup (generated CSSOM accessors), the largest single cost of oxidom's env setup.
- AREA B: `require('./events.cjs').installWindow(win, document)` (window EventTarget, `event`, on* handlers),
  `events.reportException(win, err)` (rAF / MO callback errors), `require('./forms.cjs').formEntries(form,
  submitter)` (FormData override), `rt.classes` Event classes / `Option` / `Image` / `HashChangeEvent`
  (fragment navigation fires `hashchange` when present). Requests: `select` indexed access + `length` for
  `Array.from(select)` (jest-dom `toHaveDisplayValue`, the last app failure); `reportException` sets
  `win.reporting` on the window (with the Vitest environment that is a stray global; a WeakSet would avoid it).
- ALL: every facade method that can make Rust queue MutationObserver records must end with `rt.mutated()`
  (that is where delivery is scheduled); records queued by a native without it are delivered at the next
  `rt.mutated()` of any mutation.
- Foundation touches (cfg-gated / minimal): `natives!` macro timing lines (`#[cfg(feature = "counters")]`),
  `Env.counters` field + `counters()` body (env.rs), `pub mod counters` (lib.rs), the parse.rs MO test now
  counts records through the real natives.

## Not done

- The `vitest-environment-oxidom` package alias for `@vitest-environment oxidom` docblocks (ROADMAP M6 P1).
- Final M8 numbers on the merged build (the preview numbers come from a scratch integration while other
  agents shared the 4 CPUs).
