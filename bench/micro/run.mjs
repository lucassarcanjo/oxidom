// Micro benchmark runner (ROADMAP M8, revised after the M9 fairness review).
//
// - Every case x DOM runs in PROCS fresh Node processes (--procs=, default 5), INTERLEAVED round-robin across
//   DOMs (process p of every DOM before process p+1 of any; DOM order rotated per round), so variance
//   between processes, often larger than within one, is measured instead of hidden.
// - Inside a process each metric is warmed up, its iteration count calibrated to ~OXIDOM_BENCH_TARGET_MS
//   (default 100 ms) per sample, then the median of OXIDOM_BENCH_SAMPLES (default 7) samples is that
//   process's value. Reported: the median of the process medians, and the min-max range across processes.
// - "oxidom vs best other" prints a ratio only when the two process ranges do not overlap ("~parity"
//   otherwise); byte metrics print "x less" / "x more".
// - The 1-minute load average is recorded around every process; values measured above OXIDOM_BENCH_MAX_LOAD
//   are marked with `!`.
// - Children get a clean environment: OXIDOM_NATIVE is removed unless --native=<addon> is given; ablation
//   switches pass through. Provenance (git rev, dirty flag, addon sha256 + build profile, package versions)
//   goes into meta; --merge refuses to splice results of a different rev / addon.
// - `process: true` cases (env, env-vitest) take one sample per process: 1 discarded warm-up process, then
//   max(SAMPLES, PROCS) processes per DOM, interleaved the same way.
//
//   node --expose-gc bench/micro/run.mjs [--cases=mutate,attr] [--doms=jsdom,oxidom] [--procs=5] [--write]
//   OXIDOM_SHARED=0 | OXIDOM_NO_MEMO=1 | OXIDOM_NO_PREFILTER=1 node bench/micro/run.mjs --write   (ablations)
//
// --merge (with --write): re-run only --cases and splice them into the stored results (same build only).
// --write stores bench/results/micro[-<ablation>].json (every sample) and .md (table). Cases whose API is
// missing on this branch report n/a with the reason.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES, TARGET_NS, median, spread, NA, here, oxidomRoot } from './lib.mjs';
import { provenance, mergeConflict, cleanEnv, load1, MAX_LOAD } from '../provenance.mjs';

const self = fileURLToPath(import.meta.url);
const ALL_DOMS = ['jsdom', 'happy-dom', 'oxidom'];

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a === undefined ? def : a.slice(name.length + 3);
}

// ---------------------------------------------------------------------------------------------- child

async function child(caseName, kind) {
  const { cases, windowFor, getSink } = await import('./cases.mjs');
  const c = cases[caseName];
  const metrics = {};
  const record = (name, unit, r) => {
    if (typeof r === 'number') metrics[name] = { unit, value: r };
    else metrics[name] = { unit, value: r.value, spread: spread(r.samples), samples: r.samples, iters: r.iters };
  };
  const fail = (name, unit, e) => {
    metrics[name] = { unit, na: e instanceof NA ? e.message : `error: ${String(e?.message ?? e).split('\n')[0]}` };
  };
  const metric = (name, unit, fn) => {
    try {
      record(name, unit, fn());
    } catch (e) {
      fail(name, unit, e);
    }
  };
  const metricAsync = async (name, unit, fn) => {
    try {
      record(name, unit, await fn());
    } catch (e) {
      fail(name, unit, e);
    }
  };
  let w = null;
  let teardown = null;
  try {
    if (c.global) {
      const { installGlobalEnv } = await import('./lib.mjs');
      ({ teardown } = await installGlobalEnv(kind));
      w = globalThis;
    } else if (!c.process) {
      w = windowFor(kind);
    }
    await c.run({ metric, metricAsync, w, kind });
  } catch (e) {
    const where = e?.stack?.split('\n').find((l) => l.includes('cases.mjs'))?.trim() ?? '';
    metrics['(case)'] = { unit: '', na: e instanceof NA ? e.message : `error: ${String(e?.message ?? e).split('\n')[0]} ${where}` };
  }
  if (teardown) await teardown();
  process.stdout.write(`\n@@RESULT ${JSON.stringify({ metrics, sink: getSink() })}\n`);
  // jsdom/happy-dom keep timers alive; the parent only needs the result line.
  process.exit(0);
}

const NATIVE = arg('native', null);
/** Ablation switches and harness knobs that may reach the children; everything else OXIDOM_* is dropped. */
const KEEP = ['OXIDOM_SHARED', 'OXIDOM_NO_MEMO', 'OXIDOM_NO_PREFILTER', 'OXIDOM_BENCH_SAMPLES', 'OXIDOM_BENCH_TARGET_MS'];

function spawnCase(caseName, kind, gc) {
  const args = [...(gc ? ['--expose-gc'] : []), self, '--child', caseName, kind];
  const env = cleanEnv(NATIVE ? { OXIDOM_NATIVE: path.resolve(NATIVE) } : {}, KEEP);
  const loadBefore = load1();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 900_000, env, maxBuffer: 64 << 20 });
  const load = [loadBefore, load1()];
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('@@RESULT '));
  if (line === undefined) {
    const why = (r.stderr || r.stdout || `exit ${r.status} signal ${r.signal}`).trim().split('\n').slice(-3).join(' | ');
    return { metrics: { '(case)': { unit: '', na: `process failed: ${why}` } }, load };
  }
  return { metrics: JSON.parse(line.slice('@@RESULT '.length)).metrics, load };
}

/**
 * Aggregates the per-process results of one case x DOM: per metric, the median of the process medians and
 * the min-max across processes (`runs` keeps every process: value, in-process samples, load).
 */
function aggregate(runs) {
  const out = {};
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))];
  for (const m of names) {
    const ok = runs.filter((r) => r.metrics[m] && r.metrics[m].na === undefined);
    if (ok.length === 0) {
      out[m] = runs.map((r) => r.metrics[m]).find(Boolean);
      continue;
    }
    const vals = ok.map((r) => r.metrics[m].value);
    out[m] = {
      unit: ok[0].metrics[m].unit,
      value: median(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
      procs: vals.length,
      failedProcs: runs.length - ok.length,
      loaded: ok.filter((r) => Math.max(...r.load) > MAX_LOAD).length,
      runs: ok.map((r) => ({ value: r.metrics[m].value, spread: r.metrics[m].spread, iters: r.metrics[m].iters, samples: r.metrics[m].samples, load: r.load })),
    };
  }
  return out;
}

// --------------------------------------------------------------------------------------------- parent

function num(v) {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
}

function fmt(m) {
  if (m === undefined) return '';
  if (m.na !== undefined) return 'n/a';
  const range = m.min !== undefined && m.max - m.min > 0.1 * Math.abs(m.value) ? ` (${num(m.min)}-${num(m.max)})` : '';
  return `${num(m.value)}${range}${m.loaded ? ' !' : ''}`;
}

/**
 * oxidom vs the best other DOM: a ratio only when the process ranges do not overlap, else "~parity".
 * Byte units compare as "x less" / "x more"; units ending in `-nc` (not comparable across DOMs) print no ratio.
 */
function ratio(results, name, doms) {
  const r = results.oxidom?.[name];
  if (r?.unit?.endsWith('-nc')) return 'not comparable';
  if (!r || r.na !== undefined) return '';
  const others = doms.filter((k) => k !== 'oxidom').map((k) => results[k]?.[name]).filter((m) => m && m.na === undefined);
  if (others.length === 0) return '';
  const best = others.reduce((a, b) => (b.value < a.value ? b : a));
  if (r.value <= 0 || best.value <= 0) return '';
  const [rlo, rhi, blo, bhi] = [r.min ?? r.value, r.max ?? r.value, best.min ?? best.value, best.max ?? best.value];
  if (!(rhi < blo || rlo > bhi)) return '~parity (ranges overlap)';
  const x = best.value / r.value;
  const bytes = r.unit === 'bytes';
  const f = (y) => y.toFixed(y >= 10 ? 0 : 1);
  if (x >= 1) return `${f(x)}x ${bytes ? 'less' : 'faster'}`;
  return `${f(1 / x)}x ${bytes ? 'more' : 'slower'}`;
}

async function parent() {
  const { cases } = await import('./cases.mjs');
  const names = arg('cases', Object.keys(cases).join(',')).split(',').filter(Boolean);
  const doms = arg('doms', ALL_DOMS.join(',')).split(',').filter(Boolean);
  for (const n of names) if (!cases[n]) throw new Error(`unknown case ${n}; known: ${Object.keys(cases).join(', ')}`);
  const suffix = process.env.OXIDOM_SHARED === '0' ? '-fallback'
    : process.env.OXIDOM_NO_MEMO === '1' && process.env.OXIDOM_NO_PREFILTER === '1' ? '-nomemo-noprefilter'
      : process.env.OXIDOM_NO_MEMO === '1' ? '-nomemo' : process.env.OXIDOM_NO_PREFILTER === '1' ? '-noprefilter' : '';
  const PROCS = Math.max(1, Number(arg('procs', 5)));
  const out = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      cpu: `${os.cpus()[0]?.model ?? '?'} x${os.cpus().length}`,
      samples: SAMPLES,
      procs: PROCS,
      targetMsPerSample: TARGET_NS / 1e6,
      maxLoad: MAX_LOAD,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.includes(k))),
      provenance: provenance({ native: NATIVE }),
      note: 'ns/us/ms per operation (lower is better); bytes for mem. Value = median over processes of the per-process median of samples; (a-b) = min-max across processes when > 10%; ! = measured above the load threshold.',
    },
    cases: {},
  };
  if (out.meta.provenance.addon.build && !out.meta.provenance.addon.build.startsWith('release')) {
    process.stderr.write(`[micro] WARNING: addon build is "${out.meta.provenance.addon.build}", not a plain release build\n`);
  }
  let rot = 0;
  for (const name of names) {
    const c = cases[name];
    const runs = Object.fromEntries(doms.map((k) => [k, []]));
    const warm = c.process ? 1 : 0;
    const procs = c.process ? Math.max(SAMPLES, PROCS) : PROCS;
    for (let p = 0; p < warm + procs; p++) {
      const order = doms.map((_, i) => doms[(i + rot) % doms.length]);
      rot++;
      for (const kind of order) {
        process.stderr.write(`[micro] ${name} / ${kind} ${p < warm ? 'warm-up' : `process ${p - warm + 1}/${procs}`}\n`);
        const r = spawnCase(name, kind, !c.process);
        if (p >= warm) runs[kind].push(r);
      }
    }
    const res = {};
    for (const kind of doms) res[kind] = aggregate(runs[kind]);
    out.cases[name] = { row: c.row, results: res, date: out.meta.date };
  }

  // --merge: re-run some cases and splice them into the stored results (other cases keep their numbers).
  const jsonPath = path.join(oxidomRoot, 'bench/results', `micro${suffix}.json`);
  if (process.argv.includes('--merge') && fs.existsSync(jsonPath)) {
    const old = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const why = mergeConflict(old.meta.provenance, out.meta.provenance);
    if (why) throw new Error(`--merge refused: ${why}. Re-run every case on this build instead.`);
    const merged = {};
    for (const n of Object.keys(cases)) {
      const v = out.cases[n] ?? old.cases[n];
      if (v) merged[n] = { date: old.meta.date, ...v };
    }
    out.meta.merged = `cases ${names.join(', ')} re-run on ${out.meta.date}; others from ${old.meta.date} (same rev and addon)`;
    out.cases = merged;
  }
  const doms2 = [...new Set([...doms, ...Object.values(out.cases).flatMap((c) => Object.keys(c.results))])];
  doms.splice(0, doms.length, ...ALL_DOMS.filter((d) => doms2.includes(d)));

  const lines = [];
  lines.push(`# oxidom micro benchmarks${suffix ? ` (${suffix.slice(1)})` : ''}`, '');
  const pv = out.meta.provenance;
  lines.push(`${out.meta.date} · Node ${out.meta.node} · ${out.meta.cpu} · ${PROCS} processes per case and DOM (interleaved), median of ${SAMPLES} samples of ~${TARGET_NS / 1e6} ms each per process`
    + ` · git ${pv.gitRev?.slice(0, 10)}${pv.gitDirty ? '-dirty' : ''} · addon ${pv.addon.build} ${pv.addon.sha256?.slice(0, 12)}`
    + ` · jsdom ${pv.versions.jsdom} · happy-dom ${pv.versions['happy-dom']} · vitest ${pv.versions.vitest}`
    + `${Object.keys(out.meta.env).length ? ` · ${Object.entries(out.meta.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`
    + `${out.meta.merged ? ` · ${out.meta.merged}` : ''}`, '');
  lines.push(`| case (DESIGN §13 row) | metric | unit | ${doms.join(' | ')} | oxidom vs best other |`);
  lines.push(`|---|---|---|${doms.map(() => '---:').join('|')}|---|`);
  const nas = [];
  for (const [name, { row, results }] of Object.entries(out.cases)) {
    let metricNames = [...new Set(doms.flatMap((k) => Object.keys(results[k] ?? {})))];
    // A whole-case n/a shows on the metric rows of the DOMs that ran (one reason line).
    if (metricNames.length > 1) metricNames = metricNames.filter((m) => m !== '(case)');
    const cell = (k, m) => results[k]?.[m] ?? results[k]?.['(case)'];
    for (const m of metricNames) {
      const unit = doms.map((k) => results[k]?.[m]?.unit).find(Boolean) ?? '';
      lines.push(`| ${name} (${row}) | ${m} | ${unit} | ${doms.map((k) => fmt(cell(k, m))).join(' | ')} | ${ratio(results, m, doms)} |`);
      for (const k of doms) if (results[k]?.[m]?.na !== undefined) nas.push(`- ${name} / ${m} / ${k}: ${results[k][m].na}`);
    }
    for (const k of doms) if (results[k]?.['(case)']?.na !== undefined && metricNames[0] !== '(case)') nas.push(`- ${name} / ${k}: ${results[k]['(case)'].na}`);
  }
  lines.push('', 'Value = median over processes of each process\'s median; (a-b) = min-max across processes when wider than 10%; '
    + '`!` = at least one process ran above the load threshold (re-run on an idle machine). A ratio is printed only when the process '
    + 'ranges of oxidom and the best other DOM do not overlap. oxidom never reclaims nodes inside an env: mutate / deep / parse rows '
    + 'exclude the freeing work GC-based DOMs pay; see the mem `churn` row for the memory side of that trade-off.');
  if (nas.length) lines.push('', '**n/a reasons**', '', ...nas);
  const md = lines.join('\n') + '\n';
  process.stdout.write(md);
  if (process.argv.includes('--write')) {
    const dir = path.join(oxidomRoot, 'bench/results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `micro${suffix}.json`), JSON.stringify(out, null, 1) + '\n');
    fs.writeFileSync(path.join(dir, `micro${suffix}.md`), md);
    process.stderr.write(`[micro] wrote bench/results/micro${suffix}.{json,md}\n`);
  }
}

void here;
const ci = process.argv.indexOf('--child');
if (ci >= 0) await child(process.argv[ci + 1], process.argv[ci + 2]);
else await parent();
