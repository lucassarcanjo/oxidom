// Step 2: run every selected WPT file against every DOM, each (file, DOM) pair in a FRESH child process
// (worker.mjs), at most --concurrency (default 2) processes at a time. Results are appended to
// results/raw/<dom>.jsonl as they arrive, so an interrupted run resumes where it stopped.
//
// Why one process per file: test pages declare top-level `let`/`const`/`class` bindings, and with
// vm.runInThisContext those live in the process's global lexical scope forever — a second page in the same
// process would throw "Identifier has already been declared". Vitest (isolate: true) likewise gives each test
// file a fresh worker. A crashed / hung child is recorded as CRASH / KILLED for that DOM only.
//
// Usage: node conformance/wpt/run.mjs [--doms jsdom,happy-dom,oxidom] [--filter <regex>] [--limit N]
//                                 [--concurrency 2] [--fresh]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fork } from 'node:child_process';
import { HERE, RESULTS, DOMS, readJSON } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? def : args[i + 1];
};
const doms = opt('doms', DOMS.join(',')).split(',');
const filter = opt('filter', null);
const limit = Number(opt('limit', Infinity));
const concurrency = Number(opt('concurrency', 2));
const fresh = args.includes('--fresh');
const TIMEOUT_MS = Number(process.env.WPT_TIMEOUT_MS ?? 10_000);
const HARD_KILL_MS = TIMEOUT_MS + 30_000; // env setup (jsdom ~1-3 s) + 10 s test + teardown, with slack

const sel = readJSON(path.join(RESULTS, 'selection.json'));
let tests = sel.tests;
if (filter) tests = tests.filter((t) => new RegExp(filter).test(t.id));
tests = tests.slice(0, limit);

const rawDir = path.join(RESULTS, 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const done = new Map(doms.map((d) => [d, new Set()]));
for (const d of doms) {
  const f = path.join(rawDir, `${d}.jsonl`);
  if (fresh) for (const x of [f, f + '.gz']) if (fs.existsSync(x)) fs.rmSync(x);
  // resume from the committed .gz: unpack it so new results append to the same file
  if (!fs.existsSync(f) && fs.existsSync(f + '.gz')) {
    fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(f + '.gz')));
    fs.rmSync(f + '.gz');
  }
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      done.get(d).add(JSON.parse(line).id);
    } catch {
      // torn last line from an interrupted run
    }
  }
}

const jobs = [];
for (const t of tests) for (const d of doms) if (!done.get(d).has(t.id)) jobs.push({ dom: d, test: t });
console.log(`${tests.length} files x ${doms.length} DOMs: ${jobs.length} jobs to run (${concurrency} at a time)`);

const compileCache = process.env.NODE_COMPILE_CACHE ?? path.join(os.tmpdir(), 'oxidom-wpt-compile-cache');
const out = Object.fromEntries(doms.map((d) => [d, fs.openSync(path.join(rawDir, `${d}.jsonl`), 'a')]));

function runJob({ dom, test }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = fork(path.join(HERE, 'worker.mjs'), [], {
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
    }, HARD_KILL_MS);
    child.on('message', (m) => {
      result = m;
    });
    // 'close', not 'exit': 'exit' can arrive before the child's last IPC message (a large result then looks
    // like a crash); 'close' waits for the IPC channel too.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (!result) {
        result = {
          id: test.id,
          dom,
          harness: {
            status: killed ? 'KILLED' : 'CRASH',
            message: killed ? `no result after ${HARD_KILL_MS} ms` : `exit code ${code} signal ${signal}: ${stderr.slice(-600)}`,
          },
          subtests: [],
          scriptErrors: [],
          notes: [],
        };
      }
      result.wallMs = Date.now() - t0;
      fs.writeSync(out[dom], JSON.stringify(result) + '\n');
      resolve(result);
    });
    child.send({ dom, test });
  });
}

let next = 0;
let finished = 0;
const tStart = Date.now();
async function lane() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await runJob(job);
    finished++;
    if (finished % 50 === 0 || finished === jobs.length || !['OK', 'ERROR', 'TIMEOUT'].includes(r.harness.status)) {
      const el = (Date.now() - tStart) / 1000;
      const eta = (el / finished) * (jobs.length - finished);
      console.log(`[${finished}/${jobs.length}] ${el.toFixed(0)}s eta ${(eta / 60).toFixed(1)}min  last: ${r.dom} ${r.id} ${r.harness.status}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, lane));
console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(0)} s`);
// keep the raw results small in the repo: <dom>.jsonl -> <dom>.jsonl.gz
for (const d of doms) {
  fs.closeSync(out[d]);
  const f = path.join(rawDir, `${d}.jsonl`);
  fs.writeFileSync(f + '.gz', zlib.gzipSync(fs.readFileSync(f), { level: 9 }));
  fs.rmSync(f);
}
