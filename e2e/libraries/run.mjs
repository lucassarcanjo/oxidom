#!/usr/bin/env node
// Runs the library suite (tests/) and the diagnostics (diagnostics/) under each DOM, sequentially.
//   node run.mjs                 -> all DOMs, both modes (with / without documented shims) + diagnostics
//   node run.mjs --doms=oxidom    -> subset
// Outputs: results/raw/<mode>-<dom>.json (Vitest JSON reporter) and results/raw/<mode>-<dom>.log
// (default reporter, no colour; the aggregator parses "Unhandled Errors" from it).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const raw = path.join(here, 'results/raw')
fs.mkdirSync(raw, { recursive: true })
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split('=')[1]
const doms = arg('doms', 'jsdom,happy-dom,oxidom').split(',')
const modes = arg('modes', 'polyfills,nopolyfills,diagnostics').split(',')
const vitest = path.join(here, 'node_modules/vitest/vitest.mjs')

for (const mode of modes) {
  for (const dom of doms) {
    const tag = `${mode}-${dom}`
    const args = [vitest, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(raw, tag + '.json')}`]
    if (mode === 'diagnostics') args.push('-c', 'vitest.diagnostics.config.ts')
    const env = { ...process.env, DOM_ENV: dom, NO_COLOR: '1', FORCE_COLOR: '0', LIBS_POLYFILLS: mode === 'nopolyfills' ? '0' : '1' }
    const t0 = Date.now()
    const r = spawnSync(process.execPath, args, { cwd: here, env, encoding: 'utf8', maxBuffer: 64 << 20 })
    fs.writeFileSync(path.join(raw, tag + '.log'), (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''))
    const sum = (r.stdout ?? '').match(/Tests\s+(.*)/)?.[1] ?? '?'
    console.log(`${tag.padEnd(24)} exit=${r.status} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${sum}`)
  }
}
