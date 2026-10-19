// M9 review regressions that only rsdom can check (raw natives, ablation switches).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const FACADE = require.resolve('../../lib/index.cjs');
const { createWindow, rt } = require(FACADE);
const { N } = rt;

describe('M9 review: untrusted native arguments', () => {
  it('moObserve validates the attributeFilter count before reading OUT', () => {
    const { document } = createWindow();
    const target = document.body._i;
    // nfilter without the FILTER option bit, and a count of 2^32-1 (used to abort with a 16 GiB allocation)
    expect(N.moObserve(1, target, 1, 0xffffffff)).not.toBe(0);
    expect(N.moObserve(1, target, 1, -1 >>> 0)).not.toBe(0);
    // with the FILTER bit, a huge count is clamped to OUT's capacity instead of allocating unboundedly
    expect(N.moObserve(1, target, 2 | 64, 0xffffffff)).toBe(0);
    N.moDisconnect(1);
  });
});

describe('M9 review: RSDOM_NO_MEMO disables the Rust computed-style memo too', () => {
  it('runs a child process with RSDOM_NO_MEMO=1 and checks stale-prone reads', () => {
    const script = `
      const { createWindow } = require(${JSON.stringify(FACADE)});
      const { window: w, document: d } = createWindow();
      d.head.innerHTML = '<style>button:disabled{display:none}</style>';
      d.body.innerHTML = '<button id=b>x</button>';
      const b = d.getElementById('b');
      const before = w.getComputedStyle(b).display;
      b.disabled = true;
      process.stdout.write(before + ',' + w.getComputedStyle(b).display);
    `;
    for (const env of [{}, { RSDOM_NO_MEMO: '1', RSDOM_NO_PREFILTER: '1' }]) {
      const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ...env }, encoding: 'utf8' });
      expect(out).toBe('inline-block,none');
    }
  });
});
