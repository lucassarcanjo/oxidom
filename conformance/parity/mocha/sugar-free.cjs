'use strict';
// A small BDD runner with the `mocha-sugar-free` interface, so jsdom's own mocha suites (refs/jsdom/test/api,
// refs/jsdom/test/to-port-to-wpts) run without mocha. Semantics follow mocha 12 + mocha-sugar-free 1.4 (jsdom's
// devDependencies):
// - `describe|it|specify|before|after|beforeEach|afterEach(title?, options?, fn?)`, arguments in any order;
//   `.skip` / `.only` variants (`.only` behaves like a plain call: the parity suite always runs everything);
//   a hook with `options.skip` is not registered;
// - the callback gets a context `{ skip, timeout, slow, enableTimeouts, done }` instead of `this`;
//   `options.async` makes the test wait for `context.done(err?)` (a falsy `err` passes), otherwise a returned
//   thenable is awaited;
// - default timeout 2000 ms (mocha's; jsdom has no .mocharc), `options.timeout` / `context.timeout(ms)` /
//   a suite's `context.timeout(ms)` override it, 0 disables it;
// - `context.skip()` in a test or a `beforeEach` hook skips that test, in a `before` hook every test of the suite;
// - a failing `before` hook: no test of its suite runs (`after` hooks still do); a failing `beforeEach` or
//   `afterEach` hook: the current test fails and none of the remaining tests of the hook's suite run.
//   Tests mocha does not run are recorded as FAIL with the hook's error (mocha reports only the hook);
// - an uncaught exception or unhandled rejection while a runnable is active fails that runnable.
//
// Result names are the titles from the outermost describe down, joined with " > " (duplicates get " (2)", ...).

const DEFAULT_TIMEOUT = 2000;
const SKIP = Symbol('skip');

class Suite {
  constructor(title, parent) {
    this.title = title;
    this.parent = parent;
    this.suites = [];
    this.tests = [];
    this.hooks = { before: [], after: [], beforeEach: [], afterEach: [] };
    this.timeout = parent ? parent.timeout : DEFAULT_TIMEOUT;
    this.skip = parent ? parent.skip : false;
  }
}

const root = new Suite('', null);
let current = root;

function parseArgs(args) {
  const o = {};
  for (const a of args) {
    if (typeof a === 'string') o.title = a;
    else if (typeof a === 'function') o.fn = a;
    else if (a && typeof a === 'object') Object.assign(o, a);
  }
  return o;
}

function skips(o) {
  return !!(o.skip || o.skipUnlessBrowser);
}

function describe(...args) {
  const o = parseArgs(args);
  const s = new Suite(o.title ?? '', current);
  if (o.timeout !== undefined) s.timeout = o.timeout;
  if (skips(o)) s.skip = true;
  current.suites.push(s);
  const prev = current;
  current = s;
  try {
    if (o.fn) {
      o.fn({
        isSuite: true,
        timeout(ms) {
          s.timeout = ms;
        },
        slow() {},
        enableTimeouts(on) {
          if (!on) s.timeout = 0;
        },
        skip() {
          s.skip = true;
        },
      });
    }
  } finally {
    current = prev;
  }
}
describe.skip = (...args) => describe(...args, { skip: true });
describe.only = describe;

function it(...args) {
  const o = parseArgs(args);
  current.tests.push({ title: o.title ?? '', fn: o.fn, opts: o, skip: current.skip || skips(o) || !o.fn, suite: current });
}
it.skip = (...args) => it(...args, { skip: true });
it.only = it;

function hook(kind) {
  return (...args) => {
    const o = parseArgs(args);
    if (o.fn && !skips(o)) current.hooks[kind].push({ fn: o.fn, opts: o });
  };
}

// ---------------------------------------------------------------------------------------------- running

/** The runnable currently executing: uncaught errors are routed to it. */
let active = null;

function onUncaught(err) {
  if (active) active(err === SKIP || err instanceof Error ? err : new Error(String(err)));
}

/**
 * Runs one test or hook function; resolves to undefined (passed), SKIP, or the error.
 * @param {Function} fn
 * @param {object} opts the parsed mocha-sugar-free options
 * @param {number} suiteTimeout
 */
function runFn(fn, opts, suiteTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      active = null;
      resolve(v);
    };
    let timeout = opts.timeout ?? suiteTimeout;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = timeout > 0 ? setTimeout(() => finish(Object.assign(new Error(`Timeout of ${timeout}ms exceeded`), { timeout: true })), timeout) : null;
    };
    const ctx = {
      isTest: true,
      skip() {
        throw SKIP;
      },
      timeout(ms) {
        timeout = ms;
        arm();
      },
      slow() {},
      enableTimeouts(on) {
        if (!on) {
          timeout = 0;
          arm();
        }
      },
      done: opts.async ? (err) => finish(!err ? undefined : err instanceof Error ? err : new Error(String(err))) : undefined,
    };
    active = finish;
    arm();
    try {
      const r = fn(ctx);
      if (!opts.async) {
        if (r && typeof r.then === 'function') r.then(() => finish(undefined), (e) => finish(e === SKIP ? SKIP : e ?? new Error('rejected')));
        else finish(undefined);
      }
    } catch (e) {
      finish(e);
    }
  });
}

function errMessage(e) {
  if (e === SKIP) return '';
  const s = e && e.stack ? String(e.stack) : String(e);
  const lines = s.split('\n');
  const msg = e && e.message !== undefined ? String(e.message) : lines[0];
  // first stack frame inside jsdom's test tree, for orientation (path relative to <refs>/jsdom/test)
  const frame = lines.find((l) => /jsdom\/test\//.test(l))?.replace(/\(?[^\s(]*jsdom\/test\//, '(');
  return (msg + (frame ? ' | ' + frame.trim() : '')).replace(/\s*\n\s*/g, ' ').slice(0, 600);
}

function titlePath(suite, title) {
  const parts = [];
  for (let s = suite; s; s = s.parent) if (s.title) parts.unshift(s.title);
  if (title !== undefined) parts.push(title);
  return parts.join(' > ');
}

function hasTests(s) {
  return s.tests.length > 0 || s.suites.some(hasTests);
}

/** Runs every collected test; resolves to [{ name, status: PASS|FAIL|TIMEOUT|SKIP, message }]. */
async function run() {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  const results = [];
  const seen = new Map();
  const record = (suite, title, status, message = '') => {
    let name = titlePath(suite, title);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name += ` (${n})`;
    results.push({ name, status, message });
  };
  const statusOf = (e) => (e === undefined ? 'PASS' : e === SKIP ? 'SKIP' : e && e.timeout ? 'TIMEOUT' : 'FAIL');
  /** Records the tests of `s` without running them: skipped ones as SKIP, the others as `status`. */
  const recordAll = (s, status, msg = '') => {
    for (const t of s.tests) {
      const skipped = s.skip || t.skip;
      record(s, t.title, skipped ? 'SKIP' : status, skipped ? '' : msg);
    }
    for (const c of s.suites) recordAll(c, status, msg);
  };
  /** { suite, msg } once an each-hook of `suite` failed: mocha runs none of that suite's remaining tests. */
  let abort = null;
  // Failures while handling one come from that suite or an outer one (the "after each" hooks above it).
  const abortSuite = (suite, msg) => {
    if (abort?.suite !== suite) abort = { suite, msg };
  };

  /** Runs `list` in order up to the first hook that fails or skips; resolves to its error or SKIP. */
  async function runHooks(list, suiteTimeout) {
    for (const h of list) {
      const e = await runFn(h.fn, h.opts, suiteTimeout);
      if (e !== undefined) return e;
    }
    return undefined;
  }
  /** mocha's hookDown: the beforeEach hooks from the root down to `s`; the first failure (or SKIP) and its suite. */
  async function beforeEach(s) {
    const chain = [];
    for (let x = s; x; x = x.parent) chain.unshift(x);
    for (const x of chain) {
      const e = await runHooks(x.hooks.beforeEach, s.timeout);
      if (e !== undefined) return { e, suite: x };
    }
    return undefined;
  }
  /**
   * mocha's hookUp: the afterEach hooks from `from` up to the root (a SKIP from one is ignored); a failure skips
   * the rest of its suite's and aborts that suite, outer suites' hooks still run. Resolves to the first error.
   */
  async function afterEach(from, timeout) {
    let first;
    for (let x = from; x; x = x.parent) {
      for (const h of x.hooks.afterEach) {
        const e = await runFn(h.fn, h.opts, timeout);
        if (e !== undefined && e !== SKIP) {
          first ??= e;
          abortSuite(x, '"after each" hook failed: ' + errMessage(e));
          break;
        }
      }
    }
    return first;
  }

  async function runTest(s, t) {
    if (t.skip) return record(s, t.title, 'SKIP');
    if (abort) return record(s, t.title, 'FAIL', abort.msg);
    const be = await beforeEach(s);
    if (be !== undefined) {
      if (be.e === SKIP) record(s, t.title, 'SKIP');
      else {
        const msg = '"before each" hook failed: ' + errMessage(be.e);
        record(s, t.title, 'FAIL', msg);
        abortSuite(be.suite, msg);
      }
      // the afterEach hooks of suites below the hook's are skipped
      await afterEach(be.suite, s.timeout);
      return;
    }
    let e = await runFn(t.fn, t.opts, s.timeout);
    const ae = await afterEach(s, s.timeout);
    if (e === undefined && ae !== undefined) e = new Error('"after each" hook failed: ' + errMessage(ae));
    record(s, t.title, statusOf(e), errMessage(e));
  }

  async function runSuite(s) {
    if (!hasTests(s)) return;
    if (s.skip) return recordAll(s, 'SKIP');
    if (abort) return recordAll(s, 'FAIL', abort.msg);
    const be = await runHooks(s.hooks.before, s.timeout);
    if (be === SKIP) recordAll(s, 'SKIP');
    else if (be !== undefined) recordAll(s, 'FAIL', '"before all" hook failed: ' + errMessage(be));
    else {
      for (const t of s.tests) await runTest(s, t);
      for (const c of s.suites) await runSuite(c);
    }
    await runHooks(s.hooks.after, s.timeout);
    if (abort?.suite === s) abort = null;
  }

  await runSuite(root);
  return results;
}

module.exports = {
  describe,
  xdescribe: describe.skip,
  context: describe,
  xcontext: describe.skip,
  it,
  xit: it.skip,
  specify: it,
  xspecify: it.skip,
  before: hook('before'),
  after: hook('after'),
  beforeEach: hook('beforeEach'),
  afterEach: hook('afterEach'),
  run,
};
