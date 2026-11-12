// oxidom-only: the facade protocol of the form-control `value` setters (CONTRIBUTING §5): every mutating facade
// method ends with `rt.mutated()` and routes the native's Code through `rt.check`.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

describe('value setters', () => {
  it('input, textarea and select value setters end with rt.mutated()', () => {
    const d = createWindow().window.document;
    d.body.innerHTML = '<input id=i><input id=h type=hidden><textarea id=t></textarea>'
      + '<select id=s><option>a</option><option>b</option></select>';
    const orig = rt.mutated;
    let calls = 0;
    rt.mutated = function counted(...args) {
      calls++;
      return orig.apply(this, args);
    };
    try {
      for (const [id, v, expected] of [['i', 'x', 'x'], ['h', 'y', 'y'], ['t', 'z', 'z'], ['s', 'b', 'b']]) {
        calls = 0;
        const el = d.getElementById(id);
        el.value = v;
        expect([id, el.value, calls > 0]).toEqual([id, expected, true]);
      }
    } finally {
      rt.mutated = orig;
    }
  });
});
