# oxidom benchmark harness (ROADMAP M8)

Two harnesses, both comparing jsdom 30.1.3, happy-dom 21.0.3 and oxidom on the same machine. Build the
release addon first (`npm run build`); `npm ci` in `oxidom/` and `e2e/react-app/`.

## Micro (`bench/micro/run.mjs`)

```bash
npm run bench:micro                                   # all cases, all DOMs, prints a markdown table
node --expose-gc bench/micro/run.mjs --cases=mo,qsa --doms=oxidom,jsdom --procs=5
node --expose-gc bench/micro/run.mjs --write          # -> bench/results/micro.{json,md}
node --expose-gc bench/micro/run.mjs --native=/abs/other.node   # an explicit addon (OXIDOM_NATIVE is NOT inherited)
OXIDOM_SHARED=0 node --expose-gc bench/micro/run.mjs --write          # -> micro-fallback.{json,md}
OXIDOM_NO_MEMO=1 OXIDOM_NO_PREFILTER=1 node ... --write                # -> micro-nomemo-noprefilter.*
```

- **`--procs` (default 5) fresh Node processes per case and DOM** (`--child <case> <dom>`), **interleaved
  round-robin** across DOMs (process p of every DOM before process p+1 of any, order rotated every round). No
  JIT state, megamorphic call sites or GC pressure leak from one case or DOM into another, and the variance
  BETWEEN processes (often larger than inside one) is measured.
- Inside a process every metric is warmed up twice; the second warm-up calibrates the iteration count so one
  sample lasts about `OXIDOM_BENCH_TARGET_MS` (default 100 ms; nominal count scaled by at most 20x). The
  process's value is the median of `OXIDOM_BENCH_SAMPLES` (default 7) samples.
- Reported: the **median of the process medians** and the **min-max range across processes** (shown when
  wider than 10%). The "oxidom vs best other" column prints a ratio **only when the two ranges do not overlap**
  (`~parity` otherwise); byte metrics print `x less` / `x more`; units ending in `-nc` (V8-heap-only memory,
  the env import/setup breakdown) are not comparable across DOMs and get no ratio.
- The 1-minute load average is recorded before/after every process; values from a process that ran above
  `OXIDOM_BENCH_MAX_LOAD` (default half the CPUs) are marked `!`.
- Provenance in `meta.provenance` and the table header: git rev + dirty flag, the addon's path, sha256 and
  build profile (`__buildInfo`: release / debug / +counters; a warning is printed for non-release builds),
  jsdom / happy-dom / vitest / React / Testing Library versions. Children get a clean environment: every
  `OXIDOM_*` variable except the ablation switches and `OXIDOM_BENCH_*` is removed (a leftover `OXIDOM_NATIVE`
  pointing at a debug or counters addon used to apply silently); `--native=` passes an addon explicitly.
  `--merge` refuses to splice results from a different git rev, a dirty tree or a different addon.
- `process: true` cases (env, env-vitest) take one sample per process: 1 discarded warm-up process, then
  `max(SAMPLES, procs)` processes per DOM, interleaved the same way.
- DOMs are created through `test/contract/adapter.cjs` (`makeWindow`, no globals, the construction the
  contract suite uses). The env, React and Testing Library cases install the DOM on `globalThis` exactly as
  the Vitest environments do (`builtinEnvironments.jsdom/happy-dom` from `vitest/runtime`, and
  `packages/oxidom/lib/vitest-environment.mjs` for oxidom), because those libraries read globals. React and Testing Library
  are loaded from `e2e/react-app/node_modules`.
- A metric whose API is missing on the current branch (or DOM) reports **n/a with the reason** instead of
  failing the run, so cases light up as areas A/B/C merge.
- Reads interleave mutations wherever a DOM could answer from a cache (attr, walk, matches, qsa, gcs,
  serialize); cold and warm variants are separate rows.

| case | DESIGN §13 row | what |
|---|---|---|
| mutate | 1 | createElement + appendChild + removeChild; insertBefore(first) + remove() |
| attr | 2, 6, 7 | setAttribute; getAttribute / hasAttribute unchanged; set+get+has interleaved |
| deep | 3 | bottom-up detached build, 1001 nodes at depth 200, then attach |
| walk | 4, 5 | firstChild/nextSibling DFS over 4096 nodes, steady and with 2 mutations per walk; `childNodes[i]` |
| matches | 9 | DTL's getImplicitAriaRoles loop: the 108 aria-query role selectors over a 565-element page, warm and interleaved |
| qsa | 10, 11 | querySelectorAll cold (after a mutation) and warm, 2.7k-element table; querySelector cold |
| gcs | 12 | getComputedStyle(el).display cold after a class mutation (author sheet present); warm visibility; 4 properties incl. non-core ones (color, margin-left, font-weight: separate lazy crossings in oxidom); getPropertyValue |
| focus | 13 | focus() alternating between two inputs |
| event | 14 | new MouseEvent + dispatch through 20 levels, React-like capture/bubble listeners reading 24 props |
| parse | 15 | innerHTML set, 300-row table |
| serialize | 16 | outerHTML / textContent get of the table after a text mutation |
| env | 17 | in-process breakdown: environment module import + setup() (window on globalThis) in a fresh process, teardown. vitest/dist/runtime.js is imported before t0 for every DOM; Node's lazy undici globals are NOT preloaded (in a worker every env pays them inside setup) |
| env-vitest | 17 | **authoritative env row**: Vitest's own per-file `environment` phase in a real `vitest run` (forks, isolate, maxWorkers=1, 6 trivial files in `bench/micro/env-fixture`), median per file |
| mo | 18 | observe + disconnect on a 4096-node subtree (DTL waitFor options); mutations under an active observer (+ takeRecords); burst -> one delivery |
| mem | 19 | RSS and V8 heap+external per retained `<div class>` (100k, wrappers alive); V8 heap alone (not comparable: oxidom data lives in Rust); **churn**: RSS growth per created-and-discarded node (2000 x innerHTML, after gc) - oxidom never reclaims nodes inside an env, so mutate / deep / parse exclude freeing work the GC-based DOMs pay |
| react | - | React 19 createRoot + render of a 1000-row table (flushSync); update re-render |
| testing-library | - | DTL getAllByRole('row') and getByRole('button', {name}) on a 1000-row table |

## End-to-end (`bench/e2e/run.mjs`)

```bash
npm run bench:e2e -- --n=5 --write                    # default matrix + ablations, -> bench/results/e2e.{json,md}
node bench/e2e/run.mjs --n=5 --matrix=forks --no-ablations --doms=jsdom,oxidom
node bench/e2e/run.mjs --counters --write             # + one counters-build run (npm run build:counters)
```

- Runs the unmodified `e2e/react-app/` suite (11 files, 90 tests) with `vitest run`, one **fresh process per sample**,
  `--reporter=dot` plus `bench/e2e/phase-reporter.mjs` (absolute per-file phases: environment, worker,
  transform, setup, import, tests). Configuration only through CLI flags and env (`DOM_ENV`, `OXIDOM_*`).
- 1 warm-up round (Vitest 5's `fsModuleCache` then makes every sample a warm-cache run) + N samples,
  **interleaved**: sample i of every configuration runs before sample i+1 of any, order rotated per round.
- Matrix: `forks` (+ isolate, the default), **`forks-1`** (forks + isolate, `maxWorkers=1`: the only source
  of per-phase attribution, no CPU contention between workers), `threads`, `threads-noiso` (`isolate:
  false`), `serial` (`threads`, `isolate: false`, `maxWorkers=1`). `--best` adds `vmThreads` (jsdom /
  happy-dom only; the pool Vitest recommends for jsdom, oxidom cannot run it) and `forks-cc`
  (`NODE_COMPILE_CACHE`), and prints a "best available config per DOM" table (fastest wall among forks,
  threads, threads-noiso, vmThreads, forks-cc). `--maxWorkers` is pinned (`availableParallelism() - 1`
  unless `--workers=`).
- **Valid samples only**: statistics use samples with exit 0, reporter output and 0 failed tests; the table
  shows valid/total and marks a row INVALID below N-1 valid samples (a crashed run is short and used to pull
  the median down). "tests (common)" = files that passed in every sample of every DOM of the entry.
- Wall is shown next to the **critical-path file** (the long pole: DataTable.heavy bounds wall with 3 workers),
  plus "excl. heavy" (tests over common files without `*.heavy*`) and the **per-file median ratio** (other DOM /
  oxidom over common files): quote both the heavy-file and the typical-file ratio.
- Peak RSS per sample (getrusage `RUSAGE_CHILDREN` through a python3 wrapper; null without python3).
- Same provenance and clean-environment rules as the micro harness (`--native=` for an explicit addon).
- oxidom ablations (`--ablations=forks,serial`, default): `OXIDOM_SHARED=0`, `OXIDOM_NO_MEMO=1`,
  `OXIDOM_NO_PREFILTER=1` and all three, to split wins between Rust algorithms and JS-side memoisation /
  shared-memory layout (DESIGN §13 attribution rule 2).
- Reports medians and min-max of external wall time and of each phase summed over files, per-file median
  test time from `forks-1` (DataTable.heavy called out), and "tests (common)" (a DOM failing tests is not
  "faster"; failing counts are shown).
- Caveat (Vitest Pitfall A): with `isolate: false` and maxWorkers > 1 the environment phase is re-reported
  for every file of a reused worker; compare wall time there.
- `--counters`: one extra oxidom run with the counters build (`OXIDOM_COUNTERS=1`, built by
  `npm run build:counters` into `native/counters/`); the environment appends one JSON line per worker
  to `OXIDOM_COUNTERS_OUT`, summarised as native calls and time per file plus the top natives.
- Raw samples go to `bench/results/raw/` (gitignored); the summary `bench/results/e2e.{json,md}` is committed.

## Counters build

`cargo build --features counters` (or `npm run build:counters`) times every native between argument reading
and result conversion and counts calls per native (`src/counters.rs`); `N.counters()` returns the JSON and
`N.countersReset()` clears it. Without the feature the macro emits no timing code at all. Absolute times
include ~20 ns of clock overhead per call: use them for attribution and call counts, not latency.

## Profiling and attribution

- **Native time is invisible to `--cpu-prof`.** N-API callbacks never appear as profile frames: their time is
  charged to the calling facade function (the "oxidom native" category is 0 in every profile, and e.g.
  `createElement`'s self time includes ~200 ns of Rust). Split JS from native with the counters build
  (`--counters`), not with the profile.
- **Environment / startup:** use the unprofiled phase reporter (`env-vitest` micro row, `forks-1` e2e
  entry). Profiling inflates the tests phase ~1.2x but compile-heavy setup far more (the profiler logs every
  code event), so profiled env numbers overstate setup.
- **Composition only:** use the profile to see what dominates a file. React's own self time differs by DOM
  for the same work (one review's profiles of the app suite: ~4.55 s on oxidom, 5.0-5.25 s on jsdom, 5.8-6.3 s
  on happy-dom; GC pressure and inline-cache state), so "DOM self time" understates the total DOM-induced
  cost; report React self time per DOM as its own row when quoting a profile.
- `valgrind --tool=callgrind` works on a scratch `cargo test --release` probe for Rust instruction counts;
  `perf` is not installed on the lab VM.

## Semantics behind some rows

- **qsa warm:** happy-dom 21 returns the *same* NodeList object for a repeated query when nothing changed
  (its `querySelectorAll` cache), which is where its ~0.2 us comes from; the spec (and jsdom, oxidom) return a
  new static NodeList per call, so oxidom pays for building one (own index properties) even on a memo hit.
- **gcs:** the first rows use a 2-rule author sheet; the `+ 800-rule class-keyed sheet` rows add a
  Tailwind- / CSS-module-sized sheet (none of its rules match), which exposes cascade costs that grow with
  the number of author rules.
- **attr:** oxidom memoizes getAttribute/hasAttribute per element under the element's `attr_ver`; the
  interleaved row (set + get + has on the same element) is the case where every read misses that memo.

## Machine notes

The final M8 numbers (idle machine, 2026-10-17, `c4e213d`) are in `bench/results/` and written up in
`docs/BENCHMARKS.md`.

The lab VM has 4 vCPUs; while parallel agents build and test, numbers carry ±15-50% noise (the JSON keeps
every sample, the tables flag loaded processes with `!`). Re-run on a quiet machine before quoting ratios, and
state which matrix entry each quoted ratio comes from (wall: a parallel entry or the best-config table; phase
attribution: `forks-1`; env setup: the `env-vitest` micro row).
