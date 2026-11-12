// Runs ONE WPT test file against ONE DOM in Vitest-style "global-install mode", in this (fresh) process,
// and sends the result to the parent over IPC (or prints it with --print).
//
// The page is executed the way a Vitest test file would touch the DOM:
//   1. the DOM is installed on globalThis by its Vitest environment object (jsdom / happy-dom: vitest's
//      builtinEnvironments; oxidom: packages/oxidom/lib/vitest-environment.mjs), with the test URL as environment url;
//   2. the page's markup is loaded with `document.documentElement.innerHTML = <inner HTML of the parsed
//      <html>>` (+ the <html> attributes) — identical for all three DOMs; scripts inserted this way do not run;
//   3. testharness.js and every classic <script> of the page (inline or src, same-origin files from the WPT
//      checkout) run IN DOCUMENT ORDER with vm.runInThisContext, i.e. in the Node realm, like test code;
//   4. DOMContentLoaded (document) and load (window) are dispatched after the last script;
//      (before the scripts, a getter per element id of the markup emulates window named access);
//   5. results come from testharness's add_result_callback / add_completion_callback; setup() gets
//      {output:false, explicit_timeout:true} and we call timeout() ourselves after TIMEOUT_MS.
//
// Usage: node worker.mjs --print <dom> [wpt:|tuwpt:]<test-id>   (debugging; the runner forks it with IPC instead)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { LAB, ORIGIN, readScriptMeta, wrapperPage, resolveSrc, appRequire, RESULTS, readJSON, testRoot, scriptFile } from './lib.mjs';

const nodeSetTimeout = globalThis.setTimeout;
const nodeClearTimeout = globalThis.clearTimeout;
const TIMEOUT_MS = Number(process.env.WPT_TIMEOUT_MS ?? 10_000);
const parse5 = appRequire('parse5');

const trunc = (s, n = 400) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** Extracts the classic scripts (document order) and the <html> element's attrs + inner HTML. */
function analysePage(html, urlPath) {
  const doc = parse5.parse(html);
  const htmlEl = doc.childNodes.find((n) => n.nodeName === 'html');
  const scripts = [];
  const ids = [];
  (function walk(n, inTemplate) {
    for (const c of n.childNodes ?? []) {
      if (!inTemplate && c.attrs) {
        const id = c.attrs.find((a) => a.name === 'id');
        if (id && /^[A-Za-z_$][\w$]*$/.test(id.value)) ids.push(id.value);
      }
      if (c.nodeName === 'script' && !inTemplate) {
        const attrs = Object.fromEntries(c.attrs.map((a) => [a.name, a.value]));
        const type = (attrs.type ?? '').trim().toLowerCase();
        const classic = type === '' || /^(text|application)\/(x-)?(java|ecma)script$/.test(type);
        if (classic) {
          if (attrs.src !== undefined) scripts.push({ src: attrs.src, path: resolveSrc(attrs.src, urlPath) });
          else scripts.push({ inline: c.childNodes.map((t) => t.value ?? '').join('') });
        }
      }
      if (c.content) walk(c.content, true);
      walk(c, inTemplate);
    }
  })(doc, false);
  return {
    htmlAttrs: htmlEl.attrs.map((a) => [a.name, a.value]),
    inner: parse5.serialize(htmlEl),
    scripts,
    ids: [...new Set(ids)],
    hasDoctype: doc.childNodes.some((n) => n.nodeName === '#documentType'),
  };
}

async function loadEnv(dom) {
  if (dom === 'oxidom') return (await import(pathToFileURL(path.join(LAB, 'packages/oxidom/lib/vitest-environment.mjs')).href)).default;
  const rt = await import(pathToFileURL(path.join(LAB, 'node_modules/vitest/dist/runtime.js')).href);
  return rt.builtinEnvironments[dom];
}

/** testharnessreport.js replacement: hooks results; mirrors refs/jsdom/test/web-platform-tests/run-single-wpt.js. */
function installReporter(state) {
  const g = globalThis;
  g.setup({ output: false, explicit_timeout: true });
  const oldSetup = g.setup;
  g.setup = function (opts, ...rest) {
    if (opts && typeof opts === 'object' && opts.allow_uncaught_exception) state.allowUncaught = true;
    return oldSetup.call(this, opts, ...rest);
  };
  // Cross-realm assert_throws_js / promise_rejects_js (jsdom's own WPT runner installs the same shim, see
  // jsdom#2727): compare the thrown error's .name instead of instanceof. Applied identically to all DOMs.
  function assertThrowsJSImpl(constructor, func, description, assertionType) {
    try {
      func.call(this);
      g.assert_true(false, `${assertionType}: ${description}: ${func} did not throw`);
    } catch (e) {
      if (e instanceof g.AssertionError) throw e;
      g.assert_true(typeof e === 'object', `${assertionType}: ${description}: ${func} threw ${e} with type ${typeof e}, not an object`);
      g.assert_true(e !== null, `${assertionType}: ${description}: ${func} threw null, not an object`);
      g.assert_true(typeof constructor === 'function', `${assertionType}: ${description}: ${constructor} is not a constructor`);
      let obj = constructor;
      while (obj) {
        if (typeof obj === 'function' && obj.name === 'Error') break;
        obj = Object.getPrototypeOf(obj);
      }
      g.assert_true(obj !== null && obj !== undefined, `${assertionType}: ${description}: ${constructor} is not an Error subtype`);
      g.assert_equals(e.name, constructor.name, `${assertionType}: ${description}: ${func} threw ${e} (${e.name}) expected instance of ${constructor.name}`);
    }
  }
  g.assert_throws_js = (c, f, d) => assertThrowsJSImpl(c, f, d, 'assert_throws_js');
  g.promise_rejects_js = (test, expected, promise, description) => promise
    .then(test.unreached_func('Should have rejected: ' + description))
    .catch((e) => assertThrowsJSImpl(expected, () => { throw e; }, description, 'promise_reject_js'));
  g.add_result_callback((t) => {
    state.results.set(t.name, { name: t.name, status: t.status, message: trunc(t.message) });
  });
  g.add_completion_callback((tests, hs) => {
    for (const t of tests) state.results.set(t.name, { name: t.name, status: t.status, message: trunc(t.message) });
    state.harness = { status: hs.status, message: trunc(hs.message) };
    state.done?.();
  });
  state.reporterInstalled = true;
}

/** Reports an uncaught error to the page the way a browser would: an "error" event on window. */
function reportError(state, e, kind = 'error') {
  state.scriptErrors.push(trunc(`${kind}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 2).join(' | ') : e}`, 300));
  if (kind === 'error' && e !== undefined && state.windowErrors.delete(e)) return;
  try {
    let ev;
    if (kind === 'unhandledrejection') {
      ev = new globalThis.Event('unhandledrejection', { cancelable: true });
      Object.defineProperty(ev, 'reason', { value: e });
    } else if (typeof globalThis.ErrorEvent === 'function') {
      ev = new globalThis.ErrorEvent('error', { message: String(e && e.message ? e.message : e), error: e, cancelable: true });
    } else {
      ev = new globalThis.Event('error', { cancelable: true });
      Object.defineProperty(ev, 'message', { value: String(e && e.message ? e.message : e) });
      Object.defineProperty(ev, 'error', { value: e });
    }
    globalThis.dispatchEvent(ev);
  } catch (err) {
    state.scriptErrors.push(trunc(`could not dispatch ${kind} event: ${err && err.message}`, 200));
  }
}

const STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
const HSTATUS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];

export async function runOne(dom, test) {
  const t0 = performance.now();
  const state = { results: new Map(), harness: null, scriptErrors: [], allowUncaught: false, reporterInstalled: false, windowErrors: new Set() };
  const out = { id: test.id, dom, harness: null, subtests: [], scriptErrors: state.scriptErrors, notes: [] };
  process.on('uncaughtException', (e) => reportError(state, e, 'error'));
  process.on('unhandledRejection', (e) => reportError(state, e, 'unhandledrejection'));

  // --- page ---
  const abs = path.join(testRoot(test), test.file);
  const src = fs.readFileSync(abs, 'utf8');
  const page = test.kind === 'html' ? src : wrapperPage(test.kind, '/' + test.file, readScriptMeta(src));
  const pg = analysePage(page, test.id);

  // --- environment ---
  const url = ORIGIN + '/' + test.id;
  let envRet;
  try {
    const env = await loadEnv(dom);
    envRet = await env.setup(globalThis, { jsdom: { url }, happyDOM: { url }, oxidom: { url } });
  } catch (e) {
    out.harness = { status: 'SETUP_ERROR', message: trunc(e && e.stack) };
    return out;
  }
  const tSetup = performance.now();
  // An error the DOM already reported to the window is not dispatched there a second time: oxidom's "report an
  // exception" fires the window's ErrorEvent and then emits uncaughtException (what Vitest needs to fail a test),
  // which would otherwise reach the window again through reportError (DESIGN §28).
  try {
    globalThis.addEventListener('error', (ev) => state.windowErrors.add(ev.error), true);
  } catch {}

  try {
    const de = globalThis.document.documentElement;
    for (const [k, v] of pg.htmlAttrs) de.setAttribute(k, v);
    de.innerHTML = pg.inner;
  } catch (e) {
    out.notes.push('markup load failed: ' + trunc(e && e.message, 200));
  }

  // Named access (window[id]): browsers expose elements with an id as window properties, and many WPT pages
  // use them as bare identifiers. Vitest's global install does not mirror them onto globalThis for any DOM,
  // so the harness adds a getter per id present in the markup (resolved with the DOM's own getElementById),
  // identically for the three DOMs. Assigning / declaring the name replaces the getter with a plain value.
  for (const id of pg.ids) {
    if (id in globalThis) continue;
    Object.defineProperty(globalThis, id, {
      configurable: true,
      enumerable: false,
      get: () => globalThis.document.getElementById(id) ?? undefined,
      set: (v) => Object.defineProperty(globalThis, id, { value: v, writable: true, configurable: true, enumerable: true }),
    });
  }

  const completion = new Promise((resolve) => { state.done = resolve; });
  // --- scripts, in order ---
  const hasReport = pg.scripts.some((s) => s.path === 'resources/testharnessreport.js');
  for (const s of pg.scripts) {
    if (s.path === 'resources/testharnessreport.js') {
      if (!state.reporterInstalled && typeof globalThis.add_completion_callback === 'function') {
        try { installReporter(state); } catch (e) { reportError(state, e); }
      }
      continue;
    }
    let code;
    let filename;
    if (s.inline !== undefined) {
      code = s.inline;
      filename = url + '#inline';
    } else {
      filename = ORIGIN + '/' + s.path;
      try {
        code = fs.readFileSync(scriptFile(test, s.path), 'utf8');
      } catch {
        state.scriptErrors.push('missing script ' + s.path);
        continue;
      }
    }
    try {
      vm.runInThisContext(code, { filename });
    } catch (e) {
      reportError(state, e);
    }
    if (s.path === 'resources/testharness.js' && !hasReport && typeof globalThis.add_completion_callback === 'function') {
      try { installReporter(state); } catch (e) { reportError(state, e); }
    }
  }
  if (!state.reporterInstalled) out.notes.push('testharness reporter not installed');

  // --- end of parsing ---
  try {
    globalThis.document.dispatchEvent(new globalThis.Event('DOMContentLoaded', { bubbles: true }));
  } catch (e) {
    reportError(state, e);
  }
  try {
    globalThis.dispatchEvent(new globalThis.Event('load'));
  } catch (e) {
    reportError(state, e);
  }

  // --- wait ---
  const race = (ms) => new Promise((r) => { const h = nodeSetTimeout(() => r('timeout'), ms); completion.then(() => { nodeClearTimeout(h); r('done'); }); });
  let how = state.reporterInstalled ? await race(TIMEOUT_MS) : 'no-reporter';
  if (how === 'timeout') {
    out.notes.push('harness timeout() called after ' + TIMEOUT_MS + ' ms');
    try { globalThis.timeout(); } catch (e) { out.notes.push('timeout() threw ' + trunc(e && e.message, 100)); }
    how = await race(1500);
    if (how === 'timeout') out.notes.push('no completion after timeout()');
  }
  // some tests keep doing things after done(); give them a tick, like jsdom's runner (process.nextTick)
  await new Promise((r) => nodeSetTimeout(r, 0));

  out.harness = state.harness
    ? { status: HSTATUS[state.harness.status] ?? String(state.harness.status), message: state.harness.message }
    : { status: how === 'no-reporter' ? 'NO_HARNESS' : 'NO_COMPLETION', message: '' };
  out.subtests = [...state.results.values()].map((r) => ({ name: r.name, status: STATUS[r.status] ?? String(r.status), message: r.message }));
  out.ms = { setup: Math.round(tSetup - t0), total: Math.round(performance.now() - t0) };
  try {
    await Promise.race([envRet.teardown(globalThis), new Promise((r) => nodeSetTimeout(r, 3000))]);
  } catch (e) {
    out.notes.push('teardown threw: ' + trunc(e && e.message, 150));
  }
  return out;
}

// ---- entry ----
const argv = process.argv.slice(2);
if (argv[0] === '--print') {
  const [, dom, arg] = argv;
  const sel = readJSON(path.join(RESULTS, 'selection.json'));
  // a few to-upstream ids are also WPT ids; `tuwpt:<id>` (or `wpt:<id>`) picks the list, as in conformance/parity
  const [, source, id] = /^(?:(wpt|tuwpt):)?(.*)$/.exec(arg);
  const wpt = source === 'tuwpt' ? undefined : sel.tests.find((t) => t.id === id);
  const tuwpt = source === 'wpt' ? undefined : sel.toUpstream?.tests.find((t) => t.id === id);
  if (wpt && tuwpt) console.error(`worker: ${id} is in wpt and tuwpt; running wpt (--print ${dom} tuwpt:${id} for the other)`);
  const test = wpt ?? tuwpt;
  if (!test) throw new Error('unknown test ' + arg);
  const r = await runOne(dom, test);
  fs.writeSync(1, JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
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
