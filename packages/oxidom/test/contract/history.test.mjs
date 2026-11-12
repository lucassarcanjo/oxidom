// Session history traversal parity (DESIGN §23): history.back / forward / go, popstate, and the entries that
// pushState and fragment navigations add. jsdom is the oracle: traversal is two queued tasks (setImmediate) and
// fires popstate, then hashchange, synchronously in the second one. happy-dom traverses synchronously: the
// assertions about what is visible before the tasks run are pinned to jsdom.
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const { makeWindow, DOMS } = require('./adapter.cjs');

/** One turn of the event loop's check phase (one jsdom task). */
const tick = () => new Promise((r) => setImmediate(r));

/** Lets every queued traversal finish. */
async function settle() {
  for (let i = 0; i < 4; i++) await tick();
}

describe.each(DOMS)('history traversal [%s]', (kind) => {
  let w;
  let log;
  beforeEach(() => {
    w = makeWindow(kind);
    log = [];
    w.addEventListener('popstate', (e) => log.push(['popstate', e.state, w.location.pathname + w.location.hash]));
    w.addEventListener('hashchange', (e) => log.push(['hashchange', e.oldURL, e.newURL]));
  });

  it('back / forward / go move between pushState entries and fire popstate with the entry state', async () => {
    w.history.pushState({ a: 1 }, '', '/a');
    w.history.pushState({ b: 1 }, '', '/b');
    w.history.back();
    await settle();
    expect(w.location.href).toBe('http://localhost:3000/a');
    expect(w.document.URL).toBe('http://localhost:3000/a');
    expect(w.history.state).toEqual({ a: 1 });
    expect(w.history.length).toBe(3);
    w.history.forward();
    await settle();
    expect(w.location.pathname).toBe('/b');
    expect(w.history.state).toEqual({ b: 1 });
    w.history.go(-2);
    await settle();
    expect(w.location.pathname).toBe('/');
    expect(w.history.state).toBe(null);
    expect(log).toEqual([
      ['popstate', { a: 1 }, '/a'],
      ['popstate', { b: 1 }, '/b'],
      ['popstate', null, '/'],
    ]);
  });

  it('traversal is two queued tasks; the URL and state change in the second, just before popstate', async () => {
    w.history.pushState({ a: 1 }, '', '/a');
    w.history.pushState({ b: 1 }, '', '/b');
    w.history.back();
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom traverses synchronously
      expect(w.location.pathname).toBe('/b');
      expect(w.history.state).toEqual({ b: 1 });
      await tick();
      expect(w.location.pathname).toBe('/b');
      expect(log).toEqual([]);
      await tick();
    }
    expect(w.location.pathname).toBe('/a');
    expect(log).toEqual([['popstate', { a: 1 }, '/a']]);
  });

  it('the popstate event: PopStateEvent at the window, trusted, neither bubbling nor cancelable, onpopstate too', async () => {
    const seen = [];
    w.onpopstate = (e) => seen.push(e);
    w.history.pushState(1, '', '/a');
    w.history.back();
    await settle();
    expect(seen.length).toBe(1);
    const e = seen[0];
    expect(e).toBeInstanceOf(w.PopStateEvent);
    expect(e.type).toBe('popstate');
    expect(e.target).toBe(w);
    expect(e.bubbles).toBe(false);
    expect(e.cancelable).toBe(false);
    expect(e.state).toBe(null);
    if (kind !== 'happy-dom') expect(e.isTrusted).toBe(true); // PINNED to jsdom: happy-dom leaves isTrusted undefined
  });

  it('out-of-range deltas and go(0) do nothing; deltas convert like a WebIDL long', async () => {
    w.history.pushState(1, '', '/a');
    w.history.pushState(2, '', '/b');
    w.history.go(-5);
    w.history.go(3);
    w.history.forward();
    w.history.go(0);
    w.history.go();
    await settle();
    expect(w.location.pathname).toBe('/b');
    expect(log).toEqual([]);
    w.history.go(-1.7);
    await settle();
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom ignores a non-integer delta and a string one
      expect(w.location.pathname).toBe('/a');
      w.history.go('-1');
      await settle();
      expect(w.location.pathname).toBe('/');
    }
  });

  it('two back() calls in the same turn both pick the same entry (jsdom), so only one popstate fires', async () => {
    w.history.pushState(1, '', '/a');
    w.history.pushState(2, '', '/b');
    w.history.pushState(3, '', '/c');
    w.history.back();
    w.history.back();
    await settle();
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom applies each back() at once
      expect(w.location.pathname).toBe('/b');
      expect(log).toEqual([['popstate', 2, '/b']]);
    }
  });

  it('pushState cancels a queued traversal; replaceState does not', async () => {
    w.history.pushState(1, '', '/a');
    w.history.back();
    w.history.pushState(2, '', '/b');
    await settle();
    expect(w.location.pathname).toBe('/b');
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom went back before the push, which then dropped /a
      expect(w.history.length).toBe(3);
      expect(log).toEqual([]);
    }

    // cancelled after the first task too
    w.history.back();
    await tick();
    w.history.pushState(3, '', '/c');
    await settle();
    expect(w.location.pathname).toBe('/c');

    log.length = 0;
    w.history.back();
    w.history.replaceState('r', '', '/r');
    await settle();
    if (kind !== 'happy-dom') {
      // PINNED to jsdom
      expect(w.location.pathname).toBe('/b');
      expect(log).toEqual([['popstate', 2, '/b']]);
    }
  });

  it('pushState after going back drops the forward entries', async () => {
    w.history.pushState(1, '', '/a');
    w.history.pushState(2, '', '/b');
    w.history.back();
    await settle();
    w.history.pushState(3, '', '/c');
    expect(w.history.length).toBe(3);
    w.history.forward();
    await settle();
    expect(w.location.pathname).toBe('/c');
    w.history.back();
    await settle();
    expect(w.location.pathname).toBe('/a');
    expect(w.history.state).toBe(1);
  });

  it('a replaced entry is traversed to with its new URL and state', async () => {
    w.history.replaceState({ r: 0 }, '', '/start');
    w.history.pushState(1, '', '/a');
    w.history.back();
    await settle();
    expect(w.location.pathname).toBe('/start');
    expect(w.history.state).toEqual({ r: 0 });
    expect(log).toEqual([['popstate', { r: 0 }, '/start']]);
  });

  it('traversing between entries whose fragments differ fires popstate, then hashchange', async () => {
    w.history.pushState(1, '', '/a#one');
    w.history.pushState(2, '', '/a#two');
    w.history.back();
    await settle();
    expect(w.location.href).toBe('http://localhost:3000/a#one');
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom fires no hashchange on traversal
      expect(log).toEqual([
        ['popstate', 1, '/a#one'],
        ['hashchange', 'http://localhost:3000/a#two', 'http://localhost:3000/a#one'],
      ]);
    }
  });

  it('a fragment navigation adds an entry and fires popstate + hashchange in one queued task', async () => {
    w.location.hash = '#x';
    expect(w.history.length).toBe(2);
    expect(w.location.href).toBe('http://localhost:3000/#x');
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: happy-dom fires no popstate for a fragment navigation and queues hashchange later
      expect(log).toEqual([]);
      await tick();
      // DIVERGENCE (spec): the state of a fragment navigation's entry is null; jsdom leaves it undefined
      const state = kind === 'jsdom' ? undefined : null;
      expect(w.history.state).toBe(state);
      expect(log).toEqual([
        ['popstate', state, '/#x'],
        ['hashchange', 'http://localhost:3000/', 'http://localhost:3000/#x'],
      ]);
    }
    w.location.hash = '#y';
    await settle();
    expect(w.history.length).toBe(3);
    log.length = 0;
    w.history.back();
    await settle();
    expect(w.location.hash).toBe('#x');
    w.history.go(-1);
    await settle();
    expect(w.location.href).toBe('http://localhost:3000/');
    w.history.forward();
    await settle();
    expect(w.location.hash).toBe('#x');
    if (kind !== 'happy-dom') {
      const state = kind === 'jsdom' ? undefined : null;
      expect(log).toEqual([
        ['popstate', state, '/#x'],
        ['hashchange', 'http://localhost:3000/#y', 'http://localhost:3000/#x'],
        ['popstate', null, '/'],
        ['hashchange', 'http://localhost:3000/#x', 'http://localhost:3000/'],
        ['popstate', state, '/#x'],
        ['hashchange', 'http://localhost:3000/', 'http://localhost:3000/#x'],
      ]);
    }
  });

  it('location.replace with a fragment replaces the current entry', async () => {
    w.history.pushState(1, '', '/a');
    w.location.replace('#r');
    expect(w.location.href).toBe('http://localhost:3000/a#r');
    if (kind !== 'happy-dom') expect(w.history.length).toBe(2); // PINNED to jsdom: happy-dom adds an entry
    await settle();
    w.history.back();
    await settle();
    if (kind !== 'happy-dom') expect(w.location.href).toBe('http://localhost:3000/');
  });

  it('a pushState right after a fragment navigation does not cancel its events', async () => {
    w.location.hash = '#x';
    w.history.pushState(1, '', '/z');
    await settle();
    expect(w.location.pathname).toBe('/z');
    expect(w.history.length).toBe(3);
    expect(w.history.state).toBe(1);
    if (kind !== 'happy-dom') {
      // PINNED to jsdom: the events carry the fragment navigation's values
      expect(log).toEqual([
        ['popstate', kind === 'jsdom' ? undefined : null, '/z'],
        ['hashchange', 'http://localhost:3000/', 'http://localhost:3000/#x'],
      ]);
    }
  });

  it('replaceState with an empty URL keeps the current one, fragment included', () => {
    w.location.hash = '#keep';
    w.history.replaceState(1, '', '');
    expect(w.location.href).toBe('http://localhost:3000/#keep');
  });
});
