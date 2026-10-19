# rsdom roadmap

**Goal:** a drop-in replacement for jsdom. A project that runs its tests on jsdom switches one word of
configuration and gets the same results, faster.

The lab answered the first question: on an unmodified React 19 + Testing Library suite, rsdom runs 2.9x faster
than jsdom and 2.5x faster than happy-dom ([`BENCHMARKS.md`](BENCHMARKS.md)). The lab milestones M0-M9, which code
comments cite, are recorded in [`lab/ROADMAP.md`](lab/ROADMAP.md). This file covers what comes next.

"Drop-in" has three parts, and each stage below moves at least one of them:

1. **Same entry points.** `environment: 'rsdom'` in Vitest, `testEnvironment: 'rsdom'` in Jest, and a `JSDOM`-shaped
   programmatic API (`new JSDOM(html, options).window`).
2. **Same behaviour.** Whatever passes on jsdom passes on rsdom. This is measured three ways: real libraries
   (`e2e/libraries`), web-platform-tests (`conformance/wpt`) and the WebIDL surface (`conformance/api-surface`).
3. **Installable.** `npm i -D rsdom` works on every mainstream platform without a Rust toolchain.

Baseline (2026-10-17, [`PARITY.md`](PARITY.md)): 62% of jsdom's IDL members, 51% of the WPT subtests jsdom passes,
11 of the 18 real libraries that pass on jsdom, and the full 90-test React app suite.

---

## Stage 0: Repository and distribution

- [x] Monorepo layout: `crates/rsdom` (Rust), `packages/rsdom` (npm), e2e suites, benchmarks, conformance harnesses.
- [x] `vitest-environment-rsdom` package so `environment: 'rsdom'` resolves like `'jsdom'`.
- [x] CI: lint, Rust tests, contract suite (also in fallback mode), React app suite on Linux.
- [ ] CI matrix: macOS and Windows builds of the addon and the test suites.
- [ ] Prebuilt binaries: napi-rs per-platform packages (`@rsdom/<triple>` as `optionalDependencies`) for linux x64/arm64
      (gnu and musl), darwin x64/arm64 and win32 x64; release workflow.
- [ ] Confirm the npm names (`rsdom`, `vitest-environment-rsdom`, `jest-environment-rsdom`, `@rsdom/*`) and publish
      a first preview; drop `"private": true`.
- [ ] Versioning and changelog (one version for all packages; changesets or a release script).
- [ ] Performance regression guard: a reduced `bench:micro` and `bench:e2e` run on a fixed runner, compared with
      `bench/results/`.
- [ ] Scheduled conformance runs (WPT, API surface, libraries) that publish their summaries, so parity is tracked
      over time instead of as a one-off snapshot.

## Stage 1: Close the measured library gaps

Items 1, 2, 4 and 5 of the parity roadmap remove every rsdom-only failure seen in the library sample
([`PARITY.md`](PARITY.md) §3.2). Each is small or medium.

- [ ] **TreeWalker / NodeIterator / NodeFilter** (S). Unblocks Radix Dialog, Headless UI, react-aria and lit; 7 of 20
      libraries reference it.
- [ ] **ShadowRoot + `attachShadow`**, without retargeting (M). Unblocks MUI Modal and Dialog; first step for lit.
- [ ] **Session history traversal**: `back`, `forward`, `go` with `popstate` (S). react-router.
- [ ] **XMLHttpRequest** (M). axios with the XHR adapter.
- [ ] No-op observers and scrolling APIs that jsdom setups shim by hand: ResizeObserver, IntersectionObserver,
      `scrollIntoView`, `scrollTo` on elements, pointer capture, `checkVisibility` (S, beyond jsdom).

## Stage 2: jsdom-compatible entry points

- [ ] `JSDOM` class: `new JSDOM(html, { url, contentType, pretendToBeVisual, ... })`, `.window`, `.serialize()`,
      `.fragment()`; `JSDOM.fragment()`. Decide how several live `JSDOM` instances map onto one Env per thread
      (today `createWindow()` makes one main document per Env; `main: false` creates a secondary one).
- [ ] Accept Vitest's `environmentOptions.jsdom` keys (`url`, `html`, `userAgent`, `pretendToBeVisual`, `console`)
      as well as `environmentOptions.rsdom`.
- [ ] `jest-environment-rsdom` for Jest (`testEnvironment: 'rsdom'`).
- [ ] Vitest VM pools (`pool: 'vmThreads'` / `'vmForks'`, the environment's `setupVM`), which jsdom supports.
- [ ] TypeScript declarations for the public API (`rsdom`, `rsdom/vitest-environment`).
- [ ] Migration guide: jsdom to rsdom, with the known divergences listed in one place.

## Stage 3: Breadth parity with jsdom

In parity-score order ([`PARITY.md`](PARITY.md) §3.2 and §3.3 give effort and evidence for each):

- [ ] Selection backed by real Ranges (M). tiptap and lexical typing through user-event.
- [ ] CSSOM rule objects: `CSSStyleSheet.insertRule`, `cssRules` (L). The largest WPT gap share.
- [ ] Computed-value fidelity: colours as `rgb()`, `font-weight: 700`, resolved `em` (M).
- [ ] `document.createEvent`, `init*Event` and the missing event classes (S).
- [ ] Forms remainder: `stepUp`/`stepDown`, `valueAsDate`, `valueAsNumber` and the rest of the 259 members (M).
- [ ] FileReader with DOM Blob and File (S).
- [ ] Web Storage named properties (S).
- [ ] Reflected IDL attributes and ARIAMixin (`role`, `aria*`) (M).
- [ ] Range comparison and stringification (S), then Range mutation with live boundary updates (L).
- [ ] XML documents, `XMLSerializer` and `DOMParser` for XML types (M); XPath (M).
- [ ] DOMRect classes and the remaining Window members (S).

## Stage 4: Architectural work

These change rsdom's data model or add a second browsing context. Each needs a design note in
[`DESIGN.md`](DESIGN.md) before code.

- [ ] Full Shadow DOM: event retargeting, slots, scoped styles (L).
- [ ] Custom elements and `customElements` (L). lit after Stage 1.
- [ ] Node memory reclamation inside an Env (a wrapper-liveness protocol; [`../CONTRIBUTING.md`](../CONTRIBUTING.md) §8).
- [ ] WTF-8 or UTF-16 character data, so lone surrogates round-trip (§8 there).
- [ ] iframes, script execution (`runScripts`) and resource loading (XL). No library in the sample needs them.

## Not planned

- Layout and geometry: rsdom, like jsdom, reports zero sizes and has no `elementFromPoint`.
- Canvas, media playback and WebSocket.
- `contentEditable` editing and `execCommand` beyond what Selection and Range need.
- Electron.
