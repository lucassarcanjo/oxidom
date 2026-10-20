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

> **Status: pre-release.** rsdom runs an unmodified React 19 + Testing Library suite, but it covers about 62% of
> jsdom's API surface and is not on npm yet. See [what works](#compatibility) and the [roadmap](docs/ROADMAP.md).
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

Measured against jsdom 30.1.3 on 2026-10-17 ([`docs/PARITY.md`](docs/PARITY.md)):

| measure | rsdom |
|---|---|
| jsdom's WebIDL members present | 62% (1,167 of 1,877) |
| WPT subtests that pass on jsdom and also pass on rsdom | 51% (82,867 of 162,751) |
| real libraries passing, of the 18 that pass on jsdom | 17 (2026-10-20, [`e2e/libraries`](e2e/libraries/results/summary.md)) |
| React 19 + Testing Library app suite | 90 of 90 tests |

The parity suite ([`conformance/parity`](conformance/parity/README.md)) runs **jsdom's own test suite** against
rsdom: web-platform-tests from the 67 of jsdom's 127 WPT directories that a DOM environment exercises, jsdom's
to-upstream tests, its legacy mocha tests and its API tests. On 2026-10-20 rsdom passed 88.8% of the subtests
jsdom passes there; the [scoreboard](conformance/parity/results/summary.md) has the current numbers, broken down
by roadmap item.

The remaining library failure comes from a missing API: custom elements (lit), which are
[Stage 4 of the roadmap](docs/ROADMAP.md#stage-4-architectural-work).
Not supported today: Shadow DOM event retargeting, slots and scoped styles, custom elements, iframes, script
execution, layout, CSSOM rule objects, synchronous XMLHttpRequest.

## Usage (from source)

Requires Rust (stable) and Node.js 22+.

```bash
git clone https://github.com/lucassarcanjo/rsdom && cd rsdom
npm ci
npm run build          # builds the native addon into packages/rsdom/native/
```

**Vitest.** Install `jetdom` and `vitest-environment-jetdom` (from this repository for now) and set
`environment: 'jetdom'`. Options go in `test.environmentOptions.jetdom`: `{ url, html }`.

**Plain Node.**

```js
const { createWindow } = require('jetdom');

const { window, document } = createWindow({ url: 'https://example.test/' });
document.body.innerHTML = '<button class="primary">Save</button>';
document.querySelector('button.primary').textContent; // 'Save'
```

A `JSDOM`-compatible class (`new JSDOM(html, options)`) is planned ([roadmap, Stage 2](docs/ROADMAP.md#stage-2-jsdom-compatible-entry-points)).

## Repository

| path | what |
|---|---|
| [`crates/rsdom`](crates/rsdom) | the Rust core and Node-API bindings (napi-rs v3) |
| [`packages/rsdom`](packages/rsdom) | the `jetdom` npm package: JS facade, native loader, Vitest environment, contract tests |
| [`packages/vitest-environment-rsdom`](packages/vitest-environment-rsdom) | `vitest-environment-jetdom`: makes `environment: 'jetdom'` resolve |
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
