// M1/M2 microbenchmarks, one fresh Node process per DOM (jsdom 30.1.3, happy-dom 21.0.3, oxidom).
// Reads interleave mutations so no DOM can serve them from a whole-result cache.
//   node bench/micro/m1m2.mjs [--write]            (needs a release build: npm run build)
//   OXIDOM_SHARED=0 node bench/micro/m1m2.mjs       (oxidom crossing-getter fallback ablation)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** ns/op: warm-up, then median of 7 timed runs. */
function bench(iters, fn) {
  fn(Math.max(1, iters >> 2));
  fn(Math.max(1, iters >> 2));
  const res = [];
  for (let r = 0; r < 7; r++) {
    const t0 = process.hrtime.bigint();
    fn(iters);
    res.push(Number(process.hrtime.bigint() - t0) / iters);
  }
  return median(res);
}

function runChild(kind) {
  const { makeWindow } = require('../../packages/oxidom/test/contract/adapter.cjs');
  const w = makeWindow(kind);
  const d = w.document;
  const body = d.body;
  const out = {};
  let sink = 0;

  out['createElement+appendChild+removeChild (ns)'] = bench(100_000, (n) => {
    for (let i = 0; i < n; i++) {
      const e = d.createElement('div');
      body.appendChild(e);
      body.removeChild(e);
    }
  });

  const el = d.createElement('div');
  body.appendChild(el);
  out['setAttribute (ns)'] = bench(200_000, (n) => {
    for (let i = 0; i < n; i++) el.setAttribute('title', 'v' + (i & 7));
  });
  el.setAttribute('data-i', '42');
  out['getAttribute (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += el.getAttribute('data-i').length;
    sink += s;
  });
  out['getAttribute interleaved with setAttribute (ns/pair)'] = bench(200_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      el.setAttribute('data-i', i & 1 ? 'a' : 'bb');
      s += el.getAttribute('data-i').length;
    }
    sink += s;
  });
  out['hasAttribute (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += el.hasAttribute('data-i') ? 1 : 0;
    sink += s;
  });

  // bottom-up detached build: depth 200, 4 spans per level (1001 nodes), then attach (happy-dom-probes/ops.mjs)
  out['bottom-up detached build 1001 nodes depth 200 + attach (us)'] = bench(20, (n) => {
    for (let k = 0; k < n; k++) {
      let child = d.createElement('div');
      for (let depth = 0; depth < 200; depth++) {
        const p = d.createElement('div');
        for (let j = 0; j < 4; j++) p.appendChild(d.createElement('span'));
        p.appendChild(child);
        child = p;
      }
      body.appendChild(child);
      child.remove();
    }
  }) / 1000;

  // tree walk interleaved with a mutation per walk
  const root = d.createElement('div');
  const all = [root];
  for (let i = 1; i < 4096; i++) {
    const s = d.createElement(i % 3 ? 'span' : 'div');
    all[(i - 1) >> 2].appendChild(s);
    all.push(s);
  }
  body.appendChild(root);
  const walk = (r) => {
    let count = 0;
    let n = r;
    while (n !== null) {
      count++;
      const f = n.firstChild;
      if (f !== null) {
        n = f;
        continue;
      }
      while (n !== r && n.nextSibling === null) n = n.parentNode;
      n = n === r ? null : n.nextSibling;
    }
    return count;
  };
  out['DFS walk firstChild/nextSibling, 4096 nodes, +1 mutation/walk (ns/node)'] = bench(200, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      all[i & 1023].setAttribute('x', 'y');
      s += walk(root);
    }
    sink += s;
  }) / 4096;

  // serialize / parse ~3.6k elements (a 300-row table like DataTable.heavy)
  let html = '<table><tbody>';
  for (let r = 0; r < 300; r++) {
    html += `<tr data-row="${r}"><td><input type="checkbox" aria-label="row ${r}"></td><td class="name">Item &amp; ${r}</td><td>${r * 3}</td><td><button>Edit</button></td><td><a href="/x/${r}">open</a></td></tr>`;
  }
  html += '</tbody></table>';
  const host = d.createElement('div');
  body.appendChild(host);
  out['innerHTML set, 300-row table (~3.6k nodes) (us)'] = bench(20, (n) => {
    for (let i = 0; i < n; i++) host.innerHTML = html;
  }) / 1000;
  let elements = 0;
  for (let n = host.firstElementChild; n !== null; ) {
    elements++;
    if (n.firstElementChild !== null) n = n.firstElementChild;
    else {
      while (n !== host && n.nextElementSibling === null) n = n.parentElement;
      n = n === host ? null : n.nextElementSibling;
    }
  }
  out['  (elements in the table)'] = elements;
  out['outerHTML get, same table (us)'] = bench(50, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      host.firstChild.setAttribute('data-v', String(i));
      s += host.outerHTML.length;
    }
    sink += s;
  }) / 1000;
  out['textContent get, same table (us)'] = bench(50, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      host.firstChild.setAttribute('data-v', String(i));
      s += host.textContent.length;
    }
    sink += s;
  }) / 1000;
  out['textContent set (replace-all) (ns)'] = bench(100_000, (n) => {
    for (let i = 0; i < n; i++) el.textContent = i & 1 ? 'a' : 'b';
  });
  if (sink === 0.5) console.error('');
  process.stdout.write(JSON.stringify(out));
}

if (process.argv[2] === '--child') {
  runChild(process.argv[3]);
} else {
  const kinds = ['jsdom', 'happy-dom', 'oxidom'];
  const results = {};
  for (const k of kinds) {
    results[k] = JSON.parse(execFileSync(process.execPath, [self, '--child', k], { maxBuffer: 1 << 24 }).toString());
  }
  const rows = Object.keys(results.oxidom);
  const fmt = (v) => (v == null || Number.isNaN(v) ? 'n/a' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const lines = [
    `# oxidom M1/M2 micro (${new Date().toISOString()})`,
    `# Node ${process.version}, ${os.cpus()[0].model} x${os.cpus().length}; OXIDOM_SHARED=${process.env.OXIDOM_SHARED ?? '1'}; median of 7 runs, one process per DOM`,
    `${'operation'.padEnd(72)}${'jsdom'.padStart(10)}${'happy-dom'.padStart(11)}${'oxidom'.padStart(10)}`,
  ];
  for (const r of rows) {
    lines.push(`${r.padEnd(72)}${fmt(results.jsdom[r]).padStart(10)}${fmt(results['happy-dom'][r]).padStart(11)}${fmt(results.oxidom[r]).padStart(10)}`);
  }
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    const name = process.env.OXIDOM_SHARED === '0' ? 'm1m2-fallback.txt' : 'm1m2.txt';
    fs.writeFileSync(path.join(here, name), text);
  }
}
