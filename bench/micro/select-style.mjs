// AREA A microbenchmarks (selectors, element.style, getComputedStyle), one fresh Node process per DOM
// (jsdom 30.1.3, happy-dom 21.0.3, rsdom). Every "cold" read follows a mutation that invalidates the
// relevant caches of every DOM (rsdom: EP[TREE]/EP[ATTR] for the qSA memo, EP[STYLE] for computed style);
// "warm" reads repeat without mutations (rsdom: memo hits, a JS effect; reported separately).
//   node bench/micro/select-style.mjs [--write]      (needs a release build: npm run build)
//   RSDOM_NO_MEMO=1 / RSDOM_NO_PREFILTER=1 / RSDOM_SHARED=0 node bench/micro/select-style.mjs   (ablations)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const ROLE_SELECTORS = fs.readFileSync(path.join(here, '../../crates/rsdom/data/role-selectors.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * ns/op: the iteration count is capped at `iters` and reduced so one timed run takes ~40 ms at most (slow
 * DOMs would otherwise run for minutes); two warm-ups, then the median of 7 timed runs.
 */
function bench(iters, fn) {
  let n = 1;
  for (;;) {
    const t0 = process.hrtime.bigint();
    fn(n);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (n >= iters || ms >= 10) break;
    n = Math.min(iters, n * 4);
  }
  fn(n);
  const res = [];
  for (let r = 0; r < 7; r++) {
    const t0 = process.hrtime.bigint();
    fn(n);
    res.push(Number(process.hrtime.bigint() - t0) / n);
  }
  return median(res);
}

function tableHtml(rows) {
  let html = '<table><tbody>';
  for (let r = 0; r < rows; r++) {
    html += `<tr data-row="${r}" class="row ${r & 1 ? 'odd' : 'even'}"><td><input type="checkbox" aria-label="row ${r}"></td>`
      + `<td class="name">Item ${r}</td><td>${r * 3}</td><td><button>Edit</button></td><td><a href="/x/${r}">open</a></td></tr>`;
  }
  return `${html}</tbody></table>`;
}

function runChild(kind) {
  const { makeWindow } = require('../../packages/rsdom/test/contract/adapter.cjs');
  const w = makeWindow(kind);
  const d = w.document;
  const gcs = typeof w.getComputedStyle === 'function'
    ? (el) => w.getComputedStyle(el)
    : require('../../packages/rsdom/lib/index.cjs').rt.getComputedStyle;
  const out = {};
  let sink = 0;

  // ------------------------------------------------------------------ matches: DTL role selectors
  const host = d.createElement('div');
  d.body.appendChild(host);
  host.innerHTML = '<form><input type=email><input><input type=checkbox><select></select><button>b</button>'
    + '<a href="/">a</a><img alt=""><h2>t</h2><ul><li>x</li></ul><p>p</p><span>s</span><table><tr><th scope=col>h</th><td>d</td></tr></table></form>';
  const els = [...host.querySelectorAll('*')];
  out['matches(): 108 DTL role selectors x every element (ns/call)'] = bench(20, (n) => {
    let s = 0;
    for (let k = 0; k < n; k++) {
      host.firstChild.setAttribute('data-k', String(k));
      for (const el of els) for (const sel of ROLE_SELECTORS) if (el.matches(sel)) s++;
    }
    sink += s;
  }) / (els.length * ROLE_SELECTORS.length);
  const td = host.querySelector('td');
  const email = host.querySelector('input[type=email]');
  out['matches() prefilter miss: td.matches(input[...]) (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (td.matches('input:not([list])[type="email"]')) s++;
    sink += s;
  });
  out['matches() hit through Rust: input:not([list])[type=email] (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (email.matches('input:not([list])[type="email"]')) s++;
    sink += s;
  });
  out['closest(form) from a nested element (ns)'] = bench(200_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (td.closest('form') !== null) s++;
    sink += s;
  });

  // -------------------------------------------------------------------- qSA on a 3k-element table
  const t = d.createElement('div');
  d.body.appendChild(t);
  t.innerHTML = tableHtml(300);
  out['  (elements in the table)'] = t.querySelectorAll('*').length;
  const first = t.querySelector('tr');
  for (const [label, sel] of [['td button', 'td button'], ['[data-row="150"]', '[data-row="150"]'], ['.row.odd a[href]', '.row.odd a[href]']]) {
    out[`qSA cold '${label}' after a mutation (us)`] = bench(200, (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        first.setAttribute('data-v', String(i));
        s += t.querySelectorAll(sel).length;
      }
      sink += s;
    }) / 1000;
  }
  out["qSA warm 'td button', no mutation (us)"] = bench(2000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += t.querySelectorAll('td button').length;
    sink += s;
  }) / 1000;
  out['getElementsByClassName(odd).length after a mutation (us)'] = bench(500, (n) => {
    const l = t.getElementsByClassName('odd');
    let s = 0;
    for (let i = 0; i < n; i++) {
      first.setAttribute('data-v', String(i));
      s += l.length;
    }
    sink += s;
  }) / 1000;

  // ------------------------------------------------------------------------------- element.style
  const st = d.createElement('div');
  d.body.appendChild(st);
  out['style.color = ... (ns)'] = bench(100_000, (n) => {
    for (let i = 0; i < n; i++) st.style.color = i & 1 ? 'red' : '#00ff00';
  });
  out["style.setProperty('--x', ...) (ns)"] = bench(100_000, (n) => {
    for (let i = 0; i < n; i++) st.style.setProperty('--x', i & 1 ? '1px' : '2px');
  });
  st.style.cssText = 'margin: 1px 2px; color: red; display: flex';
  out['style.marginLeft read (ns)'] = bench(200_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += st.style.marginLeft.length;
    sink += s;
  });

  // ------------------------------------------------------------------------------ computed style
  const deep = t.querySelector('tr:nth-child(150) button');
  out['getComputedStyle(el).display cold after a mutation (ns)'] = bench(20_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      d.body.setAttribute('style', i & 1 ? 'color: red' : 'color: blue');
      s += gcs(deep).display.length;
    }
    sink += s;
  });
  out['getComputedStyle(el).display warm (ns)'] = bench(200_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += gcs(deep).display.length;
    sink += s;
  });
  out['getComputedStyle(el).visibility, 100 siblings after a mutation (ns/el)'] = bench(200, (n) => {
    const btns = [...t.querySelectorAll('button')].slice(0, 100);
    let s = 0;
    for (let i = 0; i < n; i++) {
      d.body.setAttribute('style', i & 1 ? 'color: red' : 'color: blue');
      for (const b of btns) s += gcs(b).visibility.length;
    }
    sink += s;
  }) / 100;
  out['getComputedStyle(el).color (non-core, inherited) (ns)'] = bench(20_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += gcs(deep).color.length;
    sink += s;
  });

  if (sink === 0.5) console.error('');
  process.stdout.write(JSON.stringify(out));
}

if (process.argv[2] === '--child') {
  runChild(process.argv[3]);
} else {
  const kinds = ['jsdom', 'happy-dom', 'rsdom'];
  const results = {};
  for (const k of kinds) {
    results[k] = JSON.parse(execFileSync(process.execPath, [self, '--child', k], { maxBuffer: 1 << 24 }).toString());
  }
  const rows = Object.keys(results.rsdom);
  const fmt = (v) => (v == null || Number.isNaN(v) ? 'n/a' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const env = ['RSDOM_SHARED', 'RSDOM_NO_MEMO', 'RSDOM_NO_PREFILTER'].map((k) => `${k}=${process.env[k] ?? '-'}`).join(' ');
  const lines = [
    `# rsdom area A micro: selectors / style (${new Date().toISOString()})`,
    `# Node ${process.version}, ${os.cpus()[0].model} x${os.cpus().length}; ${env}; median of 7 runs, one process per DOM`,
    '# NOTE: 4 shared CPUs with two other agents building/testing: numbers are noisy (sanity only).',
    `${'operation'.padEnd(72)}${'jsdom'.padStart(10)}${'happy-dom'.padStart(11)}${'rsdom'.padStart(10)}`,
  ];
  for (const r of rows) {
    lines.push(`${r.padEnd(72)}${fmt(results.jsdom[r]).padStart(10)}${fmt(results['happy-dom'][r]).padStart(11)}${fmt(results.rsdom[r]).padStart(10)}`);
  }
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    const suffix = process.env.RSDOM_NO_MEMO === '1' || process.env.RSDOM_NO_PREFILTER === '1' || process.env.RSDOM_SHARED === '0' ? '-ablation' : '';
    fs.writeFileSync(path.join(here, `select-style${suffix}.txt`), text);
  }
}
