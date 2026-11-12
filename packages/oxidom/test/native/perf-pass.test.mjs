// Regressions for the profile-driven optimization pass (fast paths that must stay semantically
// transparent): oxidom-only checks on epochs, versions and raw natives.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { createWindow, rt } = require('../../lib/index.cjs');

describe('same-value setAttribute (attributes with derived state)', () => {
  it('queues the MutationObserver record but leaves attr_ver, EP[ATTR] and EP[STYLE] alone', async () => {
    const { window: w, document: d } = createWindow();
    d.head.innerHTML = '<style>.x{display:none}</style>';
    d.body.innerHTML = '<div id=a class=x></div>';
    const a = d.getElementById('a');
    const records = [];
    const mo = new w.MutationObserver((rs) => records.push(...rs.map((r) => [r.attributeName, r.oldValue])));
    mo.observe(a, { attributes: true, attributeOldValue: true });
    const ver = rt.field(a._i, rt.F.ATTR_VER);
    const ep = [rt.V.EP[rt.EPI.ATTR], rt.V.EP[rt.EPI.STYLE]];
    a.setAttribute('class', 'x');
    a.setAttribute('id', 'a');
    expect(rt.field(a._i, rt.F.ATTR_VER)).toBe(ver);
    expect([rt.V.EP[rt.EPI.ATTR], rt.V.EP[rt.EPI.STYLE]]).toEqual(ep);
    expect(w.getComputedStyle(a).display).toBe('none');
    a.setAttribute('class', 'y');
    expect(rt.field(a._i, rt.F.ATTR_VER)).not.toBe(ver);
    expect(w.getComputedStyle(a).display).toBe('block');
    await Promise.resolve();
    expect(records).toEqual([['class', 'x'], ['id', 'a'], ['class', 'x']]);
    mo.disconnect();
  });

  it('still runs the forms attribute change steps (re-setting checked re-checks a clean radio)', () => {
    const { document: d } = createWindow();
    d.body.innerHTML = '<input type=radio name=g id=r1 checked><input type=radio name=g id=r2>';
    const [r1, r2] = [d.getElementById('r1'), d.getElementById('r2')];
    r2.setAttribute('checked', ''); // r2 becomes checked, r1 is unchecked (both clean)
    expect([r1.checked, r2.checked]).toEqual([false, true]);
    r1.setAttribute('checked', ''); // same value: jsdom re-checks r1 and unchecks r2
    expect([r1.checked, r2.checked]).toEqual([true, false]);
  });
});

describe('getAttribute / hasAttribute memo (validated by attr_ver)', () => {
  it('every attribute-changing API invalidates it', () => {
    const { document: d } = createWindow();
    d.body.innerHTML = '<input id=a class=x data-k=1 type=text>';
    const a = d.getElementById('a');
    const read = () => [a.getAttribute('class'), a.getAttribute('data-k'), a.hasAttribute('title'), a.getAttribute('type'), a.hasAttribute('data-k')];
    expect(read()).toEqual(['x', '1', false, 'text', true]);
    expect(read()).toEqual(['x', '1', false, 'text', true]); // memo hit
    a.classList.add('y');
    a.dataset.k = '2';
    a.title = 't';
    expect(read()).toEqual(['x y', '2', true, 'text', true]);
    a.type = 'checkbox';
    a.removeAttribute('data-k');
    expect(read()).toEqual(['x y', null, true, 'checkbox', false]);
    a.getAttributeNode('class').value = 'z';
    a.toggleAttribute('title');
    expect(read()).toEqual(['z', null, false, 'checkbox', false]);
    a.setAttributeNS(null, 'data-k', '3');
    a.className = 'w';
    expect(read()).toEqual(['w', '3', false, 'checkbox', true]);
    const attr = a.getAttributeNode('data-k');
    a.removeAttributeNode(attr);
    expect(a.hasAttribute('data-k')).toBe(false);
    a.setAttributeNode(attr);
    expect(a.getAttribute('data-k')).toBe('3');
    // hasAttribute records presence only: a later getAttribute still reads the value
    a.setAttribute('data-p', 'v');
    expect(a.hasAttribute('data-p')).toBe(true);
    expect(a.getAttribute('data-p')).toBe('v');
    // a reset neuters wrappers: the memo must not answer for a dead node
    rt.reset();
    expect(a.getAttribute('class')).toBe(null);
    expect(a.hasAttribute('data-p')).toBe(false);
  });
});
