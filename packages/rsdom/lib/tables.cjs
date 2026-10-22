'use strict';
// The HTML table API (ROADMAP Stage 3 `reflection`, DESIGN §37): caption / tHead / tFoot / tBodies / rows and
// their create* / delete* / insertRow / deleteRow, section rows, row cells / rowIndex / insertCell, and
// cellIndex. A port of jsdom 30 (refs/jsdom/lib/jsdom/living/nodes/HTMLTable*Element-impl.js): every query
// walks the children through the public DOM, every mutation is an insertBefore / removeChild, and the live
// collections re-run their query when the tree epoch moved (memo.cjs `deps('TREE')`).

const rt = require('./runtime.cjs');
const { liveQueryCollection } = require('./collections.cjs');
const { deps } = require('./memo.cjs');

const HTML = rt.NS.HTML;
const TREE_DEPS = deps('TREE');
const CELLS = new Set(['td', 'th']);

const isHtml = (e, name) => e.localName === name && e.namespaceURI === HTML;

/** jsdom `childrenByLocalName(s)`: the HTML element children named `name` (a string or a set). */
function childrenNamed(parent, name) {
  const out = [];
  for (let c = parent.firstElementChild; c !== null; c = c.nextElementSibling) {
    if (c.namespaceURI === HTML && (typeof name === 'string' ? c.localName === name : name.has(c.localName))) out.push(c);
  }
  return out;
}

function firstChildNamed(parent, name) {
  for (let c = parent.firstElementChild; c !== null; c = c.nextElementSibling) if (isHtml(c, name)) return c;
  return null;
}

/** HTMLTableElement rows: thead rows, then tbody and direct rows in tree order, then tfoot rows. */
function tableRows(table) {
  const head = [];
  const body = [];
  const foot = [];
  for (let c = table.firstElementChild; c !== null; c = c.nextElementSibling) {
    if (c.namespaceURI !== HTML) continue;
    const n = c.localName;
    if (n === 'thead') head.push(...childrenNamed(c, 'tr'));
    else if (n === 'tbody') body.push(...childrenNamed(c, 'tr'));
    else if (n === 'tfoot') foot.push(...childrenNamed(c, 'tr'));
    else if (n === 'tr') body.push(c);
  }
  return [...head, ...body, ...foot];
}

/** Each element's live collections ([SameObject]), by attribute name. */
const LIVE = new WeakMap();

function live(el, key, items) {
  let s = LIVE.get(el);
  if (s === undefined) LIVE.set(el, (s = {}));
  return (s[key] ??= liveQueryCollection({ deps: TREE_DEPS, items }))._synced();
}

/** WebIDL `long` with a default of -1 (the optional index arguments). */
const index = (v) => (v === undefined ? -1 : Number(v) | 0);

/** WebIDL `long`, a required argument of `name`. */
function required(args, name, iface) {
  if (args.length === 0) throw new TypeError(`Failed to execute '${name}' on '${iface}': 1 argument required, but only 0 present.`);
  return Number(args[0]) | 0;
}

function nullableOf(C, v, prop, type) {
  if (v === null || v === undefined) return null;
  if (!(v instanceof C)) {
    throw new TypeError(`Failed to set the '${prop}' property on 'HTMLTableElement': The provided value is not of type '${type}'.`);
  }
  return v;
}

function install(_rt, _dom) {
  const C = rt.classes;

  /** jsdom `tHeadInsertionPoint`: the first child that is not an HTML caption or colgroup. */
  function tHeadInsertionPoint(table) {
    for (let c = table.firstElementChild; c !== null; c = c.nextElementSibling) {
      if (c.namespaceURI !== HTML || (c.localName !== 'caption' && c.localName !== 'colgroup')) return c;
    }
    return null;
  }

  rt.define(C.HTMLTableElement, {
    get caption() {
      return firstChildNamed(this, 'caption');
    },
    set caption(v) {
      v = nullableOf(C.HTMLTableCaptionElement, v, 'caption', 'HTMLTableCaptionElement');
      const cur = this.caption;
      if (cur !== null) this.removeChild(cur);
      if (v !== null) this.insertBefore(v, this.firstChild);
    },
    get tHead() {
      return firstChildNamed(this, 'thead');
    },
    set tHead(v) {
      v = nullableOf(C.HTMLTableSectionElement, v, 'tHead', 'HTMLTableSectionElement');
      if (v !== null && v.localName !== 'thead') throw rt.domError(1, 'Cannot set a non-thead element as a table header');
      const cur = this.tHead;
      if (cur !== null) this.removeChild(cur);
      if (v !== null) this.insertBefore(v, tHeadInsertionPoint(this));
    },
    get tFoot() {
      return firstChildNamed(this, 'tfoot');
    },
    set tFoot(v) {
      v = nullableOf(C.HTMLTableSectionElement, v, 'tFoot', 'HTMLTableSectionElement');
      if (v !== null && v.localName !== 'tfoot') throw rt.domError(1, 'Cannot set a non-tfoot element as a table footer');
      const cur = this.tFoot;
      if (cur !== null) this.removeChild(cur);
      if (v !== null) this.appendChild(v);
    },
    get rows() {
      return live(this, 'rows', () => tableRows(this));
    },
    get tBodies() {
      return live(this, 'tBodies', () => childrenNamed(this, 'tbody'));
    },
    createTBody() {
      const el = this.ownerDocument.createElement('tbody');
      const bodies = childrenNamed(this, 'tbody');
      const last = bodies[bodies.length - 1];
      if (last !== undefined) this.insertBefore(el, last.nextSibling);
      else this.appendChild(el);
      return el;
    },
    createTHead() {
      let el = this.tHead;
      if (el === null) this.tHead = el = this.ownerDocument.createElement('thead');
      return el;
    },
    deleteTHead() {
      this.tHead = null;
    },
    createTFoot() {
      let el = this.tFoot;
      if (el === null) this.tFoot = el = this.ownerDocument.createElement('tfoot');
      return el;
    },
    deleteTFoot() {
      this.tFoot = null;
    },
    createCaption() {
      let el = this.caption;
      if (el === null) this.caption = el = this.ownerDocument.createElement('caption');
      return el;
    },
    deleteCaption() {
      const c = this.caption;
      if (c !== null) c.parentNode.removeChild(c);
    },
    insertRow(i = undefined) {
      i = index(i);
      const rows = tableRows(this);
      if (i < -1 || i > rows.length) {
        throw rt.domError(5, 'Cannot insert a row at an index that is less than -1 or greater than the number of existing rows');
      }
      const tr = this.ownerDocument.createElement('tr');
      if (rows.length === 0) {
        const bodies = childrenNamed(this, 'tbody');
        if (bodies.length === 0) {
          const body = this.ownerDocument.createElement('tbody');
          body.appendChild(tr);
          this.appendChild(body);
        } else bodies[bodies.length - 1].appendChild(tr);
      } else if (i === -1 || i === rows.length) {
        rows[rows.length - 1].parentNode.appendChild(tr);
      } else {
        rows[i].parentNode.insertBefore(tr, rows[i]);
      }
      return tr;
    },
    deleteRow(_i) {
      let i = required(arguments, 'deleteRow', 'HTMLTableElement');
      const rows = tableRows(this);
      if (i < -1 || i >= rows.length) throw rt.domError(5, `Cannot delete a row at index ${i}, where no row exists`);
      if (i === -1) {
        if (rows.length === 0) return;
        i = rows.length - 1;
      }
      rows[i].parentNode.removeChild(rows[i]);
    },
  });

  rt.define(C.HTMLTableSectionElement, {
    get rows() {
      return live(this, 'rows', () => childrenNamed(this, 'tr'));
    },
    insertRow(i = undefined) {
      i = index(i);
      const rows = childrenNamed(this, 'tr');
      if (i < -1 || i > rows.length) {
        throw rt.domError(5, 'Cannot insert a row at an index that is less than -1 or greater than the number of existing rows');
      }
      const tr = this.ownerDocument.createElement('tr');
      if (i === -1 || i === rows.length) this.appendChild(tr);
      else this.insertBefore(tr, rows[i]);
      return tr;
    },
    deleteRow(_i) {
      const i = required(arguments, 'deleteRow', 'HTMLTableSectionElement');
      const rows = childrenNamed(this, 'tr');
      if (i < -1 || i >= rows.length) throw rt.domError(5, `Cannot delete a row at index ${i}, where no row exists`);
      if (i === -1) {
        if (rows.length > 0) this.removeChild(rows[rows.length - 1]);
      } else this.removeChild(rows[i]);
    },
  });

  rt.define(C.HTMLTableRowElement, {
    get cells() {
      return live(this, 'cells', () => childrenNamed(this, CELLS));
    },
    get rowIndex() {
      const parent = this.parentElement;
      if (parent === null || parent.namespaceURI !== HTML) return -1;
      let table = parent;
      if (parent.localName === 'thead' || parent.localName === 'tbody' || parent.localName === 'tfoot') table = parent.parentElement;
      if (table === null || !isHtml(table, 'table')) return -1;
      return tableRows(table).indexOf(this);
    },
    get sectionRowIndex() {
      const parent = this.parentNode;
      if (parent === null) return -1;
      // jsdom reads the parent's `rows` (a table or a table section; anything else has none).
      if (parent instanceof C.HTMLTableElement) return tableRows(parent).indexOf(this);
      if (parent instanceof C.HTMLTableSectionElement) return childrenNamed(parent, 'tr').indexOf(this);
      return -1;
    },
    insertCell(i = undefined) {
      i = index(i);
      const td = this.ownerDocument.createElement('td');
      const cells = childrenNamed(this, CELLS);
      if (i < -1 || i > cells.length) throw rt.domError(5, 'The index is not in the allowed range.');
      if (i === -1 || i === cells.length) this.appendChild(td);
      else this.insertBefore(td, cells[i]);
      return td;
    },
    deleteCell(_i) {
      let i = required(arguments, 'deleteCell', 'HTMLTableRowElement');
      const cells = childrenNamed(this, CELLS);
      if (i < -1 || i >= cells.length) throw rt.domError(5, 'The index is not in the allowed range.');
      if (i === -1) {
        if (cells.length === 0) return;
        i = cells.length - 1;
      }
      this.removeChild(cells[i]);
    },
  });

  rt.define(C.HTMLTableCellElement, {
    get cellIndex() {
      let tr = this;
      while (tr !== null && !isHtml(tr, 'tr')) tr = tr.parentNode;
      return tr === null ? -1 : childrenNamed(tr, CELLS).indexOf(this);
    },
  });
}

module.exports = { install };
