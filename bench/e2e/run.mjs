// End-to-end benchmark (ROADMAP M8): runs the app suite (app/, 11 files / 90 tests, NOT modified) N times per
// DOM_ENV, each sample a fresh `vitest run` process with bench/e2e/phase-reporter.mjs, and summarises
// external wall time + per-phase sums + per-file test time (medians and spread).
//
//   node bench/e2e/run.mjs [--n=5] [--warmup=1] [--doms=jsdom,happy-dom,oxidom]
//                          [--matrix=forks,threads,threads-noiso,serial] [--ablations=forks,serial | --no-ablations]
//                          [--counters] [--write]
//
// Protocol (docs/lab/research/vitest-env.md §9): warm-up run(s) first (Vitest 5's fsModuleCache makes samples
// warm-cache runs, as developers see them); samples are INTERLEAVED (sample i of every config before sample
// i+1 of any) to spread machine drift over all configs; --maxWorkers is pinned; config, setup files and
// transforms are identical for all DOMs, only DOM_ENV (and OXIDOM_* for ablations) varies. Configuration is
// passed with CLI flags/env only. A failing run is kept (and flagged), but the "common" test sums only count
// files that passed in every DOM of that matrix entry: a DOM that fails tests is not "faster".
//
// --write: raw samples -> bench/results/raw/e2e-<stamp>.json (gitignored), summary ->
// bench/results/e2e.json + e2e.md. --counters: one extra oxidom forks run with the counters build
// (OXIDOM_COUNTERS=1), crossings and native time per file -> e2e-counters section.
//
// Fairness rules (M9 review):
// - Statistics use only VALID samples (exit 0, reporter output present, 0 failed tests); the excluded count
//   is shown and a row with fewer than N-1 valid samples is marked INVALID. A crashed run is short: it must
//   never pull a median down.
// - "tests (common)" counts files that passed in EVERY sample of EVERY DOM of that matrix entry.
// - Per-phase attribution (environment vs tests) comes from `forks-1` (isolate, 1 worker: no CPU contention
//   between workers); the parallel entries are for wall time only. The markdown says which entry each
//   number comes from.
// - Wall is reported next to the critical-path file (the long pole, DataTable.heavy) plus "tests excluding
//   *.heavy*" and the per-file median ratio, so a single heavy file does not stand for the whole suite.
// - Peak RSS per sample (getrusage RUSAGE_CHILDREN through a python3 wrapper when available).
// - Children get a clean environment (every OXIDOM_* not set by the config is removed, OXIDOM_NATIVE included,
//   unless --native=<addon>); meta records git rev, dirty flag, addon sha256 + build profile, package
//   versions and the load average around every sample.
// - --best adds each DOM's other supported pools (vmThreads for jsdom / happy-dom; oxidom cannot run it) and
//   NODE_COMPILE_CACHE variants of forks, and prints a "best available config per DOM" table.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provenance, cleanEnv as cleanOxidomEnv, load1, MAX_LOAD } from '../provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const oxidomRoot = path.resolve(here, '../..');
const appRoot = path.join(oxidomRoot, 'e2e/react-app');
const resultsDir = path.join(oxidomRoot, 'bench/results');
const reporter = path.join(here, 'phase-reporter.mjs');
const vitestCli = path.join(appRoot, 'node_modules/vitest/vitest.mjs');

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a === undefined ? def : a.slice(name.length + 3);
}
const flag = (name) => process.argv.includes(`--${name}`);

const N = Number(arg('n', 5));
const WARMUP = Number(arg('warmup', 1));
const DOMS = arg('doms', 'jsdom,happy-dom,oxidom').split(',').filter(Boolean);
const WORKERS = Number(arg('workers', Math.max(1, os.availableParallelism() - 1)));

/** Matrix entries: Vitest CLI flags. */
const MATRIX = {
  forks: { label: `forks + isolate (default), ${WORKERS} workers`, args: ['--pool=forks', `--maxWorkers=${WORKERS}`] },
  threads: { label: `threads + isolate, ${WORKERS} workers`, args: ['--pool=threads', `--maxWorkers=${WORKERS}`] },
  'threads-noiso': { label: `threads, isolate: false, ${WORKERS} workers`, args: ['--pool=threads', '--no-isolate', `--maxWorkers=${WORKERS}`] },
  serial: { label: 'threads, isolate: false, maxWorkers=1', args: ['--pool=threads', '--no-isolate', '--maxWorkers=1'] },
  'forks-1': { label: 'forks + isolate, maxWorkers=1 (phase attribution: no contention between workers)', args: ['--pool=forks', '--maxWorkers=1'] },
  vmThreads: { label: `vmThreads, ${WORKERS} workers (jsdom / happy-dom only)`, args: ['--pool=vmThreads', `--maxWorkers=${WORKERS}`], doms: ['jsdom', 'happy-dom'] },
  'forks-cc': { label: `forks + isolate + NODE_COMPILE_CACHE, ${WORKERS} workers`, args: ['--pool=forks', `--maxWorkers=${WORKERS}`], compileCache: true },
};
/** Matrix entries that may compete in the "best available config per DOM" table (same worker count). */
const BEST_CANDIDATES = ['forks', 'threads', 'threads-noiso', 'vmThreads', 'forks-cc'];
const ABLATIONS = {
  'OXIDOM_SHARED=0': { OXIDOM_SHARED: '0' },
  'OXIDOM_NO_MEMO=1': { OXIDOM_NO_MEMO: '1' },
  'OXIDOM_NO_PREFILTER=1': { OXIDOM_NO_PREFILTER: '1' },
  'all off': { OXIDOM_SHARED: '0', OXIDOM_NO_MEMO: '1', OXIDOM_NO_PREFILTER: '1' },
};
const matrix = arg('matrix', `forks,forks-1,threads,threads-noiso,serial${flag('best') ? ',vmThreads,forks-cc' : ''}`).split(',').filter(Boolean);
const NATIVE = arg('native', null);
const ablationMatrix = flag('no-ablations') ? [] : arg('ablations', 'forks,serial').split(',').filter(Boolean);
for (const m of [...matrix, ...ablationMatrix]) if (!MATRIX[m]) throw new Error(`unknown matrix entry ${m}`);

const configs = [];
const compileCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxidom-e2e-cc-'));
for (const m of matrix) {
  for (const dom of DOMS) {
    if (MATRIX[m].doms && !MATRIX[m].doms.includes(dom)) continue;
    const env = { DOM_ENV: dom, ...(MATRIX[m].compileCache ? { NODE_COMPILE_CACHE: path.join(compileCacheDir, dom) } : {}) };
    configs.push({ name: `${dom} | ${m}`, matrix: m, dom, ablation: null, env, args: MATRIX[m].args });
  }
}
if (DOMS.includes('oxidom')) {
  for (const m of ablationMatrix) {
    for (const [ab, env] of Object.entries(ABLATIONS)) {
      configs.push({ name: `oxidom ${ab} | ${m}`, matrix: m, dom: 'oxidom', ablation: ab, env: { DOM_ENV: 'oxidom', ...env }, args: MATRIX[m].args });
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDir = path.join(resultsDir, 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oxidom-e2e-'));

function cleanEnv(extra) {
  // every OXIDOM_* switch (ablations, OXIDOM_NATIVE, counters) must only come from the config
  const env = cleanOxidomEnv({ CI: '1', NO_COLOR: '1', ...(NATIVE ? { OXIDOM_NATIVE: path.resolve(NATIVE) } : {}), ...extra });
  if (!('NODE_COMPILE_CACHE' in extra)) delete env.NODE_COMPILE_CACHE;
  return env;
}

// python3 wrapper: runs the command, prints {"wall_ms", "maxrss_kib"} (getrusage RUSAGE_CHILDREN = the peak
// RSS of the largest waited-for descendant: the Vitest main process or a forks worker; threads share it).
const PY_WRAP = 'import json,resource,subprocess,sys,time\n'
  + 't=time.perf_counter(); r=subprocess.run(sys.argv[1:]); w=(time.perf_counter()-t)*1000\n'
  + 'sys.stderr.write("\\n@@RUSAGE "+json.dumps({"wall_ms":w,"maxrss_kib":resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,"status":r.returncode})+"\\n")\n'
  + 'sys.exit(r.returncode if r.returncode >= 0 else 128 - r.returncode)\n';
const HAVE_PY = spawnSync('python3', ['-c', 'import resource'], { encoding: 'utf8' }).status === 0;

function runOnce(cfg, tag) {
  const out = path.join(scratch, `${tag}.json`);
  const cmd = [process.execPath, vitestCli, 'run', '--reporter=dot', `--reporter=${reporter}`, ...cfg.args];
  const loadBefore = load1();
  const t0 = performance.now();
  const r = spawnSync(HAVE_PY ? 'python3' : cmd[0], HAVE_PY ? ['-c', PY_WRAP, ...cmd] : cmd.slice(1), {
    cwd: appRoot,
    env: cleanEnv({ ...cfg.env, OXIDOM_PHASES_OUT: out }),
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 << 20,
  });
  let wall = performance.now() - t0;
  let maxRssMiB = null;
  const ru = (r.stderr ?? '').split('\n').find((l) => l.startsWith('@@RUSAGE '));
  if (ru) {
    const j = JSON.parse(ru.slice('@@RUSAGE '.length));
    wall = j.wall_ms; // excludes the wrapper's own startup
    maxRssMiB = Math.round(j.maxrss_kib / 1024);
  }
  const load = [loadBefore, load1()];
  let phases = null;
  try {
    phases = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    // the run crashed before the reporter wrote
  }
  const failLines = r.status === 0 ? [] : (r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error|×/.test(l)).slice(0, 5);
  const failedTests = phases ? phases.files.reduce((a, f) => a + f.failed, 0) : null;
  const valid = r.status === 0 && phases !== null && failedTests === 0;
  return { wall, status: r.status, signal: r.signal, phases, failLines, valid, failedTests, maxRssMiB, load };
}

// --------------------------------------------------------------------------------------------- stats

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? null : n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function stat(xs) {
  if (xs.length === 0) return null;
  const m = median(xs);
  return { n: xs.length, median: Math.round(m), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)), spread: m ? +((Math.max(...xs) - Math.min(...xs)) / m).toFixed(3) : 0 };
}
const PHASES = ['environment', 'worker', 'transform', 'setup', 'import', 'tests'];
const sum = (files, k, filter = () => true) => files.filter(filter).reduce((a, f) => a + f[k], 0);

// ----------------------------------------------------------------------------------------------- run

if (!fs.existsSync(vitestCli)) throw new Error('e2e/react-app/node_modules missing: run `npm ci` in app/');
const raw = { meta: { date: new Date().toISOString(), node: process.version, cpu: `${os.cpus()[0]?.model ?? '?'} x${os.cpus().length}`, n: N, warmup: WARMUP, workers: WORKERS, maxLoad: MAX_LOAD, rusage: HAVE_PY, provenance: provenance({ native: NATIVE }) }, configs: {} };
if (raw.meta.provenance.addon.build && !raw.meta.provenance.addon.build.startsWith('release')) {
  process.stderr.write(`[e2e] WARNING: addon build is "${raw.meta.provenance.addon.build}", not a plain release build\n`);
}
for (const c of configs) raw.configs[c.name] = { ...c, samples: [] };

for (let i = 0; i < WARMUP + N; i++) {
  // rotate the order every round so no config always runs first/last
  const order = configs.map((_, k) => configs[(k + i) % configs.length]);
  for (const cfg of order) {
    process.stderr.write(`[e2e] ${i < WARMUP ? 'warm-up' : `sample ${i - WARMUP + 1}/${N}`}: ${cfg.name}\n`);
    const r = runOnce(cfg, `${cfg.name.replace(/\W+/g, '_')}-${i}`);
    if (r.status !== 0) process.stderr.write(`[e2e]   exit ${r.status}${r.signal ? ` (${r.signal})` : ''}: ${r.failLines.join(' | ')}\n`);
    if (i >= WARMUP) raw.configs[cfg.name].samples.push(r);
  }
}

let counters = null;
if (flag('counters') && DOMS.includes('oxidom')) {
  const outFile = path.join(scratch, 'counters.jsonl');
  const r = runOnce({ env: { DOM_ENV: 'oxidom', OXIDOM_COUNTERS: '1', OXIDOM_COUNTERS_OUT: outFile }, args: MATRIX.forks.args }, 'counters');
  const lines = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const perFile = lines.map((l) => ({ file: l.files.map((f) => path.relative(appRoot, f)).join(','), calls: l.counters.calls, ms: +(l.counters.ns / 1e6).toFixed(2) }));
  const fns = {};
  for (const l of lines) for (const [k, [c, ns]] of Object.entries(l.counters.fns)) {
    fns[k] ??= [0, 0];
    fns[k][0] += c;
    fns[k][1] += ns;
  }
  const top = Object.entries(fns).sort((a, b) => b[1][1] - a[1][1]).slice(0, 15).map(([k, [c, ns]]) => ({ fn: k, calls: c, ms: +(ns / 1e6).toFixed(2), nsPerCall: Math.round(ns / c) }));
  counters = { status: r.status, enabled: lines[0]?.counters.enabled ?? false, files: perFile, totalCalls: perFile.reduce((a, f) => a + f.calls, 0), totalMs: +perFile.reduce((a, f) => a + f.ms, 0).toFixed(1), top };
}

// ------------------------------------------------------------------------------------------- summary

const summary = { meta: raw.meta, matrix: {}, ablations: {}, perFile: {}, counters };
/** files that passed in EVERY sample of EVERY DOM of a matrix entry */
function commonFiles(m) {
  let common = null;
  for (const dom of DOMS) {
    const cfg = raw.configs[`${dom} | ${m}`];
    if (!cfg) continue;
    for (const s of cfg.samples) {
      const ok = new Set((s.phases?.files ?? []).filter((f) => f.state === 'passed').map((f) => f.file));
      common = common === null ? ok : new Set([...common].filter((f) => ok.has(f)));
    }
  }
  return common ?? new Set();
}

const isHeavy = (f) => /\.heavy\./.test(f.file);
const fileTotal = (f) => f.environment + f.worker + f.transform + f.setup + f.import + f.tests;

function summarise(cfg, common) {
  const ok = cfg.samples.filter((s) => s.valid);
  const row = {
    runs: cfg.samples.length,
    valid: ok.length,
    excluded: cfg.samples.length - ok.length,
    invalid: ok.length < Math.max(1, N - 1),
    exitCodes: cfg.samples.map((s) => s.status),
    failedTests: cfg.samples.map((s) => s.failedTests),
    failedFiles: cfg.samples.map((s) => (s.phases ? s.phases.files.filter((f) => f.state !== 'passed').length : null)),
    loaded: cfg.samples.filter((s) => Math.max(...s.load) > MAX_LOAD).length,
    wall: stat(ok.map((s) => s.wall)),
    vitestWall: stat(ok.map((s) => s.phases.wall)),
    maxRssMiB: stat(ok.map((s) => s.maxRssMiB).filter((x) => x !== null)),
  };
  for (const p of PHASES) row[p] = stat(ok.map((s) => sum(s.phases.files, p)));
  row.testsCommon = stat(ok.map((s) => sum(s.phases.files, 'tests', (f) => common.has(f.file))));
  row.testsNoHeavy = stat(ok.map((s) => sum(s.phases.files, 'tests', (f) => common.has(f.file) && !isHeavy(f))));
  // critical path: the file with the largest env+worker+transform+setup+import+tests in each sample
  const crit = ok.map((s) => s.phases.files.reduce((a, f) => (fileTotal(f) > fileTotal(a) ? f : a)));
  row.criticalFile = crit.length ? median(crit.map((f) => fileTotal(f))) : null;
  row.criticalName = crit[0]?.file ?? null;
  row.envSetups = ok[0]?.phases.workersSpawned ?? null;
  return row;
}

/** Median over common files of (other DOM's median tests time / oxidom's): the "typical file" ratio. */
function perFileRatio(per, other, common) {
  const rs = [];
  for (const [file, v] of Object.entries(per)) {
    if (!common.has(file) || !v[other] || !v.oxidom || v.oxidom.tests <= 0) continue;
    rs.push(v[other].tests / v.oxidom.tests);
  }
  return rs.length ? +median(rs).toFixed(2) : null;
}

for (const m of [...new Set([...matrix, ...ablationMatrix])]) {
  const common = commonFiles(m);
  summary.matrix[m] = { label: MATRIX[m].label, commonPassingFiles: [...common].sort(), doms: {} };
  for (const dom of DOMS) {
    const cfg = raw.configs[`${dom} | ${m}`];
    if (cfg) summary.matrix[m].doms[dom] = summarise(cfg, common);
  }
  for (const ab of Object.keys(ABLATIONS)) {
    const cfg = raw.configs[`oxidom ${ab} | ${m}`];
    if (cfg) (summary.ablations[m] ??= {})[ab] = summarise(cfg, common);
  }
  // per-file median test time over valid samples
  const per = {};
  for (const dom of DOMS) {
    const cfg = raw.configs[`${dom} | ${m}`];
    if (!cfg) continue;
    const byFile = {};
    for (const s of cfg.samples) if (s.valid) for (const f of s.phases.files) (byFile[f.file] ??= []).push(f);
    for (const [file, xs] of Object.entries(byFile)) {
      (per[file] ??= {})[dom] = {
        tests: Math.round(median(xs.map((x) => x.tests))),
        import: Math.round(median(xs.map((x) => x.import))),
        environment: Math.round(median(xs.map((x) => x.environment))),
        state: xs[0].state,
      };
    }
  }
  summary.perFile[m] = per;
  if (DOMS.includes('oxidom')) {
    summary.matrix[m].perFileMedianRatio = Object.fromEntries(DOMS.filter((d) => d !== 'oxidom').map((d) => [d, perFileRatio(per, d, common)]));
  }
}

// best available config per DOM (wall, same worker count): only entries that ran and are valid
summary.best = {};
for (const dom of DOMS) {
  let best = null;
  for (const m of BEST_CANDIDATES) {
    const r = summary.matrix[m]?.doms[dom];
    if (!r || r.invalid || !r.wall) continue;
    if (best === null || r.wall.median < best.wall.median) best = { matrix: m, wall: r.wall };
  }
  summary.best[dom] = best;
}

// ------------------------------------------------------------------------------------------- markdown

const L = [];
const fmtS = (s) => (s ? `${s.median}${s.spread > 0.1 ? ` (${s.min}-${s.max})` : ''}` : 'n/a');
const pv = raw.meta.provenance;
L.push('# oxidom end-to-end benchmark (app/ suite)', '');
L.push(`${raw.meta.date} · Node ${raw.meta.node} · ${raw.meta.cpu} · ${N} samples + ${WARMUP} warm-up per config, interleaved · ms, medians over VALID samples (min-max when spread > 10%)`
  + ` · git ${pv.gitRev?.slice(0, 10)}${pv.gitDirty ? '-dirty' : ''} · addon ${pv.addon.build} ${pv.addon.sha256?.slice(0, 12)}`
  + ` · jsdom ${pv.versions.jsdom} · happy-dom ${pv.versions['happy-dom']} · vitest ${pv.versions['vitest (app)']} · react ${pv.versions.react}`, '');
L.push('Wall = external `vitest run` process time. Phase columns are SUMS over files of Vitest 5\'s per-file phases. '
  + '**Use `forks-1` (one worker, no CPU contention) for phase attribution (environment vs tests); use the parallel entries for wall time only.** '
  + 'A sample is valid when vitest exits 0 with 0 failed tests; "valid" shows valid/total and a row with fewer than N-1 valid samples is INVALID. '
  + '"tests (common)" counts only files that passed in every sample of every DOM of the group; "excl. heavy" also drops *.heavy* files. '
  + '"critical file" = the long-pole file (env+setup+import+tests), which bounds wall with parallel workers. '
  + '`!` = some sample ran above the load threshold. With `isolate: false` and maxWorkers > 1 the environment phase is re-reported per file (Vitest Pitfall A): compare wall there.', '');
for (const [m, g] of Object.entries(summary.matrix)) {
  L.push(`## ${m}: ${g.label}`, '');
  const ratios = g.perFileMedianRatio ? Object.entries(g.perFileMedianRatio).map(([d, x]) => `${d}/oxidom ${x ?? 'n/a'}`).join(', ') : '';
  L.push(`common passing files: ${g.commonPassingFiles.length}/11${ratios ? ` · per-file median tests ratio: ${ratios}` : ''}`, '');
  L.push('| DOM | valid | wall | critical file | environment | import | setup | transform | worker | tests | tests (common) | excl. heavy | peak RSS MiB | failed tests / files |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  const rows = [...Object.entries(g.doms).map(([k, v]) => [k, v]), ...Object.entries(summary.ablations[m] ?? {}).map(([k, v]) => [`oxidom ${k}`, v])];
  for (const [k, r] of rows) {
    const valid = `${r.valid}/${r.runs}${r.invalid ? ' **INVALID**' : ''}${r.loaded ? ' !' : ''}`;
    const crit = r.criticalFile !== null ? `${Math.round(r.criticalFile)} (${path.basename(r.criticalName ?? '')})` : 'n/a';
    L.push(`| ${k} | ${valid} | ${fmtS(r.wall)} | ${crit} | ${fmtS(r.environment)} | ${fmtS(r.import)} | ${fmtS(r.setup)} | ${fmtS(r.transform)} | ${fmtS(r.worker)} | ${fmtS(r.tests)} | ${fmtS(r.testsCommon)} | ${fmtS(r.testsNoHeavy)} | ${fmtS(r.maxRssMiB)} | ${[...new Set(r.failedTests)].join(',')} / ${[...new Set(r.failedFiles)].join(',')} |`);
  }
  L.push('');
}
if (Object.values(summary.best).some(Boolean)) {
  L.push('## Best available config per DOM (wall, same worker count)', '');
  L.push(`Candidates: ${BEST_CANDIDATES.filter((m) => summary.matrix[m]).join(', ')} (vmThreads: jsdom / happy-dom only; oxidom cannot run it). Quote "oxidom default vs competitor best" from here.`, '');
  L.push('| DOM | best entry | wall |', '|---|---|---:|');
  for (const [dom, b] of Object.entries(summary.best)) L.push(`| ${dom} | ${b ? b.matrix : 'n/a'} | ${b ? fmtS(b.wall) : 'n/a'} |`);
  L.push('');
}
const first = summary.perFile['forks-1'] ? 'forks-1' : Object.keys(summary.perFile)[0];
if (first) {
  L.push(`## Per-file median test time (${first}: ${MATRIX[first].label})`, '');
  L.push(`| file | ${DOMS.map((d) => `${d} tests`).join(' | ')} | ${DOMS.map((d) => `${d} env`).join(' | ')} |`);
  L.push(`|---|${DOMS.map(() => '---:').join('|')}|${DOMS.map(() => '---:').join('|')}|`);
  for (const [file, v] of Object.entries(summary.perFile[first]).sort()) {
    const cell = (d, k) => (v[d] ? `${v[d][k]}${v[d].state !== 'passed' ? ' (FAIL)' : ''}` : '');
    L.push(`| ${file}${file.includes('heavy') ? ' **(heavy)**' : ''} | ${DOMS.map((d) => cell(d, 'tests')).join(' | ')} | ${DOMS.map((d) => (v[d] ? v[d].environment : '')).join(' | ')} |`);
  }
  L.push('');
}
if (counters) {
  L.push('## Native crossings (counters build, forks + isolate, one run)', '');
  L.push(`exit ${counters.status}; enabled=${counters.enabled}; total ${counters.totalCalls} native calls, ${counters.totalMs} ms inside natives (incl. ~20 ns timer overhead per call)`, '');
  L.push('| file | calls | ms in natives |', '|---|---:|---:|');
  for (const f of counters.files) L.push(`| ${f.file} | ${f.calls} | ${f.ms} |`);
  L.push('', '| top natives by time | calls | ms | ns/call |', '|---|---:|---:|---:|');
  for (const t of counters.top) L.push(`| ${t.fn} | ${t.calls} | ${t.ms} | ${t.nsPerCall} |`);
  L.push('');
}
const md = L.join('\n');
process.stdout.write(md + '\n');
if (flag('write')) {
  fs.writeFileSync(path.join(rawDir, `e2e-${stamp}.json`), JSON.stringify(raw));
  fs.writeFileSync(path.join(resultsDir, 'e2e.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(resultsDir, 'e2e.md'), md + '\n');
  process.stderr.write(`[e2e] wrote bench/results/e2e.{json,md} and raw/e2e-${stamp}.json\n`);
}
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(compileCacheDir, { recursive: true, force: true });
