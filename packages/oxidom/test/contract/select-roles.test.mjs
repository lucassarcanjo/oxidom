// ROADMAP M3 acceptance: the aria-query role selectors that DTL generates (data/role-selectors.txt, from
// refs/dom-testing-library/src/role-helpers.js L80-139) give identical matches() results on oxidom and
// jsdom over every element of a generated fixture; DTL's own getImplicitAriaRoles agrees too.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, pkgDir, CRATE_DATA } = require('./adapter.cjs');

const SELECTORS = fs.readFileSync(path.join(CRATE_DATA, 'role-selectors.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

/** Element specs [tag, [[attr, value]...]] covering every tag / attribute / value the selectors test. */
function fixtureSpecs() {
  const tags = new Set();
  const attrVals = new Map();
  for (const s of SELECTORS) {
    tags.add(/^[a-z0-9]+/.exec(s)[0]);
    for (const m of s.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)) {
      if (!attrVals.has(m[1])) attrVals.set(m[1], new Set(['', 'x']));
      if (m[2] !== undefined) attrVals.get(m[1]).add(m[2]);
    }
  }
  attrVals.get('type').add('CHECKBOX').add('Text').add('text').add('bogus');
  const specs = [];
  for (const t of tags) {
    specs.push([t, []]);
    for (const [a, vals] of attrVals) for (const v of vals) specs.push([t, [[a, v]]]);
  }
  for (const t of attrVals.get('type')) {
    for (const l of ['', 'dl']) specs.push(['input', [['type', t], ['list', l]]]);
  }
  specs.push(['select', [['multiple', ''], ['size', '2']]]);
  specs.push(['img', [['alt', 'a'], ['role', 'presentation']]]);
  specs.push(['section', [['aria-label', 'n'], ['aria-labelledby', '']]]);
  specs.push(['th', [['scope', 'COL']]]);
  return specs;
}

function build(document) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const els = [];
  for (const [tag, attrs] of fixtureSpecs()) {
    const el = document.createElement(tag);
    for (const [a, v] of attrs) el.setAttribute(a, v);
    host.appendChild(el);
    els.push(el);
  }
  return els;
}


describe.each(DOMS.filter((k) => k !== 'jsdom'))('DTL role selectors vs jsdom [%s]', (kind) => {
  it('matches() is identical on every element of the generated fixture', () => {
    const oracle = build(makeWindow('jsdom').document);
    const w = makeWindow(kind);
    const els = build(w.document);
    expect(els.length).toBe(oracle.length);
    expect(SELECTORS.length).toBeGreaterThan(100);
    const diffs = [];
    let hits = 0;
    for (const s of SELECTORS) {
      for (let i = 0; i < els.length; i++) {
        const want = oracle[i].matches(s);
        const got = els[i].matches(s);
        if (want) hits++;
        if (got !== want) diffs.push(`${s} on ${oracle[i].outerHTML}: got ${got}`);
      }
    }
    expect(hits).toBeGreaterThan(300);
    if (kind === 'happy-dom') return; // PINNED to jsdom: reported only
    expect(diffs).toEqual([]);
  });

  it("DTL's getImplicitAriaRoles agrees with jsdom", () => {
    const helpers = path.join(pkgDir('@testing-library/dom'), 'dist/role-helpers.js');
    const roleHelpers = require(helpers);
    const oracle = build(makeWindow('jsdom').document);
    const w = makeWindow(kind);
    const els = build(w.document);
    const diffs = [];
    let withRole = 0;
    for (let i = 0; i < els.length; i++) {
      if (roleHelpers.getImplicitAriaRoles(oracle[i]).length > 0) withRole++;
      const want = roleHelpers.getImplicitAriaRoles(oracle[i]).join(',');
      const got = roleHelpers.getImplicitAriaRoles(els[i]).join(',');
      if (got !== want) diffs.push(`${oracle[i].outerHTML}: got ${got} want ${want}`);
    }
    expect(withRole).toBeGreaterThan(300);
    if (kind === 'happy-dom') return; // PINNED to jsdom: reported only
    expect(diffs).toEqual([]);
  });
});
