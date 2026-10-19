// Step 1 of the surface census: parse every WebIDL file jsdom ships under refs/jsdom/lib/jsdom/living into
// a flat list of interfaces (partials and `includes` mixins merged) with their members, classified into a
// spec AREA. Writes results/idl.json. Run: node parse-idl.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'webidl2';

const here = path.dirname(fileURLToPath(import.meta.url));
const living = path.resolve(here, '../../refs/jsdom/lib/jsdom/living');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.webidl')) out.push(p);
  }
  return out;
}

const files = walk(living).sort();
const defs = []; // { def, file, dir }
const parseErrors = [];
for (const f of files) {
  const rel = path.relative(living, f);
  try {
    for (const def of parse(fs.readFileSync(f, 'utf8'))) defs.push({ def, file: rel, dir: rel.split(path.sep)[0] });
  } catch (e) {
    parseErrors.push({ file: rel, error: String(e.message).split('\n')[0] });
  }
}

const xattr = (node, name) => (node.extAttrs ?? []).find((a) => a.name === name);
const xattrRhs = (a) => {
  if (!a || !a.rhs) return [];
  const v = a.rhs.value;
  return Array.isArray(v) ? v.map((x) => x.value) : [v];
};

/** Converts one IDL member into census member records (may yield several, e.g. iterable). */
function membersOf(m, from) {
  const out = [];
  const base = { from };
  const unforgeable = !!xattr(m, 'LegacyUnforgeable');
  switch (m.type) {
    case 'attribute':
      out.push({ ...base, name: m.name, kind: 'attribute', static: m.special === 'static', readonly: !!m.readonly, unforgeable });
      if (m.special === 'stringifier') out.push({ ...base, name: 'toString', kind: 'stringifier', static: false, unforgeable });
      break;
    case 'operation':
      if (m.special === 'stringifier') {
        out.push({ ...base, name: 'toString', kind: 'stringifier', static: false, unforgeable });
        break;
      }
      if (m.name) out.push({ ...base, name: m.name, kind: 'operation', static: m.special === 'static', unforgeable });
      break;
    case 'const':
      out.push({ ...base, name: m.name, kind: 'constant', static: false, unforgeable: false });
      break;
    case 'iterable':
    case 'async_iterable': {
      const names = m.type === 'async_iterable' || m.async ? ['values', '@@asyncIterator'] : ['entries', 'forEach', 'keys', 'values', '@@iterator'];
      for (const n of names) out.push({ ...base, name: n, kind: 'iterator', static: false, unforgeable: false });
      break;
    }
    case 'maplike':
    case 'setlike': {
      const names = ['size', 'entries', 'forEach', 'has', 'keys', 'values', '@@iterator'];
      if (m.type === 'maplike') names.push('get');
      if (!m.readonly) names.push(...(m.type === 'maplike' ? ['set'] : ['add']), 'delete', 'clear');
      for (const n of names) out.push({ ...base, name: n, kind: 'iterator', static: false, unforgeable: false });
      break;
    }
    case 'constructor':
      break;
    default:
      break;
  }
  return out;
}

/** Special getters/setters/deleters (indexed vs named): recorded separately, not prototype properties. */
function specialsOf(m) {
  if (m.type !== 'operation' || !['getter', 'setter', 'deleter'].includes(m.special)) return [];
  const argType = m.arguments?.[0]?.idlType?.idlType;
  const indexed = argType === 'unsigned long';
  return [`${indexed ? 'indexed' : 'named'}-${m.special}${m.name ? `(${m.name})` : ''}`];
}

const ifaces = new Map(); // name -> record
const mixins = new Map(); // name -> { members, specials }
const includes = []; // [target, mixin]
function ensureIface(name, kind) {
  if (!ifaces.has(name))
    ifaces.set(name, { name, kind, parent: null, file: null, dir: null, exposed: null, hasConstructor: false, legacyFactory: [], noInterfaceObject: false, members: [], specials: [], partialFiles: [] });
  return ifaces.get(name);
}

for (const { def, file, dir } of defs) {
  if (def.type === 'interface mixin') {
    const mx = mixins.get(def.name) ?? { members: [], specials: [], files: [] };
    mx.files.push(file);
    for (const m of def.members) {
      mx.members.push(...membersOf(m, def.name));
      mx.specials.push(...specialsOf(m));
    }
    mixins.set(def.name, mx);
    continue;
  }
  if (def.type === 'includes') {
    includes.push([def.target, def.includes]);
    continue;
  }
  if (def.type === 'interface' || def.type === 'namespace' || def.type === 'callback interface') {
    const rec = ensureIface(def.name, def.type);
    if (def.partial) rec.partialFiles.push(file);
    else {
      rec.kind = def.type;
      rec.file = file;
      rec.dir = dir;
      rec.parent = def.inheritance ?? null;
      const ex = xattr(def, 'Exposed');
      rec.exposed = ex ? xattrRhs(ex) : null;
      rec.noInterfaceObject = !!xattr(def, 'LegacyNoInterfaceObject');
      for (const a of (def.extAttrs ?? []).filter((a) => a.name === 'LegacyFactoryFunction' || a.name === 'NamedConstructor')) rec.legacyFactory.push(a.rhs?.value);
    }
    for (const m of def.members) {
      if (m.type === 'constructor') rec.hasConstructor = true;
      const from = def.partial ? `partial ${def.name} (${file})` : def.name;
      // HTML "obsolete features" (html.spec.whatwg.org/multipage/obsolete.html): jsdom declares them as a
      // partial interface of the element in the same file. HTMLElement's partial is CSSOM View, not obsolete.
      const obsolete = def.partial && /^HTML.+Element$/.test(def.name) && def.name !== 'HTMLElement';
      rec.members.push(...membersOf(m, from).map((x) => (obsolete ? { ...x, obsolete: true } : x)));
      rec.specials.push(...specialsOf(m));
    }
  }
}

const unresolvedIncludes = [];
for (const [target, mixin] of includes) {
  const t = ifaces.get(target);
  const mx = mixins.get(mixin);
  if (!t || !mx) {
    unresolvedIncludes.push(`${target} includes ${mixin}`);
    continue;
  }
  t.members.push(...mx.members.map((m) => ({ ...m, from: mixin })));
  t.specials.push(...mx.specials);
}

// Dedupe members (overloads, the same name from a partial and the main definition).
for (const rec of ifaces.values()) {
  const seen = new Map();
  for (const m of rec.members) {
    const k = `${m.static ? 'static ' : ''}${m.name}`;
    if (!seen.has(k)) seen.set(k, m);
  }
  rec.members = [...seen.values()];
  rec.specials = [...new Set(rec.specials)];
}

// ---------------------------------------------------------------- area classification
// Rules, applied in order (first match wins). Documented in README.md.
const FORMS = new Set([
  'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLFieldSetElement',
  'HTMLOutputElement', 'HTMLOptionElement', 'HTMLOptGroupElement', 'HTMLLabelElement', 'HTMLLegendElement', 'HTMLDataListElement',
  'HTMLMeterElement', 'HTMLProgressElement', 'HTMLFormControlsCollection', 'HTMLOptionsCollection', 'RadioNodeList', 'ValidityState',
  'FormData', 'SubmitEvent', 'FormDataEvent', 'ElementInternals',
]);
const CORE = new Set([
  'Node', 'Element', 'Document', 'XMLDocument', 'DocumentFragment', 'DocumentType', 'CharacterData', 'Text', 'CDATASection', 'Comment',
  'ProcessingInstruction', 'Attr', 'NamedNodeMap', 'NodeList', 'HTMLCollection', 'DOMTokenList', 'DOMStringMap', 'DOMImplementation',
  'EventTarget', 'DOMException', 'QuotaExceededError', 'AbortController', 'AbortSignal',
]);
const SHADOW = new Set(['ShadowRoot', 'HTMLSlotElement', 'HTMLTemplateElement', 'CustomElementRegistry']);
const DIR_AREA = {
  events: 'Events', deviceorientation: 'Events', css: 'CSSOM', svg: 'SVG', range: 'Traversal, Range & Selection',
  traversal: 'Traversal, Range & Selection', selection: 'Traversal, Range & Selection', domparsing: 'Parsing & serialization',
  window: 'Window, navigation & history', navigator: 'Window, navigation & history', xhr: 'Networking (XHR, fetch, WebSocket)',
  fetch: 'Networking (XHR, fetch, WebSocket)', websockets: 'Networking (XHR, fetch, WebSocket)', 'file-api': 'File API',
  webstorage: 'Storage', encoding: 'Encoding', 'custom-elements': 'Custom elements & Shadow DOM', 'mutation-observer': 'Mutation observers',
  geometry: 'Geometry', 'constraint-validation': 'Forms & constraint validation', aborting: 'DOM core', webidl: 'DOM core',
  attributes: 'DOM core', 'hr-time': 'Misc (performance, crypto)', crypto: 'Misc (performance, crypto)',
};
export function classify(name, dir) {
  if (FORMS.has(name)) return 'Forms & constraint validation';
  if (SHADOW.has(name)) return 'Custom elements & Shadow DOM';
  if (CORE.has(name)) return 'DOM core';
  if (name === 'Window') return 'Window, navigation & history';
  if (/^SVG/.test(name)) return 'SVG';
  if (/^CSS|StyleSheet|^MediaList$/.test(name)) return 'CSSOM';
  if (/Event$/.test(name) && name !== 'Event') return 'Events';
  if (/^HTML.*Element$/.test(name)) return 'HTML elements';
  if (dir && DIR_AREA[dir]) return DIR_AREA[dir];
  if (/^(Plugin|PluginArray|MimeType|MimeTypeArray)$/.test(name)) return 'Window, navigation & history';
  return 'Misc (performance, crypto)';
}

// Whole interfaces listed in the HTML spec's obsolete-features section.
const OBSOLETE_IFACES = new Set(['HTMLMarqueeElement', 'HTMLFrameSetElement', 'HTMLFrameElement', 'HTMLDirectoryElement', 'HTMLFontElement', 'HTMLParamElement']);
const interfaces = [];
for (const rec of [...ifaces.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  if (rec.kind === 'callback interface' && !rec.exposed) continue; // EventListener: not exposed
  // An exposed callback interface (NodeFilter) has an interface object carrying only its constants.
  if (rec.kind === 'callback interface') rec.members = rec.members.filter((m) => m.kind === 'constant');
  const exposedOnWindow = !rec.noInterfaceObject && (rec.exposed == null ? true : rec.exposed.includes('Window') || rec.exposed.includes('*'));
  // `getter T item(...)` style specials double as regular operations; plain `getter T (...)` do not.
  interfaces.push({ ...rec, area: classify(rec.name, rec.dir), exposedOnWindow, obsolete: OBSOLETE_IFACES.has(rec.name) || undefined });
}

const out = {
  generated: new Date().toISOString(),
  source: 'refs/jsdom/lib/jsdom/living/**/*.webidl',
  jsdomVersion: JSON.parse(fs.readFileSync(path.resolve(living, '../../../package.json'), 'utf8')).version,
  files: files.length,
  parseErrors,
  unresolvedIncludes,
  mixins: [...mixins.keys()].sort(),
  interfaces,
};
fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.writeFileSync(path.join(here, 'results/idl.json'), JSON.stringify(out, null, 1));
const nm = interfaces.reduce((s, i) => s + i.members.length, 0);
console.log(`files=${files.length} parseErrors=${parseErrors.length} interfaces=${interfaces.length} members=${nm} unresolvedIncludes=${unresolvedIncludes.length}`);
for (const e of parseErrors) console.log('  parse error', e.file, e.error);
for (const u of unresolvedIncludes) console.log('  unresolved', u);
