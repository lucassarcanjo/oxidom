'use strict';
// rsdom facade entry. `createWindow()` creates a document (html/head/body) in this process's env and a
// window-like object WITHOUT installing globals (plain Node / contract tests). The Vitest environment
// (lib/vitest-environment.mjs, area C) builds on the same pieces.
//
// Area install order: core (dom.cjs, collections.cjs) -> traversal -> select -> style -> forms -> events -> mo -> window
// -> xhr.

const rt = require('./runtime.cjs');
const dom = require('./dom.cjs');
const areas = [
  require('./traversal.cjs'),
  require('./select.cjs'),
  require('./style.cjs'),
  require('./forms.cjs'),
  require('./events.cjs'),
  require('./mo.cjs'),
  require('./window.cjs'),
  require('./xhr.cjs'),
];
for (const a of areas) a.install(rt, dom);
// WebIDL: interface members are enumerable (class syntax made them non-enumerable).
rt.exposeMembers();
const { makeWindow } = require('./window.cjs');

/**
 * @param {{ url?: string, html?: string, main?: boolean }} [options]
 * @returns {{ window: object, document: object }}
 */
function createWindow(options = {}) {
  const id = rt.checkId(rt.N.createDocument(0, null));
  rt.afterAlloc();
  const document = rt.wrap(id);
  document._url = options.url ?? 'http://localhost:3000/';
  if (options.main !== false) {
    rt.N.setMainDocument(id);
    rt.defaultDocument = document;
  }
  if (options.html !== undefined) document.documentElement.innerHTML = options.html;
  const window = makeWindow(rt, dom, document, options);
  // Area B: the window is an EventTarget linked to the document (idempotent if makeWindow already did it).
  require('./events.cjs').installWindow(window, document);
  return { window, document };
}

module.exports = { createWindow, rt, dom };
