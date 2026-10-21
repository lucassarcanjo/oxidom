'use strict';
// rsdom facade entry. `createWindow()` opens a browsing context (lib/context.cjs, DESIGN §18): a document
// (html/head/body) in this process's env and a window-like object, WITHOUT installing globals (plain Node /
// contract tests). The Vitest environment (lib/vitest-environment.mjs, area C) opens one on globalThis.
//
// One facade per native env. Jest and Vitest's VM pools load a test file's `require('jetdom')` through their own
// module registries: a second copy of these files over the same addon exports (Node caches `.node` files per
// process). That copy hands back the first one's exports (lib/facade.cjs records them on the addon exports)
// instead of re-initialising the env under the environment's document (DESIGN §32).
const native = require('./native.cjs');

module.exports = native[Symbol.for('jetdom.facade')] ?? require('./facade.cjs');
// The export names for Node's ESM import of this CommonJS entry (`import { JSDOM } from 'jetdom'`): its lexer
// reads them from this never-run assignment, as it does in esbuild's CommonJS output
0 && (module.exports = { createWindow, rt, dom, JSDOM, VirtualConsole, CookieJar, toughCookie });
