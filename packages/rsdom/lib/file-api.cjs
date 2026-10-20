'use strict';
// File API (ROADMAP Stage 3 `file-api`, DESIGN §27): Blob, File and FileReader. A port of
// refs/jsdom/lib/jsdom/living/file-api/ (Blob-impl.js, File-impl.js, FileReader-impl.js) and of the WebIDL
// conversions jsdom generates for them (node_modules/jsdom/lib/generated/idl/{Blob,File,FileReader}.js).
//
// Blob and File SUBCLASS Node's: the bytes stay in Node's blob store, so an rsdom Blob is a Node Blob to
// fetch, Response, URL.createObjectURL and structuredClone, while the constructors and `slice` follow WebIDL
// (argument order, [Clamp], USVString and dictionary conversions) as jsdom's do. `instanceof` accepts the
// Node Blobs and Files Node itself creates (`await response.blob()`), so replacing the globals in the Vitest
// environment does not break them. FileReader reads any Blob through `arrayBuffer()` and fires its events
// in jsdom's three queued tasks (setImmediate).

const rt = require('./runtime.cjs');
const { EventTarget } = require('./dom.cjs');
const events = require('./events.cjs');
const context = require('./context.cjs');
const { MIMEType } = require('node:util');

const NodeBlob = globalThis.Blob;
const NodeFile = globalThis.File;
// Captured at load, like context.cjs's timers: fake timers installed later must not stall a read.
const nodeSetImmediate = globalThis.setImmediate;

function illegal() {
  throw new TypeError('Illegal constructor');
}

function tag(C, name = C.name) {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  rt.classes[name] = C;
  return C;
}

// ============================================================================= WebIDL conversions

/** DOMString (a template literal throws TypeError on a Symbol, as ToString must). */
const domString = (v) => (typeof v === 'string' ? v : `${v}`);
/** USVString: lone surrogates become U+FFFD. */
const usvString = (v) => domString(v).toWellFormed();

/** [Clamp] long long: NaN is 0, out-of-range values clamp, halves round to even. */
function clampLongLong(v) {
  const x = Number(v);
  if (Number.isNaN(x)) return 0;
  const c = Math.min(Math.max(x, -(2 ** 63)), 2 ** 63 - 1);
  const f = Math.floor(c);
  const r = c - f;
  return r < 0.5 ? f : r > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
}

/** long long: NaN and infinities are 0, truncation, then modulo 2^64 into the signed range. */
function longLong(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  const t = Math.trunc(x);
  if (Number.isSafeInteger(t)) return t === 0 ? 0 : t;
  return Number(BigInt.asIntN(64, BigInt(t)));
}

/** `sequence<BlobPart>`: GetMethod(@@iterator) once, then each element converted as it is produced. */
function blobParts(V, ctx) {
  if (V === null || (typeof V !== 'object' && typeof V !== 'function')) {
    throw new TypeError(`${ctx}: The provided value cannot be converted to a sequence.`);
  }
  const method = V[Symbol.iterator];
  if (typeof method !== 'function') throw new TypeError(`${ctx}: The object must have a callable @@iterator property.`);
  const iterator = method.call(V);
  if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function')) {
    throw new TypeError(`${ctx}: The iterator is not an object.`);
  }
  const next = iterator.next;
  const out = [];
  for (;;) {
    const r = next.call(iterator);
    if (r === null || (typeof r !== 'object' && typeof r !== 'function')) throw new TypeError(`${ctx}: The iterator result is not an object.`);
    if (r.done) return out;
    const part = r.value;
    out.push(part instanceof NodeBlob || part instanceof ArrayBuffer || ArrayBuffer.isView(part) ? part : usvString(part));
  }
}

/** BlobPropertyBag (endings, type) and FilePropertyBag's own lastModified after them (inherited members first). */
function propertyBag(obj, ctx, file) {
  if (obj !== undefined && obj !== null && typeof obj !== 'object' && typeof obj !== 'function') {
    throw new TypeError(`${ctx}: The provided value is not of type '${file ? 'FilePropertyBag' : 'BlobPropertyBag'}'.`);
  }
  const get = (k) => (obj === undefined || obj === null ? undefined : obj[k]);
  let endings = get('endings');
  if (endings === undefined) endings = 'transparent';
  else {
    endings = domString(endings);
    if (endings !== 'transparent' && endings !== 'native') {
      throw new TypeError(`${ctx}: The provided value '${endings}' is not a valid enum value of type EndingType.`);
    }
  }
  const type = get('type');
  const bag = { endings, type: type === undefined ? '' : domString(type), lastModified: undefined };
  if (file) {
    const lm = get('lastModified');
    if (lm !== undefined) bag.lastModified = longLong(lm);
  }
  return bag;
}

/** The type attribute's normalization: anything outside U+0020-U+007E empties it, else ASCII lowercase. */
const blobType = (t) => (/[^ -~]/.test(t) ? '' : t.toLowerCase());

/** `endings: 'native'`: jsdom always pretends to be *nix (refs/jsdom/lib/jsdom/living/file-api/Blob-impl.js). */
function withEndings(parts, endings) {
  if (endings !== 'native') return parts;
  return parts.map((p) => (typeof p === 'string' ? p.replace(/\r\n|\r|\n/g, '\n') : p));
}

// ===================================================================================== Blob, File

/** Constructor token for already-converted arguments: `new Blob(CONVERTED, { parts, type })`. */
const CONVERTED = Symbol('rsdom.blob.converted');

class Blob extends NodeBlob {
  constructor(parts = undefined, options = undefined) {
    if (parts === CONVERTED) {
      super(options.parts, { type: options.type });
    } else {
      const ps = parts === undefined ? [] : blobParts(parts, "Failed to construct 'Blob': parameter 1");
      const bag = propertyBag(options, "Failed to construct 'Blob': parameter 2", false);
      super(withEndings(ps, bag.endings), { type: blobType(bag.type) });
    }
  }

  slice(start = undefined, end = undefined, contentType = undefined) {
    if (!(this instanceof NodeBlob)) throw new TypeError("'slice' called on an object that is not a valid instance of Blob.");
    const { size } = this;
    let s = start === undefined ? 0 : clampLongLong(start);
    let e = end === undefined ? size : clampLongLong(end);
    s = s < 0 ? Math.max(size + s, 0) : Math.min(s, size);
    e = e < 0 ? Math.max(size + e, 0) : Math.min(e, size);
    const type = contentType === undefined ? '' : blobType(domString(contentType));
    return new Blob(CONVERTED, { parts: [super.slice(s, Math.max(e, s))], type });
  }

  static [Symbol.hasInstance](v) {
    return v instanceof NodeBlob;
  }
}

class File extends Blob {
  #name;
  #lastModified;

  constructor(fileBits, fileName, options = undefined) {
    if (arguments.length < 2) {
      throw new TypeError(`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`);
    }
    const ps = blobParts(fileBits, "Failed to construct 'File': parameter 1");
    const name = usvString(fileName);
    const bag = propertyBag(options, "Failed to construct 'File': parameter 3", true);
    super(CONVERTED, { parts: withEndings(ps, bag.endings), type: blobType(bag.type) });
    this.#name = name;
    this.#lastModified = bag.lastModified === undefined ? Date.now() : bag.lastModified;
  }

  get name() {
    if (#name in this) return this.#name;
    return nodeFileGetter('name', this);
  }

  get lastModified() {
    if (#name in this) return this.#lastModified;
    return nodeFileGetter('lastModified', this);
  }

  static [Symbol.hasInstance](v) {
    return (typeof v === 'object' && v !== null && #name in v) || v instanceof NodeFile;
  }
}

/** File getters on the Node Files Node creates (they are `instanceof File`, hasInstance above). */
function nodeFileGetter(key, file) {
  if (!(file instanceof NodeFile)) throw new TypeError(`'get ${key}' called on an object that is not a valid instance of File.`);
  return Object.getOwnPropertyDescriptor(NodeFile.prototype, key).get.call(file);
}

// ===================================================================================== FileReader

const EMPTY = 0;
const LOADING = 1;
const DONE = 2;
const READER_EVENTS = ['loadstart', 'progress', 'load', 'abort', 'error', 'loadend'];

/** Encoding name of a label, or null (WHATWG Encoding "get an encoding", through Node's ICU TextDecoder). */
function encodingOf(label) {
  if (label === undefined || label === null) return null;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

/** WHATWG Encoding "decode": a BOM overrides the encoding. */
function decode(bytes, encoding) {
  let enc = encoding;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) enc = 'utf-8';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) enc = 'utf-16be';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) enc = 'utf-16le';
  if (enc === 'windows-1252') return decode1252(bytes);
  return new TextDecoder(enc).decode(bytes);
}

/** WHATWG index-windows-1252 for 0x80-0x9F (Node's decoder maps them as ISO-8859-1); the rest is Latin-1. */
const CP1252 =
  '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

function decode1252(bytes) {
  const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
  return /[\x80-\x9f]/.test(s) ? s.replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]) : s;
}

function parseMime(type) {
  try {
    return new MIMEType(type);
  } catch {
    return null;
  }
}

/** FileReader's result for a format (refs/jsdom/lib/jsdom/living/file-api/FileReader-impl.js `_setResult`). */
function readResult(buf, type, format, label) {
  switch (format) {
    case 'binaryString':
      return Buffer.from(buf).toString('latin1');
    case 'dataURL':
      return `data:${parseMime(type) ?? 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
    case 'text': {
      let enc = label === undefined ? null : encodingOf(label);
      if (enc === null) enc = encodingOf(parseMime(type)?.params.get('charset'));
      return decode(new Uint8Array(buf), enc ?? 'utf-8');
    }
    default:
      return buf;
  }
}

/** FileReader's private state (brand-checked); assigned in its static block. */
let state;

class FileReader extends EventTarget {
  #s = { readyState: EMPTY, result: null, error: null, terminated: false, ctx: null };

  constructor() {
    super();
    this.#s.ctx = context.current();
    // `Object.keys(reader)` is [] as in jsdom: the listener registry is not an enumerable own property
    Object.defineProperty(this, '_ev', { value: null, writable: true, enumerable: false, configurable: true });
  }

  get readyState() {
    return state(this, 'readyState').readyState;
  }

  get result() {
    return state(this, 'result').result;
  }

  get error() {
    return state(this, 'error').error;
  }

  readAsArrayBuffer(blob) {
    read(this, 'readAsArrayBuffer', arguments.length, blob, 'buffer');
  }

  readAsBinaryString(blob) {
    read(this, 'readAsBinaryString', arguments.length, blob, 'binaryString');
  }

  readAsText(blob, label = undefined) {
    read(this, 'readAsText', arguments.length, blob, 'text', label === undefined ? undefined : domString(label));
  }

  readAsDataURL(blob) {
    read(this, 'readAsDataURL', arguments.length, blob, 'dataURL');
  }

  abort() {
    const s = state(this, 'abort');
    if (s.readyState === EMPTY || s.readyState === DONE) {
      s.result = null;
      return;
    }
    s.readyState = DONE;
    s.result = null;
    s.terminated = true;
    events.fire(this, 'abort', undefined, events.ProgressEvent);
    events.fire(this, 'loadend', undefined, events.ProgressEvent);
  }

  static {
    state = (r, member) => {
      if (typeof r !== 'object' || r === null || !(#s in r)) {
        throw new TypeError(`'${member}' called on an object that is not a valid instance of FileReader.`);
      }
      return r.#s;
    };
  }
}
/** The read steps: jsdom's three queued tasks, with the bytes fetched from Node's blob store meanwhile. */
function read(reader, method, argc, blob, format, label = undefined) {
  const s = state(reader, method);
  if (argc < 1) throw new TypeError(`Failed to execute '${method}' on 'FileReader': 1 argument required, but only 0 present.`);
  if (!(blob instanceof NodeBlob)) throw new TypeError(`Failed to execute '${method}' on 'FileReader': parameter 1 is not of type 'Blob'.`);
  if (s.readyState === LOADING) throw new rt.classes.DOMException('The object is in an invalid state.', 'InvalidStateError');
  s.readyState = LOADING;
  s.result = null;
  s.error = null;
  const { size, type } = blob;
  let bytes = null;
  let failure = null;
  const pending = blob.arrayBuffer().then((b) => {
    bytes = b;
  }, (e) => {
    failure = e;
  });
  // A step runs unless the context closed or abort() terminated the read (which the step then consumes).
  const live = () => {
    if (s.ctx !== null && s.ctx.closed) return false;
    if (!s.terminated) return true;
    s.terminated = false;
    return false;
  };
  const finish = () => {
    if (failure !== null) {
      s.readyState = DONE;
      s.error = new rt.classes.DOMException(`The blob could not be read: ${failure?.message ?? failure}`, 'NotReadableError');
      events.fire(reader, 'error', undefined, events.ProgressEvent);
    } else {
      s.result = readResult(bytes, type, format, label);
      s.readyState = DONE;
      events.fire(reader, 'load', undefined, events.ProgressEvent);
    }
    // a new read started by a load or error handler keeps its own loadend
    if (s.readyState !== LOADING) events.fire(reader, 'loadend', undefined, events.ProgressEvent);
  };
  nodeSetImmediate(() => {
    if (!live()) return;
    events.fire(reader, 'loadstart', undefined, events.ProgressEvent);
    nodeSetImmediate(() => {
      if (!live()) return;
      if (size > 0) events.fire(reader, 'progress', { lengthComputable: true, total: size, loaded: size }, events.ProgressEvent);
      nodeSetImmediate(() => {
        if (!live()) return;
        if (bytes !== null || failure !== null) finish();
        else pending.then(() => live() && finish());
      });
    });
  });
}

for (const [k, v] of Object.entries({ EMPTY, LOADING, DONE })) {
  const d = { value: v, writable: false, enumerable: true, configurable: false };
  Object.defineProperty(FileReader, k, d);
  Object.defineProperty(FileReader.prototype, k, d);
}

// ===================================================================================== install

function install(_rt, _dom) {
  tag(Blob);
  tag(File);
  tag(FileReader);
  events.defineHandlers(FileReader.prototype, READER_EVENTS);
}

module.exports = { install, Blob, File, FileReader };
