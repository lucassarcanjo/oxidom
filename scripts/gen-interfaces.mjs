#!/usr/bin/env node
// Regenerates crates/oxidom/data/interfaces.json from the jsdom reference checkout:
//   - tag -> interface mapping: refs/jsdom/lib/jsdom/living/helpers/create-element.js (INTERFACE_TAG_MAPPING,
//     UNKNOWN_HTML_ELEMENTS_NAMES, HTML_ELEMENTS_NAMES)
//   - interface -> parent interface: refs/jsdom/lib/jsdom/living/nodes/<Interface>.webidl ("interface X : Y")
//   - interface -> reflected IDL attributes: every `[Reflect*]` attribute of living/nodes/*.webidl and
//     living/aria/*.webidl, mixins folded into the interfaces that include them (DESIGN §37)
//
// The output is committed so the build stays hermetic (refs/ is gitignored; populate it with
// `scripts/fetch-refs.sh`). build.rs turns it into packages/oxidom/lib/generated/interfaces.cjs.
// Run: `node scripts/gen-interfaces.mjs` (OXIDOM_REFS overrides the refs/ location).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const refs = process.env.OXIDOM_REFS ?? path.resolve(here, '../refs');
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

/** `[ext] attribute [LegacyNullToEmptyString] T name;` lines of one interface body. */
const ATTR_RE = /^\s*\[([^\]]*)\]\s*(readonly\s+)?attribute\s+(\[LegacyNullToEmptyString\]\s+)?([\w ]+\??)\s+(\w+)\s*;/;

/**
 * `{ Interface: [[prop, attr, kind, opts?], ...] }` for every reflected attribute jsdom declares. kind is the
 * IDL type reduced to how it reflects: str, str? (nullable), str0 ([LegacyNullToEmptyString]), url
 * ([ReflectURL]), bool, long, ulong, double. opts carries ReflectDefault (d), ReflectRange (range),
 * ReflectNonNegative / ReflectPositive / ReflectPositiveWithFallback (nonNeg / pos / posFb).
 */
function reflected() {
  const own = new Map();
  const includes = [];
  for (const dir of ['nodes', 'aria']) {
    for (const f of fs.readdirSync(path.join(living, dir)).filter((n) => n.endsWith('.webidl')).sort()) {
      const text = fs.readFileSync(path.join(living, dir, f), 'utf8').replace(/\/\/.*$/gm, '');
      for (const m of text.matchAll(/^(\w+) includes (\w+);/gm)) includes.push([m[1], m[2]]);
      for (const m of text.matchAll(/interface\s+(?:mixin\s+)?(\w+)[^{]*\{([^}]*)\}/g)) {
        for (const line of m[2].split('\n')) {
          const a = ATTR_RE.exec(line);
          if (a === null || !/\bReflect/.test(a[1]) || a[2]) continue; // readonly: SVG animated values
          const ext = a[1];
          const prop = a[5];
          const attr = /\bReflect="([^"]+)"/.exec(ext)?.[1] ?? prop.toLowerCase();
          const type = a[4].trim();
          let kind;
          if (/\bReflectURL\b/.test(ext)) kind = 'url';
          else if (type === 'DOMString?') kind = 'str?';
          else if (type === 'DOMString' || type === 'USVString') kind = a[3] ? 'str0' : 'str';
          else kind = { boolean: 'bool', long: 'long', 'unsigned long': 'ulong', double: 'double' }[type];
          if (kind === undefined) throw new Error(`${f}: unhandled reflected type ${type} ${prop}`);
          const opts = {};
          const d = /\bReflectDefault=([-\d.]+)/.exec(ext);
          if (d !== null) opts.d = Number(d[1]);
          const r = /\bReflectRange=\((\d+),\s*(\d+)\)/.exec(ext);
          if (r !== null) opts.range = [Number(r[1]), Number(r[2])];
          if (/\bReflectNonNegative\b/.test(ext)) opts.nonNeg = true;
          if (/\bReflectPositive\b/.test(ext)) opts.pos = true;
          if (/\bReflectPositiveWithFallback\b/.test(ext)) opts.posFb = true;
          const list = own.get(m[1]) ?? [];
          list.push(Object.keys(opts).length ? [prop, attr, kind, opts] : [prop, attr, kind]);
          own.set(m[1], list);
        }
      }
    }
  }
  for (const [iface, mixin] of includes) {
    if (!own.has(mixin)) continue;
    own.set(iface, [...(own.get(iface) ?? []), ...own.get(mixin)]);
  }
  const mixins = new Set(includes.map(([, m]) => m));
  return Object.fromEntries([...own].filter(([k]) => !mixins.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const out = { source: 'refs/jsdom/lib/jsdom/living/helpers/create-element.js (jsdom 30.1.3)', html: {}, svg: {}, parents: {}, unknownHtml: unknown, plainHtml };
for (const ns of ['html', 'svg']) {
  for (const [iface, tags] of Object.entries(mapping[ns])) {
    out[ns][iface] = tags;
    out.parents[iface] = parentOf(iface) ?? (ns === 'html' ? 'HTMLElement' : 'SVGElement');
  }
}
out.parents.HTMLElement = 'Element';
out.reflect = reflected();
out.parents.SVGElement = 'Element';
// One line per reflected attribute keeps the table reviewable.
const { reflect, ...rest } = out;
const table = Object.entries(reflect)
  .map(([k, list]) => `  ${JSON.stringify(k)}: [\n${list.map((a) => `   ${JSON.stringify(a).replace(/([,:])(?=["{[\d])/g, '$1 ')}`).join(',\n')}\n  ]`)
  .join(',\n');
const json = `${JSON.stringify(rest, null, 1).slice(0, -2)},\n "reflect": {\n${table}\n }\n}`;
fs.writeFileSync(path.join(here, '../crates/oxidom/data/interfaces.json'), json + '\n');
console.log(`wrote data/interfaces.json: ${Object.keys(out.html).length} HTML + ${Object.keys(out.svg).length} SVG interfaces`);
