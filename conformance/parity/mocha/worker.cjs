'use strict';
// Runs ONE of jsdom's mocha test files (refs/jsdom/test/api/*.js, refs/jsdom/test/to-port-to-wpts/**/*.js)
// against ONE DOM in this (fresh) process and sends the result to the parent over IPC, in the same shape as
// conformance/wpt/worker.mjs: { id, dom, harness: { status, message }, subtests: [{ name, status, message }] }.
//
// Module redirection (Module._resolveFilename), so the files run unmodified:
// - `mocha-sugar-free` -> ./sugar-free.cjs (jsdom's suites only use its BDD interface);
// - jsdom's package entry (`require("../..")` from a test file resolves to refs/jsdom/lib/api.js)
//   -> jsdom: node_modules/jsdom (the same 30.1.3 the checkout is tagged at); rsdom: ./rsdom-jsdom.cjs;
// - any other refs/jsdom/lib/** file (a few tests import jsdom internals such as lib/jsdom/utils.js or
//   lib/generated/js-globals.json, which only exists in a built checkout) -> node_modules/jsdom/lib/**, for both DOMs.
//   Those internals run as jsdom code under rsdom too, so a file that only exercises them (no `new JSDOM`) says
//   nothing about rsdom: such files are marked skip in expectations/api.yaml;
// - `server-destroy` (one helper) -> a 10-line equivalent;
// - other bare requests from refs/jsdom (undici, tough-cookie, ...) resolve from the repository root, so a
//   refs/ checkout outside the repo (RSDOM_REFS, as scripts/fetch-refs.sh) shares this node_modules.
//
// Usage: node worker.cjs --print <dom> <file relative to refs/jsdom/test>      (debugging)
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const REPO = path.resolve(__dirname, '../../..');
// Real path: Node resolves modules to real paths, so a refs/ reached through a symlink (RSDOM_REFS, or a
// worktree's refs link) must be compared through its target.
const REFS = realpath(path.resolve(process.env.RSDOM_REFS || path.join(REPO, 'refs')));
const JSDOM_TEST = path.join(REFS, 'jsdom/test');
const REFS_LIB = path.join(REFS, 'jsdom/lib') + path.sep;
const REFS_ROOT = path.join(REFS, 'jsdom');
const NM_JSDOM = path.dirname(require.resolve('jsdom/package.json', { paths: [REPO] }));
const SUGAR_FREE = path.join(__dirname, 'sugar-free.cjs');
const ADAPTER = path.join(__dirname, 'rsdom-jsdom.cjs');
const SERVER_DESTROY = path.join(__dirname, 'server-destroy.cjs');
const FILE_TIMEOUT_MS = Number(process.env.PARITY_FILE_TIMEOUT_MS ?? 120_000);

const trunc = (s, n = 600) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function installRedirects(dom) {
  const orig = Module._resolveFilename;
  const mapLib = (abs) => {
    if (dom === 'rsdom' && (abs === REFS_LIB + 'api.js' || abs === REFS_LIB + 'api')) return ADAPTER;
    return path.join(NM_JSDOM, 'lib', abs.slice(REFS_LIB.length));
  };
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mocha-sugar-free') return SUGAR_FREE;
    if (request === 'server-destroy') return SERVER_DESTROY;
    if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../') || request === '..' || request === '.')) {
      const abs = path.resolve(path.dirname(parent.filename), request);
      if (abs === REFS_ROOT) return mapLib(REFS_LIB + 'api.js');
      if (abs.startsWith(REFS_LIB)) return orig.call(this, mapLib(abs), parent, isMain, options);
    } else if (parent?.filename?.startsWith(REFS_ROOT + path.sep) && !path.isAbsolute(request) && !options?.paths) {
      return orig.call(this, request, parent, isMain, { paths: [REPO] });
    }
    return orig.call(this, request, parent, isMain, options);
  };
}

async function runOne(dom, test) {
  const t0 = performance.now();
  const out = { id: test.id, dom, harness: null, subtests: [], scriptErrors: [], notes: [] };
  installRedirects(dom);
  const runner = require(SUGAR_FREE);
  const file = path.join(JSDOM_TEST, test.file);
  try {
    require(file);
  } catch (e) {
    out.harness = { status: 'ERROR', message: trunc(e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : e) };
    return out;
  }
  const timer = setTimeout(() => {
    fs.writeSync(2, `file timeout after ${FILE_TIMEOUT_MS} ms\n`);
    process.exit(3);
  }, FILE_TIMEOUT_MS);
  timer.unref();
  out.subtests = await runner.run();
  out.harness = { status: 'OK', message: '' };
  out.ms = { total: Math.round(performance.now() - t0) };
  return out;
}

const argv = process.argv.slice(2);
if (argv[0] === '--print') {
  const [, dom, file] = argv;
  runOne(dom, { id: file, file }).then((r) => {
    fs.writeSync(1, JSON.stringify(r, null, 2) + '\n');
    process.exit(0);
  });
} else if (process.send) {
  process.once('message', async ({ dom, test }) => {
    let r;
    try {
      r = await runOne(dom, test);
    } catch (e) {
      r = { id: test.id, dom, harness: { status: 'RUNNER_ERROR', message: trunc(e && e.stack) }, subtests: [], scriptErrors: [], notes: [] };
    }
    process.send(r, () => process.exit(0));
  });
}
