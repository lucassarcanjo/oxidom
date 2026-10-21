// AREA C (DESIGN §12, ROADMAP M6): the rsdom Vitest environment. Referenced by e2e/react-app/vitest.config.ts
// (DOM_ENV=rsdom) as a path, so Vite inlines this file: the facade (.cjs) and the addon (.node) are loaded
// through createRequire (Node's own loader, one CJS instance per worker thread / process), never through a
// static import. Tests reach rsdom only through the globals installed here.
//
// Lifecycle (Vitest 5, docs/lab/research/vitest-env.md §3): `setup()` runs once per worker before Vitest's own
// globals, safe timers and console exist and before any setup/test file is imported; `teardown()` runs when
// the worker stops (isolate: true -> once per file; isolate: false -> once per worker).
//
// Options: `test.environmentOptions.jetdom = { url, html, shared, memo, prefilter, counters }`. The env vars
// RSDOM_SHARED=0 / RSDOM_NO_MEMO=1 / RSDOM_NO_PREFILTER=1 / RSDOM_COUNTERS=1 win over the options (the facade
// reads them once, when it is first loaded in this worker). `jetdom.html` is body markup.
//
// `test.environmentOptions.jsdom` (ROADMAP Stage 2) is read as Vitest's jsdom environment reads it, so a
// config written for jsdom works unchanged: `url`, `html` (a whole document, default `<!DOCTYPE html>`),
// `userAgent` (or `resources.userAgent`), `pretendToBeVisual` (default true), `contentType` (HTML only),
// `console`, `referrer`, `storageQuota`. `cookieJar`, `runScripts`, `includeNodeLocations` and `beforeParse` are
// ignored: scripts in `html` do not run, where Vitest's jsdom default (`runScripts: 'dangerously'`) runs them.
// A `jetdom` key wins over the `jsdom` one.
//
// As in Vitest's jsdom environment, the window has a virtual console forwarding to the console (jsdom's
// default whether `console` is set or not): not-implemented window methods (`alert`, `scrollTo`, ...) log
// "Not implemented: ..." through `console.error`. The global `jsdom` is a `JSDOM` for the window
// (`jsdom.reconfigure({ url })`, `jsdom.serialize()`).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Maps `options.jetdom` onto the facade's env-var switches unless the env var is already set. */
function applyOptions(o) {
  const env = process.env;
  const set = (k, v) => {
    if (env[k] === undefined) env[k] = v;
  };
  if (o.shared === false) set('RSDOM_SHARED', '0');
  if (o.memo === false) set('RSDOM_NO_MEMO', '1');
  if (o.prefilter === false) set('RSDOM_NO_PREFILTER', '1');
  if (o.counters === true) set('RSDOM_COUNTERS', '1');
  if (env.RSDOM_COUNTERS === '1' && env.RSDOM_NATIVE === undefined) {
    // The counters build (`npm run build:counters`) lives next to the default addon.
    const dir = path.join(path.dirname(require.resolve('./native.cjs')), '..', 'native', 'counters');
    const file = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.node')) : undefined;
    if (file === undefined) {
      throw new Error('rsdom: RSDOM_COUNTERS=1 needs the counters build; run `npm run build:counters` in packages/rsdom/.');
    }
    env.RSDOM_NATIVE = path.join(dir, file);
  }
}

/** Appends this worker's counters as one JSON line to $RSDOM_COUNTERS_OUT (bench build). */
function dumpCounters(rt) {
  const out = process.env.RSDOM_COUNTERS_OUT;
  if (!out) return;
  let files = [];
  try {
    files = (globalThis.__vitest_worker__?.ctx?.files ?? []).map((f) => (typeof f === 'string' ? f : f.filepath));
  } catch {
    // best effort
  }
  const { threadId } = require('node:worker_threads');
  const line = JSON.stringify({ pid: process.pid, threadId, files, counters: JSON.parse(rt.N.counters()) });
  fs.appendFileSync(out, line + '\n');
}

/**
 * `context.open()` options from `environmentOptions.jetdom` (`o`) and `environmentOptions.jsdom` (`j`), with
 * the defaults of Vitest's jsdom environment (node_modules/vitest/dist/chunks/index.*.js `jsdom.setup`).
 */
function contextOptions(o, j, api) {
  api.checkContentType(j.contentType);
  const virtualConsole = j.virtualConsole ?? new api.VirtualConsole().forwardTo(globalThis.console);
  if (!(virtualConsole instanceof api.VirtualConsole)) {
    throw new TypeError('virtualConsole must be an instance of VirtualConsole');
  }
  const userAgent = j.userAgent ?? j.resources?.userAgent;
  const open = {
    url: o.url ?? (j.url === undefined ? undefined : new URL(j.url).href),
    settings: {
      pretendToBeVisual: j.pretendToBeVisual === undefined ? true : Boolean(j.pretendToBeVisual),
      storageQuota: j.storageQuota === undefined ? 5000000 : Number(j.storageQuota),
      userAgent: userAgent === undefined ? null : String(userAgent),
      referrer: j.referrer === undefined ? '' : new URL(j.referrer).href,
      virtualConsole,
    },
  };
  // `jetdom.html` is body markup; `jsdom.html` a whole document (Vitest's default is a bare doctype)
  if (o.html !== undefined) open.html = o.html;
  else if (j.html !== undefined) open.source = String(j.html);
  return { open, virtualConsole };
}

export default {
  name: 'rsdom',
  viteEnvironment: 'client',
  prewarmModules: false,
  setup(global, options = {}) {
    const o = options.jetdom ?? {};
    applyOptions(o);
    const { rt } = require('./index.cjs'); // installs every area
    const context = require('./context.cjs');
    const api = require('./jsdom.cjs');
    if (process.env.RSDOM_COUNTERS === '1') rt.N.countersReset();

    // A browsing context on `global` (DESIGN §18). window.cjs records the original descriptor of every global
    // it defines (only those: reading all of globalThis would trigger Node's lazy getters); the context's
    // close() puts them back, after cancelling its timers and removing Vitest's error routing.
    const { open, virtualConsole } = contextOptions(o, options.jsdom ?? {}, api);
    const ctx = context.open({ ...open, global, catchErrors: true });
    const hadJsdom = Object.prototype.hasOwnProperty.call(global, 'jsdom');
    const jsdomBefore = global.jsdom;
    global.jsdom = api.adopt(ctx, virtualConsole);

    return {
      teardown() {
        if (process.env.RSDOM_COUNTERS === '1') dumpCounters(rt);
        if (hadJsdom) global.jsdom = jsdomBefore;
        else delete global.jsdom;
        ctx.close();
        // Drops the whole DOM in one call (no per-node finalizers) and leaves a fresh env behind; every
        // wrapper handed out before is neutered.
        rt.reset();
      },
    };
  },
};
