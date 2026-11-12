// Area B microbenchmarks (events, focus, form controls), one fresh Node process per DOM (jsdom 30.1.3,
// happy-dom 21.0.3, oxidom). Reads interleave writes where a DOM could otherwise serve a cached answer.
//   node bench/micro/events-forms.mjs [--write]        (needs a release build: npm run build)
//   OXIDOM_SHARED=0 / OXIDOM_NO_MEMO=1 node bench/micro/events-forms.mjs   (ablations)
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

/** ns/op: two warm-ups, then the median of 7 timed runs. */
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

/** What React's SyntheticEvent + plugins read from a native MouseEvent (react-dom.md §5.3). */
const MOUSE_PROPS = ['type', 'target', 'currentTarget', 'eventPhase', 'bubbles', 'cancelable', 'timeStamp',
  'defaultPrevented', 'isTrusted', 'view', 'detail', 'screenX', 'screenY', 'clientX', 'clientY', 'pageX', 'pageY',
  'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget', 'movementX', 'movementY'];

function runChild(kind) {
  const { makeWindow } = require('../../packages/oxidom/test/contract/adapter.cjs');
  const w = makeWindow(kind);
  const d = w.document;
  const body = d.body;
  const out = {};
  let sink = 0;

  // React registers ~143 listeners per root container (react-dom.md §5.1).
  const TYPES = Array.from({ length: 72 }, (_, i) => `ev${i}`);
  const noop = () => {};
  const host = d.createElement('div');
  out['addEventListener + removeEventListener x143, one container (us)'] = bench(2000, (n) => {
    for (let k = 0; k < n; k++) {
      for (const t of TYPES) {
        host.addEventListener(t, noop, true);
        host.addEventListener(t, noop, false);
      }
      for (const t of TYPES) {
        host.removeEventListener(t, noop, true);
        host.removeEventListener(t, noop, false);
      }
    }
  }) / 1000;
  // A fresh container per "root" with fresh closures: oxidom retains every wrapper (and its listeners) for the
  // env's lifetime (no reclamation, DESIGN §11), so this row is dominated by GC of the retained heap.
  out['fresh container + 143 new listeners, retained (us)'] = bench(200, (n) => {
    for (let k = 0; k < n; k++) {
      const c = d.createElement('div');
      for (const t of TYPES) {
        c.addEventListener(t, () => {}, true);
        c.addEventListener(t, () => {}, false);
      }
    }
  }) / 1000;

  // 20-deep tree, React-like root listeners (capture + bubble) reading the synthetic-event interface.
  const root = d.createElement('div');
  body.appendChild(root);
  let leaf = root;
  for (let i = 0; i < 20; i++) {
    const c = d.createElement('div');
    leaf.appendChild(c);
    leaf = c;
  }
  const reactLike = (e) => {
    let s = 0;
    for (let i = 0; i < MOUSE_PROPS.length; i++) if (e[MOUSE_PROPS[i]]) s++;
    if (w.event !== undefined) s++;
    sink += s;
  };
  root.addEventListener('click', reactLike, true);
  root.addEventListener('click', reactLike, false);
  out['new MouseEvent + dispatch, 20 levels, React-like root listeners (ns)'] = bench(50_000, (n) => {
    for (let i = 0; i < n; i++) leaf.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: i & 7 }));
  });
  out['dispatch only (event reused), 20 levels (ns)'] = bench(50_000, (n) => {
    const e = new w.MouseEvent('click', { bubbles: true, cancelable: true });
    for (let i = 0; i < n; i++) leaf.dispatchEvent(e);
  });

  // checkbox click: activation behaviour (toggle + input + change)
  const cb = d.createElement('input');
  cb.type = 'checkbox';
  root.appendChild(cb);
  let changes = 0;
  cb.addEventListener('change', () => changes++);
  out['checkbox click() with activation (ns)'] = bench(50_000, (n) => {
    for (let i = 0; i < n; i++) cb.click();
  });
  sink += changes;

  // focus: alternate two inputs (blur/focusout/focus/focusin each time) with a capture listener on document
  const a = d.createElement('input');
  const b = d.createElement('input');
  root.appendChild(a);
  root.appendChild(b);
  let focusEvents = 0;
  d.addEventListener('focus', () => focusEvents++, true);
  out['focus() alternating two inputs (ns/focus)'] = bench(20_000, (n) => {
    for (let i = 0; i < n; i++) (i & 1 ? a : b).focus();
  });
  out['document.activeElement (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (d.activeElement !== null) s++;
    sink += s;
  });
  sink += focusEvents;

  // input value
  const inp = d.createElement('input');
  root.appendChild(inp);
  inp.value = 'hello';
  out['input.value get, unchanged (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += inp.value.length;
    sink += s;
  });
  out['input.value set + get (ns/pair)'] = bench(200_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      inp.value = i & 1 ? 'hello' : 'world!';
      s += inp.value.length;
    }
    sink += s;
  });
  out['input.checked get (ns)'] = bench(500_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (cb.checked) s++;
    sink += s;
  });
  out['setSelectionRange + selectionStart get (ns/pair)'] = bench(200_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      inp.setSelectionRange(i & 3, 5);
      s += inp.selectionStart;
    }
    sink += s;
  });
  const sel = d.createElement('select');
  sel.innerHTML = '<option value="a">A</option><option value="b">B</option><option value="c">C</option>';
  root.appendChild(sel);
  out['select.value set + get (ns/pair)'] = bench(100_000, (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      sel.value = i & 1 ? 'b' : 'c';
      s += sel.value.length;
    }
    sink += s;
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
  const flags = ['OXIDOM_SHARED', 'OXIDOM_NO_MEMO'].map((f) => `${f}=${process.env[f] ?? '-'}`).join(' ');
  const lines = [
    `# oxidom area B micro: events / focus / forms (${new Date().toISOString()})`,
    `# Node ${process.version}, ${os.cpus()[0].model} x${os.cpus().length}; ${flags}; median of 7 runs, one process per DOM`,
    '# One process per DOM, no cross-process spread (unlike run.mjs): use for orders of magnitude; load average at start is not recorded.',
    `${'operation'.padEnd(72)}${'jsdom'.padStart(10)}${'happy-dom'.padStart(11)}${'oxidom'.padStart(10)}`,
  ];
  for (const r of rows) {
    lines.push(`${r.padEnd(72)}${fmt(results.jsdom[r]).padStart(10)}${fmt(results['happy-dom'][r]).padStart(11)}${fmt(results.oxidom[r]).padStart(10)}`);
  }
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    const suffix = process.env.OXIDOM_SHARED === '0' ? '-fallback' : process.env.OXIDOM_NO_MEMO === '1' ? '-nomemo' : '';
    fs.writeFileSync(path.join(here, `events-forms${suffix}.txt`), text);
  }
}
