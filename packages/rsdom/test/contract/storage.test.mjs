// Web Storage named properties (ROADMAP Stage 3 `storage`, DESIGN §26). The upstream coverage is conformance/parity
// (`--item storage`: WPT webstorage); these cases add what test code does with a Storage object: property-style
// writes and reads, `in`, `delete`, spreading and JSON.stringify of the whole store, and the quota. Every assertion
// runs on jsdom, happy-dom and rsdom; jsdom wins disagreements.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

describe.each(DOMS)('storage [%s]', (kind) => {
  let w;
  let s;
  beforeEach(() => {
    w = makeWindow(kind);
    s = w.localStorage;
    s.clear();
  });

  it('named properties read, write, test and delete items', () => {
    s.foo = 'x';
    expect(s.getItem('foo')).toBe('x');
    expect(s.foo).toBe('x');
    expect('foo' in s).toBe(true);
    expect(s.length).toBe(1);
    s.setItem('bar', 'y');
    expect(s.bar).toBe('y');
    s[7] = 12;
    expect(s.getItem('7')).toBe('12');
    expect(s[7]).toBe('12');
    expect(delete s.foo).toBe(true);
    expect(s.getItem('foo')).toBe(null);
    expect('foo' in s).toBe(false);
    expect(s.foo).toBe(undefined);
    expect(s.length).toBe(2);
    s.removeItem('bar');
    expect(s.bar).toBe(undefined);
  });

  it('enumeration lists the keys only', () => {
    s.setItem('a', '1');
    s.b = '2';
    expect(Object.keys(s).sort()).toEqual(['a', 'b']);
    expect(Object.entries(s).sort()).toEqual([['a', '1'], ['b', '2']]);
    expect({ ...s }).toEqual({ a: '1', b: '2' });
    expect(JSON.parse(JSON.stringify(s))).toEqual({ a: '1', b: '2' });
    const seen = [];
    for (const k in s) if (Object.hasOwn(s, k)) seen.push(k);
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(Object.getOwnPropertyDescriptor(s, 'a')).toEqual({ value: '1', writable: true, enumerable: true, configurable: true });
  });

  it('built-in members shadow items of the same name', () => {
    s.setItem('getItem', 'shadowed');
    s.setItem('length', 'also');
    expect(typeof s.getItem).toBe('function');
    expect(s.length).toBe(2);
    expect(s.getItem('getItem')).toBe('shadowed');
    expect(Object.getOwnPropertyDescriptor(s, 'length')).toBe(undefined);
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom 21 replaces the method with the item's value
      s.key = 'k';
      expect(typeof s.key).toBe('function');
      expect(s.getItem('key')).toBe('k');
    }
  });

  it('values are stringified and defineProperty stores an item', () => {
    s.n = 1;
    s.o = { toString: () => 'O' };
    expect(s.n).toBe('1');
    expect(s.o).toBe('O');
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom 21 defines an own property instead of storing an item
      expect(Object.defineProperty(s, 'd', { value: 5 })).toBe(s);
      expect(s.getItem('d')).toBe('5');
      expect(errName(() => Object.defineProperty(s, 'g', { get() {} }))).toBe('TypeError');
    }
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21 drops symbol-keyed properties
    const sym = Symbol('k');
    s[sym] = 'v';
    expect(s[sym]).toBe('v');
    expect(s.length).toBe(3);
  });

  it.skipIf(kind === 'happy-dom')('missing arguments throw TypeError', () => {
    // PINNED to jsdom: happy-dom 21 accepts them
    expect(errName(() => s.getItem())).toBe('TypeError');
    expect(errName(() => s.setItem('a'))).toBe('TypeError');
    expect(errName(() => s.removeItem())).toBe('TypeError');
    expect(errName(() => s.key())).toBe('TypeError');
  });

  it('localStorage and sessionStorage are separate areas', () => {
    s.a = '1';
    expect(w.sessionStorage.a).toBe(undefined);
    if (kind !== 'happy-dom') expect(Object.prototype.toString.call(s)).toBe('[object Storage]'); // PINNED to jsdom: happy-dom 21 has no toStringTag
    expect(Object.getPrototypeOf(s)).toBe(w.Storage.prototype);
  });

  it.skipIf(kind === 'happy-dom')('exceeding the quota throws QuotaExceededError', () => {
    // PINNED to jsdom: happy-dom 21 has no quota
    const big = 'x'.repeat(2_500_000);
    s.setItem('a', big);
    let err;
    try {
      s.setItem('b', big);
    } catch (e) {
      err = e;
    }
    expect(err.name).toBe('QuotaExceededError');
    expect(err.code).toBe(22);
    expect(err).toBeInstanceOf(w.DOMException);
    expect(err.constructor).toBe(w.QuotaExceededError);
    expect(s.getItem('b')).toBe(null);
    s.clear();
  });

  it('StorageEvent.initStorageEvent', () => {
    const e = new w.StorageEvent('storage');
    expect(e.storageArea).toBe(null);
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom 21 has no initStorageEvent
    e.initStorageEvent('x', true, false, 'k', null, 'n', 'u', s);
    expect([e.type, e.bubbles, e.key, e.oldValue, e.newValue, e.url, e.storageArea]).toEqual(['x', true, 'k', null, 'n', 'u', s]);
    expect(errName(() => e.initStorageEvent('x', false, false, null, null, null, '', {}))).toBe('TypeError');
    expect(errName(() => new w.StorageEvent('storage', { storageArea: {} }))).toBe('TypeError');
  });
});
