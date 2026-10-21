'use strict';
// A window on a fresh vm context (DESIGN §32, §33): the Jest environment and Vitest's VM pools run test files in
// a vm context whose global is the window. rsdom's window lives in this realm, so this opens a browsing context
// (lib/context.cjs, DESIGN §18) on a bare context's global, with window timers of its own (a vm context has none)
// and the members a jsdom window has that rsdom otherwise takes from Node's global.
const vm = require('node:vm');
const context = require('./context.cjs');

/** jsdom window members that rsdom's window takes from Node's global. */
const NODE_GLOBALS = [
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'Headers', 'TextEncoder', 'TextDecoder', 'WebSocket',
  'Performance', 'performance', 'Crypto', 'crypto', 'queueMicrotask', 'atob', 'btoa',
];

/**
 * Opens a browsing context on a new vm context's global. `options` are `context.open()`'s (url, source,
 * settings, catchErrors).
 * @returns {{ vmContext: object, global: object, ctx: import('./context.cjs').BrowsingContext }}
 */
function openVmWindow(options) {
  const vmContext = vm.createContext();
  const global = vm.runInContext('this', vmContext);
  for (const k of NODE_GLOBALS) {
    if (globalThis[k] !== undefined) Object.defineProperty(global, k, { value: globalThis[k], writable: true, configurable: true });
  }
  const ctx = context.open({ ...options, global, ownTimers: true });
  global.webkitURL = global.URL;
  return { vmContext, global, ctx };
}

module.exports = { openVmWindow, NODE_GLOBALS };
