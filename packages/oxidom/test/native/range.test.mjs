// oxidom-only live-range protocols (lib/range.cjs, src/range.rs, DESIGN §25): boundary points live in a buffer
// shared with Rust and move inside the mutation natives (nothing in JS wraps them); ranges are bucketed by
// document, re-bucketed when JS sets a point in another document or an adoption moves their nodes; more ranges
// than the first buffer holds stay live; dropped ranges are freed by GC; ranges of a reset env stay inert.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

afterAll(() => {
  rt.reset();
});

const pts = (r) => [r.startContainer, r.startOffset, r.endContainer, r.endOffset];

describe('ranges (oxidom protocols)', () => {
  it('mutation natives stay unwrapped: points move inside Rust', () => {
    const { document } = createWindow();
    const natives = { ...rt.N };
    const host = document.createElement('div');
    host.innerHTML = '<p>ab</p><p>cd</p>';
    const r = document.createRange();
    r.setStart(host.lastChild.firstChild, 1);
    r.setEnd(host, 2);
    host.firstChild.remove();
    expect(pts(r)).toEqual([host.firstChild.firstChild, 1, host, 1]);
    // no facade wrapper was installed over a mutation native
    for (const k of ['removeChild', 'insertBefore', 'replaceData', 'splitText', 'normalize', 'textContentSet']) {
      expect(rt.N[k]).toBe(natives[k]);
    }
  });

  it('a point set in another document moves the range to that bucket', () => {
    const { document } = createWindow();
    const other = document.implementation.createHTMLDocument('');
    other.body.append(other.createElement('i'));
    const r = document.createRange();
    r.selectNodeContents(other.body);
    other.body.prepend(other.createElement('b'));
    expect(pts(r)).toEqual([other.body, 0, other.body, 2]);
    // back into the first document, then into an Attr (no bucket), then back again
    r.setEnd(document.body, 0);
    expect(r.startContainer).toBe(document.body);
    document.body.prepend(document.createElement('s'));
    expect(r.startOffset).toBe(0);
    const attr = document.createAttribute('x');
    r.setStart(attr, 0);
    document.body.firstChild.remove();
    expect(pts(r)).toEqual([attr, 0, attr, 0]);
    document.body.append(document.createElement('u'));
    r.selectNodeContents(document.body);
    const n = document.body.childNodes.length;
    document.body.prepend(document.createElement('s'));
    expect(r.endOffset).toBe(n + 1); // prepend before child 0: offsets past 0 shift
  });

  it('more live ranges than the first buffer holds are all moved', () => {
    const { document } = createWindow();
    const host = document.createElement('div');
    host.innerHTML = '<b></b><i></i>';
    const rs = [];
    for (let i = 0; i < 1000; i++) {
      const r = document.createRange();
      r.setStart(host, 2);
      rs.push(r);
    }
    host.firstChild.remove();
    expect(rs.every((r) => r.startOffset === 1 && r.endOffset === 1)).toBe(true);
  });

  it('ranges of a reset env return their last points and never touch the new env', () => {
    const { document } = createWindow();
    const r = document.createRange();
    r.selectNodeContents(document.body);
    const body = document.body;
    rt.reset();
    expect(r.startContainer).toBe(body);
    const { document: d2 } = createWindow();
    d2.body.innerHTML = '<p>x</p>';
    d2.body.firstChild.remove();
    expect(r.startOffset).toBe(0);
    expect(r.toString()).toBe('');
  });

  it('dropped ranges are freed by GC, and mutations then skip the range steps', () => {
    const lib = require.resolve('../../lib/index.cjs');
    const script = `
      const { createWindow, rt } = require(${JSON.stringify(lib)});
      const { document } = createWindow();
      (() => { for (let i = 0; i < 5000; i++) document.createRange(); })();
      const before = rt.N.rangeLive();
      (async () => {
        for (let i = 0; i < 20 && rt.N.rangeLive() > 0; i++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
        const kept = document.createRange();
        console.log(JSON.stringify({ before, after: rt.N.rangeLive() }));
      })();`;
    const r = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    const { before, after } = JSON.parse(r.stdout);
    expect(before).toBe(5000);
    expect(after).toBe(1);
  });
});
