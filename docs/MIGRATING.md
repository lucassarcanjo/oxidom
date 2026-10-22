# Migrating from jsdom to rsdom

rsdom's npm name is `jetdom`. This guide covers moving a test suite from jsdom to rsdom: the configuration
change for each runner, what carries over unchanged, and every known way rsdom behaves differently from jsdom
30.1.3, which is the oracle rsdom is measured against.

Most suites need only the configuration change. Read [the divergences](#known-divergences) if a test fails after
the switch, or before you switch if your suite relies on scripts, custom elements or iframes, which rsdom
does not support yet.

Where things stand (2026-10-22): rsdom passes 97.3% of the subtests jsdom passes in jsdom's own test suite
([scoreboard](../conformance/parity/results/summary.md)), 19 of 20 real libraries against jsdom's 18
([libraries](../e2e/libraries/results/summary.md); lit is the one that fails, for lack of custom elements), and the
React 19 + Testing Library app suite at 90 of 90.

None of the packages is on npm yet: install `jetdom` and the environment packages from this repository
(`packages/rsdom`, `packages/vitest-environment-rsdom`, `packages/jest-environment-rsdom`; README "Usage").

## Contents

1. [Vitest](#vitest)
2. [Jest](#jest)
3. [The `JSDOM` API in plain Node](#the-jsdom-api-in-plain-node)
4. [TypeScript](#typescript)
5. [Test setup files](#test-setup-files)
6. [Known divergences](#known-divergences)

## Vitest

Install `jetdom` and `vitest-environment-jetdom` (Vitest 5 or later, Node 22 or later), then change one word:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jetdom', // was: 'jsdom'
  },
})
```

Per file, `// @vitest-environment jetdom` replaces `// @vitest-environment jsdom`.

**Options.** `test.environmentOptions.jsdom` is read the way Vitest's jsdom environment reads it, with the same
defaults (`url` `http://localhost:3000`, `pretendToBeVisual: true`):

| `environmentOptions.jsdom` key | on rsdom |
|---|---|
| `url`, `referrer`, `contentType` (`text/html`), `userAgent`, `pretendToBeVisual`, `storageQuota` | as on jsdom |
| `html` | as on jsdom, except that its `<script>`s do not run |
| `console` | as on Vitest's jsdom environment: the window always has a virtual console forwarding to the test's `console` |
| `resources: 'usable'`, `runScripts`, `includeNodeLocations`, `cookieJar`, `beforeParse` | ignored |

rsdom's own options go in `test.environmentOptions.jetdom` (`url`, and `html` as body markup) and win over the
`jsdom` ones.

**The `jsdom` global** is there, as under Vitest's jsdom environment: `jsdom.reconfigure({ url })`,
`jsdom.serialize()`, `jsdom.window`.

**Pools.** The default `forks` and `threads` pools install the window on the worker's global (as the jsdom
environment does). `pool: 'vmThreads'` and `pool: 'vmForks'` run each file in a vm context with the window as its
global, through the environment's `setupVM`, as jsdom's does.

**Not-implemented methods** (`alert()`, `window.scrollTo()`, ...) log "Not implemented: ..." through
`console.error`, as on jsdom. An uncaught error that an `error` listener saw but did not cancel is logged there
too, instead of failing the test.

## Jest

Install `jetdom` and `jest-environment-jetdom` (Jest 30), then:

```js
// jest.config.js
module.exports = {
  testEnvironment: 'jetdom', // was: 'jsdom'
};
```

`jest-environment-jetdom` is a port of `jest-environment-jsdom`. `testEnvironmentOptions` (`url`, `html`,
`userAgent`, `pretendToBeVisual`, `customExportConditions`, ...), the `@jest-environment-options` docblock, fake
timers (modern and legacy), `this.dom` in a subclass and `getVmContext()` work the same.

The file runs in a vm context, so objects rsdom creates come from a different realm than the test's own
(see [Realms](#realms)). That is the one class of difference you are likely to hit under Jest that you would not
hit under Vitest's default pools.

## The `JSDOM` API in plain Node

```js
const { JSDOM, VirtualConsole } = require('jetdom'); // was: require('jsdom')

const dom = new JSDOM('<!DOCTYPE html><p>Hello</p>', { url: 'https://example.test/', pretendToBeVisual: true });
dom.window.document.querySelector('p').textContent; // 'Hello'
```

Supported: the options `url`, `referrer`, `contentType` (HTML and XML types), `pretendToBeVisual`, `storageQuota`,
`virtualConsole`, `beforeParse` and `resources.userAgent`; the members `window`, `virtualConsole`, `cookieJar`,
`serialize()` and `reconfigure()`; and `JSDOM.fragment()`, `JSDOM.fromFile()` and `JSDOM.fromURL()`. `VirtualConsole`
(`forwardTo`, `"jsdomError"` events) and `CookieJar` (tough-cookie's, as jsdom exports it) are exported too.

Not supported: `runScripts` (validated, then ignored), `includeNodeLocations`,
`nodeLocation()`, `getInternalVMContext()`, subresource loading, `requestInterceptor`, and a cookie jar behind
`document.cookie`. rsdom also has a lighter entry point, `createWindow({ url })`, which returns `{ window, document }` without
the `JSDOM` wrapper.

Several `JSDOM` instances in one thread share their interface objects (see [Setup and API](#setup-and-api)).

## TypeScript

The packages ship their declarations. `jetdom`'s `JSDOM` API is typed as `@types/jsdom` types jsdom's, so
replacing `import { JSDOM } from 'jsdom'` with `from 'jetdom'` type-checks unchanged. For the Vitest `jsdom`
global, put `"jetdom/vitest-globals"` in `compilerOptions.types` where you had `"vitest/jsdom"`.

## Test setup files

Setups written for jsdom shim what jsdom lacks. rsdom has some of those APIs, so a shim guarded by "only if
missing" now gets rsdom's version instead:

| API | jsdom | rsdom | what to do |
|---|---|---|---|
| `matchMedia` | absent | present, `matches` always `false` | assign your mock unconditionally if a test needs `matches: true` |
| `ResizeObserver`, `IntersectionObserver` | absent | present, callbacks never fire | assign your mock unconditionally if a test needs a callback |
| `elementFromPoint`, `elementsFromPoint` | absent | present, return `null` / `[]` | assign unconditionally if a test needs a hit |
| `Range#getBoundingClientRect`, `getClientRects` | absent | present, zero rects | nothing; ProseMirror, tiptap and Lexical work without the shim |
| `scrollIntoView`, element `scrollTo` / `scrollBy`, pointer capture | absent | present (no-ops or stored) | nothing |
| `<dialog>` `showModal` / `close` | absent | present | nothing |
| `InputEvent#getTargetRanges` | absent | present | nothing; editors take their `beforeinput` path |
| `customElements`, canvas `getContext` | present | absent | keep a polyfill, or wait for the roadmap items |

Shims that assign unconditionally (`window.ResizeObserver = MockResizeObserver`) keep working: rsdom's built-ins
are ordinary writable properties.

## Known divergences

Each entry is tagged:

- **[gap]**: rsdom lacks something jsdom has, or does worse. Most have a roadmap item.
- **[spec]**: rsdom follows the spec or browsers where jsdom does not. These stay.
- **[design]**: a structural difference (realm, identity, lifetime) that is neither.
- **[beyond]**: an API rsdom has and jsdom lacks; feature detection takes a different path.

Each entry also says where it is recorded: `DESIGN §N` is [`DESIGN.md`](DESIGN.md), item ids in backticks are
roadmap items with a row on the [scoreboard](../conformance/parity/results/summary.md).

### Setup and API

- **[gap] No script execution.** `<script>` elements never run, whether parsed, inserted or in `html` options,
  and `runScripts` is ignored. Vitest's jsdom environment and jest-environment-jsdom run them by default
  (`runScripts: 'dangerously'`). Inline handler attributes (`onclick="..."`) do not run either; `el.onclick = fn`
  does. DESIGN §10, §28; `browsing-contexts`.
- **[gap] No iframes.** An `<iframe>` has no nested browsing context: `contentWindow` and `contentDocument` are
  undefined, and so are `window.frames` indexing and `window.length`. `browsing-contexts` (Stage 4).
- **[gap] User agent.** `navigator.userAgent` ends in `rsdom/0.1.0`, not `jsdom/30.1.3`. Code that looks for
  "jsdom" in it will not match. DESIGN §31.
- **[design] One set of interface objects per thread**, not per `JSDOM` instance: `dom1.window.Node ===
  dom2.window.Node`, so `instanceof` across instances holds where jsdom's fails. DESIGN §31.
- **[design] The newest `JSDOM` is current.** `new Text()`, `new Range()`, `new Image()`, `new Document()` and the
  like create nodes in the most recently opened instance; closing it makes the previous one current. A `new
  JSDOM()` inside a Vitest or Jest test does not take over from the environment's window. DESIGN §18, §31.
- **[design] `window.close()`** on a `JSDOM` window stops its timers and animation frames but keeps listeners.
  `createWindow()` windows and the test environment's window have a no-op `close()`. DESIGN §31.
- **[design] Uncaught errors in plain Node**, with no virtual console and no `uncaughtException` listener, are
  rethrown from a microtask and crash the process like a timer error, instead of vanishing. DESIGN §31.
- **[gap] `JSDOM` at `about:blank` has storage** where jsdom throws `SecurityError`. DESIGN §31.
- **[gap] `document.characterSet` is always `UTF-8`**, even for bytes decoded from another charset (decoding
  itself follows jsdom: BOM, content-type charset, `<meta>` prescan). DESIGN §31.
- **[design] Vitest globals.** `window`, `self`, `top` and `parent` are `globalThis`; Node's timers,
  `queueMicrotask`, `performance`, `console`, `AbortController`, `MessageChannel`, `URL`, `fetch`, `crypto`,
  typed arrays and `DOMException` are Node's own. DESIGN §12.
- **[design] Vitest teardown leaves no `FormData` global.** rsdom's `FormData` is pure JS, as jsdom's is, so
  `fetch` does not treat it as multipart. DESIGN §14.2, §15.2.
- **[design] Jest globals.** Members a jsdom window has are copied from Node (`URL`, `TextEncoder`,
  `AbortController`, `atob`, `performance`, `crypto`, ...); `fetch` and `structuredClone` stay undefined, as
  under jest-environment-jsdom. DESIGN §32.
- **[gap] Missing Window members:** `ElementInternals` and `customElements` (`custom-elements`, Stage 4),
  `webkitURL`, the SVG value types (`SVGRect`, `SVGNumber`, `SVGStringList`, `SVGAnimated*`,
  `SVGPreserveAspectRatio`). `postMessage` delivers to the same window, like jsdom's, without `origin` or `source`. `length` is 0 even
  with iframes (`browsing-contexts`); `status`, `length`, `external` and the bars are data properties (jsdom: replaceable
  accessors), so `status = 5` reads back `5`.
- **[gap] `NamedNodeMap` named properties** (`el.attributes['id']`) are undefined. `core`.
- **[gap] Missing interfaces:** `customElements` (`custom-elements`, Stage 4), canvas `getContext` (jsdom has it and returns `null`; not planned), most SVG DOM types.
- **[gap] XPath iterators and shadow trees:** a change inside a connected shadow tree sets
  `invalidIteratorState` on a document's XPath iterators; jsdom ignores shadow-tree changes there. DESIGN §39.
- **[gap] Brand checks are skipped on hot paths.** `Object.getOwnPropertyDescriptor(Node.prototype,
  'firstChild').get.call({})` returns `null` instead of throwing `TypeError`. CONTRIBUTING §8.
- **[design] Element wrappers have enumerable own fields** (`_ev`, `_i` and others): `Object.keys(div)` is not
  `[]` (jsdom: `[]`). Code that enumerates a node's own keys sees them.
- **[gap] Indexed properties of live lists, `select` and `form` are prototype accessors**, not own properties:
  `Object.keys(childNodes)` is `[]` (jsdom lists the indices) and `i in list` holds for indices past the end.
  Reading, writing, iterating and `Array.from` match jsdom. DESIGN §14.1.
- **[design] Async work leaked past a file's end throws**, in every pool. The environment is reset between
  files; a timer or callback that touches a node from a finished file throws `Illegal invocation` in whatever file
  is running. jsdom quietly mutates the closed window. Clean up timers, or await the work, before the test ends.
  DESIGN §15.1.
- **[beyond] `Blob` and `File` subclass Node's `Blob`**, so `fetch`, `Response`, `URL.createObjectURL` and
  `structuredClone` accept them (jsdom's are refused there). DESIGN §27.

### Realms

These apply under Jest and Vitest's VM pools, where the test file runs in a vm context. Vitest's default pools
share one realm, so they do not apply there.

- **[design] Objects rsdom creates come from Node's realm.** Arrays, typed arrays, promises and errors that
  rsdom returns or throws fail `instanceof Array` and `expect(...).toThrow(TypeError)` in the test's realm. Use
  `Array.isArray`, `toThrow('message')`, or check the error's `name`. DESIGN §32, §33.
- **[design] `DOMException` is Node's** and is not `instanceof Error` in the vm context; abort reasons are such
  DOMExceptions. DESIGN §32.
- **[design] `window instanceof EventTarget` is false** in a vm context. DESIGN §32, §33.
- **[design] Under Jest, `AbortController` / `AbortSignal` are Node's:** a signal is not `instanceof
  EventTarget`, and fake timers do not drive `AbortSignal.timeout()`. DESIGN §32.
- **[design] Blob methods resolve in Node's realm** in VM pools; `FileReader` results and `TextEncoder` output
  are in the window's realm, as on jsdom. DESIGN §32, §33.

### Events

- **[gap] No Shadow DOM event retargeting.** A listener outside a shadow tree sees the original `target`
  inside it, not the host. `document.activeElement` does retarget. happy-dom does not retarget either. DESIGN §22;
  `shadow-dom`.
- **[gap] `isTrusted` is a prototype getter**, not an own unforgeable property. Values match jsdom. DESIGN §28.
- **[beyond] Extra event classes:** `AnimationEvent`, `DragEvent`, `ClipboardEvent`.
- **[gap] A native panic is not transactional:** an internal bug surfaces as a JS `Error` and may leave a
  mutation half-applied. DESIGN §14.2.

### CSS and computed style

- **[gap] CSSOM edges:** `document.styleSheets`, `sheet`, `CSSStyleSheet` and `insertRule` work like jsdom
  (CSS-in-JS "speedy" mode styles elements). `<link rel=stylesheet>` has no `sheet` even with `resources: 'usable'`, `@import` sheets are empty,
  and a `<style>`'s `media` is read when its sheet is first observed rather than at insertion. DESIGN §35.
- **[gap] `calc()` is not reduced** in computed values: `calc(10px + 5px)` stays as written (jsdom: `15px`).
  `computed-values`.
- **[gap] Some colours stay as specified:** `lab()`, `color-mix()`, `color-scheme`. Named colours, hex,
  `transparent`, system colours and `currentcolor` resolve to `rgb()` like jsdom. DESIGN §30.
- **[beyond] `:heading` and `:heading()` match headings** (with `headingoffset` / `headingreset`, and the
  `headingOffset` / `headingReset` properties); jsdom accepts the selectors and matches nothing. DESIGN §30.
- **[gap] Specified-value parsing:** rsdom accepts `none` for `column-rule-color` and rounds `1e-8in` to `0in`.
  DESIGN §30.
- **[gap] Computed style is partly live.** `display`, `visibility`, `pointerEvents`, `opacity` and `position`
  of a `getComputedStyle` result are a snapshot, as on jsdom; other properties are read at each access. DESIGN §8.2.
- **[gap] Pseudo-element style** (`getComputedStyle(el, '::before')`) is a stub with `content: 'none'`. DESIGN §8.2.
- **[gap] A computed declaration's `length`** counts longhands only.
- **[gap] No external stylesheets.** `<link rel=stylesheet>` is not fetched, as on jsdom without `resources`.
- **[spec] `display: revert`** computes to the user-agent value (`block` on `<p>`); jsdom returns `revert`.
  DESIGN §14.2.
- **[spec] Changing `<style type>` re-evaluates the sheet.** DESIGN §14.2.
- **[spec] Selectors:** `:empty` ignores empty Text children; `:lang()` honours `xml:lang`, non-ASCII subtags and
  extended ranges; `:dir()` takes any identifier; `::slotted()` and `::part()` parse and never match; a scoped
  `el.querySelectorAll('nav li > a')` matches through ancestors outside `el`, as browsers do (jsdom returns
  nothing). DESIGN §14.2.
- **[beyond] `matchMedia` exists**; `MediaQueryList.matches` is always `false`. DESIGN §12.
- **[beyond] `checkVisibility()`** answers from computed style. DESIGN §24.

### Forms

- **[gap] `ElementInternals`** is missing. `stepUp()` / `stepDown()`, `valueAsNumber`, `valueAsDate`, `<meter>`
  and `<progress>` work like jsdom (DESIGN §36). `forms`.
- **[gap] `document.forms.<name>`** and other named access on HTMLCollection is undefined; use
  `namedItem(name)`. `core`.
- **[gap] `document.open()`, `write()` and `close()` are missing.** `core`.
- **[gap] `:invalid` / `:valid` ignore `pattern`:** `validity.patternMismatch` is right, but
  `matches(':invalid')` is false for a pattern mismatch. `forms`.
- **[gap] `control.labels` and `document.getElementsByName()` return static NodeLists**, a new one on each
  call (jsdom: live, and `labels === labels`). `forms`, `core`.
- **[gap] Option selectedness reset** does not run when an option is removed from inside a non-`optgroup`
  wrapper below the `select`.
- **[beyond] `innerText` exists** (jsdom has none), but it ignores `<br>` and `display: none`.
- **[spec] `select[i] = option` for an option in an `<optgroup>`** replaces it in place, as Chromium does; jsdom
  throws `NotFoundError`. DESIGN §14.1.
- **[beyond] `contentEditable` / `isContentEditable`, `<dialog>` methods, `img.decode()`.**

### Ranges, selection and geometry

  DESIGN §25, §29.
- **[beyond] `Range#getBoundingClientRect` / `getClientRects`** exist and return zero rects. DESIGN §24.
- **[beyond] `elementFromPoint` / `elementsFromPoint`** exist and return `null` / `[]`. DESIGN §24.
- **[beyond] Scrolling:** `scrollIntoView` is a no-op; element `scroll` / `scrollTo` / `scrollBy` set
  `scrollTop` / `scrollLeft` without a `scroll` event; pointer capture is tracked without capture events.
  DESIGN §24.
- **[spec] NodeIterator removal steps** follow the spec where jsdom fails the WPT test. DESIGN §16.

### History and navigation

- **[gap] No navigation to another document.** Following a link or submitting a form is a silent no-op (jsdom
  logs "Not implemented: ..." for each). Fragment navigation, `pushState` and `replaceState` work. DESIGN §23.
- **[gap] No cross-document traversal**, no `beforeunload` / `pagehide`; `scrollRestoration` is only stored.
  DESIGN §23.
- **[spec] Fragment-navigation entries have state `null`** (jsdom: `undefined`). DESIGN §23.
- **[spec] `pushState` / `replaceState` structured-clone the state**, so `history.state !== data`. DESIGN §23.
- **[design] History tasks ignore fake timers** installed after the window loads: `back()`, `popstate` and
  `hashchange` still arrive with `vi.useFakeTimers()`. DESIGN §23.

### Storage and cookies

- **[gap] No `storage` events**; each window has its own storage areas. DESIGN §26.
- **[gap] `document.cookie` ignores `Path`, `Domain`, `Secure` and `SameSite`:** a cookie set with
  `Path=/x` is visible at `/`. There is no cookie jar option. DESIGN §21.

### XMLHttpRequest and fetch

- **[gap] Synchronous XHR is not supported:** `send()` after `open(m, u, false)` throws `NetworkError`.
  DESIGN §21.
- **[gap] `window.stop()` and `window.close()` do not abort in-flight XHRs.** DESIGN §21.
- **[design] XHR runs on Node's `fetch`:** `getAllResponseHeaders()` is lowercased, sorted and combined;
  requests carry `sec-fetch-mode: cors`; an aborted request can hold a keep-alive connection for about 4 s, so call
  `server.closeAllConnections()` before a test server's `close()`. DESIGN §21.
- **[design] Mocking XHR:** msw (2 and 3) and undici's `MockAgent` see XHR traffic, as on jsdom. Spying on
  `globalThis.fetch` after the environment loads, nock and `http.request` hooks do not. DESIGN §21.
- **[spec] jsdom XHR bugs not copied** (stray `progress` after `abort()`, `responseURL` after errors, typed array
  bodies, late `timeout`, `blob:` URLs, ...). DESIGN §21.

### Shadow DOM

- **[gap] No slots, retargeting, scoped styles or declarative shadow DOM:** `attachShadow` and `ShadowRoot`
  work; `assignedNodes()`, `assignedElements()` and `slotchange` do not. DESIGN §22; `shadow-dom`.

### Parsing and serialization

- **[gap] Lone surrogates become U+FFFD**, and a CharacterData offset inside a surrogate pair rounds down to the
  code point's start. Final values match when user-event types an emoji; an intermediate `value` can differ.
  DESIGN §2.3; `surrogates`.
- **[spec] Customizable `<select>`:** html5ever keeps `<div>` inside `<option>` (2025 HTML change); parse5 drops
  it. DESIGN §15.
- **[spec] Serialization:** processing instructions in HTML fragments serialize as `<?x y>`; SVG elements
  serialize their local name; MathML elements are `MathMLElement`.
- **[spec] `compareDocumentPosition` between an element and its `Attr`** returns the spec's answer.

### Timing and memory

- **[beyond] `ResizeObserver` and `IntersectionObserver` exist but never call back** (jsdom has neither).
  DESIGN §24.
- **[design] FileReader tasks ignore fake timers**, and a failed blob read fires `error` with
  `NotReadableError`. DESIGN §27.
- **[spec] FileReader:** a read started in a `load` handler suppresses the old read's `loadend`. DESIGN §27.
- **[spec] MutationObserver** reports mutations in a just-removed subtree (transient observers), and
  `attributeFilter` ignores namespaced attributes. DESIGN §14.2.
- **[design] Memory is reclaimed only between files.** A long single file grows monotonically; unique `id`
  values and class names are interned until the file ends. DESIGN §11.

### Other

- **[spec] `dataset` reads only null-namespace `data-*` attributes.** DESIGN §14.2.
