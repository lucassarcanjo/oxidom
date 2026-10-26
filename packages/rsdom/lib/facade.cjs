'use strict';
// The facade, loaded once per native env through lib/index.cjs (which documents it).
//
// Area install order: core (dom.cjs, collections.cjs) -> traversal -> select -> style -> cssom -> forms -> events -> mo -> window
// -> xhr -> observers -> range -> shadow -> file-api -> selection -> xml -> xpath -> geometry -> media -> tables -> frames -> reflection (last: it only fills in
// reflected attributes no other area defined).

const rt = require('./runtime.cjs');
const dom = require('./dom.cjs');
const context = require('./context.cjs');
const areas = [
  require('./traversal.cjs'),
  require('./select.cjs'),
  require('./style.cjs'),
  require('./cssom.cjs'),
  require('./forms.cjs'),
  require('./events.cjs'),
  require('./mo.cjs'),
  require('./window.cjs'),
  require('./xhr.cjs'),
  require('./observers.cjs'),
  require('./range.cjs'),
  require('./shadow.cjs'),
  require('./file-api.cjs'),
  require('./selection.cjs'),
  require('./xml.cjs'),
  require('./xpath.cjs'),
  require('./geometry.cjs'),
  require('./media.cjs'),
  require('./tables.cjs'),
  require('./frames.cjs'),
  require('./reflection.cjs'),
  require('./custom-elements.cjs'),
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
  require('./scripts.cjs').bind(ctx);
  return { window: ctx.window, document: ctx.document };
}

const { JSDOM, VirtualConsole, CookieJar, toughCookie } = require('./jsdom.cjs');

module.exports = { createWindow, rt, dom, JSDOM, VirtualConsole, CookieJar, toughCookie };
// lib/index.cjs hands these exports to any later copy of the facade in this env. Only a copy loaded in Node's own
// realm records them (the addon exports object is made there): a copy a VM pool loads inside one file's vm
// context must not hand that file's realm to the next file
const native = require('./native.cjs');
if (Object.getPrototypeOf(native) === Object.prototype) {
  Object.defineProperty(native, Symbol.for('nativedom.facade'), { value: module.exports });
}
