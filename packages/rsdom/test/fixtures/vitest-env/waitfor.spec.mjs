// ROADMAP M6 acceptance: DTL waitFor / findBy* resolve through MutationObserver delivery (counted with the
// facade's MO stats), not through the polling interval (set to 10 s here).
import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// (not `new URL(x, import.meta.url)`: Vite's client transform rewrites that pattern relative to `location`)
const here = path.dirname(fileURLToPath(import.meta.url));
const dtlPath = require.resolve('@testing-library/dom');
const hasDTL = fs.existsSync(dtlPath);

// DTL's container check needs querySelector/querySelectorAll (area A): skipped on a branch without them.
const hasQuery = () => typeof document.querySelectorAll === 'function';

test.runIf(hasDTL)('waitFor resolves on a DOM mutation via MO, not polling', async (ctx) => {
  if (!hasQuery()) ctx.skip();
  const { waitFor } = require(dtlPath);
  const before = { ...__rsdom.moStats };
  const p = document.createElement('p');
  document.body.appendChild(p);
  const timer = setTimeout(() => {
    p.textContent = 'done';
  }, 20);
  ctx.onTestFinished(() => clearTimeout(timer));
  const t0 = performance.now();
  await waitFor(() => {
    if (p.textContent !== 'done') throw new Error('not yet');
  }, { interval: 10_000, timeout: 5_000 });
  expect(performance.now() - t0).toBeLessThan(2_000);
  expect(__rsdom.moStats.ticks).toBeGreaterThan(before.ticks);
  expect(__rsdom.moStats.records).toBeGreaterThan(before.records);
});

test.runIf(hasDTL)('findByText resolves via MO (needs querySelectorAll from area A)', async (ctx) => {
  if (!hasQuery()) ctx.skip();
  const { findByText } = require(dtlPath);
  const before = __rsdom.moStats.takes;
  const timer = setTimeout(() => {
    const b = document.createElement('b');
    b.textContent = 'Loaded';
    document.body.appendChild(b);
  }, 20);
  ctx.onTestFinished(() => clearTimeout(timer));
  const el = await findByText(document.body, 'Loaded', {}, { interval: 10_000, timeout: 5_000 });
  expect(el.tagName).toBe('B');
  expect(__rsdom.moStats.takes).toBeGreaterThan(before);
});
