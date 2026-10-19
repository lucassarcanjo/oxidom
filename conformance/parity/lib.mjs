// Shared pieces of the parity suite (conformance/parity, README.md there): the four test sources taken from
// jsdom's own test suite, the expectations files (rsdom's known failures, a ratchet) and the jsdom oracle
// (what jsdom itself passes in the same harness), and the comparison of a run against them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cause, short, RESULTS as WPT_RESULTS, WPT_ROOT, WPT_COMMIT } from '../wpt/lib.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const RESULTS = path.join(HERE, 'results');
export const JSDOM_TEST = path.join(REPO, 'refs/jsdom/test');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/** Test sources, in report order. `worker` is the script that runs one test file in a fresh process. */
export const SOURCES = {
  wpt: { title: 'web-platform-tests (the DIRs jsdom runs)', worker: path.join(REPO, 'conformance/wpt/worker.mjs') },
  tuwpt: { title: "jsdom's WPT-format tests (to-upstream)", worker: path.join(REPO, 'conformance/wpt/worker.mjs') },
  legacy: { title: "jsdom's legacy mocha tests (to-port-to-wpts)", worker: path.join(HERE, 'mocha/worker.cjs') },
  api: { title: "jsdom's API tests (test/api)", worker: path.join(HERE, 'mocha/worker.cjs') },
};

// ------------------------------------------------------------------------------------------------ tests

function selection() {
  const f = path.join(WPT_RESULTS, 'selection.json');
  let sel = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  if (!sel || sel.wptCommit !== WPT_COMMIT || !sel.toUpstream) {
    if (!fs.existsSync(path.join(WPT_ROOT, 'resources/testharness.js'))) {
      throw new Error(`parity: no WPT checkout at ${WPT_ROOT}; run scripts/fetch-refs.sh --wpt (see conformance/parity/README.md)`);
    }
    execFileSync(process.execPath, [path.join(REPO, 'conformance/wpt/select.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
    sel = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return sel;
}

/** Test files of one source: [{ id, file, ... }] (WPT records come from conformance/wpt/results/selection.json). */
export function listTests(source) {
  if (!fs.existsSync(JSDOM_TEST)) throw new Error('parity: refs/jsdom is missing; run scripts/fetch-refs.sh');
  if (source === 'wpt') return selection().tests;
  if (source === 'tuwpt') return selection().toUpstream.tests;
  const dirs = source === 'api' ? ['api'] : ['to-port-to-wpts', 'to-port-to-wpts/level1', 'to-port-to-wpts/level2', 'to-port-to-wpts/level3'];
  const out = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(JSDOM_TEST, d)).sort()) {
      if (f.endsWith('.js')) out.push({ id: `${d}/${f}`, file: `${d}/${f}` });
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------- run results

const TIMEOUT_STATUSES = new Set(['TIMEOUT', 'NO_COMPLETION']);
const CRASH_STATUSES = new Set(['CRASH', 'KILLED']);

/**
 * Normalises one worker result: { harnessOk, status, message, pass, failing: Map(name -> message) }.
 * Every non-PASS subtest counts as failing, except mocha's SKIP (a test the file itself skips), which counts
 * as neither.
 */
export function summarize(r) {
  const failing = new Map();
  let pass = 0;
  for (const s of r.subtests) {
    if (s.status === 'PASS') pass++;
    else if (s.status !== 'SKIP') failing.set(s.name, `${s.status === 'FAIL' ? '' : s.status + ': '}${s.message ?? ''}`);
  }
  return { harnessOk: r.harness.status === 'OK', status: r.harness.status, message: r.harness.message ?? '', pass, failing };
}

/** The expectation status a non-passing run maps to. */
function fileStatus(sum) {
  if (TIMEOUT_STATUSES.has(sum.status)) return 'timeout';
  if (CRASH_STATUSES.has(sum.status)) return 'crash';
  return 'fail';
}

/** Expectation reason for a failure message (mocha messages end with " | at <frame>", which is dropped). */
const reasonOf = (msg) => cause(String(msg).replace(/ \| at .*$/, ''));

function mostCommonCause(failing) {
  const n = new Map();
  for (const m of failing.values()) {
    const c = reasonOf(m);
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [c, k] of n) if (k > bestN) [best, bestN] = [c, k];
  return best;
}

// ------------------------------------------------------------------------------------ expectations

/** Expectation statuses. The first three come from a run; `flaky` and `skip` are set by hand. */
export const STATUSES = ['fail', 'timeout', 'crash', 'flaky', 'skip'];
/** Not run unless `--all`: harness timeouts cost 10 s each, flaky files never gate. */
export const SKIPPED_BY_DEFAULT = new Set(['timeout', 'flaky', 'skip']);
/** A file with more failing subtests than this gets one file-level entry with a passing-count floor. */
export const SUBTEST_LIMIT = 50;

export function expectationsFile(source) {
  return path.join(HERE, 'expectations', `${source}.yaml`);
}

/**
 * Reads expectations/<source>.yaml: Map(id -> entry), entry = { status, reason, pass } (file level; `pass` is
 * the number of subtests that must keep passing) or { subtests: Map(name -> reason) } (exactly these fail).
 */
export function loadExpectations(source) {
  const f = expectationsFile(source);
  const map = new Map();
  if (!fs.existsSync(f)) return map;
  const doc = yaml.load(fs.readFileSync(f, 'utf8'), { filename: f }) ?? {};
  for (const [id, v] of Object.entries(doc)) {
    if (Array.isArray(v)) {
      const [status, reason = '', extra] = v;
      if (!STATUSES.includes(status)) throw new Error(`${f}: ${id}: unknown status "${status}" (expected one of ${STATUSES.join(', ')})`);
      map.set(id, { status, reason: String(reason), pass: extra?.pass ?? 0 });
    } else if (v && typeof v === 'object') {
      const subtests = new Map();
      for (const [name, sv] of Object.entries(v)) {
        if (!Array.isArray(sv) || sv[0] !== 'fail') throw new Error(`${f}: ${id}: subtest "${name}" must be [fail, reason]`);
        subtests.set(name, String(sv[1] ?? ''));
      }
      map.set(id, { subtests });
    } else {
      throw new Error(`${f}: ${id}: expected [status, reason] or a map of subtests`);
    }
  }
  return map;
}

const PLAIN_KEY = /^[\w][\w./+,@()-]*$/;
const key = (s) => (PLAIN_KEY.test(s) ? s : JSON.stringify(s));

export function saveExpectations(source, map) {
  const lines = [
    `# rsdom's expected failures in the parity suite: ${SOURCES[source].title}.`,
    '# Written by `npm run test:parity -- --update`; edit reasons by hand freely (an update keeps the reason of an',
    '# entry whose status does not change). Format and workflow: conformance/parity/README.md.',
    '',
  ];
  for (const id of [...map.keys()].sort()) {
    const e = map.get(id);
    if (e.subtests) {
      lines.push(`${key(id)}:`);
      for (const name of [...e.subtests.keys()].sort()) lines.push(`  ${JSON.stringify(name)}: [fail, ${JSON.stringify(e.subtests.get(name))}]`);
    } else {
      lines.push(`${key(id)}: [${e.status}, ${JSON.stringify(e.reason)}${e.pass ? `, {pass: ${e.pass}}` : ''}]`);
    }
  }
  fs.writeFileSync(expectationsFile(source), lines.join('\n') + '\n');
}

/**
 * The entry a run result calls for (null = everything passed). Reasons of `old` survive when the status does:
 * a file-level entry keeps its reason while it stays at that status, a subtest keeps its reason while it fails.
 */
export function entryFromResult(sum, old) {
  if (!sum.harnessOk) {
    const status = fileStatus(sum);
    const reason = old && old.status === status ? old.reason : `harness ${sum.status}: ${reasonOf(sum.message)}`;
    return { status, reason, pass: sum.pass };
  }
  if (sum.failing.size === 0) return null;
  if (sum.pass === 0 || sum.failing.size > SUBTEST_LIMIT) {
    const reason = old && old.status === 'fail' ? old.reason : mostCommonCause(sum.failing);
    return { status: 'fail', reason, pass: sum.pass };
  }
  const subtests = new Map();
  for (const [name, msg] of sum.failing) subtests.set(name, old?.subtests?.get(name) ?? reasonOf(msg));
  return { subtests };
}

/**
 * Compares a run with its expectation. verdict: 'ok' | 'regression' (something that was expected to pass
 * does not) | 'progress' (more passes than expected: lock it in with --update) | 'changed' (same passes,
 * different failure status; informational).
 */
export function compare(sum, exp) {
  const list = (names) => names.slice(0, 5).map((n) => `    - ${short(n, 120)}${sum.failing.has(n) ? `: ${short(sum.failing.get(n), 200)}` : ''}`);
  const harness = `harness ${sum.status}${sum.message ? ': ' + short(sum.message, 200) : ''}`;
  if (!exp) {
    if (!sum.harnessOk) return { verdict: 'regression', notes: [harness] };
    if (sum.failing.size) return { verdict: 'regression', notes: [`${sum.failing.size} subtest(s) fail`, ...list([...sum.failing.keys()])] };
    return { verdict: 'ok', notes: [] };
  }
  if (exp.subtests) {
    if (!sum.harnessOk) return { verdict: 'regression', notes: [harness] };
    const newly = [...sum.failing.keys()].filter((n) => !exp.subtests.has(n));
    const fixed = [...exp.subtests.keys()].filter((n) => !sum.failing.has(n));
    if (newly.length) {
      const notes = [`${newly.length} subtest(s) newly fail`, ...list(newly)];
      if (fixed.length) notes.push(`  (and ${fixed.length} expected failure(s) now pass)`);
      return { verdict: 'regression', notes };
    }
    if (fixed.length) return { verdict: 'progress', notes: [`${fixed.length} expected failure(s) now pass`, ...list(fixed)] };
    return { verdict: 'ok', notes: [] };
  }
  const floor = exp.pass ?? 0;
  if (sum.harnessOk && sum.failing.size === 0 && sum.pass > 0) return { verdict: 'progress', notes: ['now passes entirely'] };
  if (sum.pass < floor) {
    const notes = [`passing subtests dropped from ${floor} to ${sum.pass}`];
    if (!sum.harnessOk) notes.push('  ' + harness);
    return { verdict: 'regression', notes };
  }
  if (sum.pass > floor) return { verdict: 'progress', notes: [`passing subtests rose from ${floor} to ${sum.pass}`] };
  const st = sum.harnessOk ? 'fail' : fileStatus(sum);
  if (st !== exp.status && !(sum.harnessOk && sum.failing.size === 0)) return { verdict: 'changed', notes: [`now ${st} (expected ${exp.status})`] };
  return { verdict: 'ok', notes: [] };
}

// ------------------------------------------------------------------------------------------ oracle

export function oracleFile(source) {
  return path.join(HERE, 'oracle', `${source}.json`);
}

/**
 * jsdom's results in this harness: Map(id -> { status, pass, fail: [names], failCount }) for EVERY test file
 * (the denominator of the parity score). On disk each file is `[status, pass, fail]`, where `fail` lists the
 * failing subtests, or is just their count when jsdom passes none (the names then matter to nothing: such a
 * file adds 0 to the score). Regenerated with `--dom jsdom --update` when the jsdom or WPT pin moves.
 */
export function loadOracle(source) {
  const f = oracleFile(source);
  if (!fs.existsSync(f)) return new Map();
  return new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))).map(([id, [status, pass, fail]]) => [
    id,
    { status, pass, fail: Array.isArray(fail) ? fail : [], failCount: Array.isArray(fail) ? fail.length : fail },
  ]));
}

export function saveOracle(source, map) {
  const ids = [...map.keys()].sort();
  const body = ids.map((id) => {
    const o = map.get(id);
    const fail = o.pass === 0 ? o.failCount : [...o.fail].sort();
    return `${JSON.stringify(id)}: ${JSON.stringify([o.status, o.pass, fail])}`;
  });
  fs.writeFileSync(oracleFile(source), `{\n${body.join(',\n')}\n}\n`);
}

export function oracleFromResult(sum) {
  return { status: sum.status, pass: sum.pass, fail: [...sum.failing.keys()], failCount: sum.failing.size };
}

/** The oracle as expectations, so a jsdom run is checked with the same compare() (exact subtest lists). */
export function oracleAsExpectations(oracle) {
  const map = new Map();
  for (const [id, o] of oracle) {
    if (o.status === 'OK' && o.pass === 0) {
      if (o.failCount) map.set(id, { status: 'fail', reason: 'jsdom', pass: 0 });
    } else if (o.status === 'OK') {
      if (o.fail.length) map.set(id, { subtests: new Map(o.fail.map((n) => [n, 'jsdom'])) });
    } else {
      map.set(id, { status: fileStatus({ status: o.status }), reason: 'jsdom', pass: o.pass });
    }
  }
  return map;
}

// ------------------------------------------------------------------------------------- selection

/**
 * Test filter from CLI patterns. A pattern is `[source:]text`: text with `*` is a glob over the test id,
 * otherwise a substring of it. No patterns = everything.
 */
export function makeFilter(patterns) {
  if (!patterns.length) return () => true;
  const ps = patterns.map((p) => {
    const m = /^(wpt|tuwpt|legacy|api):(.*)$/.exec(p);
    return { source: m ? m[1] : null, text: m ? m[2] : p };
  });
  return (source, id) => ps.some((p) => (!p.source || p.source === source) && (p.text === '' || (p.text.includes('*') ? path.matchesGlob(id, p.text) : id.includes(p.text))));
}

/** Roadmap items (roadmap.yaml) with their test globs over `<source>:<id>` (a leading `!` excludes). */
export function loadRoadmap() {
  const items = yaml.load(fs.readFileSync(path.join(HERE, 'roadmap.yaml'), 'utf8'));
  for (const it of items) {
    it.tests ??= [];
    const include = it.tests.filter((g) => !g.startsWith('!'));
    const exclude = it.tests.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    it.match = (source, id) => {
      const key = `${source}:${id}`;
      return include.some((g) => path.matchesGlob(key, g)) && !exclude.some((g) => path.matchesGlob(key, g));
    };
  }
  return items;
}
