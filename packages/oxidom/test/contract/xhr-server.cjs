'use strict';
// Local HTTP server for test/contract/xhr.test.mjs (one per test file, 127.0.0.1, ephemeral port). It records every
// request (method, url, raw headers, body). Every route answers with `Access-Control-Allow-Origin: *` and
// `Access-Control-Allow-Headers: *` unless it says otherwise, and OPTIONS with 204.
const http = require('node:http');
const zlib = require('node:zlib');

function startServer() {
  /** @type {{ method: string, url: string, rawHeaders: string[], body: Buffer }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) };
      requests.push(rec);
      route(req, res, rec);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        requests,
        /** requests whose path starts with `prefix` */
        hits: (prefix) => requests.filter((r) => r.url.startsWith(prefix)),
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

/** Lowercased header -> value of a recorded request (`null` when absent). */
function header(rec, name) {
  const lc = name.toLowerCase();
  for (let i = 0; i < rec.rawHeaders.length; i += 2) if (rec.rawHeaders[i].toLowerCase() === lc) return rec.rawHeaders[i + 1];
  return null;
}

function route(req, res, rec) {
  const u = new URL(req.url, 'http://x');
  const q = (k) => u.searchParams.get(k);
  const path = u.pathname;
  const cors = path !== '/nocors' && path !== '/cors';
  if (cors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
  }
  if (path === '/cors') return corsRoute(req, res, q);
  if (req.method === 'OPTIONS' && cors) {
    res.writeHead(204);
    res.end();
    return;
  }
  switch (path) {
    case '/echo':
    case '/dir/echo':
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, rawHeaders: req.rawHeaders, body: rec.body.toString('base64') }));
      return;
    case '/chunks': {
      res.writeHead(200, q('len') === '1' ? { 'Content-Type': 'text/plain', 'Content-Length': '15' } : { 'Content-Type': 'text/plain' });
      let n = 0;
      const t = setInterval(() => {
        res.write('chunk');
        if (++n === 3) {
          clearInterval(t);
          res.end();
        }
      }, 20);
      return;
    }
    case '/204':
      res.writeHead(204);
      res.end();
      return;
    case '/head':
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '5' });
      res.end(req.method === 'HEAD' ? undefined : 'hello');
      return;
    case '/status':
      res.writeHead(Number(q('code')), q('reason') ?? undefined, { 'Content-Type': 'text/plain' });
      res.end('s');
      return;
    case '/dup':
      res.setHeader('X-B', ['1', '3']);
      res.setHeader('X-A', '2');
      res.setHeader('X-Empty', '');
      res.setHeader('Set-Cookie', 'dup=1');
      res.end('dup');
      return;
    case '/gzip': {
      const body = zlib.gzipSync('hello gzip world');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    case '/redirect': {
      const n = Number(q('n') ?? 1);
      const to = q('to') ?? '/echo';
      const loc = n > 1 ? `/redirect?code=${q('code') ?? 302}&n=${n - 1}&to=${encodeURIComponent(to)}` : to;
      // noloc=1: no Location header; noloc=empty: an empty one
      res.writeHead(Number(q('code') ?? 302), q('noloc') === '1' ? {} : { Location: q('noloc') === 'empty' ? '' : loc });
      res.end();
      return;
    }
    case '/loop':
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    case '/auth':
      if (header(rec, 'authorization') === null) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="t"' });
        res.end('no');
        return;
      }
      res.end(header(rec, 'authorization'));
      return;
    case '/cookie/set':
      res.setHeader('Set-Cookie', `${q('name') ?? 'a'}=${q('v') ?? '1'}; Path=/${q('httponly') === '1' ? '; HttpOnly' : ''}`);
      corsHeaders(req, res, q);
      res.end('set');
      return;
    case '/cookie/echo':
      corsHeaders(req, res, q);
      res.end(header(rec, 'cookie') ?? '');
      return;
    case '/slow':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('s');
      return; // never ends
    case '/hang':
      return; // no response at all
    case '/charset': {
      const ct = q('cs') === null ? 'text/plain' : `text/plain;charset=${q('cs')}`;
      res.writeHead(200, { 'Content-Type': q('ct') ?? ct });
      res.end(Buffer.from(q('bytes'), 'hex'));
      return;
    }
    case '/json':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(q('bad') === '1' ? '{nope' : q('bom') === '1' ? '﻿{"a":[1,2]}' : '{"a":[1,2]}');
      return;
    case '/reset':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('x');
      setTimeout(() => req.socket.destroy(), 30);
      return;
    case '/html':
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end('<!DOCTYPE html><title>T</title><p id="p">hi</p>');
      return;
    case '/xml':
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<r><a/></r>');
      return;
    case '/nocors':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('nocors');
      return;
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nf');
  }
}

/** `acao=echo|star|none`, `acac=1`, `aceh=<list>` on any route that calls it. */
function corsHeaders(req, res, q) {
  const acao = q('acao');
  if (acao === 'echo') res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? 'null');
  else if (acao === 'star') res.setHeader('Access-Control-Allow-Origin', '*');
  else if (acao === 'none') res.removeHeader('Access-Control-Allow-Origin');
  if (q('acac') === '1') res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (q('aceh') !== null) res.setHeader('Access-Control-Expose-Headers', q('aceh'));
}

/** `/cors?acao=echo|star&acac=1&aceh=X-B&preflight=ok|403|noacah` (preflight `ok` allows the requested headers). */
function corsRoute(req, res, q) {
  corsHeaders(req, res, q);
  if (req.method === 'OPTIONS') {
    const p = q('preflight') ?? 'ok';
    if (p === 'noacah') res.writeHead(204);
    else if (p === '403') res.writeHead(403);
    else res.writeHead(204, { 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'X-B': 'b' });
  res.end('cors');
}

module.exports = { startServer, header };
