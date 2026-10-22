'use strict';
// HTMLMediaElement's non-reflected members (ROADMAP Stage 3 `core`, DESIGN §41), ported from
// refs/jsdom/lib/jsdom/living/nodes/HTMLMediaElement-impl.js and its generated wrapper: jsdom plays nothing, so
// the state is a handful of values per element (facade-only, a WeakMap), `play()` / `pause()` / `load()` report
// "not implemented" on the virtual console, and `volume` / `muted` / `playbackRate` changes queue `volumechange`
// / `ratechange` as tasks. The reflected attributes (`src`, `preload`, `autoplay`, ...) come from reflection.cjs.

const rt = require('./runtime.cjs');
const events = require('./events.cjs');

/** element -> its media state (created on first use) */
const STATE = new WeakMap();

/** jsdom's getTimeRangeDummy(): one object per element and attribute. */
function timeRanges() {
  return {
    length: 0,
    start() {
      return 0;
    },
    end() {
      return 0;
    },
  };
}

function stateOf(el, what) {
  if (!(el instanceof rt.classes.HTMLMediaElement)) {
    throw new TypeError(`'${what}' called on an object that is not a valid instance of HTMLMediaElement.`);
  }
  let s = STATE.get(el);
  if (s === undefined) {
    s = {
      muted: false, volume: 1, rate: 1, defaultRate: 1, currentTime: 0,
      buffered: timeRanges(), played: timeRanges(), seekable: timeRanges(),
      audioTracks: [], videoTracks: [], textTracks: [],
    };
    STATE.set(el, s);
  }
  return s;
}

/** WebIDL `double` (finite). */
function dbl(v, prop) {
  if (typeof v === 'bigint') throw new TypeError(`Failed to set the '${prop}' property on 'HTMLMediaElement': The provided value is a BigInt which cannot be converted to a number.`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`Failed to set the '${prop}' property on 'HTMLMediaElement': The provided value is not a finite floating-point value.`);
  return n;
}

/** jsdom's notImplementedMethod: a "not-implemented" jsdomError on the window's virtual console. */
function notImplemented(el, method) {
  const vc = el.ownerDocument?._ctx?.settings?.virtualConsole;
  if (vc) {
    const error = new Error(`Not implemented: HTMLMediaElement's ${method}() method`);
    error.type = 'not-implemented';
    vc.emit('jsdomError', error);
  }
}

/** HTML "queue a media element task" to fire `type` (jsdom: `_queueATask`, so never synchronously). */
function queueEvent(el, type) {
  const ctx = el.ownerDocument?._ctx;
  if (ctx === undefined || ctx === null || ctx.closed) return;
  ctx.queueTask(() => events.fire(el, type));
}

const TEXT_TRACK_KINDS = new Set(['subtitles', 'captions', 'descriptions', 'chapters', 'metadata']);

const members = {
  load() {
    stateOf(this, 'load');
    notImplemented(this, 'load');
  },
  canPlayType(type) {
    stateOf(this, 'canPlayType');
    if (arguments.length < 1) throw new TypeError("Failed to execute 'canPlayType' on 'HTMLMediaElement': 1 argument required, but only 0 present.");
    void `${type}`; // DOMString conversion: a Symbol throws
    return '';
  },
  play() {
    try {
      stateOf(this, 'play');
    } catch (e) {
      return Promise.reject(e);
    }
    notImplemented(this, 'play');
    return undefined;
  },
  pause() {
    stateOf(this, 'pause');
    notImplemented(this, 'pause');
  },
  addTextTrack(kind, label = undefined, language = undefined) {
    stateOf(this, 'addTextTrack');
    if (arguments.length < 1) throw new TypeError("Failed to execute 'addTextTrack' on 'HTMLMediaElement': 1 argument required, but only 0 present.");
    const k = `${kind}`;
    if (!TEXT_TRACK_KINDS.has(k)) {
      throw new TypeError(`Failed to execute 'addTextTrack' on 'HTMLMediaElement': parameter 1 '${k}' is not a valid enumeration value for TextTrackKind`);
    }
    if (label !== undefined) void `${label}`;
    if (language !== undefined) void `${language}`;
    notImplemented(this, 'addTextTrack');
  },
  get currentSrc() {
    stateOf(this, 'get currentSrc');
    return '';
  },
  get networkState() {
    stateOf(this, 'get networkState');
    return 0;
  },
  get buffered() {
    return stateOf(this, 'get buffered').buffered;
  },
  get readyState() {
    stateOf(this, 'get readyState');
    return 0;
  },
  get seeking() {
    stateOf(this, 'get seeking');
    return false;
  },
  get currentTime() {
    return stateOf(this, 'get currentTime').currentTime;
  },
  set currentTime(v) {
    stateOf(this, 'set currentTime').currentTime = dbl(v, 'currentTime');
  },
  get duration() {
    stateOf(this, 'get duration');
    return NaN;
  },
  get paused() {
    stateOf(this, 'get paused');
    return true;
  },
  get defaultPlaybackRate() {
    return stateOf(this, 'get defaultPlaybackRate').defaultRate;
  },
  set defaultPlaybackRate(v) {
    const s = stateOf(this, 'set defaultPlaybackRate');
    const n = dbl(v, 'defaultPlaybackRate');
    if (n === 0) throw new rt.classes.DOMException('The operation is not supported.', 'NotSupportedError');
    if (n !== s.defaultRate) {
      s.defaultRate = n;
      queueEvent(this, 'ratechange');
    }
  },
  get playbackRate() {
    return stateOf(this, 'get playbackRate').rate;
  },
  set playbackRate(v) {
    const s = stateOf(this, 'set playbackRate');
    const n = dbl(v, 'playbackRate');
    if (n !== s.rate) {
      s.rate = n;
      queueEvent(this, 'ratechange');
    }
  },
  get played() {
    return stateOf(this, 'get played').played;
  },
  get seekable() {
    return stateOf(this, 'get seekable').seekable;
  },
  get ended() {
    stateOf(this, 'get ended');
    return false;
  },
  get volume() {
    return stateOf(this, 'get volume').volume;
  },
  set volume(v) {
    const s = stateOf(this, 'set volume');
    const n = dbl(v, 'volume');
    if (n < 0 || n > 1) throw new rt.classes.DOMException('The index is not in the allowed range.', 'IndexSizeError');
    if (n !== s.volume) {
      s.volume = n;
      queueEvent(this, 'volumechange');
    }
  },
  get muted() {
    return stateOf(this, 'get muted').muted;
  },
  set muted(v) {
    const s = stateOf(this, 'set muted');
    const b = !!v;
    if (b !== s.muted) {
      s.muted = b;
      queueEvent(this, 'volumechange');
    }
  },
  get audioTracks() {
    return stateOf(this, 'get audioTracks').audioTracks;
  },
  get videoTracks() {
    return stateOf(this, 'get videoTracks').videoTracks;
  },
  get textTracks() {
    return stateOf(this, 'get textTracks').textTracks;
  },
};

const CONSTANTS = {
  NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3,
  HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4,
};

function install() {
  const C = rt.classes.HTMLMediaElement;
  if (C === undefined) return;
  for (const key of Object.keys(members)) {
    // an accessor or method another area already defines wins (none today)
    if (Object.hasOwn(C.prototype, key)) continue;
    const d = Object.getOwnPropertyDescriptor(members, key);
    if ('value' in d) d.writable = true;
    d.enumerable = false;
    d.configurable = true;
    Object.defineProperty(C.prototype, key, d);
  }
  for (const [k, v] of Object.entries(CONSTANTS)) {
    Object.defineProperty(C, k, { value: v, enumerable: true });
    Object.defineProperty(C.prototype, k, { value: v, enumerable: true });
  }
}

module.exports = { install };
