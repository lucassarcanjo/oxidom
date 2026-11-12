// Shared helpers of the micro benchmark harness (bench/micro/run.mjs).
//
// DOM adapter: `windowFor(kind)` creates a window WITHOUT globals (test/contract/adapter.cjs, the same
// construction the contract suite uses); `installGlobalEnv(kind)` installs the DOM on globalThis exactly like
// the Vitest environments do (jsdom / happy-dom: Vitest's builtin environments; oxidom: packages/oxidom/lib/vitest-environment.mjs),
// for benches that run library code reading globals (React, Testing Library) and for the env-setup bench.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root. */
export const oxidomRoot = path.resolve(here, '../..');
export const appRoot = path.join(oxidomRoot, 'e2e/react-app');
const require = createRequire(import.meta.url);

/** Samples per measurement (median reported); OXIDOM_BENCH_SAMPLES overrides (>= 7 for reported numbers). */
export const SAMPLES = Math.max(1, Number(process.env.OXIDOM_BENCH_SAMPLES ?? 7));

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Relative spread (max-min)/median of samples, for the JSON output. */
export function spread(xs) {
  const m = median(xs);
  return m === 0 ? 0 : (Math.max(...xs) - Math.min(...xs)) / m;
}

/**
 * Target duration of one timed sample (OXIDOM_BENCH_TARGET_MS, default 100 ms). Iteration counts are
 * calibrated per DOM from the second warm-up call (tinybench / mitata style) so a sample is long enough
 * for timer, GC and table-growth noise to average out on the fast DOM and short enough on the slow one:
 * a fixed count made oxidom's samples ~12 ms and jsdom's ~2.6 s for the same row (M9 review).
 */
export const TARGET_NS = Number(process.env.OXIDOM_BENCH_TARGET_MS ?? 100) * 1e6;
/** Upper bound on scaling the nominal count up (bounds memory: oxidom does not reclaim nodes in an env). */
const MAX_SCALE = 20;

function calibrated(iters, warm, warmNs) {
  const per = Math.max(warmNs / warm, 1);
  return Math.max(1, Math.min(iters * MAX_SCALE, Math.ceil(TARGET_NS / per)));
}

/**
 * Measures `fn(k)`: two warm-up calls of `iters / 4` (the second one timed for calibration), then SAMPLES
 * timed calls of the calibrated count. Returns { value: median ns per iteration, samples, iters }.
 */
export function bench(iters, fn) {
  const warm = Math.max(1, iters >> 2);
  fn(warm);
  const w0 = process.hrtime.bigint();
  fn(warm);
  const k = calibrated(iters, warm, Number(process.hrtime.bigint() - w0));
  const samples = [];
  for (let r = 0; r < SAMPLES; r++) {
    const t0 = process.hrtime.bigint();
    fn(k);
    samples.push(Number(process.hrtime.bigint() - t0) / k);
  }
  return { value: median(samples), samples, iters: k };
}

/** Async variant of `bench` for awaited bodies (MutationObserver delivery). */
export async function benchAsync(iters, fn) {
  const warm = Math.max(1, iters >> 2);
  await fn(warm);
  const w0 = process.hrtime.bigint();
  await fn(warm);
  const k = calibrated(iters, warm, Number(process.hrtime.bigint() - w0));
  const samples = [];
  for (let r = 0; r < SAMPLES; r++) {
    const t0 = process.hrtime.bigint();
    await fn(k);
    samples.push(Number(process.hrtime.bigint() - t0) / k);
  }
  return { value: median(samples), samples, iters: k };
}

/** A window without globals (same construction as the contract suite). */
export function windowFor(kind) {
  const { makeWindow } = require('../../packages/oxidom/test/contract/adapter.cjs');
  return makeWindow(kind);
}

/**
 * Installs `kind` on globalThis the way its Vitest environment does; returns { teardown, ms, importMs,
 * setupMs }. The same starting point for every DOM (M9 review):
 * - vitest/dist/runtime.js is imported BEFORE t0 for all three DOMs (a Vitest worker has loaded it before
 *   any environment; it used to be timed for jsdom / happy-dom only);
 * - Node's lazy web globals (undici: FormData, fetch, ...) are NOT preloaded: in a real worker the first
 *   FormData access happens inside every environment's setup(), so it is part of each DOM's cost.
 * `importMs` is the environment module import (oxidom: packages/oxidom/lib/vitest-environment.mjs + the facade + the addon;
 * jsdom / happy-dom: nothing, their builtin environments import the package inside setup()), so only the
 * total is comparable across DOMs. The authoritative number is the `env-vitest` case (Vitest's own phase).
 */
export async function installGlobalEnv(kind) {
  const rt = await import(pathToFileURL(path.join(oxidomRoot, 'node_modules/vitest/dist/runtime.js')).href);
  const t0 = performance.now();
  let env;
  if (kind === 'oxidom') {
    env = (await import(pathToFileURL(path.join(oxidomRoot, 'packages/oxidom/lib/vitest-environment.mjs')).href)).default;
  } else {
    env = rt.builtinEnvironments[kind];
  }
  const t1 = performance.now();
  const r = await env.setup(globalThis, {});
  const t2 = performance.now();
  return { teardown: () => r.teardown(globalThis), ms: t2 - t0, importMs: t1 - t0, setupMs: t2 - t1 };
}

/** `require` resolving from e2e/react-app (React, Testing Library; hoisted to the root node_modules). */
export function appRequire() {
  return createRequire(path.join(appRoot, 'package.json'));
}

/** A benchmark that cannot run on this DOM / branch (reported as n/a with the reason). */
export class NA extends Error {}

/** Throws NA unless `cond`. */
export function need(cond, why) {
  if (!cond) throw new NA(why);
}

/** The aria-query role selectors DTL generates (data/role-selectors.txt). */
export function roleSelectors() {
  return fs.readFileSync(path.join(oxidomRoot, 'crates/oxidom/data/role-selectors.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** HTML of an n-row data table like the app's DataTable (header + rows with inputs and buttons). */
export function tableHTML(rows) {
  let s = '<table class="data"><caption>Users</caption><thead><tr><th scope="col">Name</th><th scope="col">Email</th>'
    + '<th scope="col">Role</th><th scope="col">Actions</th></tr></thead><tbody>';
  for (let i = 0; i < rows; i++) {
    s += `<tr data-row="${i}" class="${i & 1 ? 'odd' : 'even'}"><td class="cell">User ${i}</td>`
      + `<td><a href="mailto:u${i}@x.io">u${i}@x.io</a></td><td><span role="status">${i % 3 ? 'member' : 'admin'}</span></td>`
      + `<td><input type="checkbox" aria-label="Select ${i}"><button type="button">Edit</button></td></tr>`;
  }
  return s + '</tbody></table>';
}
