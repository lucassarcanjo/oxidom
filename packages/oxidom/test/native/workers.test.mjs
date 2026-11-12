// Regression: loading the addon on a new thread after an earlier thread that used it has exited
// (sequential worker_threads, Vitest `pool: 'threads'`). With mimalloc v3 as #[global_allocator] the 2nd
// worker segfaulted the whole process, so both checks run in a child process and assert its exit status.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const { pkgDir } = createRequire(import.meta.url)('../contract/adapter.cjs');

const facade = fileURLToPath(new URL('../../lib/index.cjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('addon on many threads', () => {
  it('six sequential workers each load the addon and build a document', () => {
    const script = `
      const { Worker } = require('node:worker_threads');
      const code = 'const { createWindow } = require(' + JSON.stringify(${JSON.stringify(facade)}) + ');'
        + 'const { document } = createWindow(); document.body.innerHTML = "<p>x</p>";'
        + 'require("node:worker_threads").parentPort.postMessage(document.body.textContent);';
      (async () => {
        let got = '';
        for (let i = 0; i < 6; i++) {
          got += await new Promise((resolve, reject) => {
            const w = new Worker(code, { eval: true });
            let msg = '';
            w.on('message', (m) => { msg = m; });
            w.on('error', reject);
            w.on('exit', () => resolve(msg));
          });
        }
        process.stdout.write(got);
      })();`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.signal).toBe(null);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('x'.repeat(6));
  });

  it("vitest pool: 'threads' smoke run (one fresh worker per file)", () => {
    const cli = path.join(pkgDir('vitest'), 'vitest.mjs');
    const r = spawnSync(process.execPath, [cli, 'run', '--config', 'vitest.config.mjs'], {
      cwd: path.join(root, 'test/fixtures/pool-threads'), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    expect(r.signal, r.stderr).toBe(null);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/3 passed/);
  }, 120_000);
});
