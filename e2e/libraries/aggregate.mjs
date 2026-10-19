#!/usr/bin/env node
// Aggregates results/raw/* (from run.mjs) + results/census.json (from census.mjs) into
// results/libs.json and results/summary.md. Every failure is matched to causes.mjs; unmatched
// failures are listed as UNEXPLAINED (none is expected).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAUSES } from './causes.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const raw = path.join(here, 'results/raw')
const DOMS = ['jsdom', 'happy-dom', 'rsdom']
const MODES = ['polyfills', 'nopolyfills', 'diagnostics']
const GROUP = { tabbable: 'focus-trap + tabbable', 'focus-trap': 'focus-trap + tabbable' }
const VERSION_PKG = { 'focus-trap + tabbable': ['focus-trap', 'tabbable'], '@tiptap/react': ['@tiptap/react', '@tiptap/starter-kit'], lexical: ['lexical', '@lexical/react'], '@mui/material': ['@mui/material', '@emotion/react', '@emotion/styled'] }
const ver = (p) => JSON.parse(fs.readFileSync(path.join(here, 'node_modules', p, 'package.json'), 'utf8')).version
const rel = (f) => path.relative(here, f)
const firstLine = (s) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? ''

function parseUnhandled(log) {
  const i = log.indexOf('Unhandled Errors')
  if (i < 0) return []
  const chunks = log.slice(i).split(/^⎯+ (?:Uncaught Exception|Unhandled Rejection|Unhandled Error) ⎯+$/m).slice(1)
  return chunks.map((c) => {
    const lines = c.split('\n').map((l) => l.trimEnd())
    const msg = lines.find((l) => l.trim()) ?? ''
    const frame = (lines.find((l) => l.trim().startsWith('❯')) ?? '').trim().replace(/^❯\s*/, '')
    const file = c.match(/This error originated in "([^"]+)" test file/)?.[1] ?? null
    const test = c.match(/The last test to run before this error was "([^"]+)"/)?.[1] ?? null
    return { message: msg.trim(), frame, file, test }
  })
}
function matchCause(dom, file, message) {
  const c = CAUSES.find((c) => c.doms.includes(dom) && c.re.test(message) && (!c.file || c.file.test(file)))
  return c ? c.id : 'UNEXPLAINED'
}

const runs = {}
const unexplained = []
for (const mode of MODES) {
  for (const dom of DOMS) {
    const tag = `${mode}-${dom}`
    const jf = path.join(raw, tag + '.json')
    if (!fs.existsSync(jf)) continue
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'))
    const log = fs.readFileSync(path.join(raw, tag + '.log'), 'utf8')
    const unhandled = parseUnhandled(log).map((u) => ({ ...u, cause: matchCause(dom, u.file ?? '', u.message) }))
    const tests = []
    for (const tr of j.testResults) {
      const file = rel(tr.name)
      if (file.includes('_env-probe')) continue
      if (tr.assertionResults.length === 0 && tr.status === 'failed') {
        // suite failed to load (import-time error)
        const msg = firstLine(tr.message)
        tests.push({ file, lib: null, importFailure: true, title: '(suite failed to import)', status: 'fail', error: msg, cause: matchCause(dom, file, msg) })
        continue
      }
      for (const a of tr.assertionResults) {
        const lib = GROUP[a.ancestorTitles[0]] ?? a.ancestorTitles[0] ?? null
        const err = a.status === 'failed' ? firstLine(a.failureMessages?.[0]) : null
        const uh = unhandled.filter((u) => u.file === file && u.test === a.title)
        const status = a.status === 'passed' ? (uh.length ? 'pass+unhandled' : 'pass') : 'fail'
        const t = { file, lib, title: a.title, status, durationMs: Math.round(a.duration ?? 0) }
        if (err) { t.error = err; t.cause = matchCause(dom, file, err) }
        if (uh.length) t.unhandled = uh.map((u) => ({ message: u.message, frame: u.frame, cause: u.cause }))
        tests.push(t)
      }
    }
    // suite-level libs for import failures: infer from the libs that use that file in other runs
    runs[tag] = { mode, dom, numTests: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, unhandledErrors: unhandled, tests }
    for (const t of tests) {
      if (t.cause === 'UNEXPLAINED') unexplained.push({ tag, file: t.file, title: t.title, error: t.error })
      for (const u of t.unhandled ?? []) if (u.cause === 'UNEXPLAINED') unexplained.push({ tag, file: t.file, title: t.title, error: u.message })
    }
    for (const u of unhandled) if (u.cause === 'UNEXPLAINED' && !tests.some((t) => t.file === u.file && t.title === u.test)) unexplained.push({ tag, file: u.file, title: u.test, error: u.message })
  }
}
// Fill lib for import-failed suites from another run of the same file.
const fileLibs = {}
for (const r of Object.values(runs)) for (const t of r.tests) if (t.lib && !t.importFailure) (fileLibs[t.file] ??= new Set()).add(t.lib)
for (const r of Object.values(runs)) {
  const extra = []
  for (const t of r.tests) {
    if (t.importFailure) {
      // expand into one row per (lib, test title) seen in other runs so counts stay comparable
      const titles = Object.values(runs).flatMap((o) => o.tests.filter((x) => x.file === t.file && x.lib)).map((x) => `${x.lib}\u0000${x.title}`)
      for (const k of new Set(titles)) { const [lib, title] = k.split('\u0000'); extra.push({ ...t, lib, title, importFailure: true }) }
      t.drop = true
    }
  }
  r.tests = r.tests.filter((t) => !t.drop).concat(extra)
  r.passed = r.tests.filter((t) => t.status !== 'fail').length
  r.failed = r.tests.filter((t) => t.status === 'fail').length
  r.numTests = r.tests.length
}

// Per-library rollup (primary = polyfills mode).
const libNames = [...new Set(runs['polyfills-jsdom'].tests.map((t) => t.lib))]
const causeById = Object.fromEntries(CAUSES.map((c) => [c.id, c]))
const libs = libNames.map((lib) => {
  const out = { lib, version: (VERSION_PKG[lib] ?? [lib]).map((p) => `${p}@${ver(p)}`).join(', '), scenarios: [], results: {}, resultsWithoutShims: {}, causes: [] }
  const roll = (mode, dom) => {
    const ts = runs[`${mode}-${dom}`].tests.filter((t) => t.lib === lib)
    const status = ts.some((t) => t.status === 'fail') ? 'fail' : ts.some((t) => t.status === 'pass+unhandled') ? 'error' : 'pass'
    return { status, passed: ts.filter((t) => t.status !== 'fail').length, total: ts.length, tests: ts.map((t) => ({ title: t.title, status: t.status, ...(t.error ? { error: t.error } : {}), ...(t.cause ? { cause: t.cause } : {}), ...(t.unhandled ? { unhandled: t.unhandled } : {}) })) }
  }
  for (const dom of DOMS) {
    out.results[dom] = roll('polyfills', dom)
    out.resultsWithoutShims[dom] = roll('nopolyfills', dom)
  }
  out.scenarios = out.results.jsdom.tests.map((t) => t.title)
  const cs = new Map()
  for (const mode of ['polyfills', 'nopolyfills']) for (const dom of DOMS) {
    for (const t of out[mode === 'polyfills' ? 'results' : 'resultsWithoutShims'][dom].tests) {
      for (const id of [t.cause, ...(t.unhandled ?? []).map((u) => u.cause)].filter(Boolean)) {
        const k = `${id}|${mode}`
        if (!cs.has(k)) cs.set(k, { id, mode, doms: new Set(), title: causeById[id]?.title ?? 'UNEXPLAINED' })
        cs.get(k).doms.add(dom)
      }
    }
  }
  out.causes = [...cs.values()].map((c) => ({ ...c, doms: [...c.doms] }))
  return out
})

const census = fs.existsSync(path.join(here, 'results/census.json')) ? JSON.parse(fs.readFileSync(path.join(here, 'results/census.json'), 'utf8')) : null
const probes = Object.fromEntries(DOMS.map((d) => [d, JSON.parse(fs.readFileSync(path.join(raw, `probe-${d}-polyfills.json`), 'utf8')).polyfillsApplied]))
const facts = Object.fromEntries(DOMS.map((d) => [d, JSON.parse(fs.readFileSync(path.join(raw, `diag-facts-${d}.json`), 'utf8')).facts]))

const totals = {}
for (const mode of MODES) for (const dom of DOMS) {
  const r = runs[`${mode}-${dom}`]; if (!r) continue
  totals[`${mode}-${dom}`] = { tests: r.numTests, pass: r.tests.filter((t) => t.status === 'pass').length, passWithUnhandled: r.tests.filter((t) => t.status === 'pass+unhandled').length, fail: r.failed, unhandledErrors: r.unhandledErrors.length,
    libsPass: mode === 'diagnostics' ? undefined : libs.filter((l) => (mode === 'polyfills' ? l.results : l.resultsWithoutShims)[dom].status === 'pass').length }
}

const result = {
  generated: new Date().toISOString(),
  versions: { node: process.version, vitest: ver('vitest'), jsdom: ver('jsdom'), 'happy-dom': ver('happy-dom'), react: ver('react'), '@testing-library/react': ver('@testing-library/react'), '@testing-library/user-event': ver('@testing-library/user-event'), '@testing-library/jest-dom': ver('@testing-library/jest-dom'), rsdom: 'working tree, packages/rsdom/native/rsdom.linux-x64-gnu.node' },
  statusLegend: { pass: 'all tests of the library passed, no unhandled errors', fail: 'at least one test failed (or the test file failed to import)', error: 'all assertions passed but Vitest reported an unhandled error/rejection attributed to one of its tests (the run exits 1)' },
  shims: { applied: 'tests/setup.ts, only if the API is missing; identical code for all DOMs', installedPerDom: probes },
  totals,
  libs,
  causes: CAUSES.map((c) => ({ id: c.id, category: c.category, doms: c.doms, title: c.title, evidence: c.evidence })),
  diagnosticsFacts: facts,
  counterfactuals: runs['diagnostics-jsdom'] ? Object.fromEntries(DOMS.map((d) => [d, runs[`diagnostics-${d}`].tests.filter((t) => t.file.includes('counterfactual')).map((t) => ({ title: t.title, status: t.status, ...(t.error ? { error: t.error, cause: t.cause } : {}), ...(t.unhandled ? { unhandled: t.unhandled.map((u) => u.message) } : {}) }))])) : null,
  census: census && { missingApisReferenced: census.missingApisReferenced, apis: census.apis },
  unexplained,
  runs,
}
fs.writeFileSync(path.join(here, 'results/libs.json'), JSON.stringify(result, null, 2))

// ---------------------------------------------------------------- summary.md
const S = { pass: 'pass', fail: '**FAIL**', error: 'error*' }
const md = []
md.push('# Real-world library compatibility: jsdom vs happy-dom vs rsdom', '')
md.push(`Generated ${result.generated} by \`e2e/libraries/aggregate.mjs\`. Versions: ${Object.entries(result.versions).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '')
md.push('Each library gets 1 to 3 smoke tests written like app tests: render, then interact with user-event, then assert with jest-dom. The same files run under each DOM, and only `DOM_ENV` changes. The primary run applies the documented test-setup shims (see below). A second run applies no shims.', '')
md.push('## Totals', '', '| run | tests | pass | pass + unhandled error | fail | libraries fully passing |', '|---|---|---|---|---|---|')
for (const [k, t] of Object.entries(totals)) if (!k.startsWith('diagnostics')) md.push(`| ${k} | ${t.tests} | ${t.pass} | ${t.passWithUnhandled} | ${t.fail} | ${t.libsPass}/${libs.length} |`)
md.push('', '`error*` means every assertion passed but Vitest reported an unhandled error or rejection from that library\'s test. Vitest then exits 1, so CI goes red.', '')
md.push('## Per library (with documented shims)', '', '| library | version | tests | jsdom | happy-dom | rsdom | without shims (jsdom / happy-dom / rsdom) |', '|---|---|---|---|---|---|---|')
for (const l of libs) {
  const cell = (d) => `${S[l.results[d].status]} ${l.results[d].passed}/${l.results[d].total}`
  md.push(`| ${l.lib} | ${l.version.replace(/, /g, '<br>')} | ${l.results.jsdom.total} | ${cell('jsdom')} | ${cell('happy-dom')} | ${cell('rsdom')} | ${DOMS.map((d) => S[l.resultsWithoutShims[d].status]).join(' / ')} |`)
}
md.push('', '## Root causes (each one verified)', '')
for (const c of CAUSES) {
  const affected = libs.filter((l) => l.causes.some((x) => x.id === c.id)).map((l) => `${l.lib}${l.causes.filter((x) => x.id === c.id).every((x) => x.mode === 'nopolyfills') ? ' (no-shim run only)' : ''}`)
  md.push(`### ${c.title}`, '', `- **DOM(s):** ${c.doms.join(', ')}. **Category:** ${c.category}. **Libraries hit:** ${affected.join(', ') || '(diagnostics only)'}`, `- **Evidence:** ${c.evidence}`, '')
}
md.push(unexplained.length ? `**UNEXPLAINED failures: ${unexplained.length}** (see libs.json \`unexplained\`)` : 'Every failing test and every unhandled error, in all six runs, maps to one of the causes above (`unexplained` is empty).', '')
md.push('## Counterfactual checks (diagnostics/counterfactual.test.tsx)', '', 'Each check re-runs a failing scenario after shimming only the API named as the root cause. A pass confirms the diagnosis. On rsdom these scenarios hit an earlier blocker first, which is listed below.', '', '| scenario | jsdom | happy-dom | rsdom |', '|---|---|---|---|')
if (result.counterfactuals) {
  const titles = result.counterfactuals.jsdom.map((t) => t.title)
  for (const ti of titles) md.push(`| ${ti} | ${DOMS.map((d) => { const t = result.counterfactuals[d].find((x) => x.title === ti); return t.status === 'fail' ? `fail (${t.cause})` : t.status === 'pass+unhandled' ? `pass, then unhandled: ${t.unhandled.join('; ').slice(0, 80)}` : 'pass' }).join(' | ')} |`)
}
md.push('', '## Shims ("polyfills")', '', 'Only shims that library docs or the Jest docs tell jsdom users to add are allowed: `matchMedia`, `ResizeObserver`, `Element#scrollIntoView`, and `Element#hasPointerCapture`/`setPointerCapture`/`releasePointerCapture`. Each one is installed only when the API is missing. The two "Testing in JSDom" READMEs of tabbable and focus-trap say to pass `displayCheck: \'none\'`, and the tests do that for every DOM. The shims each DOM actually needed:', '')
for (const d of DOMS) md.push(`- ${d}: ${probes[d].length ? probes[d].join(', ') : 'none (all present natively)'}`)
md.push('', 'Without shims, Radix Select and Headless UI fail on jsdom and on rsdom. happy-dom needs no shims.', '')
if (census) {
  md.push('## Static census: DOM APIs referenced by the 20 libraries', '', 'Method: regex search of the shipped `.js`/`.mjs`/`.cjs` of each library plus its dependency closure, excluding react and react-dom. "Used by" means the identifier appears in the code. It does not mean a test executed it. The Range rows also require `createRange` or `getRangeAt` in the same file, which approximates the receiver. "Native" is measured inside each Vitest environment with no shims (`tests/_env-probe.test.ts`, `LIBS_POLYFILLS=0`).', '', '| API | area | used by (of 20) | jsdom | happy-dom | rsdom |', '|---|---|---|---|---|---|')
  const yn = (v) => (v === true ? 'yes' : v === false ? '**no**' : 'n/a')
  for (const a of [...census.apis].sort((x, y) => y.usedBy.length - x.usedBy.length)) md.push(`| ${a.id} | ${a.area} | ${a.usedBy.length} | ${yn(a.available.jsdom)} | ${yn(a.available['happy-dom'])} | ${yn(a.available.rsdom)} |`)
  md.push('', '### Referenced-but-missing APIs per DOM (count of libraries referencing each)', '')
  for (const d of DOMS) md.push(`- **${d}** (${census.missingApisReferenced[d].length} APIs): ${census.missingApisReferenced[d].map((r) => `${r.api} (${r.libs})`).join(', ')}`)
  md.push('')
}
md.push('## Caveats', '', '- These are smoke tests, 1 to 3 per library. A pass shows that a typical happy path works. It does not prove full compatibility.', '- Static census hits come from identifier presence. Many are feature-detected or sit on code paths the tests never reach. Use them as a risk indicator. They do not predict failures.', '- Typing into contenteditable editors (Lexical, tiptap) also depends on how @testing-library/user-event simulates input. The Lexical typing failure on jsdom and happy-dom is partly a tooling limit. The counterfactual shows that the missing `getTargetRanges` is enough to explain it.', '- Unhandled errors are attributed to a test with Vitest\'s "last test to run" heuristic.', `- On rsdom, ${runs['polyfills-rsdom'].tests.filter((t) => t.cause && CAUSES.find((c) => c.id === t.cause)?.category === 'missing-api').length} tests stop at the first missing API. Gaps further along those scenarios are therefore not observed.`, '')
fs.writeFileSync(path.join(here, 'results/summary.md'), md.join('\n'))
console.log(JSON.stringify(totals, null, 1))
console.log('unexplained:', unexplained)
