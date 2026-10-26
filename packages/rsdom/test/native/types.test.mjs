// The TypeScript declarations (DESIGN §34): test/types type-checks against them with tsc (strict, lib check on),
// and the runtime exports are the ones lib/index.d.ts declares, also as an ES module's named exports.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { pkgDir } = require('../contract/adapter.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('TypeScript declarations', () => {
  it('test/types type-checks', () => {
    const tsc = path.join(pkgDir('typescript'), 'bin/tsc');
    const r = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'test/types')], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120_000);

  it('lib/index.d.ts declares every runtime export of the entry', () => {
    const dts = fs.readFileSync(path.join(root, 'lib/index.d.ts'), 'utf8');
    const declared = [...dts.matchAll(/^export (?:declare )?(?:function|class|const) (\w+)/gm)].map((m) => m[1]).sort();
    expect(Object.keys(require('../../lib/index.cjs')).sort()).toEqual(declared);
  });

  it("every declared export is a named export for Node's ES module import", () => {
    // Node's own namespace keys for a CommonJS module: `default`, and `module.exports` since Node 23
    const code = "import * as m from 'jetdom'; process.stdout.write(JSON.stringify(Object.keys(m).filter((k) => k !== 'default' && k !== 'module.exports')))";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).sort()).toEqual(Object.keys(require('../../lib/index.cjs')).sort());
  });
});
