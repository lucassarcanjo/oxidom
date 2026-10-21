# rsdom

A DOM for Node.js test environments, implemented in Rust. The goal is a drop-in replacement for
[jsdom](https://github.com/jsdom/jsdom): switch one word of configuration and run the same tests, faster.

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jetdom', // was: 'jsdom'
  },
})
```

> **Status: pre-release.** rsdom runs an unmodified React 19 + Testing Library suite and passes 90.5% of what jsdom
> passes in jsdom's own test suite, but it is not on npm yet. See [what works](#compatibility), the
> [migration guide](docs/MIGRATING.md) and the [roadmap](docs/ROADMAP.md).
> Its npm name is `jetdom`: an unrelated project owns `vitest-environment-rsdom` and the `@rsdom` scope on npm.

## Why

On a 90-test React 19 suite (Vitest 5, default `forks` pool, 4 vCPUs) rsdom finishes in **4.27 s**, against
10.74 s on happy-dom (2.5x) and 12.46 s on jsdom (2.9x).

Only about 3% of the test time is spent inside Rust. The win comes from making the operations Testing Library
and React lean on cheap: selector matching, `querySelectorAll`, `getComputedStyle`, HTML parsing and
MutationObserver registration are 5-700x cheaper than in the JS DOMs, and environment setup takes 45 ms per file
instead of 318-709 ms. Methodology, per-file numbers, ablations and where rsdom loses are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

## How it works

The document tree lives in a Rust arena, one per Node-API environment (so every Vitest worker thread is
independent). JavaScript gets a thin facade: one wrapper object per node, classes with the exact WebIDL shapes,
and a read-only, zero-copy table of node records shared with Rust, so most tree reads never cross into native
code. Parsing uses html5ever, selector matching uses Servo's `selectors` crate, and inline style uses
`cssparser`. Event dispatch stays in JavaScript. Details: [`docs/DESIGN.md`](docs/DESIGN.md).

## Compatibility

Measured against jsdom 30.1.3:

| measure | rsdom |
|---|---|
| subtests of jsdom's own test suite that pass on jsdom and also on rsdom | 90.5% (151,811 of 167,724; [scoreboard](conformance/parity/results/summary.md), 2026-10-21) |
| real libraries passing | 19 of 20, jsdom 18 of 20 (2026-10-20, [`e2e/libraries`](e2e/libraries/results/summary.md)) |
| React 19 + Testing Library app suite | 90 of 90 tests |

The parity suite ([`conformance/parity`](conformance/parity/README.md)) runs **jsdom's own test suite** against
rsdom: web-platform-tests from the 67 of jsdom's 127 WPT directories that a DOM environment exercises, jsdom's
to-upstream tests, its legacy mocha tests and its API tests; the scoreboard breaks it down by roadmap item. The
lab-phase baseline (API surface, WPT, 2026-10-17) is in [`docs/PARITY.md`](docs/PARITY.md).

The remaining library failure comes from a missing API: custom elements (lit), which are
[Stage 4 of the roadmap](docs/ROADMAP.md#stage-4-architectural-work).
Not supported today: Shadow DOM event retargeting, slots and scoped styles, custom elements, iframes, script
execution, layout, CSSOM rule objects, XML documents, synchronous XMLHttpRequest. Every known difference from
jsdom is listed in the [migration guide](docs/MIGRATING.md#known-divergences).

## Usage (from source)

Requires Rust (stable) and Node.js 22+.

```bash
git clone https://github.com/lucassarcanjo/rsdom && cd rsdom
npm ci
npm run build          # builds the native addon into packages/rsdom/native/
```

**Vitest.** Install `jetdom` and `vitest-environment-jetdom` (from this repository for now) and set
`environment: 'jetdom'`. A config written for Vitest's jsdom environment works unchanged: `test.environmentOptions.jsdom`
(`url`, `html`, `userAgent`, `pretendToBeVisual`, `console`, ...) is read the way Vitest reads it, and the `jsdom`
global (`jsdom.reconfigure({ url })`) is there. rsdom never runs scripts, so a `<script>` in `html` does not run
(Vitest's jsdom default runs it). rsdom's own options go in `test.environmentOptions.jetdom` (`{ url, html }`, with
`html` as body markup) and win over the `jsdom` ones. The VM pools (`pool: 'vmThreads'` / `'vmForks'`) work too. As on jsdom, `alert()`, `scrollTo()` and the other
not-implemented window methods log "Not implemented: ..." through `console.error`, and an uncaught error that an
`error` listener saw but did not cancel is logged there instead of failing the test.

**Jest.** Install `jetdom` and `jest-environment-jetdom` (from this repository for now) and set
`testEnvironment: 'jetdom'`. It is a port of `jest-environment-jsdom`: `testEnvironmentOptions` (`url`, `html`,
`userAgent`, `pretendToBeVisual`, `customExportConditions`, ...) and the `@jest-environment-options` docblock work
the same, and so do fake timers. Scripts and inline `on*` attribute handlers do not run (jest-environment-jsdom
runs them). Arrays, typed arrays, promises and errors that rsdom itself creates come from Node's realm, not the test
file's, so `instanceof Array` or `toThrow(TypeError)` on them does not hold; `DOMException` and abort reasons are
not `instanceof Error`. `customElements`, `XMLSerializer` and `DOMRect` are not there yet.

**TypeScript.** The packages ship their declarations; `jetdom`'s `JSDOM` API is typed as @types/jsdom types
jsdom's. For the Vitest `jsdom` global, use `types: ["jetdom/vitest-globals"]` where you had `vitest/jsdom`.

**Plain Node.**

```js
const { createWindow } = require('jetdom');

const { window, document } = createWindow({ url: 'https://example.test/' });
document.body.innerHTML = '<button class="primary">Save</button>';
document.querySelector('button.primary').textContent; // 'Save'
```

Or the jsdom API, unchanged:

```js
const { JSDOM } = require('jetdom');

const dom = new JSDOM('<!DOCTYPE html><p>Hello</p>', { url: 'https://example.test/', pretendToBeVisual: true });
dom.window.document.querySelector('p').textContent; // 'Hello'
```

`JSDOM` takes jsdom's options (`url`, `referrer`, `contentType`, `pretendToBeVisual`, `storageQuota`,
`virtualConsole`, `beforeParse`, `resources.userAgent`) and has `serialize()`, `reconfigure()`, `JSDOM.fragment()`,
`JSDOM.fromFile()` and `JSDOM.fromURL()`. Not supported yet: XML content types, `runScripts`, `includeNodeLocations`
and subresource loading ([roadmap, Stage 2](docs/ROADMAP.md#stage-2-jsdom-compatible-entry-points)).

## Repository

| path | what |
|---|---|
| [`crates/rsdom`](crates/rsdom) | the Rust core and Node-API bindings (napi-rs v3) |
| [`packages/rsdom`](packages/rsdom) | the `jetdom` npm package: JS facade, native loader, Vitest environment, contract tests |
| [`packages/vitest-environment-rsdom`](packages/vitest-environment-rsdom) | `vitest-environment-jetdom`: makes `environment: 'jetdom'` resolve |
| [`packages/jest-environment-rsdom`](packages/jest-environment-rsdom) | `jest-environment-jetdom`: makes `testEnvironment: 'jetdom'` resolve |
| [`e2e/react-app`](e2e/react-app) | React 19 + Testing Library suite, run on jsdom, happy-dom and rsdom |
| [`e2e/libraries`](e2e/libraries) | smoke tests of 20 real libraries (Radix, MUI, react-aria, lit, tiptap, ...) |
| [`bench`](bench) | micro and end-to-end benchmarks, committed results |
| [`conformance`](conformance) | jsdom's test suite as rsdom's gate (`parity`), web-platform-tests and WebIDL surface comparisons against jsdom |
| [`scripts`](scripts) | data generators, `fetch-refs.sh` for upstream reference checkouts |
| [`docs`](docs) | design, benchmarks, parity study, roadmap; [`docs/lab`](docs/lab) keeps the lab-phase record |

## Development

```bash
npm test               # Rust tests, contract suites (jsdom / happy-dom / rsdom), React app suite on rsdom
npm run test:parity    # jsdom's own test suite on rsdom (needs scripts/fetch-refs.sh --wpt)
npm run lint           # clippy + rustfmt
npm run check          # lint, npm test, the fallback-mode suites and test:parity: run it before merging
npm run bench:micro    # see bench/README.md
```

GitHub Actions is disabled for this repository, so nothing runs these checks automatically;
`.github/workflows/ci.yml` keeps the definition for when it is turned back on.

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md): build and test commands, how to add a native function, the
facade conventions and the invariants that keep rsdom fast.

## License

[MIT](LICENSE)
