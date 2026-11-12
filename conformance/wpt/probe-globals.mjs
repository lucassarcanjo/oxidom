// Records, for each DOM's Vitest environment, whether a global the WPT areas depend on is provided by the DOM,
// left as Node's own implementation, or absent (results/globals.json). Explains areas where the numbers
// measure Node rather than the DOM (encoding: TextDecoder is Node's in all three environments).
//
// Usage: node conformance/wpt/probe-globals.mjs
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAB, RESULTS, DOMS, writeJSON } from './lib.mjs';

export const NAMES = ['TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Blob', 'File', 'FileReader',
  'FormData', 'URL', 'URLSearchParams', 'DOMException', 'EventTarget', 'Event', 'CustomEvent', 'structuredClone',
  'setTimeout', 'queueMicrotask', 'MessageChannel', 'fetch', 'Headers', 'XMLHttpRequest', 'localStorage',
  'sessionStorage', 'NodeFilter', 'NodeIterator', 'TreeWalker', 'customElements', 'ShadowRoot', 'XPathEvaluator',
  'Range', 'StaticRange', 'Selection', 'CSSStyleSheet', 'DOMParser', 'XMLSerializer', 'MutationObserver'];

if (process.argv[2] === '--child') {
  const kind = process.argv[3];
  const before = {};
  for (const n of NAMES) before[n] = globalThis[n];
  const env = kind === 'oxidom'
    ? (await import(pathToFileURL(path.join(LAB, 'packages/oxidom/lib/vitest-environment.mjs')).href)).default
    : (await import(pathToFileURL(path.join(LAB, 'node_modules/vitest/dist/runtime.js')).href)).builtinEnvironments[kind];
  const r = await env.setup(globalThis, {});
  const out = {};
  for (const n of NAMES) {
    let v;
    try {
      v = globalThis[n];
    } catch {
      v = undefined;
    }
    out[n] = v === undefined ? 'absent' : before[n] !== undefined && v === before[n] ? 'node' : 'dom';
  }
  await r.teardown(globalThis);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} else {
  const res = {};
  for (const d of DOMS) {
    res[d] = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', d], {
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    }));
  }
  writeJSON(path.join(RESULTS, 'globals.json'), {
    legend: 'dom = provided by the DOM environment; node = Node\'s own global left in place; absent = undefined',
    globals: res,
  }, true);
  console.log(res);
}
