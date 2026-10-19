// formEntries(form, submitter) (the entry list AREA C's FormData override builds on) vs jsdom's FormData.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow } = require('../contract/adapter.cjs');
const { formEntries } = require('../../lib/forms.cjs');

const HTML = `<form id="f">
  <input name="text" value="t1"><input name="empty"><input value="no-name">
  <input type="checkbox" name="cb1" checked><input type="checkbox" name="cb2"><input type="checkbox" name="cb3" value="v3" checked>
  <input type="radio" name="r" value="a"><input type="radio" name="r" value="b" checked>
  <select name="s"><option>x</option><option selected value="y">Y</option></select>
  <select name="m" multiple><option selected>1</option><option>2</option><option selected disabled>3</option></select>
  <textarea name="ta">line1
line2</textarea>
  <input name="dis" value="d" disabled>
  <fieldset disabled><input name="infs" value="f"></fieldset>
  <datalist><input name="indl" value="dl"></datalist>
  <input type="hidden" name="h" value="hv">
  <input name="dn" value="x" dirname="dn.dir">
  <button name="b1" value="bv1" id="b1">1</button><button name="b2" value="bv2">2</button>
  <input type="submit" name="sub" value="sv" id="sub"><input type="image" name="img" id="img">
</form><input form="f" name="outside" value="o">`;

function entries(kind, submitterId) {
  const w = makeWindow(kind);
  w.document.body.innerHTML = HTML;
  const form = w.document.getElementById('f');
  const sub = submitterId ? w.document.getElementById(submitterId) : null;
  if (kind === 'jsdom') return Array.from(new w.FormData(form, sub)).map(([k, v]) => [k, typeof v === 'string' ? v : `File:${v.name}`]);
  return formEntries(form, sub).map(([k, v]) => [k, typeof v === 'string' ? v : `File:${v.name}`]);
}

describe('formEntries vs jsdom FormData', () => {
  for (const sub of [null, 'b1', 'sub', 'img']) {
    it(`submitter ${sub}`, () => {
      expect(entries('rsdom', sub)).toEqual(entries('jsdom', sub));
    });
  }
});
