# rsdom roadmap

**Goal:** a drop-in replacement for jsdom. A project that runs its tests on jsdom switches one word of
configuration and gets the same results, faster.

The lab answered the first question: on an unmodified React 19 + Testing Library suite, rsdom runs 2.9x faster
than jsdom and 2.5x faster than happy-dom ([`BENCHMARKS.md`](BENCHMARKS.md)). The lab milestones M0-M9, which code
comments cite, are recorded in [`lab/ROADMAP.md`](lab/ROADMAP.md). This file covers what comes next.

"Drop-in" has three parts, and each stage below moves at least one of them:

1. **Same entry points.** `environment: 'jetdom'` in Vitest, `testEnvironment: 'jetdom'` in Jest, and a `JSDOM`-shaped
   programmatic API (`new JSDOM(html, options).window`).
2. **Same behaviour.** Whatever passes on jsdom passes on rsdom. This is measured three ways: real libraries
   (`e2e/libraries`), web-platform-tests (`conformance/wpt`) and the WebIDL surface (`conformance/api-surface`).
3. **Installable.** `npm i -D rsdom` works on every mainstream platform without a Rust toolchain.

Baseline (2026-10-17, [`PARITY.md`](PARITY.md)): 62% of jsdom's IDL members, 51% of the WPT subtests jsdom passes,
11 of the 18 real libraries that pass on jsdom, and the full 90-test React app suite.

**How progress is measured.** The parity suite ([`conformance/parity`](../conformance/parity/README.md)) runs jsdom's
own test suite against rsdom: WPT files from the 67 of jsdom's 127 `to-run.yaml` DIRs relevant to a DOM environment,
jsdom's to-upstream WPT tests, its legacy mocha tests and its API tests (about 2,600 files). On 2026-10-19 rsdom
passed **53.5%** of the subtests jsdom passes there; the scoreboard,
[`results/summary.md`](../conformance/parity/results/summary.md), has the current numbers and every item's remaining
gap. Each item below names its scope in the suite in backticks (`conformance/parity/roadmap.yaml`):
`npm run test:parity -- --item <id>` runs it. An item is done when its gap is 0, or when every remaining entry in
`conformance/parity/expectations/` is explained there.

---

## Stage 0: Repository and distribution

- [x] Monorepo layout: `crates/rsdom` (Rust), `packages/rsdom` (npm), e2e suites, benchmarks, conformance harnesses.
- [x] `vitest-environment-jetdom` package so `environment: 'jetdom'` resolves like `'jsdom'`.
- [ ] CI running on every PR. `.github/workflows/ci.yml` defines the jobs (lint, Rust tests, contract suite also in
      fallback mode, React app suite and the parity suite, on Linux), but GitHub Actions is disabled for this
      repository; until it runs, `npm run check` runs the same checks locally before merging.
- [x] Parity suite: jsdom's own test suite, gated by checked-in expectations (regressions and unlocked progress both
      fail), with a committed scoreboard (`conformance/parity`).
- [ ] CI matrix: macOS and Windows builds of the addon and the test suites.
- [ ] Prebuilt binaries: napi-rs per-platform packages (`@jetdom/<triple>` as `optionalDependencies`) for linux x64/arm64
      (gnu and musl), darwin x64/arm64 and win32 x64; release workflow.
- [ ] Publish a first preview under the npm names `jetdom`, `vitest-environment-jetdom`, `jest-environment-jetdom` and
      `@jetdom/*` (an unrelated project owns `vitest-environment-rsdom` and `@rsdom/*`); drop `"private": true`.
- [ ] Versioning and changelog (one version for all packages; changesets or a release script).
- [ ] Performance regression guard: a reduced `bench:micro` and `bench:e2e` run on a fixed runner, compared with
      `bench/results/`.
- [ ] Scheduled runs of the three-DOM measurements (`conformance/wpt`, `conformance/api-surface`, `e2e/libraries`)
      that publish their summaries; the parity suite's scoreboard is already committed with every change that moves it.
- [ ] Refresh the parity oracle with each jsdom release. Bump every pin: the jsdom tag and `WPT_COMMIT` in
      `scripts/fetch-refs.sh`, `WPT_COMMIT` in `conformance/wpt/lib.mjs`, and the `jsdom` devDependency in
      `packages/rsdom/package.json` and `e2e/react-app/package.json` followed by `npm install` (`--dom jsdom` runs
      `node_modules/jsdom`, not `refs/jsdom`). Then re-fetch (`rm -rf refs/jsdom && scripts/fetch-refs.sh --wpt`) and
      run `npm run test:parity -- --dom jsdom --update --all`, then `npm run test:parity -- --update --all` (`--all` also
      reruns the ~130 files expected to time out, about 10 s each, so their entries follow the new versions).

## Stage 1: Close the measured library gaps

Items 1, 2, 4 and 5 of the parity roadmap remove every rsdom-only failure seen in the library sample
([`PARITY.md`](PARITY.md) §3.2). Each is small or medium.

- [x] **TreeWalker / NodeIterator / NodeFilter** (S) `traversal`. Unblocks Radix Dialog, Headless UI, react-aria and
      lit; 7 of 20 libraries reference it. Done 2026-10-19 (DESIGN §16): all 17 suite files at parity, libraries
      11 -> 14 of 20; lit now stops at custom elements and `attachShadow`.
- [x] **ShadowRoot + `attachShadow`**, without retargeting (M) `shadow-root`. Unblocks MUI Modal and Dialog; first step
      for lit. Done 2026-10-20 (DESIGN §22): 23 of 25 suite files at parity (1 before), gap 512 -> 7 subtests (6 need
      `customElements`, 1 an iframe); overall parity +0.4 points (54.3% -> 54.7% on the main it merged into), Stage 4 `shadow-dom` 3.7% -> 69.0%. Libraries
      16 -> 17 of 20 (MUI); lit now stops at custom elements only. Events are not retargeted (Stage 4).
- [x] **Session history traversal**: `back`, `forward`, `go` with `popstate` (S) `history`. react-router. Done
      2026-10-20 (DESIGN §23): jsdom's queued traversal, popstate/hashchange order and entry bookkeeping, 13
      contract cases on all three DOMs; react-router's BrowserRouter back/forward test passes.
- [x] **XMLHttpRequest** (M) `xhr`. axios with the XHR adapter. Done 2026-10-19 (DESIGN §21): all 31 suite files at
      parity, libraries 14 -> 15 of 20 (axios). Asynchronous only: a synchronous `send()` throws NetworkError, the
      way a failed synchronous request does in jsdom.
- [x] No-op observers and scrolling APIs that jsdom setups shim by hand: ResizeObserver, IntersectionObserver,
      `scrollIntoView`, `scrollTo` on elements, pointer capture, `checkVisibility` (S, beyond jsdom) `observers`.
      Done 2026-10-20 (DESIGN §24): inert, the observers never fire; libraries without shims 14 -> 16 of 20 (Headless
      UI, Radix Select), the same as with shims (16). `elementFromPoint`/`elementsFromPoint` finding nothing added
      2026-10-20: libraries 18 -> 19 of 20 (tiptap).

## Stage 2: jsdom-compatible entry points

- [ ] `JSDOM` class: `new JSDOM(html, { url, contentType, pretendToBeVisual, ... })`, `.window`, `.serialize()`,
      `.fragment()`; `JSDOM.fragment()` `jsdom-api`. Decide how several live `JSDOM` instances map onto one Env per
      thread (today `createWindow()` makes one main document per Env; `main: false` creates a secondary one). Class
      done 2026-10-21 (DESIGN §31): `require('jetdom').JSDOM` and `VirtualConsole`, each instance a browsing context
      that becomes current; jsdom's API tests run on it, gap 426 -> 365 subtests. Left: XML content types (`xml`),
      `runScripts`, iframes and subresources (`browsing-contexts`), a cookie jar behind `document.cookie`,
      `requestInterceptor`, and per-instance interface objects.
- [x] Accept Vitest's `environmentOptions.jsdom` keys (`url`, `html`, `userAgent`, `pretendToBeVisual`, `console`)
      as well as `environmentOptions.jetdom`. Done 2026-10-21 (DESIGN §31): read with the defaults of Vitest's jsdom
      environment, plus its virtual console (not-implemented methods log through `console.error`) and `jsdom`
      global.
- [x] `jest-environment-jetdom` for Jest (`testEnvironment: 'jetdom'`). Done 2026-10-21 (DESIGN §32): a port of
      jest-environment-jsdom 30 on a vm context, checked side by side with it on jsdom 30.
- [x] Vitest VM pools (`pool: 'vmThreads'` / `'vmForks'`, the environment's `setupVM`), which jsdom supports. Done
      2026-10-21 (DESIGN §33): the window on a vm context, as for Jest; the React app suite passes 90/90 in both pools
      and the libraries suite matches jsdom's result.
- [x] TypeScript declarations for the public API (`rsdom`, `rsdom/vitest-environment`).
      Done 2026-10-21 (DESIGN §34): `lib/index.d.ts` (the `JSDOM` API as @types/jsdom types it), the Vitest and
      Jest environments, type-checked in the package suite.
- [x] Migration guide: jsdom to rsdom, with the known divergences listed in one place. Done 2026-10-21:
      [`MIGRATING.md`](MIGRATING.md).

## Stage 3: Breadth parity with jsdom

In parity-score order ([`PARITY.md`](PARITY.md) §3.2 and §3.3 give effort and evidence for each):

- [x] Selection backed by real Ranges (M) `selection`. tiptap and lexical typing through user-event. Done 2026-10-20
      (DESIGN §29): jsdom's Selection over the live Range (identity through addRange, direction, selectionchange);
      42 -> 62 of 64 suite files at parity, gap 19,944 -> 2 subtests (a jsdom onload quirk). Lexical typing now passes
      on rsdom; tiptap's assertions pass, its remaining unhandled error is `elementFromPoint`.
- [x] CSSOM rule objects: `CSSStyleSheet.insertRule`, `cssRules` (L) `cssom`. The largest WPT gap share. Done
      2026-10-21 (DESIGN §35): a Rust rule tree behind jsdom's CSSOM classes, `CSS.supports` like jsdom; 138 -> 223
      of 260 suite files at parity, gap 681 -> 219 subtests, overall parity 90.5% -> 90.9%. Left: value serialization
      (about 190, `computed-values`) and `customElements` (20).
- [ ] Computed-value fidelity: colours as `rgb()`, `font-weight: 700`, resolved `em` (M) `computed-values`. Values
      done 2026-10-20 (DESIGN §30): 206 -> 265 of 297 suite files at parity, gap 3,147 -> 366 subtests, overall parity
      88.8% -> 90.5%. `:heading()` 2026-10-22: gap 249 -> 88, overall 91.0%. Left: shorthand serialization quirks
      of jsdom's cssstyle (border / background, about 60), CR/LF preprocessing in CSSOM text, `calc()` reduction.
- [x] `document.createEvent`, `init*Event` and the missing event classes (S) `events`. Done 2026-10-20 (DESIGN §28):
      createEvent with jsdom's table, the initialized flag, BeforeUnload/DeviceOrientation/DeviceMotion/MessageEvent,
      init argument and view checks; 74 -> 97 of 108 suite files at parity, gap 160 -> 63 (all of it other items':
      inline handlers, shadow retargeting, CSSOM).
- [ ] Forms remainder: `stepUp`/`stepDown`, `valueAsDate`, `valueAsNumber` and the rest of the 259 members (M) `forms`.
- [x] FileReader with DOM Blob and File (S) `file-api`. Done 2026-10-20 (DESIGN §27): FileReader, and Blob and File
      as WebIDL-converting subclasses of Node's; 16 -> 36 of 37 suite files at parity, gap 137 -> 1 (an HTMLCollection
      iterator detail that belongs to `core`).
- [x] Web Storage named properties (S) `storage`. Done 2026-10-20 (DESIGN §26): a Proxy per Storage with the WebIDL
      named-property traps, the 5,000,000-unit quota and QuotaExceededError; 6 -> 25 of 25 suite files at parity,
      gap 1,205 -> 0.
- [ ] Reflected IDL attributes and ARIAMixin (`role`, `aria*`) (M) `reflection`.
- [x] Range comparison and stringification (S), then Range mutation with live boundary updates (L) `ranges`. Done
      2026-10-20 (DESIGN §25): 43 of 44 suite files at parity, the last one needs an XML document (`xml`).
- [ ] XML documents, `XMLSerializer` and `DOMParser` for XML types (M) `xml`; XPath (M) `xpath`.
- [ ] DOMRect classes and the remaining Window members (S) `geometry`.
- [ ] Core DOM and HTML gaps no item above claims (dom/nodes, html/semantics, html/dom, html/syntax) `core`,
      including NamedNodeMap named properties (`attributes['id']`, jsdom's legacy namespaces tests): the scoreboard's
      `core` row and its last table list them.

## Stage 4: Architectural work

These change rsdom's data model or add a second browsing context. Each needs a design note in
[`DESIGN.md`](DESIGN.md) before code.

- [ ] Full Shadow DOM: event retargeting, slots, scoped styles (L) `shadow-dom`.
- [ ] Custom elements and `customElements` (L) `custom-elements`. lit after Stage 1.
- [ ] Node memory reclamation inside an Env (a wrapper-liveness protocol; [`../CONTRIBUTING.md`](../CONTRIBUTING.md) §8)
      `reclamation`.
- [ ] WTF-8 or UTF-16 character data, so lone surrogates round-trip (§8 there) `surrogates`.
- [ ] iframes, script execution (`runScripts`) and resource loading (XL) `browsing-contexts`. No library in the sample
      needs them.

## Not planned

- Layout and geometry: rsdom, like jsdom, reports zero sizes; unlike jsdom, `elementFromPoint` exists and finds nothing
  (DESIGN §24).
- Canvas, media playback and WebSocket.
- `contentEditable` editing and `execCommand` beyond what Selection and Range need.
- Electron.
