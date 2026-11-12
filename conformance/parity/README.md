# conformance/parity: jsdom's test suite as oxidom's gate

oxidom aims to be a drop-in replacement for jsdom, and jsdom is the behavioural oracle (CONTRIBUTING §6). This
directory runs **jsdom's own test suite** against oxidom and gates changes on it. GitHub Actions is disabled for
this repository, so nothing runs it automatically: run it before merging (`npm run check` runs it with the other
checks).

| source | what | files |
| --- | --- | ---: |
| `wpt` | web-platform-tests from the 67 of the 127 DIRs in jsdom's `refs/jsdom/test/web-platform-tests/to-run.yaml` that are relevant to a DOM environment (`INCLUDE` in `conformance/wpt/select.mjs`; CSS layout, SVG, network and navigation DIRs are left out), at the WPT commit jsdom pins, minus files that need a server, a second document or workers (the per-file rules in the same script) | 2,389 |
| `tuwpt` | jsdom's own WPT-format tests (`test/web-platform-tests/to-upstream`), every directory, with the same per-file rules | 190 |
| `legacy` | jsdom's legacy mocha tests (`test/to-port-to-wpts`: DOM Level 1/2/3 suites, parsing, NodeIterator, ...) | 19 (≈1,800 specs) |
| `api` | jsdom's API tests (`test/api`: the `JSDOM` class and its options) | 18 (≈630 specs) |

Every file runs in a fresh process, the way a Vitest test file sees the DOM: WPT pages through
`conformance/wpt/worker.mjs` (global-install mode, described in `conformance/wpt/README.md`), mocha files
through `mocha/worker.cjs`, which runs them unmodified with a small `mocha-sugar-free` runner
(`mocha/sugar-free.cjs`) and, for oxidom, oxidom's own `JSDOM` class (`mocha/oxidom-jsdom.cjs` maps jsdom's `lib/api.js` onto the package entry).

Three committed files drive it:

- **`expectations/<source>.yaml`**: everything oxidom is known to fail. Anything not listed must pass. This is the
  ratchet: a run fails when something listed starts passing (lock it in) or something unlisted starts failing (a
  regression).
- **`oracle/<source>.json`**: what jsdom passes in the same harness, file by file. It is the denominator of the
  parity score and tells which oxidom failures are parity gaps and which jsdom shares.
- **`roadmap.yaml`**: the tests that measure each item of `docs/ROADMAP.md`.

`results/summary.md` is the scoreboard (parity per source and per roadmap item), regenerated from those three
files by every `--update`, or by `node conformance/parity/report.mjs` after a hand edit. Commit it with them.

## Setup

```sh
npm ci && npm run build          # the addon
scripts/fetch-refs.sh --wpt      # refs/jsdom (v30.1.3) and refs/wpt (the commit jsdom pins, sparse): ~60 + ~90 MB on disk
```

`OXIDOM_REFS=<dir>` puts the checkouts in `<dir>` instead of `refs/`; the suite honours the same variable.

## Daily use

```sh
npm run test:parity                                   # everything (≈4 min on 4 cores)
npm run test:parity -- dom/traversal                  # substring of a test id
npm run test:parity -- 'wpt:dom/nodes/Node-*'         # glob, optionally prefixed by its source
npm run test:parity -- --item traversal               # one roadmap item's scope (roadmap.yaml)
npm run test:parity -- --source legacy,api            # one or more sources
npm run test:parity -- --print dom/traversal/TreeWalker-basic.html   # one file's raw result as JSON
npm run test:parity -- --print tuwpt:uievents/focusevents/blur-relatedTarget.html   # when two sources share the id
```

A run exits 1 on a regression, or when an expected failure now passes (progress: lock it in with `--update`, or
let it through with `--allow-progress`). A green run prints just the per-source counts; otherwise the output lists
only the files whose result differs from the expectations:

```
REGRESSION wpt:dom/nodes/Node-cloneNode.html
    2 subtest(s) fail
        - Node.cloneNode on a DocumentType: assert_equals: ...
PROGRESS   legacy:to-port-to-wpts/node-iterator.js
    32 expected failure(s) now pass
        - node-contains > createNodeIterator(): should set defaults for missing arguments
```

`changed` lines are informational (same passes with a different failure status, or how a `flaky` or `skip` file
did) and do not fail the run.

Files expected to time out (`timeout`, about 130 of them, 10 s each), and files marked `flaky` or `skip`, do not
run unless `--all` is given. Under `--all`, `flaky` and `skip` files are reported but never gate.

### Working on a roadmap item

1. `npm run test:parity -- --item <id>` runs the item's scope. Its failures are all expected, so a green run
   prints only counts: the failures to fix are the item's entries in `expectations/*.yaml`, each with a reason,
   and `results/raw/oxidom.jsonl` has every subtest result of the run. An item with `tests: []` in `roadmap.yaml`
   has no tests in the selection; `--item` reports `no test matches` for it, and its contract tests carry it.
2. Implement. Re-run the item (or one file) as you go; PROGRESS lines are the subtests you fixed.
3. `npm run test:parity -- --update --item <id>` rewrites the expectations for those files and regenerates
   `results/summary.md`. Commit both: the diff shows exactly what now passes.
4. Run `npm run test:parity` once over everything before merging (`npm run check` does, with the other checks):
   a fix in one area can move another.

A regression you cannot fix in the same change is recorded the same way (`--update`), with the reason edited
to say why; reviewers see it in the expectations diff.

## Expectations format

YAML, one entry per test id, sorted. Reasons are free text: `--update` writes a cause derived from the failure
message and keeps an existing reason while the entry's status does not change, so edit them by hand freely. It
keeps `flaky` and `skip` entries as they are.

```yaml
# the whole file fails: harness error, or no subtest passes
dom/traversal/TreeWalker-basic.html: [fail, "missing global: NodeFilter"]
# more than 50 subtests fail: a floor of passing subtests (fewer = regression, more = progress)
html/dom/reflection-forms.html: [fail, "assert_equals: got undefined (missing attribute/API)", {pass: 7294}]
# up to 50 failing subtests in a file whose harness completes: exactly these fail
dom/nodes/Element-classlist.html:
  "classList.replace with the empty string": [fail, "assert_throws_dom: did not throw"]
# not run by default
html/semantics/embedded-content/the-img-element/reuse-img.html: [timeout, "harness TIMEOUT"]
```

| status | meaning | runs by default |
| --- | --- | --- |
| `fail` | as above | yes |
| `crash` | the process died or hung past the hard limit | yes |
| `timeout` | testharness timed out (10 s) | no |
| `flaky` | set by hand: the result varies between runs; never gates | no |
| `skip` | set by hand: the file does not measure oxidom (say why in the reason); never gates, left out of the score | no |
| `fail-node:<N` | set by hand, file or subtest: a failure of the Node runtime, not of oxidom, that Node N fixed (jsdom's `to-run.yaml` syntax). Below major N it is `fail`; from N on it is no entry, so the test must pass. `--update` writes it back as it is on any Node, and the scoreboard reads it as on Node 22 so it is the same on every Node | yes |

A run compares each file with its entry: no entry means every subtest must pass, and at least as many as jsdom
passes; a subtest list means exactly those may fail, and the others (jsdom's passes, less the listed failures
jsdom passes) must still be reported; a file-level entry means at least `pass` subtests must pass (0 if absent).
A file whose process dies (`CRASH`) is a regression unless its entry already says `crash`; one killed for
running past the hard limit (`KILLED`, 60 s for WPT files) is reported like a timeout, without failing the run.
An expected subtest failure the run no longer reports at all (the subtest was renamed or removed) shows as
PROGRESS, marked stale; `--update` drops it.

## The oracle and the score

`oracle/<source>.json` holds, for every test file, jsdom's harness status, its number of passing subtests and
the names of its failing subtests, from running jsdom 30.1.3 through the same harness:
`npm run test:parity -- --dom jsdom` checks jsdom against it, and `--dom jsdom --update --all` rewrites it
(`--all`, so the files expected to time out are rerun too). Do that when the jsdom or WPT pin moves, or when a
harness change alters what jsdom passes. jsdom passing a test through
this harness is the actual drop-in question: would it pass in a Vitest test file on jsdom?

The pins move together: the jsdom tag and `WPT_COMMIT` in `scripts/fetch-refs.sh`, `WPT_COMMIT` in
`conformance/wpt/lib.mjs`, and the `jsdom` devDependency in `packages/oxidom/package.json` and
`e2e/react-app/package.json`, followed by `npm install`. `--dom jsdom` runs `node_modules/jsdom`; `refs/jsdom`
only supplies the test files. `docs/ROADMAP.md` (Stage 0) has the steps.

**Parity** (the scoreboard's main number) is, of the subtests jsdom passes, the share oxidom passes. It is
computed from the committed files alone (`report.mjs` explains the per-file rule); files marked `skip` are left
out.

## When something looks wrong

- Run the file on jsdom: `npm run test:parity -- --dom jsdom --print <id>`. If jsdom fails it here too, the
  test needs something the harness does not provide (a server, a real page load, iframes); its selection rule
  belongs in `conformance/wpt/select.mjs`. The selection is cached in `conformance/wpt/results/selection.json`
  (gitignored), which the suite regenerates when `select.mjs`, `conformance/wpt/lib.mjs` or jsdom's
  `to-run.yaml` changes.
- `results/raw/<dom>.jsonl` has every subtest result and message of the last run.
- A file that changes between identical runs gets `[flaky, "<what varies>"]` by hand.

## Relationship to the rest of the test suite

- `packages/oxidom/test/contract` stays the fast, targeted parity suite (seconds, three DOMs side by side, every
  feature's own cases). The parity suite is the broad net: thousands of upstream files nobody here wrote.
- `conformance/wpt` is the 2026-10-17 measurement of all three DOMs (jsdom, happy-dom, oxidom) behind
  `docs/PARITY.md`; this directory reuses its selection and worker.
- `e2e/react-app` and `e2e/libraries` test real applications and libraries.
