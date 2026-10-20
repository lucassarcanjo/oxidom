// A test that returns with an XMLHttpRequest still in flight (headers received, body never ending) and handlers
// that throw on any completion. Teardown (rt.reset() -> abortRequests) must drop it without events, so no run
// reports an error; under isolate: false it stays in flight while the next files run, as it would under jsdom.
import { test, expect } from 'vitest';
import http from 'node:http';

test('leaves a request in flight', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    res.write('s'); // never ends
  });
  server.unref();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const x = new XMLHttpRequest();
  for (const t of ['load', 'error', 'abort', 'timeout', 'loadend']) {
    x[`on${t}`] = () => {
      throw new Error(`xhr-leak: ${t} after the test`);
    };
  }
  x.open('GET', `http://127.0.0.1:${server.address().port}/slow`);
  x.send();
  await new Promise((r) => x.addEventListener('progress', r, { once: true }));
  expect(x.readyState).toBe(3);
});
