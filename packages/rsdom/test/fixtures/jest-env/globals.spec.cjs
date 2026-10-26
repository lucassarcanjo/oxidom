// What a test file sees: the same on jest-environment-jsdom and jest-environment-nativedom.
test('globals', () => {
  const id = setTimeout(() => {}, 0);
  clearTimeout(id);
  expect({
    window: window === globalThis && global === globalThis && self === window,
    url: document.URL,
    doctype: document.doctype?.name,
    html: document.documentElement.outerHTML,
    visual: [typeof requestAnimationFrame, document.hidden, document.visibilityState],
    timer: typeof id,
    interfaces: document.createElement('div') instanceof HTMLElement && new Event('x') instanceof Event,
    node: [typeof URL, typeof TextEncoder, typeof AbortController, typeof atob, typeof queueMicrotask, typeof performance.now, typeof crypto.getRandomValues],
    notInJsdom: [typeof fetch, typeof structuredClone],
    storage: typeof localStorage.setItem,
    process: typeof process.env,
  }).toEqual({
    window: true,
    url: 'http://localhost/',
    doctype: 'html',
    html: '<html><head></head><body></body></html>',
    visual: ['function', false, 'visible'],
    timer: 'number',
    interfaces: true,
    node: ['function', 'function', 'function', 'function', 'function', 'function', 'function'],
    notInJsdom: ['undefined', 'undefined'],
    storage: 'function',
    process: 'object',
  });
});

test('the window and TextEncoder output belong to the test realm', () => {
  expect(Object.prototype.toString.call(window)).toBe('[object Window]');
  expect(new TextEncoder().encode('a')).toEqual(new Uint8Array([97]));
  expect(new TextEncoder().encode('a') instanceof Uint8Array).toBe(true);
});

test('a DOM change in one test is still there in the next (one document per file)', () => {
  document.body.innerHTML = '<p id=kept>1</p>';
});

test('...as on jsdom', () => {
  expect(document.getElementById('kept')).not.toBe(null);
});
