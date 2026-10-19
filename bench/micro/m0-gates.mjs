// M0 microbench gates (ROADMAP M0 acceptance):
//   raw u32 crossing <= 35 ns, getAttr-shaped call (2 x u32 in, latin1 out) <= 90 ns,
//   JS table-read walk <= 10 ns/node, RSS growth after init < 1 MiB.
// Usage: node --expose-gc bench/micro/m0-gates.mjs [--write]   (needs a release build: npm run build)
// Method: monomorphic loops, 2 warm-up passes, best and median of 7 timed runs (process.hrtime.bigint()).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[2] === '--rss-child') {
  // Fresh process: RSS delta of loading the addon + init (table reservation must stay uncommitted).
  const before = process.memoryUsage().rss;
  const N = require('../../packages/rsdom/lib/native.cjs');
  const afterLoad = process.memoryUsage().rss;
  N.init(new ArrayBuffer(64), new ArrayBuffer(1 << 16, { maxByteLength: 1 << 28 }), 0, true);
  const afterInit = process.memoryUsage().rss;
  console.log(JSON.stringify({ load: afterLoad - before, init: afterInit - afterLoad, cap: N.__tableCap() }));
  process.exit(0);
}

const rt = require('../../packages/rsdom/lib/runtime.cjs');
require('../../packages/rsdom/lib/index.cjs');
const { N } = rt;

let sink = 0;
function bench(name, iters, fn, runs = 7) {
  fn(Math.min(iters, 200_000));
  fn(Math.min(iters, 200_000));
  const res = [];
  for (let r = 0; r < runs; r++) {
    globalThis.gc?.();
    const t0 = process.hrtime.bigint();
    fn(iters);
    res.push(Number(process.hrtime.bigint() - t0) / iters);
  }
  res.sort((a, b) => a - b);
  return { name, best: res[0], median: res[res.length >> 1] };
}

// --- raw u32 crossing
const echo = bench('raw u32 crossing (__echo)', 10_000_000, (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += N.__echo(i & 1023);
  sink += s;
});

// --- getAttr-shaped: (id, atom) -> latin1 string
const doc = N.createDocument(0, null);
rt.afterAlloc();
const div = N.createElement(doc, rt.lookupAtom('div'), 0);
const title = rt.lookupAtom('title');
N.setAttr(div, title, 'hello world');
const getAttr = bench('getAttr (2 x u32 -> latin1 "hello world")', 5_000_000, (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += N.getAttr(div, title).length;
  sink += s;
});
const hasAttr = bench('hasAttr (2 x u32 -> bool)', 5_000_000, (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += N.hasAttr(div, title) ? 1 : 0;
  sink += s;
});
const setAttr = bench('setAttr (2 x u32 + 11-char string)', 2_000_000, (n) => {
  for (let i = 0; i < n; i++) N.setAttr(div, title, 'hello world');
});

// --- build a 4096-node 4-ary tree through natives, then walk the shared table from JS
const ROOT = N.createElement(doc, rt.lookupAtom('div'), 0);
const nodes = [ROOT];
const span = rt.lookupAtom('span');
for (let i = 1; i < 4096; i++) {
  const id = N.createElement(doc, span, 0);
  N.appendChild(nodes[(i - 1) >> 2], id);
  nodes.push(id);
}
rt.afterAlloc();

function walkTable(root) {
  // DFS via firstChild / nextSibling / parent reads on the zero-copy table: no crossings.
  const T = rt.V.T;
  let count = 0;
  let n = root;
  while (n !== 0) {
    count++;
    const o = n << 4;
    if (T[o + 1] !== 0) {
      n = T[o + 1];
      continue;
    }
    while (n !== root && T[(n << 4) + 4] === 0) n = T[n << 4];
    n = n === root ? 0 : T[(n << 4) + 4];
  }
  return count;
}
const walk = bench('JS table walk (ns/node, 4096 nodes)', 2000, (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += walkTable(ROOT);
  sink += s;
});
walk.best /= 4096;
walk.median /= 4096;

// --- same walk through the facade wrappers (firstChild/nextSibling getters + W[] identity)
const rootEl = rt.wrap(ROOT);
function walkWrappers(root) {
  let count = 0;
  let n = root;
  while (n !== null) {
    count++;
    const f = n.firstChild;
    if (f !== null) {
      n = f;
      continue;
    }
    while (n !== root && n.nextSibling === null) n = n.parentNode;
    n = n === root ? null : n.nextSibling;
  }
  return count;
}
const walkW = bench('facade walk via node.firstChild/nextSibling (ns/node)', 500, (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += walkWrappers(rootEl);
  sink += s;
});
walkW.best /= 4096;
walkW.median /= 4096;

const rss = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--rss-child']).toString());

const gates = [
  [echo, 35],
  [getAttr, 90],
  [walk, 10],
];
const lines = [];
const env = `Node ${process.version}, ${os.cpus()[0].model} x${os.cpus().length}, ${os.platform()} ${os.release()}, shared=${rt.shared}`;
lines.push(`# rsdom M0 gates (${new Date().toISOString()})`, `# ${env}`, '# ns/op: best / median of 7 runs');
for (const r of [echo, getAttr, hasAttr, setAttr, walk, walkW]) {
  const gate = gates.find(([g]) => g === r);
  const verdict = gate ? (r.median <= gate[1] ? `PASS (gate <= ${gate[1]})` : `MISS (gate <= ${gate[1]})`) : '(info)';
  lines.push(`${r.name.padEnd(56)} ${r.best.toFixed(1).padStart(7)} / ${r.median.toFixed(1).padStart(7)}  ${verdict}`);
}
const kib = (b) => `${(b / 1024).toFixed(0)} KiB`;
lines.push(`${'RSS growth: addon load / init()'.padEnd(56)} ${kib(rss.load).padStart(7)} / ${kib(rss.init).padStart(7)}  ${rss.init < 1 << 20 ? 'PASS (init < 1 MiB)' : 'MISS (init < 1 MiB)'}`);
lines.push(`# init() reserves ${rss.cap} records (${(rss.cap * 64) >> 20} MiB virtual, mmap MAP_NORESERVE): pages commit on first touch`);
const text = lines.join('\n') + '\n';
process.stdout.write(text);
if (process.argv.includes('--write')) fs.writeFileSync(path.join(here, 'm0-gates.txt'), text);
if (sink === 42) console.log('');
