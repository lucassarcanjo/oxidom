# Benchmark results

> Committed here: the Markdown summaries and `e2e.json` of the lab's final M8 run. The per-sample micro JSON files
> (`micro*.json`) and `raw/` stayed in oxidom-lab; `--write` regenerates all of them.

Produced by `bench/micro/run.mjs` and `bench/e2e/run.mjs` (see `../README.md`). The write-up, with methodology,
machine, DESIGN §13 predicted-vs-measured and attribution, is **`docs/BENCHMARKS.md`**.

**Provenance of the committed files (final M8 run, 2026-10-17):** merged HEAD `c4e213d`, clean release build
(addon sha256 `325866fa4f24…`, counters build `cdcc9f16bda6…`), idle 4-vCPU VM with no other agents running, every harness
run alone and in sequence.

| file | what |
|---|---|
| `micro.{json,md}` | all cases, all three DOMs, 5 interleaved processes per case and DOM, `OXIDOM_BENCH_SAMPLES=9` |
| `micro-fallback.{json,md}` | same with `OXIDOM_SHARED=0` (all three DOMs re-measured in the same run) |
| `micro-nomemo-noprefilter.{json,md}` | same with `OXIDOM_NO_MEMO=1 OXIDOM_NO_PREFILTER=1` |
| `e2e.{json,md}` | app suite, n=7 + 1 warm-up per config, interleaved; matrix forks / forks-1 / threads / threads-noiso / serial x 3 DOMs; oxidom ablations (`OXIDOM_SHARED=0`, `OXIDOM_NO_MEMO=1`, `OXIDOM_NO_PREFILTER=1`, all three) on forks and serial; one counters-build run |
| `raw/e2e-2026-10-17T03-53-11-529Z.json` | every sample of that e2e run (per-file phases, load average, RSS). `raw/` is gitignored; this file was force-added as the M8 record |

The micro JSON files keep every sample of every process. All 161 e2e samples are valid (exit 0, 0 failed tests). The e2e
samples carry the `!` load flag because the trailing load of the preceding 3-worker run was 1.65-3.71, which is
self-induced and the same for every DOM thanks to interleaving. No micro process ran above the load threshold. The e2e
meta says `gitDirty: true` only because this run's `micro*` outputs had already been rewritten when the e2e run started.
