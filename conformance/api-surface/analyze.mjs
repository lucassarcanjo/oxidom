// Step 3 of the surface census: compares the runtime dumps (results/runtime-*.json) against the jsdom WebIDL
// (results/idl.json) and writes results/surface.json (full per-member matrix) and results/summary.md.
//   node analyze.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importance } from './importance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = (f) => JSON.parse(fs.readFileSync(path.join(here, 'results', f), 'utf8'));
const idl = R('idl.json');
const DOMS = ['jsdom', 'happy-dom', 'oxidom'];
const rt = Object.fromEntries(DOMS.map((d) => [d, R(`runtime-${d}.json`)]));
const baseline = new Set(rt.jsdom.baselineNames);
const realm = new Set(rt.jsdom.realmBuiltins);

// Representative instances for [LegacyUnforgeable] members (own properties of instances, not prototypes).
const INSTANCE_FOR = { Document: 'document', Location: 'location', Event: 'event' };

const has = (level, name) => level && level.own.includes(name);

function ifacePresence(dom, iface) {
  const g = rt[dom].globals[iface.name];
  if (!g || !g.present) return { present: false };
  const okType = iface.kind === 'interface' ? g.type === 'function' : g.type === 'function' || g.type === 'object';
  return { present: okType, fromNode: !!g.fromNode, type: g.type, construct: g.construct ?? null };
}

/**
 * Member status in one DOM: 'R' = own property of the right object (interface prototype, constructor for
 * statics, the namespace object, or the instance for [LegacyUnforgeable]); 'C' = reachable through the
 * prototype chain but defined elsewhere; 'M' = missing (interface present); 'I' = interface missing.
 */
function memberStatus(dom, iface, m, pres) {
  if (!pres.present) return 'I';
  const g = rt[dom].globals[iface.name];
  let right = false;
  let any = false;
  if (g.type === 'object') {
    // namespace (CSS) or callback interface exposed as an object (NodeFilter in happy-dom)
    const ch = g.objectChain ?? [];
    right = has(ch[0], m.name);
    any = ch.some((l) => has(l, m.name));
  } else if (m.static) {
    const ch = g.staticChain ?? [];
    right = has(ch[0], m.name);
    any = ch.some((l) => has(l, m.name));
  } else if (m.kind === 'constant') {
    const sc = g.staticChain ?? [];
    const pc = g.protoChain ?? [];
    right = has(sc[0], m.name);
    any = right || sc.some((l) => has(l, m.name)) || pc.some((l) => has(l, m.name));
  } else {
    const pc = g.protoChain ?? [];
    right = has(pc[0], m.name);
    any = pc.some((l) => has(l, m.name));
    if (m.unforgeable && INSTANCE_FOR[iface.name]) {
      const inst = rt[dom].instances[INSTANCE_FOR[iface.name]];
      const ic = inst?.chain ?? [];
      if (has(ic[0], m.name)) right = any = true;
      else if (ic.some((l) => has(l, m.name))) any = true;
    }
  }
  if (!right && !any) {
    // Own property of a real instance only (class fields in happy-dom): usable from tests, but not on the
    // prototype, so prototype-descriptor tricks (React value tracker, user-event interceptors) cannot see it.
    const io = rt[dom].instanceOwn?.[iface.name];
    if (io && io.own.includes(m.name)) return m.unforgeable ? 'R' : 'O';
  }
  if (!right && !any && subclassHas(dom, iface.name, m.name)) return 'S';
  return right ? 'R' : any ? 'C' : 'M';
}

// IDL descendants of each interface (for the 'S' status).
const idlParent = new Map(idl.interfaces.map((i) => [i.name, i.parent]));
function isDescendant(name, anc) {
  for (let p = idlParent.get(name); p; p = idlParent.get(p)) if (p === anc) return true;
  return false;
}
/** Is `member` an own prototype property of some IDL descendant of `ifaceName` in this DOM? */
function subclassHas(dom, ifaceName, member) {
  for (const i of idl.interfaces) {
    if (!isDescendant(i.name, ifaceName)) continue;
    const g = rt[dom].globals[i.name];
    if (g?.type === 'function' && has(g.protoChain?.[0], member)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ IDL census
const interfaces = [];
for (const iface of idl.interfaces.filter((i) => i.exposedOnWindow)) {
  const exposure = {};
  for (const d of DOMS) exposure[d] = ifacePresence(d, iface);
  const legacyFactory = iface.legacyFactory.map((f) => ({ name: f, ...Object.fromEntries(DOMS.map((d) => [d, rt[d].globals[f]?.type === 'function'])) }));
  const members = iface.members.map((m) => {
    const st = {};
    for (const d of DOMS) st[d] = memberStatus(d, iface, m, exposure[d]);
    return { name: m.name, kind: m.kind, static: m.static, unforgeable: m.unforgeable || undefined, readonly: m.readonly || undefined, obsolete: m.obsolete || iface.obsolete || undefined, from: m.from, ...st };
  });
  interfaces.push({ name: iface.name, kind: iface.kind, area: iface.area, obsolete: iface.obsolete, parent: iface.parent, file: iface.file, hasConstructor: iface.hasConstructor, legacyFactory, specials: iface.specials, exposure, members });
}

// ------------------------------------------------------------------ Supplement: jsdom runtime surface outside living/*.webidl
// (a) Window: jsdom has no Window.webidl; browser/Window.js defines the members by hand. Derived from jsdom's real
//     window object (not the vitest global), minus JS builtins, interface objects and _internal names.
const jw = rt.jsdom.jsdomWindow;
const ifaceNames = new Set([...idl.interfaces.map((i) => i.name), ...idl.interfaces.flatMap((i) => i.legacyFactory), ...Object.keys(jw.interfaces)]);
const windowMembers = new Set();
for (const level of jw.chain) {
  if (level.label === 'EventTarget') continue;
  for (const k of level.own) {
    if (realm.has(k) || ifaceNames.has(k) || k.startsWith('_') || k === 'constructor' || k.startsWith('@@')) continue;
    windowMembers.add(k);
  }
}
const windowRows = [...windowMembers].sort().map((name) => {
  const row = { name, alsoInPlainNode: baseline.has(name) };
  row.jsdomWindow = 'R'; // by construction
  for (const d of DOMS) row[d] = rt[d].windowNames.includes(name) ? 'R' : 'M';
  return row;
});

// (b) jsdom interfaces that are installed at runtime but have no living/*.webidl (URL, URLSearchParams,
//     CSSStyleProperties (generated from the CSS property list), XPath*, HTMLDocument).
const extras = [];
for (const [name, dump] of Object.entries(jw.interfaces)) {
  if (name === 'Window') continue;
  const own = (dump.protoChain[0]?.own ?? []).filter((k) => k !== 'constructor' && !k.startsWith('_') && k !== '@@toStringTag');
  const statics = (dump.staticChain[0]?.own ?? []).filter((k) => !['length', 'name', 'prototype', 'arguments', 'caller'].includes(k) && !k.startsWith('_'));
  const exposure = {};
  for (const d of DOMS) {
    const g = rt[d].globals[name];
    exposure[d] = { present: !!(g && g.present && g.type === 'function'), fromNode: !!g?.fromNode };
  }
  const memberRows = [];
  for (const [list, isStatic] of [[own, false], [statics, true]]) {
    for (const mname of list) {
      const row = { name: mname, static: isStatic };
      for (const d of DOMS) {
        const g = rt[d].globals[name];
        if (name === 'CSSStyleProperties') {
          // What matters is `el.style.<prop>`: look on the element.style instance chain of each DOM.
          const ch = rt[d].instances.style?.chain ?? [];
          row[d] = ch.some((l) => has(l, mname)) ? 'R' : 'M';
          continue;
        }
        if (!exposure[d].present) {
          row[d] = 'I';
          continue;
        }
        const ch = isStatic ? g.staticChain ?? [] : g.protoChain ?? [];
        row[d] = has(ch[0], mname) ? 'R' : ch.some((l) => has(l, mname)) ? 'C' : 'M';
      }
      memberRows.push(row);
    }
  }
  extras.push({ name, exposure, members: memberRows });
}

// ------------------------------------------------------------------ Counting
const AREAS = [...new Set(interfaces.map((i) => i.area))].sort();
const isPresent = (s) => s === 'R' || s === 'C' || s === 'O';
function countArea(list) {
  const c = { interfaces: 0, members: 0 };
  for (const d of DOMS) c[d] = { interfaces: 0, interfacesFromNode: 0, members: 0, membersRight: 0, membersInstanceOnly: 0, membersOnSubclassOnly: 0, missingInterfaces: [], missingMembers: [] };
  for (const i of list) {
    if (!i.exposure.jsdom.present) continue; // the denominator is what jsdom really exposes
    c.interfaces++;
    for (const d of DOMS) {
      if (i.exposure[d].present) {
        c[d].interfaces++;
        if (i.exposure[d].fromNode) c[d].interfacesFromNode++;
      } else c[d].missingInterfaces.push(i.name);
    }
    for (const m of i.members) {
      if (!isPresent(m.jsdom)) continue;
      c.members++;
      for (const d of DOMS) {
        if (isPresent(m[d])) {
          c[d].members++;
          if (m[d] === 'R') c[d].membersRight++;
          if (m[d] === 'O') c[d].membersInstanceOnly++;
        } else if (m[d] === 'M' || m[d] === 'S') {
          c[d].missingMembers.push(`${i.name}.${m.static ? 'static ' : ''}${m.name}${m[d] === 'S' ? ' (on subclass)' : ''}`);
          if (m[d] === 'S') c[d].membersOnSubclassOnly++;
        }
      }
    }
  }
  return c;
}
// Informational: interfaces missing from a DOM's global although instances of a same-named class exist.
const hiddenInterfaces = {};
for (const d of ['happy-dom', 'oxidom']) {
  hiddenInterfaces[d] = [];
  for (const i of interfaces) {
    if (i.exposure[d].present || !i.exposure.jsdom.present) continue;
    const h = rt[d].hiddenInstances?.[i.name];
    if (!h) continue;
    const names = new Set(h.chain.flatMap((l) => l.own));
    const jm = i.members.filter((m) => isPresent(m.jsdom) && !m.static && m.kind !== 'constant');
    hiddenInterfaces[d].push({ name: i.name, via: h.via, instanceMembers: jm.filter((m) => names.has(m.name)).length, of: jm.length });
  }
}
const byArea = AREAS.map((area) => ({ area, ...countArea(interfaces.filter((i) => i.area === area)) }));
const total = countArea(interfaces);
// Same totals with the HTML spec's obsolete features (whole interfaces and obsolete partial members) removed.
const totalNoHandlers = countArea(interfaces.map((i) => ({ ...i, members: i.members.filter((m) => !(m.kind === 'attribute' && /^on[a-z]/.test(m.name))) })));
const totalModern = countArea(interfaces.filter((i) => !i.obsolete).map((i) => ({ ...i, members: i.members.filter((m) => !m.obsolete) })));
// IDL members jsdom itself does not expose at runtime (sanity check of the method).
const idlTotal = { interfaces: interfaces.length, members: interfaces.reduce((s, i) => s + i.members.length, 0) };
const jsdomIdlGaps = [];
for (const i of interfaces) {
  if (!i.exposure.jsdom.present) jsdomIdlGaps.push(`${i.name} (interface)`);
  else for (const m of i.members) if (!isPresent(m.jsdom)) jsdomIdlGaps.push(`${i.name}.${m.name} [${m.jsdom}]${i.exposure.jsdom.fromNode ? ' (global is Node\'s)' : ''}`);
}

const windowCount = { members: windowRows.length, alsoInPlainNode: windowRows.filter((r) => r.alsoInPlainNode).length };
for (const d of DOMS) {
  const domOnly = windowRows.filter((r) => !r.alsoInPlainNode);
  windowCount[d] = { present: windowRows.filter((r) => r[d] === 'R').length, presentExcludingNode: domOnly.filter((r) => r[d] === 'R').length, domOnlyTotal: domOnly.length, missing: windowRows.filter((r) => r[d] === 'M').map((r) => r.name) };
}
const extrasCount = extras.map((e) => {
  const o = { name: e.name, members: e.members.length };
  if (e.name === 'CSSStyleProperties') {
    const camel = e.members.filter((m) => !m.name.includes('-') && !/^webkit/i.test(m.name));
    o.camelCaseUnprefixed = { members: camel.length, ...Object.fromEntries(DOMS.map((d) => [d, camel.filter((m) => isPresent(m[d])).length])) };
  }
  for (const d of DOMS) o[d] = { present: e.exposure[d].present, fromNode: e.exposure[d].fromNode, members: e.members.filter((m) => isPresent(m[d])).length, missing: e.members.filter((m) => !isPresent(m[d])).map((m) => m.name) };
  return o;
});

// ------------------------------------------------------------------ Reverse census (what happy-dom / oxidom have that jsdom lacks)
const OBJECT_PROTO = Object.getOwnPropertyNames(Object.prototype);
const jsdomGlobalNames = new Set([...rt.jsdom.windowNames, ...jw.chain.flatMap((l) => l.own), ...Object.keys(rt.jsdom.globals).filter((k) => rt.jsdom.globals[k].present)]);
function reverse(dom) {
  const r = rt[dom];
  const onlyGlobals = [];
  for (const [k, g] of Object.entries(r.globals)) {
    if (!g.present || baseline.has(k) || realm.has(k) || jsdomGlobalNames.has(k)) continue;
    onlyGlobals.push({ name: k, type: g.type ?? 'unknown', classLike: /^[A-Z]/.test(k) && g.type === 'function' });
  }
  // Window members (non-interface) reachable on globalThis that jsdom's window does not have.
  const onlyWindowMembers = r.windowNames.filter((k) => !baseline.has(k) && !realm.has(k) && !jsdomGlobalNames.has(k) && !/^[A-Z]/.test(k) && !k.startsWith('@@')).sort();
  // Members of interfaces both have, present in this DOM's interface prototype/constructor but nowhere in jsdom's chain.
  const extraMembers = [];
  const indexAccessors = [];
  for (const [k, g] of Object.entries(r.globals)) {
    const j = rt.jsdom.globals[k];
    if (!g.present || g.type !== 'function' || !j?.present || j.type !== 'function' || g.fromNode || !/^[A-Z]/.test(k)) continue;
    const jProto = new Set([...(j.protoChain ?? []).flatMap((l) => l.own), ...(rt.jsdom.instanceOwn[k]?.own ?? []), ...OBJECT_PROTO]);
    // jsdom keeps [LegacyUnforgeable] members on instances and CSS property accessors on CSSStyleProperties.
    if (k === 'Document' || k === 'HTMLDocument') for (const n of rt.jsdom.instances.document?.chain?.[0]?.own ?? []) jProto.add(n);
    if (k === 'CSSStyleDeclaration') for (const l of jw.interfaces.CSSStyleProperties?.protoChain ?? []) for (const n of l.own) jProto.add(n);
    const jStatic = new Set((j.staticChain ?? []).flatMap((l) => l.own));
    const ownProto = (g.protoChain?.[0]?.own ?? []).filter((n) => n !== 'constructor' && !jProto.has(n));
    const ownStatic = (g.staticChain?.[0]?.own ?? []).filter((n) => !['length', 'name', 'prototype', 'arguments', 'caller'].includes(n) && !jStatic.has(n));
    const idx = ownProto.filter((n) => /^\d+$/.test(n));
    if (idx.length) indexAccessors.push({ iface: k, count: idx.length });
    for (const n of ownProto.filter((n) => !/^\d+$/.test(n))) extraMembers.push({ iface: k, name: n, static: false, internal: n.startsWith('_') || n.startsWith('#') });
    for (const n of ownStatic) extraMembers.push({ iface: k, name: n, static: true, internal: n.startsWith('_') || n.startsWith('#') });
  }
  return {
    onlyGlobals: onlyGlobals.sort((a, b) => a.name.localeCompare(b.name)),
    onlyWindowMembers,
    extraMembers: extraMembers.filter((m) => !m.internal),
    extraMembersInternal: extraMembers.filter((m) => m.internal).length,
    indexAccessorsOnPrototype: indexAccessors,
  };
}
const reverseCensus = { 'happy-dom': reverse('happy-dom'), oxidom: reverse('oxidom') };

// ------------------------------------------------------------------ Importance-ranked gaps
const ifaceIndex = new Map(interfaces.map((i) => [i.name, i]));
function lookup(key, dom) {
  if (key.startsWith('window.')) {
    const row = windowRows.find((r) => r.name === key.slice(7));
    return row ? row[dom] : 'not-in-jsdom';
  }
  const [iname, mname] = key.split('.');
  const extra = extras.find((e) => e.name === iname);
  const i = ifaceIndex.get(iname);
  if (!mname) {
    if (i) return i.exposure.jsdom.present ? (i.exposure[dom].present ? 'R' : 'I') : 'not-in-jsdom';
    if (extra) return extra.exposure[dom].present ? 'R' : 'I';
    return 'not-in-jsdom';
  }
  const m = i?.members.find((x) => x.name === mname) ?? extra?.members.find((x) => x.name === mname);
  if (!m || !isPresent(m.jsdom ?? 'R')) {
    // Not an IDL member of that interface (inherited from a parent, or added outside the IDL such as
    // Document.evaluate): fall back to raw runtime presence, with jsdom as the reference.
    return isPresent(rawStatus('jsdom', key)) ? rawStatus(dom, key) : 'not-in-jsdom';
  }
  return m[dom];
}
const seen = new Set();
const ranked = [];
for (const [key, tier, why] of importance) {
  if (seen.has(key)) continue;
  seen.add(key);
  const row = { key, tier, why };
  for (const d of DOMS) row[d] = lookup(key, d);
  ranked.push(row);
}
const notInJsdom = ranked.filter((r) => r.jsdom === 'not-in-jsdom').map((r) => r.key);
/** Raw presence of a key in one DOM, independent of jsdom (for curated keys jsdom lacks). */
function rawStatus(dom, key) {
  const r = rt[dom];
  if (key.startsWith('window.')) return r.windowNames.includes(key.slice(7)) ? 'R' : 'M';
  const [iname, mname] = key.split('.');
  const g = r.globals[iname];
  if (!g?.present || (g.type !== 'function' && g.type !== 'object')) return 'I';
  if (!mname) return 'R';
  const chains = [g.protoChain, g.staticChain, g.objectChain].filter(Boolean);
  if (chains.some((c) => has(c[0], mname))) return 'R';
  if (chains.some((c) => c.some((l) => has(l, mname)))) return 'C';
  if (r.instanceOwn?.[iname]?.own.includes(mname)) return 'O';
  if (subclassHas(dom, iname, mname)) return 'S';
  return 'M';
}
const jsdomLacks = notInJsdom.map((key) => ({ key, tier: ranked.find((r) => r.key === key).tier, ...Object.fromEntries(DOMS.map((d) => [d, rawStatus(d, key)])) }));
const topMissing = {};
for (const d of ['happy-dom', 'oxidom']) topMissing[d] = ranked.filter((r) => r.jsdom !== 'not-in-jsdom' && (r[d] === 'M' || r[d] === 'I')).map((r) => ({ key: r.key, tier: r.tier, status: r[d], why: r.why }));
// jsdom-in-vitest: things jsdom has but the vitest global does not (populateGlobal copies only own keys / KEYS)
topMissing['jsdom (vitest global)'] = ranked.filter((r) => r.jsdom === 'M' || r.jsdom === 'I').map((r) => ({ key: r.key, tier: r.tier, status: r.jsdom, why: r.why }));

// ------------------------------------------------------------------ Write JSON
const meta = {
  generated: new Date().toISOString(),
  node: rt.jsdom.node,
  versions: rt.jsdom.versions,
  idlFiles: idl.files,
  idlSource: idl.source,
  statusLegend: { R: 'own property of the right object (interface prototype / constructor / namespace / unforgeable instance)', C: 'reachable through the prototype chain but defined on another object', O: 'own property of an instance only (class field), not on any prototype', S: 'not on this interface or its ancestors, but on the prototype of a subclass (e.g. on HTMLElement instead of Element); not counted as present', M: 'missing (interface present)', I: 'interface missing from the global' },
  setupMs: Object.fromEntries(DOMS.map((d) => [d, rt[d].setupMs])),
};
const surface = { meta, totals: { idl: idlTotal, jsdomRuntime: total, jsdomRuntimeExcludingObsolete: totalModern, jsdomRuntimeExcludingEventHandlers: totalNoHandlers }, byArea, window: { counts: windowCount, members: windowRows }, extras: { counts: extrasCount, interfaces: extras }, jsdomIdlGaps, hiddenInterfaces, reverseCensus, importance: { ranked, notInJsdom, jsdomLacks, topMissing }, interfaces };
fs.writeFileSync(path.join(here, 'results/surface.json'), JSON.stringify(surface, null, 1));

// ------------------------------------------------------------------ summary.md
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const L = [];
L.push('# API surface census: jsdom vs happy-dom vs oxidom', '');
L.push(`Generated ${meta.generated} by \`conformance/api-surface\` (node ${meta.node}; jsdom ${meta.versions.jsdom}, happy-dom ${meta.versions['happy-dom']}, vitest ${meta.versions.vitest}, oxidom ${meta.versions.oxidom}).`);
L.push('Each DOM was installed on `globalThis` exactly as the Vitest 5 environment does it, in its own process; presence is read from the global object the tests see.', '');
L.push('## Totals (WebIDL from jsdom living/, 227 files)', '');
L.push(`- IDL: ${idlTotal.interfaces} interfaces exposed on Window, ${idlTotal.members} members (attributes, operations, constants, statics, iterator methods; overloads deduplicated; indexed/named getters excluded).`);
L.push(`- jsdom runtime (Vitest global): ${total.interfaces} interfaces, ${total.members} members present. ${jsdomIdlGaps.length} IDL items not visible on the jsdom Vitest global (see surface.json \`jsdomIdlGaps\`).`);
L.push('');
L.push('| | interfaces | % | members present (R+C+O) | % | on the right interface (R) | % | instance-only (O) | on a subclass only (S, not counted) |');
L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const d of DOMS) L.push(`| ${d} | ${total[d].interfaces}/${total.interfaces} | ${pct(total[d].interfaces, total.interfaces)} | ${total[d].members}/${total.members} | ${pct(total[d].members, total.members)} | ${total[d].membersRight}/${total.members} | ${pct(total[d].membersRight, total.members)} | ${total[d].membersInstanceOnly} | ${total[d].membersOnSubclassOnly} |`);
L.push('', `Excluding the HTML spec's obsolete features (${interfaces.filter((i) => i.obsolete).length} interfaces such as HTMLMarqueeElement, and ${interfaces.reduce((n, i) => n + (i.obsolete ? 0 : i.members.filter((m) => m.obsolete).length), 0)} obsolete members such as \`align\`/\`bgColor\`): jsdom ${totalModern.interfaces} interfaces / ${totalModern.members} members; ${DOMS.filter((d) => d !== 'jsdom').map((d) => `${d} ${totalModern[d].interfaces} (${pct(totalModern[d].interfaces, totalModern.interfaces)}) / ${totalModern[d].members} (${pct(totalModern[d].members, totalModern.members)})`).join('; ')}.`);
L.push('', `Mixins are counted on every interface that includes them, so ${total.members - totalNoHandlers.members} of the ${total.members} members are \`on*\` event-handler attributes (GlobalEventHandlers alone is included by HTMLElement, SVGElement and Document). Excluding \`on*\` handlers: jsdom ${totalNoHandlers.members} members; ${DOMS.filter((d) => d !== 'jsdom').map((d) => `${d} ${totalNoHandlers[d].members} (${pct(totalNoHandlers[d].members, totalNoHandlers.members)})`).join('; ')}.`);
L.push('', 'Status legend: R = own property of the right object (interface prototype; constructor for statics/constants; the namespace object; the instance for [LegacyUnforgeable]); C = inherited from another object in the chain; O = own property of an instance only (class field); S = only on a subclass prototype; M = missing; I = interface missing.');
L.push('');
L.push(`Interfaces whose global is Node's own class rather than the DOM's (counted as present): ${DOMS.map((d) => `${d}: ${interfaces.filter((i) => i.exposure[d].fromNode).map((i) => i.name).join(', ') || 'none'}`).join('; ')}.`, '');
L.push('## Per area (members counted only where jsdom has them; a member of a missing interface counts as missing)', '');
L.push('| area | jsdom ifaces | happy-dom ifaces | oxidom ifaces | jsdom members | happy-dom members | % | oxidom members | % |');
L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const a of byArea) L.push(`| ${a.area} | ${a.interfaces} | ${a['happy-dom'].interfaces} | ${a.oxidom.interfaces} | ${a.members} | ${a['happy-dom'].members} | ${pct(a['happy-dom'].members, a.members)} | ${a.oxidom.members} | ${pct(a.oxidom.members, a.members)} |`);
L.push('');
L.push('### Missing interfaces per area', '');
for (const a of byArea) {
  const h = a['happy-dom'].missingInterfaces;
  const r = a.oxidom.missingInterfaces;
  if (!h.length && !r.length) continue;
  L.push(`- **${a.area}**: happy-dom lacks ${h.length ? h.join(', ') : 'none'}; oxidom lacks ${r.length ? r.join(', ') : 'none'}.`);
}
L.push('');
L.push('### Interfaces missing from the global although instances exist (informational, not counted)', '');
for (const d of ['happy-dom', 'oxidom']) L.push(`- ${d}: ${hiddenInterfaces[d].map((h) => `${h.name} (via ${h.via}; ${h.instanceMembers}/${h.of} instance members reachable)`).join(', ') || 'none'}`);
L.push('');
L.push('## Window members (jsdom has no Window.webidl; derived from jsdom\'s real window object)', '');
L.push(`${windowCount.members} members, ${windowCount.alsoInPlainNode} of which plain Node also has (timers, atob, fetch, performance, ...).`, '');
L.push('| | present | % | present, excluding Node-provided | % |');
L.push('|---|---:|---:|---:|---:|');
for (const d of DOMS) L.push(`| ${d}${d === 'jsdom' ? ' (Vitest global)' : ''} | ${windowCount[d].present}/${windowCount.members} | ${pct(windowCount[d].present, windowCount.members)} | ${windowCount[d].presentExcludingNode}/${windowCount[d].domOnlyTotal} | ${pct(windowCount[d].presentExcludingNode, windowCount[d].domOnlyTotal)} |`);
L.push('');
for (const d of DOMS) L.push(`- ${d} missing: ${windowCount[d].missing.join(', ') || 'none'}`);
L.push('');
L.push('## jsdom interfaces outside living/*.webidl (members from jsdom\'s runtime prototypes)', '');
L.push('| interface | members | jsdom | happy-dom | oxidom |');
L.push('|---|---:|---|---|---|');
for (const e of extrasCount) L.push(`| ${e.name} | ${e.members} | ${DOMS.map((d) => `${e[d].present ? '' : '(no global) '}${e[d].members}/${e.members}${e[d].fromNode ? ' (Node\'s)' : ''}`).join(' | ')} |`);
const csp = extrasCount.find((e) => e.name === 'CSSStyleProperties');
if (csp?.camelCaseUnprefixed) L.push('', `CSSStyleProperties, camelCase unprefixed accessors only: ${csp.camelCaseUnprefixed.members} in jsdom; ${DOMS.filter((d) => d !== 'jsdom').map((d) => `${d} ${csp.camelCaseUnprefixed[d]}`).join(', ')}.`);
L.push('', 'CSSStyleProperties members are CSS property accessors (camelCase, dashed and webkit-prefixed); they are checked on each DOM\'s `document.body.style` instance chain.', '');
L.push('## Most important gaps for app testing (curated tiers, see importance.mjs)', '');
for (const d of ['happy-dom', 'oxidom', 'jsdom (vitest global)']) {
  const list = topMissing[d];
  L.push(`### ${d}: ${list.length} of ${ranked.length - notInJsdom.length} curated items missing`, '');
  for (const t of ['P0', 'P1', 'P2']) {
    const items = list.filter((x) => x.tier === t);
    if (items.length) L.push(`- **${t}** (${items.length}): ${items.map((x) => `\`${x.key}\`${x.status === 'I' ? '*' : ''}`).join(', ')}`);
  }
  L.push('');
}
L.push('`*` = the whole interface is missing from the global.', '');
if (jsdomLacks.length) {
  L.push('### Curated items jsdom itself lacks (excluded from the counts above)', '');
  L.push('| key | tier | jsdom | happy-dom | oxidom |', '|---|---|---|---|---|');
  for (const x of jsdomLacks) L.push(`| \`${x.key}\` | ${x.tier} | ${x.jsdom} | ${x['happy-dom']} | ${x.oxidom} |`);
  L.push('');
}
L.push('## Reverse census: present in happy-dom / oxidom, absent from jsdom', '');
for (const d of ['happy-dom', 'oxidom']) {
  const rc = reverseCensus[d];
  const cls = rc.onlyGlobals.filter((g) => g.classLike).map((g) => g.name);
  const oth = rc.onlyGlobals.filter((g) => !g.classLike).map((g) => g.name);
  L.push(`### ${d}`, '');
  const othAll = [...new Set([...oth, ...rc.onlyWindowMembers])].sort();
  L.push(`- ${cls.length} global interfaces jsdom lacks: ${cls.join(', ') || 'none'}`);
  L.push(`- ${othAll.length} other globals / Window members jsdom lacks (Node built-ins filtered out): ${othAll.join(', ') || 'none'}`);
  const byIface = {};
  for (const m of rc.extraMembers) (byIface[m.iface] ??= []).push(m.static ? `static ${m.name}` : m.name);
  if (rc.indexAccessorsOnPrototype.length) L.push(`- numeric index accessors defined on prototypes (not API names; jsdom uses a proxy per instance): ${rc.indexAccessorsOnPrototype.map((x) => `${x.iface} 0..${x.count - 1}`).join(', ')}`);
  L.push(`- ${rc.extraMembers.length} interface members on shared interfaces that jsdom lacks (plus ${rc.extraMembersInternal} underscore-internal names not listed):`);
  for (const [k, v] of Object.entries(byIface).sort()) L.push(`  - ${k}: ${v.join(', ')}`);
  L.push('');
}
fs.writeFileSync(path.join(here, 'results/summary.md'), L.join('\n') + '\n');
const MM = ['# Missing members per area (members jsdom exposes; generated by analyze.mjs)', '', 'Members of interfaces missing from the global are not listed here (see "Missing interfaces per area" in summary.md). `(on subclass)` = defined only on a subclass prototype.', ''];
for (const a of byArea) {
  MM.push(`## ${a.area}`, '');
  for (const d of ['happy-dom', 'oxidom']) MM.push(`- **${d}** (${a[d].missingMembers.length}): ${a[d].missingMembers.join(', ') || 'none'}`);
  MM.push('');
}
fs.writeFileSync(path.join(here, 'results/missing-members.md'), MM.join('\n'));
console.log(`IDL ${idlTotal.interfaces}/${idlTotal.members}; jsdom runtime ${total.interfaces}/${total.members}`);
for (const d of DOMS) console.log(`${d}: ifaces ${total[d].interfaces} (${pct(total[d].interfaces, total.interfaces)}), members ${total[d].members} (${pct(total[d].members, total.members)}), right ${total[d].membersRight}`);
console.log('window', JSON.stringify({ n: windowCount.members, node: windowCount.alsoInPlainNode, ...Object.fromEntries(DOMS.map((d) => [d, windowCount[d].present])) }));
console.log('jsdomIdlGaps', jsdomIdlGaps.length, jsdomIdlGaps.slice(0, 40).join('; '));
