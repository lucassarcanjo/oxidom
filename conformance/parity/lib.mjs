// Shared pieces of the parity suite (conformance/parity, README.md there): the four test sources taken from
// jsdom's own test suite, the expectations files (oxidom's known failures, a ratchet) and the jsdom oracle
// (what jsdom itself passes in the same harness), and the comparison of a run against them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cause, short, RESULTS as WPT_RESULTS, WPT_ROOT, WPT_COMMIT, REFS } from '../wpt/lib.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const RESULTS = path.join(HERE, 'results');
export { REFS };
export const JSDOM_TEST = path.join(REFS, 'jsdom/test');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/** Test sources, in report order. `worker` is the script that runs one test file in a fresh process. */
export const SOURCES = {
  wpt: {
    // 67 of 127: INCLUDE in conformance/wpt/select.mjs (CSS layout, SVG, network and navigation DIRs are out)
    title: "web-platform-tests: the DIRs of jsdom's to-run.yaml relevant to a DOM environment (67 of 127)",
    worker: path.join(REPO, 'conformance/wpt/worker.mjs'),
  },
  tuwpt: { title: "jsdom's WPT-format tests (to-upstream)", worker: path.join(REPO, 'conformance/wpt/worker.mjs') },
  legacy: { title: "jsdom's legacy mocha tests (to-port-to-wpts)", worker: path.join(HERE, 'mocha/worker.cjs') },
  api: { title: "jsdom's API tests (test/api)", worker: path.join(HERE, 'mocha/worker.cjs') },
};

// ------------------------------------------------------------------------------------------------ tests

/**
 * selection.json is a gitignored cache: regenerated when the WPT commit moves or one of these is newer than it.
 * refs/jsdom's HEAD file changes on every checkout, so moving it to another tag (scripts/fetch-refs.sh) also
 * refreshes the to-upstream list even when to-run.yaml did not change.
 */
const SELECTION_INPUTS = [
  path.join(REPO, 'conformance/wpt/select.mjs'),
  path.join(REPO, 'conformance/wpt/lib.mjs'),
  path.join(JSDOM_TEST, 'web-platform-tests/to-run.yaml'),
  path.join(REFS, 'jsdom/.git/HEAD'),
];

function selection() {
  const f = path.join(WPT_RESULTS, 'selection.json');
  let sel = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const mtime = (p) => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (!sel || sel.wptCommit !== WPT_COMMIT || !sel.toUpstream || SELECTION_INPUTS.some((p) => mtime(p) > mtime(f))) {
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
  if (!fs.existsSync(JSDOM_TEST)) throw new Error(`parity: ${JSDOM_TEST} is missing; run scripts/fetch-refs.sh`);
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
 * Normalises one worker result: { harnessOk, status, message, pass, passing: Set(name), failing: Map(name ->
 * message) }. Every non-PASS subtest counts as failing, except mocha's SKIP (a test the file itself skips),
 * which counts as neither.
 */
export function summarize(r) {
  const passing = new Set();
  const failing = new Map();
  let pass = 0;
  for (const s of r.subtests) {
    if (s.status === 'PASS') {
      pass++;
      passing.add(s.name);
    } else if (s.status !== 'SKIP') failing.set(s.name, `${s.status === 'FAIL' ? '' : s.status + ': '}${s.message ?? ''}`);
  }
  return { harnessOk: r.harness.status === 'OK', status: r.harness.status, message: r.harness.message ?? '', pass, passing, failing };
}

/** The expectation status a non-passing run maps to. */
function fileStatus(sum) {
  if (TIMEOUT_STATUSES.has(sum.status)) return 'timeout';
  if (CRASH_STATUSES.has(sum.status)) return 'crash';
  return 'fail';
}

/**
 * A run whose subtests all pass still falls short when it ran none (no file completes that way on jsdom) or
 * fewer than jsdom passes: subtests vanished, and the score credits a file without an entry with jsdom's passes.
 */
const tooFew = (sum, oracle) => sum.pass === 0 || sum.pass < (oracle?.pass ?? 0);

/**
 * Fewest passes a subtest-list entry allows: jsdom's passes minus the listed failures jsdom passes. Fewer means
 * passing subtests stopped being reported (the score still credits them).
 */
function listFloor(subtests, oracle) {
  if (!oracle?.pass) return 0;
  const jsdomFails = new Set(oracle.fail);
  let expectedGap = 0;
  for (const name of subtests.keys()) if (!jsdomFails.has(name)) expectedGap++;
  return Math.max(0, oracle.pass - expectedGap);
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
/** Set by hand: never gate (`--all` runs such files for information) and survive `--update`. */
const BY_HAND = new Set(['flaky', 'skip']);
/** Not run unless `--all`: harness timeouts cost 10 s each, flaky and skip files never gate. */
export const SKIPPED_BY_DEFAULT = new Set(['timeout', 'flaky', 'skip']);
/** A file with more failing subtests than this gets one file-level entry with a passing-count floor. */
export const SUBTEST_LIMIT = 50;
/**
 * `fail-node:<N` (the syntax of jsdom's to-run.yaml), set by hand: a failure of the Node runtime rather than of
 * oxidom (Float16Array, TextDecoder encodings) that Node N fixed. It reads as `fail` below major N and as no entry
 * from N on, and `--update` writes it back as it is on any Node.
 */
const NODE_FAIL = /^fail-node:<(\d+)$/;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
/** The Node major the scoreboard reads `fail-node:<N` entries for, so it is the same on every Node (CI's). */
export const REFERENCE_NODE = 22;

export function expectationsFile(source) {
  return path.join(HERE, 'expectations', `${source}.yaml`);
}

/**
 * Reads expectations/<source>.yaml for Node `major`: Map(id -> entry), entry = { status, reason, pass } (file
 * level; `pass` is the number of subtests that must keep passing) or { subtests: Map(name -> reason) } (exactly
 * these fail). `map.byNode` keeps the `fail-node:<N` entries as written (id -> { file: [status, reason, extra] }
 * or { subtests: Map(name -> [status, reason]) }) for saveExpectations.
 */
export function loadExpectations(source, major = NODE_MAJOR) {
  const f = expectationsFile(source);
  const map = new Map();
  map.byNode = new Map();
  if (!fs.existsSync(f)) return map;
  const text = fs.readFileSync(f, 'utf8');
  // js-yaml throws on a document of comments only: a source with nothing expected to fail
  const doc = /^\s*(?:#.*)?$/.test(text.replace(/^\s*#.*$/gm, '')) ? {} : yaml.load(text, { filename: f }) ?? {};
  for (const [id, v] of Object.entries(doc)) {
    if (Array.isArray(v)) {
      const [status, reason = '', extra] = v;
      const node = NODE_FAIL.exec(status);
      if (node) map.byNode.set(id, { file: v });
      else if (!STATUSES.includes(status)) throw new Error(`${f}: ${id}: unknown status "${status}" (expected one of ${STATUSES.join(', ')}, or fail-node:<N)`);
      if (!node || major < Number(node[1])) map.set(id, { status: node ? 'fail' : status, reason: String(reason), pass: extra?.pass ?? 0 });
    } else if (v && typeof v === 'object') {
      const subtests = new Map();
      const byNode = new Map();
      for (const [name, sv] of Object.entries(v)) {
        const node = Array.isArray(sv) && NODE_FAIL.exec(sv[0]);
        if (!Array.isArray(sv) || (sv[0] !== 'fail' && !node)) throw new Error(`${f}: ${id}: subtest "${name}" must be [fail, reason] or [fail-node:<N, reason]`);
        if (node) byNode.set(name, sv);
        if (!node || major < Number(node[1])) subtests.set(name, String(sv[1] ?? ''));
      }
      if (byNode.size) map.byNode.set(id, { subtests: byNode });
      if (subtests.size) map.set(id, { subtests });
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
    `# oxidom's expected failures in the parity suite: ${SOURCES[source].title}.`,
    '# Written by `npm run test:parity -- --update`; edit reasons by hand freely (an update keeps the reason of an',
    '# entry whose status does not change). Format and workflow: conformance/parity/README.md.',
    '',
  ];
  const fileLine = (id, status, reason, pass) => `${key(id)}: [${status}, ${JSON.stringify(String(reason))}${pass ? `, {pass: ${pass}}` : ''}]`;
  const byNode = map.byNode ?? new Map();
  const ids = new Set([...map.keys(), ...byNode.keys()]);
  for (const id of [...ids].sort()) {
    const e = map.get(id);
    const b = byNode.get(id);
    // `fail-node:<N` entries go back as written: the run that updates may be on a Node where they do not apply
    if (b?.file) lines.push(fileLine(id, b.file[0], b.file[1] ?? '', b.file[2]?.pass));
    else if (e && !e.subtests) lines.push(fileLine(id, e.status, e.reason, e.pass));
    else {
      const subtests = new Map([...(e?.subtests ?? [])].map(([name, reason]) => [name, ['fail', reason]]));
      for (const [name, sv] of b?.subtests ?? []) subtests.set(name, sv);
      lines.push(`${key(id)}:`);
      for (const name of [...subtests.keys()].sort()) {
        const [status, reason = ''] = subtests.get(name);
        lines.push(`  ${JSON.stringify(name)}: [${status}, ${JSON.stringify(String(reason))}]`);
      }
    }
  }
  if (ids.size === 0) lines.push('{}');
  fs.writeFileSync(expectationsFile(source), lines.join('\n') + '\n');
}

/**
 * The entry a run result calls for (null = everything passed), given the old entry and jsdom's oracle entry.
 * Reasons of `old` survive when the status does: a file-level entry keeps its reason while it stays at that
 * status, a subtest keeps its reason while it fails. A `flaky` or `skip` entry is kept as it is.
 */
export function entryFromResult(sum, old, oracle) {
  if (old && !old.subtests && BY_HAND.has(old.status)) return old;
  if (!sum.harnessOk) {
    const status = fileStatus(sum);
    const reason = old && old.status === status ? old.reason : `harness ${sum.status}: ${reasonOf(sum.message)}`;
    return { status, reason, pass: sum.pass };
  }
  if (sum.failing.size === 0) {
    if (!tooFew(sum, oracle)) return null;
    return { status: 'fail', reason: old?.status === 'fail' ? old.reason : sum.pass ? 'fewer subtests than jsdom passes' : 'no subtests ran', pass: sum.pass };
  }
  if (sum.pass === 0 || sum.failing.size > SUBTEST_LIMIT) {
    const reason = old && old.status === 'fail' ? old.reason : mostCommonCause(sum.failing);
    return { status: 'fail', reason, pass: sum.pass };
  }
  const subtests = new Map();
  for (const [name, msg] of sum.failing) subtests.set(name, old?.subtests?.get(name) ?? reasonOf(msg));
  if (sum.pass < listFloor(subtests, oracle)) {
    // passing subtests went missing: a floor entry, so the gate and the next update agree
    return { status: 'fail', reason: old?.status === 'fail' ? old.reason : 'fewer subtests than jsdom passes', pass: sum.pass };
  }
  return { subtests };
}

/**
 * Compares a run with its expectation and, when given, jsdom's oracle entry for the file. verdict: 'ok' |
 * 'regression' (something that was expected to pass does not, or the file now crashes) | 'progress' (more
 * passes than expected, or expected failures no longer reported: lock it in with --update) | 'changed'
 * (informational: same passes with a different failure status, or how a flaky or skip file did).
 */
export function compare(sum, exp, oracle) {
  const list = (names) => names.slice(0, 5).map((n) => `    - ${short(n, 120)}${sum.failing.has(n) ? `: ${short(sum.failing.get(n), 200)}` : ''}`);
  const harness = `harness ${sum.status}${sum.message ? ': ' + short(sum.message, 200) : ''}`;
  if (!exp) {
    if (!sum.harnessOk) return { verdict: 'regression', notes: [harness] };
    if (sum.failing.size) return { verdict: 'regression', notes: [`${sum.failing.size} subtest(s) fail`, ...list([...sum.failing.keys()])] };
    if (tooFew(sum, oracle)) return { verdict: 'regression', notes: [sum.pass ? `${sum.pass} subtest(s) pass, jsdom passes ${oracle.pass}: subtests no longer run` : 'no subtests ran'] };
    return { verdict: 'ok', notes: [] };
  }
  if (exp.subtests) {
    if (!sum.harnessOk) return { verdict: 'regression', notes: [harness] };
    const newly = [...sum.failing.keys()].filter((n) => !exp.subtests.has(n));
    const fixed = [...exp.subtests.keys()].filter((n) => !sum.failing.has(n));
    if (newly.length) {
      const notes = [`${newly.length} subtest(s) newly fail`, ...list(newly)];
      if (fixed.length) notes.push(`  (and ${fixed.length} expected failure(s) now pass or are no longer reported)`);
      return { verdict: 'regression', notes };
    }
    const least = listFloor(exp.subtests, oracle);
    if (sum.pass < least) return { verdict: 'regression', notes: [`${sum.pass} subtest(s) pass, at least ${least} expected: passing subtests no longer run`] };
    if (!fixed.length) return { verdict: 'ok', notes: [] };
    const passed = fixed.filter((n) => sum.passing.has(n));
    const stale = fixed.filter((n) => !sum.passing.has(n));
    const notes = [];
    if (passed.length) notes.push(`${passed.length} expected failure(s) now pass`, ...list(passed));
    if (stale.length) notes.push(`${stale.length} expected failure(s) no longer reported (stale)`, ...list(stale));
    return { verdict: 'progress', notes };
  }
  if (BY_HAND.has(exp.status)) {
    if (sum.harnessOk && sum.failing.size === 0) return { verdict: 'ok', notes: [] };
    return { verdict: 'changed', notes: [`${exp.status}, not gated: ${sum.pass} pass, ${sum.failing.size} fail${sum.harnessOk ? '' : `; ${harness}`}`] };
  }
  const floor = exp.pass ?? 0;
  if (sum.harnessOk && sum.failing.size === 0 && !tooFew(sum, oracle)) return { verdict: 'progress', notes: ['now passes entirely'] };
  // a process that died is a regression; KILLED (past the hard time limit) is slowness, informational like a timeout
  if (sum.status === 'CRASH' && exp.status !== 'crash') return { verdict: 'regression', notes: [`now crash (expected ${exp.status})`, '  ' + harness] };
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

/** `[source:]text` -> { source (null when absent), text }. */
export function splitSource(p) {
  const m = /^(wpt|tuwpt|legacy|api):(.*)$/.exec(p);
  return { source: m ? m[1] : null, text: m ? m[2] : p };
}

/**
 * Test filter from CLI patterns. A pattern is `[source:]text`: text with `*` is a glob over the test id,
 * otherwise a substring of it. No patterns = everything.
 */
export function makeFilter(patterns) {
  if (!patterns.length) return () => true;
  const ps = patterns.map(splitSource);
  return (source, id) => ps.some((p) => (!p.source || p.source === source) && (p.text === '' || (p.text.includes('*') ? path.matchesGlob(id, p.text) : id.includes(p.text))));
}

/**
 * Roadmap items (roadmap.yaml) with their test globs over `<source>:<id>` (a leading `!` excludes):
 * `include` lists the including globs, `match(source, id)` applies them all.
 */
export function loadRoadmap() {
  const items = yaml.load(fs.readFileSync(path.join(HERE, 'roadmap.yaml'), 'utf8'));
  for (const it of items) {
    it.tests ??= [];
    const include = it.tests.filter((g) => !g.startsWith('!'));
    const exclude = it.tests.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    it.include = include;
    it.match = (source, id) => {
      const key = `${source}:${id}`;
      return include.some((g) => path.matchesGlob(key, g)) && !exclude.some((g) => path.matchesGlob(key, g));
    };
  }
  return items;
}
