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
export const JSDOM_WPT = path.join(LAB, 'refs/jsdom/test/web-platform-tests');
/** Sparse checkout of web-platform-tests at the commit jsdom pins (see README.md). */
export const WPT_ROOT = process.env.WPT_ROOT ?? path.join(LAB, 'refs/wpt');
export const WPT_COMMIT = '2971340498805350babb6c167e0df98eaa380f98';
export const DOMS = ['jsdom', 'happy-dom', 'rsdom'];
/** Origin the test pages pretend to be served from (passed to every environment as its URL). */
export const ORIGIN = 'http://web-platform.test:8000';

export const appRequire = createRequire(path.join(LAB, 'e2e/react-app/package.json'));
export const rsdomRequire = createRequire(path.join(LAB, 'packages/rsdom/package.json'));

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
