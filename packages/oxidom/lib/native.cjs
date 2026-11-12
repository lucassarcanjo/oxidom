'use strict';
// Loads the oxidom addon. Resolution order:
//   1. $OXIDOM_NATIVE (absolute path, e.g. a `counters` bench build)
//   2. native/oxidom.<platform>-<arch>[-gnu|-musl].node   (napi build --platform)
//   3. native/oxidom.node
// A `.node` file is dlopen'ed once per process; napi-rs runs `module_exports` once per napi_env
// (main thread or worker), so every Vitest worker gets its own Env.
const path = require('node:path');
const fs = require('node:fs');

/** glibc vs musl via a full diagnostic report (~5 ms): only consulted when both builds are present. */
function isGlibc() {
  return Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
}

function candidates(dir) {
  const { platform, arch } = process;
  const at = (t) => path.join(dir, `oxidom.${t}.node`);
  let first;
  if (platform === 'linux') {
    const gnu = at(`linux-${arch}-gnu`);
    const musl = at(`linux-${arch}-musl`);
    const hasGnu = fs.existsSync(gnu);
    const hasMusl = fs.existsSync(musl);
    // A single platform build needs no libc probe (process.report.getReport() gathers stacks, handles and
    // the environment: ~5 ms per worker).
    if (hasGnu !== hasMusl) first = hasGnu ? gnu : musl;
    else first = isGlibc() ? gnu : musl;
  } else if (platform === 'win32') first = at(`win32-${arch}-msvc`);
  else first = at(`${platform}-${arch}`);
  return [first, path.join(dir, 'oxidom.node')];
}

function resolveNative() {
  if (process.env.OXIDOM_NATIVE) return process.env.OXIDOM_NATIVE;
  const dir = path.join(__dirname, '..', 'native');
  const tried = candidates(dir);
  for (const c of tried) if (fs.existsSync(c)) return c;
  throw new Error(`oxidom: native addon not found (tried ${tried.join(', ')}). Run \`npm run build\` at the repository root.`);
}

module.exports = require(resolveNative());
