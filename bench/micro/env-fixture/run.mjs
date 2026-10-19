// Runs the env fixture once with Vitest (forks, isolate, maxWorkers=1) and returns Vitest's own per-file
// environment phase (bench/e2e/phase-reporter.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from '../../provenance.mjs';
import { median } from '../lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rsdomRoot = path.resolve(here, '../../..');
const vitestCli = path.join(rsdomRoot, 'node_modules/vitest/vitest.mjs');
const reporter = path.join(rsdomRoot, 'bench/e2e/phase-reporter.mjs');

export function runEnvFixture(kind) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rsdom-envfix-')), 'phases.json');
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [vitestCli, 'run', '--config', path.join(here, 'vitest.config.mjs'), '--pool=forks', '--maxWorkers=1', '--reporter=dot', `--reporter=${reporter}`], {
    cwd: here,
    env: cleanEnv({ DOM_ENV: kind, RSDOM_PHASES_OUT: out, CI: '1', NO_COLOR: '1' }, ['RSDOM_SHARED', 'RSDOM_NO_MEMO', 'RSDOM_NO_PREFILTER', 'RSDOM_NATIVE']),
    encoding: 'utf8',
    timeout: 300_000,
  });
  const wall = performance.now() - t0;
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`vitest run failed (${r.status}): ${(r.stdout + r.stderr).split('\n').filter((l) => /Error|FAIL/.test(l)).slice(0, 3).join(' | ')}`);
  const ph = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  const env = ph.files.map((f) => f.environment);
  return { envMedian: median(env), env, wall, files: ph.files.length };
}
