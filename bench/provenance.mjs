// Benchmark provenance (M9 review): what was measured, on which build, under which load. Shared by
// bench/micro/run.mjs and bench/e2e/run.mjs.
//
// - git rev + dirty flag of the repository
// - the rsdom addon the facade will load (the same resolution as packages/rsdom/lib/native.cjs, with RSDOM_NATIVE
//   removed from benchmark children unless --native= is given): path, sha256, size, mtime, and the build
//   profile reported by the addon itself (`__buildInfo`: release / debug, +counters)
// - versions of the DOMs, the test runner and the libraries the suites use
// - the load average (sampled again around every measured process by the runners)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rsdomRoot = path.resolve(here, '..');
export const appRoot = path.join(rsdomRoot, 'e2e/react-app');

function git(args) {
  const r = spawnSync('git', args, { cwd: rsdomRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The addon path the facade would load for `native` (an explicit path) or the default build. */
export function addonPath(native = null) {
  if (native) return path.resolve(native);
  const dir = path.join(rsdomRoot, 'packages/rsdom/native');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^rsdom\..*\.node$/.test(f)) : [];
  const pick = files.find((f) => f.includes(process.platform)) ?? files[0];
  return pick ? path.join(dir, pick) : null;
}

function addonInfo(p) {
  if (!p || !fs.existsSync(p)) return { path: p, missing: true };
  const buf = fs.readFileSync(p);
  const st = fs.statSync(p);
  const env = { ...process.env };
  if (p) env.RSDOM_NATIVE = p;
  const r = spawnSync(process.execPath, ['-e', `const N = require(${JSON.stringify(p)}); process.stdout.write(typeof N.__buildInfo === 'function' ? N.__buildInfo() : 'unknown (addon predates __buildInfo)')`], { encoding: 'utf8', env });
  return {
    path: path.relative(rsdomRoot, p) || p,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    build: r.status === 0 ? r.stdout.trim() : `error: ${(r.stderr || '').split('\n')[0]}`,
  };
}

function version(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/** Provenance record for a benchmark result file. */
export function provenance({ native = null } = {}) {
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  const v = (name) => version(rsdomRoot, name) ?? version(appRoot, name);
  return {
    gitRev: git(['rev-parse', 'HEAD']),
    gitDirty: dirty === null ? null : dirty.length > 0,
    addon: addonInfo(addonPath(native)),
    versions: {
      node: process.version,
      jsdom: v('jsdom'),
      'happy-dom': v('happy-dom'),
      vitest: v('vitest'),
      'vitest (app)': version(appRoot, 'vitest'),
      react: version(appRoot, 'react'),
      'react-dom': version(appRoot, 'react-dom'),
      '@testing-library/dom': version(appRoot, '@testing-library/dom'),
      '@testing-library/react': version(appRoot, '@testing-library/react'),
      '@testing-library/user-event': version(appRoot, '@testing-library/user-event'),
    },
    cpu: `${os.cpus()[0]?.model ?? '?'} x${os.cpus().length}`,
    loadavg: os.loadavg().map((x) => +x.toFixed(2)),
  };
}

/** Why two provenance records must not be merged into one result file (null = compatible). */
export function mergeConflict(a, b) {
  if (!a || !b) return 'stored results have no provenance record';
  if (a.gitRev !== b.gitRev) return `git rev differs (${a.gitRev} vs ${b.gitRev})`;
  if (a.gitDirty || b.gitDirty) return 'working tree dirty';
  if (a.addon?.sha256 !== b.addon?.sha256) return 'addon sha256 differs';
  return null;
}

/** The 1-minute load average now. */
export const load1 = () => +os.loadavg()[0].toFixed(2);

/** Load above which a measured process is flagged (RSDOM_BENCH_MAX_LOAD; default half the CPUs, >= 1). */
export const MAX_LOAD = Number(process.env.RSDOM_BENCH_MAX_LOAD ?? Math.max(1, os.cpus().length / 2));

/**
 * Environment for benchmark children: drops every RSDOM_* variable that neither comes from `extra` nor is
 * named in `keep` (so a leftover RSDOM_NATIVE pointing at a debug or counters addon, stray ablation
 * switches or counters output files never leak into a measurement).
 */
export function cleanEnv(extra = {}, keep = []) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('RSDOM_') && !(k in extra) && !keep.includes(k)) delete env[k];
  return env;
}
