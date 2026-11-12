// Element state contract (DESIGN §19): the HTML predicates oxidom keeps in one Rust module
// (src/forms/element_state.rs) and the cases where its former copies disagreed with jsdom.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

const SVG = 'http://www.w3.org/2000/svg';

describe.each(DOMS)('element state [%s]', (kind) => {
  let w;
  let d;
  const jsdomLike = kind !== 'happy-dom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
  });
  const $ = (id) => d.getElementById(id);

  it('select size: rules for parsing non-negative integers ("-0" is 0, huge values saturate)', () => {
    d.body.innerHTML = '<select id=zero size="-0"><option>a</option><option>b</option></select>'
      + '<select id=huge size="99999999999999999999999"><option>a</option></select>'
      + '<select id=plus size=" +1"><option>a</option></select><select id=neg size="-1"><option>a</option></select>';
    if (jsdomLike) {
      // PINNED to jsdom: happy-dom ignores `size` for the display size
      expect($('zero').selectedIndex).toBe(-1);
      expect($('huge').selectedIndex).toBe(-1);
    }
    expect($('plus').selectedIndex).toBe(0);
    expect($('neg').selectedIndex).toBe(0);
  });

  it(':invalid applies maxlength / minlength as dom-selector does, validity.valid does not', () => {
    d.body.innerHTML = '<input id=zero maxlength="-0" value="a"><input id=huge maxlength="2147483648" value="abc">'
      + '<input id=ws maxlength=" 1" value="ab"><textarea id=min minlength="3">ab</textarea><input id=ok maxlength="5" value="ab">';
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom applies maxlength to validity and not to :invalid
    for (const id of ['zero', 'huge', 'ws', 'min', 'ok']) expect($(id).validity.valid).toBe(true);
    expect($('zero').matches(':invalid')).toBe(true);
    expect($('ws').matches(':invalid')).toBe(true);
    expect($('min').matches(':invalid')).toBe(true);
    expect($('huge').matches(':invalid')).toBe(false);
    expect($('ok').matches(':valid')).toBe(true);
  });

  it('summary for its parent details: only HTML <summary> children count', () => {
    const det = d.createElement('details');
    det.append(d.createElementNS(SVG, 'summary'));
    const s = d.createElement('summary');
    const second = d.createElement('summary');
    det.append(s, second);
    d.body.append(det);
    expect(second.tabIndex).toBe(-1);
    // PINNED to jsdom: happy-dom counts the SVG <summary> (tabIndex -1) and click() does not toggle
    if (!jsdomLike) return;
    expect(s.tabIndex).toBe(0);
    s.click();
    expect(det.open).toBe(true);
    second.click();
    expect(det.open).toBe(true);
  });

  it('input type follows the null-namespace type attribute only', () => {
    const i = d.createElement('input');
    i.setAttributeNS('urn:x', 'type', 'checkbox');
    i.indeterminate = true;
    d.body.append(i);
    if (!jsdomLike) return; // PINNED to jsdom: happy-dom reads the qualified name (type === 'checkbox')
    expect(i.type).toBe('text');
    expect(i.matches(':indeterminate')).toBe(false);
    expect(i.matches(':read-write')).toBe(true);
  });

  it(':disabled / :enabled vs the disabled used by focus and FormData', () => {
    d.body.innerHTML = '<form id=f><fieldset id=fs disabled><legend><input id=in-legend name=l value=1></legend>'
      + '<select id=s name=s><option id=o selected>x</option></select><input id=plain name=p value=2></fieldset>'
      + '<select name=g><optgroup disabled><option id=og selected>y</option></optgroup></select></form>';
    // PINNED to jsdom: happy-dom ignores disabled fieldsets (for :disabled and focus), the first-legend
    // exemption and disabled optgroups
    if (!jsdomLike) return;
    $('plain').focus();
    expect(d.activeElement).toBe(d.body);
    expect($('fs').matches(':disabled')).toBe(true);
    expect($('plain').matches(':disabled')).toBe(true);
    expect($('og').matches(':disabled')).toBe(true);
    expect($('in-legend').matches(':enabled')).toBe(true);
    expect($('o').matches(':enabled')).toBe(true);
    $('in-legend').focus();
    expect(d.activeElement).toBe($('in-legend'));
    expect([...new w.FormData($('f'))]).toEqual([['l', '1'], ['g', 'y']]);
  });

  it('submit buttons: FormData submitter and :default', () => {
    d.body.innerHTML = '<form id=f><input id=up type="SUBMIT" name=s value=v><button id=reset type="RESET" name=r>r</button>'
      + '<button id=b name=b value=bv>b</button><input type=checkbox name=c checked><input type=radio name=r2>'
      + '<datalist><input name=dl value=x></datalist><input name=t value=tv disabled></form>';
    // PINNED to jsdom: happy-dom accepts any submitter and keeps datalist descendants in the entry list
    if (!jsdomLike) return;
    expect(() => new w.FormData($('f'), $('reset'))).toThrow(TypeError);
    expect([...new w.FormData($('f'), $('up'))]).toEqual([['s', 'v'], ['c', 'on']]);
    expect([...new w.FormData($('f'), $('b'))]).toEqual([['b', 'bv'], ['c', 'on']]);
    // dom-selector compares the raw type attribute case-sensitively: type=SUBMIT is not a candidate,
    // type=RESET is, so it is the form's :default button
    expect($('up').matches(':default')).toBe(false);
    expect($('reset').matches(':default')).toBe(true);
    expect($('b').matches(':default')).toBe(false);
  });
});
