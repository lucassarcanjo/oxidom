# What Testing Library needs from a DOM, and where its time goes

Research notes for **oxidom**, a DOM written in Rust and exposed to Node through napi-rs, used as a Vitest
environment. The question these notes answer: which DOM APIs do `@testing-library/dom` (DTL),
`@testing-library/react` (RTL), `dom-accessibility-api`, `@testing-library/jest-dom` and (partly)
`@testing-library/user-event` call, how they call them, and which calls dominate test time.

All paths are relative to `refs` unless they start with `e2e/react-app/` (the benchmark
app at `oxidom-lab/app`) or `trace/`, which is
`oxidom-lab/docs/research/testing-library-trace/` (scripts and raw outputs for every number here).

---

## 0. TL;DR

1. **`getByRole` is the dominant query in real suites, and the most expensive one.** It accounts for 205 of
   ~350 query calls in `e2e/react-app/src/__tests__`. It used **27.6% of all CPU** of the whole app suite under jsdom
   (9.5 s of 34.5 s) and 13.4% under happy-dom (3.3 s of 24.5 s) (`trace/cpu-profile-*.txt`).
2. Inside `getByRole`, three DOM primitives do almost all of the work:
   - **`Element.matches(selector)`.** DTL works out implicit ARIA roles by trying up to **113 CSS selectors**
     from aria-query, one `matches()` call each, until one hits. A `<tr>` costs 98 calls, a `<button>` 41, a
     `<label>` or `<svg>` 111 (`trace/implicit-role-scan-cost.txt`). `matches()` is **56% of all DTL→DOM
     calls** (272,706 of 487,462 in the app suite).
   - **`window.getComputedStyle()`**, called from `isInaccessible` (DTL) and from accessible-name
     computation (dom-accessibility-api). It is cheap only while the style cache is warm. **After any DOM
     mutation, one call costs about 380 µs in jsdom and about 200 µs in happy-dom**
     (`trace/style-and-selector-costs.txt`). Tests mutate the DOM between queries all the time (every React
     commit), so this path is cold in practice. It cost about **5.9 s (17%) of the jsdom suite CPU**, counting
     `getComputedStyle` itself (5.3 s) plus the lazily cascaded property getters it hands back (0.6 s).
   - **`querySelectorAll`** over the whole container (`*[role~="row"],tr`, `*`, `[data-testid]`, …) plus
     `Array.from` over the result: 3.6–5.8 ms per call on about 2–3.6k elements in jsdom.
3. **The number of boundary crossings is modest.** The whole 90-test app suite makes about **1.52 M public
   DOM API calls** from non-DOM code. jsdom and happy-dom agree to within 1%. About 50% come from react-dom,
   32% from DTL, 10% from dom-accessibility-api, 4% from user-event and 0.1% from jest-dom
   (`trace/api-call-counts-*.txt`). At the measured **~40–100 ns per napi call** (`trace/napi-call-overhead.txt`),
   1.5 M crossings cost about 0.1–0.15 s. That is small next to jsdom's 15.6 s of DOM-implementation self
   time. **The win comes from doing `matches` / `getComputedStyle` / `querySelectorAll` / accessible-name
   inputs fast in Rust, not from avoiding calls.** Trivial getters (`tagName`, `nodeType`, `localName`,
   `ownerDocument`) are the exception: on a JS object they cost about 2 ns versus about 90 ns over napi, so
   cache the immutable ones on the JS wrapper.
4. **Correctness traps that silently break Testing Library** (all P0, details in §11):
   - `NodeList`/`HTMLCollection` must support **indexed access**. dom-accessibility-api's `ArrayFrom` and
     pretty-format's `Array.prototype.slice.call(childNodes)` use `length` + `[i]`, not the iterator.
   - Class names must be the real DOM names (`HTMLDivElement`, `Text`, `Comment`, `DocumentFragment`, …).
     pretty-format detects DOM nodes by `constructor.name`.
   - `Node.prototype.ELEMENT_NODE` and `TEXT_NODE` constants must exist on instances. dom-accessibility-api
     does `node.nodeType === node.ELEMENT_NODE`.
   - `Object.getPrototypeOf(input)` must have an **own** `value` accessor. DTL `setNativeValue`, React's
     value tracker and user-event's interceptors all rely on it.
   - `getComputedStyle` must work **unbound**. jest-dom does `const {getComputedStyle} = defaultView`.
   - The computed `display` must follow the UA stylesheet: `span` is inline, `div` is block, and `td` is
     table-cell. Accessible names depend on it: `<button>Save<span>d</span></button>` is `"Saved"` in jsdom
     but `"Save d"` in happy-dom (`trace/accessible-name-display.txt`).
   - MutationObserver callbacks must be **batched per microtask**, not fired per mutation, or every
     `findBy*` re-runs its query thousands of times.
   - Wrappers must keep a **stable identity for the node's lifetime**. React fibers, user-event flags and
     DTL `WeakMap` caches are all expandos or keys on the wrapper object.
5. **Error paths are expensive:**
   - Every *failed* `getBy*` builds a message with `prettyDOM(container)`, which walks the whole tree and
     then reads `outerHTML`. That is 52 ms on 3.6k elements in jsdom.
   - Every failing attempt inside `findBy*` / `waitFor` pays it again.
   - A failed `getByRole` outside `waitFor` also runs `prettyRoles`, which computes the role and name of
     every element: **1.1 s** for one miss in jsdom, 0.39 s in happy-dom.

---

## 1. Sources, versions, and method

| Package | Studied source | Version actually executed in `e2e/react-app/` |
|---|---|---|
| @testing-library/dom | `dom-testing-library/src` (master, 2026-09-13) | 10.4.2 (dist matches source for everything cited) |
| @testing-library/react | `react-testing-library/src` (master, 2026-08-27) | 16.3.3 |
| @testing-library/jest-dom | `jest-dom/src` (master, 2026-08-09) | 7.0.1 |
| dom-accessibility-api | `dom-accessibility-api/sources` (0.7.1) | **0.5.16** (used by DTL), **0.6.3** (used by jest-dom). Same DOM API surface: I grepped both dists for every DOM member used |
| aria-query | — (data only) | 5.3.0 (pinned by DTL) |
| pretty-format | — | 27.5.1 (used by DTL). Vitest bundles its own copy with the same DOMElement plugin test (`e2e/react-app/node_modules/vitest/dist/chunks/index.*.js`, `ELEMENT_REGEXP`) |
| user-event | `e2e/react-app/node_modules/@testing-library/user-event/dist/esm` | 14.6.8 |
| jsdom / happy-dom | `jsdom`, `happy-dom/packages/happy-dom/src` | 30.1.3 / 21.0.3 |

How the measurements were made (all scripts in `trace/`):

- **Static reading** of the sources above.
- **Dynamic API-call tracer.** `trace/tracer-setup.js` is a Vitest setup file. It wraps every method,
  getter and setter on every DOM interface prototype, plus `window.getComputedStyle`. It attributes each call
  to the npm package of the *immediate non-DOM caller*, skipping builtin frames, and ignores calls made by
  the DOM implementation itself. It ran over the full app suite (`e2e/react-app/src/__tests__`, 11 files, 90 tests)
  through `trace/vitest.trace.config.mjs`. Aggregation: `trace/agg.cjs`. Outputs:
  `trace/api-call-counts-jsdom.txt` and `trace/api-call-counts-happy-dom.txt`. The two environments agree
  to within 1% on the total (1,531,631 and 1,524,453 calls), which cross-checks the attribution.
- **CPU profiles** of the full suite run serially (`--no-file-parallelism --execArgv=--cpu-prof`), aggregated
  by `trace/analyze.cjs`. It reports self time per package, DOM-implementation time attributed to the first
  non-DOM caller and the DOM entry point, and inclusive time of key functions. Outputs:
  `trace/cpu-profile-jsdom.txt` (10 worker profiles; one file's profile was not flushed) and
  `trace/cpu-profile-happy-dom.txt` (11).
- **Micro-benchmarks** outside Vitest: `trace/microbench.cjs` runs each query on a 3,643-element page with a
  300-row table and a form. `trace/cs-cold.cjs` and `trace/match-cold.cjs` measure cache effects.
  `trace/cs-defaults.cjs` compares computed-style values. `trace/accname.cjs` and `trace/tohavestyle.cjs` check
  parity. `trace/role-scan.cjs` counts `matches()` calls per element type.
- **N-API cost**: a tiny napi-rs 3 addon (`trace/napibench/`), with results in `trace/napi-call-overhead.txt`.

Caveat on micro-benchmarks: they repeat a query on an **unchanged** DOM, so happy-dom's memoization makes it
look better than in real tests. happy-dom caches `querySelectorAll` results per selector, `matches` results
per element, and computed styles. All three are invalidated by mutations. See §2.4.

---

## 2. Where the time goes (measured)

### 2.1 Whole app suite, CPU profile (serial run)

Wall clock: jsdom 28.6 s, happy-dom 19.2 s serial. In parallel (4 workers): 11.8 s and 10.4 s.

| Inclusive CPU | jsdom (34.5 s total) | happy-dom (24.5 s total) |
|---|---:|---:|
| DOM implementation (any frame) | 24.0 s (69.6%) | 9.5 s (38.7%) |
| DOM implementation, **self** | 15.6 s (45.3%) | 6.7 s (27.2%) |
| react-dom (any frame) | 8.4 s | 8.9 s |
| `@testing-library/dom` (any frame) | 14.4 s | 8.3 s |
| `queryAllByRole` | **9.52 s** | **3.29 s** |
| ↳ `isInaccessible` (DTL) | 3.35 s | 0.75 s |
| ↳ `computeAccessibleName` (dom-a11y) | 2.77 s | 1.37 s |
| ↳ ↳ `isHidden` → `getComputedStyle` | 2.51 s | 1.19 s |
| ↳ `getImplicitAriaRoles` (→ `matches`) | 1.25 s | 0.31 s |
| `fireEvent` (incl. React handling + re-render) | 3.44 s | 3.48 s |
| RTL `render` (incl. React) | 3.59 s | 4.03 s |
| user-event (all) | 1.19 s | 0.97 s |
| `queryAllByLabelText` | 0.47 s | 0.39 s |
| jest-dom (all matchers) | 0.30 s | 0.10 s |
| pretty-format (`prettyDOM`, `debug`) | 0.08 s | 0.11 s |
| module compile (`wrapSafe`) | 2.98 s | 0.63 s |

DOM-implementation self time, attributed to who called the DOM and through which entry point (jsdom):

| Caller → DOM entry | jsdom | happy-dom |
|---|---:|---:|
| DTL → `window.getComputedStyle` | 2.87 s | ~0.35 s (lazy; shows up as `CSSStyleDeclaration` getters) |
| DTL → `querySelectorAll` | 2.32 s | 1.04 s |
| dom-a11y → `window.getComputedStyle` + `getPropertyValue` | 2.46 s | 0.63 s |
| DTL → `matches` | 1.10 s | 0.29 s |
| vitest → `new JSDOM()` / `GlobalWindow` (env creation) | 1.04 s | 0.11 s |
| react-dom → `appendChild` / `createElement` / `setAttribute` / `removeChild` / `textContent=` | 2.41 s | 2.88 s |

For jsdom, **about 9.5 s of the 15.6 s of DOM self time is spent on behalf of Testing Library and
dom-accessibility-api** (DTL 6.9 s + dom-accessibility-api 2.6 s), mostly in style computation, selector matching and `querySelectorAll`. React's own
DOM work is about 3 s. React's share is the sibling research topic (`docs/lab/research/react-dom.md`).

### 2.2 DOM API call counts by caller (whole suite, jsdom; happy-dom within 1%)

Total public DOM calls from non-DOM code: **1,531,631**.

| Caller | Calls | Share |
|---|---:|---:|
| react-dom | 768,480 | 50.2% |
| @testing-library/dom | 487,462 | 31.8% |
| dom-accessibility-api | 159,721 | 10.4% |
| @testing-library/user-event | 61,780 | 4.0% |
| test code | 8,206 | 0.5% |
| @testing-library/jest-dom | 1,772 | 0.1% |
| @testing-library/react | 623 | <0.1% |

Top DTL calls: `Element.matches()` 272,706 · `Element.tagName` 66,840 · `hasAttribute` 46,533 ·
`parentElement` 21,424 · `getAttribute` 12,041 · `HTMLInputElement.type` 11,917 · `ownerDocument` 10,509 ·
`window.getComputedStyle()` 9,999 · `HTMLInputElement.labels` 8,898 · `HTMLElement.hidden` 7,212 ·
`nodeType` 4,391 · `nodeName` 2,496 · `childNodes` 2,472 · `textContent` 2,285 ·
`HTMLAnchorElement.type`/`HTMLButtonElement.type`/`HTMLLIElement.type` about 4,100 (from the role matcher,
§3.4) · `querySelectorAll` 1,440 · `dispatchEvent` 189 · `MutationObserver.observe` and `disconnect` 10 each.

Top dom-accessibility-api calls: `nodeType` 61,474 · `localName` 37,383 · `getAttribute` 21,107 ·
`CSSStyleDeclaration.getPropertyValue` 9,618 · `ownerDocument` 7,302 · `hasAttribute` 5,967 ·
`window.getComputedStyle()` 5,210 · `getAttributeNode` 4,408 · `HTMLInputElement.type` 3,861 ·
`childNodes` 1,412 · `textContent` 1,001 · `labels` 941 · `getElementById` 19 · `getRootNode` 18.

jest-dom (59 `toBeInTheDocument`, 49 `toHaveTextContent`, 42 `toHaveAttribute`, … call sites): `ownerDocument` 982 ·
`tagName` 166 · `textContent` 103 · `hasAttribute` 97 · `parentElement` 80 · `getAttribute` 65 ·
`getRootNode` 47 · `getComputedStyle` 39. **jest-dom is not a hot path.**

user-event: `namespaceURI` 22,932 · `tagName` 14,939 · `parentElement` 5,457 · `ownerDocument` 4,269 ·
`dispatchEvent` 1,821 · `Element.shadowRoot` 681 · the Selection and Range family (tens of calls each).

### 2.3 Per-query micro-benchmarks (3,643-element page, 300-row table; `trace/microbench-300rows.txt`)

| Operation | jsdom | happy-dom* |
|---|---:|---:|
| `getAllByRole('row')` | 108.6 ms | 3.2 ms |
| `getAllByRole('row', {hidden:true})` (skips `isInaccessible`) | 82.1 ms | 2.0 ms |
| `getByRole('button', {name:'Edit row 150'})` (601 candidates → 601 names) | 128.6 ms | 13.1 ms |
| `getByRole('checkbox', {name:'Select row 150'})` | 29.7 ms | 2.5 ms |
| `getByRole('textbox', {name:'Email'})` | 26.3 ms | 1.4 ms |
| `getByText('Name 150')` | 39.4 ms | 16.9 ms |
| `getByLabelText('Email')` | 12.5 ms | 5.1 ms |
| `getByTestId('row-150')` | 3.7 ms | 0.08 ms |
| `querySelectorAll('*')` + `Array.from` | 4.4 ms | 0.09 ms |
| `getComputedStyle(el).display` × 3,643 (warm) | 16.4 ms | 3.1 ms |
| `el.matches('input:not([list])[type="email"]')` × 3,643 | 11.5 ms | 1.2 ms |
| `computeAccessibleName(button)` × 601 | 17.7 ms | 7.1 ms |
| `prettyDOM(container)` (every failed `getBy*`) | 52.4 ms | 50.2 ms |
| `getByRole('button',{name:'nope'})` miss, with full diagnostics | **1,131 ms** | 393 ms |
| `fireEvent.click(button)`, no listeners | 0.034 ms | 0.015 ms |

\* Repeated on an unchanged DOM, so happy-dom's per-selector `querySelectorAll` cache and per-element
`matches` cache are hot. See `happy-dom/packages/happy-dom/src/query-selector/QuerySelector.ts:112-146` (cache
lookup and store) and `happy-dom/packages/happy-dom/src/nodes/node/Node.ts:880-960` (`clearCache`).

### 2.4 Primitive costs with and without mutations (`trace/style-and-selector-costs.txt`)

| Primitive | jsdom | happy-dom |
|---|---:|---:|
| `getComputedStyle(el).display`, warm (no mutation since the last call) | 2.9–3.5 µs | 0.9–1.8 µs |
| `getComputedStyle`, **first call per element after any mutation** | **~380 µs** | **~200 µs** |
| `getComputedStyle`, a mutation before *every* call | ~388 µs | ~3,990 µs |
| `matches()` (aria-query style selectors) | 2.2–3.1 µs | 0.2–1.0 µs |
| `querySelectorAll` on 2.1k elements after a mutation | 5.75 ms | 0.15 ms |

Why jsdom's cold style is so expensive:

- `getComputedStyle` → `getComputedStyleDeclaration` builds a **complete** declaration. It collects candidate
  rules from the 415-line UA stylesheet (`jsdom/lib/jsdom/browser/default-stylesheet.css`) and every document
  sheet, then matches each candidate selector through `@asamuzakjp/dom-selector`
  (`jsdom/lib/jsdom/living/css/helpers/computed-style.js:56-160`).
- The per-document `_styleCache` is thrown away on **every** connected mutation:
  - `jsdom/lib/jsdom/living/nodes/Node-impl.js:464-497` (`_invalidateSelectorState`, `_invalidateCaches`, `_childrenChangedSteps`)
  - `jsdom/lib/jsdom/living/nodes/Document-impl.js:254`
  - Attribute changes also clear the selector engine cache: `jsdom/lib/jsdom/living/nodes/Element-impl.js:82-83`.

happy-dom builds styles from a per-tag default table
(`happy-dom/packages/happy-dom/src/css/declaration/computed-style/config/CSSComputedStyleElementDefault.ts`)
plus stylesheets. It walks the whole ancestor chain on a miss
(`happy-dom/packages/happy-dom/src/css/declaration/computed-style/CSSComputedStyle.ts:58-120`) and caches the
result per element with `affectsCache` invalidation lists.

**Implication for oxidom.** A computed-style path that answers `display`, `visibility`, `opacity` and
`pointer-events` from:

- a static per-tag UA table,
- a few attribute rules (`[hidden]`, `dialog:not([open])`, `input[type=hidden]`),
- inline style,
- a (usually empty) list of author rules,

with a document-wide "style epoch" counter as the cache key, should cost on the order of 1 µs cold. That is
two orders of magnitude below jsdom on the path that dominates `getByRole` after every React commit.

### 2.5 The N-API budget (`trace/napi-call-overhead.txt`, napi-rs 3, Node 22, release+LTO)

| Call shape | ns/call |
|---|---:|
| JS getter on a JS wrapper (cached field) | 2 |
| `noop()` | 38 |
| `f(u32) -> u32` | 88 |
| `f(u32) -> &'static str` (allocates a JS string) | 103 |
| `f(u32, String /*30-char selector*/) -> bool` (UTF-8 copy + `String` alloc + hash) | 205 |
| JS `Map<string,id>` lookup + `f(u32,u32) -> bool` | 100 |
| returning a fresh `Uint32Array` | ~2 µs fixed, noisy (external ArrayBuffer + finalizer; GC churn) |

Takeaways:

- **Cache per-wrapper immutables in JS**: `nodeType`, `nodeName`, `tagName`, `localName`, `namespaceURI`,
  `ownerDocument`, the wrapper class. Those getters are called hundreds of thousands of times, and a napi
  round-trip is 40× a JS field read.
- **Intern selectors JS-side** (string → small integer id) before crossing. That halves the cost of the
  ~270k `matches()` calls, which come from a closed set of ~120 distinct selector strings (§3.4).
- **Return node lists through a reusable shared buffer** (for example one `Uint32Array` that JS allocates
  and Rust fills), not a new typed array per call.
- **Even pessimistically, crossings are not the bottleneck.** 1.5 M calls × 100 ns ≈ 0.15 s for the whole
  suite.

---

## 3. @testing-library/dom in detail

### 3.1 Entry points: container, `screen`, `within`, window lookup

- **`screen` is bound at import time** (`dom-testing-library/src/screen.ts:51-53`). If
  `typeof document !== 'undefined' && document.body`, it is `getQueriesForElement(document.body, …)`, so every
  query is `fn.bind(null, document.body)` (`dom-testing-library/src/get-queries-for-element.js`).
  ⇒ `document.body` must exist **before** DTL is imported (the setup file imports it) and **must stay the same
  object** for the whole file. Never replace `<body>` between tests.
- RTL's `render()` returns queries bound to `baseElement`, which defaults to `document.body`
  (`react-testing-library/src/pure.js:234,271`).
- `checkContainerType(container)` only checks `typeof container.querySelector === 'function'` and the same for
  `querySelectorAll` (`dom-testing-library/src/helpers.ts:65-83`). On failure it reads
  `container.constructor.name` for the message.
- `getWindowFromNode(node)` (`dom-testing-library/src/helpers.ts:28-62`) takes `node.defaultView` (document),
  then `node.ownerDocument.defaultView`, then `node.window` (window). Consequences:
  - Elements must not have a `defaultView` property.
  - `window.window === window`.
  - `ownerDocument.defaultView` must be the object that carries `MutationObserver`, the event constructors and
    `getComputedStyle`.
  - In Vitest, `populateGlobal` redefines `document.defaultView` to return **`globalThis`**
    (`vitest/packages/vitest/src/integrations/env/utils.ts:101-108`). So those globals must be installed on
    `globalThis` by the oxidom environment, and they are looked up **dynamically** on every call
    (`window[EventType]`, `window.getComputedStyle`).
- `getDocument()` returns `window.document`, from the global `window` (`helpers.ts:21-26`).

### 3.2 How each query walks the tree

No query uses `TreeWalker`, `NodeIterator`, `getElementsBy*` or `children` traversal on the hot path. I grepped
DTL, dom-accessibility-api, jest-dom, RTL and user-event for `createTreeWalker`, `createNodeIterator` and
`NodeFilter`: zero hits. **Every query is `container.querySelectorAll(<selector>)` → `Array.from` → JS
`.filter()` chains that call back into the DOM per candidate.**

| Query | Tree walk | Per-candidate DOM work |
|---|---|---|
| `*ByRole` (`queries/role.ts:186-305`) | `qSA(makeRoleSelector(role))`, e.g. `*[role~="row"],tr` | §3.3 |
| `*ByText` (`queries/text.ts:18-47`) | `container.matches(selector)` + `qSA(selector='*')` (**every element**) | `node.matches('script, style')` (the `ignore` option) + `getNodeText(node)` = `node.matches('input[type=submit], input[type=button], input[type=reset]')` + `Array.from(node.childNodes)` → each child `nodeType`, `textContent` (`get-node-text.ts:3-14`) + normalize + compare |
| `*ByLabelText` (`queries/label-text.ts:49-129`) | `qSA('*')` (**every element**) | `element.labels` (`label-helpers.ts:40-48`; `undefined` ⇒ tagName regex) + `hasAttribute('aria-labelledby')`. For labelled elements: `getLabels` → `aria-labelledby` split → `container.querySelector('[id="…"]')` → `getLabelContent` (recursive `childNodes`/`nodeName`/`nodeType`/`textContent`, or `value \|\| textContent`), and `label.querySelectorAll('button, input, meter, output, progress, select, textarea')` + `matches(selector)`. Then `queryAllByAttribute('aria-label', …)` (another qSA) and a final `element.matches(selector)` |
| `*ByPlaceholderText`, `*ByTestId` (`queries/placeholder-text.ts`, `queries/test-id.ts`) | `queryAllByAttribute` → `qSA('[placeholder]')` / `qSA('[data-testid]')` (`query-helpers.ts:28-43`) | `getAttribute(attr)` |
| `*ByAltText` (`queries/alt-text.ts`) | `qSA('[alt]')` | `getAttribute('alt')`, `tagName` regex `/^(img\|input\|area\|.+-.+)$/i` |
| `*ByTitle` (`queries/title.ts:21-38`) | `qSA('[title], svg > title')` | `getAttribute('title')`; SVG title: `tagName`, `parentElement.tagName`, `getNodeText` |
| `*ByDisplayValue` (`queries/display-value.ts:17-44`) | `qSA('input,textarea,select')` | `tagName`; `select.options` → `Array.from` → `option.selected`, `getNodeText(option)`; otherwise `.value` |

Variants (`query-helpers.ts:63-240`):

- `queryBy*` returns null on zero results.
- `getBy*` / `getAllBy*` throw `getElementError(...)` on zero results (§3.6).
- Single-element variants throw on more than one result and call `getElementError(null, element)` for **each**
  match, plus once for the container (`query-helpers.ts:63-85`).
- `findBy*` = `waitFor(() => getBy*(…), {container})`.

`throwSuggestions` is off by default. If it is on, every successful query also calls `getSuggestedQuery`
(`suggestions.js:77-136`): roles, names, labels, text and more for the found element.

### 3.3 `getByRole` step by step (`dom-testing-library/src/queries/role.ts`)

1. `checkContainerType`. Option guards consult aria-query `roles.get(role).props[...]` (pure JS).
2. `container.querySelectorAll(makeRoleSelector(role))` (`role.ts:186-190`, `307-322`). The selector is
   `*[role~="<role>"]` followed by every tag aria-query maps to that role, e.g. `*[role~="button"],input,button`
   and `*[role~="generic"],a,area,aside,b,bdo,body,data,div,…`. The full list is in
   `trace/aria-query-role-selectors.txt`. It needs the `~=` operator, selector lists, and **document order
   without duplicates**.
3. **Role filter** (`role.ts:192-214`), per candidate:
   - `hasAttribute('role')`. If present, `getAttribute('role').split(' ')[0] === role`, or any token when
     `queryFallbacks` is set.
   - Otherwise `getImplicitAriaRoles(node)` (§3.4), which is up to ~111 `matches()` calls.
4. **State filters** (`role.ts:215-268`): `selected` → `tagName === 'OPTION' ? el.selected : aria-selected`;
   `checked` → `'indeterminate' in el`, `'checked' in el`, `aria-checked`; `pressed`, `current`, `expanded`,
   `busy` → `getAttribute`; `level` → `aria-level` or `tagName` H1–H6; `value.*` → `aria-value*`
   (`role-helpers.js:237-376`).
5. **Name filter**, only if `name` is given (`role.ts:269-282`): `computeAccessibleName(element, {computedStyleSupportsPseudoElements: false})` for **every** surviving candidate (§5).
6. **Description filter**, only if `description` is given: `computeAccessibleDescription`.
7. **Hidden filter**, unless `hidden: true`. `defaultHidden` is false, so this runs by default
   (`role.ts:296-304`): `isInaccessible(element, {isSubtreeInaccessible: cached})`. This is
   `role-helpers.js:46-66`:
   - `window.getComputedStyle(element).visibility === 'hidden'` → excluded. This relies on **visibility being
     inherited** in the computed style.
   - Then walk `element`, then `parentElement`, up to the root. For each ancestor, `isSubtreeInaccessible`
     (`role-helpers.js:15-31`) checks `el.hidden === true`, then `getAttribute('aria-hidden') === 'true'`, then
     `getComputedStyle(el).display === 'none'`. The result is memoized per query in a `WeakMap<Element,bool>`
     (`role.ts:177-184`), so ancestors are evaluated once per query.
   - Note the order: names are computed **before** hidden candidates are dropped.

Cost per candidate is roughly: the role-matching `matches()` calls, plus 1–2 `getComputedStyle` calls (more
with names), plus ~5 property reads per new ancestor.

### 3.4 Implicit roles: the selector table that dominates `matches()`

`buildElementRoleList(elementRoles)` (`role-helpers.js:80-158`) turns each of aria-query 5.3.0's **113**
`elementRoles` entries into a selector. Value → `[attr="v"]`; constraint "undefined" → `:not([attr])`;
constraint "set" → `[attr]:not([attr=""])`. The list is sorted by **number of attributes, descending**.
`getImplicitAriaRoles(node)` (`role-helpers.js:68-78`) loops in that order and returns the roles of the
**first** entry whose `node.matches(selector)` is true. Two entries contain `type="text"`. For those, the
attribute is removed from the selector and replaced by a JS check `node.type !== 'text'`
(`role-helpers.js:111-139`). So `node.type` is read on every candidate that reaches entries 4 and 12, which is
why `HTMLAnchorElement.type`, `HTMLLIElement.type` and so on show up in the trace.

The selectors are `tag`, `tag[a="v"]`, `tag[a]`, `tag:not([a])`, `tag[a]:not([a=""])` and two-attribute
combinations of those. There are no combinators. Full list: `trace/aria-query-role-selectors.txt`. The scan
ends at the first matching entry, so cheap tags are those mapped early:

| Element | `matches()` calls | Role |
|---|---:|---|
| `<select>` | 6 | combobox |
| `<input>` / `type=text` / `type=email` | 9 / 12 / 9 | textbox |
| `<input type=checkbox>` | 16 | checkbox |
| `<a href>` | 26 | link |
| `<button>` | 41 | button |
| `<td>` / `<th>` | 43 / 45 | cell / columnheader |
| `<div>` / `<span>` | 61 / 71 | generic |
| `<h2>` | 79 | heading |
| `<li>` / `<ul>` | 89 / 87 | listitem / list |
| `<tr>` | 98 | row |
| `<table>` | 107 | table |
| `<textarea>` | 110 | textbox |
| `<label>`, `<svg>` | 111 | (none) |

(`trace/implicit-role-scan-cost.txt`.) `getAllByRole('row')` on a 1,000-row table is therefore about 98,000
`matches()` calls. That is ~250 ms at jsdom's ~2.5 µs, or ~10 ms at 100 ns over napi with interned selector ids.

Rust design notes for this path:

- The selector strings form a **closed, stable set** (113 + ~20 others). Cache parsed selectors in Rust keyed by
  id, and intern string → id in JS (a `Map`).
- Match the **subject compound right to left, tag first**. Nearly every miss is a tag mismatch on the first
  simple selector, which should cost a few ns in Rust.
- Optional: memoize `matches` per (element, selector) keyed by the epoch, as happy-dom does
  (`QuerySelector.ts:380-400`). That only helps repeated queries on an unchanged DOM, so it is low priority.

jest-dom's `toHaveRole` builds the same table and scan (`jest-dom/src/to-have-role.js`).

### 3.5 Error paths: `getElementError`, `prettyDOM`, `prettyRoles`

- Default `getElementError(message, container)` **always** calls `prettyDOM(container)`
  (`dom-testing-library/src/config.ts:36-46`). It is used by:
  - every failed `getBy*` / `getAllBy*` (`query-helpers.ts:101-117`),
  - each match of a "multiple elements" error (`query-helpers.ts:63-85`),
  - suggestion errors.
- **Inside `waitFor`/`findBy*` every failed attempt still pays `prettyDOM`.** `runWithExpensiveErrorDiagnosticsDisabled`
  (`config.ts:53-62`, used at `wait-for.js:139`) only switches off role-list diagnostics (`role.ts:350`),
  not `prettyDOM`. Attempts happen on each MutationObserver callback and every 50 ms.
- Role misses outside `waitFor` also build `prettyRoles` over `container.children` (`role.ts:353-361`,
  `role-helpers.js:160-232`). That is a recursive `node.children` flatten, then `isInaccessible`, roles,
  `computeAccessibleName` and `prettyDOM(el.cloneNode(false))` for **every** element. This is the 1.1 s miss
  in §2.3.
- `prettyDOM(dom, maxLength)` (`pretty-dom.js:47-93`):
  - `dom.documentElement` (document → `<html>`) and `dom.constructor.name`.
  - `'outerHTML' in dom`, else TypeError.
  - `prettyFormat.format` with the DTL `DOMElementFilter` plugin, whose filter calls `value.nodeType` and
    `value.matches('script, style')` on every element (`pretty-dom.js:40-46`).
  - Then **`dom.outerHTML.length`**, which serializes the tree a second time just to decide on truncation.
- DTL's DOMElement plugin (`dom-testing-library/src/DOMElementFilter.ts:159-268`) and Vitest's copy
  (`e2e/react-app/node_modules/vitest/dist/chunks/index.*.js:249-290`) need:
  - `val.constructor.name` matching `/^((HTML|SVG)\w*)?Element$/` for elements, or `tagName.includes('-')` or
    `hasAttribute('is')` for custom elements. `Text` + nodeType 3, `Comment` + nodeType 8 and
    `DocumentFragment` + nodeType 11 must match exactly.
  - Per element: `tagName.toLowerCase()`, then `Array.from(node.attributes)` **twice** (`attr.name`,
    `attr.value`), then `Array.prototype.slice.call(node.childNodes || node.children)` (**indexed access**),
    then the filter.
  - Text and comment nodes: `node.data`.
  - The DOMCollection plugin recognises `NodeList`, `HTML*Collection`, `NamedNodeMap` and `DOMStringMap` by
    `constructor.name`.
  - If the class names are wrong, pretty-format prints wrappers as plain objects (internal fields, possible
    cycles), and error messages and `screen.debug()` become unreadable.
- Escape hatch: `configure({getElementError})` is public. A natively accelerated serializer could be offered
  as an opt-in, but the default must work.

### 3.6 `fireEvent` and `createEvent` (`dom-testing-library/src/events.js`, `event-map.js`)

`fireEvent[name](node, init)` → `createEvent[name]` → `fireEvent(node, event)`, which is
`getConfig().eventWrapper(() => element.dispatchEvent(event))`. RTL sets `eventWrapper` to React `act()`
(`react-testing-library/src/pure.js:62-77`). Its return value is `dispatchEvent`'s boolean.

`createEvent(eventName, node, init, {EventType, defaultInit})` (`events.js:21-96`):

1. `eventInit = {...defaultInit, ...init}`. `init.target` is destructured as `{value, files, ...rest}`.
2. If `value` is given: `setNativeValue(node, value)` (`events.js:104-122`).
   - It reads `Object.getOwnPropertyDescriptor(node, 'value')`, which is React's tracker if present.
   - It reads `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')`.
   - It calls the **prototype's** setter directly so React's tracker sees a change. If there is no setter
     anywhere it throws "The given element does not have a value setter".
   - ⇒ **`HTMLInputElement.prototype`, `HTMLTextAreaElement.prototype` and `HTMLSelectElement.prototype` must
     each own a `value` accessor, and the node's immediate prototype must be that prototype.**
3. If `files` is given: `Object.defineProperty(node, 'files', {configurable, enumerable, writable, value})`.
   The wrapper must be extensible, and `files` must not be a non-configurable own property.
4. `Object.assign(node, rest)`, e.g. `{checked: true}`, which goes through setters.
5. `EventConstructor = window[EventType] || window.Event`, then `new EventConstructor(eventName, eventInit)`.
   `window` is `getWindowFromNode(node)`, which is `globalThis` under Vitest.
6. `dataTransfer` / `clipboardData` in init: if `typeof window.DataTransfer === 'function'`, DTL builds
   `new window.DataTransfer()` and defines props on it. Otherwise it defines the plain object on the event.
   **Leaving `DataTransfer` out is the simplest option** (jsdom has none).

Constructors `window[EventType]` that `event-map.js` uses, with their `defaultInit`:

| EventType | DTL events using it | Must honour init members |
|---|---|---|
| `Event` | change, invalid, submit, reset, select, load, error, media events, online/offline | bubbles, cancelable, composed |
| `MouseEvent` | click (`button: 0`), contextMenu, dblClick, mouseDown/Up/Move/Over/Out/Enter/Leave | + view, detail, screenX/Y, clientX/Y, ctrlKey, shiftKey, altKey, metaKey, button, buttons, relatedTarget, movementX/Y; jsdom also exposes `pageX/Y`, `offsetX/Y`, `x/y` derived from clientX/Y (`jsdom/lib/jsdom/living/events/MouseEvent-impl.js`) |
| `KeyboardEvent` | keyDown/keyPress/keyUp (`charCode: 0`) | key, code, location, repeat, isComposing, **charCode, keyCode** (legacy partial dictionary), `which` (UIEventInit partial), modifiers (`jsdom/lib/jsdom/living/events/KeyboardEvent.webidl`, `UIEvent.webidl`) |
| `FocusEvent` | focus/blur (`bubbles:false`), focusIn/focusOut (`bubbles:true`) | relatedTarget |
| `InputEvent` | input | data, inputType, isComposing |
| `PointerEvent` | pointerOver/Enter/Down/Move/Up/Cancel/Out/Leave, got/lostPointerCapture | MouseEventInit + pointerId, width, height, pressure, tiltX/Y, twist, pointerType, isPrimary |
| `UIEvent` | resize, scroll | view, detail |
| `WheelEvent` | wheel | deltaX/Y/Z, deltaMode |
| `TouchEvent` | touchStart/Move/End/Cancel | touches, targetTouches, changedTouches |
| `CompositionEvent` | compositionStart/Update/End | data |
| `ProgressEvent` | loadStart, progress | lengthComputable, loaded, total |
| `PopStateEvent` | popState | state |
| `PageTransitionEvent` | pageHide, pageShow | persisted |
| `TransitionEvent` | transitionStart/Run/End/Cancel | propertyName, elapsedTime, pseudoElement |
| `AnimationEvent` | animationStart/End/Iteration | animationName, elapsedTime, pseudoElement |
| `ClipboardEvent` | copy, cut, paste | clipboardData |
| `DragEvent` | drag, dragStart/End/Enter/Exit/Leave/Over, drop | dataTransfer |

jsdom 30 has no `ClipboardEvent`, `AnimationEvent` or `DragEvent` (`jsdom/lib/jsdom/living/interfaces.js`).
For those DTL silently falls back to `Event`, so P2.

Rules for init dictionaries:

- Unknown members (`target`, `value`, …) must be **ignored**.
- Missing members take WebIDL defaults.
- `view` must be a Window or null. jsdom throws a TypeError otherwise.
- Members are read once at construction.

Tests rely on `{key, code, keyCode, charCode}` reaching React's `getEventKey`/`getEventCharCode`. A
`KeyboardEvent` that drops `keyCode` or `charCode` breaks `onKeyPress` handlers.

RTL's `fireEvent` wrapper (`react-testing-library/src/fire-event.js`) adds extra events:

- `mouseEnter` → also `mouseOver`; `mouseLeave` → also `mouseOut`.
- `pointerEnter` → also `pointerOver`; `pointerLeave` → also `pointerOut`.
- `blur` → `focusOut` first, then blur; `focus` → `focusIn` first, then focus.
- `select` → `select`, then **`node.focus()`**, then `keyUp`.

React listens to `focusin`/`focusout` and `mouseover`/`mouseout`. `fireEvent.focus` **does not move focus**;
only `el.focus()` does.

DOM **activation behaviour** that tests depend on through `fireEvent.click` (React reads `checked` in its
`click` handler for checkboxes):

- **Checkbox/radio**: toggle `checked` before dispatch, restore it if the event is cancelled, then fire
  `input` + `change` (`jsdom/lib/jsdom/living/nodes/HTMLInputElement-impl.js:177-230`, dispatch hooks at
  `jsdom/lib/jsdom/living/events/EventTarget-impl.js:238-293`).
- **Submit button**: `form.requestSubmit(button)` → `submit` event (`jsdom/lib/jsdom/living/nodes/HTMLButtonElement-impl.js:19-29`).
- **Label**: clicking it forwards a click to the labelled control (`HTMLLabelElement-impl.js:56`).

`fireEvent.submit(form)` only dispatches a plain `submit` Event, and nothing else happens. A submit-button
click goes through `form._doRequestSubmit` → `requestSubmit`, which fires a cancelable `SubmitEvent` with
`submitter`. If it is not cancelled, jsdom reports "not implemented: HTMLFormElement.prototype.requestSubmit" to
the virtual console (`jsdom/lib/jsdom/living/nodes/HTMLFormElement-impl.js:75-111`). oxidom can fire the
`SubmitEvent` and then no-op.

### 3.7 `waitFor`, `findBy*`, `waitForElementToBeRemoved` (`wait-for.js`, `wait-for-element-to-be-removed.js`)

- Real-timer path. In Vitest `typeof jest === 'undefined'`, so it always runs (`helpers.ts:5-19`):
  - `setTimeout(handleTimeout, 1000)` (`asyncUtilTimeout`) and `setInterval(check, 50)`.
  - **`new (getWindowFromNode(container).MutationObserver)(check)`** and
    `.observe(container, {subtree:true, childList:true, attributes:true, characterData:true})`
    (`wait-for.js:94-106`). Then an immediate `checkCallback()`, and `observer.disconnect()` when done.
  - The container is `document` by default for `waitFor` and `document.body` for `screen.findBy*`.
- The callback **ignores the records**: it just re-runs the query. Requirements:
  - Callbacks **must be coalesced into one microtask per batch of mutations**. A React commit that inserts
    1,000 rows must cause one callback, not 1,000 query re-runs.
  - Only subtree observation of the container matters for DTL, but full `MutationRecord`s are cheap enough to
    support for other users. Records can be built JS-side, since all public mutations pass through the JS
    facade, and only when an observer is registered. When no observer is registered, mutations should do zero
    extra work.
  - Without MutationObserver, `waitFor` still works through the 50 ms interval, but every async test waits up
    to 50 ms longer per `waitFor`. So it is effectively P0 for speed.
- RTL's `asyncWrapper` (`react-testing-library/src/pure.js:39-60`) sets `IS_REACT_ACT_ENVIRONMENT=false`
  during `waitFor`, then drains with `await new Promise(r => setTimeout(r, 0))`. Timers are Node's, so oxidom
  needs none.
- `waitForElementToBeRemoved` walks `parentElement` to the top ancestor, then uses `parent.contains(element)`
  (`wait-for-element-to-be-removed.js:19-27`).

### 3.8 Config defaults that matter (`config.ts:12-49`)

| Setting | Default |
|---|---|
| `testIdAttribute` | `data-testid` |
| `asyncUtilTimeout` | 1000 |
| `defaultHidden` | false (so `isInaccessible` always runs) |
| `defaultIgnore` | `'script, style'` (`matches` per element in ByText and prettyDOM) |
| `throwSuggestions` | false |
| `computedStyleSupportsPseudoElements` | false (so dom-accessibility-api never asks for `::before`/`::after`) |

---

## 4. @testing-library/react

- `render(ui)` (`react-testing-library/src/pure.js:238-315`, `renderRoot` at `:165-236`):
  - `baseElement = document.body`, `container = baseElement.appendChild(document.createElement('div'))`.
  - `ReactDOMClient.createRoot(container, …)` (`pure.js:126`), then `act(() => root.render(ui))`.
  - Queries are bound to `baseElement`.
- `cleanup()` runs after each test, through auto-registration (`index.js`) and the app's `setup.ts`. It calls
  `act(() => root.unmount())` and then, `if (container.parentNode === document.body)`,
  `document.body.removeChild(container)` (`pure.js:317-328`).
- `asFragment()`: `if (typeof document.createRange === 'function')` →
  `document.createRange().createContextualFragment(container.innerHTML)`, otherwise
  `<template>.innerHTML` → `.content` (`pure.js:222-232`). **If oxidom exposes `createRange` (user-event needs
  it), `Range.prototype.createContextualFragment` must exist too.**
- `act` is React's `act`. RTL toggles `globalThis.IS_REACT_ACT_ENVIRONMENT` (`act-compat.js:28-34`).
  `configure({eventWrapper, asyncWrapper, unstable_advanceTimersWrapper})` routes DTL events and async
  utilities through `act`, so **every `fireEvent` is followed by React's synchronous flush**. The mutations
  it causes invalidate any style or query caches.
- `debug()` → `prettyDOM` → `console.log`.
- DOM calls RTL itself made in the whole suite: 623 (`createElement`, `appendChild`, `removeChild`,
  `parentNode`). Everything else is React's (see `docs/lab/research/react-dom.md`).

---

## 5. dom-accessibility-api (`dom-accessibility-api/sources`)

Used by DTL (ByRole `name`/`description`, `prettyRoles`, suggestions) and by jest-dom
(`toHaveAccessibleName`, `toHaveAccessibleDescription`, `toHaveAccessibleErrorMessage`).

`computeTextAlternative(root, options)` (`accessible-name-and-description.ts:337-759`):

- **Per call setup:**
  - `safeWindow(root)` → `ownerDocument.defaultView`, with `null` meaning a TypeError (`util.ts:46-54`).
  - `window.getComputedStyle.bind(window)` (`:356`), wrapped in a per-computation `Map<Element, CSSStyleDeclaration>`
    cache (`:342-386`). The returned declaration object is held and queried later, so returning a live or lazy
    object is fine.
  - A `consultedNodes` set keyed by **node and Attr identity** (`useAttribute` `:434-448`, step 2B `:608-617`).
- **Per visited node**, recursion over `childNodes` plus `aria-owns`/`aria-labelledby` targets:
  - `isHidden(node)` (`:71-91`):
    - `isElement` uses `node.nodeType === node.ELEMENT_NODE`, so **instance access to the constant** is
      required (`util.ts:6-8`).
    - `hasAttribute('hidden')`, `getAttribute('aria-hidden')`.
    - `getComputedStyle(node).getPropertyValue('display') === 'none'` and the same for `visibility === 'hidden'`.
  - `getAttributeNode('aria-labelledby')`. Attr identity matters for loop protection, so Attr wrappers must be
    stable per element and name. Then `queryIdRefs` (`util.ts:90-108`): `node.getRootNode ? node.getRootNode() : ownerDocument`,
    then **`root.getElementById(id)`**, which is needed on `Document`, `ShadowRoot` and `DocumentFragment`.
  - `getAttribute('aria-label')`.
  - `getRole(node)` (`getRole.ts:130-224`), repeatedly through `hasAnyConcreteRoles`:
    - `getAttribute('role')`, `element.localName ?? tagName.toLowerCase()`.
    - For `<input>` the **`.type` IDL attribute**, normalized: missing or unknown → `"text"`, lowercased.
    - For `<select>`: `hasAttribute('multiple')`, `.size`.
    - For `<a>`/`<area>`: `hasAttribute('href')`. For `<img>`: `getAttribute('alt')`.
    - `hasGlobalAriaAttributes`: up to 20 `hasAttribute` calls, only for `role=presentation|none`.
  - Element text alternative (`computeElementTextAlternative`, `:458-592`):
    - `fieldset`→`legend`, `table`→`caption`, `svg`→`title` via `ArrayFrom(node.childNodes)`.
    - `img`/`area` alt; `optgroup` label; `input[type=button|submit|reset|image]` value/alt/title.
    - **`element.labels`** (`:292-322`): `null` → none; anything array-like → `ArrayFrom`; `undefined` on a
      labelable element → **polyfill**, which is `document.querySelectorAll('label')` plus `label.control`
      for each label. That is O(labels) per call, so implement `labels` on labelable elements.
  - `computeMiscTextAlternative` (`:388-432`): for each child, recurse, then
    `getComputedStyle(child).getPropertyValue('display')`. **A display other than `'inline'` inserts spaces.**
    This is why UA-default `display` values matter (§8).
  - Combobox/listbox: `select.selectedOptions` or `querySelectorAll('[aria-selected="true"]')`. Range roles:
    `aria-value*`. Textbox: `.value` or `textContent`.
  - Text nodes: `current.nodeType === current.TEXT_NODE`, then `textContent`.
  - `HTMLSlotElement.assignedNodes()` if `localName === 'slot'`. `isSVGElement` uses
    `ownerSVGElement !== undefined` (`util.ts:72-74`), so **HTML elements must not have `ownerSVGElement`**.
- **`ArrayFrom` is a polyfill that uses `length` and `items[k]`**
  (`dom-accessibility-api/sources/polyfills/array.from.ts`, confirmed in `e2e/react-app/node_modules/dom-accessibility-api/dist/polyfills/array.from.js`).
  It does **not** use `Symbol.iterator`. `childNodes`, `labels` and `selectedOptions` must be index-addressable.
  `element.childNodes.forEach` is also used (`:257`).
- `isInaccessible` and `isSubtreeInaccessible` (`is-inaccessible.ts`) mirror DTL's copies (§3.3). `isDisabled`
  checks `localName` + `hasAttribute('disabled')` + `aria-disabled`.

Typical cost: ~30 DOM calls per `getComputedStyle` call during name computation (159,721 calls for 5,210 style
calls in the app suite). Computing a simple button name is ~30–60 calls, i.e. 3–6 µs over napi.

---

## 6. jest-dom matchers (`jest-dom/src`)

Common guards (`utils.js:51-79`):

- `checkHtmlElement` requires `el.ownerDocument.defaultView`, then `el instanceof window.HTMLElement ||
  el instanceof window.SVGElement`, where `window` is `defaultView` (`globalThis`). The **global `HTMLElement`
  must be the same constructor** that wrappers inherit from.
- `checkNode` requires `instanceof window.Node`.
- The `message()` thunks (`cloneNode`, `innerHTML`, `printReceived`) run **only on failure**.

| Matcher | DOM APIs |
|---|---|
| `toBeInTheDocument` | `ownerDocument === getRootNode({composed:true})` (`to-be-in-the-document.js:11`). Document wrapper identity must be stable |
| `toHaveTextContent` | `node.textContent`, normalized |
| `toHaveAttribute` | `hasAttribute`, `getAttribute` |
| `toHaveValue` / `toHaveDisplayValue` / `toHaveFormValues` | `tagName`, `.type`, `.value`, `.checked`, `.multiple`, `.options` (iterable + `selected`/`value`), `Array.from(select)` (**select is iterable/indexed**), `form.elements` (names), `querySelectorAll('[name="…"]')` with `css.escape` (`utils.js:175-222`, `to-have-form-values.js`) |
| `toBeChecked` / `toBePartiallyChecked` | `tagName`, `.type`, `.checked`, `.indeterminate`, `role` + `aria-checked` (role table from aria-query `roles`) |
| `toBeDisabled` / `toBeEnabled` | `tagName`, `hasAttribute('disabled')` up the `parentElement` chain, `Array.from(parent.children)`, `isSameNode` for the fieldset legend rule (`to-be-disabled.js`) |
| `toHaveClass` | `getAttribute('class')` split on whitespace (not `classList`) |
| `toBeVisible` | `getRootNode({composed:true})`. For the element **and every ancestor**: `getComputedStyle(el)` → destructured `display`, `visibility`, `opacity` (camelCase **properties**), `nodeName` (DETAILS/SUMMARY), `hasAttribute('hidden'|'open')` (`to-be-visible.js:3-46`). `getComputedStyle` is called **unbound** (`const {getComputedStyle} = defaultView`) |
| `toHaveStyle` | `parseCSS` (via @adobe/css-tools) → for each property `copy = document.createElement('div'); copy.style[prop] = v; expected[prop] = copy.style[prop]` (**camelCase and kebab-case named properties on `CSSStyleDeclaration`**, with normalization). Then `computed[prop] === v \|\| computed.getPropertyValue(prop) === v`, also trying the lowercased name. On failure: `Array.from(computedStyles)` (length + index) + `getPropertyValue` (`to-have-style.js:5-80`) |
| `toHaveFocus` | `ownerDocument.activeElement === element` |
| `toHaveAccessibleName` / `…Description` / `…ErrorMessage` | `computeAccessibleName` / `computeAccessibleDescription` (§5), `getElementById` |
| `toHaveDescription` / `toHaveErrormessage` (deprecated) | `aria-describedby` → `ownerDocument.getElementById` → `textContent` |
| `toHaveRole` | same 113-selector `matches()` scan as DTL (`to-have-role.js`) |
| `toBeRequired` / `toBeInvalid` | attributes; `checkValidity()` on form/input/select/textarea |
| `toBeEmptyDOMElement` | `[...childNodes]` (iterator), `nodeType` |
| `toContainElement` | `container.contains(el)` |
| `toContainHTML` | `createElement('div').innerHTML = html; .innerHTML` (parse + serialize round-trip), `container.outerHTML.includes(...)` |
| `toHaveSelection` | `selectionStart`/`End`, `value`, `getSelection()`, `createRange()`, `contains` |
| `toAppearBefore`/`After` | `compareDocumentPosition` |

**Parity finding on `toHaveStyle` with jsdom 30** (`trace/tohavestyle-parity.txt`). jsdom 30 *fails*
`toHaveStyle('color: red')` and `toHaveStyle({fontWeight:'bold'})` on an element with exactly that inline
style. Its computed values resolve to `rgb(255, 0, 0)` and `700`, while `copy.style` keeps `red` / `bold`.
happy-dom passes these, because its computed value is the specified value. jsdom passes hex↔rgb because both
sides normalize hex to `rgb()`.

Recommendation for oxidom: **use one serializer for `element.style` and for computed values**, and keep
computed values close to the specified values. For colors, either normalize everywhere or nowhere. That makes
`toHaveStyle` round-trips pass and avoids jsdom's false negatives.

What the app needs:

- Shorthand expansion and serialization: `padding: '8px 12px'`, `borderWidth: 1` → `'1px'` (React adds `px`),
  `overflow: hidden` on `document.body`.
- `backgroundColor: '#ffffff'` (`e2e/react-app/src/__tests__/Theme.test.tsx:28-67`, `Modal.test.tsx:36,51`).

---

## 7. user-event 14.6.8 (partial support target)

(`e2e/react-app/node_modules/@testing-library/user-event/dist/esm`)

- **Value and selection interceptors** (`document/interceptor.js`, `document/prepareDocument.js`). On every
  focus (a capture listener on `document`), user-event patches the focused `input`/`textarea`. It reads
  `Object.getOwnPropertyDescriptor(element.constructor.prototype, prop)` for `value`, `setSelectionRange`,
  `selectionStart`, `selectionEnd`, `select` and `setRangeText`. If they are missing it **throws** "Element X
  does not implement …". It then `Object.defineProperty(element, prop, …)`.
  ⇒ these must be **own properties of `HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype`**, and
  `element.constructor` must be the specific class.
- **Events**: `new window[EventType](type, defaultInit)` for Event, FocusEvent, InputEvent, MouseEvent,
  PointerEvent, KeyboardEvent, ClipboardEvent and others. A class is synthesized only if the global is
  missing. It then **`Object.defineProperty(event, key, {get})` for every init member**: `key`, `code`,
  modifiers, `getModifierState`, `detail`, `view`, `button(s)`, `clientX`, `data`, `inputType` and so on
  (`event/createEvent.js`).
  ⇒ Event objects must be ordinary extensible JS objects whose prototype getters can be shadowed. React must
  read those shadowed own properties.
- `dispatchEvent.js` overrides **`event.preventDefault` and `event.defaultPrevented` as own properties** before
  `target.dispatchEvent(event)`. React calls `nativeEvent.preventDefault()`, so the same JS object must reach
  listeners, and dispatch must not rely on an internal flag that bypasses the override for user-event's own
  bookkeeping.
- Visibility and pointer checks walk ancestors with `getComputedStyle(el)`:
  - `display`/`visibility` (`utils/misc/isVisible.js`).
  - `pointerEvents` until a value that is neither empty nor `inherit`/`unset` (`utils/pointer/cssPointerEvents.js`).
  - Returning `'auto'` stops the walk early, as jsdom does. Returning `''` makes it walk to the root, as
    happy-dom does.
- Focus: `matches(FOCUSABLE_SELECTOR)` (`utils/focus/selector.js`) needs `:not()`, the child combinator
  `details > summary`, `[contenteditable=""]` and `[tabindex]`. Also `focus()`/`blur()` updating
  `document.activeElement` and firing focus/blur/focusin/focusout, plus `closest()`, `shadowRoot`,
  `getRootNode`, `tabIndex`, `disabled` and `readOnly`.
- Selection: `document.getSelection()` (`anchorNode`, `focusNode`, offsets, `setBaseAndExtent`, `addRange`,
  `removeAllRanges`, `getRangeAt`), `createRange()` (`setStart`, `setEnd`, `cloneRange`, `deleteContents`,
  `insertNode`), and input `setSelectionRange`/`selectionStart`/`selectionEnd`.
- Default actions that user-event does **not** emulate, so the DOM must provide them: checkbox/radio toggling
  on `click`, submit-button → form submission, and Enter → click on buttons (user-event dispatches the click;
  the DOM does the activation). Label → control forwarding is done by user-event itself via `label.control`
  (`event/behavior/click.js`). `keypress` with Enter looks up `input.form`, then
  `form.querySelector('input[type="submit"], button:not([type]), button[type="submit"]')`.
- Counts in the suite (§2.2): about 62k calls, mostly `namespaceURI`/`tagName` from `isElementType`, so cache
  them JS-side.

---

## 8. `getComputedStyle`: who calls it, and what it must return

**Call sites:**

| Caller | Location | Properties read |
|---|---|---|
| DTL `isInaccessible` | `role-helpers.js:52` | `.visibility` |
| DTL `isSubtreeInaccessible` | `role-helpers.js:24` | `.display` |
| dom-a11y `isHidden` | `accessible-name-and-description.ts:85-89` | `getPropertyValue('display')`, `getPropertyValue('visibility')` |
| dom-a11y `computeMiscTextAlternative` | `:413` | `getPropertyValue('display')` |
| jest-dom `toBeVisible` | `to-be-visible.js:6` | destructured `display`, `visibility`, `opacity` |
| jest-dom `toHaveStyle` | `to-have-style.js:20-30` | any property, by camelCase, kebab-case and lowercased name, plus `getPropertyValue`, `length`, `[i]` |
| user-event | `utils/misc/isVisible.js`, `utils/pointer/cssPointerEvents.js` | `display`, `visibility`, `pointerEvents` |

**Calling conventions:**

- `window.getComputedStyle(el)` with `this = globalThis` (DTL).
- `getComputedStyle.bind(window)` (dom-a11y).
- **Unbound `getComputedStyle(el)`** (jest-dom).
- The pseudo-element argument is never passed with default config.

**Volume:** 15,383 calls in the suite (DTL 9,999, dom-a11y 5,210, user-event 135, jest-dom 39). After every
React commit the first call per element is cold. That is ~380 µs per element in jsdom (§2.4), and ~5.9 s of jsdom
suite CPU in total.

**Values that must be right.** Measured in `trace/computed-style-defaults.txt`:

- **`display`**: follow the HTML UA stylesheet, as jsdom does (`jsdom/lib/jsdom/browser/default-stylesheet.css`).
  - `none` for `head`, `script`, `style`, `template`, `title`, `meta`, `link`, `base`, `datalist`,
    `[hidden]` (except `hidden=until-found`), `dialog:not([open])`, `input[type=hidden i]`.
  - `block` for div, p, section, nav, header, footer, main, form, fieldset, legend, ul, ol, dl, dd, dt, h1–h6,
    html, body, details, summary, dialog[open], pre, hr, address, blockquote, figure, figcaption.
  - `list-item` for li.
  - `table`, `table-row`, `table-cell`, `table-row-group`, `table-header-group`, `table-footer-group` and
    `table-caption` for the table family.
  - `inline-block` for button and input.
  - jsdom reports `inline` for select, textarea, img, svg, label, span, a, strong, em, code, option, iframe,
    output and progress. happy-dom differs for select, textarea, progress and option (`inline-block`/`block`).
  - Inline style and author rules override all of this.
  - Accessible names depend on inline versus non-inline (`trace/accessible-name-display.txt`):
    `<button>Save<span>d</span></button>` → jsdom `"Saved"`, happy-dom `"Save d"`;
    `<button>Hi<img alt="icon"></button>` → jsdom `"Hiicon"`, happy-dom `"Hi icon"`.
  - **To be a drop-in for existing jsdom suites, match jsdom's table.**
- **`visibility`**: **inherited**. A child of `visibility:hidden` reports `hidden`; the default is `visible`.
  DTL checks it only on the element itself (`role-helpers.js:52`).
- **`opacity`**: the default is `'1'` (jsdom; happy-dom gives `''`). Only `'0'` matters.
- **`pointer-events`**: inherited, default `'auto'` (jsdom; happy-dom gives `''` and no inheritance).
- **`toHaveStyle`** needs everything an author can set inline: longhands, common shorthands with
  serialization, custom properties (`--foo`), and React's numeric-to-`px` values. Use **the same value
  serialization as `element.style`** (§6).
- Simple `<style>` rules: both jsdom and happy-dom apply `.hide { display:none }` and `.card > p { … }`. P1 for
  oxidom, because CSS-in-JS and test-injected styles exist but React component tests usually rely on inline
  styles or none.

**Shape of the return value:**

- A `CSSStyleDeclaration`-like object with `getPropertyValue(name)`.
- Named camelCase and kebab-case getters.
- `length` and `[i]` iteration, used only on `toHaveStyle` failure.
- `cssText`.
- Read-only. Setters should throw `NoModificationAllowedError` or be no-ops.

Returning a fresh object per call is fine, but it can also be cached per element and style epoch, as happy-dom
does (`happy-dom/packages/happy-dom/src/window/BrowserWindow.ts:2255-2265`).

---

## 9. Selector engine requirements (union of all callers)

**Must (P0):**

- Selector lists (`,`) with **document-order, de-duplicated** `querySelectorAll` results.
- Type selectors (case-insensitive for HTML) and `*`.
- Attribute selectors: presence, `=`, `~=` (`*[role~="button"]`), quoted and unquoted values
  (`input[type=submit]`).
- `:not(<compound>)`, including chains like `input:not([type=hidden]):not([disabled])`.
- Combinators: child (`svg > title`, `details > summary`) and descendant (user code, `container.querySelector('tbody tr')`).
- Methods: `matches`, `closest`, `querySelector`, `querySelectorAll` on Element, Document and
  DocumentFragment.
- Selectors used by the libraries:
  - DTL: `*`, `[data-testid]`, `[placeholder]`, `[alt]`, `[aria-label]`, `[title], svg > title`, `[id="…"]`,
    `label,input`, `input,textarea,select`, `script, style`,
    `input[type=submit], input[type=button], input[type=reset]`,
    `button, input, meter, output, progress, select, textarea`, the 113 role selectors (§3.4), and
    `makeRoleSelector` lists.
  - jest-dom: `[name="…"]` (CSS-escaped).
  - user-event: `FOCUSABLE_SELECTOR`, `button,input,label,select,textarea`,
    `input[type="submit"], button:not([type]), button[type="submit"]`.

**Should (P1):**

- `^=`, `$=`, `*=`, `|=`.
- Class and id selectors (obviously common in user code).
- `:checked`, `:disabled`, `:enabled`, `:focus`, `:first-child`, `:last-child`, `:nth-child()`, `:empty`.
- The adjacent and general sibling combinators.
- The `type` attribute is matched case-insensitively in HTML documents.

**Nice (P2):** the `i`/`s` attribute flags, `:is()`/`:where()`/`:has()`, `:scope`, namespaces.

**Strategy:**

- Cache parsed selectors by string. Intern frequently used strings to ids on the JS side.
- Match right-to-left with a tag pre-check.
- For `querySelectorAll`, do one pre-order traversal of the subtree with a match per element, which keeps
  document order without a sort.
- Optionally fast-path id-only and attribute-presence-only selectors through indexes.
- The Servo `selectors` crate can do this if oxidom implements its `Element` trait; a small hand-written matcher
  covering the list above is also realistic.

---

## 10. Object model and collection requirements

The section header is plain, but these are invariants all the above code silently assumes.

- **Wrapper identity.** One JS object per node for the node's lifetime.
  - React stores fibers and props as expandos (`__reactFiber$…`, `__reactProps$…`, `_valueTracker`).
  - user-event stores Symbol flags.
  - DTL and dom-a11y key `WeakMap`/`Map`/`Set` on elements and Attr nodes.
  - jest-dom compares `ownerDocument === getRootNode()`.
  - A wrapper that is garbage-collected and later recreated loses expandos and breaks React events. Keep
    wrappers strongly reachable while the Rust node is alive. A JS array indexed by node id is the simplest
    option, and teardown per test file reclaims everything.
- **Extensible wrappers** with configurable own-property definition (`defineProperty(node,'value'|'files'|…)`).
  No Proxies on the hot path: they are slow and they break `getOwnPropertyDescriptor` expectations.
- **Prototype chain and class names** match the DOM:
  - Chain: `HTMLInputElement → HTMLElement → Element → Node → EventTarget`.
  - `constructor.name` is the interface name (pretty-format).
  - The global constructors are the same objects (`instanceof window.HTMLElement`).
  - `element.constructor.prototype` owns the element-specific accessors: `value`, `checked`, `type`,
    `selectionStart`/`selectionEnd`, `setSelectionRange`, `select`, `setRangeText`, `labels`, `form`.
- **Node constants** on `Node` and `Node.prototype`: `ELEMENT_NODE=1`, `TEXT_NODE=3`, `COMMENT_NODE=8`,
  `DOCUMENT_NODE=9`, `DOCUMENT_FRAGMENT_NODE=11`, and `DOCUMENT_POSITION_*`.
- **Collections:**
  - `NodeList` (childNodes, querySelectorAll) needs `length`, indexed `[i]`, `item()`, `forEach`, and
    `Symbol.iterator`/`keys`/`values`/`entries`.
  - `HTMLCollection` (children, `select.options`, `selectedOptions`, `form.elements`) needs `length`, `[i]`,
    `item`, `namedItem` and an iterator.
  - `NamedNodeMap` (attributes) needs `length`, `[i]`, an iterator, `getNamedItem`, and Attr `name`/`value`.
  - `childNodes`/`children` are live. Making indexed access live without a Proxy is possible because every
    consumer here reads `length` first: Array.from, ArrayFrom, `slice.call` and `forEach`. A `length`
    getter that re-syncs numeric own properties when the parent's child-version changed is enough. Static
    `querySelectorAll` results can be plain array-backed objects.
- **Reflected IDL properties** these libraries read:
  - Global: `hidden` (boolean reflect), `id`, `tabIndex`, `disabled`, `readOnly`, `required`, `type`.
  - `type` must be normalized: input defaults to `"text"`, button to `"submit"`.
  - `value` follows the input value mode: default value from the attribute, then a dirty flag.
  - `checked`/`defaultChecked`, `indeterminate`, `selected`, `multiple`, `size`, `name`, `href` (anchor),
    `labels`, `control`, `form`, `options`, `selectedOptions`, `textContent`, `innerHTML`, `outerHTML`, `data`.
  - **No `ownerSVGElement` on HTML elements; no `defaultView` on elements.**
- **Window/document surface.** `document.body`, `documentElement` and `activeElement` (defaults to body).
  `getElementById` on document and fragment. `defaultView` (rewritten to `globalThis` by the environment).
  Globals: `MutationObserver`, the event constructors of §3.6, `getComputedStyle`, `Node`, `Element`,
  `HTMLElement`, `SVGElement` and all `HTML*Element` classes.

---

## 11. Hot paths ranked, with oxidom implications

| # | Hot path | Evidence | What oxidom should do |
|---|---|---|---|
| 1 | `getComputedStyle` (DTL `isInaccessible`, dom-a11y `isHidden` and separators) | ~5.9 s (17%) of jsdom suite CPU; ~380 µs cold per element in jsdom, ~200 µs in happy-dom | Rust-side style resolution of a few properties from a per-tag UA table, attribute rules, inline style and (rare) author rules, cached by `(node, style_epoch)`. A small JS facade object, cached per element and epoch, with lazy getters. Inherited props (`visibility`, `pointer-events`) by walking the parent chain in Rust |
| 2 | `matches()` with the 113 aria-query selectors (ByRole, toHaveRole) | 272,706 calls by DTL in the suite; ~2.5 µs each in jsdom | Parsed-selector cache, JS-side string→id interning, right-to-left matching with a tag pre-check. Target ≤100 ns per call including napi |
| 3 | `querySelectorAll` + `Array.from` over the whole container (ByRole, ByText `*`, ByLabelText `*`, ByTestId `[data-testid]`) | 2.3 s DTL→qSA in jsdom; 4–6 ms per call on 2–3.6k elements | One subtree traversal in Rust; ids returned through a reusable shared buffer; JS maps ids to cached wrappers. Optional epoch-keyed result cache like happy-dom's |
| 4 | Accessible-name inputs (dom-a11y) | 2.8 s inclusive in jsdom; ~160k DOM calls | Cheap `nodeType`/`localName`/`getAttribute`/`hasAttribute`/`childNodes`/`labels`; label associations memoized per epoch, as jsdom does (`jsdom/lib/jsdom/living/helpers/form-controls.js:168-180`); stable Attr wrappers |
| 5 | Error formatting (`prettyDOM` + `outerHTML`) on failed `getBy*`, and on every failed `findBy*` attempt | 52 ms per call on 3.6k elements; a 1.1 s role miss in jsdom | Fast `outerHTML` serialization in Rust; cheap `attributes` iteration (one napi call returning all attributes); `constructor.name` correct |
| 6 | `fireEvent` / user-event dispatch, followed by React re-render | 3.4 s inclusive (mostly React work and DOM mutations) | Fast event path (§3.6), activation behaviours, and fast `createElement`/`appendChild`/`setAttribute`/`textContent=` for React's commit (sibling doc) |
| 7 | MutationObserver-driven re-queries in `waitFor`/`findBy*` | 10 observers in the suite (small here, large in async-heavy suites) | Microtask-batched callbacks; zero cost when nobody observes |
| 8 | Trivial getters (`tagName`, `nodeType`, `ownerDocument`, `namespaceURI`, `localName`, `parentElement`) | Several hundred thousand calls | Immutables as JS fields on the wrapper (~2 ns); mutable links over napi (~90 ns) are acceptable at this volume |

Environment overheads that are outside Testing Library but visible in the same profiles:

- jsdom spends ~1 s per suite creating windows (`new JSDOM`, `installInterfaces`), roughly 0.6–0.9 s per test
  file in wall time.
- It spends ~3 s compiling modules (`wrapSafe`).

oxidom's environment setup should be cheap: lazy class installation, and a native addon loaded once per worker.
This can matter as much as query speed for suites made of many small files.

---

## 12. Prioritized requirements (summary)

**P0, without which Testing Library tests fail or are badly wrong:**

- querySelector, querySelectorAll, matches and closest with the §9 P0 grammar.
- getAttribute, hasAttribute, setAttribute, removeAttribute, `attributes` and `getAttributeNode` with stable
  Attr objects.
- childNodes, children, parentElement and parentNode, with index-addressable collections.
- textContent, innerHTML and outerHTML.
- Node constants on instances; correct `constructor.name` per interface.
- `getComputedStyle` (unbound) with UA `display`, inherited `visibility`, `opacity`, `pointer-events`, inline
  style, and `getPropertyValue` plus named getters.
- `element.style` (CSSStyleDeclaration) with camelCase and kebab-case named properties, shorthand basics, and
  the same serializer as the computed values.
- Event constructors: Event, UIEvent, MouseEvent, KeyboardEvent (with keyCode/charCode/which), FocusEvent,
  InputEvent, PointerEvent, CustomEvent. `dispatchEvent` with capture, target and bubble phases and the
  correct boolean result. Checkbox/radio and submit-button activation behaviour.
- Own `value` accessors on the input, textarea and select prototypes. `type` normalization.
- `checked`, `selected`, `options`, `selectedOptions`, `labels`, `hidden` IDL, `focus()`/`blur()` with
  `activeElement`.
- MutationObserver, microtask-batched.
- `getRootNode()` (`composed` option); `getElementById` on Document.
- Stable wrapper identity and extensible wrappers; globals installed for Vitest, including
  `defaultView === globalThis`.

**P1, needed for common tests and parity:**

- Shorthand serialization (padding, margin, border, overflow).
- Simple `<style>` author rules in `getComputedStyle`.
- WheelEvent, TouchEvent, CompositionEvent, ProgressEvent, PopStateEvent, PageTransitionEvent,
  TransitionEvent, AnimationEvent, and `SubmitEvent` (with `submitter`) for submit-button activation.
- Label activation forwarding; `label.control`; `form`, `form.elements`, `requestSubmit`.
- Selection and Range: `getSelection`, `createRange`, `setStart`/`setEnd`, `cloneRange`, and
  **`createContextualFragment`** (RTL `asFragment`).
- `setSelectionRange`, `selectionStart`/`selectionEnd`, `select()`, `setRangeText`.
- `compareDocumentPosition`, `contains`, `isSameNode`, `cloneNode(deep)`, `checkValidity`, `indeterminate`.
- `HTMLSlotElement.assignedNodes`, `shadowRoot`/`attachShadow` basics.
- Full MutationRecords.
- The P1 selectors from §9.

**P2, rarely hit:**

- `ClipboardEvent`, `DragEvent`, `DataTransfer` (better left absent, so DTL uses its fallback).
- TreeWalker and NodeIterator (unused by these libraries).
- Pseudo-element computed styles.
- `:has()`/`:is()`; iframes and `contentDocument`; `HTMLTableSectionElement.rows`.

---

## 13. Pitfalls checklist

1. Iterator-only `NodeList`/`HTMLCollection`: dom-a11y `ArrayFrom` and pretty-format `slice.call` see empty
   lists, every accessible name becomes `""`, and every `getByRole({name})` fails.
2. A missing `node.ELEMENT_NODE` on instances makes `isElement()` always false in dom-a11y, with the same
   result.
3. Wrapper class names not matching `/^(HTML|SVG)\w*Element$/`, `Text`, `Comment` or `DocumentFragment` make
   `prettyDOM` and Vitest diffs print garbage, or loop on internal fields.
4. A `value` accessor not owned by the element's immediate prototype: `fireEvent.change` throws "does not have
   a value setter" or React never sees the change, and user-event throws "does not implement value".
5. `getComputedStyle` that depends on `this` breaks jest-dom `toBeVisible`/`toHaveStyle`, because they call it
   unbound.
6. All-`''` or all-`block` `display` defaults: accessible names gain or lose spaces compared with jsdom, so
   `getByRole('button', {name: 'Saved'})` stops matching. Missing `[hidden] → none` or non-inherited
   `visibility` makes ByRole return hidden elements.
7. MutationObserver firing synchronously, or once per mutation: `findBy*` re-runs a full query per inserted
   node. A missing MutationObserver adds up to 50 ms of latency to each `waitFor`.
8. Wrappers recreated after GC: React expandos are lost and events stop reaching handlers. DTL and dom-a11y
   caches miss.
9. `document.body` replaced between tests, or created after DTL import: `screen` is bound to a stale or missing
   body.
10. `createRange` without `createContextualFragment`: RTL `asFragment()` throws.
11. A `DataTransfer` global that is a partial stub: DTL tries `new window.DataTransfer()` and defines
    properties on it. Better absent.
12. `KeyboardEvent` ignoring `keyCode`/`charCode`: React `onKeyPress`/`onKeyDown` handlers that read
    `event.keyCode` or `charCode` silently fail. Event init dictionaries must ignore unknown keys like
    `target`.
13. Event objects that are frozen, or that read state from internal slots: user-event's
    `defineProperty(event, 'key'|'preventDefault'|'defaultPrevented', …)` has no effect.
14. `querySelectorAll` with comma lists concatenated per selector instead of in tree order:
    `getAllByRole(...)[i]` order changes and duplicates appear.
15. `labels` returning `undefined` on labelable elements: dom-a11y falls back to scanning every `<label>` in the
    document for each name computation. Returning `undefined` on non-labelable elements is fine, as is `null`.
16. Assuming jsdom is the gold standard for `toHaveStyle`: jsdom 30 fails `color: red` and `font-weight: bold`
    round-trips. Pick consistent serialization instead.
17. HTML elements exposing `ownerSVGElement`: dom-a11y treats them as SVG.
18. Per-call `Uint32Array` allocation for node lists: ~2 µs plus GC churn per call. Use a shared scratch
    buffer.

---

## 14. Open questions and next steps

- Measure oxidom against §2.3 and §2.4, using the **same scripts**: `trace/microbench.cjs` and the cold-style
  benchmarks. Add a "mutation between queries" variant so happy-dom's memoization does not flatter it.
- Decide the color and shorthand serialization policy (jsdom-like `rgb()` versus specified values) and
  document the parity consequences.
- Whether to add an epoch-keyed `querySelectorAll` result cache. It mostly helps repeated identical queries
  on an unchanged DOM, which happens in tests (`getByRole` several times between two events) but is less
  common than it looks in micro-benchmarks.
- Whether to ship an opt-in `configure({getElementError})` that uses a native serializer. It would make failed
  `findBy*` retries cheap on large DOMs.
