// File API: Blob, File and FileReader (ROADMAP Stage 3 `file-api`, DESIGN §27). The upstream coverage is
// conformance/parity (`--item file-api`: WPT FileAPI); these cases add what test code does with them: reading an
// uploaded File the way an <input type=file> change handler does, data URLs for image previews, text decoding,
// abort, and Blobs crossing into Node's fetch. Every assertion runs on jsdom, happy-dom and oxidom; jsdom wins
// disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('file-api [%s]', (kind) => {
  let w;
  beforeEach(() => {
    w = makeWindow(kind);
  });

  /** Runs a read and resolves with the event types fired and the reader, at loadend. */
  const readWith = (blob, method, ...args) =>
    new Promise((resolve) => {
      const r = new w.FileReader();
      const seen = [];
      for (const t of ['loadstart', 'progress', 'load', 'error', 'abort']) r.addEventListener(t, () => seen.push(t));
      r.onloadend = () => resolve({ seen: [...seen, 'loadend'], r });
      r[method](blob, ...args);
      seen.push(`readyState ${r.readyState}`);
    });

  it('reads a File as text, with the events in order', async () => {
    const f = new w.File(['héllo'], 'a.txt', { type: 'text/plain' });
    const { seen, r } = await readWith(f, 'readAsText');
    // PINNED to jsdom: happy-dom 21 orders progress differently
    if (kind !== 'happy-dom') expect(seen).toEqual(['readyState 1', 'loadstart', 'progress', 'load', 'loadend']);
    expect(r.result).toBe('héllo');
    expect(r.readyState).toBe(2);
    expect(r.error).toBe(null);
  });

  it('readAsDataURL, readAsArrayBuffer and readAsBinaryString', async () => {
    const b = new w.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/PNG' });
    expect((await readWith(b, 'readAsDataURL')).r.result).toBe('data:image/png;base64,iVBORw==');
    const ab = (await readWith(b, 'readAsArrayBuffer')).r.result;
    expect(Object.prototype.toString.call(ab)).toBe('[object ArrayBuffer]');
    expect([...new Uint8Array(ab)]).toEqual([137, 80, 78, 71]);
    expect((await readWith(b, 'readAsBinaryString')).r.result).toBe('\x89PNG');
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom 21 writes `data:;base64,` for an untyped Blob
      expect((await readWith(new w.Blob(['hi']), 'readAsDataURL')).r.result).toBe('data:application/octet-stream;base64,aGk=');
    }
  });

  it('an empty Blob fires no progress event', async () => {
    const { seen, r } = await readWith(new w.Blob([]), 'readAsText');
    // PINNED to jsdom: happy-dom 21 fires progress for an empty Blob
    if (kind !== 'happy-dom') expect(seen).toEqual(['readyState 1', 'loadstart', 'load', 'loadend']);
    expect(r.result).toBe('');
  });

  it.skipIf(kind === 'happy-dom')('readAsText decodes with the label, the charset or a BOM', async () => {
    // PINNED to jsdom: happy-dom 21 ignores the label and the charset
    const latin1 = new w.Blob([new Uint8Array([0x63, 0x61, 0x66, 0xe9])]);
    expect((await readWith(latin1, 'readAsText', 'iso-8859-1')).r.result).toBe('café');
    const typed = new w.Blob([new Uint8Array([0x63, 0x61, 0x66, 0xe9])], { type: 'text/plain;charset=windows-1252' });
    expect((await readWith(typed, 'readAsText')).r.result).toBe('café');
    const bom = new w.Blob([new Uint8Array([0xff, 0xfe, 0x61, 0x00])]);
    expect((await readWith(bom, 'readAsText', 'utf-8')).r.result).toBe('a');
  });

  it.skipIf(kind === 'happy-dom')('abort, InvalidStateError and argument checks', async () => {
    // PINNED to jsdom: happy-dom 21 fires load after abort and throws no InvalidStateError
    const r = new w.FileReader();
    const seen = [];
    for (const t of ['loadstart', 'load', 'abort', 'loadend']) r.addEventListener(t, () => seen.push(t));
    r.readAsText(new w.Blob(['x']));
    expect(errName(() => r.readAsText(new w.Blob(['y'])))).toBe('InvalidStateError');
    r.abort();
    expect(seen).toEqual(['abort', 'loadend']);
    expect(r.readyState).toBe(2);
    expect(r.result).toBe(null);
    await new Promise((res) => setTimeout(res, 20));
    expect(seen).toEqual(['abort', 'loadend']);
    expect(errName(() => r.readAsText('not a blob'))).toBe('TypeError');
    expect(errName(() => r.readAsArrayBuffer())).toBe('TypeError');
    expect(w.FileReader.LOADING).toBe(1);
    expect(r.EMPTY).toBe(0);
  });

  it('File and Blob basics', () => {
    const f = new w.File(['ab', new Uint8Array([99])], 'n.bin', { type: 'App/X', lastModified: 42 });
    expect([f.name, f.size, f.type, f.lastModified]).toEqual(['n.bin', 3, 'app/x', 42]);
    expect(f instanceof w.Blob).toBe(true);
    expect(new w.Blob(['x']) instanceof w.File).toBe(false);
    if (kind !== 'happy-dom') expect(Object.prototype.toString.call(f)).toBe('[object File]'); // PINNED to jsdom: happy-dom 21 has no toStringTag
    expect(errName(() => new w.File(['x']))).toBe('TypeError');
    const s = f.slice(1, 3, 'TEXT/plain');
    expect(s instanceof w.Blob).toBe(true);
    expect(s instanceof w.File).toBe(false);
    expect([s.size, s.type]).toEqual([2, 'text/plain']);
  });

  it.skipIf(kind === 'happy-dom')('slice clamps and rounds its offsets as WebIDL [Clamp] does', async () => {
    // PINNED to jsdom: happy-dom 21 truncates them
    const b = new w.Blob(['abcd']);
    expect(await b.slice(1.5).text()).toBe('cd');
    expect(await b.slice(0, 2.5).text()).toBe('ab');
    expect(await b.slice(-3, -1).text()).toBe('bc');
    expect(await b.slice(0, 1e300).text()).toBe('abcd');
  });

  it.skipIf(kind === 'happy-dom')('endings: native and option conversion order', async () => {
    // PINNED to jsdom: happy-dom 21 ignores `endings`
    expect(await new w.Blob(['a\r\nb\rc'], { endings: 'native' }).text()).toBe('a\nb\nc');
    expect(errName(() => new w.Blob([], { endings: 'dos' }))).toBe('TypeError');
    const order = [];
    new w.Blob([], { get type() { order.push('type'); return ''; }, get endings() { order.push('endings'); return undefined; } });
    expect(order).toEqual(['endings', 'type']);
  });

  it('a window Blob is a Blob to Node', async () => {
    const b = new w.Blob(['{"a":1}'], { type: 'application/json' });
    if (kind === 'oxidom') {
      // oxidom's Blob is a Node Blob (DESIGN §27); jsdom's and happy-dom's are not
      expect(b instanceof globalThis.Blob).toBe(true);
      expect(await new Response(b).json()).toEqual({ a: 1 });
      expect((await new Response('z').blob()) instanceof w.Blob).toBe(true);
    }
    expect(await b.text()).toBe('{"a":1}');
  });
});
