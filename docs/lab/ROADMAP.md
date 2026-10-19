# rsdom roadmap

> Lab record: milestones M0-M9 are complete. The current roadmap is [`../ROADMAP.md`](../ROADMAP.md).

The architecture is in `docs/DESIGN.md`: a Rust arena, raw N-API calls, a read-only zero-copy node table, and a JS facade. Milestones are ordered, and each one is done only when its acceptance criteria pass.

Priority tags:
- **P0** is required for the app suite.
- **P1** is needed for realistic RTL usage beyond the app.
- **P2** is nice to have.

Paths under `refs/` are relative to `refs`.

**Scope:** React 19 + @testing-library/react, dom, jest-dom and user-event, running under Vitest 5. The subject is `e2e/react-app/`: 11 files and 90 tests, all green on jsdom 30.1.3 and happy-dom 21.0.3.

**Testing before M6.** The facade exposes `createWindow()` for plain Node. `test/contract/*.test.js` uses an adapter `makeWindow('jsdom'|'happy-dom'|'rsdom')` and runs in Vitest's `node` environment. Every behavioural assertion is checked against all three DOMs. A case jsdom and happy-dom disagree on gets a comment and is pinned to jsdom.

---

> **Update (gap analysis, docs/PARITY.md §3):** the library study found TreeWalker/NodeFilter referenced by 7 of 20 popular libraries and blocking 4 of them (Radix Dialog, Headless UI, react-aria, lit), so the "no target library uses them" rationale below no longer holds. The prioritised parity roadmap now lives in docs/PARITY.md §3.2.

## Out of scope (explicit)
- Shadow DOM, slots, event retargeting, custom elements and `customElements`.
- Iframes and multiple windows (only the `HTMLIFrameElement` constructor exists), window named properties, navigation and history beyond a stub location.
- Script execution (`<script>` never runs), `eval` of inline handlers, `runScripts`.
- Layout and geometry: all geometry is zero, `getBoundingClientRect` returns zeros, and there is no `elementFromPoint`.
- XML documents and XPath, TreeWalker and NodeIterator (no target library uses them), DOMImplementation beyond `createHTMLDocument`.
- CSS: no media-query evaluation, no animations or transitions, no pseudo-element styles (`::before`/`::after` return content `none`), no `@import`/`<link rel=stylesheet>` loading, and no `CSSStyleSheet`/CSSOM rule APIs beyond what `<style>` matching needs.
- contentEditable editing, `execCommand`, full Range mutation (only basics plus `createContextualFragment`), Selection beyond a stub with anchor/focus.
- Canvas, media playback, WebSocket and XHR (Node's `fetch` is kept), DataTransfer (deliberately absent so DTL uses its fallback).
- Vitest vm pools (`setupVM`), the V8-sandboxed external-buffer path beyond the crossing-getter fallback, Electron.
- Batched or write-behind mutation (rejected in DESIGN §0).
- Per-node memory reclamation within one environment.

---

## M0: Crate, napi skeleton and build
- [x] `rsdom/` cargo crate with release profile `lto=fat`, `codegen-units=1`, `opt-level=3`, `panic=unwind`. Crate versions pinned exactly after `cargo search`. (mimalloc was dropped after the foundation review: it crashed sequential worker threads and was slower here, DESIGN §15.1.)
- [x] `build.rs` generates the static atom table, tag-to-interface table, the `FNS` function table, `packages/rsdom/lib/generated/atoms.cjs` and `packages/rsdom/lib/generated/native.d.ts`.
- [x] `cb!` macro (implemented as `natives!`, which also emits each module's registry entry): fixed-arity `napi_get_cb_info`, `&mut Env` from the data pointer, `catch_unwind` guard, debug re-entrancy counter. `args` module with primitive readers only.
- [x] `init(EP, OUT)` returns the external node-table ArrayBuffer, or `null` if `napi_no_external_buffers_allowed`. Also `nodeTable`, `bindOut`, `outRefill`, `destroy`.
- [x] Table growth (detach the old AB, bump `EP[GEN]`) and the OUT overflow protocol (pending, `EP[OUT_NEED]`, JS resize, refill).
- [x] `napi build --release --platform -o packages/rsdom/native` works, and `npm run build` in `rsdom/` builds the addon.

**Acceptance**
- [x] Microbench gate: a raw u32 crossing takes ≤ 35 ns, a getAttr-shaped call (2×u32 in, latin1 out) ≤ 90 ns, and a JS table-read walk ≤ 10 ns/node. If a gate fails, stop and investigate. Record the results in `bench/micro/m0-gates.txt`.
- [x] A forced-growth test (capacity 64) leaves stale views at length 0 and the remap is correct. The overflow test returns 1M ids correctly. `destroy()` followed by a new init works ten times in one process.
- [x] A Rust panic in a test-only fn becomes a JS `Error` and the process keeps running.
- [x] Under `pool: 'threads'` with 3 workers, the Envs are independent, with no shared statics.
- [x] RSS after `init` grows by less than 1 MiB (lazy commit verified).

**Status (M0 done):** gates in `bench/micro/m0-gates.txt` (raw crossing 28-34 ns, getAttr 56-68 ns,
table walk 5 ns/node, init RSS +0 KiB). Threads independence is tested with `worker_threads` directly
(`test/native/m0.test.mjs`); the Vitest `pool: 'threads'` run itself needs the M6 environment.

## M1: Core tree (Document, Element, Text, Comment, Fragment, mutation, attributes)
**P0 APIs**
- `createDocument`, plus `document.documentElement`, `head` and `body`
- `createElement` and `createElementNS` (SVG and MathML, with case kept), `createTextNode`, `createComment`, `createDocumentFragment`
- `appendChild`, `insertBefore`, `removeChild`, `replaceChild` and `remove`, with move and adopt semantics, fragment insertion, and pre-insert validation order following jsdom `Node-impl.js`
- Tree getters: `parentNode`, `parentElement`, `firstChild`, `lastChild`, `previousSibling`, `nextSibling`, `childNodes` (live, SameObject), `children`, `firstElementChild`, `lastElementChild`, `nextElementSibling`, `previousElementSibling`, `childElementCount`, `hasChildNodes`, `contains`, `getRootNode`, `isConnected`, `ownerDocument`
- Node facts: `nodeType`, `nodeName`, `tagName` (uppercase in HTML documents), `localName`, `namespaceURI`, `prefix`
- `nodeValue`, `data`, `length`, `textContent` set on CharacterData
- Attributes: `getAttribute`, `setAttribute` (lowercase on HTML, case kept on SVG), `removeAttribute`, `hasAttribute`, `toggleAttribute`, `getAttributeNames`, `setAttributeNS` (xlink and xml), `attributes` (NamedNodeMap, stable Attr), `getAttributeNode`
- Reflection: `id`, `className`
- Node constants on both Node and Node.prototype
- JS: the `W[]` identity table, TOKEN-guarded classes with exact `constructor.name` and `Symbol.toStringTag`, all ~70 HTML*Element classes (`HTMLUnknownElement` only for unknown tags), and zero-FFI getters from the table
- The crossing-getter fallback set (`RSDOM_SHARED=0`)

**P1:** `compareDocumentPosition`, `isEqualNode`, `isSameNode`, `cloneNode(deep)`, `importNode`, `adoptNode`, `normalize`, `splitText`, `replaceChildren`, `before`/`after`/`replaceWith`/`prepend`/`append`, `appendData`/`insertData`/`deleteData`/`replaceData`/`substringData` (UTF-16 offsets).

**Acceptance**
- [x] The tree and attribute oracle tests ported from docs/lab/research/jsdom.md §6.1-6.7 pass on rsdom and jsdom: validation order, `insertBefore(n, n)` no-op, moves, live-collection iteration while removing (2 of 4 skipped), attribute order, and same-value `setAttribute`.
- [x] The prototype and identity contract tests pass on all three DOMs: `el === el.parentNode.firstChild`, expandos survive, `Object.prototype.toString(div) === '[object HTMLDivElement]'`, `Node.prototype.ELEMENT_NODE === 1`.
- [x] proptest: 10k random op sequences give identical trees in Rust and in the reference model, with `debug_assert` link invariants holding. The contract tests also pass with `RSDOM_SHARED=0`.
- [x] Bottom-up detached build of 1001 nodes at depth 200 takes under 1 ms.

**Status (M1 done, P0 + all P1):** contract suites `packages/rsdom/test/contract/{tree,attributes,prototype}.test.mjs`
(green on jsdom and rsdom, happy-dom divergences pinned), `crates/rsdom/tests/prop_tree.rs` (10k by default, 100k
verified with `--release`). Bottom-up build: 0.4-1.7 ms per run, median 0.97 ms (`bench/micro/m1m2.txt`); it
is bound by first-touch page faults in this VM (~2 µs per 4 KiB page, nodes are never reclaimed), so single
runs can exceed 1 ms. Divergence from jsdom by design: MathML elements are `MathMLElement`.

## M2: Parse and serialize (innerHTML, outerHTML, textContent)
**P0 APIs**
- `innerHTML` set: html5ever fragment parsing into the arena, covering tables, void elements and `<template>` content. Scripts never run.
- `innerHTML` and `outerHTML` get: a serializer with correct escaping.
- `textContent` get and set on every node type: replace-all, `null` becomes `''`, and a Document returns `null`.
- `document.body.innerHTML = ''`, which RTL cleanup relies on.

**P1:** `outerHTML` set, `insertAdjacentHTML`, `DOMParser.parseFromString(text/html)`, `Range.createContextualFragment` (RTL `asFragment`), `document.implementation.createHTMLDocument`, `template.content`.

**P2:** `innerText`/`outerText` as an alias of textContent.

**Acceptance**
- [x] Round-trip parse and serialize matches jsdom on a corpus of at least 40 snippets: tables, entities, void elements, SVG, comments, attribute escaping, `<template>`, non-ASCII.
- [x] Parser inserts create no wrappers and produce one MO record per `innerHTML` set. End-to-end delivery is verified in M6.
- [x] Serializing 3.6k elements takes ≤ 3 ms.

**Status (M2 done, P0 + P1; P2 innerText/outerText aliases done):** 60-snippet corpus + 12 context cases + 6
DOMParser documents match jsdom (`packages/rsdom/test/contract/parse-serialize.test.mjs`); one documented divergence
(html5ever implements the 2025 customizable-`<select>` parser rules). Serializing the 300-row table (2.7k
elements, ~3.6k nodes) takes ~0.12 ms; parsing it ~5 ms (jsdom ~48 ms). "One MO record per innerHTML set" is
verified against the stub record accounting in `src/mo.rs` (end-to-end delivery is M6).

## M3: Selectors (querySelector(All), matches, closest, getElementsBy*)
**P0 APIs**
- `querySelector` and `querySelectorAll` on Document, Element and DocumentFragment, plus `matches` and `closest`.
- Selector syntax: `*`, type, `#id`, `.class`, `[a]`, `[a=v]` (quoted and unquoted), `[a~=v]`, `:not()`, descendant and child combinators, selector lists returned in document order without duplicates, `:checked`, `:disabled`, `:focus`.
- `getElementById` through the id map (first match in tree order).
- The JS `SEL` cache, the corrected tag prefilter (DESIGN §6.3), and the zero-FFI `input.type` from table state bits.
- Unsupported syntax throws SyntaxError.

**P1:** `^= $= *= |=`, `[a=v i]`, `:is/:where/:has`, `:nth-child/:first-child/:last-child/:only-child`, sibling combinators `+ ~`, `:enabled :required :read-only :placeholder-shown :empty :root :scope :focus-within`, live `getElementsByTagName`/`getElementsByClassName`/`getElementsByName`, and the epoch-validated qSA LRU memo (`RSDOM_NO_MEMO` to disable).

**P2:** custom right-to-left fast compiler, positive-only attribute bloom for `hasAttribute`/`matches`.

**Acceptance**
- [x] The 113 aria-query role selectors that DTL generates (`refs/dom-testing-library/src/role-helpers.js` L80-139) give identical `matches()` results on rsdom and jsdom over every element of a generated fixture. Implicit roles from DTL's own `getImplicitAriaRoles` also match.
- [x] Results are identical with the prefilter on and off. The contract suite is green with `RSDOM_NO_PREFILTER=1` and with `RSDOM_NO_MEMO=1`.
- [x] Cold qSA on a 3k-element table takes ≤ 100 µs, and the prefiltered `matches` miss takes ≤ 15 ns.

## M4: Events (EventTarget, Event classes, dispatch, default actions)
**P0 APIs**
- `addEventListener`/`removeEventListener` with `{capture, passive, once, signal}`, deduplication by callback plus capture, object listeners (`handleEvent`), and the passive probe.
- `dispatchEvent`:
  - path is target → ancestors → document → window, except `load`
  - capture, target and bubble phases over a snapshot of each listener list
  - `stopPropagation`, `stopImmediatePropagation`, `preventDefault`, `defaultPrevented`, `cancelBubble`/`returnValue` aliases, `composedPath`
  - the return value
- `window.event` is `undefined` when idle and is restored after dispatch.
- Listener exceptions become a window `ErrorEvent`, then `process.emit('uncaughtException')` when unhandled. There is no `reportError`.
- Event classes:
  - Event, CustomEvent, UIEvent, MouseEvent, PointerEvent
  - KeyboardEvent, with keyCode, charCode and which kept
  - FocusEvent, InputEvent, CompositionEvent, ErrorEvent, SubmitEvent
  - AnimationEvent, TransitionEvent
  - No TextEvent. Unknown init keys are ignored.
- Activation behaviour applies only to MouseEvent or PointerEvent `click`:
  - checkbox and radio pre-activation toggle with revert, then `input` and `change`
  - submit button calls `requestSubmit`, which fires `SubmitEvent` with the submitter
  - reset button
  - label forwards the click to its control
- `HTMLElement.click()` dispatches a PointerEvent with `detail` 0 and is a no-op when disabled.
- GlobalEventHandlers `on*` accessors, with `'oninput' in document` true and `el.onclick === null`.

**P1:** WheelEvent, TouchEvent, DragEvent, ClipboardEvent, ProgressEvent, PopStateEvent, PageTransitionEvent. `form.requestSubmit`, `form.submit()` as a no-op stub.

**Acceptance**
- [x] The jsdom oracles for event phase order, listener add and remove during dispatch, checkbox activation and revert, and `new Event('click')` (no activation) pass on rsdom and jsdom.
- [x] An RTL-free React smoke test passes in plain Node using `createWindow()`: createRoot, render, click, and onChange from checkbox and text input via `fireEvent`.
- [x] A test asserts that dispatch makes no N-API crossings beyond activation calls.

**Status (M4 done, P0 + P1; area B):** see `docs/lab/status/B-events-forms.md`.

## M5: HTML element specifics (form controls, labels, dataset, classList, style, focus)
**P0 APIs**
- Input:
  - `value` and `checked` as own accessors on `HTMLInputElement.prototype`
  - value modes, dirty value flag, sanitisation
  - `defaultValue` and `defaultChecked` reflection, `type` normalisation
  - `name`, `disabled`, `readOnly`, `required`, `placeholder`, `indeterminate`
  - radio-group exclusivity by name, form owner and tree
- Selection API (UTF-16): `selectionStart`, `selectionEnd`, `selectionDirection`, `setSelectionRange`, `select`, `setRangeText`. Types without selection return `null`.
- Textarea: `value` own accessor, `defaultValue` read from child text, dirty flag, CRLF normalisation.
- Select and option:
  - `select.value` own accessor, `options` (HTMLOptionsCollection), `selectedOptions`, `selectedIndex` (-1 when nothing matches)
  - `multiple`, `size`
  - `option.value` falls back to its text; `selected`, `defaultSelected`, `disabled`, `text`, `index`
- `button.type` defaults to `submit`.
- `labels` on labelable elements, `label.control` and `htmlFor`, `form`, `form.elements`, `form.method`, `form.reset()`.
- Fieldset disabled semantics.
- `checkValidity` and `reportValidity`, firing `invalid`. `validity` covers valueMissing, typeMismatch for email, patternMismatch, tooShort/tooLong and rangeUnderflow/rangeOverflow. Also `validationMessage`.
- `classList` (DOMTokenList; removing the last class leaves no empty `class` attribute), `dataset`, `hidden`, `title`, `tabIndex` defaults, `lang`, `dir`.
- `href` and `src` resolved against `http://localhost:3000`, `contentEditable` returns `'inherit'`, `scrollTop` and `scrollLeft` setters are no-ops.
- `element.style` (CSSStyleDeclaration):
  - generated camelCase, kebab-case, `Webkit*` and `cssFloat` accessors
  - `setProperty` with `important`, `getPropertyValue`, `removeProperty`, `cssText`, `length`, `item`
  - colour normalisation to `rgb(...)`; shorthands margin, padding, border, overflow and flex
  - invalid values ignored, lazy `style` attribute sync, and `'animation' in style` / `'transition' in style` both true
- Focus:
  - `focus()` and `blur()` fire blur → focusout → focus → focusin with `relatedTarget`
  - focusability rules: connected, not disabled, tabindex, not under a `display:none` ancestor (needs the M6 UA table, so a stub until then)
  - `document.activeElement` defaults to body; removing the focused element moves focus to body without firing blur
  - focusing does not invalidate the style or selector memos
- The value memo validated by `form_ver`.

**P1:** `cloneNode` copies form state; `HTMLImageElement` `src`/`srcset`/`complete`/`width`/`height`, with `decode()` resolving immediately; `HTMLAnchorElement` URL parts; `HTMLDialogElement` `open`/`showModal`/`close` (minimal); `output.value`.

**Acceptance**
- [x] Prototype-contract tests pass on all three DOMs:
  - `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')` has both a getter and a setter.
  - Instances have no own `value`.
  - React's `trackValueOnNode` pattern works, and DTL's `setNativeValue` pattern works.
- [x] The form oracle table in docs/lab/research/jsdom.md §6.8 (value, defaultValue and attribute; select and option) passes on rsdom and jsdom.
- [x] user-event `type` with emoji and `selectionStart` checks matches jsdom.
- [x] The focus-order oracle and the focus fixup on removal pass.

**Status (area B part of M5 done, P0 + P1; `element.style` is area A):** see `docs/lab/status/B-events-forms.md`.

## M6: Window, globals, Vitest environment, MutationObserver, getComputedStyle
**P0 APIs**
- `packages/rsdom/lib/vitest-environment.mjs`:
  - default export `{name: 'rsdom', viteEnvironment: 'client', setup → {teardown}}`
  - loads the facade and addon through `createRequire`
  - installs globals as data properties: window, self, top and parent are all globalThis, and `document.defaultView === globalThis`
  - keeps Node's timers, `performance`, `queueMicrotask`, `AbortController`, `MessageChannel`, typed arrays and `console`
  - teardown is O(1) and restores the original descriptors
- Globals:
  - every interface constructor and every Event class
  - `getComputedStyle` (unbound), `MutationObserver`, `DOMParser`
  - FormData override accepting `(form, submitter)`
  - `requestAnimationFrame`/`cancelAnimationFrame`, `matchMedia`, `location`, `navigator`, `localStorage`/`sessionStorage`
  - `getSelection` stub, `HTMLIFrameElement`, `innerWidth` 1024 / `innerHeight` 768, `CSS.escape`
  - `scrollTo` as a no-op
- MutationObserver:
  - O(1) `observe` (OBSERVED flag, observer count)
  - options `subtree`, `childList`, `attributes`, `attributeFilter`, `attributeOldValue`, `characterData`, `characterDataOldValue`
  - one microtask per burst; `takeRecords`, `disconnect`
  - zero cost with no observers
- `getComputedStyle(el, pseudo?)`:
  - UA table generated from `refs/jsdom/lib/jsdom/browser/default-stylesheet.css`
  - `[hidden]`, `input[type=hidden]` and `dialog:not([open])` give `display: none`
  - inherited `visibility` and `pointer-events`, opacity defaults to `'1'`
  - inline style with `!important`, and simple author `<style>` rules (tag, class, id, descendant and child selectors)
  - fine-grained STYLE epoch
  - core snapshot cached on the wrapper
  - `getPropertyValue` plus camelCase and kebab-case getters
  - pseudo-elements return content `'none'`

**P1:** author sheets with attribute and pseudo-class selectors, `:focus` dependency tracking, `CSSStyleSheet` stubs (`document.styleSheets` length), environment options read from `options.rsdom`, and the `vitest-environment-rsdom` package alias for docblocks.

**Acceptance**
- [x] `DOM_ENV=rsdom npx vitest run src/__tests__/Counter.test.tsx` passes in `e2e/react-app/`.
- [x] DTL `waitFor` and `findBy*` resolve through MO, not through 50 ms polling. Asserted by counting `drainRecords` calls.
- [x] Accessible names match jsdom for `<button>Save<span>d</span></button>`, which gives "Saved".
- [x] `getComputedStyle` cold after a mutation takes ≤ 1 µs; `aria-*`/`data-*`/text writes do not bump STYLE (unit test on `EP[3]`).
- [x] jest-dom `toHaveStyle('color: red')` and `toHaveStyle({fontWeight: 'bold'})` pass. These fail on jsdom 30, which is documented.
- [x] `pool: 'threads'` with `isolate: false` runs 3 files per worker with no leaked DOM between files, using the app's `afterEach(cleanup)`.

## M7: Make the dummy app suite green
- [x] `cd app && npm run test:rsdom` runs 90/90 tests across all 11 files, under the forks+isolate default, `pool: 'threads'`, and `threads` with `isolate: false`.
- [x] Each failure is triaged against jsdom and happy-dom behaviour. Every fix gets a contract test, so the contract suite grows.
- [x] No test in `e2e/react-app/` is modified. Any divergence that cannot be fixed is documented in DESIGN §14 and in the report.
- [x] The suite also passes with `RSDOM_SHARED=0`, `RSDOM_NO_MEMO=1` and `RSDOM_NO_PREFILTER=1` set, one at a time and all together. This proves the shortcuts are semantically transparent.
- [x] The `RSDOM_COUNTERS=1` build reports crossings per file. The total is compared with the prediction of about 1.5M DOM calls, which should cost 0.06-0.15 s of crossing time.

## M8: Benchmarks (micro and Vitest end-to-end)
**Micro** (`bench/micro`, one Node process per DOM, warm-up first, then the median of at least 7 runs):
- mutate: create, append and remove
- attr: get, set and has
- deep: bottom-up build
- walk: steady state, and interleaved with mutations
- matches: the 113 role selectors
- qsa: cold and warm
- gcs: cold after a mutation
- focus
- event: MouseEvent dispatch through a 20-deep tree with React-like listeners
- parse: innerHTML set
- serialize: outerHTML get
- mo: observe and disconnect on 4k nodes
- mem: bytes per div
- env setup

Every read benchmark interleaves mutations, and cold and warm results are reported separately.

**End-to-end** (`bench/e2e`):
- Each sample is a fresh `vitest run` with the custom phase reporter (environment, import, tests, wall). Use N ≥ 5, report medians and spread, pin `maxWorkers`, use the same config and setup files, and vary only `DOM_ENV`.
- Matrix: forks+isolate (default), threads, threads with `isolate: false`, and `maxWorkers=1`.
- Ablation runs for rsdom: `RSDOM_SHARED=0`, `RSDOM_NO_MEMO=1`, `RSDOM_NO_PREFILTER=1`, and all three off.
- Per-file results, with DataTable.heavy called out.

**Acceptance**
- [x] Every DESIGN §13 row has a measured value next to its prediction, and wins and losses are marked honestly (`docs/BENCHMARKS.md`, final run 2026-10-17 at `c4e213d`).
- [x] The environment phase is reported separately from the tests phase, and non-Rust effects are listed: facade size, data-property globals, JS memo and prefilter.
- [x] Only tests that pass on all three DOMs are timed.
- [x] Raw data and the scripts that reproduce it are committed under `bench/results/` (micro JSON with every sample, `raw/e2e-2026-10-17T03-53-11-529Z.json`; harnesses in `bench/`).

## M9: Review and optimise
- [x] A second-opinion review by separate subagents:
  - Rust soundness: the "never re-enter JS" invariant, `unsafe` blocks, bounds checks on table and OUT ids, the growth and detach ordering, and `catch_unwind` coverage.
  - DOM spec review against the jsdom oracles.
  - JS cache invalidation: every memo has to be keyed by a Rust counter.
- [x] Profile-driven optimisation: run `--cpu-prof` on DataTable.heavy and the `perf` profile of the addon. Candidates:
  - latin1 coverage
  - the P2 fast selector compiler, if `selectors` overhead shows up
  - positive-only attribute bloom for `hasAttribute`
  - megamorphic getter hotspots
- [x] `cargo clippy -D warnings` and `cargo test` pass, the contract suite is green on all three DOMs, and proptest runs 100k cases. (Verified at 38c1d03: clippy clean, 92 cargo tests, 811 contract/native tests, proptest 100k in release 15.5 s, app 90/90 on rsdom.)
- [x] Re-run M8. Publish the comparison artifact covering the features built, caveats (unsupported surface, divergences such as live non-core computed props, stale held-list indexing and UTF-8 lone surrogates), where rsdom loses, and the ablation attribution. (Published in rsdom-lab: `docs/report/index.html`.)
