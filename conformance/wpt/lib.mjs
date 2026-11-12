// Shared paths and helpers for the WPT conformance comparison (conformance/wpt).
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root. */
export const LAB = path.resolve(HERE, '../..');
export const RESULTS = path.join(HERE, 'results');
/** scripts/fetch-refs.sh's destination, which OXIDOM_REFS overrides there too. */
export const REFS = path.resolve(process.env.OXIDOM_REFS || path.join(LAB, 'refs'));
export const JSDOM_WPT = path.join(REFS, 'jsdom/test/web-platform-tests');
/** jsdom's own WPT-format tests; their pages load testharness.js and shared helpers from WPT_ROOT. */
export const TUWPT_ROOT = path.join(JSDOM_WPT, 'to-upstream');
/** Sparse checkout of web-platform-tests at the commit jsdom pins (see README.md); WPT_ROOT overrides it. */
export const WPT_ROOT = process.env.WPT_ROOT ?? path.join(REFS, 'wpt');
export const WPT_COMMIT = '2971340498805350babb6c167e0df98eaa380f98';
export const DOMS = ['jsdom', 'happy-dom', 'oxidom'];
/** Origin the test pages pretend to be served from (passed to every environment as its URL). */
export const ORIGIN = 'http://web-platform.test:8000';

export const appRequire = createRequire(path.join(LAB, 'e2e/react-app/package.json'));
export const oxidomRequire = createRequire(path.join(LAB, 'packages/oxidom/package.json'));

export function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJSON(p, v, pretty = false) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, pretty ? 2 : 0) + '\n');
}

/** Parses `// META: key=value` lines at the top of a .any.js / .window.js file (wptserve semantics). */
export function readScriptMeta(src) {
  const out = [];
  for (const line of src.split(/\r?\n/)) {
    const m = /^\/\/\s*META:\s*(\w+)=(.*)$/.exec(line);
    if (m) out.push([m[1], m[2].trim()]);
    else if (line.trim() !== '' && !line.startsWith('//')) break;
  }
  return out;
}

/** The wrapper page wptserve generates for foo.any.js (AnyHtmlHandler) and foo.window.js (WindowHandler). */
export function wrapperPage(kind, jsUrlPath, meta) {
  const metaHtml = [];
  const scripts = [];
  for (const [k, v] of meta) {
    if (k === 'title') metaHtml.push(`<title>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>`);
    else if (k === 'timeout' && v === 'long') metaHtml.push('<meta name="timeout" content="long">');
    else if (k === 'script') scripts.push(`<script src="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></script>`);
  }
  const global = kind === 'any'
    ? `<script>
self.GLOBAL = {
  isWindow: function() { return true; },
  isWorker: function() { return false; },
  isShadowRealm: function() { return false; },
};
</script>
`
    : '';
  return `<!doctype html>
<meta charset=utf-8>
${metaHtml.join('\n')}
${global}<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>
${scripts.join('\n')}
<div id=log></div>
<script src="${jsUrlPath}"></script>
`;
}

/**
 * Directory a test file of `test` lives in, and the file a script path of it resolves to: to-upstream tests
 * (`test.root === 'tuwpt'`) look in jsdom's to-upstream directory first, then in the WPT checkout (the wptserve
 * aliases of refs/jsdom/test/web-platform-tests/tuwpt-config.json).
 */
export function testRoot(test) {
  return test.root === 'tuwpt' ? TUWPT_ROOT : WPT_ROOT;
}
export function scriptFile(test, p) {
  if (test.root === 'tuwpt') {
    const local = path.join(TUWPT_ROOT, p);
    if (fs.existsSync(local)) return local;
  }
  return path.join(WPT_ROOT, p);
}

/** Resolves a script src against the test URL path; returns a WPT-root-relative path (or null if off-origin). */
export function resolveSrc(src, testUrlPath) {
  let u;
  try {
    u = new URL(src, ORIGIN + '/' + testUrlPath);
  } catch {
    return null;
  }
  if (u.origin !== ORIGIN) return null;
  let p = decodeURIComponent(u.pathname).replace(/^\//, '');
  if (p === 'resources/WebIDLParser.js') p = 'resources/webidl2/lib/webidl2.js';
  return p;
}

/** Lines of results/raw/<dom>.jsonl, or of the gzipped .jsonl.gz the repo keeps. */
export function readRawLines(dom) {
  const f = path.join(RESULTS, 'raw', `${dom}.jsonl`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').split('\n');
  if (fs.existsSync(f + '.gz')) return zlib.gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8').split('\n');
  return [];
}

/** Collapses whitespace and truncates to n characters. */
export const short = (s, n = 160) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** Normalises a failure message to a short cause ("missing global: X", "assert_equals: wrong value", ...). */
export function cause(msg) {
  let m = String(msg ?? '').replace(/\s+/g, ' ').trim();
  if (!m) return '(no message)';
  let r;
  // unwrap the real error from "assert_throws_*: ... threw object "TypeError: x is not defined"" and
  // "promise_test: Unhandled rejection with value: object "ReferenceError: ...""
  if ((r = /(?:threw object|Unhandled rejection with value: object) "(?:\w*Error|DOMException|\w+): ([^"]*)/.exec(m)) && !/^assert_/.test(r[1])) {
    const inner = cause(r[1]);
    if (/^(missing|not a|read of|write to|instanceof|Illegal|throws)/.test(inner)) return inner;
  }
  if ((r = /^(?:ReferenceError: )?([\w$.]+) is not defined/.exec(m))) return `missing global: ${r[1]}`;
  if ((r = /(?:^|\s)([\w$]+(?:\.[\w$]+)*)\.([\w$]+) is not a function/.exec(m))) return `missing method: .${r[2]}()`;
  if ((r = /(?:^|\s)([\w$.]+) is not a function/.exec(m))) return `not a function: ${r[1].split('.').pop()}`;
  if ((r = /([\w$.]+) is not a constructor/.exec(m))) return `not a constructor: ${r[1].split('.').pop()}`;
  if ((r = /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']*)'\)/.exec(m))) return `read of ${r[1]} (.${r[2]})`;
  if ((r = /Cannot set propert(?:y|ies) of (undefined|null) \(setting '([^']*)'\)/.exec(m))) return `write to ${r[1]} (.${r[2]})`;
  if ((r = /Failed to (execute|construct) '(\w+)'(?: on '(\w+)')?: (.*)/.exec(m))) {
    const what = r[1] === 'construct' ? `new ${r[2]}()` : `${r[3]}.${r[2]}()`;
    return `${what} throws: ${r[4].replace(/\(?'[^']*'\)?|"[^"]*"|\d+/g, '…').slice(0, 70)}`;
  }
  if (/Right-hand side of 'instanceof' is not (an object|callable)/.test(m)) return "instanceof against a missing interface";
  if (/Illegal constructor/i.test(m)) return 'Illegal constructor';
  if (/not implemented/i.test(m)) return 'throws "not implemented"';
  if ((r = /^(assert_\w+|promise_rejects_\w+)/.exec(m))) {
    if (/^assert_throws_dom: .*did not throw/.test(m)) return 'assert_throws_dom: did not throw';
    if (/^assert_throws_js: .*did not throw/.test(m)) return 'assert_throws_js: did not throw';
    if (/^assert_throws_dom/.test(m)) return 'assert_throws_dom: wrong exception';
    if (/^assert_throws_js/.test(m)) return 'assert_throws_js: wrong exception';
    if (/^assert_own_property|^assert_inherits|property .* not found/.test(m)) return `${r[1]} (missing property)`;
    if (/expected \(?undefined\)? undefined|got undefined|got \(undefined\) undefined/.test(m)) return `${r[1]}: got undefined (missing attribute/API)`;
    return `${r[1]}: wrong value`;
  }
  if (/Test timed out|^$/i.test(m)) return 'subtest timed out';
  return short(m.replace(/"[^"]*"|'[^']*'|\d+/g, '…'), 90);
}
