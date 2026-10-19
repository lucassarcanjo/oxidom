# jsdom vs happy-dom vs rsdom: parity, gaps and differences

> Baseline study from the lab phase (2026-10-17). The harnesses that produced it now live in `conformance/wpt`,
> `conformance/api-surface` and `e2e/libraries`; the one-off architecture, synthesis and verification studies
> (`compare/arch`, `compare/synthesis`, `compare/verify`) and the raw data stay in rsdom-lab. The prioritised list in
> §3.2 is the basis of [`ROADMAP.md`](ROADMAP.md).

**Versions:** jsdom 30.1.3, happy-dom 21.0.3, rsdom 0.1.0 (working tree, prebuilt release addon), Vitest 5.0.5, Node 22.22.0, React 19.3.1. Measured 2026-10-17.

Every number below was produced by a script in the lab's `compare/` directory, and each table names its source file. Section 6 gives the commands to re-run everything.

This document answers two questions:
1. How far is rsdom from implementing everything jsdom has? (§2, roadmap in §3)
2. How do happy-dom and jsdom differ, and where are the gaps? (§4)

---

## 1. Short answers

**rsdom vs jsdom.** By API surface, rsdom has about **62%** of what jsdom exposes. By behaviour it is about **half**. It passes **11 of the 18** real libraries that pass on jsdom.

- **Surface:** rsdom has 149 of jsdom's 209 interfaces (71%) and 1,167 of 1,877 IDL members (62%). Excluding the 339 `on*` handler attributes, it has 56% of members.
- **WPT:** rsdom passes 82,867 of the 162,751 subtests jsdom passes (51%). It fully passes 733 of the 1,420 files jsdom fully passes (52%). The mean per-file pass rate is 40.4% for rsdom against jsdom's 66.3%.
- **Concentration:** 47.5% of rsdom's per-file gap is in four areas it deliberately left out: CSSOM rule objects, custom elements, Shadow DOM, and computed-value serialisation (in css/selectors).
- **App-testing APIs:** of 385 hand-curated APIs used in app testing, rsdom is missing **no P0 items**, 41 P1 and 30 P2.
- **Libraries:** the 7 library failures that are specific to rsdom come from only **four missing APIs**: TreeWalker/NodeFilter (4 libraries), ShadowRoot (1), history traversal (1) and XMLHttpRequest (1). Three of the four are small or medium jobs (§3).

**happy-dom vs jsdom.**
- **Breadth:** happy-dom has **more APIs** than jsdom. It exposes 152 global interfaces jsdom lacks, and it has more working features in the probes: 34 against jsdom's 28.
- **Coverage of jsdom's own surface:** happy-dom covers only 72% of jsdom's IDL members. Only 50% of members sit on the interface the spec puts them on.
- **Spec fidelity:** in 63 side-by-side repros where the two differ, jsdom matches the spec in 56.
- **WPT:** happy-dom scores 38.1% mean per-file against jsdom's 66.3%. Part of that gap is two helper-method bugs that abort whole test files (§4.3).
- **Libraries and speed:** on real libraries the two are close: jsdom 18/20, happy-dom 17/20 plus one that passes with an unhandled rejection. happy-dom is about 2x faster to set up and uses about 3x more memory per node.

---

## 2. How far is rsdom from jsdom?

### 2.1 Method in one paragraph per study

| study | what it measures | scripts / results |
|---|---|---|
| **Surface census** | Presence of every interface and member in jsdom's 227 WebIDL files: 209 interfaces exposed on Window and 1,877 members, after merging partials and mixins, deduplicating overloads and expanding iterables. Plus 180 hand-written Window members and 1,640 CSS property accessors. Each DOM is installed on `globalThis` exactly as Vitest 5 does it. A member counts as present if it is anywhere in the prototype chain or is an instance field. "Right interface" means it sits on the prototype the spec names. | `conformance/api-surface/` → `results/summary.md`, `surface.json` |
| **WPT** | Behaviour on web-platform-tests at the exact commit jsdom pins (`2971340`). From 67 of jsdom's 127 WPT directories that exercise a DOM test environment, 2,389 test files and 187,113 subtests were run. Each file runs once per DOM in a fresh process, through the Vitest environment (global-install mode). As a fidelity check, jsdom in this harness agrees with jsdom's own expectations on 92.0% of files and 99.2% of subtests. | `conformance/wpt/` → `results/summary.md`, `wpt.json` |
| **Libraries** | 20 popular libraries (Radix, Headless UI, react-aria, MUI, focus-trap, floating-ui, TanStack Table, react-hook-form, downshift, react-select, framer-motion, react-router, tiptap, lexical, lit, axios, msw). 41 smoke tests written like app tests: render, then user-event, then jest-dom. Every failure has a verified root cause, and counterfactual tests confirm most of them. A static census also searches each library's shipped JS for 50 DOM APIs. | `e2e/libraries/` → `results/summary.md`, `libs.json`, `census.json` |
| **Architecture and behaviour** | 53 capability probes, 93 side-by-side behaviour repros with a spec verdict for each, lines of code, dependencies, and memory and setup footprint. | `rsdom-lab/compare/arch/` → `summary.md`, `results/*.json` |
| **Synthesis** (this document) | Derived WPT gap metrics, lines of code per roadmap area and the priority scores. | `rsdom-lab/compare/synthesis/derive.mjs` → `results/derived.json` |

### 2.2 API surface (source: `conformance/api-surface/results/summary.md`)

| | interfaces | members anywhere in the chain | on the right interface |
|---|---:|---:|---:|
| jsdom (denominator) | 209 | 1,877 | 1,877 |
| **rsdom** | **149 (71.3%)** | **1,167 (62.2%)** | 1,166 (62.1%) |
| happy-dom | 178 (85.2%) | 1,344 (71.6%) | 941 (50.1%) |

| other measures | jsdom | rsdom | happy-dom |
|---|---:|---:|---:|
| members, excluding obsolete HTML features (1,733) | 100% | 65.8% | 77.4% |
| members, excluding `on*` handlers (1,538) | 100% | 55.8% | 71.0% |
| Window members (180) | 180 | **165 (91.7%)** | 151 (83.9%) |
| CSS property accessors (1,640) | 1,640 | 1,640 | 590 |
| curated app-testing items jsdom has (385): missing P0 / P1 / P2 | 0 / 0 / 0 | **0** / 41 / 30 | 2 / 11 / 12 |

**rsdom by area** (members present / jsdom members):

| area | jsdom members | rsdom | happy-dom | rsdom's notable gaps |
|---|---:|---:|---:|---|
| DOM core | 436 | **369 (84.6%)** | 313 (71.8%) | createEvent, createTreeWalker/NodeIterator, styleSheets, forms/links/images, attachShadow, ARIA reflection |
| Events | 150 | **127 (84.7%)** | 111 (74.0%) | BeforeUnload/PromiseRejection/Close/Blob/Device* events |
| Forms & validation | 259 | 199 (76.8%) | 202 (78.0%) | stepUp/stepDown, valueAsDate, meter, progress, ElementInternals |
| Window, navigation & history | 63 | 41 (65.1%) | 59 (93.7%) | Plugin/MimeType, BarProp, External, customElements, postMessage |
| SVG | 164 | 97 (59.1%) | 144 (87.8%) | SVGRect/Number/Animated*/StringList, ownerSVGElement |
| Networking | 58 | 27 (46.6%) | 51 (87.9%) | XMLHttpRequest (WebSocket and Headers are Node's) |
| HTML elements | 473 | 215 (45.5%) | 255 (53.9%) | canvas, iframe contentDocument, media, many reflected attributes |
| Traversal, Range & Selection | 89 | 40 (44.9%) | 81 (91.0%) | TreeWalker, NodeIterator, NodeFilter, StaticRange, Range mutation/compare |
| File API | 27 | 10 (37.0%) | 23 (85.2%) | FileReader; Blob/File are Node's |
| CSSOM | 98 | **10 (10.2%)** | 50 (51.0%) | CSSStyleSheet, CSSRule*, StyleSheetList, MediaList |
| Custom elements & Shadow DOM | 13 | **1 (7.7%)** | 13 (100%) | ShadowRoot, CustomElementRegistry, attachShadow, slots |
| Geometry | 15 | **0** | 15 | DOMRect, DOMRectReadOnly |
| Parsing & serialization | 2 | 1 (50.0%) | 2 | XMLSerializer |
| Mutation observers, Storage, Encoding, Misc | 30 | 30 (100%) | 25 | none |

**Where rsdom is ahead of jsdom on surface** (members jsdom does not have at all): matchMedia (a stub that matches nothing), innerText/outerText, contentEditable/isContentEditable, dialog show/showModal/close, InputEvent.getTargetRanges, Range.getBoundingClientRect/getClientRects, HTMLImageElement.decode, document.scrollingElement, and the animation/transition `on*` handlers.

### 2.3 Behaviour on WPT (source: `conformance/wpt/results/summary.md`; derived metrics in `rsdom-lab/compare/synthesis/results/derived.json`)

| | jsdom | rsdom | happy-dom |
|---|---:|---:|---:|
| mean per-file pass rate (fairer headline) | 66.3% | **40.4%** | 38.1% |
| subtests passed (187,113) | 87.0% | 46.5% | 29.8% |
| of jsdom's 162,751 passing subtests, also passed | 100% | **50.9%** | 33.1% |
| of jsdom's 1,420 fully passing files, also fully passed | 100% | **733 (51.6%)** | 550 (38.7%) |
| per-file gap behind jsdom, in "file equivalents" | 0 | 663.7 | 746.7 |
| per-file lead over jsdom, in "file equivalents" | 0 | 43.6 | 71.9 |
| harness errors / timeouts / crashes | 91 / 87 / 3 | 156 / 124 / **0** | 122 / 105 / 8 |

**Where rsdom's gap behind jsdom sits.** The share of the 663.7 file-equivalent gap by area (derived.json `wptAreas`):

| WPT area | files | rsdom gap share | rsdom / jsdom per-file pass rate | cause |
|---|---:|---:|---|---|
| css/cssom | 228 | **13.4%** | 31.1% / 66.7% | no CSSStyleSheet or cssRules |
| custom-elements | 146 | **12.8%** | 1.5% / 59.8% | no customElements |
| shadow-dom | 128 | **11.0%** | 5.5% / 62.6% | no attachShadow |
| css/selectors | 203 | **10.3%** | 22.7% / 56.1% | computed colours stay keywords; no `sheet.insertRule` |
| dom/nodes | 284 | 6.7% | 62.2% / 76.1% | name validation does not throw; no XML documents |
| html/semantics/other | 91 | 6.4% | 44.4% / 90.8% | assorted: tables, details, links |
| html/semantics/forms | 267 | 5.7% | 71.9% / 85.7% | stepUp/stepDown, colour input, select events |
| dom/ranges | 40 | 3.6% | 39.0% / 99.4% | compareBoundaryPoints and similar (about 24,600 failing subtests, 93% of them in 4 generated files) |
| html/dom | 128 | 3.4% | 56.6% / 66.9% | reflected IDL attributes return undefined |
| dom/events | 86 | 3.3% | 47.6% / 73.0% | no createEvent or init*Event |
| everything else | 788 | 23.4% | | selection, FileAPI, XPath, storage, XHR, traversal, ... |

**Where rsdom beats or ties jsdom:**
- dom/nodes subtests: 7,410 against 6,409. This comes from `Node-compareDocumentPosition.html`, a known jsdom failure.
- innerText setter and innerText white-space files.
- dom/lists: a tie (same subtests, same per-file rate). html/webappapis: the same 348 subtests, but a lower per-file rate (67.7% against 72.2%).
- dom/abort: 100% against 73.4%. This is a global-install artefact, not rsdom code.

### 2.4 Real libraries (source: `e2e/libraries/results/summary.md`)

| with the documented shims | jsdom | rsdom | happy-dom |
|---|---:|---:|---:|
| libraries fully passing (20) | 18 | **11** | 17 (+1 that passes but has an unhandled rejection) |
| tests passing (41) | 39 | 28 | 38 |
| libraries fully passing without shims | 16 | 10 | 17 |

Every library rsdom passes also passes on jsdom. The 7 that pass on jsdom and fail on rsdom, with their verified causes:

| library | rsdom failure | missing API |
|---|---|---|
| @radix-ui/react-dialog | `NodeFilter is not defined` in FocusScope | TreeWalker / NodeFilter |
| @headlessui/react (Menu) | `NodeFilter is not defined` in use-tree-walker | TreeWalker / NodeFilter |
| react-aria-components (3/3 tests) | `NodeFilter` in ariaHideOutside and FocusScope | TreeWalker / NodeFilter |
| lit | `createTreeWalker is not a function` at import | TreeWalker, then (not yet observed) attachShadow and customElements |
| @mui/material (Dialog) | `ShadowRoot is not defined` in `@mui/utils` contains() | ShadowRoot global |
| react-router (BrowserRouter + back()) | back() is a no-op, so no popstate fires | session history traversal |
| axios (`adapter: 'xhr'`) | adapter not supported | XMLHttpRequest |

tiptap and lexical fail on jsdom too. On rsdom they fail first on the Selection stub: `collapse()` creates no Range, so user-event's `getRangeAt(0)` throws.

`docs/lab/ROADMAP.md` lists TreeWalker as out of scope because "no target library uses them". This study contradicts that: 7 of the 20 libraries reference it, and 4 failed on it.

### 2.5 Capabilities (source: `rsdom-lab/compare/arch/summary.md`, 53 probes)

| | yes | partial | stub | no |
|---|---:|---:|---:|---:|
| jsdom | 28 | 6 | 3 | 16 |
| rsdom | 11 | 15 | 4 | 23 |
| happy-dom | 34 | 9 | 6 | 4 |

rsdom answers "no" where jsdom answers "yes" for these features:
- script execution and inline `on*` attributes
- external script and stylesheet loading
- XHR
- Shadow DOM and custom elements
- TreeWalker / NodeIterator
- XPath

XML parsing is rated "partial" rather than "no", because DOMParser handles text/html. XML MIME types throw NotSupportedError, and XMLSerializer is missing. Most of these are on rsdom's explicit out-of-scope list (`docs/lab/ROADMAP.md`).

On the 93 behaviour repros, rsdom matches the spec on 77, jsdom on 86 and happy-dom on 36. rsdom gives a different value from jsdom in 12 repros. In 10 of them jsdom matches the spec:
- keyword colours and inline `font-weight: bold` stay as authored in computed style (UA-sheet `<b>` does compute to 700)
- em values are not resolved (2 repros)
- `:invalid` misses inputs with a pattern mismatch
- `document.forms` and `tbody.rows` are missing
- the XML DOMParser throws
- `childNodes` exposes no index keys to `Object.keys`
- `setTimeout` returns Node's Timeout object. Under Vitest this happens in all three environments, because Vitest leaves Node's timers on `globalThis`.

In the other two, jsdom does not match the spec. rsdom's innerText ignores `<br>` and `display:none`, and jsdom has no innerText at all, so neither matches. For custom-property whitespace, rsdom matches the spec and jsdom does not. Outside the battery, the capability probes also show that localStorage named properties (`localStorage.key`, `localStorage[key] = v`) do not work in rsdom.

### 2.6 Putting it together

| lens | rsdom as a share of jsdom |
|---|---|
| IDL interfaces present | 71% |
| IDL members present | 62% (56% without `on*`) |
| curated P0 app-testing APIs | 100% |
| WPT subtests jsdom passes that rsdom also passes | 51% |
| WPT mean per-file pass rate (40.4 / 66.3) | 61% |
| real libraries passing (11 / 18) | 61% |
| probed capabilities rated "yes" (11 / 28) | 39% |

These lenses agree well:
- **Core DOM is close to parity.** DOM core, events, forms, MutationObserver and storage are at 77-100% of jsdom's surface. rsdom beats jsdom in a few WPT files (compareDocumentPosition, innerText), and it matched jsdom on every HTML-parsing and selector-syntax repro in the behaviour battery. Its one selector miss, `:invalid` with patternMismatch, is a form-validity bug, and XML parsing is absent. Its weak css/selectors WPT score comes from computed-colour serialisation, not from selector matching.
- **Whole subsystems are missing.** CSSOM rule objects, Shadow DOM, custom elements, traversal objects, full Range/Selection, XHR, XML/XPath and script execution account for most of the remaining distance.
- **Those subsystems were left out on purpose.** The libraries study shows that three of them (traversal, ShadowRoot, Selection) matter more for real component libraries than the original scoping assumed.

---

## 3. Prioritised parity roadmap for rsdom

### 3.1 How priority and effort were set

**Priority** is a score (computed in `rsdom-lab/compare/synthesis/derive.mjs`, field `priorities`):

`score = (3 × libraries failing on rsdom but not jsdom + libraries referencing a missing API (census) + rsdom WPT gap share in % / 2) / effort weight`

The effort weights are S=1, M=2, L=4 and XL=8. Library failures weigh most because they are verified. Census hits indicate risk only. WPT share measures breadth of spec behaviour. Only needs relevant to parity count: an API jsdom also lacks scores zero.

**Effort** sizes are judgements with a stated basis:
- **Size of jsdom's implementation.** jsdom's own lines of code for the area (`derived.json` → `roadmap[].jsdomLoc`).
- **Calibration.** For areas both DOMs implement, rsdom needed 0.8-3.3x jsdom's hand-written lines (median about 1.9x): MutationObserver 939 vs 281, events 1,290 vs 936, focus 171 vs 212, parse/serialise glue 801 vs 327. The ratio is above 1 because jsdom's webidl2js generates argument conversion and brand checks, and because rsdom state kept in Rust needs both a Rust half and a JS half.
- **Fit with rsdom's design.** Some areas cost more because of rsdom's architecture (`docs/DESIGN.md`):
  - Rust never calls back into JS (§0).
  - Mutations run inside Rust, including the innerHTML parse and replace-all.
  - Event dispatch is pure JS over parent links (§5).
  - Computed style is memoised per STYLE epoch (§8).
  - Anything that must react to every mutation (live Ranges, NodeIterator, custom-element reactions) has to be wired into Rust's mutation paths, and must keep a zero-cost fast path when it is unused.

| size | meaning |
|---|---|
| S | under ~600 new rsdom lines, JS facade only or an isolated module, no hot-path change |
| M | ~600-2,000 lines, or new Rust state outside hot paths |
| L | more than 2,000 lines, or a change to the Rust data model, mutation paths, dispatch or the cascade |
| XL | an architectural change: a second realm or browsing context, script execution, a resource loader |

### 3.2 Roadmap

| # | area | rsdom today | effort | score | who needs it (measured) |
|---:|---|---|:-:|---:|---|
| 1 | **TreeWalker / NodeIterator / NodeFilter** | absent (listed as out of scope) | S | 20.1 | 4 libraries fail (Radix Dialog, Headless UI, react-aria, lit); 7/20 reference it; dom/traversal 1.1% vs 94.9% |
| 2 | **ShadowRoot + attachShadow, without retargeting** | absent | M | 8.7 | MUI fails (every Modal or Dialog); the ShadowRoot global is referenced by 11/20; about 6.7% of the WPT gap |
| 3 | **Selection backed by real Ranges** | stub: collapse() creates no Range | M | 5.7 | tiptap and lexical typing (user-event `getRangeAt`); 4/20 call collapse() or setBaseAndExtent(); selection 37.6% vs 65.3% |
| 4 | **Session history traversal** | back/forward/go are no-ops | S | 4.0 | react-router BrowserRouter + back() |
| 5 | **XMLHttpRequest** | absent (Node's fetch only) | M | 3.0 | axios `adapter:'xhr'`; 2/20 reference it; xhr 49.3% vs 95.8% |
| 6 | **CSSOM rule objects** | 2 of 25 CSSOM interfaces | L | 2.9 | insertRule referenced by 5/20; the largest WPT gap share (13.4%) |
| 7 | **Computed-value fidelity** | colours stay keywords, `bold`, em unresolved | M | 2.6 | css/selectors share 10.3%; 60 files jsdom fully passes |
| 8 | **Full Shadow DOM**: retargeting, slots, scoped styles | absent | L | 2.0 | assignedNodes referenced by 6/20, composedPath by 9/20; about 4.3% of the WPT gap |
| 9 | **Custom elements** | absent | L | 1.9 | lit (after #1 and #2); custom-elements share 12.8% |
| 10 | document.createEvent + init*Event + missing event classes | 19 of 27 event interfaces | S | 1.7 | dom/events 47.6% vs 73.0% (25 files fail on createEvent, and 2 of them abort before any subtest runs) |
| 11 | Forms remainder | 199 of 259 members | M | 1.4 | forms 71.9% vs 85.7%; P1 curated (stepUp, valueAsDate) |
| 12 | FileReader (+ DOM Blob/File) | absent; Blob is Node's | S | 1.3 | FileAPI 40.8% vs 80.9%; P1 curated |
| 13 | Web Storage named properties | methods and `length` work; named access does not | S | 1.2 | webstorage 37% vs 100% |
| 14 | Reflected IDL attributes + ARIAMixin | HTML elements 45.5%; no `role`/`aria*` | M | 0.85 | html/dom 56.6% vs 66.9% |
| 15 | Range comparison and stringify (non-mutating) | boundary setters only | S | 0.77 | about 24,600 failing WPT subtests in 4 files |
| 16 | Range mutation + live boundary updates | absent | L | 0.26 | P1 curated (deleteContents, insertNode); dom/ranges mutation files |
| 17 | XPath | absent (happy-dom lacks it too) | M | 0.62 | domxpath 1.9% vs 63.2%; no library in the census |
| 18 | XML documents and XMLSerializer | DOMParser handles text/html only | M | 0.41 | domparsing; no library in the sample |
| 19 | DOMRect classes + Window odds and ends | plain-object rects | S | 0 | P1 curated (postMessage, DOMRect); no measured failure |
| 20 | iframes, script execution, resource loading | absent (out of scope) | XL | 0.03 | no library in the sample; WPT mostly excluded by the harness |
| (β) | Beyond parity: ResizeObserver/IntersectionObserver no-ops, scrollIntoView/scrollTo, elementFromPoint, pointer capture, inert, checkVisibility | absent (jsdom lacks them too) | S | 0* | 10-11/20 libraries reference them; jsdom setups shim them; happy-dom has them natively |

Rows are in score order with two exceptions. Range mutation (#16, 0.26) is placed next to Range comparison, and DOMRect (#19, 0) comes before iframes (#20, 0.03). By score alone the tail would be XPath, XML, Range mutation, iframes, DOMRect (`derived.json` → `priorities`).

\* Scores zero under the parity-only formula. It is still cheap, and it would let rsdom run without the shims that jsdom setups carry.

**Library parity in this sample.** Items 1, 2, 4 and 5 (S+M+S+M) remove every rsdom-only failure observed in the library sample, with two exceptions:
- lit will next need attachShadow, which is #2, and custom elements, which is #9.
- react-aria and Radix may hit later blockers that cannot be seen yet, because they currently stop at NodeFilter.

### 3.3 Notes per item (basis for the effort sizes)

1. **Traversal (S).** jsdom's traversal/ plus helpers/traversal.js come to 341 lines.
   - TreeWalker is pure JS over the zero-FFI node table: about 5 ns per node read (DESIGN §2.2).
   - NodeIterator's "pre-removing steps" need to know about removals, including the ones that happen inside Rust (innerHTML, textContent replace-all). The cheap version is a per-document list of live iterators that the facade fixes up, plus a Rust removal flag on the epoch page. It is rarely used (0/20 in the census).
2. **ShadowRoot basic (M).** jsdom's ShadowRoot-impl.js is 30 lines, plus parts of helpers/shadow-dom.js (219).
   - In rsdom this touches the Rust tree: the host link goes in the NodeRec slot already reserved for it (DESIGN §2.2, `_res`).
   - `getRootNode({composed})`, `isConnected` through hosts, and qSA not crossing into shadow trees.
   - The selector adapter needs its shadow-host hooks, and the facade needs a ShadowRoot class.
   - Event dispatch is unchanged in this phase. The ShadowRoot global alone already unblocks MUI.
3. **Selection (M).** jsdom's selection/ is 252 lines.
   - collapse, extend, setBaseAndExtent and selectAllChildren must create and own a Range.
   - toString, containsNode and deleteFromDocument, plus a queued `selectionchange` event.
   - It can ship with non-live ranges first. Correct behaviour under mutation needs #16.
   - DESIGN keeps selection state in Rust, so the document selection should live next to the input selection.
4. **History (S).** jsdom's History-impl, SessionHistory and navigation come to 264 lines. This is JS only: an entry list, traversal queued as a task, popstate carrying state, and hashchange.
5. **XHR (M).** jsdom's xhr/ is 1,278 lines, but that includes FormData (rsdom already has it) and the synchronous-XHR worker (skip it). Async XHR can be built on Node's fetch/undici in the facade, resolving URLs against `document.URL`, with progress events and responseType. No Rust is needed.
6. **CSSOM (L).** jsdom's rule classes come to 1,123 lines, and parsing is delegated to css-tree.
   - rsdom's Rust `style/sheet.rs` (466 lines) is a matching index, not a rule tree.
   - The work: rule objects with stable identity, cssText serialisation, `HTMLStyleElement.sheet`, `document.styleSheets`, constructable sheets, and insertRule/deleteRule that re-index the cascade and bump the STYLE epoch.
7. **Computed values (M).** jsdom's css/helpers is 3,737 lines, but that covers parsing *and* computed values. rsdom already has the parsing half: `style/value.rs` (1,248 lines) already serialises inline colours as rgb().
   - Needed: CSS Color 4 serialisation of cascaded keywords, em/rem to px from the computed font-size, and numeric font-weight.
   - Risk: em resolution makes more properties depend on ancestors under the per-epoch memo.
   - Not measured, but likely: jest-dom `toHaveStyle` mismatches when a stylesheet uses colour keywords, because rsdom normalises the inline expected value to rgb() and leaves the computed value as a keyword.
8. **Full Shadow DOM (L).** jsdom: shadow-dom helpers (219) + Slotable/HTMLSlotElement (76) + EventTarget-impl (373, where retargeting lives).
   - Retargeting adds a per-listener target computation when a path crosses a shadow root. To keep today's dispatch fast path, guard it with a per-document shadow-root count.
   - Scoped `<style>` requires partitioning the Rust cascade per tree.
   - Slots need assignment and slotchange.
   - happy-dom ships without retargeting and still passes lit's smoke tests, so retargeting could come last.
9. **Custom elements (L).** jsdom: custom-elements/ + helpers/custom-elements.js + html-constructor.js = 514 lines, plus `[CEReactions]` in every generated mutating wrapper.
   - Rust cannot call JS, so reactions caused by mutations inside Rust (parser-created elements, setAttribute, replace-all) must be queued in Rust like MutationObserver records.
   - The facade then drains them before each mutating method returns. That costs one extra epoch-page read per mutating call, the same cost model as MutationObserver (DESIGN §9).
   - Upgrading parser-created elements and the `new.target` HTMLElement constructor are the subtle parts.
10. **Legacy events (S).** jsdom's createEvent is a lookup table plus about 15 lines. The three missing event classes are about 24 lines. JS only.
11. **Forms (M).** jsdom: number-and-date-inputs, dates-and-times, meter, progress and datalist = 603 lines.
    - rsdom's Rust forms/ (2,154 lines) already has value modes and time parsing, so this mostly extends it.
    - Also to fix: `:invalid` disagrees with `validity.patternMismatch` (behaviour repro), and `document.forms`, `links` and `images` are missing.
12. **FileReader (S).** jsdom's FileReader-impl.js is 138 lines. It can be built on Node's `Blob.arrayBuffer()`.
13. **Storage (S).** jsdom's webstorage/ is 85 lines plus a generated named-property Proxy. rsdom avoids Proxies on hot objects (DESIGN §4.3), but Storage is cold. Named access accounts for almost all of the measured gap. `webstorage/storage_setitem.window.html` has 1,130 subtests, and rsdom fails 1,128 of them because `localStorage[key] = v` stores nothing. `length` itself is correct.
14. **Reflection (M).** jsdom has 335 `[Reflect]`-style attributes, which webidl2js generates, so there is no hand-written code to compare. rsdom's build.rs already generates tables. Generating reflectors from the same IDL is mechanical but broad: string, boolean, limited long, enumerated and URL types, plus ARIAMixin.
15. **Range compare (S).** A subset of jsdom's range/ (658 lines):
    - compareBoundaryPoints, comparePoint, isPointInRange, intersectsNode, toString
    - boundary validation: IndexSizeError, InvalidNodeTypeError
    - StaticRange and AbstractRange

    rsdom's `compareDocumentPosition` already beats jsdom on WPT.
16. **Range mutation (L).** extract, delete, clone, insertNode and surroundContents, plus *live* boundary updates on every insert, remove and text change (DOM §5.5).
    - jsdom does this from Node and CharacterData hooks. In rsdom those mutations run in Rust (tree.rs, text.rs, the parser's replace-all), so live ranges must be registered and adjusted in Rust.
    - A per-document count keeps the cost zero when there are none.
    - This touches mutation hot paths.
17. **XPath (M).** jsdom's level3/xpath.js is 1,605 self-contained lines and could be ported to the facade. No library in the census uses it, and happy-dom lacks it too.
18. **XML (M).** jsdom has 208 lines of glue over saxes and w3c-xmlserializer. rsdom needs an XML TreeSink into the arena (xml5ever, or quick-xml), an XMLDocument, and a namespace-aware serializer.
19. **DOMRect and Window odds and ends (S).** jsdom's geometry/ is 88 lines. Also postMessage, name, length, BarProp and External.
20. **iframes, scripts, resources (XL).** jsdom: Window.js + resources/ + the script and frame impls = 2,371 lines. rsdom installs one document directly on Node's `globalThis` (`window === globalThis`), so a second browsing context means a second realm. That is architectural. Recommendation: keep it out of scope.

---

## 4. jsdom vs happy-dom

### 4.1 At a glance (source: `rsdom-lab/compare/arch/summary.md`, `results/architecture.json`, `results/footprint.json`, docs/BENCHMARKS.md)

| aspect | jsdom 30.1.3 | happy-dom 21.0.3 |
|---|---|---|
| Approach | Spec-first. 227 WebIDL files compiled by webidl2js into wrapper + impl pairs. Tested against WPT (127 directories, 2,540 pinned non-pass expectations). | Pragmatic and wide. One TypeScript class per interface with symbol-keyed internals. Own Vitest suite only (5,686 `it()` blocks); no WPT. |
| Code | 32,982 hand-written JS lines + 105,231 generated | 67,084 TypeScript lines |
| Dependencies | 20 direct / 35 transitive (parse5, css-tree, dom-selector, undici, tough-cookie, ...) | 7 direct / 8 transitive |
| HTML parser | parse5: the full WHATWG algorithm | Own regex tokenizer: adoption agency, stray `</p>` and foster parenting are wrong |
| Selectors | dom-selector: full Selectors 4 | Own regex parser with caches: `:not(complex)`, `[attr i]` and `:empty` are wrong; qSA returns the same NodeList object each time |
| CSS / computed style | Real cascade, specificity, UA sheet, em to px, rgb() serialisation. `@media` honours media types only: `screen` applies and `print` does not, but feature queries such as `(min-width)` never match. No `var()`. | Evaluates `@media` and `var()`. Colours stay as authored, there is no `[hidden]` UA rule, sibling rules go stale, and em depends on declaration order. |
| Realm under Vitest | Separate vm realm: `DOMException instanceof Error` is false | GlobalWindow shares host intrinsics, but `document instanceof window.Document` is false (per-window subclass) |
| Scripts / resources | Vitest turns on `runScripts: 'dangerously'`. Resources are off by default; images never load without the canvas package. | JS evaluation and CSS/image/iframe loading are off in Vitest's environment, and can be enabled. Has its own fetch/XHR/WebSocket stack, CORS and a cookie jar. |
| Async control | none | `happyDOM.waitUntilComplete()` and `abort()` track every timer and fetch |
| Import / warm window (footprint.json medians, min-max in brackets) | 606 ms (573-672) / 7.7 ms | 337 ms (300-377) / 1.1 ms |
| Vitest environment phase per file | 709 ms | 318 ms |
| Memory per retained div (heap+external) | ~2,154 B | ~6,466 B |
| App suite, 90 tests (docs/BENCHMARKS.md) | 12.46 s | 10.74 s |

For reference, rsdom: import about 32 ms (28-36; docs/BENCHMARKS.md measured 36.7 ms), environment phase 45 ms per file, about 112 B of heap per div, app suite 4.27 s.

### 4.2 Surface: happy-dom is wider, but not a superset (source: `conformance/api-surface/results/summary.md`)

- **Against jsdom's IDL:** happy-dom has 178 of 209 interfaces (85.2%) and 1,344 of 1,877 members (71.6%). Only 941 (50.1%) are on the right prototype.
  - 129 members are instance class fields, which are invisible to the prototype-descriptor reads that React's value tracker and user-event interceptors rely on.
  - 38 members exist only on a subclass; for example, `Element.clientWidth` lives on HTMLElement.
- **What happy-dom lacks that jsdom has:**
  - Globals: CDATASection, DOMTokenList, DOMStringMap, DOMImplementation, CSSRuleList, StyleSheetList, StyleSheet, CSSImportRule, StaticRange, AbstractRange, PromiseRejectionEvent, ElementInternals, HTMLFormControlsCollection, BarProp, External, and XPath.
  - Members: `Event.isTrusted`, `KeyboardEvent.charCode`, `window.event`, alert/confirm/prompt, ARIA reflection, and `offsetParent`.
  - CSS property accessors: 590 of jsdom's 1,640.
  - Curated app-testing items: 25 missing, 2 of them P0 (`isTrusted`, `charCode`).
- **What happy-dom has that jsdom lacks:** 152 global interfaces in total, including:
  - 80 SVG element and value interfaces
  - IntersectionObserver and ResizeObserver (constructible, but they never fire)
  - matchMedia
  - DataTransfer, DragEvent, Clipboard, ClipboardEvent
  - Web Animations: Animation, KeyframeEffect, `Element.animate`
  - DOMMatrix, DOMPoint
  - Touch, Permissions, CookieStore
  - Members: scrollIntoView, scrollTo, checkVisibility, pointer capture, innerText, contentEditable, inert, popover (the attribute only), dialog methods, elementFromPoint, adoptedStyleSheets.

### 4.3 Behaviour on WPT (source: `conformance/wpt/results/summary.md`)

| | jsdom | happy-dom |
|---|---:|---:|
| mean per-file pass rate | 66.3% | 38.1% |
| subtests passed | 87.0% | 29.8% |
| files fully passing | 1,420 | 607 |
| crashed or hung (killed after 40 s) | 3 | 8 |

**Read this with care.** Two helper-level bugs abort whole files before most subtests run:
- happy-dom's XML documents have no `createCDATASection()` (45,339 subtests in 25 files).
- `createProcessingInstruction()` rejects valid targets (35,151 subtests in 31 files).

These wipe out dom/ranges, dom/traversal, selection and part of dom/nodes. The capability probes show that happy-dom's TreeWalker, Range and Selection **do work** on ordinary documents (`rsdom-lab/compare/arch`). The WPT numbers in those areas therefore understate happy-dom.

**Real failures beyond those aborts:**
- attributes that return undefined: about 7,100 subtests, about 6,600 of them in html/dom (reflection and ARIA reflection)
- named colours in computed style: most css/selectors failures
- missing setHTMLUnsafe, XPath, attachInternals, moveBefore and isTrusted
- wrong or missing DOMException types: about 3,000 subtests

**Where happy-dom matches or beats jsdom:**
- dom/abort: it ships its own consistent AbortController.
- embedded content (img and media) and scripting: by a hair.
- `shadow-dom/declarative/gethtml.html`: jsdom has no getHTML.
- innerText setter files.

### 4.4 Capabilities (source: `rsdom-lab/compare/arch/summary.md`, 53 probes)

jsdom scores 28 yes / 6 partial / 3 stub / 16 no. happy-dom scores 34 / 9 / 6 / 4.

| only happy-dom (or clearly better) | only jsdom (or clearly better) |
|---|---|
| fetch with relative URLs and CORS | XPath |
| matchMedia evaluation | Shadow DOM event retargeting |
| `@media` and `var()` in computed style | focusability rules (happy-dom focuses plain divs and inputs inside `display:none`; it does block disabled controls) |
| Web Animations, clipboard, inert | `:invalid` / constraint-validation selectors |
| ResizeObserver/IntersectionObserver (stubs) | computed-colour serialisation, CSS.supports |
| image loading (opt-in), real navigation (Browser mode) | full WHATWG parser (adoption agency, foster parenting) |
| await or abort all pending async work | WebIDL error layer: correct DOMException names, InvalidCharacterError, HierarchyRequestError |
| WebSocket works under Vitest | `window.event`, `isTrusted`, event brand strings |

Two measured gotchas:
- **jsdom's WebSocket is broken under Vitest.** undici builds its events from the global `Event`, which Vitest has replaced with jsdom's, and they are rejected.
- **Several happy-dom capabilities are off in Vitest's environment.** JS evaluation, CSS, image and iframe loading, and navigation (Browser mode only) all need opt-in settings. jsdom likewise needs `resources: "usable"` to load anything.

### 4.5 Spec correctness where they differ (source: `rsdom-lab/compare/arch/results/behaviour-diffs.json`)

Across 93 repros, happy-dom differs from jsdom in 63. jsdom is right in **56**, happy-dom in **6**, and neither in 1 (innerText).

happy-dom's errors cluster in these areas:

| area | happy-dom divergences (jsdom matches the spec) |
|---|---|
| Computed style | `red` not `rgb(255, 0, 0)`; `#f00` kept as written; `[hidden]` gives `block`; stale results after a sibling-class change; `2em` gives `32px` depending on declaration order; pointer-events not inherited; `input[type=hidden]` displayed |
| Events | no `window.event`; a removed listener still runs; an already-aborted signal still registers; cancelBubble ignored; re-dispatch allowed; `on*` handler runs after listeners; composedPath() not cleared; `isTrusted` undefined; brand is `[object Object]` |
| Focus | focuses a plain div and an input inside `display:none`; `:focus` still matches after blur |
| Forms | textarea keeps CRLF; option text not collapsed; select not iterable; image inputs counted in `form.elements`; clicking a span in a submit button does not submit; `option:checked` misses the default option |
| Parser and selectors | adoption agency, stray `</p>`, foster parenting; `:not(complex)`, `:empty`, `[attr i]`; same NodeList returned from qSA; duplicate-id lookup order |
| Errors and timing | no InvalidCharacterError or HierarchyRequestError; rAF and setTimeout return objects; `<details>` toggle fires synchronously; innerHTML produces 4 MutationObserver records instead of 1 |

happy-dom is right and jsdom wrong on these:
- `var()` substitution
- `@media` rules
- the live getComputedStyle object
- empty computed style for disconnected elements
- custom-property whitespace
- `checkVisibility()`

**Caveat:** this battery is not a random sample. Most repros come from places rsdom's contract tests had already flagged as happy-dom divergences. It shows these differences are real and who is right on each; it does not measure how often happy-dom is wrong in general.

### 4.6 Real libraries (source: `e2e/libraries/results/summary.md`)

| | jsdom | happy-dom |
|---|---|---|
| fully passing, with shims | 18/20 | 17/20, plus framer-motion passing with an unhandled rejection |
| fully passing, without shims | 16/20 | 17/20 (needs no shims) |
| shims needed | matchMedia, ResizeObserver, scrollIntoView, pointer capture | none |
| library-specific failures | tiptap: no Range geometry, no elementFromPoint | react-aria: `document instanceof window.Document` is false, so focus is stolen; framer-motion: `Animation.cancel()` leaves the finished promise unhandled |
| shared failure | lexical: no `InputEvent.getTargetRanges` (plus a user-event limitation) | same |

**In practice:** for app tests written with React and Testing Library, both work, and the differences show up at the edges:
- **happy-dom** gives more APIs out of the box and is faster, at the cost of more spec deviations.
- **jsdom** is the safer oracle for spec behaviour (events, focus, parsing, validation), but needs shims for observer, scroll and pointer APIs.

---

## 5. Where measurements conflict, and their limits

- **Surface vs WPT for happy-dom.** happy-dom has the larger surface (72% of jsdom's members against rsdom's 62%), yet a lower WPT per-file rate (38.1% against rsdom's 40.4%). The helper aborts in §4.3 explain most of this. Surface measures presence only, and a present member can still be a stub or wrong.
- **Probe vs WPT for happy-dom's Range, TreeWalker and Selection.** The probes say they work; WPT says about 0% of subtests pass. Both are right: WPT's shared setup builds XML documents and stops early. Do not read happy-dom's dom/ranges or traversal numbers as "missing".
- **rsdom beating jsdom.** In dom/nodes (compareDocumentPosition) the win is real. In dom/abort it is not: there it reflects Node's AbortSignal and DOMException under global-install mode.
- **Subtests vs files.** A few generated files carry tens of thousands of subtests: dom/ranges 40k, selection 35k, and html/dom 58k, of which 57k are in 11 reflection files. Prefer the per-file rates. The roadmap scores use per-file gap shares, so the Range comparison methods score low: about 24,600 subtests, 93% of them in 4 files.
- **Harness mode.** WPT ran in global-install mode, as Vitest does: `window === globalThis`, scripts run after parsing, and no resources load. It reproduces jsdom's own expectations at 92% of files and 99.2% of subtests. Script-timing, iframe, worker and network tests are excluded for every DOM (4,641 of 7,030 candidate URLs; reasons in `conformance/wpt/results/selection.json`).
- **Node-provided globals.** In rsdom, Blob, File, URL, DOMException, AbortController, WebSocket, TextEncoder and TextDecoder are Node's. They count as present, and the related WPT areas partly measure Node. TextEncoder and TextDecoder are Node's in all three environments.
- **Library sample.** 20 libraries and 41 smoke tests: 1-3 happy-path tests each, not full compatibility. rsdom failures stop at the first missing API, so later gaps are unobserved. lit will need attachShadow and custom elements after TreeWalker. Census hits show that an identifier appears in shipped code, not that it runs.
- **Judgement inputs.** The importance tiers (P0/P1/P2) in the surface census and the effort sizes in §3 are judgements. Their basis is stated in each case; everything else is measured.
- **Behaviour repros.** The 93 repros are a targeted battery, not a random sample (§4.5).
- **Scope.** rsdom is deliberately scoped (`docs/lab/ROADMAP.md`, "Out of scope"). "Distance from jsdom" is not a defect list for its stated goal, which is React plus Testing Library, where it passes the app suite at 2.5-2.9x the speed. It does show what a drop-in jsdom replacement would still need.

---

## 6. Reproduce

```sh
conformance/api-surface/run.sh                 # API census (~1 min)
# WPT: clone WPT at the pinned commit per conformance/wpt/README.md, then:
node conformance/wpt/select.mjs && node conformance/wpt/run.mjs && node conformance/wpt/aggregate.mjs   # ~62 min at 2 workers
e2e/libraries/run.sh                    # 20 libraries x 3 DOMs, with and without shims (~2 min)
rsdom-lab/compare/arch/run.sh                    # probes, behaviour repros, lines of code, footprint (~1 min)
node rsdom-lab/compare/synthesis/derive.mjs      # derived gaps, lines of code per area, priority scores (< 5 s)
rsdom-lab/compare/verify/run.sh                  # independent re-check of this document's claims (~6 min, see §7)
```

---

## 7. Verification

An independent pass re-checked 39 claims in this document before publication: 29 were confirmed, 6 were wrong and 4 were imprecise. All 10 have been corrected. It used fresh scripts in `rsdom-lab/compare/verify/` (`run.sh`; outputs in `rsdom-lab/compare/verify/results/`). Each claim was re-measured, not just re-read from the other studies' summaries.

**Confirmed (29):**
- **Aggregates recomputed from the per-item files** (`recompute.mjs` → `recompute.json`):
  - surface: 149/209 interfaces and 1,167/1,877 members for rsdom; for happy-dom, 178, 1,344 and 941, with 129 instance-only and 38 subclass-only members
  - every per-area member count, and that the areas sum to 1,877
  - WPT: passed subtests, per-file means (66.3 / 38.1 / 40.4), fully passing files (1,420 / 607 / 779, where fully passing means a harness status of OK plus every subtest passing; without the harness rule the counts are 1,427 / 609 / 780)
  - WPT overlap and gap: 82,867 (50.9%) and 53,872 (33.1%) of jsdom's passing subtests; 733 and 550 of jsdom's fully passing files; 663.7 / 746.7 file-equivalents behind and 43.6 / 71.9 ahead; every per-area rate and gap share in §2.3; 47.5% of the gap in the four left-out areas; 60 css/selectors files
  - capability counts (28/6/3/16, 34/9/6/4, 11/15/4/23)
  - behaviour tallies (63 differ; 56 / 6 / 1; spec matches 86 / 36 / 77)
  - library counts (18 / 17 / 11; every library rsdom passes also passes on jsdom; the 7 rsdom-only failures)
  - all 20 roadmap scores from the stated formula, within 0.02
- **Fresh presence probes** in each Vitest environment (`probe.mjs`):
  - every rsdom gap named in §1-§2: NodeFilter, TreeWalker, ShadowRoot, attachShadow, customElements, XHR, DOMRect, FileReader, CSSStyleSheet, styleSheets, createEvent, XMLSerializer, postMessage, name, stepUp, valueAsDate, ARIA
  - rsdom's extras over jsdom, and its 5 extra globals
  - happy-dom's missing globals and members: isTrusted, charCode, window.event, alert/confirm/prompt, ARIA (only `role` of 42 ARIA members), offsetParent, and `clientWidth` only on HTMLElement
  - the 152 global interfaces happy-dom has that jsdom lacks, counted by an independent diff of the globals
- **WPT:** 10 files × 3 DOMs re-run with `conformance/wpt/worker.mjs` (`wpt-rerun.mjs`). All 30 runs reproduce the recorded pass count and harness status: compareDocumentPosition at 1,444 vs 202, the NodeFilter abort, the CDATA aborts and the webstorage gap. Three more checks:
  - happy-dom's `createProcessingInstruction('somePI', …)` throws (that target is what WPT's `dom/common.js` uses)
  - about 3,300 happy-dom failures are DOMException-type failures
  - jsdom's `to-run.yaml` has 127 DIRs and 2,540 non-pass expectations
- **Behaviour:** 26 of the repros were rewritten independently, with different markup and values. Where the scenario is the same, every one gives the recorded result for each DOM. Two variants exposed nuances, now reflected above: UA-sheet `<b>` computes to 700 in rsdom, and `@media screen` applies in jsdom and rsdom. So do the rsdom Selection stub (`rangeCount` 0 after `collapse`), `history.back()` without popstate, localStorage named access, and `document instanceof window.Document` being false in happy-dom.
- **Libraries:** radix, mui, react-router, framer-motion and react-aria were re-run on all three DOMs (15 tests each):
  - jsdom: 15 of 15 pass
  - happy-dom: 14 of 15. The failure is react-aria focus, and framer-motion raises an unhandled `AbortError` from `Animation.cancel`.
  - rsdom: 8 of 15. The failures are `NodeFilter` (5), `ShadowRoot` (1) and back() (1), as reported.
- **Footprint:** re-measured with 3 fresh processes each. Import takes 572-634 ms for jsdom against 297 ms for happy-dom (2.0x). Retained memory is about 2,180 B per div for jsdom against 6,491 B for happy-dom (3.0x). rsdom uses 111 B per div.

**Wrong, now corrected (6):**
1. **On-handler count.** It is 339, not 340, with 1,538 members excluding them, not 1,537. `conformance/api-surface/analyze.mjs` counted `navigator.onLine` as a handler; it is fixed and re-run. The percentages are unchanged.
2. **"happy-dom focuses disabled inputs" was wrong.** It came from the capability probe's step order: the check compared against an element focused two steps earlier. Checked on its own, happy-dom blocks disabled inputs and buttons. Fixed in §4.4 and §4.5, with a note in `rsdom-lab/compare/arch/summary.md`.
3. **XML DOMParser** is rated "partial" for rsdom, not "no". It was removed from the §2.5 "no" list.
4. **createEvent.** dom/events has 25 files that fail on createEvent, and 2 of them abort; the earlier "31 files abort" was wrong.
5. **Web Storage.** The big webstorage file has 1,130 subtests, not 1,118. Its rsdom failure is the named-property setter, not `length`, which works. Roadmap row 13 and note 13 are fixed.
6. **SVG interfaces.** happy-dom's extra SVG interfaces number 80, not "about 100".

**Imprecise, now reworded (4):**
- **@media.** jsdom (and rsdom) do honour media *types*: `@media screen` applies and `print` does not. Media-feature queries never match. The capability levels are unchanged.
- **rsdom-vs-jsdom repro list (§2.5).** It is now the 12 repros the battery actually shows, and localStorage is attributed to the capability probes.
- **Range comparison failures.** 24,610 subtests across 8 files, 93% of them in 4.
- **Import times.** The ranges are now footprint.json medians and min-max.

Editorial fixes (not counted as claims):
- html/dom reflection: 57k subtests in 11 files
- the missing Parsing & serialization row was added to the §2.2 area table
- roadmap ordering: a note explains where the table departs from score order

**Not re-checked:**
- jsdom's WebSocket failure under Vitest (it needs a WebSocket server)
- lines of code and dependency counts
- the per-library census hit counts (only their total of 50 APIs was checked)
