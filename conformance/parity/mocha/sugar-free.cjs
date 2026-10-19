'use strict';
// A small BDD runner with the `mocha-sugar-free` interface, so jsdom's own mocha suites (refs/jsdom/test/api,
// refs/jsdom/test/to-port-to-wpts) run without mocha. Semantics follow mocha 10 + mocha-sugar-free 1.4:
// - `describe|it|specify|before|after|beforeEach|afterEach(title?, options?, fn?)`, arguments in any order;
//   `.skip` / `.only` variants (`.only` behaves like a plain call: the parity suite always runs everything);
// - the callback gets a context `{ skip, timeout, slow, enableTimeouts, done }` instead of `this`;
//   `options.async` makes the test wait for `context.done(err?)`, otherwise a returned thenable is awaited;
// - default timeout 2000 ms (mocha's; jsdom has no .mocharc), `options.timeout` / `context.timeout(ms)` /
//   a suite's `context.timeout(ms)` override it, 0 disables it;
// - a failing `before` hook fails every test of its suite; a failing `beforeEach` fails the test;
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
    if (o.fn) current.hooks[kind].push({ fn: o.fn, opts: o });
  };
}

// ---------------------------------------------------------------------------------------------- running

/** The runnable currently executing: uncaught errors are routed to it. */
let active = null;

function onUncaught(err) {
  if (active) active(err instanceof Error ? err : new Error(String(err)));
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
      done: opts.async ? (err) => finish(err == null ? undefined : err instanceof Error ? err : new Error(String(err))) : undefined,
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
  // first stack frame inside jsdom's test tree, for orientation (path relative to refs/jsdom/test)
  const frame = lines.find((l) => /refs\/jsdom\/test\//.test(l))?.replace(/\(?[^\s(]*refs\/jsdom\/test\//, '(');
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

function allTests(s, out = []) {
  out.push(...s.tests);
  for (const c of s.suites) allTests(c, out);
  return out;
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

  async function runHooks(list, suiteTimeout) {
    for (const h of list) {
      const e = await runFn(h.fn, h.opts, suiteTimeout);
      if (e !== undefined && e !== SKIP) return e;
    }
    return undefined;
  }
  function eachChain(suite, kind) {
    const chain = [];
    for (let s = suite; s; s = s.parent) chain.unshift(s);
    const hooks = chain.map((s) => s.hooks[kind]);
    return kind === 'beforeEach' ? hooks.flat() : hooks.reverse().flat();
  }

  async function runSuite(s) {
    if (!hasTests(s)) return;
    if (s.skip) {
      for (const t of allTests(s)) record(t.suite, t.title, 'SKIP');
      return;
    }
    const be = await runHooks(s.hooks.before, s.timeout);
    if (be !== undefined) {
      const msg = '"before all" hook failed: ' + errMessage(be);
      for (const t of allTests(s)) record(t.suite, t.title, 'FAIL', msg);
      return;
    }
    for (const t of s.tests) {
      if (t.skip) {
        record(s, t.title, 'SKIP');
        continue;
      }
      let e = await runHooks(eachChain(s, 'beforeEach'), s.timeout);
      if (e !== undefined) {
        record(s, t.title, 'FAIL', '"before each" hook failed: ' + errMessage(e));
        continue;
      }
      e = await runFn(t.fn, t.opts, s.timeout);
      const ae = await runHooks(eachChain(s, 'afterEach'), s.timeout);
      if (e === undefined && ae !== undefined) e = new Error('"after each" hook failed: ' + errMessage(ae));
      record(s, t.title, statusOf(e), errMessage(e));
    }
    for (const c of s.suites) await runSuite(c);
    await runHooks(s.hooks.after, s.timeout);
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
