'use strict';
// rsdom facade entry. `createWindow()` opens a browsing context (lib/context.cjs, DESIGN §18): a document
// (html/head/body) in this process's env and a window-like object, WITHOUT installing globals (plain Node /
// contract tests). The Vitest environment (lib/vitest-environment.mjs, area C) opens one on globalThis.
//
// Area install order: core (dom.cjs, collections.cjs) -> traversal -> select -> style -> forms -> events -> mo -> window
// -> xhr -> observers -> range -> shadow -> file-api.

const rt = require('./runtime.cjs');
const dom = require('./dom.cjs');
const context = require('./context.cjs');
const areas = [
  require('./traversal.cjs'),
  require('./select.cjs'),
  require('./style.cjs'),
  require('./forms.cjs'),
  require('./events.cjs'),
  require('./mo.cjs'),
  require('./window.cjs'),
  require('./xhr.cjs'),
  require('./observers.cjs'),
  require('./range.cjs'),
  require('./shadow.cjs'),
  require('./file-api.cjs'),
];
for (const a of areas) a.install(rt, dom);
// WebIDL: interface members are enumerable (class syntax made them non-enumerable).
rt.exposeMembers();

/**
 * Opens a browsing context and returns its window and document. `main: false` keeps the current context
 * current (`new Text()` & co keep creating nodes in its document); `global` installs the window on that
 * object (lib/context.cjs `open`).
 * @param {{ url?: string, html?: string, main?: boolean, global?: object }} [options]
 * @returns {{ window: object, document: object }}
 */
function createWindow(options = {}) {
  const ctx = context.open(options);
  return { window: ctx.window, document: ctx.document };
}

module.exports = { createWindow, rt, dom };
