// ROADMAP M5 acceptance: user-event `type` with emoji and selectionStart checks matches jsdom. user-event's
// value/selection interceptors require the prototype contract (own value/selectionStart/setSelectionRange on
// HTMLInputElement.prototype) and real UTF-16 selection offsets.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, load } = require('./adapter.cjs');
const userEvent = load('@testing-library/user-event').default ?? load('@testing-library/user-event');

describe.each(DOMS)('user-event [%s]', (kind) => {
  let w;
  let d;
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    // getComputedStyle / getSelection belong to areas A and C; user-event only needs inert answers here.
    w.navigator ??= { userAgent: 'oxidom' };
    if (typeof w.getComputedStyle !== 'function') w.getComputedStyle = () => ({ pointerEvents: 'auto', display: 'inline', visibility: 'visible', getPropertyValue: () => '' });
    if (typeof d.getSelection !== 'function') {
      const sel = { rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, removeAllRanges() {}, addRange() {}, getRangeAt() { return null; }, setBaseAndExtent() {}, collapse() {} };
      d.getSelection = () => sel;
      w.getSelection = () => sel;
    }
  });

  it('types emoji with correct values and UTF-16 selection', async () => {
    d.body.innerHTML = '<input id="i"><textarea id="t"></textarea>';
    const i = d.getElementById('i');
    const user = userEvent.setup({ document: d, delay: null });
    const seen = [];
    i.addEventListener('input', () => seen.push([i.value, i.selectionStart, i.selectionEnd]));
    i.focus();
    await user.type(i, 'a😀b', { skipClick: true });
    expect(i.value).toBe('a😀b');
    expect([i.selectionStart, i.selectionEnd]).toEqual([4, 4]);
    // user-event types UTF-16 code units: the intermediate value holds a lone high surrogate (DESIGN §44)
    expect(seen).toEqual([['a', 1, 1], ['a\ud83d', 2, 2], ['a😀', 3, 3], ['a😀b', 4, 4]]);
    i.setSelectionRange(1, 3);
    await user.keyboard('{Backspace}');
    expect([i.value, i.selectionStart]).toEqual(['ab', 1]);
    const t = d.getElementById('t');
    t.focus();
    await user.type(t, 'x{Enter}y', { skipClick: true });
    expect(t.value).toBe('x\ny');
    await user.clear(t);
    expect(t.value).toBe('');
  });

  it('keyboard events reach listeners with key / code', async () => {
    d.body.innerHTML = '<input id="i">';
    const i = d.getElementById('i');
    const keys = [];
    i.addEventListener('keydown', (e) => keys.push(`${e.key}/${e.code}`));
    const user = userEvent.setup({ document: d, delay: null });
    i.focus();
    await user.type(i, 'A', { skipClick: true });
    expect(keys).toEqual(['A/KeyA']);
  });
});
