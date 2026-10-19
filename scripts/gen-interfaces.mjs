#!/usr/bin/env node
// Regenerates crates/rsdom/data/interfaces.json from the jsdom reference checkout:
//   - tag -> interface mapping: refs/jsdom/lib/jsdom/living/helpers/create-element.js (INTERFACE_TAG_MAPPING,
//     UNKNOWN_HTML_ELEMENTS_NAMES, HTML_ELEMENTS_NAMES)
//   - interface -> parent interface: refs/jsdom/lib/jsdom/living/nodes/<Interface>.webidl ("interface X : Y")
//
// The output is committed so the build stays hermetic (refs/ is gitignored; populate it with
// `scripts/fetch-refs.sh`). build.rs turns it into packages/rsdom/lib/generated/interfaces.cjs.
// Run: `node scripts/gen-interfaces.mjs` (RSDOM_REFS overrides the refs/ location).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const refs = process.env.RSDOM_REFS ?? path.resolve(here, '../refs');
const living = path.join(refs, 'jsdom/lib/jsdom/living');
const src = fs.readFileSync(path.join(living, 'helpers/create-element.js'), 'utf8');

function extract(startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  let i = src.indexOf('=', start) + 1;
  const open = src[src.slice(i).search(/[[{]/) + i];
  const close = open === '{' ? '}' : ']';
  i = src.indexOf(open, i);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced literal');
}

const literal = extract('const INTERFACE_TAG_MAPPING')
  .replace(/__proto__:\s*null,?/g, '')
  .replace(/\[HTML_NS\]/g, '"html"')
  .replace(/\[SVG_NS\]/g, '"svg"');
const mapping = new Function(`return (${literal});`)();
const unknown = new Function(`return ${extract('const UNKNOWN_HTML_ELEMENTS_NAMES')};`)();
const plainHtml = new Function(`return ${extract('const HTML_ELEMENTS_NAMES')};`)();

function parentOf(iface) {
  const file = path.join(living, 'nodes', `${iface}.webidl`);
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/interface\s+\w+\s*:\s*(\w+)/);
  return m ? m[1] : null;
}

const out = { source: 'refs/jsdom/lib/jsdom/living/helpers/create-element.js (jsdom 30.1.3)', html: {}, svg: {}, parents: {}, unknownHtml: unknown, plainHtml };
for (const ns of ['html', 'svg']) {
  for (const [iface, tags] of Object.entries(mapping[ns])) {
    out[ns][iface] = tags;
    out.parents[iface] = parentOf(iface) ?? (ns === 'html' ? 'HTMLElement' : 'SVGElement');
  }
}
out.parents.HTMLElement = 'Element';
out.parents.SVGElement = 'Element';
fs.writeFileSync(path.join(here, '../crates/rsdom/data/interfaces.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote data/interfaces.json: ${Object.keys(out.html).length} HTML + ${Object.keys(out.svg).length} SVG interfaces`);
