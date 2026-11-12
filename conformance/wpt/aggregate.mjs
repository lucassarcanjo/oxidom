// Step 3: fold results/raw/<dom>.jsonl into results/wpt.json (per file, per subtest, per DOM), results/
// summary.json (the numbers) and results/summary.md (the human-readable report), including the fidelity
// check of jsdom-in-global-install-mode against jsdom's own to-run.yaml expectations.
//
// Counting rules:
// - The subtests of a file are the UNION of the subtest names any DOM reported. A subtest a DOM did not report
//   (its harness errored before defining it, or the process crashed) counts as a failure for that DOM
//   (status MISSING, or CRASH when the process died / was killed / setup failed).
// - A file where no DOM reported any subtest counts as one pseudo-subtest "(file)" that passes iff the
//   harness status is OK.
// - pass = testharness PASS. Everything else (FAIL, TIMEOUT, NOTRUN, PRECONDITION_FAILED, MISSING, CRASH) fails.
//
// Usage: node conformance/wpt/aggregate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS, DOMS, WPT_COMMIT, WPT_ROOT, readJSON, writeJSON, readRawLines, short, cause } from './lib.mjs';

const sel = readJSON(path.join(RESULTS, 'selection.json'));
const raw = {};
for (const d of DOMS) {
  raw[d] = new Map();
  for (const line of readRawLines(d)) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      raw[d].set(r.id, r);
    } catch {
      // torn line
    }
  }
}
const tests = sel.tests.filter((t) => DOMS.every((d) => raw[d].has(t.id)));
const notRun = sel.tests.length - tests.length;

/** Groups to-run.yaml DIRs into the areas reported on the comparison page. */
export function areaOf(dir) {
  if (dir.startsWith('html/semantics/forms')) return 'html/semantics/forms';
  if (dir.startsWith('html/semantics/scripting-1')) return 'html/semantics/scripting (script, template, noscript)';
  if (dir.startsWith('html/semantics/embedded-content')) return 'html/semantics/embedded-content (img, media)';
  if (dir.startsWith('html/semantics/document-metadata')) return 'html/semantics/document-metadata';
  if (dir.startsWith('html/semantics/')) return 'html/semantics/other (tables, links, details, grouping, text-level, selectors)';
  if (/^html\/(editing|interaction)/.test(dir)) return 'html focus & activation';
  if (dir.startsWith('html/webappapis')) return 'html/webappapis (event handlers, timers, atob, microtasks)';
  if (dir.startsWith('html/infrastructure')) return 'html/dom';
  return dir;
}

const CRASHY = new Set(['CRASH', 'KILLED', 'SETUP_ERROR', 'RUNNER_ERROR']);

// ---- per-file table ----
const files = {};
for (const t of tests) {
  const rs = Object.fromEntries(DOMS.map((d) => [d, raw[d].get(t.id)]));
  const names = [];
  const seen = new Set();
  for (const d of DOMS) for (const s of rs[d].subtests) if (!seen.has(s.name)) seen.add(s.name), names.push(s.name);
  const subtests = {};
  const msgs = {};
  if (names.length === 0) {
    subtests['(file)'] = DOMS.map((d) => (rs[d].harness.status === 'OK' ? 'PASS' : CRASHY.has(rs[d].harness.status) ? 'CRASH' : 'FAIL'));
  } else {
    const by = Object.fromEntries(DOMS.map((d) => [d, new Map(rs[d].subtests.map((s) => [s.name, s]))]));
    for (const n of names) {
      subtests[n] = DOMS.map((d) => by[d].get(n)?.status ?? (CRASHY.has(rs[d].harness.status) ? 'CRASH' : 'MISSING'));
      const m = DOMS.map((d) => (by[d].get(n) && by[d].get(n).status !== 'PASS' ? short(by[d].get(n).message) : null));
      if (m.some(Boolean)) msgs[n] = m;
    }
  }
  files[t.id] = {
    dir: t.dir,
    area: areaOf(t.dir),
    harness: DOMS.map((d) => rs[d].harness.status),
    harnessMessage: DOMS.map((d) => (rs[d].harness.status === 'OK' ? null : short(rs[d].harness.message || rs[d].scriptErrors?.[0] || rs[d].notes?.join('; '), 200))),
    firstScriptError: DOMS.map((d) => (rs[d].scriptErrors?.length ? short(rs[d].scriptErrors[0], 200) : null)),
    subtests,
    messages: msgs,
  };
}

// ---- totals / areas ----
const zero = () => Object.fromEntries(DOMS.map((d) => [d, 0]));
const areas = {};
const totals = { files: 0, subtests: 0, pass: zero(), fileScore: zero(), filesAllPass: zero(), crash: zero(), harnessError: zero(), harnessTimeout: zero() };
for (const [id, f] of Object.entries(files)) {
  const a = (areas[f.area] ??= { files: 0, subtests: 0, pass: zero(), fileScore: zero(), filesAllPass: zero(), dirs: new Set() });
  a.files++;
  a.dirs.add(f.dir);
  totals.files++;
  const n = Object.keys(f.subtests).length;
  a.subtests += n;
  totals.subtests += n;
  DOMS.forEach((d, i) => {
    let p = 0;
    for (const st of Object.values(f.subtests)) if (st[i] === 'PASS') p++;
    a.pass[d] += p;
    totals.pass[d] += p;
    a.fileScore[d] += p / n;
    totals.fileScore[d] += p / n;
    if (p === n && f.harness[i] === 'OK') {
      a.filesAllPass[d]++;
      totals.filesAllPass[d]++;
    }
    if (CRASHY.has(f.harness[i])) totals.crash[d]++;
    if (f.harness[i] === 'ERROR') totals.harnessError[d]++;
    if (['TIMEOUT', 'NO_COMPLETION'].includes(f.harness[i])) totals.harnessTimeout[d]++;
  });
}
// fileScore: mean over files of (passed subtests / subtests in file), in % — every file weighs the same, so a
// few files with thousands of generated subtests cannot dominate.
for (const a of [...Object.values(areas), totals]) {
  if (a.dirs) a.dirs = [...a.dirs];
  for (const d of DOMS) a.fileScore[d] = Number(((100 * a.fileScore[d]) / a.files).toFixed(1));
}

// Totals without areas whose implementation is Node's in every environment (results/globals.json):
// encoding = TextEncoder/TextDecoder.
const NODE_AREAS = new Set(['encoding']);
const domTotals = { files: 0, subtests: 0, pass: zero(), fileScore: zero() };
for (const [area, a] of Object.entries(areas)) {
  if (NODE_AREAS.has(area)) continue;
  domTotals.files += a.files;
  domTotals.subtests += a.subtests;
  for (const d of DOMS) {
    domTotals.pass[d] += a.pass[d];
    domTotals.fileScore[d] += (a.fileScore[d] * a.files) / 100;
  }
}
for (const d of DOMS) domTotals.fileScore[d] = Number(((100 * domTotals.fileScore[d]) / domTotals.files).toFixed(1));
const globalsFile = path.join(RESULTS, 'globals.json');
const globals = fs.existsSync(globalsFile) ? readJSON(globalsFile).globals : null;

// ---- failure causes (buckets from lib.mjs cause()) ----
const causes = Object.fromEntries(DOMS.map((d) => [d, new Map()]));
const addCause = (d, c, id, n = 1) => {
  const e = causes[d].get(c) ?? { subtests: 0, files: new Set() };
  e.subtests += n;
  e.files.add(id);
  causes[d].set(c, e);
};
for (const [id, f] of Object.entries(files)) {
  DOMS.forEach((d, i) => {
    const r = raw[d].get(id);
    const fullMsg = new Map(r.subtests.map((x) => [x.name, x.message]));
    for (const [name, st] of Object.entries(f.subtests)) {
      if (st[i] === 'PASS') continue;
      if (st[i] === 'CRASH') addCause(d, `process ${f.harness[i].toLowerCase()} (${short(f.harnessMessage[i], 60)})`, id);
      else if (st[i] === 'MISSING' || name === '(file)') {
        const hm = r.harness.status === 'OK' ? (r.scriptErrors?.[0] ?? 'subtest not defined') : r.harness.message || r.scriptErrors?.[0] || r.harness.status;
        addCause(d, `file aborted: ${cause(String(hm).replace(/^(error|unhandledrejection): /, '').replace(/^Unhandled rejection: /, ''))}`, id);
      } else if (st[i] === 'TIMEOUT' || st[i] === 'NOTRUN') addCause(d, `subtest ${st[i]}`, id);
      else addCause(d, cause(fullMsg.get(name)), id);
    }
  });
}
const topCauses = Object.fromEntries(DOMS.map((d) => [d, [...causes[d].entries()]
  .map(([c, e]) => ({ cause: c, subtests: e.subtests, files: e.files.size, example: [...e.files][0] }))
  .sort((a, b) => b.subtests - a.subtests)]));

// ---- jsdom fidelity check (vs refs/jsdom/test/web-platform-tests/to-run.yaml) ----
const SKIP_REASONS = new Set(['timeout', 'fail-slow', 'flaky', 'needs-canvas', 'fail-with-canvas', 'skip']);
const fid = {
  filesCompared: 0, filesAgree: 0, filesSkippedByJsdom: 0,
  expectPass: { files: 0, agree: 0 }, expectFail: { files: 0, agree: 0 }, expectPartial: { files: 0, agree: 0 },
  subtestsCompared: 0, subtestsAgree: 0, unexpectedFail: 0, unexpectedPass: 0,
  disagreements: [],
};
const jIdx = DOMS.indexOf('jsdom');
const disagreeCauses = new Map();
const TH_GLOBALS = /^(assert_\w+|promise_\w+|test|async_test|promise_test|t|step_\w+|done|setup|format_value|add_\w+)$/;
function classifyDisagreement(msg, pageSrc, id) {
  const m = String(msg ?? '');
  if (/^encoding\//.test(id) || /encoding is not supported|encoded data was not valid/.test(m)) {
    return "Node's TextEncoder/TextDecoder (Vitest keeps Node's; jsdom's own runner uses jsdom's)";
  }
  if (/execution-timing|script-defer|readyState|compatmode|charset|Document-doctype|DocumentType-literal|meta-inhead|quotes-in-meta|link-error-fired|emptyish-script|script-for-event|fetch-src|script-type|post-connection-steps|insertion-removing-steps|initial-linefeed|parseFromString-encoding/.test(id)) {
    return 'no real page load (parser-interleaved scripts, doctype/quirks, charset, readyState)';
  }
  const nd = /([\w$]+) is not defined/.exec(m);
  if (nd && !TH_GLOBALS.test(nd[1]) && new RegExp(`\\b(id|name)\\s*=\\s*["']?${nd[1]}\\b`).test(pageSrc)) {
    return 'named access (window[id]) is not mirrored onto globalThis';
  }
  if (/must be an instance of Event\. Received an instance of Event|is a? ?DOMException/.test(m)) return 'Node-provided globals the environment keeps (AbortController/AbortSignal, Node EventTarget, DOMException) mixed with DOM objects';
  if (/\[object global\]|\[object Window\]|got object "\[object|expected object "\[object|not of type '?Window/.test(m)) return 'window !== globalThis (event path / defaultView shows the jsdom Window object, test expects `window`)';
  if (/instanceof|is DOMException|prototype|realm|Object\.getPrototypeOf/i.test(m)) return 'cross-realm objects (jsdom realm vs Node realm: instanceof / prototype checks)';
  if (/\w+ is not defined/.test(m)) return 'code jsdom evaluates in its own realm (event-handler attributes, injected <script>) cannot see the Node-realm test globals';
  if (/callback" argument must be of type function|setTimeout|setInterval/.test(m)) return 'Node timers instead of window timers (string callbacks, return values)';
  if (/timed out|TIMEOUT|NO_COMPLETION|timeout\(\) called/i.test(m)) return 'timeout (no real page load / resource events, or 10 s cap)';
  if (/fetch|ENOTFOUND|Failed to parse URL|network/i.test(m)) return 'network/resource loading (no server)';
  if (/currentScript|readyState|document\.write|parser|DOMContentLoaded|load event/i.test(m)) return 'no parser-interleaved script execution (scripts run after the whole page is in the DOM)';
  return 'other';
}
function pageSource(t) {
  try {
    return fs.readFileSync(path.join(WPT_ROOT, t.file), 'utf8');
  } catch {
    return '';
  }
}
for (const t of tests) {
  const f = files[t.id];
  const exp = t.jsdomExpectation;
  if (exp?.file && SKIP_REASONS.has(exp.file)) {
    fid.filesSkippedByJsdom++;
    continue;
  }
  fid.filesCompared++;
  const hOK = f.harness[jIdx] === 'OK';
  // a subtest name jsdom never generated (another DOM named a dynamic subtest differently) is not a
  // disagreement with jsdom's expectations
  const st = Object.entries(f.subtests).map(([n, s]) => [n, s[jIdx]]).filter(([, s]) => !(hOK && s === 'MISSING'));
  const allPass = hOK && st.every(([, s]) => s === 'PASS');
  let agree;
  let kind;
  if (exp?.file === 'fail') {
    kind = 'expectFail';
    agree = !allPass;
  } else if (exp?.subtests) {
    kind = 'expectPartial';
    agree = hOK;
    for (const [n, s] of st) {
      const expFail = Boolean(exp.subtests[n]) && exp.subtests[n].reason.startsWith('fail');
      const ok = expFail ? s !== 'PASS' : s === 'PASS';
      fid.subtestsCompared++;
      if (ok) fid.subtestsAgree++;
      else if (expFail) fid.unexpectedPass++;
      else fid.unexpectedFail++;
      if (!ok) agree = false;
    }
  } else {
    kind = 'expectPass';
    agree = allPass;
    for (const [, s] of st) {
      fid.subtestsCompared++;
      if (s === 'PASS') fid.subtestsAgree++;
      else fid.unexpectedFail++;
    }
  }
  fid[kind].files++;
  if (agree) {
    fid[kind].agree++;
    fid.filesAgree++;
  } else {
    const r = raw.jsdom.get(t.id);
    const firstFail = st.find(([n, s]) => s !== 'PASS' && !(exp?.subtests?.[n]));
    const msg = !hOK ? (r.harness.message || r.scriptErrors[0] || r.harness.status) : firstFail ? (f.messages[firstFail[0]]?.[jIdx] ?? firstFail[1]) : 'unexpected pass';
    const c = kind === 'expectFail' || msg === 'unexpected pass' ? 'unexpected pass (jsdom expects a failure)' : classifyDisagreement(msg + ' ' + (r.harness.status), pageSource(t), t.id);
    disagreeCauses.set(c, (disagreeCauses.get(c) ?? 0) + 1);
    fid.disagreements.push({ id: t.id, expected: kind, harness: f.harness[jIdx], cause: c, message: short(msg, 200) });
  }
}
fid.disagreementCauses = Object.fromEntries([...disagreeCauses.entries()].sort((a, b) => b[1] - a[1]));

// ---- where happy-dom / oxidom beat jsdom ----
const beats = [];
// (per-area comparison on subtests passed; see BEAT_NOTES in the report section for caveats)
for (const [area, a] of Object.entries(areas)) {
  for (const d of ['happy-dom', 'oxidom']) {
    if (a.pass[d] > a.pass.jsdom) beats.push({ area, dom: d, pass: a.pass[d], jsdom: a.pass.jsdom, subtests: a.subtests });
  }
}
const fileBeats = { 'happy-dom': [], oxidom: [] };
for (const [id, f] of Object.entries(files)) {
  for (const d of ['happy-dom', 'oxidom']) {
    const i = DOMS.indexOf(d);
    let mine = 0;
    let js = 0;
    for (const s of Object.values(f.subtests)) {
      if (s[i] === 'PASS') mine++;
      if (s[jIdx] === 'PASS') js++;
    }
    if (mine > js) fileBeats[d].push({ id, [d]: mine, jsdom: js, subtests: Object.keys(f.subtests).length });
  }
}
for (const d of Object.keys(fileBeats)) fileBeats[d].sort((a, b) => (b[d] - b.jsdom) - (a[d] - a.jsdom));

const BEAT_NOTES = {
  'oxidom dom/abort': "caveat: AbortController/AbortSignal are Node's in the jsdom and oxidom environments (results/globals.json); jsdom loses subtests because its DOMException is not the one Node's AbortSignal uses, oxidom passes because it leaves Node's DOMException in place too — a global-install effect, not oxidom code",
  'happy-dom dom/abort': "happy-dom installs its own AbortController/AbortSignal, consistent with its DOMException; jsdom's environment keeps Node's AbortSignal next to jsdom's DOMException (global-install effect)",
  'oxidom dom/nodes': 'mostly Node-compareDocumentPosition.html (1,444 subtests), where jsdom has a known failure (to-run.yaml: disconnected-node ordering not antisymmetric)',
};

// ---- outputs ----
const pct = (p, n) => (n ? ((100 * p) / n).toFixed(1) : '0.0');
const summary = {
  wptCommit: WPT_COMMIT,
  generated: new Date().toISOString(),
  doms: DOMS,
  versions: {},
  filesSelected: sel.selectedCount,
  filesWithResultsForAllDoms: tests.length,
  filesNotYetRun: notRun,
  totals,
  totalsExcludingNodeProvidedAreas: { excluded: [...NODE_AREAS], ...domTotals },
  globals,
  areas,
  topCauses: Object.fromEntries(DOMS.map((d) => [d, topCauses[d].slice(0, 40)])),
  fidelity: { ...fid, disagreements: fid.disagreements },
  beats: beats.map((b) => ({ ...b, note: BEAT_NOTES[`${b.dom} ${b.area}`] ?? null })),
  fileScoreBeats: Object.entries(areas).flatMap(([area, a]) => ['happy-dom', 'oxidom'].filter((d) => a.fileScore[d] > a.fileScore.jsdom).map((d) => ({ area, dom: d, fileScore: a.fileScore[d], jsdom: a.fileScore.jsdom }))),
  fileBeats: { 'happy-dom': fileBeats['happy-dom'].slice(0, 60), oxidom: fileBeats.oxidom.slice(0, 60), counts: { 'happy-dom': fileBeats['happy-dom'].length, oxidom: fileBeats.oxidom.length } },
};
try {
  const { appRequire } = await import('./lib.mjs');
  summary.versions.jsdom = appRequire('jsdom/package.json').version;
  summary.versions['happy-dom'] = appRequire('happy-dom/package.json').version;
  summary.versions.vitest = appRequire('vitest/package.json').version;
  summary.versions.node = process.versions.node;
} catch {
  // best effort
}
writeJSON(path.join(RESULTS, 'summary.json'), summary, true);
// wpt.json: compact per-subtest statuses (failure messages stay in results/raw/<dom>.jsonl.gz)
const CODE = { PASS: 'P', FAIL: 'F', TIMEOUT: 'T', NOTRUN: 'N', PRECONDITION_FAILED: 'X', MISSING: 'M', CRASH: 'C' };
const compactFiles = {};
for (const [id, f] of Object.entries(files)) {
  compactFiles[id] = {
    dir: f.dir,
    area: f.area,
    harness: f.harness,
    harnessMessage: f.harnessMessage,
    subtests: Object.fromEntries(Object.entries(f.subtests).map(([n, st]) => [n, st.map((x) => CODE[x] ?? '?').join('')])),
  };
}
writeJSON(path.join(RESULTS, 'wpt.json'), {
  wptCommit: WPT_COMMIT,
  doms: DOMS,
  statusLegend: 'subtests[name] = 3-letter string, one status per DOM in `doms` order: P=PASS F=FAIL T=TIMEOUT N=NOTRUN X=PRECONDITION_FAILED M=MISSING (not reported by this DOM; counts as fail) C=CRASH (process crashed/killed/setup failed). harness = testharness file status per DOM. Failure messages: results/raw/<dom>.jsonl.gz.',
  files: compactFiles,
});

// ---- summary.md ----
const L = [];
const row = (cells) => L.push('| ' + cells.join(' | ') + ' |');
L.push('# WPT behavioural conformance: jsdom vs happy-dom vs oxidom (global-install mode)', '');
L.push(`Generated ${summary.generated} by \`node conformance/wpt/aggregate.mjs\` from results/raw/*.jsonl. WPT commit \`${WPT_COMMIT}\` (the one jsdom pins).`);
L.push(`Versions: jsdom ${summary.versions.jsdom}, happy-dom ${summary.versions['happy-dom']}, vitest ${summary.versions.vitest} (environments), oxidom @ working tree, Node ${summary.versions.node}.`, '');
L.push(`${tests.length} test files (of ${sel.selectedCount} selected${notRun ? `, ${notRun} not yet run for every DOM` : ''}), ${totals.subtests} subtests (union of subtest names across the three DOMs).`, '');
L.push('## Overall', '');
row(['', ...DOMS]);
row(['---', ...DOMS.map(() => '---:')]);
row(['subtests passed', ...DOMS.map((d) => `${totals.pass[d]} / ${totals.subtests} (${pct(totals.pass[d], totals.subtests)}%)`)]);
row(['mean per-file pass rate (each file weighs 1)', ...DOMS.map((d) => `${totals.fileScore[d]}%`)]);
row(['subtests passed, excluding encoding (Node\'s TextDecoder in all three)', ...DOMS.map((d) => `${domTotals.pass[d]} / ${domTotals.subtests} (${pct(domTotals.pass[d], domTotals.subtests)}%)`)]);
row(['mean per-file pass rate, excluding encoding', ...DOMS.map((d) => `${domTotals.fileScore[d]}%`)]);
row(['files fully passing', ...DOMS.map((d) => `${totals.filesAllPass[d]} / ${totals.files} (${pct(totals.filesAllPass[d], totals.files)}%)`)]);
row(['files with harness ERROR', ...DOMS.map((d) => totals.harnessError[d])]);
row(['files timing out (10 s)', ...DOMS.map((d) => totals.harnessTimeout[d])]);
row(['files crashed / killed', ...DOMS.map((d) => totals.crash[d])]);
L.push('');
L.push('Subtest totals are dominated by a few generated files (dom/ranges, selection, html/dom reflection and custom-elements name tests have thousands of subtests each); the mean per-file pass rate weighs every file equally.', '');
if (globals) {
  L.push('## Which implementation the test code sees (results/globals.json)', '');
  L.push('In Vitest global-install mode some globals stay Node\'s own. Areas built on them measure Node, not the DOM.', '');
  const names = Object.keys(globals.jsdom).filter((n) => DOMS.some((d) => globals[d][n] !== 'dom'));
  row(['global', ...DOMS]);
  row(['---', ...DOMS.map(() => '---')]);
  for (const n of names) row([n, ...DOMS.map((d) => globals[d][n])]);
  L.push('');
}
L.push('## By area (subtests passed)', '');
L.push('Cells: subtests passed (subtest pass %) / mean per-file pass rate.', '');
row(['area', 'files', 'subtests', ...DOMS]);
row(['---', '---:', '---:', ...DOMS.map(() => '---:')]);
for (const [area, a] of Object.entries(areas).sort((x, y) => y[1].subtests - x[1].subtests)) {
  row([area, a.files, a.subtests, ...DOMS.map((d) => `${a.pass[d]} (${pct(a.pass[d], a.subtests)}%) / ${a.fileScore[d]}%`)]);
}
L.push('');
L.push('## Where happy-dom or oxidom beat jsdom', '');
if (!beats.length) L.push('No area.');
for (const b of beats.sort((x, y) => (y.pass - y.jsdom) - (x.pass - x.jsdom))) {
  L.push(`- **${b.dom}** in ${b.area}: ${b.pass} vs jsdom ${b.jsdom} of ${b.subtests} subtests (+${b.pass - b.jsdom})${BEAT_NOTES[`${b.dom} ${b.area}`] ? ` — ${BEAT_NOTES[`${b.dom} ${b.area}`]}` : ''}`);
}
const fsBeats = [];
for (const [area, a] of Object.entries(areas)) {
  for (const d of ['happy-dom', 'oxidom']) if (a.fileScore[d] > a.fileScore.jsdom) fsBeats.push(`**${d}** in ${area}: ${a.fileScore[d]}% vs jsdom ${a.fileScore.jsdom}%`);
}
L.push('', 'By mean per-file pass rate: ' + (fsBeats.length ? fsBeats.join('; ') : 'none') + '.');
L.push('', `Files where a DOM passes more subtests than jsdom: happy-dom ${fileBeats['happy-dom'].length}, oxidom ${fileBeats.oxidom.length}. Largest margins:`, '');
for (const d of ['happy-dom', 'oxidom']) {
  L.push(`- ${d}: ` + fileBeats[d].slice(0, 12).map((x) => `${x.id} (${x[d]} vs ${x.jsdom}/${x.subtests})`).join('; '));
}
L.push('');
for (const d of DOMS) {
  L.push(`## Top failure causes: ${d}`, '');
  row(['cause', 'failing subtests', 'files', 'example file']);
  row(['---', '---:', '---:', '---']);
  for (const c of topCauses[d].slice(0, 20)) row([c.cause.replace(/\|/g, '\\|'), c.subtests, c.files, c.example]);
  L.push('');
}
L.push('## Fidelity check: jsdom in this harness vs jsdom\'s own expectations (to-run.yaml)', '');
L.push(`Files compared: ${fid.filesCompared} (another ${fid.filesSkippedByJsdom} are marked timeout / fail-slow / flaky / needs-canvas, which jsdom does not run, so there is nothing to compare).`);
L.push(`- File-level agreement: ${fid.filesAgree} / ${fid.filesCompared} (${pct(fid.filesAgree, fid.filesCompared)}%)`);
L.push(`  - expected to pass fully: ${fid.expectPass.agree} / ${fid.expectPass.files}; expected to fail (whole file): ${fid.expectFail.agree} / ${fid.expectFail.files}; with per-subtest expectations: ${fid.expectPartial.agree} / ${fid.expectPartial.files}`);
L.push(`- Subtest-level agreement (files expected to pass, or with per-subtest expectations): ${fid.subtestsAgree} / ${fid.subtestsCompared} (${pct(fid.subtestsAgree, fid.subtestsCompared)}%); ${fid.unexpectedFail} subtests fail here but pass in jsdom's own runner, ${fid.unexpectedPass} pass here but are expected to fail.`);
L.push('', 'Disagreeing files by cause (first unexpected failure of each file, classified by message):', '');
for (const [c, n] of Object.entries(fid.disagreementCauses)) L.push(`- ${n} — ${c}`);
L.push('', 'Examples:', '');
const ex = new Map();
for (const dgr of fid.disagreements) {
  const arr = ex.get(dgr.cause) ?? [];
  if (arr.length < 3) arr.push(dgr);
  ex.set(dgr.cause, arr);
}
for (const [c, arr] of ex) for (const dgr of arr) L.push(`- [${c.split(' (')[0]}] ${dgr.id}: ${dgr.message.replace(/\|/g, '\\|')}`);
L.push('');
fs.writeFileSync(path.join(RESULTS, 'summary.md'), L.join('\n') + '\n');
console.log(`aggregated ${tests.length} files; subtests ${totals.subtests}; pass`, totals.pass);
console.log('fidelity: files', fid.filesAgree, '/', fid.filesCompared, 'subtests', fid.subtestsAgree, '/', fid.subtestsCompared);
