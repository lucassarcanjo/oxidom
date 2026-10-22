// Core DOM gaps (ROADMAP Stage 3 `core`): behaviour no other item claims, checked against jsdom.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

describe.each(DOMS)('core [%s]', (kind) => {
  let d;
  beforeEach(() => {
    d = makeWindow(kind).document;
  });

  it('live lists expose their indices as own enumerable properties', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom
    d.body.innerHTML = '<p></p><p></p>';
    const kids = d.body.childNodes;
    const ps = d.getElementsByTagName('p');
    expect(kids.length).toBe(2);
    expect(Object.keys(kids)).toEqual(['0', '1']);
    expect(ps.length).toBe(2); // own-ness is synced on `length` reads (DESIGN §4.3)
    expect(Object.prototype.hasOwnProperty.call(ps, 1)).toBe(true);
    d.body.lastChild.remove();
    expect(ps.length).toBe(1);
    expect([ps.hasOwnProperty(0), ps.hasOwnProperty(1)]).toEqual([true, false]);
    expect(Object.keys(ps)).toEqual(['0']);
  });

  it('two equal live lists compare equal after one had its length read', () => {
    d.body.innerHTML = '<ul><li>a</li></ul><ul><li>a</li></ul>';
    const [u1, u2] = d.querySelectorAll('ul');
    expect(u1.children.length).toBe(1);
    expect(u1.children).toEqual(u2.children);
    expect(u1.childNodes).toEqual(u2.childNodes);
  });

  it('a frozen live list keeps answering length', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's lists are arrays
    const kids = d.body.childNodes;
    try {
      Object.freeze(kids); // jsdom's Proxy refuses this
    } catch {}
    d.body.append(d.createElement('p'));
    expect(kids.length).toBe(1);
  });

  it('select.options keeps its indexed setter on own indices', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom ignores the assignment
    d.body.innerHTML = '<select><option>a</option><option>b</option></select>';
    const opts = d.querySelector('select').options;
    expect(opts.length).toBe(2);
    const o = d.createElement('option');
    o.textContent = 'c';
    opts[1] = o;
    expect(opts[1].textContent).toBe('c');
  });

  it('named properties on form.elements, document.forms and attributes', () => {
    d.body.innerHTML = '<form id="f"><input name="email" value="x"></form>';
    const form = d.forms.f;
    expect(form.id).toBe('f');
    expect(form.elements.email.value).toBe('x');
    const token = d.createElement('input');
    token.name = '_token'; // a CSRF field: `_` names work on collections
    form.append(token);
    expect(form.elements._token).toBe(token);
    const el = d.querySelector('input');
    expect(el.attributes.name.value).toBe('email');
    if (kind === 'happy-dom') return; // PINNED to jsdom
    expect(Object.keys(d.forms)).toEqual(['0']); // own indices from the getter, names not enumerable
    const held = form.elements;
    const attrs = el.attributes;
    el.name = 'renamed'; // a held collection / map answers names as of now
    el.setAttribute('data-x', '1');
    expect([held.email, held.renamed]).toEqual([undefined, el]);
    expect(attrs['data-x'].value).toBe('1');
    expect(attrs.DATA_X).toBe(undefined);
    expect(attrs.length).toBe(3); // own indices are synced on reads (DESIGN §4.3)
    expect(Object.keys(attrs)).toEqual(['0', '1', '2']); // names are not enumerable
    expect(d.body.children.f).toBe(form);
    expect(form.elements.item).toBe(d.defaultView.HTMLFormControlsCollection.prototype.item); // the prototype wins
  });

  it('document named properties: forms and named images, a live collection for duplicates', () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom has no document named properties
    d.body.innerHTML = '<form name="login"></form><img id="logo" name="brand"><form name="dup"></form><embed name="dup">';
    expect(d.login).toBe(d.forms[0]);
    expect([d.logo, d.brand]).toEqual([d.images[0], d.images[0]]);
    const dup = d.dup;
    expect(dup.length).toBe(2);
    expect([...dup]).toEqual([d.forms[1], d.querySelector('embed')]);
    expect(d.dup).toBe(dup);
    d.querySelector('img').removeAttribute('name'); // an img contributes its id only alongside a name
    expect([d.logo, d.brand]).toEqual([undefined, undefined]);
    d.querySelector('embed').remove();
    expect(dup.length).toBe(1);
    expect(d.dup).toBe(d.forms[1]);
    expect(d.createElement).toBe(d.defaultView.Document.prototype.createElement);
    const parsed = new d.defaultView.DOMParser().parseFromString('<form name="p"></form>', 'text/html');
    expect(parsed.p).toBe(parsed.forms[0]); // a fresh document answers on first read
    d.body.firstChild.setAttribute('name', 'renamed');
    expect([d.login, d.renamed]).toEqual([undefined, d.forms[0]]);
  });

  it('HTMLMediaElement: state, volume / rate events as tasks, play() not implemented', async () => {
    if (kind === 'happy-dom') return; // PINNED to jsdom: happy-dom's play() returns a promise
    const v = d.createElement('video');
    expect([v.paused, v.readyState, v.currentSrc, v.canPlayType('video/mp4')]).toEqual([true, 0, '', '']);
    expect(Number.isNaN(v.duration)).toBe(true);
    expect(v.buffered).toBe(v.buffered);
    const seen = [];
    v.addEventListener('volumechange', () => seen.push('volume'));
    v.addEventListener('ratechange', () => seen.push('rate'));
    v.muted = true;
    v.playbackRate = 2;
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['volume', 'rate']);
    expect(() => {
      v.volume = 2;
    }).toThrow(/allowed range/);
    expect(v.play()).toBe(undefined);
    expect(d.defaultView.HTMLMediaElement.HAVE_ENOUGH_DATA).toBe(4);
  });
});
