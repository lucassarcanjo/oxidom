#!/usr/bin/env node
// Static census: which DOM APIs (apis.mjs) appear in the shipped JS of each library and its
// runtime dependency closure (excluding react/react-dom/scheduler, which every DOM runs anyway).
// A hit means the identifier occurs in the code, NOT that a given test executes it.
// Output: results/census.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APIS } from './apis.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const NM = path.join(here, 'node_modules')
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
const EXCLUDE = new Set(['react', 'react-dom', 'scheduler', 'csstype', 'typescript', 'vite', 'graphql', 'yjs'])

// Libraries under test = runtime dependencies of this project (grouped where one test covers several packages).
const LIBS = {
  '@radix-ui/react-dialog': ['@radix-ui/react-dialog'],
  '@radix-ui/react-select': ['@radix-ui/react-select'],
  '@radix-ui/react-dropdown-menu': ['@radix-ui/react-dropdown-menu'],
  '@radix-ui/react-tabs': ['@radix-ui/react-tabs'],
  '@headlessui/react': ['@headlessui/react'],
  'react-aria-components': ['react-aria-components'],
  '@mui/material': ['@mui/material', '@emotion/react', '@emotion/styled'],
  'focus-trap + tabbable': ['focus-trap', 'tabbable'],
  '@floating-ui/react': ['@floating-ui/react'],
  '@tanstack/react-table': ['@tanstack/react-table'],
  'react-hook-form': ['react-hook-form'],
  downshift: ['downshift'],
  'react-select': ['react-select'],
  'framer-motion': ['framer-motion'],
  'react-router': ['react-router'],
  '@tiptap/react': ['@tiptap/react', '@tiptap/starter-kit', '@tiptap/pm'],
  lexical: ['lexical', '@lexical/react'],
  lit: ['lit'],
  axios: ['axios'],
  msw: ['msw'],
}

const readPkg = (name) => {
  const p = path.join(NM, name, 'package.json')
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}
function closure(roots) {
  const seen = new Set()
  const stack = [...roots]
  while (stack.length) {
    const n = stack.pop()
    if (seen.has(n) || EXCLUDE.has(n) || n.startsWith('@types/')) continue
    const pj = readPkg(n)
    if (!pj) continue // optional / not installed
    seen.add(n)
    for (const d of Object.keys({ ...pj.dependencies, ...pj.peerDependencies })) stack.push(d)
  }
  return [...seen].sort()
}
function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name === 'tests' || e.name === '__tests__') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) jsFiles(p, out)
    else if (/\.(c|m)?js$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const pkgHits = new Map() // package -> Set(api id)
const pkgFiles = new Map()
function scanPackage(name) {
  if (pkgHits.has(name)) return pkgHits.get(name)
  const files = jsFiles(path.join(NM, name))
  const hits = new Set()
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const a of APIS) if (!hits.has(a.id) && a.re.test(src) && (!a.andRe || a.andRe.test(src))) hits.add(a.id)
  }
  pkgHits.set(name, hits)
  pkgFiles.set(name, files.length)
  return hits
}

const libs = {}
for (const [lib, roots] of Object.entries(LIBS)) {
  const pkgs = closure(roots)
  const apis = {}
  for (const a of APIS) {
    const via = pkgs.filter((p) => scanPackage(p).has(a.id))
    if (via.length) apis[a.id] = via
  }
  libs[lib] = {
    version: readPkg(roots[0]).version,
    packages: pkgs.map((p) => `${p}@${readPkg(p).version}`),
    files: pkgs.reduce((s, p) => s + pkgFiles.get(p), 0),
    apis,
  }
}

// Native availability per DOM (probe run with LIBS_POLYFILLS=0)
const avail = {}
for (const dom of ['jsdom', 'happy-dom', 'rsdom']) {
  const f = path.join(here, `results/raw/probe-${dom}-nopolyfills.json`)
  avail[dom] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).apis : {}
}
const facts = {}
for (const dom of ['jsdom', 'happy-dom', 'rsdom']) {
  const f = path.join(here, `results/raw/diag-facts-${dom}.json`)
  if (fs.existsSync(f)) facts[dom] = JSON.parse(fs.readFileSync(f, 'utf8')).facts
}
for (const dom of Object.keys(facts)) avail[dom]['history traversal fires popstate'] = Boolean(facts[dom]['history.back() fires popstate']?.fired)

const apis = APIS.map((a) => ({
  id: a.id,
  area: a.area,
  pattern: a.re.source + (a.andRe ? `  AND (same file) ${a.andRe.source}` : ''),
  usedBy: Object.keys(libs).filter((l) => libs[l].apis[a.id]),
  available: { jsdom: avail.jsdom[a.id] ?? null, 'happy-dom': avail['happy-dom'][a.id] ?? null, rsdom: avail.rsdom[a.id] ?? null },
}))
// Static risk: libraries that reference an API a DOM lacks natively.
const risk = {}
for (const dom of ['jsdom', 'happy-dom', 'rsdom']) {
  risk[dom] = apis.filter((a) => a.available[dom] === false && a.usedBy.length).map((a) => ({ api: a.id, libs: a.usedBy.length, usedBy: a.usedBy }))
    .sort((x, y) => y.libs - x.libs)
}
const out = { generated: new Date().toISOString(), note: 'static identifier presence in shipped JS (dependency closure); availability = native, measured inside each Vitest environment with no shims', libs, apis, missingApisReferenced: risk }
fs.writeFileSync(path.join(here, 'results/census.json'), JSON.stringify(out, null, 2))
for (const a of apis) console.log(a.id.padEnd(42), String(a.usedBy.length).padStart(2), ['jsdom', 'happy-dom', 'rsdom'].map((d) => (a.available[d] ? 'Y' : '-')).join(' '))
