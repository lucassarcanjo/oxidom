'use strict';
// makeWindow('jsdom' | 'happy-dom' | 'oxidom'): one parity harness for all three DOMs (ROADMAP "Testing before M6").
// jsdom / happy-dom (and the Testing Library packages some suites use) are oxidom's devDependencies.
// Options mirror Vitest's built-in environments (refs/vitest/packages/vitest/src/integrations/env/jsdom.ts):
// url http://localhost:3000, '<!DOCTYPE html>', runScripts 'dangerously' (=> scripting enabled for parsing).
const path = require('node:path');
const fs = require('node:fs');

function load(name) {
  return require(name);
}

/** Root directory of an installed package (works for packages whose `exports` hide package.json). */
function pkgDir(name) {
  let dir = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`package root of ${name} not found`);
    dir = up;
  }
  return dir;
}

/** Build inputs of the Rust crate (role selectors, CSS tables). */
const CRATE_DATA = path.resolve(__dirname, '../../../../crates/oxidom/data');

/** DOMs under test; restrict with OXIDOM_CONTRACT_DOMS=oxidom,jsdom */
const DOMS = (process.env.OXIDOM_CONTRACT_DOMS ?? 'jsdom,happy-dom,oxidom').split(',').map((s) => s.trim()).filter(Boolean);

const URL = 'http://localhost:3000/';

/** @param {{ url?: string }} [options] the document URL (default http://localhost:3000/) */
function makeWindow(kind, { url = URL } = {}) {
  switch (kind) {
    case 'jsdom': {
      const { JSDOM } = load('jsdom');
      const dom = new JSDOM('<!DOCTYPE html>', { url, pretendToBeVisual: true, runScripts: 'dangerously' });
      return dom.window;
    }
    case 'happy-dom': {
      const { Window } = load('happy-dom');
      const w = new Window({ url });
      w.document.write('<!DOCTYPE html><html><head></head><body></body></html>');
      return w;
    }
    case 'oxidom': {
      const { createWindow } = require('../../lib/index.cjs');
      return createWindow({ url }).window;
    }
    default:
      throw new Error(`unknown DOM ${kind}`);
  }
}

/** Catches and returns the error name (or 'ok'). */
function errName(fn) {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e && e.name;
  }
}

module.exports = { makeWindow, DOMS, errName, load, pkgDir, CRATE_DATA };
