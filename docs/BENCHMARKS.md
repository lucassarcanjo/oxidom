# oxidom vs jsdom vs happy-dom: benchmark results

> Baseline from the lab phase (milestone M8, oxidom-lab commit `c4e213d`). Harnesses: `bench/`; committed summaries:
> `bench/results/`. Re-run with `npm run bench:micro -- --write` and `npm run bench:e2e -- --write` and update this
> file when a change moves the numbers.

Measured 2026-10-17 at `c4e213d` (release addon sha256 `325866fa4f24…`, bit-identical after a clean rebuild), jsdom 30.1.3,
happy-dom 21.0.3, Vitest 5.0.5, React 19.3.1, @testing-library/dom 10.4.2 / react 16.3.3 / user-event 14.6.8.
Raw data: `bench/results/` (see the [file list](#files-and-reproduction) at the end).

## Short answer

**Yes, oxidom beats both on this workload, and the end-to-end result beats the DESIGN §13 prediction** (several
individual micro predictions were missed; see [predicted vs measured](#design-13-predicted-vs-measured)). The unmodified 90-test `e2e/react-app/` suite
passes on all three DOMs in every pool mode. In the default Vitest configuration (forks + isolate, 3 workers) it finishes in
**4.27 s, against 10.74 s on happy-dom (2.5x) and 12.46 s on jsdom (2.9x)**. Measured over the summed per-file phases with
one worker, the win comes from two places:

- **Environment phase (about 28% of the gap to happy-dom).** oxidom's environment phase takes 45 ms per file, against
  318 ms for happy-dom and 709 ms for jsdom. This is **not a Rust effect**: it comes from a small JS facade, globals
  installed as data properties, and no large module graph to load (DESIGN §13 rule 1).
- **Tests phase (about 72% of the gap).** oxidom takes 4.98 s, against 12.54 s for happy-dom and 17.38 s for jsdom.
  - The win is largest on the file that dominates the suite, DataTable.heavy: 3.4x faster than happy-dom and 3.9x faster
    than jsdom.
  - On a typical file the median win is only about 1.4-1.5x over happy-dom (3.7-3.8x over jsdom); the smallest
    per-file wins over happy-dom are 1.2-1.3x.
  - Only about **3-4% of oxidom's tests phase is spent inside Rust**: 0.2 s across 605k native calls (counters build),
    against 6.22 s of tests phase summed with 3 workers or 4.98 s with one. The rest is React, Testing Library,
    user-event and the facade's JavaScript. So the win is not "Rust code runs faster than JS code" in general: it is
    that oxidom's DOM operations cost far less in total than jsdom's and happy-dom's JS implementations of the same
    operations, mostly the expensive ones Testing Library and React lean on (selector matching, `qSA`,
    `getComputedStyle`, parsing, MutationObserver registration) plus a cheaper JS event dispatch. Keeping node data
    outside the V8 heap may also reduce GC work; that was not measured separately. The ablations show the three
    switchable JS layers (shared table, memo, prefilter) are worth 0-10%; they cannot separate the Rust engine from
    the facade's basic design, which is always on.

The JS-side shortcuts were also switched off in ablation runs: the memo, the selector prefilter and the shared table
(all three off). With all three off, oxidom's tests phase is only 0-10% slower and the suite is still **2.3x faster than
happy-dom**. The end-to-end win is therefore not an artefact of JS caching. At the micro level, though, several of
oxidom's individual wins exist only because of those caches; see [Ablations](#ablations).

**Where oxidom loses:**
- A repeated, unchanged `querySelectorAll` is 14x slower than happy-dom. It takes 2.8 µs against 0.2 µs, because
  happy-dom returns its cached NodeList object.
- Memory is never reclaimed inside an environment: a discarded node costs 173 bytes, against 2-4 bytes on the GC-based
  DOMs.
- `hasAttribute` is at parity to 1.1x slower than happy-dom (1.1x slower in the main run, parity in the audit re-run).
- Adding 143 listeners to fresh targets is 2.3x slower than happy-dom (from the coarser single-process forms
  harness).
- Environment teardown takes 1.2 ms, against 0.5 ms for jsdom (happy-dom: 2.7 ms). Negligible per file.
- The `setupFiles` phase is slightly slower.
- In fallback mode (`OXIDOM_SHARED=0`), an interleaved tree walk is 2x slower than happy-dom, as predicted.
- With the JS memo disabled, reads such as `getAttribute`, `input.value` and warm `getComputedStyle` lose to happy-dom by
  2-3x, as predicted.

## Methodology

**Builds and checks.** Both addons were rebuilt clean on an idle machine (release, then counters). The app suite was
confirmed green on all three DOMs, without timing, before measuring. This agent was the only workload on the VM: the
1-minute load average was 0.41 at the start. Each harness ran alone, in sequence: the full micro run, then the two micro
ablation runs, then the e2e matrix with the counters run, then the area-B forms micro.

**Micro harness** (`bench/micro/run.mjs`):
- Every case runs in 5 fresh Node processes per DOM, interleaved round-robin across DOMs.
- Inside each process every metric is warmed up twice and its iteration count is calibrated to about 100 ms per sample.
  The process's value is the median of 9 samples.
- A row reports the median of the 5 process medians, with the min-max range across processes when that range is wider
  than 10%.
- A ratio is printed only when the oxidom range and the best other DOM's range do not overlap.

**End-to-end harness** (`bench/e2e/run.mjs`):
- Every sample is a fresh `vitest run` of the unmodified `e2e/react-app/` suite, using the dot reporter plus an absolute per-file
  phase reporter.
- Each configuration gets 1 warm-up and 7 samples, interleaved: sample *i* of every configuration runs before sample
  *i*+1 of any, with the order rotated each round.
- `maxWorkers` is pinned. Only `DOM_ENV` and the `OXIDOM_*` ablation switches vary between configurations.
- Statistics use only valid samples (exit 0, 0 failed tests). Every one of the 161 samples was valid.

**Load warnings.** The harnesses flag every e2e sample with `!`, meaning the 1-minute load average was above 2. That load
was **self-induced**: it is the trailing load of the previous 3-worker `vitest run`. Measured before each sample it ranged
from 1.65 to 3.71, below the 4 vCPUs, and was evenly spread across DOMs because the samples are interleaved. No micro
process exceeded the load threshold.

**Provenance.** The e2e meta records `gitDirty: true`. The only modified files at that point were this session's freshly
written `bench/results/micro*` outputs; the code and the addon were at `c4e213d`.

## Machine

| | |
|---|---|
| CPU | Intel(R) Xeon(R) Processor @ 2.80GHz (AVX2, AVX-512), 4 vCPUs (Firecracker VM), 33 MB L3 |
| RAM | 15 GiB |
| OS | Linux 6.18.44 |
| Node / Rust | v22.22.0 / rustc 1.97.0 (2d8144b78 2026-07-07) |
| load (1/5/15 min) | 0.41 / 1.08 / 1.28 before the first run; micro runs ran at 1.0-1.7 (one benchmark process); e2e at 1.65-3.71 (self-induced, see above) |
| addon | `oxidom.linux-x64-gnu.node`, release profile, 2.34 MB, sha256 `325866fa4f24cc5eb956b1142607278eb9cf225d95181b30ce839845241a202f`; counters build `cdcc9f16bda6…` |

## End-to-end headline (app/ suite, 11 files, 90 tests)

The table shows medians of 7 valid samples, with min-max in brackets. Times are in seconds:
- "wall" is the external `vitest run` time.
- The phase columns are Vitest's per-file phases, summed over the 11 files.
- "critical file" is the long pole, DataTable.heavy in every row. It bounds the wall time when there are several
  workers.

**Default configuration: forks + isolate, 3 workers.**

| DOM | wall | environment | setup | tests | tests excl. heavy | critical file | peak RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| jsdom | 12.46 (11.91-12.85) | 9.68 (9.20-9.95) | 1.57 (1.47-1.70) | 21.88 (21.04-22.77) | 11.13 (10.80-11.72) | 11.69 | 514 |
| happy-dom | 10.74 (9.89-12.00) | 4.80 (4.26-5.19) | 1.71 (1.62-1.82) | 15.91 (14.60-17.42) | 6.39 (5.82-6.96) | 9.97 | 1197 |
| **oxidom** | **4.27 (4.25-4.54)** | **0.62 (0.59-0.68)** | 1.87 (1.85-2.02) | **6.22 (6.14-7.16)** | **3.51 (3.40-4.05)** | 3.00 | 281 |

**Full matrix.**

| mode | DOM | wall | environment | setup | tests | tests excl. heavy | critical file | peak RSS MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| threads + isolate, 3 workers | jsdom | 12.07 (11.86-13.67) | 8.87 (8.75-9.50) | 1.67 | 21.10 (20.24-23.58) | 10.69 | 11.38 | 749 |
| | happy-dom | 10.71 (10.13-11.39) | 4.16 (3.83-4.31) | 1.60 | 15.42 (14.21-16.73) | 6.04 | 9.89 | 1295 |
| | **oxidom** | **4.38 (4.19-4.97)** | **0.65 (0.63-0.79)** | 1.83 | **6.28 (6.14-6.96)** | **3.47** | 3.07 | 491 |
| threads, isolate: false, 3 workers | jsdom | 11.40 (10.49-12.41) | 8.77* | 0.47 | 18.36 (16.17-20.79) | 8.62 | 10.69 | 705 |
| | happy-dom | 9.92 (9.34-10.45) | 4.16* | 0.53 | 13.77 (12.80-14.60) | 5.29 | 9.14 | 1278 |
| | **oxidom** | **3.65 (3.27-3.83)** | 0.84* | 0.53 | **5.26 (5.14-5.69)** | **2.81** | 2.88 | 456 |
| forks + isolate, maxWorkers=1 (attribution) | jsdom | 29.21 (28.04-30.69) | 7.87 (7.63-8.34) | 1.34 | 17.38 (16.67-18.32) | 8.58 | 9.77 | 482 |
| | happy-dom | 19.88 (19.51-20.58) | 3.41 (3.25-3.63) | 1.42 | 12.54 (12.46-13.14) | 4.91 | 8.25 | 1184 |
| | **oxidom** | **9.43 (9.12-10.04)** | **0.51 (0.47-0.56)** | 1.42 | **4.98 (4.78-5.34)** | **2.72** | 2.45 | 280 |
| threads, isolate: false, maxWorkers=1 | jsdom | 16.26 (15.13-18.09) | 0.69 | 0.16 | 14.47 (13.53-16.08) | 5.66 | 9.71 | 516 |
| | happy-dom | 13.19 (12.55-15.16) | 0.29 | 0.14 | 11.68 (11.07-13.63) | 3.99 | 8.17 | 1520 |
| | **oxidom** | **5.31 (5.00-5.60)** | **0.05** | 0.15 | **4.11 (3.92-4.47)** | **1.91** | 2.42 | 407 |

\* With `isolate: false` and several workers, Vitest re-reports the environment phase for every file of a reused worker
(Vitest Pitfall A). Compare wall time in that mode.

**Wall-time ratios** (other DOM's wall time divided by oxidom's):

| mode | jsdom / oxidom | happy-dom / oxidom |
|---|---:|---:|
| forks + isolate, 3 workers (default) | 2.92 | 2.52 |
| threads + isolate, 3 workers | 2.76 | 2.45 |
| threads, isolate: false, 3 workers | 3.12 | 2.72 |
| forks + isolate, 1 worker | 3.10 | 2.11 |
| threads, isolate: false, 1 worker | 3.06 | 2.48 |

**Best configuration of each DOM.** Every DOM is fastest with threads and `isolate: false`. Comparing oxidom's default
configuration against each competitor's best: oxidom forks takes 4.27 s, happy-dom's best takes 9.92 s (2.3x) and jsdom's
best takes 11.40 s (2.7x). vmThreads (oxidom cannot run it) was not in the final matrix; the audit re-run below measured
it at 12.21 s for jsdom and 10.15 s for happy-dom (n=3), no faster than their threads-noiso entries, so it does not
change this comparison.

**Where the time goes.** These figures come from the single-worker forks mode (forks-1), where workers do not compete for
CPU:

| | jsdom − oxidom | happy-dom − oxidom |
|---|---:|---:|
| wall difference | 19.8 s | 10.5 s |
| from the environment phase | 7.36 s (37%) | 2.90 s (28%) |
| from the tests phase | 12.40 s (63%) | 7.56 s (72%) |
| ...of which DataTable.heavy | 6.61 s | 5.50 s |
| ...of which the other 10 files | 5.79 s | 2.06 s |
| setup + import + transform + worker | ≈ 0 (oxidom +0.08 s) | ≈ 0 (oxidom +0.04 s) |

- **The parallel wall time is set by DataTable.heavy.** In the default configuration DataTable.heavy is the long pole
  for every DOM: 3.00 s of oxidom's 4.27 s, and 9.97 s of happy-dom's 10.74 s. The parallel wall-time ratio is therefore
  mostly that file's ratio (3.4x against happy-dom), diluted by fixed per-run costs.
- **There is a floor oxidom cannot remove.** Each run spends about 1.4 s summed across files in `setupFiles` (jest-dom,
  RTL cleanup), the same on every DOM. Vitest's own startup and collection add about 2 s of wall time with one worker.
  The React update re-render micro row, which is mostly React work, is at parity.

## Per-file test time

The table shows the tests phase per file in milliseconds: the median of 7 samples in the single-worker forks mode.

| file | jsdom | happy-dom | oxidom | jsdom / oxidom | happy-dom / oxidom | env ms (jsdom / happy-dom / oxidom) | ms in natives (counters run) |
|---|---:|---:|---:|---:|---:|---|---:|
| Accordion | 349 | 129 | 68 | 5.13 | 1.90 | 721 / 312 / 44 | 1.6 |
| AsyncUserList | 453 | 204 | 156 | 2.90 | 1.31 | 697 / 315 / 42 | 3.1 |
| Counter | 260 | 89 | 69 | 3.77 | 1.29 | 701 / 297 / 47 | 1.3 |
| Dashboard | 736 | 380 | 208 | 3.54 | 1.83 | 735 / 329 / 42 | 5.2 |
| **DataTable.heavy** | **8864** | **7751** | **2253** | **3.93** | **3.44** | 703 / 307 / 51 | 136.3 |
| DataTable | 2669 | 1554 | 503 | 5.31 | 3.09 | 722 / 311 / 42 | 19.0 |
| Modal | 559 | 323 | 260 | 2.15 | 1.24 | 695 / 307 / 45 | 2.3 |
| SignupForm | 1714 | 1238 | 978 | 1.75 | 1.27 | 697 / 319 / 57 | 20.0 |
| Tabs | 316 | 113 | 74 | 4.27 | 1.53 | 745 / 288 / 43 | 1.6 |
| Theme | 253 | 100 | 66 | 3.83 | 1.52 | 710 / 299 / 42 | 1.7 |
| TodoApp | 1364 | 706 | 349 | 3.91 | 2.02 | 714 / 295 / 47 | 8.2 |

**Typical file:** the median per-file ratio is 3.83 against jsdom and 1.53 against happy-dom.

**Heavy file:** 3.93 against jsdom and 3.44 against happy-dom.

**Smallest wins:**
- SignupForm: 1.27x against happy-dom and 1.75x against jsdom. The file is dominated by user-event typing and React.
- Modal: 1.24x against happy-dom.

The environment phase per file is flat on every DOM: 42-57 ms for oxidom, about 300 ms for happy-dom and about 710 ms for
jsdom.

## Ablations

### End-to-end

The oxidom ablation runs used n=7 in the same rounds as the matrix.

| mode | oxidom variant | wall | environment | tests | tests excl. heavy | tests vs default |
|---|---|---:|---:|---:|---:|---:|
| forks, 3 workers | default | 4.27 (4.25-4.54) | 0.62 | 6.22 (6.14-7.16) | 3.51 | 1.00 |
| | `OXIDOM_SHARED=0` | 4.49 (4.27-4.90) | 0.54 | 6.83 (6.47-7.66) | 3.80 | 1.10 |
| | `OXIDOM_NO_MEMO=1` | 4.47 (4.18-4.73) | 0.67 | 6.64 (6.07-7.01) | 3.73 | 1.07 |
| | `OXIDOM_NO_PREFILTER=1` | 4.54 (4.29-4.87) | 0.62 | 6.59 (6.21-7.45) | 3.77 | 1.06 |
| | all three off | 4.58 (4.21-5.00) | 0.56 | 6.70 (6.18-7.76) | 3.74 | 1.08 |
| threads, isolate: false, 1 worker | default | 5.31 (5.00-5.60) | 0.05 | 4.11 (3.92-4.47) | 1.91 | 1.00 |
| | `OXIDOM_SHARED=0` | 5.49 (5.14-6.01) | 0.05 | 4.37 (4.12-4.68) | 1.94 | 1.06 |
| | `OXIDOM_NO_MEMO=1` | 5.28 (4.96-5.57) | 0.05 | 4.10 (3.89-4.37) | 1.86 | 1.00 |
| | `OXIDOM_NO_PREFILTER=1` | 5.43 (5.00-5.70) | 0.05 | 4.31 (3.84-4.54) | 1.95 | 1.05 |
| | all three off | 5.55 (4.90-6.02) | 0.04 | 4.35 (3.92-4.97) | 2.00 | 1.06 |

- **Each JS-side layer is worth 0-10% of the tests phase**, and the ranges overlap. With all three off, the wall time is
  still 2.3x faster than happy-dom (forks) and 2.4x faster (serial).
- **The end-to-end win comes from what the switches leave on**: the Rust engine plus the facade's basic design
  (wrappers over table ids, events dispatched in JS, O(1) observer registration), not the memos. These runs cannot
  split those two; the counters (about 0.2 s inside natives) and the micro rows suggest both matter.
- **`OXIDOM_SHARED=0` has a slightly cheaper environment phase**: 0.54 s against 0.62 s summed (forks). Mapping the shared
  node table costs a few ms per file, and the table only pays off in the tests phase.

### Micro

The table compares oxidom variants with the oxidom default. The full tables are in `micro-fallback.md` and
`micro-nomemo-noprefilter.md`. Each table also has its own jsdom and happy-dom columns, measured in the same interleaved
run.

| row | metric | oxidom default | `OXIDOM_SHARED=0` | × | memo + prefilter off | × | happy-dom |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | createElement + append + remove (ns) | 727 | 1071 (971-3252) | 1.47 | 716 | 0.98 | 2084 |
| 1 | insertBefore first + remove() (ns) | 681 | 2027 (1382-2793) | 2.98 | 721 | 1.06 | 2868 |
| 2 | setAttribute (ns) | 108 | 232 | 2.15 | 107 | 0.99 | 1287 |
| 6 | getAttribute unchanged (ns) | 11.9 | 22.0 | 1.84 | **59.4** | **4.97** | 26.0 |
| 7 | hasAttribute unchanged (ns) | 26.4 | 33.2 | 1.26 | 42.7 | 1.62 | 24.3 |
| 2 | set + get + has interleaved (ns) | 278 | 446 | 1.60 | 233 | 0.84 | 1370 |
| 3 | deep build (µs) | 686 | 951 | 1.38 | 654 | 0.95 | 6637 |
| 4 | walk steady (ns/node) | 17.9 | 35.1 | 1.96 | 18.2 | 1.02 | 55.1 |
| 4/5 | walk interleaved (ns/node) | 19.6 | **142** | **7.25** | 19.2 | 0.98 | 62.9 |
| 9 | matches, DTL role selectors, warm (ns/call) | 22.9 | 27.6 | 1.21 | **74.4** | **3.25** | 133 |
| 10 | qSA cold (µs) | 43.1 | 46.8 | 1.09 | 41.8 | 0.97 | 2168 |
| 11 | qSA warm (µs) | 2.83 | 2.91 | 1.03 | **34.2** | **12.1** | 0.202 |
| 10 | querySelector cold (µs) | 0.546 | 0.713 | 1.31 | 0.352 | 0.65 | 2.13 |
| 12 | gcs display cold (ns) | 1221 | 1445 | 1.18 | 1151 | 0.94 | 1094299 |
| 12 | gcs visibility warm (ns) | 61.4 | 65.6 | 1.07 | **933** | **15.2** | 336 |
| 13 | focus() (ns) | 1542 | 2858 | 1.85 | 2938 | 1.90 | 9883 |
| 14 | MouseEvent dispatch, 20 levels (ns) | 3680 | 4232 | 1.15 | 3612 | 0.98 | 15999 |
| 15 | innerHTML parse (µs) | 3248 | 3152 | 0.97 | 3311 | 1.02 | 51366 |
| 18 | MO burst delivery (µs) | 60.8 | 84.8 | 1.39 | 59.3 | 0.97 | 323 |
| - | React createRoot + render 1000 rows (ms) | 66.5 | 92.0 | 1.38 | 67.2 | 1.01 | 284 |
| - | DTL getAllByRole('row') (ms) | 2.29 | 3.28 | 1.43 | **10.0** | **4.37** | 13.1 |
| - | DTL getByRole('button', {name}) (ms) | 6.35 | 7.07 | 1.11 | 10.4 | 1.64 | 21.0 |

How the work splits between Rust and the JS facade:

- **What Rust does.** Rust owns the work where oxidom wins by 6-700x over the faster competitor: MutationObserver
  registration (6.3x), serialisation (9x), parsing (14x), cold `qSA` (50x) and cold `getComputedStyle` (444-689x).
  That work is almost untouched by every ablation.
- **The shared-memory layout matters for traversal and mutation.** It makes walks 2-7x faster, mutation 1.5-3x faster
  and React's initial render 1.4x faster. It reads Rust-owned memory from JS, so its benefit is a facade-design effect.
- **The JS memo and prefilter matter for repeated reads**: `getAttribute`, warm `getComputedStyle`, warm `qSA`, DTL role
  queries and `matches`. Without them oxidom loses `getAttribute` and warm `getComputedStyle` to happy-dom, as DESIGN §13
  predicted.
- **But oxidom still beats happy-dom on `matches` and DTL `getAllByRole` with memo and prefilter off**, at 1.8x and 1.3x
  against the main run's happy-dom values (2.4x and 1.5x against the happy-dom values measured in the ablation run
  itself, which drifted 10-35% slower). Without the shortcuts, each of those calls is one crossing into Rust.
- **The memo has a cost.** An interleaved set/get/has is 16% cheaper with the memo off, because every read misses and
  refills it. A cold `querySelector` is 35% cheaper with memo and prefilter off.

## Micro results (all DOMs)

The table shows 5 processes per case and DOM, interleaved, each the median of 9 samples of about 100 ms. Values are the
median of the process medians, with min-max across processes when wider than 10%. The ratio column shows "oxidom vs best
other": it is printed only when the process ranges do not overlap, and reads "~parity" otherwise. The last column flags
DOMs whose min-max range is wider than 25% of the median.

| case (§13 row) | metric | unit | jsdom | happy-dom | oxidom | oxidom vs best other | spread > 25% |
|---|---|---|---:|---:|---:|---|---|
| mutate (1) | createElement + appendChild + removeChild | ns | 4203 | 2084 (1937-2203) | 727 | 2.9x faster | - |
| mutate (1) | insertBefore first child + remove() (100 siblings) | ns | 4561 | 2868 | 681 (620-752) | 4.2x faster | - |
| attr (2) | setAttribute | ns | 561 | 1287 | 108 | 5.2x faster | - |
| attr (6) | getAttribute (unchanged) | ns | 192 | 26.0 | 11.9 (11.7-13.4) | 2.2x faster | - |
| attr (7) | hasAttribute (unchanged) | ns | 195 | 24.3 | 26.4 | **1.1x slower** (parity in the audit re-run) | - |
| attr (2) | setAttribute + getAttribute + hasAttribute, interleaved | ns/triple | 988 | 1370 (1334-1535) | 278 | 3.6x faster | - |
| deep (3) | bottom-up detached build, 1001 nodes, depth 200, + attach | us | 83638 | 6637 (5865-8657) | 686 (606-759) | 9.7x faster | happy-dom 42% |
| walk (4) | DFS firstChild/nextSibling/parentNode, 4096 nodes, steady | ns/node | 174 | 55.1 (52.1-65.5) | 17.9 | 3.1x faster | - |
| walk (4) | same walk, interleaved: 1 setAttribute + 1 append/remove per walk | ns/node | 197 (184-217) | 62.9 (55.7-71.0) | 19.6 | 3.2x faster | - |
| walk (4) | childNodes[i] indexed read of a 100-child list | ns | 201 (199-238) | 143 | 113 | 1.3x faster | - |
| matches (9) | DTL role selectors x 565 elements, warm | ns/call | 2462 | 133 | 22.9 (22.6-32.0) | 5.8x faster | oxidom 41% |
| matches (9) | same, interleaved: 1 attribute + 1 child-list mutation per pass | ns/call | 2482 (2318-2622) | 138 | 24.2 | 5.7x faster | - |
| qsa (10) | querySelectorAll cold (after a mutation), 2709-element table | us/query | 2856 (2552-2965) | 2168 (1859-2255) | 43.1 | 50x faster | - |
| qsa (11) | querySelectorAll warm (same query, no mutation) | us/query | 183 (167-208) | 0.202 (0.196-0.233) | 2.83 | **14x slower** | - |
| qsa (10) | querySelector #id-less first match, cold | us/query | 36.7 (34.9-40.7) | 2.13 (2.02-3.52) | 0.546 | 3.9x faster | happy-dom 71% |
| gcs (12) | getComputedStyle(el).display, cold after a class mutation | ns | 542678 (489402-617284) | 1094299 (1047125-1177588) | 1221 | 444x faster | - |
| gcs (12) | getComputedStyle(el).visibility, warm (no mutation) | ns | 2585 | 336 (321-386) | 61.4 | 5.5x faster | - |
| gcs (12) | 4 properties (display, color, margin-left, font-weight), cold after a class mutation | ns | 821927 | 1081559 (1029229-1172826) | 2750 | 299x faster | - |
| gcs (12) | getPropertyValue("color"), cold after a class mutation | ns | 744459 | 1227811 (1171664-1347559) | 1881 | 396x faster | - |
| gcs (12) | display, cold after a class mutation, + 800-rule class-keyed sheet | ns | 618452 | 2042398 (1887596-2329370) | 1251 | 494x faster | - |
| gcs (12) | getPropertyValue("color"), cold after a class mutation, + 800-rule sheet | ns | 1381427 (1311214-1452789) | 1993739 | 2006 | 689x faster | - |
| focus (13) | focus() alternating between two inputs (blur/focusout/focus/focusin) | ns | 168879 | 9883 | 1542 (1396-1558) | 6.4x faster | - |
| event (14) | new MouseEvent + dispatch, 20 levels, React-like listeners | ns | 17985 | 15999 (15532-29094) | 3680 (3416-3814) | 4.3x faster | happy-dom 85% |
| parse (15) | innerHTML set, 300-row table | us | 46587 | 51366 (49051-56109) | 3248 (3193-4230) | 14x faster | oxidom 32% |
| serialize (16) | outerHTML get, 300-row table, after a text mutation | us | 1623 (1500-2036) | 4312 (3190-6071) | 181 (174-194) | 9.0x faster | jsdom 33%, happy-dom 67% |
| serialize (16) | textContent get, same table, after a text mutation | us | 340 (309-405) | 679 (639-730) | 26.1 | 13x faster | jsdom 28% |
| mo (18) | observe + disconnect, 4096-node subtree (DTL waitFor options) | ns/pair | 2397 (2286-2769) | 827132 (804405-939980) | 382 (310-564) | 6.3x faster | oxidom 66% |
| mo (18) | appendChild + remove under an active subtree observer (records queued) | ns/pair | 9915 (9250-10884) | 6839 (6233-8115) | 1479 (1327-1605) | 4.6x faster | happy-dom 28% |
| mo (18) | burst of 100 mutations -> one callback delivery (await microtask) | us/burst | 476 (460-519) | 323 (305-352) | 60.8 (53.4-64.3) | 5.3x faster | - |
| mem (19) | RSS per retained `<div class>` (100k, wrapper alive) | bytes | 2011 | 6569 | 347 | 5.8x less | - |
| mem (19) | V8 heap + external per retained `<div class>` | bytes | 2123 | 6404 | 97.7 | 22x less | - |
| mem (19) | churn: RSS growth per created-and-discarded node (2000 x innerHTML of 339 nodes, after gc) | bytes | 2.15 (-0.24-4.56) | 4.09 (0.67-4.77) | 173 | **80x more** | jsdom, happy-dom (near zero) |
| env (17) | environment setup (import + window on globalThis), fresh process, in-process | ms | 744 (692-779) | 323 (307-381) | 36.7 (34.1-44.6) | 8.8x faster | oxidom 29% |
| env (17) | environment teardown | ms | 0.541 (0.473-0.858) | 2.67 (1.34-2.88) | 1.20 (1.10-4.93) | **2.2x slower** (than jsdom) | all |
| env-vitest (17) | **Vitest environment phase per file** (forks, isolate, maxWorkers=1) | ms | 709 | 318 (288-345) | 45.3 (42.2-58.4) | 7.0x faster | oxidom 36% |
| env-vitest (17) | vitest run wall, 6 trivial files (forks, maxWorkers=1) | ms | 5805 (5650-6286) | 3527 | 1812 (1695-1992) | 1.9x faster | - |
| react | createRoot + render 1000-row table (flushSync) | ms | 204 (173-238) | 284 | 66.5 (64.4-107) | 3.1x faster | jsdom 32%, oxidom 64% |
| react | update: re-render with a new selected row | ms | 63.2 (54.2-68.8) | 67.4 (62.1-82.3) | 52.7 (49.7-59.1) | ~parity | happy-dom 30% |
| testing-library | getAllByRole("row") on a 1000-row table | ms | 272 (253-303) | 13.1 (12.5-15.4) | 2.29 (2.20-3.16) | 5.7x faster | oxidom 42% |
| testing-library | getByRole("button", {name}) on the same table (accessible names) | ms | 214 | 21.0 (20.5-25.8) | 6.35 (5.87-7.09) | 3.3x faster | happy-dom 25% |

The env row splits into import and `setup()`. oxidom's facade import takes 0.89 ms and its `setup()` 35.9 ms. For
jsdom and happy-dom, Vitest's environment import is lazy, so all of their cost lands in `setup()`. oxidom never reclaims
nodes inside an environment, so the mutate, deep and parse rows exclude the freeing work that the GC-based DOMs pay; the
churn row shows the memory cost.

**Events, focus and forms** (`bench/micro/events-forms.mjs`, DESIGN §13 row 8). This harness is simpler: one process per
DOM, median of 7 runs, so read it for orders of magnitude only. The oxidom no-memo column is from a separate run.

| operation | jsdom | happy-dom | oxidom | oxidom, `OXIDOM_NO_MEMO=1` |
|---|---:|---:|---:|---:|
| input.value get, unchanged (ns) | 62.0 | 33.1 | 5.1 | 70.6 |
| input.value set + get (ns/pair) | 658 | 260 | 122 | 208 |
| input.checked get (ns) | 32.5 | 2.1 | 2.7 | 2.7 |
| select.value set + get (ns/pair) | 1787 | 1136 | 201 | 230 |
| checkbox click() with activation (ns) | 26428 | 15280 | 5384 | 5263 |
| setSelectionRange + selectionStart get (ns/pair) | 2449 | 4002 | 707 | 735 |
| addEventListener + removeEventListener x143, one container (us) | 81.8 | 30.7 | 14.4 | 15.1 |
| **fresh container + 143 new listeners, retained (us)** | 55.7 | 35.9 | **83.4** | 85.9 |
| document.activeElement (ns) | 279 | 10.2 | 9.5 | 9.1 |

## Native crossings (counters build)

The counters build ran once with forks + isolate and 3 workers; all 90 tests passed.

- **Calls and time.** The suite made **605,113 native calls** and spent **200.4 ms inside natives**. That figure includes
  about 12 ms of timer overhead (about 20 ns per call), so about 190 ms is real work. The count is identical to the
  preliminary run, so it is deterministic.
- **Share of the tests phase.** The time inside natives is **3.2%** of oxidom's 6.22 s tests phase (forks), and 6% of
  DataTable.heavy, which makes 461,586 of the calls and spends 136 ms in natives.

| top natives by time | calls | ms | ns/call |
|---|---:|---:|---:|
| setAttr | 103,495 | 54.2 | 523 |
| qsa | 5,424 | 27.0 | 4971 |
| createElement | 98,621 | 23.9 | 242 |
| textContentSet | 53,637 | 22.8 | 425 |
| appendChild | 101,351 | 15.4 | 152 |
| csCore (computed style, core properties) | 8,966 | 14.2 | 1587 |
| matches | 91,043 | 9.3 | 102 |
| hasAttr | 56,187 | 6.7 | 118 |
| removeChild | 4,074 | 4.1 | 1010 |
| compileSel | 1,017 | 3.8 | 3740 |

What the counters show:

- **DESIGN §13 rule 3 holds.** It predicted about 1.5M public DOM calls but only 0.06-0.15 s of crossing cost. The
  measured crossing count is 0.6M, because many public calls are answered in JS from the shared table and memos without
  crossing. At about 30 ns each, pure crossing overhead is about 0.02 s, and all native work together is about 0.19 s.
- **The boundary is not the bottleneck.** oxidom's remaining tests-phase time is JavaScript: React, Testing Library,
  user-event and the facade.
- **One lead for optimisation.** Inside the app, `setAttr` averages 523 ns per call, against 108 ns in the micro
  benchmark. The cost probably comes from class and style attributes, MutationObserver records and selector or style
  invalidation, but this has not been investigated.

## DESIGN §13: predicted vs measured

Measured values are listed as jsdom / happy-dom / oxidom. The attribution column uses three labels:
- **R**: Rust algorithms or data structures doing the work.
- **F**: the JS facade's design, including the shared-table reads (`OXIDOM_SHARED`), the memos (`OXIDOM_NO_MEMO`) and the
  prefilter (`OXIDOM_NO_PREFILTER`).
- **E**: environment and module-loading effects.

| # | operation | predicted oxidom (verdict) | measured jsdom / happy-dom / oxidom | measured verdict | prediction | attribution |
|---|---|---|---|---|---|---|
| 1 | createElement+appendChild+removeChild | 0.15-0.3 µs (win 15-40×) | 4.20 / 2.08 / 0.73 µs | **win 2.9×** vs happy-dom, 5.8× vs jsdom | **missed**: win, but oxidom is 2.4-4.8× slower than predicted and both baselines are faster than the research numbers (6.6 / 4.5 µs) | R + F (shared table: 1.5× slower when it is off); excludes freeing |
| 2 | setAttribute | 70-120 ns (win 15-50×) | 561 / 1287 / 108 ns | **win 5.2×** vs jsdom, 12× vs happy-dom | oxidom absolute held; ratio vs jsdom lower because jsdom 30 is at 561 ns, not 1.9 µs. In-app average is 523 ns (counters) | R (2.2× slower in fallback mode) |
| 3 | bottom-up build, 1001 nodes, depth 200 | 0.1-0.3 ms (win) | 83.6 / 6.64 / 0.69 ms | **win 9.7×** vs happy-dom, 122× vs jsdom | held (win). oxidom is 2-7× above the predicted absolute, and happy-dom 21 is 10× faster than the research baseline | R (no subtree walks) + F (wrappers) |
| 4 | DFS walk, steady / interleaved | 8-15 ns/node (win 2-5× vs happy-dom) | 174 / 55.1 / 17.9 and 197 / 62.9 / 19.6 ns/node | **win 3.1-3.2×** | held (absolute slightly above range) | F over Rust-owned memory: the shared table (2× / 7× slower without it) |
| 5 | same walk, fallback mode, interleaved | 35-80 ns/node (**lose** to happy-dom) | 210 / 70.3 / 142 ns/node (fallback run) | **lose 2.0×**; steady fallback wins 1.5× (35.1 vs 53.6) | held; absolute worse than predicted | F (crossing per read without the table) |
| 6 | getAttribute of a tiny node | 60-100 ns (parity to lose 2× vs happy-dom; win 4× vs jsdom) | 192 / 26.0 / 11.9 ns | **win 2.2×** vs happy-dom, 16× vs jsdom | **wrong in oxidom's favour, only because of the JS memo** added in §15.2: memo off gives 59.4 ns, which **loses 2.2×**, the predicted outcome. textContent of a tiny node is not measured separately | F (memo) |
| 7 | hasAttribute | 45-70 ns (lose ~1.5×) | 195 / 24.3 / 26.4 ns | **lose 1.1×** (parity in the audit re-run) | held (lose or parity), smaller than predicted thanks to the memo; memo off is 42.7 ns (lose 1.7×) | F (memo) |
| 8 | input.value get after write | 60-80 ns cold, 3-5 ns memo (memo: parity; no memo: lose) | get 62.0 / 33.1 / 5.1 ns; set+get 658 / 260 / 122 ns | **memo: win 6.5×** (get), 2.1× (set+get); **no memo: lose 2.1×** (get, 70.6 ns) | held for no-memo; memo better than the predicted parity | F (memo) |
| 9 | matches(), DTL role selectors | 3-10 ns prefiltered (win; vs happy-dom warm only because of the prefilter) | 2462 / 133 / 22.9 ns | **win 5.8×** vs happy-dom, 107× vs jsdom | **partly wrong**: absolute 2-7× above the prediction, and the Rust path alone (prefilter and memo off: 74 ns) still beats happy-dom warm 1.8×. Memo and prefilter together add 3.2× (the micro ablation switched them off together) | R + F (prefilter, memo) |
| 10 | qSA cold, 2.7k-element table | 20-80 µs (win 30-300×) | 2856 / 2168 / 43.1 µs | **win 50×** vs happy-dom, 66× vs jsdom | held | R |
| 11 | qSA warm, no mutation | 0.3-0.6 µs with memo (parity) / 20-80 µs without (lose) | 183 / 0.202 / 2.83 µs | **lose 14×** vs happy-dom (win 65× vs jsdom); memo off 34.2 µs (lose 164×) | **missed**: happy-dom returns the same cached NodeList object, while the spec, jsdom and oxidom return a new static NodeList. oxidom's cost is building that list in JS | F (NodeList construction); memo |
| 12 | getComputedStyle cold after mutation | 0.1-1 µs (win 500-5000×) | 543 / 1094 / 1.22 µs | **win 444×** vs jsdom (896× vs happy-dom); 494-689× with an 800-rule sheet | **narrowly missed**: 1.22 µs is just above the predicted 0.1-1 µs, and 444× (vs jsdom, the faster competitor here) just below the predicted 500×; the order of magnitude held | R (cascade + bucketed author index); the warm path is F (memo: 933 ns without it, lose 2.8×) |
| 13 | focus() | 0.3-1 µs (win) | 168.9 / 9.88 / 1.54 µs | **win 6.4×** vs happy-dom, 110× vs jsdom | held (win); absolute 1.5-5× above prediction | R (focusability, fixup) + F (focus events in JS) |
| 14 | new MouseEvent + dispatch, 20 levels | ≈ happy-dom ±20% (parity, pure JS on both) | 17985 / 15999 / 3680 ns | **win 4.3×** | **wrong in oxidom's favour**: happy-dom 21's dispatch is far slower than the research baseline | F (JS dispatch design: flat listener lists, path from shared-table parent reads; 1.15× slower in fallback). Not Rust |
| 15 | innerHTML set (parse) | 3-8× vs jsdom, 2-4× vs happy-dom | 46.6 / 51.4 / 3.25 ms | **win 14×** vs jsdom, 16× vs happy-dom | beat prediction | R (parser + no per-node JS objects until touched); excludes freeing |
| 16 | outerHTML get | 1-3 ms for 3.6k elements (win) | 1623 / 4312 / 181 µs (300-row table) | **win 9.0×** vs jsdom, 24× vs happy-dom | held. The ~52 ms research baseline was the prettyDOM path, which this case does not measure | R |
| 17 | env setup per file | 15-40 ms (win, mostly non-Rust) | Vitest env phase 709 / 318 / 45.3 ms | **win 7.0×** vs happy-dom, 15.7× vs jsdom | held (absolute slightly above 40 ms); suite-level 0.62 s vs the predicted ~0.3 s | **E** (facade size, data-property globals, no large module graph). Rust adds the addon load; `OXIDOM_SHARED=0` is about 3 ms cheaper (ranges overlap). Teardown loses 2.2× to jsdom (1.2 ms vs 0.5 ms; negligible) |
| 18 | MO observe/disconnect on 4k nodes | O(1), ~50 ns (win) | 2397 / 827132 / 382 ns per pair | **win 6.3×** vs jsdom, 2165× vs happy-dom | held (win); absolute about 4× the predicted 50 ns per call | R (O(1) registration) |
| 19 | memory per div | ~0.3 KB (win; no reclaim within a file) | RSS 2011 / 6569 / 347 B | **win 5.8× less** vs jsdom, 19× vs happy-dom | held. **Churn loses**: 173 B per discarded node vs 2-4 B, as predicted ("no reclaim") | R (64-B table rows) |

**Whole suite** (forks + isolate, 3 workers):

| phase | predicted oxidom | measured jsdom / happy-dom / oxidom | prediction |
|---|---|---|---|
| environment (summed) | ~0.3 s | 9.68 / 4.80 / 0.62 s | **missed by 2×**; still 7.7× less than happy-dom |
| tests (summed) | 6-10 s | 21.88 / 15.91 / 6.22 s | held (low end) |
| wall | 4.5-6.5 s | 12.46 / 10.74 / 4.27 s | **beat** |
| speed-up | 2-2.5× vs jsdom, 1.5-2× vs happy-dom | 2.92× / 2.52× | **beat** on both |

**Attribution rules.**
1. Environment and tests are reported separately, and the environment win is labelled **E**. The suite's setup phase is
   about equal on every DOM.
2. Ablations: switching off the JS layers, one at a time or all together, costs 0-10% of the tests phase end to end.
   At the micro level the memo and prefilter decide the repeated-read rows 6-9 and 11, and the shared table decides walks
   (rows 4-5).
3. Counters: 0.6M crossings and about 0.19 s inside natives; the crossing overhead is about 0.02 s.
4. Every timed test passes on all three DOMs (161/161 valid e2e samples). Reads interleave mutations, and cold and warm
   are reported separately.

## Losses and caveats

**Losses**, each one measured:
- `qSA` warm: 14× slower than happy-dom. This is F plus happy-dom's non-spec NodeList reuse.
- Node churn: 173 B per discarded node, because nothing is reclaimed inside an environment.
- `hasAttribute`: parity to 1.1× slower than happy-dom (within run-to-run noise).
- Fresh targets with 143 new listeners: 2.3× slower than happy-dom. This is F.
- Environment teardown: 2.2× slower than jsdom, about 0.7 ms per file.
- `setupFiles` phase in the parallel modes: 1.87 s against 1.57-1.71 s, not investigated. With one worker it is equal
  (1.42 s against 1.34-1.42 s).
- With an ablation switch on, oxidom loses the rows above: fallback walks, and no-memo reads of `getAttribute`,
  `input.value` and warm `getComputedStyle`.

**Caveats:**
- **Scope.** These results cover one workload: a React 19 + RTL suite whose wall time is set by DataTable.heavy. The
  typical-file win over happy-dom is about 1.4-1.5×, not the 2.5× wall-time headline.
- **Missing surface.** oxidom does not implement Shadow DOM, custom elements, iframes or layout (ROADMAP "Out of scope").
- **Divergences.** DESIGN §14.1 and §14.2 list the remaining divergences: live non-core computed properties, `:empty`,
  `dataset` namespaces, `font-weight` serialisation and others. A suite that relies on those may behave differently.
- **vmThreads** is not in the final matrix (`--best` adds it; oxidom cannot run it). The audit re-run measured it once
  (n=3): it was not faster than threads-noiso for jsdom or happy-dom.
- **Peak RSS** is measured with getrusage `RUSAGE_CHILDREN`, which reports the peak of the **largest single
  process** (the Vitest main process or one forks worker), not the sum over workers. With forks it is therefore about
  one worker's footprint; with threads the workers share one process, which is why threads figures are higher.
  Compare DOMs within one mode only.
- **Other known limits** (ROADMAP M9 list): strings are stored as UTF-8, with lone surrogates as private-use escapes
  (DESIGN §44); live-list index getters are installed up
  to a bound (at least 256), so a list held across a mutation that grows it past that bound and indexed without any
  `length`/`item`/iteration access returns `undefined`; non-core computed properties are read live (jsdom snapshots
  them); a panic inside a native leaves the env non-transactional.
- **Noise.** One 4-vCPU Firecracker VM. Identical baseline rows drift 10-35% between the three micro runs (for
  example happy-dom `matches` 133 vs 179 ns), so ratios built across runs are approximate; within a run, DOMs are
  interleaved. The forms micro (row 8, listener rows) is one process per DOM: orders of magnitude only.

## Independent audit re-run (2026-10-17, same addon `325866fa4f24`, HEAD `f87e20c`)

A separate agent re-ran a subset on the same idle VM (load 0.00 before the start), without `--write`, to check the
committed numbers. Everything agreed within noise; no row changed sign except `hasAttribute` (1.1x slower -> parity).

E2E, n=3 + 1 warm-up, interleaved (`node bench/e2e/run.mjs --n=3 --matrix=forks,forks-1,vmThreads --no-ablations`),
wall in seconds, all 3/3 samples valid on every DOM:

| entry | jsdom | happy-dom | oxidom | jsdom / oxidom | happy-dom / oxidom | published ratios |
|---|---:|---:|---:|---:|---:|---|
| forks, 3 workers | 12.02 | 10.28 | 4.34 | 2.77 | 2.37 | 2.92 / 2.52 |
| forks-1 | 29.07 | 20.11 | 9.16 | 3.17 | 2.19 | 3.10 / 2.11 |
| vmThreads, 3 workers | 12.21 | 10.15 | (cannot run) | 2.82 vs oxidom forks | 2.34 vs oxidom forks | not measured |

forks-1 phases: environment 7.91 / 3.29 / 0.51 s, tests 17.36 / 12.67 / 4.91 s; DataTable.heavy tests 8.55 / 7.82 /
2.14 s (happy-dom / oxidom 3.66x); per-file median tests ratio happy-dom / oxidom 1.46 (1.38 in forks).

Micro, 3 processes x 7 samples (`--cases=attr,qsa,gcs,matches --procs=3`; the attr case ran right after the e2e run,
under its trailing load): setAttribute 538 / 1215 / 109 ns (published 561 / 1287 / 108); getAttribute 188 / 25.2 /
11.9 ns; hasAttribute 199 / 25.4 / 25.3 ns (parity); qSA cold 2903 / 2194 / 43.4 µs (51x); qSA warm 183 / 0.244 /
3.07 µs (13x slower); gcs display cold 493 / 1177 / 1.15 µs (428x); gcs 800-rule color 1319 / 2037 / 2.07 µs (638x);
matches warm 2478 / 150 / 25.0 ns (6.0x).

## Files and reproduction

- `bench/results/micro.{json,md}`: the main micro run, `OXIDOM_BENCH_SAMPLES=9`. The JSON keeps every sample and
  every process.
- `bench/results/micro-fallback.{json,md}`: the `OXIDOM_SHARED=0` micro run.
- `bench/results/micro-nomemo-noprefilter.{json,md}`: the micro run with `OXIDOM_NO_MEMO=1` and
  `OXIDOM_NO_PREFILTER=1`.
- `bench/results/e2e.{json,md}`: the e2e summary, covering the matrix, ablations, per-file times and counters.
- `bench/results/raw/e2e-2026-10-17T03-53-11-529Z.json`: every e2e sample with all of its per-file phases and load
  averages. It is committed (tracked explicitly) as the M8 record; other files in `raw/` are gitignored.
- `bench/micro/events-forms{,-nomemo}.txt`: the area-B forms micro (row 8).

```bash
cd oxidom && npm run build && npm run build:counters
OXIDOM_BENCH_SAMPLES=9 node --expose-gc bench/micro/run.mjs --write
OXIDOM_SHARED=0 OXIDOM_BENCH_SAMPLES=9 node --expose-gc bench/micro/run.mjs --write
OXIDOM_NO_MEMO=1 OXIDOM_NO_PREFILTER=1 OXIDOM_BENCH_SAMPLES=9 node --expose-gc bench/micro/run.mjs --write
node bench/e2e/run.mjs --n=7 --counters --write      # about 29 min; micro runs about 17-18 min each
node --expose-gc bench/micro/events-forms.mjs --write && OXIDOM_NO_MEMO=1 node --expose-gc bench/micro/events-forms.mjs --write
```
