// The rsdom Vitest environment (lib/vitest-environment.mjs, ROADMAP M6): setup/teardown on a stand-in global
// in-process, then the real thing in child `vitest run`s over test/fixtures/vitest-env under several pools.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import env from '../../lib/vitest-environment.mjs';

const require = createRequire(import.meta.url);
const { pkgDir } = require('../contract/adapter.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function descriptors(o) {
  const m = new Map();
  for (const k of Reflect.ownKeys(o)) m.set(k, Object.getOwnPropertyDescriptor(o, k));
  return m;
}

describe('vitest-environment module', () => {
  it('has the Vitest 5 Environment shape', () => {
    expect(env.name).toBe('rsdom');
    expect(env.viteEnvironment).toBe('client');
    expect(typeof env.setup).toBe('function');
    expect(typeof env.setupVM).toBe('function');
  });

  it('setup installs own data globals; teardown restores every descriptor and drops the DOM', async () => {
    const fake = {
      navigator: { userAgent: 'node' },
      FormData: class NodeLike {},
      keep: 1,
    };
    Object.defineProperty(fake, 'localStorage', { get: () => { throw new Error('must not be read'); }, configurable: true });
    const before = descriptors(fake);
    const { teardown } = await env.setup(fake, { nativedom: { url: 'http://localhost:3000/a' } });
    expect(fake.window).toBe(fake);
    expect(fake.document.defaultView).toBe(fake);
    expect(fake.location.pathname).toBe('/a');
    expect(fake.navigator.userAgent).toMatch(/rsdom/);
    expect(typeof fake.localStorage.getItem).toBe('function');
    expect('value' in Object.getOwnPropertyDescriptor(fake, 'HTMLDivElement')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(fake, 'HTMLDivElement').enumerable).toBe(false);
    const div = fake.document.createElement('div');
    fake.document.body.appendChild(div);
    await teardown(fake);
    const after = descriptors(fake);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, d] of before) expect(after.get(k), String(k)).toEqual(d);
    // every wrapper of the old env is neutered (DESIGN §11 teardown)
    expect(div._i).toBe(0);
    expect(div.parentNode).toBe(null);
    const { rt } = require('../../lib/index.cjs');
    expect(rt.N.moRegistrations()).toBe(0);
  });
});

describe('environmentOptions.jsdom (Vitest jsdom environment keys)', () => {
  it('reads url, html, userAgent, pretendToBeVisual and referrer; a nativedom key wins', async () => {
    const fake = {};
    const { teardown } = await env.setup(fake, {
      jsdom: {
        url: 'https://example.com/x',
        html: '<!DOCTYPE html><html lang=fr><body><p>hi</p></body></html>',
        userAgent: 'agent/1',
        pretendToBeVisual: false,
        referrer: 'https://ref.example/',
      },
      nativedom: { url: 'https://example.org/y' },
    });
    expect([fake.location.href, fake.document.documentElement.lang, fake.document.body.innerHTML]).toEqual(['https://example.org/y', 'fr', '<p>hi</p>']);
    expect([fake.navigator.userAgent, fake.document.referrer]).toEqual(['agent/1', 'https://ref.example/']);
    expect([typeof fake.requestAnimationFrame, fake.document.hidden, fake.document.visibilityState]).toEqual(['undefined', true, 'prerender']);
    await teardown(fake);
    expect(Reflect.ownKeys(fake)).toEqual([]);
  });

  it('rejects XML and non-HTML content types like jsdom', async () => {
    await expect(async () => env.setup({}, { jsdom: { contentType: 'text/plain' } })).rejects.toThrow(RangeError);
  });

  it('defaults: visual, not-implemented methods log through console.error, and a `jsdom` global', async () => {
    const fake = {};
    const { teardown } = await env.setup(fake, {});
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    try {
      fake.alert('x');
      expect(fake.document.hidden).toBe(false);
      expect(typeof fake.requestAnimationFrame).toBe('function');
      fake.jsdom.reconfigure({ url: 'http://localhost:3000/next' });
      expect(fake.location.pathname).toBe('/next');
      expect(fake.jsdom.window).toBe(fake);
      fake.jsdom.reconfigure({ windowTop: 5 });
      expect(fake.top).toBe(fake);
      expect(fake.jsdom.serialize()).toBe('<!DOCTYPE html><html><head></head><body></body></html>');
    } finally {
      spy.mockRestore();
    }
    expect(errors).toEqual(["Not implemented: Window's alert() method"]);
    await teardown(fake);
    expect('jsdom' in fake).toBe(false);
  });
});

describe('environment startup cost', () => {
  it('installing the window on globalThis does not load undici (Node lazy FormData & co)', () => {
    const facade = path.join(root, 'lib/index.cjs');
    // XMLHttpRequest up to send() (what axios and msw touch at import / request setup) loads nothing either:
    // undici and lib/xhr-fetch.cjs come with the first send()
    const code = `
      const { createWindow } = require(${JSON.stringify(facade)});
      createWindow({ global: globalThis });
      const fd = new FormData();
      fd.append('a', '1');
      const x = new XMLHttpRequest();
      x.open('POST', '/x');
      x.setRequestHeader('X-A', '1');
      void ['onloadend' in x, x.upload, x.responseText];
      const loaded = process.moduleLoadList.some((m) => m.includes('undici') || m === 'NativeModule http');
      const xhrFetch = Object.keys(require.cache).some((k) => k.endsWith('xhr-fetch.cjs'));
      process.stdout.write(JSON.stringify({ loaded, xhrFetch, a: fd.get('a'), own: Object.prototype.hasOwnProperty.call(globalThis, 'FormData') }));`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ loaded: false, xhrFetch: false, a: '1', own: true });
  });
});

const cli = path.join(pkgDir('vitest'), 'vitest.mjs');
const fixture = path.join(root, 'test/fixtures/vitest-env');

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, 'run', '--config', 'vitest.config.mjs', ...args], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1', ...extraEnv },
  });
}

describe.each([
  ['forks (default, isolate)', []],
  ['threads (isolate)', ['--pool=threads']],
  ['threads, isolate: false, 1 worker (3 leak files share one DOM)', ['--pool=threads', '--no-isolate', '--maxWorkers=1']],
  ['forks, isolate: false, RSDOM_SHARED=0', ['--no-isolate', '--maxWorkers=2'], { RSDOM_SHARED: '0' }],
])('fixture suite in the rsdom environment: %s', (_name, args, extraEnv) => {
  it('passes', () => {
    const r = run(args, extraEnv);
    expect(r.signal, r.stderr).toBe(null);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Tests\s+\d+ passed/);
    expect(r.stdout + r.stderr).not.toMatch(/Unhandled/);
  }, 120_000);
});

// VM pools (DESIGN §33): test/fixtures/vitest-vm under nativedom and under Vitest's jsdom environment (the oracle).
const vmFixture = path.join(root, 'test/fixtures/vitest-vm');

function runVm(dom, pool, extraEnv = {}) {
  const r = spawnSync(process.execPath, [cli, 'run', '--config', 'vitest.config.mjs', `--pool=${pool}`], {
    cwd: vmFixture,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1', VITEST_DOM: dom, ...extraEnv },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe.each(['jsdom', 'nativedom'])('VM pools fixture suite [%s]', (dom) => {
  it.each(['vmThreads', 'vmForks'])('passes in %s', (pool) => {
    const { status, out } = runVm(dom, pool);
    expect(status, out).toBe(0);
    expect(out).toMatch(/Tests\s+8 passed \(8\)/);
  }, 120_000);

  it('a listener error is reported as an unhandled error', () => {
    const { status, out } = runVm(dom, 'vmThreads', { VITEST_INCLUDE: 'errors.failing.mjs' });
    expect(status).toBe(1);
    expect(out).toMatch(/Unhandled Errors[\s\S]*Error: listener boom/);
  }, 120_000);
});
