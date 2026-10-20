// Inert observers and scrolling APIs (ROADMAP Stage 1 `observers`, DESIGN §24). Beyond jsdom: jsdom has none of
// these (asserted below, so a jsdom upgrade that adds them shows up here), so happy-dom, which implements them as
// inert stubs too, is the comparison. Argument validation happy-dom skips follows the specs and runs on rsdom only
// (`spec` below).
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS, errName } = require('./adapter.cjs');

const NAMES = ['ResizeObserver', 'IntersectionObserver'];
const ELEMENT_METHODS = ['scrollIntoView', 'scroll', 'scrollTo', 'scrollBy', 'setPointerCapture', 'releasePointerCapture', 'hasPointerCapture', 'checkVisibility'];

describe.each(DOMS.filter((k) => k === 'jsdom'))('observers [%s]', (kind) => {
  it('jsdom has none of them (the reason test setups shim them)', () => {
    const w = makeWindow(kind);
    for (const k of NAMES) expect(k in w, k).toBe(false);
    for (const k of ELEMENT_METHODS) expect(k in w.Element.prototype, k).toBe(false);
  });
});

describe.each(DOMS.filter((k) => k !== 'jsdom'))('observers [%s]', (kind) => {
  let w;
  let d;
  let el;
  const spec = kind === 'rsdom';
  beforeEach(() => {
    w = makeWindow(kind);
    d = w.document;
    el = d.createElement('div');
    d.body.append(el);
  });

  /** Lets microtasks, timers and animation frames run, so an observer that would fire has fired. */
  const settle = () => new Promise((r) => setTimeout(r, 40));

  it('interface objects are writable, configurable window members', () => {
    for (const k of NAMES) {
      expect(typeof w[k], k).toBe('function');
      const desc = Object.getOwnPropertyDescriptor(w, k);
      expect(desc.writable && desc.configurable, k).toBe(true);
    }
    for (const k of ELEMENT_METHODS) expect(typeof w.Element.prototype[k], k).toBe('function');
  });

  it('a test polyfill assigned over them wins', () => {
    class Shim {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    w.ResizeObserver = Shim;
    expect(w.ResizeObserver).toBe(Shim);
    const mine = function scrollIntoView() {
      this.dataset.scrolled = '1';
    };
    w.Element.prototype.scrollIntoView = mine;
    el.scrollIntoView();
    expect(el.dataset.scrolled).toBe('1');
  });

  it('ResizeObserver accepts targets and never fires', async () => {
    const calls = [];
    const ro = new w.ResizeObserver((entries) => calls.push(entries));
    ro.observe(el);
    ro.observe(el, { box: 'border-box' });
    el.style.width = '100px';
    await settle();
    ro.unobserve(el);
    ro.disconnect();
    expect(calls).toEqual([]);
    if (spec) expect(Object.prototype.toString.call(ro)).toBe('[object ResizeObserver]'); // happy-dom: no toStringTag
  });

  it('IntersectionObserver accepts targets, never fires, and reports its options', async () => {
    const calls = [];
    const io = new w.IntersectionObserver((entries) => calls.push(entries));
    io.observe(el);
    await settle();
    expect(calls).toEqual([]);
    expect(io.takeRecords()).toEqual([]);
    io.unobserve(el);
    io.disconnect();
    if (spec) {
      expect(io.root).toBe(null);
      expect(io.rootMargin).toBe('0px 0px 0px 0px');
      expect(io.thresholds).toEqual([0]);
      const o = new w.IntersectionObserver(() => {}, { root: d, rootMargin: '10px 5%', threshold: [1, 0.25, 0.5] });
      expect(o.root).toBe(d);
      expect(o.rootMargin).toBe('10px 5% 10px 5%');
      expect(o.thresholds).toEqual([0.25, 0.5, 1]);
      expect(o.thresholds).toBe(o.thresholds);
      expect(new w.IntersectionObserver(() => {}, { rootMargin: '1px 2px 3px' }).rootMargin).toBe('1px 2px 3px 2px');
      expect(new w.IntersectionObserver(() => {}, { threshold: 0.5 }).thresholds).toEqual([0.5]);
      expect(new w.IntersectionObserver(() => {}, { threshold: [] }).thresholds).toEqual([0]);
    }
  });

  it.runIf(spec)('observer argument validation (spec)', () => {
    expect(errName(() => new w.ResizeObserver())).toBe('TypeError');
    expect(errName(() => new w.ResizeObserver(1))).toBe('TypeError');
    expect(errName(() => w.ResizeObserver(() => {}))).toBe('TypeError');
    const ro = new w.ResizeObserver(() => {});
    expect(errName(() => ro.observe(d))).toBe('TypeError');
    expect(errName(() => ro.observe(el, { box: 'padding-box' }))).toBe('TypeError');
    expect(errName(() => ro.observe())).toBe('TypeError');
    expect(errName(() => new w.IntersectionObserver(null))).toBe('TypeError');
    expect(errName(() => new w.IntersectionObserver(() => {}, { root: {} }))).toBe('TypeError');
    for (const m of ['1', '2em', 'auto', '1px 2px 3px 4px 5px', 'calc(1px + 2px)']) {
      expect(errName(() => new w.IntersectionObserver(() => {}, { rootMargin: m })), m).toBe('SyntaxError');
    }
    expect(errName(() => new w.IntersectionObserver(() => {}, { threshold: 1.5 }))).toBe('RangeError');
    expect(errName(() => new w.IntersectionObserver(() => {}, { threshold: [-0.1] }))).toBe('RangeError');
    expect(errName(() => new w.IntersectionObserver(() => {}, { threshold: NaN }))).toBe('TypeError');
    const io = new w.IntersectionObserver(() => {});
    expect(errName(() => io.observe(null))).toBe('TypeError');
    expect(errName(() => w.IntersectionObserver.prototype.takeRecords.call({}))).toBe('TypeError');
    expect(errName(() => new w.ResizeObserverEntry())).toBe('TypeError');
  });

  it.runIf(spec)('IntersectionObserverEntry is constructible from its init dictionary (spec)', () => {
    const e = new w.IntersectionObserverEntry({
      time: 5, rootBounds: null, boundingClientRect: { width: 10, height: 20 }, intersectionRect: {}, isIntersecting: true,
      intersectionRatio: 1, target: el,
    });
    expect([e.time, e.rootBounds, e.isIntersecting, e.intersectionRatio, e.target]).toEqual([5, null, true, 1, el]);
    expect(e.boundingClientRect.bottom).toBe(20);
    expect('intersectionRatio' in w.IntersectionObserverEntry.prototype).toBe(true);
    expect(errName(() => new w.IntersectionObserverEntry({}))).toBe('TypeError');
  });

  it('scrollIntoView is a no-op that accepts every argument form', () => {
    expect(el.scrollIntoView()).toBe(undefined);
    el.scrollIntoView(false);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  it('scroll / scrollTo / scrollBy move the remembered scroll offsets', () => {
    el.scrollTo(10, 20);
    expect([el.scrollLeft, el.scrollTop]).toEqual([10, 20]);
    el.scroll({ top: 5 });
    expect([el.scrollLeft, el.scrollTop]).toEqual([10, 5]);
    el.scrollTo({ left: 1, top: 2, behavior: 'instant' });
    expect([el.scrollLeft, el.scrollTop]).toEqual([1, 2]);
    if (kind !== 'happy-dom') {
      // PINNED to the spec: happy-dom has no Element#scrollBy, and its scroll() keeps NaN
      el.scrollBy(4, 4);
      expect([el.scrollLeft, el.scrollTop]).toEqual([5, 6]);
      el.scrollBy({ left: -5 });
      expect([el.scrollLeft, el.scrollTop]).toEqual([0, 6]);
      el.scrollTo(NaN, Infinity);
      expect([el.scrollLeft, el.scrollTop]).toEqual([0, 0]);
    }
    expect(errName(() => el.scrollTo(5))).toBe('TypeError');
  });

  it('pointer capture is held by one element per pointer and released with it', () => {
    const other = d.createElement('span');
    d.body.append(other);
    expect(el.hasPointerCapture(1)).toBe(false);
    el.setPointerCapture(1);
    expect(el.hasPointerCapture(1)).toBe(true);
    expect(el.hasPointerCapture(2)).toBe(false);
    el.releasePointerCapture(1);
    expect(el.hasPointerCapture(1)).toBe(false);
    if (spec) {
      // PINNED to the spec: happy-dom keeps a per-element set (several holders, no implicit release, no checks)
      el.setPointerCapture(1);
      other.setPointerCapture(1);
      expect([el.hasPointerCapture(1), other.hasPointerCapture(1)]).toEqual([false, true]);
      other.remove();
      expect(other.hasPointerCapture(1)).toBe(false);
      expect(errName(() => d.createElement('p').setPointerCapture(1))).toBe('InvalidStateError');
      expect(errName(() => el.hasPointerCapture())).toBe('TypeError');
    }
  });

  it('checkVisibility follows display, opacity and visibility', () => {
    d.body.innerHTML = '<div id=a style="display:none"><span id=b></span></div><div id=h hidden></div><div id=c style="opacity:0"><i id=e></i></div>'
      + '<div style="visibility:hidden"><i id=f></i></div><p id=g>x</p>';
    const $ = (id) => d.getElementById(id);
    expect($('g').checkVisibility()).toBe(true);
    expect($('a').checkVisibility()).toBe(false);
    expect($('b').checkVisibility()).toBe(false);
    expect($('e').checkVisibility()).toBe(true);
    expect($('e').checkVisibility({ opacityProperty: true })).toBe(false);
    expect($('e').checkVisibility({ checkOpacity: true })).toBe(false);
    expect($('f').checkVisibility()).toBe(true);
    expect($('f').checkVisibility({ visibilityProperty: true })).toBe(false);
    expect($('f').checkVisibility({ checkVisibilityCSS: true })).toBe(false);
    expect(d.createElement('div').checkVisibility()).toBe(false);
    if (spec) expect($('h').checkVisibility()).toBe(false); // PINNED to the UA sheet: happy-dom ignores [hidden] here
    $('g').style.display = 'contents';
    // PINNED to the spec: a display: contents element has no box (happy-dom asks its children)
    if (spec) expect($('g').checkVisibility()).toBe(false);
  });
});
