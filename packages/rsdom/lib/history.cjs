'use strict';
// Session history (DESIGN §23): the entry list of one browsing context and its traversal, a port of
// refs/jsdom/lib/jsdom/living/window/SessionHistory.js with jsdom's observable timing:
// - `back()` / `forward()` / `go(delta)` queue a task that picks the target entry (out of range: nothing), which
//   queues a second task that traverses: the URL, `history.state`, then `popstate` and `hashchange`, synchronously;
// - `pushState()` and fragment navigations cancel traversals still queued; `replaceState()` does not;
// - a fragment navigation adds an entry and fires `popstate` + `hashchange` in one queued task, and cannot be
//   cancelled (only `close()` cancels it).
// Tasks are `ctx.queueTask` (setImmediate on Node's timer, cancelled by `ctx.close()`). Facade state only: one
// instance per context, created with its window (lib/window.cjs).

const rt = require('./runtime.cjs');
const events = require('./events.cjs');

/** @typedef {{ url: URL, state: any }} Entry */

class SessionHistory {
  /** @type {Entry[]} */
  #entries;
  #index = 0;
  /** the entry whose state was last made the document's (jsdom's `document._latestEntry`); popstate fires when this changes */
  #latest = null;
  /** handles of queued traversal tasks (jsdom's history traversal task source), cancelled by `clearTraversals()` */
  #traversals = new Set();

  constructor(ctx) {
    this.ctx = ctx;
    this.#entries = [{ url: ctx.url, state: null }];
    /** `history.state`: the state of the current entry when it was last made current */
    this.state = null;
  }

  get length() {
    return this.#entries.length;
  }

  /** pushState: drops the entries after the current one and adds a new current entry. */
  push(url, state) {
    this.clearTraversals();
    this.#entries.splice(this.#index + 1);
    const entry = { url, state };
    this.#entries.push(entry);
    this.#index++;
    this.#latest = entry;
    this.state = state;
    this.ctx.setURL(url);
  }

  /** replaceState: rewrites the current entry. */
  replace(url, state) {
    const entry = this.#entries[this.#index];
    entry.url = url;
    entry.state = state;
    this.#latest = entry;
    this.state = state;
    this.ctx.setURL(url);
  }

  /**
   * Navigation to a fragment of the current document (refs/jsdom/lib/jsdom/living/window/navigation.js
   * navigateToFragment): a new entry after the current one (`replacement`: in place of it, as `location.replace`),
   * made current now, its events fired by a queued task.
   */
  navigateToFragment(url, replacement) {
    this.clearTraversals();
    if (!replacement) this.#entries.splice(this.#index + 1);
    const entry = { url, state: null };
    this.#entries.splice(this.#index + 1, 0, entry);
    this.#traverse(entry, true, replacement);
  }

  /** history.go(delta), delta != 0 (traverse the history by a delta). */
  traverseByDelta(delta) {
    this.#queueTraversal(() => {
      const target = this.#entries[this.#index + delta];
      if (target === undefined) return;
      this.#queueTraversal(() => this.#traverse(target, false, false));
    });
  }

  clearTraversals() {
    for (const t of this.#traversals) this.ctx.cancelTask(t);
    this.#traversals.clear();
  }

  #queueTraversal(fn) {
    const traversals = this.#traversals;
    const t = this.ctx.queueTask(() => {
      traversals.delete(t);
      fn();
    });
    traversals.add(t);
  }

  /** Traverse the history to `entry` (same document); `queueEvents`: fire the events from a task. */
  #traverse(entry, queueEvents, replacement) {
    const ctx = this.ctx;
    const current = this.#entries[this.#index];
    const oldURL = current.url.href;
    const hashChanged = entry.url.hash !== current.url.hash;
    ctx.setURL(entry.url);
    if (replacement) this.#entries.splice(this.#entries.indexOf(entry) - 1, 1);
    this.#index = this.#entries.indexOf(entry);
    const state = entry.state;
    this.state = state;
    const stateChanged = this.#latest !== entry;
    this.#latest = entry;
    const newURL = entry.url.href;
    const fireEvents = () => {
      if (stateChanged) events.fire(ctx.wt, 'popstate', { state }, rt.classes.PopStateEvent);
      if (hashChanged) events.fire(ctx.wt, 'hashchange', { oldURL, newURL }, rt.classes.HashChangeEvent);
    };
    if (queueEvents) ctx.queueTask(fireEvents);
    else fireEvents();
  }
}

module.exports = { SessionHistory };
