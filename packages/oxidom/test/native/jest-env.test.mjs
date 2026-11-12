// The oxidom Jest environment (lib/jest-environment.cjs, package jest-environment-oxidom, DESIGN §32): the specs in
// test/fixtures/jest-env run in child `jest` processes under oxidom and under jest-environment-jsdom's base class
// on jsdom 30, and must give the same results.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { pkgDir } = require('../contract/adapter.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(pkgDir('jest'), 'bin/jest.js');
const config = path.join(root, 'test/fixtures/jest-env/jest.config.cjs');

function jest(dom, args = []) {
  const r = spawnSync(process.execPath, [cli, '--config', config, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', JEST_DOM: dom },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe.each(['jsdom', 'oxidom'])('Jest fixture suite [%s]', (dom) => {
  it('passes, in workers and in band', () => {
    for (const args of [[], ['--runInBand']]) {
      const { status, out } = jest(dom, args);
      expect(status, out).toBe(0);
      expect(out).toMatch(/Tests:\s+10 passed, 10 total/);
    }
  }, 120_000);

  it('a listener error fails its test; not-implemented methods log through console.error', () => {
    const { status, out } = jest(dom, ['--testMatch', '<rootDir>/errors.failing.cjs']);
    expect(status).toBe(1);
    expect(out).toMatch(/Tests:\s+1 failed, 1 passed, 2 total/);
    expect(out).toMatch(/● listener error[\s\S]*listener boom/);
    expect(out).toContain("Not implemented: Window's alert() method");
  }, 120_000);
});
