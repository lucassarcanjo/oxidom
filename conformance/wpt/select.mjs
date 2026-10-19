// Step 1: choose the WPT test files to run (conformance/wpt/results/selection.json).
//
// Source of truth for "which tests exist" is jsdom's own WPT manifest (refs/jsdom/test/web-platform-tests/
// wpt-manifest.json, generated at the WPT commit jsdom pins) and the DIR list in its to-run.yaml. We keep the
// DIRs relevant to a DOM test environment, apply jsdom's global filters (workers, testdriver, shadowrealm,
// tentative), then drop every test that needs wptserve features we do not have (we execute pages from disk in
// Vitest-style global-install mode, with no HTTP server, no second document and no workers). Each exclusion is
// counted per reason. jsdom's expectations for every kept test are recorded for the fidelity check.
//
// Usage: node conformance/wpt/select.mjs        (needs the sparse WPT checkout at $WPT_ROOT; see README.md)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  JSDOM_WPT, WPT_ROOT, WPT_COMMIT, RESULTS, readJSON, writeJSON, readScriptMeta, wrapperPage, resolveSrc,
  rsdomRequire, appRequire,
} from './lib.mjs';

const yaml = rsdomRequire('js-yaml');
const parse5 = appRequire('parse5');

// ---- 1. DIRs ---------------------------------------------------------------------------------------------
const INCLUDE = [
  'FileAPI', 'css/cssom', 'css/selectors', 'custom-elements',
  'dom/abort', 'dom/collections', 'dom/events', 'dom/lists', 'dom/nodes', 'dom/ranges', 'dom/traversal',
  'domparsing', 'domxpath', 'encoding',
  'html/dom', 'html/editing/activation', 'html/editing/focus/focus-management',
  'html/infrastructure/common-dom-interfaces/collections', 'html/interaction/focus',
  'html/semantics/*', // every html/semantics DIR jsdom runs, except the canvas one (below)
  'html/syntax',
  'html/webappapis/atob', 'html/webappapis/events', 'html/webappapis/microtask-queuing',
  'html/webappapis/scripting/events', 'html/webappapis/timers',
  'selection', 'shadow-dom', 'uievents', 'webstorage', 'xhr',
];
const DIR_EXCLUDE_REASON = {
  'html/semantics/embedded-content/the-canvas-element': 'needs canvas (jsdom itself skips it without node-canvas)',
};
function dirIncluded(dir) {
  if (DIR_EXCLUDE_REASON[dir]) return false;
  return INCLUDE.some((p) => (p.endsWith('/*') ? dir.startsWith(p.slice(0, -1)) : dir === p));
}
function dirReason(dir) {
  if (DIR_EXCLUDE_REASON[dir]) return DIR_EXCLUDE_REASON[dir];
  if (/^(WebCryptoAPI|cookies|cors|fetch|url|websockets|webmessaging|hr-time)/.test(dir)) {
    return 'network / Node-provided API, not DOM';
  }
  if (/^css\//.test(dir) || /^svg\//.test(dir) || /^html\/rendering/.test(dir)) return 'CSS/SVG rendering or layout';
  if (/^html\/browsers|^html\/infrastructure\/urls|^html\/obsolete/.test(dir)) {
    return 'browsing contexts / navigation / history (multi-document)';
  }
  if (/^html\/canvas|^mediacapture|^orientation|^pointer/.test(dir)) return 'device / graphics APIs';
  return 'not selected (outside DOM-environment scope)';
}

const toRunDocs = yaml.loadAll(fs.readFileSync(path.join(JSDOM_WPT, 'to-run.yaml'), 'utf8'));
const allDirs = toRunDocs.map((d) => d.DIR);
const dirs = allDirs.filter(dirIncluded);
const skippedDirs = allDirs.filter((d) => !dirIncluded(d)).map((d) => ({ dir: d, reason: dirReason(d) }));

// ---- 2. jsdom expectations (same matching as refs/jsdom/test/web-platform-tests/expectations-utils.js) ----
function expectationsFor(doc, paths) {
  const map = new Map();
  for (const [pattern, data] of Object.entries(doc)) {
    if (pattern === 'DIR') continue;
    for (const p of paths) {
      if (path.matchesGlob(p, doc.DIR + '/' + pattern) && !map.has(p)) map.set(p, data);
    }
  }
  return map;
}
/** Collapses a to-run.yaml entry into { file: reason } or { subtests: {name: reason} } for Node 22. */
function normExpectation(data) {
  if (data === undefined) return null;
  const nodeOk = (r) => {
    const m = /^(fail|skip)-node:(.+)$/.exec(r);
    if (!m) return r;
    // Node 22 here: "<24" style ranges apply, ">=24" ones do not
    const range = m[2];
    const major = Number(process.versions.node.split('.')[0]);
    const lt = /^<(\d+)/.exec(range);
    const ge = /^>=(\d+)/.exec(range);
    const applies = lt ? major < Number(lt[1]) : ge ? major >= Number(ge[1]) : true;
    return applies ? m[1] : null;
  };
  if (Array.isArray(data)) {
    const r = nodeOk(data[0]);
    return r ? { file: r, why: data[1] ?? '' } : null;
  }
  const subtests = {};
  for (const [name, [r, why]] of Object.entries(data)) {
    const rr = nodeOk(r);
    if (rr) subtests[name] = { reason: rr, why: why ?? '' };
  }
  return Object.keys(subtests).length ? { subtests } : null;
}

// ---- 3. Manifest walk ---------------------------------------------------------------------------------------
const manifest = readJSON(path.join(JSDOM_WPT, 'wpt-manifest.json'));
/** [{ urlPath, file, extras }] for every testharness test URL. */
const items = [];
(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${k}` : k;
    if (Array.isArray(v)) {
      for (const [u, extras] of v.slice(1)) items.push({ urlPath: u ?? p, file: p, extras: extras ?? {} });
    } else walk(v, p);
  }
})(manifest.items.testharness, '');

/** Non-testharness items (reftest, manual, crashtest, visual, print-reftest) under the kept DIRs, for the record. */
const otherTypes = {};
for (const t of ['reftest', 'manual', 'crashtest', 'visual', 'print-reftest']) {
  let n = 0;
  (function walk(node, prefix) {
    for (const [k, v] of Object.entries(node ?? {})) {
      const p = prefix ? `${prefix}/${k}` : k;
      if (Array.isArray(v)) {
        if (dirs.some((d) => p.startsWith(d + '/'))) n += v.length - 1;
      } else walk(v, p);
    }
  })(manifest.items[t], '');
  otherTypes[t] = n;
}

// ---- 4. Exclusion rules ---------------------------------------------------------------------------------
// Ordered: the first matching rule names the reason. Path rules first, then content rules over the test
// source (the .html page, or the .any.js / .window.js file) — content rules are heuristic and conservative.
const PATH_RULES = [
  ['worker variant (no workers in a DOM env)', (t) => /\.(?:shared|service)?worker(?:-module)?\.html(?:\?|$)/.test(t.urlPath)],
  ['shadowrealm variant', (t) => /\.any\.shadowrealm/.test(t.urlPath)],
  ['testdriver (needs WebDriver)', (t) => Boolean(t.extras.testdriver)],
  ['tentative (jsdom skips these too)', (t) => /tentative[./]/.test(t.urlPath)],
  ['.sub. (wptserve substitution)', (t) => /\.sub\./.test(t.file)],
  ['.https. / .h2. (secure server)', (t) => /\.(https|h2)\./.test(t.file)],
  ['not an HTML/any/window test (.xhtml/.svg/...)', (t) => !/\.(html?|any\.js|window\.js)$/.test(t.file)],
  ['legacy multibyte encoding pages (must be served in that encoding)', (t) => /^encoding\/legacy-/.test(t.file)],
  ['document charset from bytes (needs a real page load)', (t) => /^html\/syntax\/charset\//.test(t.file)],
  ['html5lib parser driver (fetches .dat files, parses in iframes)', (t) => /^html\/syntax\/parsing\/html5lib_/.test(t.file)],
];
const CONTENT_RULES = [
  ['testdriver (needs WebDriver)', /testdriver\.js|test_driver\./],
  ['workers', /new\s+(Shared)?Worker\s*\(|serviceWorker\.register/],
  ['media resource loading/decoding', /get(Video|Audio)URI|\.(webm|mp4|ogv|ogg|oga|mp3|wav|vtt|m4a)\b|\/media\/[\w-]+\.\w+/],
  ['iframes / other documents', /<i?frame\b|<object\b|<embed\b|createElement(NS)?\([^)]*['"](i?frame|object|embed)['"]|window\.open\s*\(|\.contentWindow|\.contentDocument|\bframes\[|\bopener\b/i],
  ['server-side handler (.py / pipe)', /\.py\b|[?&]pipe=|\/cookies\/resources\//],
  ['cross-origin', /get-host-info|REMOTE_ORIGIN|HTTP_REMOTE|OTHER_ORIGIN|crossOrigin\b/],
  ['idlharness (fetches .idl files from the server)', /idlharness|\/interfaces\//],
  ['network fetch / XHR send / EventSource', /\bfetch\s*\(|\.send\s*\(|new\s+EventSource|navigator\.sendBeacon|new\s+WebSocket/],
  ['navigation / history', /location\.(href\s*=|assign\s*\(|replace\s*\(|reload\s*\()|history\.(pushState|replaceState|back|forward|go)\s*\(|\.click\(\)\s*;?\s*\/\/\s*navigat/],
  ['module scripts', /type\s*=\s*["']?module|\bimport\s*\(|^\s*import\s/m],
  ['parser-interleaved (document.write / document.open)', /document\.(write|writeln|open)\s*\(/],
];

// Test-specific helper scripts are scanned too (network rules always; the iframe rule except for the
// multi-purpose helper libraries below, where only some functions open a second document).
const MULTI_PURPOSE_HELPERS = new Set([
  'custom-elements/resources/custom-elements-helpers.js', 'html/resources/common.js',
  'dom/nodes/Comment-Text-constructor.js', 'common/object-association.js',
]);
function helperReason(paths) {
  for (const p of paths) {
    if (p === 'resources/testharness.js' || p === 'resources/testharnessreport.js') continue;
    if (/WebIDLParser|idlharness/.test(p)) return 'idlharness (fetches .idl files from the server)';
    const abs = path.join(WPT_ROOT, p);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    if (/\.py\b|[?&]pipe=/.test(src)) return 'server-side handler (.py / pipe)';
    if (/\bfetch\s*\(/.test(src)) return 'network fetch / XHR send / EventSource';
    if (!MULTI_PURPOSE_HELPERS.has(p) && CONTENT_RULES.find(([k]) => k === 'iframes / other documents')[1].test(src)) {
      return 'iframes / other documents';
    }
  }
  return null;
}

function scriptsOfPage(html, urlPath) {
  const doc = parse5.parse(html);
  const out = [];
  (function walk(n) {
    for (const c of n.childNodes ?? []) {
      if (c.nodeName === 'script') {
        const attrs = Object.fromEntries(c.attrs.map((a) => [a.name, a.value]));
        const type = (attrs.type ?? '').trim().toLowerCase();
        const classic = type === '' || /^(text|application)\/(x-)?(java|ecma)script$/.test(type);
        if (!classic) continue;
        if (attrs.src !== undefined) out.push({ src: attrs.src, path: resolveSrc(attrs.src, urlPath) });
      }
      if (c.content) walk(c.content);
      walk(c);
    }
  })(doc);
  return out;
}

function gitShowExists(p) {
  try {
    execFileSync('git', ['-C', WPT_ROOT, 'cat-file', '-e', `${WPT_COMMIT}:${p}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const selected = [];
const excluded = {}; // reason -> [urlPath]
const exclude = (reason, t) => (excluded[reason] ??= []).push(t.urlPath);
const neededPaths = new Set();

for (const doc of toRunDocs) {
  if (!dirs.includes(doc.DIR)) continue;
  const inDir = items.filter((t) => t.urlPath.startsWith(doc.DIR + '/'));
  const exps = expectationsFor(doc, inDir.map((t) => t.urlPath));
  for (const t of inDir) {
    const pr = PATH_RULES.find(([, f]) => f(t));
    if (pr) {
      exclude(pr[0], t);
      continue;
    }
    const abs = path.join(WPT_ROOT, t.file);
    if (!fs.existsSync(abs)) {
      exclude('test file missing from checkout', t);
      continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    const kind = t.file.endsWith('.any.js') ? 'any' : t.file.endsWith('.window.js') ? 'window' : 'html';
    const page = kind === 'html' ? src : wrapperPage(kind, '/' + t.file, readScriptMeta(src));
    const cr = CONTENT_RULES.find(([, re]) => re.test(src));
    if (cr) {
      exclude(cr[0], t);
      continue;
    }
    const scripts = scriptsOfPage(page, t.urlPath);
    if (scripts.some((s) => s.path === null)) {
      exclude('off-origin script', t);
      continue;
    }
    const hr = helperReason(scripts.map((s) => s.path));
    if (hr) {
      exclude(hr, t);
      continue;
    }
    for (const s of scripts) if (s.path !== 'resources/testharnessreport.js') neededPaths.add(s.path);
    selected.push({
      id: t.urlPath,
      dir: doc.DIR,
      file: t.file,
      kind,
      long: /name=["']?timeout["']?\s+content=["']?long/.test(page) || t.extras.timeout === 'long',
      scripts: scripts.map((s) => s.path),
      jsdomExpectation: normExpectation(exps.get(t.urlPath)),
    });
  }
}

// Script files outside the sparse checkout: add them (non-cone sparse-checkout accepts file paths), or drop
// the test when the file does not exist at the commit (server-generated resources).
const missing = [...neededPaths].filter((p) => !fs.existsSync(path.join(WPT_ROOT, p)));
const fetchable = missing.filter(gitShowExists);
if (fetchable.length) {
  const sc = path.join(WPT_ROOT, '.git/info/sparse-checkout');
  const cur = fs.readFileSync(sc, 'utf8');
  fs.writeFileSync(sc, cur + fetchable.map((p) => '/' + p).join('\n') + '\n');
  execFileSync('git', ['-C', WPT_ROOT, 'read-tree', '-mu', 'HEAD'], { stdio: 'inherit' });
}
const unavailable = new Set(missing.filter((p) => !fs.existsSync(path.join(WPT_ROOT, p))));
const final = [];
for (const t of selected) {
  if (t.scripts.some((p) => unavailable.has(p))) exclude('script resource not in repo (server-generated)', { urlPath: t.id });
  else final.push(t);
}

const exclusionCounts = Object.fromEntries(
  Object.entries(excluded).map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]),
);
const perDir = {};
for (const t of final) perDir[t.dir] = (perDir[t.dir] ?? 0) + 1;
const out = {
  wptCommit: WPT_COMMIT,
  manifest: 'refs/jsdom/test/web-platform-tests/wpt-manifest.json',
  dirsRun: dirs,
  dirsNotRun: skippedDirs,
  nonTestharnessItemsInRunDirs: otherTypes,
  candidates: final.length + Object.values(excluded).reduce((a, v) => a + v.length, 0),
  selectedCount: final.length,
  exclusionCounts,
  perDir,
  excluded,
  tests: final,
};
writeJSON(path.join(RESULTS, 'selection.json'), out, true);
console.log(`selected ${final.length} test files from ${dirs.length} DIRs; excluded:`, exclusionCounts);
console.log('added to sparse checkout:', fetchable.length, 'unavailable:', [...unavailable]);
