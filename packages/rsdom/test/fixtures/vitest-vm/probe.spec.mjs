// What a test file sees in a VM pool: the same under jsdom and jetdom.
import { test, expect } from 'vitest';

test('globals', () => {
  const id = setTimeout(() => {}, 0);
  clearTimeout(id);
  const probe = {
    window: window === globalThis && self === window,
    jsdom: typeof jsdom.reconfigure,
    url: document.URL,
    html: document.documentElement.outerHTML,
    visual: [typeof requestAnimationFrame, document.hidden],
    timer: typeof id,
    interfaces: document.createElement('div') instanceof HTMLElement,
    node: ['URL', 'TextEncoder', 'AbortController', 'atob', 'queueMicrotask', 'structuredClone', 'fetch', 'Response', 'Request', 'Headers', 'MessageChannel', 'Buffer', 'setImmediate', 'process'].map((k) => typeof globalThis[k]),
    storage: typeof localStorage.setItem,
  };
  expect(probe).toEqual({
    window: true,
    jsdom: 'function',
    url: 'http://localhost:3000/vm',
    html: '<html><head></head><body></body></html>',
    visual: ['function', false],
    timer: 'number',
    interfaces: true,
    node: ['function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'object'],
    storage: 'function',
  });
  document.body.innerHTML = '<p>left behind</p>';
});

test('FileReader results are the test realm\'s ArrayBuffers', async () => {
  const reader = new FileReader();
  const done = new Promise((resolve) => reader.addEventListener('load', resolve));
  reader.readAsArrayBuffer(new Blob(['abc']));
  await done;
  expect(reader.result instanceof ArrayBuffer).toBe(true);
});
