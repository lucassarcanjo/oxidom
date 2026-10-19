// The parity suite: jsdom's own test suite (WPT as jsdom runs it, jsdom's to-upstream WPT tests, its legacy mocha
// tests and its API tests) run against rsdom, gated by checked-in expectations. README.md has the workflow.
//
//   node conformance/parity/run.mjs [patterns...] [options]
//
//   patterns          `[source:]text`: substring of a test id, or a glob when it contains `*`
//                     (e.g. dom/traversal, legacy:node-iterator, 'wpt:dom/nodes/Node-*')
//   --source a,b      only these sources (wpt, tuwpt, legacy, api; default all)
//   --item <id>       only the tests of a roadmap item (roadmap.yaml), e.g. --item traversal
//   --dom jsdom       run jsdom against the oracle instead of rsdom against the expectations
//   --update          rewrite the expectations (or, with --dom jsdom, the oracle) for the files that ran, then
//                     regenerate results/summary.md; a run over a whole source also drops stale entries
//   --all             also run files expected to time out, and flaky or skipped files (reported, never gating)
//   --allow-progress  exit 0 when tests pass that are expected to fail (default: fail, so progress is locked in)
//   --concurrency N   parallel processes (default: available parallelism)
//   --print <id>      run one test file and print the raw result as JSON; `<source>:<id>` picks the source
//                     when two share the id (a few to-upstream ids are also WPT ids)
//
// Exit code 1 on any regression (or, without --allow-progress, unexpected pass). Raw results of the run go to
// results/raw/<dom>.jsonl (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import {
  SOURCES, RESULTS, SKIPPED_BY_DEFAULT, listTests, summarize, compare, entryFromResult, loadExpectations,
  saveExpectations, loadOracle, saveOracle, oracleFromResult, oracleAsExpectations, makeFilter, splitSource,
  loadRoadmap,
} from './lib.mjs';
import { writeReport } from './report.mjs';

const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const patterns = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (['--source', '--item', '--dom', '--concurrency', '--print'].includes(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    opts[a.slice(2)] = v;
  } else if (a.startsWith('--')) flags.add(a.slice(2));
  else patterns.push(a);
}
const dom = opts.dom ?? 'rsdom';
if (!['rsdom', 'jsdom'].includes(dom)) throw new Error(`--dom must be rsdom or jsdom, not ${dom}`);
const update = flags.has('update');
const sources = (opts.source ?? Object.keys(SOURCES).join(',')).split(',');
for (const s of sources) if (!SOURCES[s]) throw new Error(`unknown source ${s} (expected ${Object.keys(SOURCES).join(', ')})`);
const concurrency = Number(opts.concurrency ?? os.availableParallelism());
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a positive integer, not ${opts.concurrency}`);
const WPT_TIMEOUT_MS = Number(process.env.WPT_TIMEOUT_MS ?? 10_000);
// generous: the webstorage quota files take ~32 s on an idle 4-core machine
const HARD_KILL_MS = { wpt: WPT_TIMEOUT_MS + 50_000, tuwpt: WPT_TIMEOUT_MS + 50_000, legacy: 180_000, api: 180_000 };
const compileCache = process.env.NODE_COMPILE_CACHE ?? path.join(os.tmpdir(), 'rsdom-parity-compile-cache');

function runJob(source, test) {
  return new Promise((resolve) => {
    const child = fork(SOURCES[source].worker, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, NODE_COMPILE_CACHE: compileCache, NODE_NO_WARNINGS: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-2000);
    });
    let result = null;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, HARD_KILL_MS[source]);
    child.on('message', (m) => {
      result = m;
    });
    // 'close', not 'exit': 'exit' can arrive before the child's last IPC message (a large result then looks
    // like a crash); 'close' waits for the IPC channel too.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      result ??= {
        id: test.id,
        dom,
        harness: {
          status: killed ? 'KILLED' : 'CRASH',
          message: killed ? `no result after ${HARD_KILL_MS[source]} ms` : `exit code ${code} signal ${signal}: ${stderr.slice(-600)}`,
        },
        subtests: [],
      };
      resolve(result);
    });
    child.send({ dom, test });
  });
}

// ------------------------------------------------------------------------------------------- --print
if (opts.print) {
  const { source, text: id } = splitSource(opts.print);
  const where = source ? [source] : sources;
  const found = where.flatMap((s) => listTests(s).filter((x) => x.id === id).map((t) => ({ s, t })));
  if (!found.length) throw new Error(`no test ${id} in ${where.join(', ')}`);
  if (found.length > 1) console.error(`parity: ${id} is in ${found.map((f) => f.s).join(' and ')}; running ${found[0].s} (--print ${found[1].s}:${id} for the other)`);
  fs.writeSync(1, JSON.stringify(await runJob(found[0].s, found[0].t), null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------- run
const roadmap = opts.item ? loadRoadmap() : null;
const item = roadmap?.find((it) => it.id === opts.item);
if (opts.item && !item) throw new Error(`unknown roadmap item ${opts.item} (roadmap.yaml ids: ${roadmap.map((it) => it.id).join(', ')})`);
const filter = makeFilter(patterns);
const plan = [];
const state = {};
for (const source of sources) {
  const tests = listTests(source).filter((t) => filter(source, t.id) && (!item || item.match(source, t.id)));
  const oracle = loadOracle(source);
  const exps = dom === 'jsdom' ? oracleAsExpectations(oracle) : loadExpectations(source);
  const skipped = [];
  for (const t of tests) {
    const e = exps.get(t.id);
    if (e && !e.subtests && SKIPPED_BY_DEFAULT.has(e.status) && !flags.has('all')) skipped.push(t.id);
    else plan.push({ source, test: t });
  }
  state[source] = { tests, oracle, exps, skipped, results: new Map(), counts: { ok: 0, regression: 0, progress: 0, changed: 0 } };
}
if (!plan.length) {
  console.log('parity: no test matches');
  process.exit(patterns.length || item ? 1 : 0);
}

console.log(`parity (${dom}): ${plan.length} files from ${sources.join(', ')}` +
  `${Object.values(state).some((s) => s.skipped.length) ? `, ${Object.values(state).reduce((a, s) => a + s.skipped.length, 0)} skipped (timeout/flaky/skip; --all runs them)` : ''}` +
  `, ${concurrency} at a time`);

fs.mkdirSync(path.join(RESULTS, 'raw'), { recursive: true });
const rawOut = fs.openSync(path.join(RESULTS, 'raw', `${dom}.jsonl`), 'w');
const t0 = Date.now();
let next = 0;
let finished = 0;
let lastTick = Date.now();
const SIGN = { regression: 'REGRESSION', progress: 'PROGRESS  ', changed: 'changed   ' };
async function lane() {
  while (next < plan.length) {
    const { source, test } = plan[next++];
    const r = await runJob(source, test);
    fs.writeSync(rawOut, JSON.stringify({ source, ...r }) + '\n');
    const st = state[source];
    const sum = summarize(r);
    st.results.set(test.id, sum);
    const { verdict, notes } = compare(sum, st.exps.get(test.id), st.oracle.get(test.id));
    st.counts[verdict]++;
    finished++;
    if (verdict !== 'ok') console.log(`${SIGN[verdict]} ${source}:${test.id}\n${notes.map((n) => '    ' + n).join('\n')}`);
    else if (process.stdout.isTTY === false && Date.now() - lastTick > 30_000) {
      lastTick = Date.now();
      console.log(`  ... ${finished}/${plan.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, lane));
fs.closeSync(rawOut);

// ------------------------------------------------------------------------------------------ summary
let regressions = 0;
let progress = 0;
for (const source of sources) {
  const st = state[source];
  if (!st.results.size && !st.skipped.length) continue;
  const c = st.counts;
  regressions += c.regression;
  progress += c.progress;
  console.log(`${source.padEnd(6)} ${String(st.results.size).padStart(5)} files: ${c.ok} as expected, ${c.regression} regressed, ${c.progress} progressed, ${c.changed} changed` +
    (st.skipped.length ? `; ${st.skipped.length} skipped` : ''));
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ------------------------------------------------------------------------------------------- update
if (update) {
  for (const source of sources) {
    const st = state[source];
    if (!st.results.size) continue;
    const whole = !patterns.length && !item;
    const ids = new Set(st.tests.map((t) => t.id));
    if (dom === 'jsdom') {
      const oracle = whole ? new Map() : st.oracle;
      for (const [id, sum] of st.results) oracle.set(id, oracleFromResult(sum));
      if (whole) for (const id of st.skipped) oracle.set(id, st.oracle.get(id));
      saveOracle(source, oracle);
    } else {
      const exps = st.exps;
      for (const [id, sum] of st.results) {
        const e = entryFromResult(sum, exps.get(id), st.oracle.get(id));
        if (e) exps.set(id, e);
        else exps.delete(id);
      }
      if (whole) for (const id of [...exps.keys()]) if (!ids.has(id)) exps.delete(id);
      saveExpectations(source, exps);
    }
    console.log(`updated ${dom === 'jsdom' ? 'oracle' : 'expectations'}/${source}.${dom === 'jsdom' ? 'json' : 'yaml'}`);
  }
  writeReport();
  console.log('updated results/summary.md');
  process.exit(0);
}
if (regressions || (progress && !flags.has('allow-progress'))) {
  if (progress) console.log(`\n${progress} file(s) pass more than expected: lock it in with\n  npm run test:parity -- --update ${process.argv.slice(2).filter((a) => a !== '--allow-progress').join(' ')}`);
  if (regressions) console.log(`\n${regressions} file(s) regressed.`);
  process.exit(1);
}
