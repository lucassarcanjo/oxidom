# How react-dom 19 touches the DOM at runtime: requirements for rsdom

Status: research notes, 2026-10-16. Audience: whoever builds the rsdom facade and Vitest environment.

All paths are relative to `refs` unless they start with `/`. Shorthands:

- `RDB/` = `react/packages/react-dom-bindings/src/`
- `RD/` = `react/packages/react-dom/src/`
- `SH/` = `react/packages/shared/`

**Sources.**
- The `refs/react` clone is `main` @ `098d2e87` (2026-10-15), and its `SH/ReactVersion.js` reads `19.3.0`.
- Every runtime claim was checked against the published **react-dom 19.3.1** bundle (`node_modules/react-dom/cjs/react-dom-client.development.js`). The code paths match.
- I also ran a **dynamic trace**: jsdom 30.1.3 with every DOM prototype instrumented, running a realistic RTL 16.3.3 / DTL 10.4.2 / user-event 14.6.8 scenario. Calls are attributed to their caller library. See §14. The scripts are in `rsdom-lab/docs/research/react-dom-trace/`.
- Small "break it on purpose" experiments are in §15.

Feature flags that decide which code paths are live are in `SH/ReactFeatureFlags.js`:

| Flag | Value | Effect |
|---|---|---|
| `disableCommentsAsDOMContainers` | `true` | comment-node containers are dead code |
| `enableCreateEventHandleAPI` | `false` | `beforeblur`/`afterblur`, `createEvent('Event')` and `dispatchBeforeDetachedBlur` are dead |
| `enableMoveBefore` | `false` | `Element.prototype.moveBefore` is never used, only `insertBefore`/`appendChild` |
| `enableViewTransition` | **`true`** | matters for suspensey images, §4.10 |
| `enableScrollEndPolyfill`, `enableSrcObject`, `enableHydrationChangeEvent` | `__EXPERIMENTAL__` | off in stable builds |
| `disableInputAttributeSyncing` | `false` | React syncs `value`/`checked` attributes |
| `enableInternalInstanceMap` | `false` | React stores fibers/props as **expando properties** on DOM nodes |

---

## 0. TL;DR: the 20 things that break React if rsdom gets them wrong

P0 means React crashes, silently misbehaves, or testing-library breaks. Each was confirmed by source reading. Items marked (exp) were also reproduced (§15).

1. **Wrapper identity is stable.** One JS object per Rust node, always.
   - React compares nodes with `===`, for example `firstChild === node.lastChild` in `RDB/client/setTextContent.js`.
   - It stores its fiber and props as expandos on the node object and reads them back from `event.target`. If the event target is a different wrapper object, `getClosestInstanceFromNode` finds nothing and **no React handler ever fires**.
   - Expando keys are `'__reactFiber$'+rand`, `'__reactProps$'+rand`, `__reactContainer$`, `__reactEvents$`, `__reactListeners$`, `__reactHandles$`, `__reactResources$`, `__reactMarker$`, `_reactListening…`, `_valueTracker`, `__reactWarnedAboutChildrenConflict` (`RDB/client/ReactDOMComponentTree.js:43-53`, `RDB/events/DOMPluginEventSystem.js:430`).
   - So the wrapper must be an ordinary extensible JS object.
   - It must stay alive at least while its Rust node is reachable from the document. Otherwise expandos are lost when the wrapper is GC'd and re-created.
2. **Prototype shape for form controls.** `value` and `checked` must be **own accessor properties (getter and setter) of the element's immediate prototype**, with `el.constructor.prototype === Object.getPrototypeOf(el)`. Specifically:
   - `HTMLInputElement.prototype` owns `value` and `checked`.
   - `HTMLTextAreaElement.prototype` owns `value`.
   - `HTMLSelectElement.prototype` owns `value`.

   Three libraries depend on this:
   - React's `RDB/client/inputValueTracking.js:59-75`.
   - DTL's `setNativeValue` (`dom-testing-library/src/events.js:106-123`).
   - user-event's interceptor, which also needs own `selectionStart`/`selectionEnd` accessors and `setSelectionRange`/`setRangeText` methods on that same prototype.

   The instance must **not** have an own `value` property before React tracks it (exp).
3. **`window.event` must be `undefined`, never `null`, when no event is being dispatched.** `resolveUpdatePriority` does `window.event === undefined ? Default : getEventPriority(event.type)` (`RDB/client/ReactDOMUpdatePriority.js:40-44`). A `null` crashes every `setState` (exp).
4. **`'oninput' in document` must be true.** `ChangeEventPlugin` decides this at import time (`RDB/events/plugins/ChangeEventPlugin.js:131-137`, `RDB/events/isEventSupported.js:31`). If it is false, React uses the IE9 `attachEvent('onpropertychange')` polyfill: onChange for text inputs stops firing and TypeErrors are reported (exp). Implement GlobalEventHandlers `on*` accessors on Document, HTMLElement and Window.
5. **`window.getSelection()` must exist** and return an object with `anchorNode`, `anchorOffset`, `focusNode` and `focusOffset`. `SelectEventPlugin` calls it **unguarded** on every keydown/keyup/mouseup while a non-selection-capable text input is focused, such as `type=email|number|date|…` (`RDB/events/plugins/SelectEventPlugin.js:57-77`) (exp).
6. **`window.HTMLIFrameElement` must be a constructor.** On **every commit** React evaluates `element instanceof win.HTMLIFrameElement` (`RDB/client/ReactInputSelection.js:67`). `undefined` throws "Right-hand side of 'instanceof' is not an object" (exp).
7. **`ownerDocument.defaultView` must be the window object**, and in the Vitest env that is `globalThis`. React derives `win` from it and reads `win.document`, `win.HTMLIFrameElement` and `win.getSelection`.
8. **Event dispatch must run real capture, target and bubble phases up to the root container.**
   - React registers **one capture and one bubble listener per event type on the root container**. That is 143 `addEventListener` calls per `createRoot`, and again per portal container (§5.1).
   - Required: `stopPropagation`, `preventDefault`/`defaultPrevented`, the `dispatchEvent` return value, `passive`, `{capture}` options objects, and object-shaped listeners.
9. **`focus()` must fire `blur`, `focusout`, `focus` and `focusin`** (FocusEvent with `relatedTarget`). React's `onFocus` and `onBlur` listen to **`focusin`/`focusout`**, not `focus`/`blur` (`RDB/events/DOMEventProperties.js:143-145`). `document.activeElement` must default to `body`.
10. **Focus fixup on removal.** When the focused element leaves the document, `activeElement` becomes `body`. React's `restoreSelection` then re-focuses moved nodes and writes `selectionStart`/`selectionEnd` (exp).
11. **Click activation behaviour for checkbox and radio.** React fires onChange for these from the **`click`** event, through the value tracker on `checked` (`ChangeEventPlugin.js:231-247`). user-event never sets `.checked` itself; it relies on the DOM toggling it during click dispatch (legacy pre-activation, with revert on `preventDefault`). Radio groups must uncheck their siblings.
12. **Form-control state semantics.**
    - Dirty-value and dirty-checkedness flags.
    - `defaultValue` ⇄ `value` attribute, `defaultChecked` ⇄ `checked` attribute.
    - Textarea `defaultValue` ⇄ child text.
    - `select.options` (HTMLOptionsCollection), `option.value`/`.selected`/`.defaultSelected`/`.disabled`, `select.multiple`/`.size`, and `input.type` normalisation.
    - React writes these in very specific orders (§6).
13. **`textContent` and `nodeValue` setters, an `innerHTML` setter that runs a real HTML fragment parser** (for `dangerouslySetInnerHTML`, and `<script>` creation via `div.innerHTML`), and `createElementNS` for SVG and MathML (§4).
14. **HTML-vs-SVG attribute case rules.** `setAttribute` lowercases names on HTML elements in HTML documents and preserves case on SVG (`viewBox`). `setAttributeNS(xlinkNS,'xlink:href')` and `removeAttribute('xlink:href')`.
15. **`CSSStyleDeclaration`.**
    - Assignment to camelCase properties (`style.marginTop = '2px'`, `style.WebkitTransform`).
    - `setProperty(name, value, priority)` for custom properties and `display:none !important`.
    - `cssFloat`, and tolerance of unknown names. React sets `style[anyCamelName]` directly (`RDB/client/CSSPropertyOperations.js:61-98`).
16. **Error reporting.** React reports errors thrown inside event handlers with `reportError` if it exists, otherwise `new window.ErrorEvent('error',{error,message,…})` plus `window.dispatchEvent` (`SH/reportGlobalError.js`). jsdom has no `reportError`, so the ErrorEvent path is the one Vitest's jsdom env catches. If neither exists, React calls `process.emit('uncaughtException')`.
17. **`Object.prototype.toString.call(el)` must not be `'[object HTMLUnknownElement]'` for known tags.** In DEV React logs "The tag <div> is unrecognized in this browser" for every such element (`RDB/client/ReactFiberConfigDOM.js:640-651`) (exp).
18. **The global `document` must exist before `react-dom` is imported.** Several things are captured at module-evaluation time: `globalDocument`, `canUseDOM`, `isInputEventSupported`, the passive-listener probe, vendor-prefix detection, composition-event detection, `requestAnimationFrame`, `queueMicrotask` and `setTimeout` (§3).
19. **Don't make `img.decode()` return a pending promise.** With `enableViewTransition` on, React 19 waits for `<img src>` (no `onLoad`, not lazy) on transition and retry commits. It calls `img.decode().then(ping)` when `typeof decode === 'function'` and holds the commit for up to **800 ms** (`ReactFiberConfigDOM.js:6614-6640, 6750-6800`).
    - jsdom has no `decode`. happy-dom resolves immediately.
    - Either is fine. A never-resolving decode is not.
20. **Hot-path cost.** Of about 1,940 DOM touches react-dom made in the traced scenario, about 85% are constant-per-node or JS-only reads:
    - `nodeType`, `nodeName`, `ownerDocument`, `defaultView`.
    - `event.*` reads.
    - `addEventListener`.

    These must **not** cross N-API (§14, §16). The event system, listener storage and Event objects should live in JS.

---

## 1. Entry points and globals used before any DOM call

| Where | What | Why it matters |
|---|---|---|
| `SH/ExecutionEnvironment.js` | `canUseDOM = typeof window !== 'undefined' && window.document && window.document.createElement` | Gates every load-time detection below. Must be true at import. |
| `RD/client/ReactDOMClient.js:57-79` (DEV) | `window.top === window.self`, `navigator.userAgent.indexOf('Chrome'/'Firefox'/'Edge')`, `window.location.protocol` | Only prints a DevTools banner. Keep the UA free of "Chrome"/"Firefox" (jsdom: `…jsdom/30.1.3`; happy-dom: `…HappyDOM/21.0.3`) to avoid `console.info` noise. |
| `RD/client/ReactDOMRoot.js:171-260` | `createRoot(container)`: `isValidContainer`, `markContainerAsRoot` (expando), `listenToAllSupportedEvents(container)` | See §5. |
| `RDB/client/ReactDOMContainer.js` | `node.nodeType ∈ {1, 9, 11}` (8 only for the disabled comment container) | Containers may be Element, Document or DocumentFragment. |
| `RDB/client/ReactFiberConfigDOM.js:303-365` | `getOwnerDocumentFromRootContainer`: `nodeType === 9 ? node : node.ownerDocument`. `getRootHostContext`: `container.namespaceURI`, `container.tagName`, `documentElement.namespaceURI` | HTML elements need `namespaceURI === 'http://www.w3.org/1999/xhtml'`. `tagName` must be a string, because DEV lowercases it. |

`react-dom/client` is the module RTL imports. The `react-dom` index (`flushSync`, `createPortal`, `preload*`) has no DOM access of its own except the resource dispatcher (§4.9).

---

## 2. Facade-level invariants the whole renderer assumes

- **Identity.** One wrapper per node (see TL;DR 1). Other identity checks besides `firstChild === node.lastChild`:
  - `otherNode === rootNode` in the radio restore (`RDB/client/ReactDOMInput.js:399-470`).
  - `activeElement !== getActiveElement(doc)` (`SelectEventPlugin.js:94-104`).
  - `curFocusedElem !== priorFocusedElem` (`ReactInputSelection.js:120-157`).
  - `maybeTargetInst.stateNode !== nativeEventTarget` (`FormActionEventPlugin.js:58-61`).
  - `grandContainer === targetContainer` (`DOMPluginEventSystem.js:577-587`).
- **Expandos.** React writes, reads, and on deletion `delete`s plain string-keyed properties on nodes (`ReactDOMComponentTree.js:71-111, 295-311`). `detachDeletedInstance` does four `delete`s per removed host component. In V8 that usually pushes the object into dictionary mode, which jsdom also pays. Wrappers should be cheap plain JS objects with predictable hidden classes. **No Proxies**: React also reads absent properties such as `target.correspondingUseElement` and `nativeEventTarget.window` on hot paths, and a Proxy `get` trap that crosses into Rust would be ruinous.
- **Prototype chain and `instanceof`.**
  - The only `instanceof` checks against DOM classes in react-dom are `instanceof win.HTMLIFrameElement` (every commit) and, for experimental fragment refs, `AbortSignal` and `AnimationTimeline`.
  - DTL and user-event use `window[EventType]`, `element.constructor.prototype` and `Object.getPrototypeOf(element)`.
  - Recommended: a real JS class hierarchy `EventTarget → Node → Element → HTMLElement → HTMLInputElement …`, with per-interface prototypes owning the right accessors.
- **`Symbol.toStringTag`** per interface. React only checks for `HTMLUnknownElement` (DEV). DTL and pretty-format use `constructor.name`/`toString` for printing.
- **Nothing is read from layout.** Outside experimental features (ViewTransition, Fragment refs, test selectors) react-dom never calls `getBoundingClientRect`, `getComputedStyle`, `offset*` or `client*`. The only layout-ish writes are `scrollLeft`/`scrollTop`, as a no-op round-trip in `restoreSelection`.

---

## 3. Module-evaluation-time feature detection

All of this runs when `react-dom/client` is first imported. In Vitest that happens after the environment's `setup()` populated globals. Anything missing then is baked in for the whole test file.

| Source | Detection | Consequence when absent or wrong |
|---|---|---|
| `RDB/events/checkPassiveEvents.js:16-30` | `window.addEventListener('test', options, options)`, where `options` is an object whose `passive` **getter** sets the flag; then `removeEventListener` | Our `addEventListener` must accept a **non-function object listener** and must **read `options.passive`**. If it never reads `passive`, React registers wheel/touch listeners without `{passive:true}`. Harmless, but it differs from jsdom. |
| `RDB/events/getVendorPrefixedEventName.js:53-66` | `style = document.createElement('div').style`; `'AnimationEvent' in window`, `'TransitionEvent' in window`; then for each of `animationend`/`iteration`/`start`/`cancel` and `transitionrun`/`start`/`cancel`/`end`, the first of `'animation' in style`, `'WebkitAnimation' in style`, `'MozAnimation' in style` that holds | **jsdom quirk:** jsdom has no `AnimationEvent` but its style has `WebkitAnimation`, so React listens to **`webkitAnimationEnd`/`webkitAnimationStart`/`webkitAnimationIteration`**, and `fireEvent.animationEnd` never reaches `onAnimationEnd` (verified with `listeners.js`). happy-dom has `AnimationEvent`, so it uses unprefixed names. **Recommendation:** expose `AnimationEvent` and `TransitionEvent`, and make `'animation' in style` and `'transition' in style` true. |
| `RDB/events/plugins/ChangeEventPlugin.js:131-137` + `RDB/events/isEventSupported.js:24-41` | `isEventSupported('input')` checks `'oninput' in document`. Fallback: `div.setAttribute('oninput','return;')` and `typeof div.oninput === 'function'` (needs event-handler content-attribute compilation). Then `!document.documentMode \|\| documentMode > 9` | **P0.** False means the onpropertychange polyfill, so `attachEvent is not a function` and broken onChange (§15). |
| `SelectEventPlugin.js:29-32` | `'documentMode' in document && document.documentMode <= 11` | Do **not** define `documentMode` at all. |
| `RDB/events/plugins/BeforeInputEventPlugin.js:34-54` | `'CompositionEvent' in window`, `'documentMode' in document`, `'TextEvent' in window` | Match jsdom: `CompositionEvent` present, `TextEvent` **absent**. React then derives `onBeforeInput` from `keypress` (`which`/`data`), the path user-event exercises. With `TextEvent` present React expects `textInput` events, which nobody fires in tests. |
| `RDB/client/ReactFiberConfigDOM.js:828-838` | `scheduleTimeout = setTimeout`, `cancelTimeout = clearTimeout`, `localPromise = Promise`, `localRequestAnimationFrame = requestAnimationFrame ?? setTimeout` | Captured once. rAF is only used by `requestPostPaintCallback` (experimental) and view transitions. |
| `ReactFiberConfigDOM.js:866-874` | `scheduleMicrotask = queueMicrotask ?? Promise.then` | Keep Node's `queueMicrotask`. React flushes sync-lane work in a microtask outside `act`. |
| `ReactFiberConfigDOM.js:1022-1027` | `enableMoveBefore && typeof window.Element.prototype.moveBefore === 'function'` | Dead (flag off). |
| `ReactFiberConfigDOM.js:5234` | `globalDocument = typeof document === 'undefined' ? null : document` | Used by `ReactDOM.preload/preinit/prefetchDNS/preconnect` (§4.9). Captured at load. |
| `SH/reportGlobalError.js:10-49` | `typeof reportError === 'function'`, else `window.ErrorEvent`, else `process.emit` | Evaluated at load; it picks an implementation. See §5.6. |
| `RD/client/ReactDOMClient.js:54-79` | DevTools hook and banner | §1. |
| react-dom DEV `supportsUserTiming` (bundle line ~28169) | `typeof console.timeStamp === 'function' && typeof performance.measure === 'function'` | With Node's globals this is **true**, so DEV react-dom calls `performance.measure`/`clearMeasures` and `console.timeStamp` per component render and commit. **Benchmark fairness:** rsdom must not replace `performance` (Vitest's jsdom and happy-dom envs keep Node's), or it skips this cost and "wins" unfairly. |
| `scheduler` 0.28 (`scheduler/cjs/scheduler.development.js:183-232`) | `performance.now`, `setTimeout`, `clearTimeout`, `setImmediate` (preferred in Node), then `MessageChannel`, then `setTimeout` | Keep Node's timers and `setImmediate`. |
| `react` core (`react/cjs/react.development.js:~612, 790, 824`) | `enqueueTask` via `require('timers').setImmediate`, falling back to `MessageChannel`; `reportError`/`window.ErrorEvent`; `queueMicrotask` | Used by `act`. |

---

## 4. Mount, update, unmount: every host-config DOM call

Reconciler → host config mapping, all in `RDB/client/ReactFiberConfigDOM.js` unless noted.

### 4.1 Creating instances (render phase, nodes still detached)

- **`createInstance`** (`:531-661`):
  - Plain HTML: `ownerDocument.createElement(type)`, or `createElement(type, {is})` when `props.is` is a string.
  - SVG/MathML context, or the tags `svg`/`math`: `createElementNS('http://www.w3.org/2000/svg' | 'http://www.w3.org/1998/Math/MathML', type)` (`:555-567`). Child context: `foreignObject` leaves SVG (`:377-399`).
  - `<script>`: `div = createElement('div'); div.innerHTML = '<script></script>'; div.removeChild(div.firstChild)` (`:571-596`). This needs an innerHTML parser that **produces a non-executing script**. The DEV warning `console.error`s on script tags.
  - `<select>`: after creation, `el.multiple = true` or `el.size = props.size` (`:597-616`).
  - DEV: `Object.prototype.toString.call(el) === '[object HTMLUnknownElement]'` (`:640-651`) and `type !== type.toLowerCase()`.
  - Then `precacheFiberNode` sets the `__reactFiber$` expando, and `updateFiberProps` sets the `__reactProps$` expando.
- **`createTextInstance`** (`:753-776`): `ownerDocument.createTextNode(text)` plus the `__reactFiber$` expando.
- **`createHoistableInstance`** (`:461-478`): `<title>`, `<meta>` and similar tags hoisted out of the tree. Calls `createElement`, `setInitialProperties`, and sets the `__reactMarker$` expando.
- **`shouldSetTextContent`** (`:740-751`): string, number or bigint children, `textarea`, `noscript` and `dangerouslySetInnerHTML` do **not** create Text instances. Their text goes through `setTextContent`. Most leaf text in a React tree is therefore set with `textContent`, not `createTextNode`.
- **`appendInitialChild`** (`:691-697`): `parent.appendChild(child)` while both are detached. The whole subtree is built bottom-up off-document and attached with **one** `appendChild` at commit. `ownerDocument` of detached nodes must still be the document.
- **`finalizeInitialChildren`** (`:699-717`) calls `setInitialProperties` (§4.3) and returns `true` for `button`/`input`/`select`/`textarea` with `autoFocus`, and for every `img`. That schedules `commitMount`.

### 4.2 Commit phase

| Host config fn | DOM calls |
|---|---|
| `prepareForCommit` `:421-434` | `getSelectionInformation(container)`, see §7: `ownerDocument.defaultView`, `win.document.activeElement` (or `body`), `instanceof win.HTMLIFrameElement`; if selection-capable then `'selectionStart' in el`, `el.selectionStart`, `el.selectionEnd`. Runs on **every commit**. |
| `clearContainer` `:3947-3964` (called for the HostRoot on first mount) | `container.nodeType`, `container.nodeName`, then `container.textContent = ''`. For HTML/HEAD/BODY or a Document container it uses `clearContainerSparingly`: walks `firstChild`/`nextSibling`/`nodeName`, keeps SCRIPT/STYLE/`LINK[rel=stylesheet]` (`link.rel.toLowerCase()`), and calls `removeChild`. |
| `appendChildToContainer` `:1078-1129` | `container.nodeType` (9 means use `.body`), `container.nodeName === 'HTML'` (means `ownerDocument.body`), `parentNode.appendChild(child)`. Then if `container._reactRootContainer == null && parentNode.onclick === null` it sets `parentNode.onclick = noop` (Mobile Safari trick). So **`onclick` must be a property that defaults to `null`**; `undefined` merely skips the trick. |
| `appendChild` / `insertBefore` / `insertInContainerBefore` `:1028-1170` | `parent.appendChild(child)` and `parent.insertBefore(child, before)`. These also **move** already-attached nodes for keyed reorders, so the "remove from old parent first" semantics are needed, including focus fixup. |
| `removeChild` / `removeChildFromContainer` `:1209-1234` | One `removeChild` per **deleted subtree root**, not per node. Descendant wrappers must stay valid: React's passive cleanup later runs `detachDeletedInstance` on them. |
| `commitUpdate` `:995-1008` | `updateProperties(domElement, type, oldProps, newProps)` (§4.3), then the `__reactProps$` expando. |
| `commitTextUpdate` `:1014-1020` | `textNode.nodeValue = newText`. |
| `resetTextContent` `:1010-1012` | `setTextContent(el, '')`, which is `textContent = ''`. |
| `commitMount` `:887-947` | `autoFocus`: `el.focus()` (`:911`). `img`: re-assigns `img.src = props.src` or `img.srcset = …` to retrigger load. |
| `hideInstance` / `unhideInstance` `:1403-1442` (Suspense fallback, `<Activity mode="hidden">`) | `el.style.setProperty('display','none','important')` (falls back to `style.display` when `setProperty` is missing). Unhide: `el.style.display = props.style.display ?? ''`. Text: `nodeValue = ''` and restore. jest-dom `toBeVisible` then needs computed style to honour `!important` inline display. |
| `resetAfterCommit` `:454-460` | `restoreSelection`, §7: if focus moved during commit and the old element is still in the document (`documentElement.contains(el)`), it calls `setSelection` (writes `selectionStart`/`selectionEnd` with `Math.min(end, el.value.length)`), saves and restores `scrollLeft`/`scrollTop` of every ancestor, and calls `el.focus()`. |
| commit for HostRoot/Portal (reconciler) | `getHoistableRoot(container)` (`:5156-5170`): `container.getRootNode()` and `rootNode.nodeType`. Called about **once per commit** (10 calls in the traced scenario). |
| `detachDeletedInstance` (`ReactDOMComponentTree.js:71-92`) | `delete node['__reactFiber$…']`, `delete node['__reactProps$…']`, plus the listeners and handles keys. JS only. |
| `preparePortalMount` `:841-843` | `listenToAllSupportedEvents(portalContainer)`, another **~142 `addEventListener`s**. |

### 4.3 Props → DOM operations (`RDB/client/ReactDOMComponent.js`)

`setInitialProperties` (`:1095-1484`) does tag-specific work first:

| Tag | Work |
|---|---|
| `img` | Listen to `error` and `load` (non-delegated); set `srcSet` before `src`. |
| `input` (`:1165`) | Listen to `invalid`; collect `name`/`type`/`value`/`defaultValue`/`checked`/`defaultChecked` and call `initInput` (§6). |
| `select` (`:1242`) | Listen to `invalid`; call `initSelect`. |
| `textarea` (`:1286`) | Listen to `invalid`; call `initTextarea`. |
| `option` (`:1339`) | `el.selected = …` |
| `dialog` | Listen to `beforetoggle`, `toggle`, `cancel` and `close`. |
| `iframe`, `object` | Listen to `load`. |
| `video`, `audio` | Listen to 24 media events (`DOMPluginEventSystem.js:206-231`). |
| `details` | Listen to `toggle`. |
| `embed`, `source`, `link` | Listen to `error` and `load`. |
| void elements | Throw on `children` or `dangerouslySetInnerHTML`. |
| custom elements | Use `setPropOnCustomElement`. |

Everything else goes through `setProp` (`:396-984`). That is where all attribute and property writes happen:

| Prop(s) | DOM op |
|---|---|
| `children` (string, number, bigint) | `setTextContent`: if `firstChild && firstChild === lastChild && firstChild.nodeType === 3` then `firstChild.nodeValue = text`, else `el.textContent = text` (`RDB/client/setTextContent.js`). Skipped for `body`, and for `textarea` with `''`. |
| `className` | `setAttribute('class', v)`, or `removeAttribute` for null/boolean/function/symbol (`DOMPropertyOperations.js:138-160`). |
| `tabIndex` | `setAttribute('tabindex', v)` (lowercase, because SVG is case-sensitive). |
| `dir`, `role`, `viewBox`, `width`, `height` | `setAttribute(key, v)`. **`viewBox` must keep its case on SVG elements.** |
| `style` | `setValueForStyles`, see §4.4. |
| `src`, `href`, `action`, `formAction`, `data` (non-object) | `setAttribute(key, sanitizeURL(v))`, which rewrites `javascript:` URLs. `''` on `src` means `removeAttribute` plus a DEV warning. A function `action`/`formAction` sets `"javascript:throw new Error(…)"`. |
| `onClick` | `el.onclick = noop` (`:374-385`, `:609-617`). Needs a writable `onclick` IDL attribute. |
| `onScroll`, `onScrollEnd` | `listenToNonDelegatedEvent('scroll'/'scrollend', el)`, which is `addEventListener` on the element itself. |
| other `on*` | No DOM op (delegated). |
| `dangerouslySetInnerHTML` | `el.innerHTML = __html` when it changed (`:641-666`). |
| `multiple`, `muted` | Property set (`el.multiple = bool`). |
| `contentEditable`, `spellCheck`, `draggable`, `value` (non-input), `autoReverse`, `externalResourcesRequired`, `focusable`, `preserveAlpha` | `setAttribute(key, String(v))` (booleanish strings). |
| `allowFullScreen`, `async`, `autoPlay`, `controls`, `default`, `defer`, `disabled`, `formNoValidate`, `hidden`, `inert`, `loop`, `noModule`, `noValidate`, `open`, `playsInline`, `readOnly`, `required`, `reversed`, `scoped`, `seamless`, `itemScope`, … | `setAttribute(key, '')` or `removeAttribute(key)`. **Note the key is camelCase** (`readOnly`, `noValidate`), so `setAttribute` must ASCII-lowercase on HTML elements. |
| `capture`, `download` | Overloaded boolean. |
| `cols`, `rows`, `size`, `span` | Positive numeric, else `removeAttribute`. `rowSpan`, `start`: numeric. |
| `popover` | `beforetoggle` and `toggle` listeners plus the attribute. |
| `xlinkHref` | `setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', v)` / `removeAttribute('xlink:href')`. Likewise `xlinkActuate`, `xlinkArcrole`, `xlinkRole`, `xlinkShow`, `xlinkTitle`, `xlinkType`, and `xmlBase`/`xmlLang`/`xmlSpace` with the XML namespace. |
| `is` | `setAttribute('is', v)`. |
| `suppressContentEditableWarning`, `suppressHydrationWarning`, `defaultValue`, `defaultChecked`, `innerHTML`, `ref`, `autoFocus`, `innerText`, `textContent` | No-op. |
| everything else | `setAttribute(getAttributeAlias(key), v)` after an `isAttributeNameSafe` regex check. Aliases include `htmlFor→for`, `acceptCharset→accept-charset`, `httpEquiv→http-equiv`, `crossOrigin→crossorigin`, and about 75 SVG camelCase→kebab names (`RDB/shared/getAttributeAlias.js`). `data-*`/`aria-*` keep booleans as `"true"`/`"false"`; other booleans are removed (`DOMPropertyOperations.js:105-136`). |

Custom elements (tag contains `-`, `RDB/shared/isCustomElement.js`) go through `setValueForPropertyOnCustomComponent` (`DOMPropertyOperations.js:187-231`):

- `on*` props become `addEventListener(name.slice(2), fn, useCapture)`, with `removeEventListener` for the previous value.
- Other props: `name in node` decides between a property set (`node[name] = value`) and `setAttribute`.

`updateProperties` (`:1502-2006`) diffs props. Removed props go through `setProp(…, null)`, which ends in `removeAttribute` or a property reset. Changed props go through `setProp(new)`. input, select, textarea and option then call `updateInput`/`updateSelect`/`updateTextarea` (§6). There are no new DOM APIs beyond those above.

`clearSingletonProperties` (`:1486-1500`) and `acquireSingletonInstance` (`ReactFiberConfigDOM.js:4983-5032`) apply when rendering `<html>`, `<head>` or `<body>`. They use `el.attributes` (live NamedNodeMap: `.length`, `[0]`) and `el.removeAttributeNode(attr)` in a loop until empty.

### 4.4 Styles (`RDB/client/CSSPropertyOperations.js:61-153`)

- `const style = node.style`. One read per `setValueForStyles`; cache the object per element.
- Custom property (`--x`): `style.setProperty(name, value)` or `style.setProperty(name, '')`.
- `float`: `style.cssFloat = v`.
- Everything else: `style[camelName] = v` and `style[camelName] = ''` to clear.
  - React appends `'px'` to non-zero numbers unless the property is unitless (`RDB/shared/isUnitlessNumber.js`).
  - It also `trim()`s strings.
  - Names arrive exactly as written in JSX (`WebkitTransform`, `MozOsxFontSmoothing`, `msTransform`).

So `CSSStyleDeclaration` needs the following:

1. Named accessors for every CSS property, in camelCase, Webkit-cased and dashed forms, as cssstyle does. jsdom 30's interface is `CSSStyleProperties`.
2. Unknown names must silently become expandos, as in browsers.
3. `setProperty(name, value, priority)` support.
4. Writes must be reflected in the `style` attribute and in `getComputedStyle` (jest-dom `toHaveStyle`/`toBeVisible`).

A JS Proxy works functionally but is slow. Generate prototype accessors from a property list instead. DEV `Object.freeze`s the style prop object (irrelevant to the DOM).

### 4.5 `dangerouslySetInnerHTML` and parsing

- `el.innerHTML = html` on (usually) detached elements, in any namespace. SVG context parses as SVG fragments.
- DEV hydration diffing additionally does `createElement(tag).innerHTML = html; return .innerHTML` (`ReactDOMComponent.js:324-340`). Hydration only.
- RTL's `asFragment()` uses `document.createRange().createContextualFragment(container.innerHTML)`, falling back to `template.innerHTML` (`react-testing-library/src/pure.js:222-233`). That needs the innerHTML **getter**, which is serialization.

### 4.6 Namespaces and casing

- `tagName`/`nodeName`: uppercase for HTML elements in HTML documents, as-is for SVG/MathML (`foreignObject`). React compares `nodeName` with `'HTML'`, `'HEAD'`, `'BODY'`, `'SCRIPT'`, `'STYLE'`, `'LINK'`, `'INPUT'`, `'VIDEO'`, `'IFRAME'`. Elsewhere it does `nodeName.toLowerCase() === 'input'|'select'|'textarea'`.
- `namespaceURI` is read on root containers and in hoistable caches (`ReactFiberConfigDOM.js:6264-6313`, which excludes SVG `<title>`).

### 4.7 Hoistables: `<title>` and `<meta>` anywhere in the tree (React 19)

`isHostHoistableType` (`:6332-…`) is true for `title` and `meta` outside SVG and without `itemProp`, and for `<link rel=… href=…>` / `<style precedence href>` / `<script async src>`. Such elements are **not** placed where they appear in the tree:

- `mountHoistable` (`:6316-6326`): `ownerDocument.head.insertBefore(instance, type === 'title' ? ownerDocument.querySelector('head > title') : null)`. That needs `document.head` and a `querySelector` with a **child combinator**.
- `unmountHoistable`: `instance.parentNode.removeChild(instance)`.
- Hydration path: `getElementsByTagName(type)`, `getAttribute`, `node.namespaceURI`.

Tests rendering `<title>` (common with React 19 metadata) therefore end up touching `document.head` and selectors.

### 4.8 Singletons: `<html>`, `<head>`, `<body>` rendered by React

`resolveSingletonInstance` (`:4925-4981`) returns `ownerDocument.documentElement`, `.head` or `.body`, and throws if any is missing. A Document must always have html, head and body; RTL also appends to `document.body`. Acquire and release use `attributes` and `removeAttributeNode` (§4.3).

### 4.9 Resources: stylesheets, scripts, `ReactDOM.preload` and friends (P2 for tests)

- Selectors used with `querySelector`/`querySelectorAll` on the Document or ShadowRoot:
  - `link[rel="stylesheet"][data-precedence],style[data-precedence]`
  - `link[data-precedence],style[data-precedence]`
  - `style[data-href~="…"]`
  - `link[rel="stylesheet"][href="…"]`
  - `link[rel="preload"][as="style"][href="…"]`
  - `script[async][src="…"]`
  - `link[rel="modulepreload"]…`
  - (`ReactFiberConfigDOM.js:5239-5620, 5848-5934, 6086-6118, 6917-6985`)
- Values are escaped with `RDB/client/escapeSelectorAttributeValueInsideDoubleQuotes.js`.
- `node.dataset.precedence` (dataset needed).
- `head.appendChild`, `insertBefore(instance, prior.nextSibling)`.
- `link.onload = link.onerror = …`, `addEventListener('load'|'error')`.
- `instance.complete` (img preload), `img.decode()`.
- **Caveat:** `<link rel="stylesheet" precedence>` suspends the commit until its `load` event, or for up to `SUSPENSEY_STYLESHEET_TIMEOUT = 60000` ms (`:6748`). Without resource loading (jsdom's default too) such tests stall. rsdom could fire `load` asynchronously for stylesheet links to be friendlier, which is a deliberate divergence from jsdom.

### 4.10 Suspensey images (live in stable because `enableViewTransition = true`)

- `maySuspendCommit` (`:6509-6520`) is true for `<img src>` without `onLoad` and with `loading !== 'lazy'`.
- On commits whose lanes are all in mask `335544128` (Gesture, Transition, Retry and Idle lanes; bundle line ~17482), `suspendInstance` (`:6614-6640`) runs:
  - If `typeof img.decode === 'function'`, it calls `img.decode().then(ping, ping)`.
  - It reads `img.complete`, `img.width`, `img.height` and global `devicePixelRatio`, plus `estimateBandwidth` (`performance.getEntriesByType('resource')`, `navigator.connection`).
  - `waitForCommitToBeReady` (`:6756-6825`) then holds the commit with `setTimeout(…, 800 or 50)`.

Recommendation: either omit `decode` (jsdom) or resolve immediately (happy-dom), and keep `complete` consistent. A Suspense boundary revealing images (a retry lane) is common in tests.

---

## 5. Event system

### 5.1 Root listener registration (`RDB/events/DOMPluginEventSystem.js:432-459, 461-…`)

`listenToAllSupportedEvents(container)` runs once per root and once per portal container (guarded by the `_reactListening<rand>` expando). For every event in `allNativeEvents` except `selectionchange`:

- `addEventListener(type, listener, true)` (capture) for all events.
- `addEventListener(type, listener, false)` (bubble) unless the event is in `nonDelegatedEvents`: `beforetoggle cancel close invalid load scroll scrollend toggle` plus 24 media events (`:236-245`).
- `touchstart`, `touchmove` and `wheel` get `{capture?, passive: true}` options objects (`:483-489`) when the passive probe succeeded.
- `selectionchange` is registered once per **document** (bubble).

Measured with `docs/lab/research/react-dom-trace/listeners.js` on jsdom:

- **143 `addEventListener` calls per `createRoot`**: 86 capture plus 56 bubble on the container, plus 1 `selectionchange` on the document (first root only). A portal container adds **142** more.
- Full type list on jsdom: `abort auxclick beforetoggle cancel canplay canplaythrough change click close compositionend compositionstart compositionupdate contextmenu copy cut dblclick drag dragend dragenter dragexit dragleave dragover dragstart drop durationchange emptied encrypted ended error focusin focusout fullscreenchange fullscreenerror gotpointercapture input invalid keydown keypress keyup load loadeddata loadedmetadata loadstart lostpointercapture mousedown mousemove mouseout mouseover mouseup paste pause play playing pointercancel pointerdown pointermove pointerout pointerover pointerup progress ratechange reset resize scroll scrollend seeked seeking stalled submit suspend textInput timeupdate toggle touchcancel touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart volumechange waiting webkitAnimationEnd webkitAnimationIteration webkitAnimationStart wheel`.
- Note there is no `focus`, `blur`, `mouseenter`, `mouseleave`, `pointerenter`, `pointerleave` or `beforeinput`. React synthesises those.

Implications:

- **`addEventListener` is the most-called DOM method during mount in small tests**: in the traced render it was 147 of 223 mutation-type calls, and 147 of 409 total react-dom DOM touches.
- It must be very cheap and should never cross N-API. Keep listener lists in JS, keyed by node, either as a JS-side field on the wrapper or a `Map<nodeId, …>`.
- Registration order matters: capture listeners for one type are added before or after bubble ones depending on iteration. React does not depend on that.
- Non-delegated per-element listeners: `invalid` on every input, select and textarea; `load`/`error` on img, link, source and embed; `toggle` on details; four on dialog; 24 on video and audio; `scroll`/`scrollend` for `onScroll`.
- The listener is a bound function (`dispatchDiscreteEvent`/`dispatchContinuousEvent`/`dispatchEvent`), so a new function per registration. Remove-by-identity must work. React never removes root listeners: `root.unmount()` leaves them, and RTL then detaches the container.

### 5.2 Dispatch path requirements

For each native event reaching the container, React's listener runs **twice**, in the capture phase and again in the bubble phase (for delegated events). Each run does the following (`RDB/events/ReactDOMEventListener.js:157-246`):

1. `getEventTarget(nativeEvent)` (`RDB/events/getEventTarget.js`): `event.target || event.srcElement || window`, then `target.correspondingUseElement` (absent-property read), then `target.nodeType === 3 ? target.parentNode : target`.
2. `getClosestInstanceFromNode(target)`: the expando read; if missing, walk `parentNode` reading `__reactContainer$`/`__reactFiber$` expandos (`ReactDOMComponentTree.js:136-227`).
3. Portal and multi-root handling compares `container === targetContainer` and walks `container.parentNode` (`DOMPluginEventSystem.js:589-660`).
4. All plugins run (`extractEvents`, `:102-198`) and build synthetic events **only when listeners exist**. Exception: enter/leave events are always built on `mouseover`/`mouseout`/`pointerover`/`pointerout`.
5. `executeDispatch` sets `syntheticEvent.currentTarget` (a JS object, not the native one) and catches handler errors, which go to `reportGlobalError` (`:252-262`).

The dispatcher must therefore:

- Compute the propagation path **at dispatch start**: target, then ancestors, then document, then window. Per DOM spec, a node removed mid-dispatch still gets its listeners.
- Run capture listeners (window down to parent), then target (capture then bubble, per the current spec), then bubble listeners (parent up to window), only if `bubbles`.
- Honour `stopPropagation`/`stopImmediatePropagation` (React calls `nativeEvent.stopPropagation()` from `SyntheticEvent.stopPropagation`, `RDB/events/SyntheticEvent.js:105-117`), `once`, `passive` (`preventDefault` ignored), `signal`, and listener-list mutation during dispatch.
- Set `event.target`, `currentTarget` and `eventPhase` correctly (React reads `eventPhase` into every synthetic event).
- Set **`window.event`** to the current event while invoking listeners (spec, jsdom `jsdom/lib/jsdom/living/events/EventTarget-impl.js:360-390`) and restore the previous value, `undefined`, afterwards. React reads it for update priority (`ReactDOMUpdatePriority.js:34-45`), popstate eager transitions and DEV perf tracks (`ReactFiberConfigDOM.js:784-821`). happy-dom never sets `window.event` (always `undefined`), which React tolerates (Default priority). jsdom sets it. **Never `null`.**
- Return `!event.defaultPrevented` from `dispatchEvent`. DTL's `fireEvent` returns that and tests assert it.
- Report listener exceptions without aborting the dispatch, through the window `error` event, as jsdom's `reportException` does.

### 5.3 Event object properties React reads (`RDB/events/SyntheticEvent.js`)

Every synthetic event copies its whole Interface from the native event, one property read each:

| Interface | Properties read |
|---|---|
| Base (`:149-158`) | `eventPhase`, `bubbles`, `cancelable`, `timeStamp` (`event.timeStamp \|\| Date.now()`), `defaultPrevented`, `isTrusted`. Also `defaultPrevented ?? returnValue === false` (`:72-80`), `type`, `target`. |
| UI | + `view`, `detail` |
| Mouse (`:192-233`) | + `screenX/Y`, `clientX/Y`, `pageX/Y`, `ctrlKey`, `shiftKey`, `altKey`, `metaKey`, `button`, `buttons`, `relatedTarget` (falls back to `fromElement`/`toElement`/`srcElement`), `'movementX' in event`, `movementX/Y` (polyfilled from `screenX` deltas). Synthetic `getModifierState` calls native `getModifierState` when present. |
| Drag | + `dataTransfer` |
| Focus | + `relatedTarget` |
| Keyboard (`:445-…`) | `key` (normalised; falls back to `keyCode` via a table), `code`, `location`, `ctrlKey`, `shiftKey`, `altKey`, `metaKey`, `repeat`, `locale`, `charCode` and `keyCode` and `which` (type-dependent; `getEventCharCode` reads `charCode`, `keyCode`). |
| Pointer | + `pointerId`, `width`, `height`, `pressure`, `tangentialPressure`, `tiltX/Y`, `twist`, `pointerType`, `isPrimary` |
| Touch | + `touches`, `targetTouches`, `changedTouches`, modifier keys |
| Wheel | + `'deltaX' in e`, `deltaX/Y/Z`, `deltaMode` (and `wheelDelta*` fallbacks) |
| Clipboard | `'clipboardData' in event ? event.clipboardData : window.clipboardData` |
| Composition/Input | `data` |
| Animation/Transition | `animationName`, `propertyName`, `elapsedTime`, `pseudoElement` |
| Submit | `submitter` |
| Toggle | `newState`, `oldState`, `source` |

Plugin-specific reads:

- `nativeEvent.button === 2`: right clicks never produce `onClick` (`SimpleEventPlugin.js:100-107`).
- `keyCode`, `which`, `ctrlKey`, `altKey`, `metaKey`, `data`, `detail` and `locale` in BeforeInput.
- `relatedTarget` in EnterLeave.
- `defaultPrevented` and `submitter` in FormAction.

**Implication:** a click with one `onClick` handler produces about 30 native-event property reads. An `Event` implemented with Rust-backed getters would cost about 30 N-API round trips per React dispatch. Event objects should be **pure JS** (fields or cheap getters over JS state). The DOM-spec internal flags (stop propagation, canceled, dispatch, path) live in JS too.

### 5.4 Which native events produce which React props

| React prop | Native event(s) the DOM must fire | Source |
|---|---|---|
| `onFocus` / `onBlur` | `focusin` / `focusout` (bubbling) | `DOMEventProperties.js:143-145`, `SimpleEventPlugin.js:88-95` |
| `onMouseEnter` / `onMouseLeave` | `mouseover` / `mouseout` with `relatedTarget` | `EnterLeaveEventPlugin.js:34-47, 48-171`; RTL's `fireEvent.mouseEnter` also fires `mouseOver` (`react-testing-library/src/fire-event.js:13-25`) |
| `onPointerEnter` / `onPointerLeave` | `pointerover` / `pointerout` | same |
| `onChange` on text inputs and textarea | `input` (or `change`) when the value tracker sees a change | `ChangeEventPlugin.js:252-260` |
| `onChange` on checkbox and radio | `click` when the tracked `checked` changed | `:231-247` |
| `onChange` on select and `input[type=file]` | `change` | `:77-83` |
| `onChange` on custom elements | `change` | `:293-297` |
| `onSelect` | `focusin`/`focusout`, `mousedown`/`mouseup`, `keydown`/`keyup`, `selectionchange`, `contextmenu`, `dragend` while a text input or contentEditable is active | `SelectEventPlugin.js:32-43, 150-207` |
| `onBeforeInput` | `keypress` (`which`) or `compositionend`/`paste`; `textInput` only when `'TextEvent' in window` | `BeforeInputEventPlugin.js` |
| `onDoubleClick` | `dblclick` | `DOMEventProperties.js:142` |
| `onAnimation*` / `onTransition*` | (vendor-prefixed?) `animationend` etc., §3 | `getVendorPrefixedEventName.js` |
| `onSubmit` / form `action={fn}` | `submit` (SubmitEvent with `submitter`); then `new FormData(form, submitter)`, `form.method`, `event.preventDefault()`; after the action, `requestFormReset` → `form.reset()` | `FormActionEventPlugin.js:49-162`, `ReactFiberConfigDOM.js:5211-5232, 6998-7002` |

Form actions need a **`FormData` global whose constructor accepts `(form, submitter)`**. Node 22's undici `FormData` throws when given a form, so the env must override `globalThis.FormData`, as jsdom's env does via KEYS.

### 5.5 Priorities and batching

- `getEventPriority(type)` (`ReactDOMEventListener.js:312-…`): discrete events (click, input, keydown, focusin, …) set `ReactDOMSharedInternals.p`. Continuous events (mousemove, pointermove, scroll, wheel, …) are the second class.
- `batchedUpdates` → `finishEventHandler`: if a controlled component was touched (`enqueueStateRestore`), React runs `flushSyncWork()` and **`restoreControlledState`**, writing the controlled `value`/`checked` back into the DOM if state didn't change (`RDB/events/ReactDOMUpdateBatching.js:27-60`, `RDB/events/ReactDOMControlledComponent.js:21-73`, `ReactDOMComponent.js:3398-3414`). This is why the value accessors must behave exactly like browsers (§6).

### 5.6 Errors thrown in handlers and roots

- Handler errors: `executeDispatch` catches them and calls `reportGlobalError(error)`. That uses `reportError` if defined, else `window.dispatchEvent(new window.ErrorEvent('error',{bubbles:true,cancelable:true,message,error}))`, and `console.error`s it unless canceled (`SH/reportGlobalError.js`).
  - jsdom: no `reportError`, `ErrorEvent` present.
  - Vitest's jsdom env turns an uncanceled window `error` with `.error` into an unhandled test error (`vitest/packages/vitest/src/integrations/env/jsdom.ts:8-34`).
  - rsdom should expose `ErrorEvent` and a working `window.dispatchEvent`, and decide deliberately whether to add `reportError`. Absent matches jsdom.
- Render errors under `act`: pushed to `ReactSharedInternals.thrownErrors` and rethrown by `act`, with no DOM involvement (bundle `logUncaughtError`, ~line 9806).
- Outside `act`: `onUncaughtError` → `defaultOnUncaughtError` → `reportGlobalError`. Hydration recoverable errors take the same path.

---

## 6. Controlled form controls in detail

### 6.1 The value tracker (`RDB/client/inputValueTracking.js`)

`track(node)` is called at the end of `initInput` and `initTextarea`. Not for select.

1. `valueField = isCheckable(node) ? 'checked' : 'value'`, where `isCheckable` is `nodeName.toLowerCase()==='input' && (type==='checkbox'||type==='radio')`.
2. `descriptor = Object.getOwnPropertyDescriptor(node.constructor.prototype, valueField)`.
3. Bail out (no tracking) if `node.hasOwnProperty(valueField)`, if the descriptor is missing, or if `get`/`set` are not functions.
4. `Object.defineProperty(node, valueField, {configurable:true, get(){return get.call(this)}, set(v){currentValue=''+v; set.call(this,v)}})`, then a second `defineProperty` with only `{enumerable: descriptor.enumerable}`.
5. `node._valueTracker = {getValue, setValue, stopTracking}`. `stopTracking` does `delete node[valueField]`.
6. `updateValueIfChanged(node)` (on input, change and click) compares `tracker.getValue()` with the current `node.checked ? 'true':'false'` or `node.value`.

What the facade must provide:

- `HTMLInputElement.prototype` has **own** `value` and `checked` accessors with both get and set, `configurable: true`. Same for `HTMLTextAreaElement.prototype.value`. Not inherited from a shared `FormControl`/`Element` prototype.
- `el.constructor` resolves to that class. Don't override `constructor` per instance.
- Getters and setters work when invoked through `.call(wrapper)`, so they must find the Rust node from `this`, via a private field or symbol slot holding the node id.
- Instances are extensible and accept `defineProperty` of own accessors that shadow the prototype. React, DTL and user-event all do this.
- The instance has **no own `value`/`checked`** until React tracks it.
- DTL `fireEvent.change(el, {target:{value}})` calls the **prototype** setter directly to bypass React's own-property setter, so the tracker keeps the old value and React sees a change (`dom-testing-library/src/events.js:106-123`). It throws "The given element does not have a value setter" when `Object.getPrototypeOf(el)` lacks an own `value` setter.
- user-event (`@testing-library/user-event/dist/cjs/document/interceptor.js:9-32`) additionally requires own `value` (set), `selectionStart` (set), `selectionEnd` (set), `setSelectionRange` and `setRangeText` on `element.constructor.prototype` for input and textarea. Otherwise it throws `Element INPUT does not implement "value"`.

Measured (`exp-value-tracker.js`, §15):

- Accessor moved one prototype up: DTL `fireEvent.change` throws and React over-fires onChange.
- Own accessor per instance: React over-fires onChange on no-op input events.

### 6.2 `<input>` (`RDB/client/ReactDOMInput.js`)

`initInput` (`:222-…`), in order:

1. `node.type = type`.
2. When `value`/`defaultValue` is given:
   - Submit/reset with no value: track and return.
   - Else, if `initialValue !== node.value`, set `node.value = initialValue`.
   - `node.defaultValue = initialValue`. This is attribute syncing: it writes the `value` attribute.
3. `node.checked = !!initialChecked`.
4. `node.defaultChecked = !node.defaultChecked; node.defaultChecked = !!initialChecked` (`:344-345`). This forces the `checked` attribute and relies on the dirty-checkedness flag being set by step 3, so the attribute toggle doesn't change `.checked`.
5. `node.name = name` if given.
6. `track(node)`.

`updateInput` (`:88-220`), in order:

1. `node.name = ''`. This reflects as `name=""`; React removes it again later.
2. `node.type = type`, or `removeAttribute('type')`.
3. If `value != null`:
   - `type === 'number'`: `if ((value === 0 && node.value === '') || node.value != value) node.value = …`. A loose `!=` keeps `"1."` / `"1.0"` while typing.
   - Otherwise: if `node.value !== String(value)`, set `node.value = …`.
4. Submit/reset without value: `removeAttribute('value')`.
5. `setDefaultValue`: `if (node.defaultValue !== v) node.defaultValue = v` (`:480-484`), or `removeAttribute('value')`.
6. `node.defaultChecked = …` (uncontrolled case).
7. `node.checked = …` (controlled).
8. `node.name = …` or `removeAttribute('name')`.

Required semantics:

| Member | Required behaviour |
|---|---|
| `type` | Reflects the `type` attribute, ASCII-lowercased, with invalid or missing values reading as `'text'`. The type-change value-mode algorithm should be followed. React, `isTextInputElement` (`RDB/events/isTextInputElement.js`) and `hasSelectionCapabilities` all read it. |
| `value` | Mode `value`: raw value plus the **dirty value flag**. Once set via the property, changing the `value` attribute (`defaultValue`) no longer changes `.value`. Mode `default/on` for checkbox and radio: `value` reflects the attribute, default `"on"`. Sanitisation per type: number clears non-numbers; email/text strip newlines. |
| `defaultValue` | Reflects the `value` content attribute. |
| `checked` | Checkedness plus a **dirty checkedness flag**. `defaultChecked` reflects the `checked` attribute and updates checkedness only while not dirty. |
| `name` | Reflects the attribute. Setting `''` creates `name=""`. |
| `form` | The form owner, needed for radio groups. |
| `selectionStart` / `selectionEnd` / `setSelectionRange` | Getters return `null` for types without selection. Setters throw `InvalidStateError` for those types. React only touches them for text/search/tel/url/password and textarea. |

The radio group restore (`:399-478`) runs after a change on a controlled radio with a `name`:

1. Walk `parentNode` to the root.
2. `queryRoot.querySelectorAll('input[name="…"][type="radio"]')`, which needs attribute selectors on any root including detached ones, and selector-string escaping.
3. Compare `otherNode.form !== rootNode.form`.
4. Read the other node's `__reactProps$`, call `updateInput` on it, then `updateValueIfChanged`.

Native radio semantics (checking one unchecks the group) must be implemented in the `checked` setter and in click activation.

### 6.3 `<textarea>` (`RDB/client/ReactDOMTextarea.js`)

`initTextarea` (`:93-148`):

1. `node.defaultValue = initial`, which **replaces child text content**.
2. `const tc = node.textContent`.
3. `if (tc === initial && tc !== '') node.value = tc`.
4. `track(node)`.

`updateTextarea` (`:64-91`) compares `node.value`/`node.defaultValue` and writes them. The textarea needs a raw value with a dirty flag, `defaultValue` ⇄ child text, and `textContent`. `setProp('children')` is skipped for `''` (`ReactDOMComponent.js:408-418`). String children are passed as `defaultValue` (`disableTextareaChildren` is false).

### 6.4 `<select>` and `<option>` (`RDB/client/ReactDOMSelect.js`, `ReactDOMOption.js`)

- `initSelect` (`:146-…`): `node.multiple = !!multiple`, then `updateOptions`.
- `updateOptions` (`:63-…`): `node.options` (live HTMLOptionsCollection with `.length` and `[i]`; includes optgroup children), then per option `options[i].value`, `.selected` get/set, `.defaultSelected = true`, `.disabled`.
  - Single select: the first matching option gets `selected = true`, or else the first non-disabled option gets `selected = true`.
- `updateSelect` and `restoreControlledSelectState` follow the same pattern.
- `option.selected` is set at create time (`ReactDOMComponent.js:1339-1363`) and cleared or re-set on update (`:1841-…`).

Required semantics:

- `option.value`: the attribute, else the text with whitespace stripped and collapsed.
- `option.selected` setter: sets selectedness and dirtiness. In a single-select, it **deselects the others**.
- Default selectedness when no option is selected: the first non-disabled option in a size-1 single select. React relies on this when `value` is null.
- `select.value` getter and setter (DTL `fireEvent.change` on select uses the prototype `value` setter).
- `selectedOptions`, `selectedIndex` (DTL, jest-dom, user-event).
- No value tracker for select: React's onChange comes straight from the `change` event.

---

## 7. Focus, selection and scroll (`RDB/client/ReactInputSelection.js`, `RDB/client/ReactDOMSelection.js`, `RDB/client/getActiveElement.js`)

On **every commit**:

1. `getActiveElementDeep(container)` (`:59-75`):
   - `win = container.ownerDocument.defaultView || window`.
   - `el = win.document.activeElement || win.document.body` (inside try/catch).
   - `while (el instanceof win.HTMLIFrameElement)`, with same-origin check `el.contentWindow.location.href`.
2. `hasSelectionCapabilities(el)` (`:90-103`): `nodeName.toLowerCase()`, `type ∈ {text, search, tel, url, password}`, `textarea`, or `contentEditable === 'true'`. `contentEditable` should return `'inherit'` by default, as a string.
3. `getSelection(el)` (`:163-…`): `'selectionStart' in el` → `{start: el.selectionStart, end: el.selectionEnd}`. Otherwise `getOffsets(el)` for contentEditable, which uses `win.getSelection()` (guarded), `rangeCount`, `anchorNode`/`anchorOffset`/`focusNode`/`focusOffset`, and tree walking.

After the commit (`restoreSelection`, `:120-157`), if the focused element changed and the old one `isInDocument` (`node.ownerDocument.documentElement.contains(node)`, or `compareDocumentPosition & 16`):

- `setSelection`: `el.selectionStart = start`, `el.selectionEnd = Math.min(end, el.value.length)`. For contentEditable: `doc.createRange()`, `range.setStart`/`setEnd`, `selection.removeAllRanges`/`addRange`/`extend` (`ReactDOMSelection.js:153-202`).
- For each element ancestor: read `scrollLeft`/`scrollTop`, call `el.focus()`, then write them back.

`autoFocus` → `el.focus()` in `commitMount`.

`setFocusIfFocusable` (Fragment refs, experimental): `ownerDocument.activeElement`, document capture `focus` listener, `(el.focus || HTMLElement.prototype.focus).call(el, opts)` (`ReactFiberConfigDOM.js:4810-4852`).

What the DOM must implement for focus:

- The full focus sequence and events. jsdom implements it in `jsdom/lib/jsdom/living/helpers/focusing.js`: `blur` and `focusout` (bubbles) on the old element, then `focus` and `focusin` (bubbles) on the new one. `relatedTarget` is set and the events are `FocusEvent`s.
- Focusability rules: disabled controls, `tabindex`, `a[href]`, etc. (`focusing.js:17-70`). user-event and `toHaveFocus` depend on them.
- **Focus fixup:** removing the focused element (or an ancestor) resets `activeElement` to `body` without firing events, matching jsdom (§15, `exp-focus-restore.js`). Without it, after unmount `document.activeElement` points at a detached node.

`SelectEventPlugin` (`RDB/events/plugins/SelectEventPlugin.js:57-…`) has two parts:

- On `focusin` it stores the target if `isTextInputElement(target)`, which includes email, number, date and similar types, or if `contentEditable === 'true'`.
- On keydown, keyup, mouseup, contextmenu, dragend and selectionchange: `getActiveElement(doc)`, then `getSelection(node)`, which uses `'selectionStart' in node && hasSelectionCapabilities(node)`. Otherwise it calls **unguarded `win.getSelection()`** and reads `anchorNode`, `anchorOffset`, `focusNode` and `focusOffset`.
- So typing into `<input type="email">` calls `window.getSelection()` on every key (P0, §15).

---

## 8. `ownerDocument`, window and global singletons

React reads these in roughly descending frequency:

- `node.ownerDocument`: 106 reads in the trace.
- `document.defaultView`: 52.
- `document.body`, `documentElement`, `head`.
- `win.document`, `win.HTMLIFrameElement`, `win.getSelection`.
- `window.event`: 32.
- `window.top`/`self` and `navigator.userAgent` (DEV banner).
- `window.location.protocol`.
- `devicePixelRatio`, `navigator.connection`, `performance.getEntriesByType` (suspensey images).
- The globals `document`, `HTMLElement`, `FormData`, `Event`/`InputEvent` (hydration replay only, `RDB/events/ReactDOMEventReplaying.js:400-452`), `IntersectionObserver` (experimental), `reportError`/`ErrorEvent`, `queueMicrotask`, `setTimeout`, `requestAnimationFrame`, `AbortController` (React's per-root cache; 2 reads per render in the trace) and `MessageChannel`/`setImmediate` (scheduler, react `act`).

In the Vitest environments `window === globalThis` and `document.defaultView` is redefined to return `globalThis` (`vitest/packages/vitest/src/integrations/env/utils.ts:92-108`). rsdom's env should do the same. `ownerDocument` and `defaultView` are constant per node for our single-document environment, so they should be served from JS without crossing to Rust.

---

## 9. Scheduler, act and timing in a test environment

- RTL sets `globalThis.IS_REACT_ACT_ENVIRONMENT = true` (`react-testing-library/src/act-compat.js:28-34`). It wraps `render`, `fireEvent` and user-event (through DTL's `eventWrapper`/`asyncWrapper`) in `React.act`.
- Under `act`, React queues work in `ReactSharedInternals.actQueue` and flushes synchronously or at `act` exit. No DOM timer APIs are involved.
- Outside `act` (`waitFor` turns it off temporarily, `react-testing-library/src/pure.js:36-60`):
  - Sync lanes flush in `queueMicrotask`.
  - Default and transition lanes go through the `scheduler` package, using `setImmediate` in Node.
  - Suspense fallback throttling uses `setTimeout` (300 ms) via the captured `scheduleTimeout`.
- **The environment should not replace Node's** `setTimeout`, `setImmediate`, `queueMicrotask`, `performance` or `MessageChannel`. This matches what Vitest's jsdom env does: it only adds `MessageChannel`, `structuredClone` and similar when jsdom lacks them (`vitest/packages/vitest/src/integrations/env/jsdom.ts:130-142`).
- DTL's `waitFor` uses `MutationObserver(container, {subtree, childList, attributes, characterData})`. That is not a react-dom requirement, but it is P0 for the RTL test suite, and every mutation React makes would then queue records. Budget for it.

---

## 10. DEV-only behaviour worth knowing

Vitest runs the development build by default (`NODE_ENV=test` resolves `react-dom` to `*.development.js`).

- `validateDOMNesting`, `ReactDOMUnknownPropertyHook`, `ReactDOMInvalidARIAHook` and `ReactDOMNullInputValuePropHook` are pure prop and tag checks with no DOM.
- `HTMLUnknownElement` toString check, §4.1. Known HTML tags must map to a non-`HTMLUnknownElement` class or toStringTag. Unknown tags such as `<foo>` should be `HTMLUnknownElement`, which gives the correct warning.
- `checkControlledValueProps`, controlled ⇄ uncontrolled warnings: pure.
- Performance tracks: `performance.measure`, `clearMeasures` and `console.timeStamp` for every commit and many components. Same cost in every env if `performance` is left alone.
- `warnForBlockInsideInline` → `getComputedStyle(node).display`: only around `<ViewTransition>` (`ReactFiberConfigDOM.js:1451-1496`).
- `Object.freeze(styleProp)`: irrelevant to the DOM.

---

## 11. What react-dom does **not** need (good for scoping rsdom v0)

- Layout and geometry: `getBoundingClientRect`, `getClientRects`, `offset*`/`client*`, `scrollTo`, `getComputedStyle`. Only ViewTransition, Fragment refs (`observeUsing`, `getClientRects`, `scrollIntoView`) and test selectors use them, all experimental or opt-in.
- `MutationObserver`, `IntersectionObserver`, `ResizeObserver`: none in stable react-dom paths. DTL needs `MutationObserver`.
- `Range`/`Selection` beyond what §7 lists. contentEditable selection restore is the only heavy user.
- `document.createEvent`/`initEvent` (dead flag), `moveBefore` (dead flag), comment containers (dead flag).
- `cloneNode`: only gesture transitions (experimental), via `cloneMutableInstance`.
- `startViewTransition`, `animate`, `getAnimations`, `AnimationTimeline`: only with `<ViewTransition>`/`startGestureTransition`. React tolerates their absence; its catch notes that only a missing `startViewTransition` should throw (`ReactFiberConfigDOM.js:2403`).
- Hydration (`hydrateRoot`): comment-node markers (`data` values `'$'`, `'/$'`, `'$?'`, `'$!'`, `'&'`, `'/&'`, `'F!'`, `'F'`), `nextSibling` walking, `getAttribute`/`hasAttribute`, `attributes` iteration, `textContent` and `removeAttributeNode` (`ReactFiberConfigDOM.js:4055-4750`). That is P2 for tests: RTL only hydrates with `render(ui, {hydrate: true})`.

---

## 12. Prioritised requirement list (react-dom only)

**P0 (needed for any React test):**
- Stable wrapper identity and extensible wrappers with expando persistence. Correct per-interface prototype classes.
- `createElement`/`createElementNS`/`createTextNode`, `appendChild`/`insertBefore`/`removeChild` (with move semantics), `textContent` get/set, `nodeValue` set, `firstChild`/`lastChild`/`nextSibling`/`parentNode`, `nodeType`/`nodeName`/`tagName`/`namespaceURI`/`ownerDocument`, `getRootNode`, `contains`.
- `setAttribute`/`removeAttribute` with HTML lowercasing and SVG case preservation, plus `setAttributeNS`.
- `innerHTML` setter with an HTML fragment parser.
- `style` (CSSStyleDeclaration with camelCase accessors, `setProperty` with priority, `cssFloat`).
- EventTarget with capture/target/bubble dispatch, an options object, `passive`/`once`, the return value, `window.event`, and object listeners.
- Event classes `Event`, `UIEvent`, `MouseEvent`, `PointerEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`, `CompositionEvent` (present), `ErrorEvent`, `SubmitEvent`, `AnimationEvent` and `TransitionEvent` (present), with the properties in §5.3. `TextEvent` **absent**.
- `'oninput' in document` (GlobalEventHandlers `on*` accessors), and a writable `onclick` defaulting to `null`.
- Form controls per §6: value tracker prototype shape, input/textarea/select/option semantics including dirty flags, checkbox and radio click activation, radio groups.
- Focus per §7: `focus()`/`blur()` with focusin/focusout, `activeElement`, focus fixup, and `selectionStart`/`selectionEnd`/`setSelectionRange`.
- `window.getSelection()` returning at least a stub with anchor and focus fields.
- `window.HTMLIFrameElement` constructor; `document.defaultView === window`; `document.body`/`head`/`documentElement`.
- Globals present before `react-dom` is imported.

**P1 (common in real suites):**
- `querySelector`/`querySelectorAll` with attribute selectors, `>` combinator and selector lists (radio groups, hoisted `<title>`).
- `dataset`.
- Element `form` owner.
- `form.reset()`, `form.method`, submit-button activation that dispatches SubmitEvent with `submitter`, and `FormData(form, submitter)`.
- `img.src`/`srcset` reflection; `img.complete`/`decode` per §4.10.
- `scrollLeft`/`scrollTop` accessors.
- `attributes` and `removeAttributeNode` (React rendering `<html>`/`<body>`).
- `contentEditable` getter.
- Non-delegated element events (`load`, `error`, `invalid`, `toggle`, `scroll`).

**P2:**
- Resources and stylesheet precedence (§4.9).
- Hydration (§11).
- contentEditable selection restore (Range/Selection API).
- ViewTransition, Fragment refs, custom element property-vs-attribute detection with real custom element classes.

---

## 13. Hot path: per-operation call sequences

Single host element mount, for example `<div className="a" style={{color:'red'}}>text</div>`:

1. `createElement('div')`.
2. 2 expando writes.
3. `setAttribute('class','a')`.
4. `style` get, then `style.color = 'red'`.
5. `textContent = 'text'`, after the `firstChild` read inside `setTextContent`, which returns null for a new element.
6. Later `appendChild` into its parent (detached).

Mixed children add `createTextNode` plus `appendChild` per text segment.

| Update | DOM work |
|---|---|
| Text-only child change | `firstChild`, `lastChild` (identity), `firstChild.nodeType`, then `firstChild.nodeValue = text`. |
| Text instance change | `nodeValue = text`. |
| Attribute change | one `setAttribute`/`removeAttribute`. |
| Style change | `style` read, then one property write per changed key. |
| Every commit | `ownerDocument`, `defaultView`, `document`, `activeElement`, `instanceof HTMLIFrameElement`, selection-capability reads, and when a text input is focused, `selectionStart`/`selectionEnd`, done **twice** (before and after); plus `getRootNode` once. |
| Every native event | §5.2 runs twice: `target`, `correspondingUseElement`, `nodeType`, expando reads, about 8 plugin checks (`nodeName`, `type` on the target for ChangeEventPlugin and SelectEventPlugin), and about 30 event-property reads per synthetic event built. |

---

## 14. Dynamic trace (jsdom 30.1.3, react-dom 19.3.1 DEV, RTL 16.3.3, user-event 14.6.8)

**Method.**
- `docs/lab/research/react-dom-trace/trace.js` wraps every method and accessor on every DOM interface prototype exposed by the window (JS built-ins excluded), plus `window.event`/`top`/`self`.
- It attributes each call by stack inspection to `react-dom`, `rtl`, `dtl`, `user-event`, `dom-a11y-api` or to implementation internals (dropped).
- The scenario uses one `App`: a list, a button, a controlled text input with autoFocus and onFocus/onBlur, a controlled textarea, a controlled select, a controlled checkbox, inline SVG, `dangerouslySetInnerHTML`, and a conditional span.
- Phases: `render`, then `fireEvent.click`, `fireEvent.change`, `user.type(textarea,'yz')`, `user.selectOptions`, `user.click(checkbox)`, and `unmount` with cleanup.
- Full table: `trace-jsdom-react-dom.txt`. Raw data: `trace-jsdom-30.1.3.json`.
- **Blind spots:** expando reads and writes, `in` checks, `instanceof`, `Object.prototype.toString`, and reads of window-own properties that aren't accessors.

**Totals by caller:** react-dom 1,940, user-event 1,574, DTL 675, dom-accessibility-api 213, RTL 7. DTL and user-event selector-engine work (`querySelectorAll`, `matches`) happens inside jsdom and is not counted.

**react-dom top APIs** (columns: total / import / render / click / fireEvent.change / user.type / user.selectOptions / user.click(checkbox) / unmount):

```
Node.nodeType [get]            308    0  33   7   7  93  97  66   5
Node.nodeName [get]            258    0  15   7   7 100  55  71   3
Event.target [get]             244    0   4   4   4  80  90  62   0
EventTarget.addEventListener() 148    1 147   0   0   0   0   0   0
Node.ownerDocument [get]       106    0  34   7   7  25  14  11   8
Event.defaultPrevented [get]    96    0   3   3   3  21  39  27   0
HTMLInputElement.type [get]     62    0   6   1   4   3   0  43   5
Document.defaultView [get]      52    0   8   4   4  14  10   8   4
Event.timeStamp [get]           40    0   2   2   2  10  14  10   0
window.event [get]              32    0   8   3   3   9   3   3   3
Event.eventPhase/bubbles/cancelable [get]   32 each
Element.removeAttribute()       29    0   5   3   5   9   3   4   0
Document.activeElement [get]    27    0   4   2   2  13   2   2   2
MouseEvent.movementX/Y [get]    25 each
Element.setAttribute()          23    0  20   1   0   0   0   2   0
Node.appendChild()              22    0  20   1   1   0   0   0   0
HTMLTextAreaElement.value [get] 21 ; HTMLInputElement.name [set] 19 ; Document.createElement() 18
HTMLInputElement.value [get] 14 ; HTMLOptionsCollection.length 13 ; HTMLOptionElement.value 13
HTMLInputElement.checked [set] 11 ; HTMLElement.style [get] 10 ; HTMLElement.onclick [set] 10
HTMLSelectElement.options 10 ; HTMLOptionElement.selected [set] 10 ; Node.getRootNode() 10
Node.textContent [set] 9 ; textarea selectionStart/End [get] 9 ; createTextNode 4 ; createElementNS 2
innerHTML [set] 2 ; removeChild 2 ; HTMLElement.focus() 1 ; insertBefore 1 ; nodeValue [set] 1 ; contains 1
```

**Reading the numbers.** About 1,650 of react-dom's 1,940 touches are reads that need no Rust crossing if the facade is designed for it:

| Reads | How to serve them from JS |
|---|---|
| `nodeType`, `nodeName` (constant per node) | Prototype-level constant or a field cached on the wrapper. |
| `ownerDocument`, `defaultView` | Constant in a single-document env. |
| `Event.*` | JS event objects. |
| `addEventListener` | JS listener registry. |
| `window.event` | JS variable. |

The remainder of roughly 300 calls (mutations, form state, traversal, activeElement) is what really needs to reach Rust. For this kind of workload a Rust DOM only wins if those ~300 calls, plus DTL and user-event's query and ARIA work, are cheaper than jsdom's JS equivalents including N-API overhead, and if the ~1,650 cheap reads stay as cheap as V8 inline caches. One N-API call costs roughly tens of ns, plus string marshalling.

---

## 15. Experiments (scripts in `docs/lab/research/react-dom-trace/`)

`exp-feature-detect.js` (jsdom, each feature removed or broken in turn; scenario: `user.type` into a controlled email input and an uncontrolled text input, plus `fireEvent.change`):

| Variant | Result |
|---|---|
| baseline | OK (`v=a@b n=3`, 0 console.error) |
| `window.getSelection = undefined` | 8× `TypeError: …getSelection is not a function at constructSelectEvent` reported through `reportGlobalError`. In Vitest these surface as unhandled errors. |
| `oninput` removed from Document/HTMLElement | Text-input onChange count `n=0`; 3× `attachEvent is not a function` / `detachEvent is not a function` |
| `window.event` returns `null` | Throws `Cannot read properties of null (reading 'type')` at render |
| `HTMLIFrameElement = undefined` | Throws `Right-hand side of 'instanceof' is not an object` at the first commit |
| `HTMLDivElement` toStringTag = `HTMLUnknownElement` | DEV `console.error`: "The tag <div> is unrecognized in this browser" |

`exp-value-tracker.js` (where the `value` accessor lives):

| Variant | `fireEvent.change` | onChange on a no-op `input` event | `user.type` |
|---|---|---|---|
| baseline (own accessor on `HTMLInputElement.prototype`) | works (1 change) | not fired | works |
| accessor moved to `HTMLElement.prototype` | **throws** "does not have a value setter" | fired (over-reporting) | works (user-event fell back) |
| own accessor on each instance (facade-generated) | works | **fired** (React bails out of tracking: `hasOwnProperty('value')`) | works, extra onChange |

`exp-focus-restore.js`: in jsdom, removing a focused input sets `activeElement` to `BODY` and fires no events. When React moves the focused input during a keyed reorder (`[a,b,c] → [b,c,a]`), `restoreSelection` calls `focus()` once and the selection (1,2) is preserved through the `selectionStart`/`selectionEnd` setters.

`listeners.js`: 143 listeners per `createRoot`, 142 per portal, webkit-prefixed animation events under jsdom (§5.1).

---

## 16. Design recommendations for the rsdom facade (from react-dom's point of view)

1. **JS object model, Rust storage.**
   - Pure-JS class hierarchy (`EventTarget`, `Node`, `CharacterData`/`Text`/`Comment`, `Element`, `HTMLElement`, per-tag `HTML*Element`, `SVGElement`, `Document`, `DocumentFragment`). Each instance holds a node id (a small integer in a field such as `this[ID]`).
   - Accessors call flat napi functions (`rs.getAttr(id, name)`).
   - napi-rs `#[napi] class` objects can't express this inheritance tree or own-accessor layout conveniently. The JS-class plus flat-function approach also keeps hidden classes stable for React's expandos.
2. **Wrapper cache.** Use a JS array or Map `id → wrapper`, created lazily, **strong while the node is connected or otherwise reachable**. Simplest v0: strong for the environment's lifetime, freed at teardown. Test files are short-lived. Measure memory on large suites before getting clever with `WeakRef` and `FinalizationRegistry`. Losing a wrapper loses React's expandos.
3. **Serve constant reads from JS.** `nodeType` comes from a prototype constant. `nodeName`, `tagName`, `localName` and `namespaceURI` are cached on the wrapper at creation. `ownerDocument` and `defaultView` are constants.
4. **Events entirely in JS.**
   - Listener registry per wrapper, as a lazily created field.
   - Event classes as plain JS.
   - The propagation path built by walking `parentNode`. That walk is the main Rust read on the event path. Consider one napi call returning the ancestor id array, `rs.ancestors(id)`, then map ids to wrappers, creating them only if there are listeners. Better still, keep a JS-side "has listeners" bitmap so only wrappers that have listeners are visited.
   - Activation behaviours (checkbox/radio toggle, label → control, submit button → form submit) hook into dispatch.
   - `window.event` is a JS variable.
5. **Form-control state.** Value, dirty flags, checkedness and selectedness can live in Rust, as part of the node, so serialization and `form.reset()` are consistent. Or keep them in JS slots on the wrapper to avoid crossings: about 150 crossings in the trace. Either works, but the **accessors must sit on the correct prototypes** (§6.1).
6. **Batch where React batches.** React builds subtrees detached and attaches once. Initial props become many `setAttribute` calls on fresh nodes. A Rust API taking interned attribute-name ids, with JS caching name strings in a `Map<string, id>`, avoids re-encoding strings on every call. `textContent`/`nodeValue` strings must cross once.
7. **No Proxies** on nodes or events. Use generated accessors for `CSSStyleDeclaration` and `on*` handlers.
8. **Keep Node's timers, `queueMicrotask`, `performance` and `MessageChannel`.** Install DOM globals (`window === globalThis`, `document`, interface constructors, `FormData`, `ErrorEvent`, `getSelection`, `requestAnimationFrame`) **before** test files import react-dom.

---

## 17. jsdom vs happy-dom differences that touch React specifically

| Behaviour | jsdom 30.1.3 | happy-dom 21.0.3 | rsdom recommendation |
|---|---|---|---|
| `window.event` during dispatch | set (spec) | always `undefined` | set (spec) |
| `reportError` | absent | absent | absent (React uses the ErrorEvent path) |
| `'AnimationEvent' in window` / `'animation' in style` | false / true (React picks `webkitAnimation*`) | true / true (unprefixed) | true / true |
| `TextEvent` | absent | absent | absent |
| `img.decode` | absent | `Promise.resolve()` | absent or immediate |
| `img.complete` (src set, not loaded) | `false` | `true` | either; consistent with `decode` |
| `onclick` default | `null` | `null` | `null` |
| focusin/focusout on `focus()` | yes | yes | yes |
| UA string | `…jsdom/30.1.3` | `…HappyDOM/21.0.3` | no "Chrome"/"Firefox" substring |

---

## 18. Open questions and things to verify against rsdom later

- Run `trace.js` against rsdom once it exists (add an `IMPL === 'rsdom'` branch). Use the call counts as a regression budget, and the react-dom API set as a conformance checklist.
- The reconciler is not in the sparse clone, so `clearContainer`'s call site and the suspensey lane mask were verified in the published bundle (lines ~14964-14982 and ~17460-17495), not in source.
- The happy-dom trace (`node trace.js happy …`) is incomplete: some happy-dom classes live on the window prototype and weren't instrumented. Its react-dom call set matched jsdom where captured.
- Decide whether rsdom fires `load` for `<link rel=stylesheet>` (§4.9) and `<img>` (`onLoad` tests). jsdom without resources never fires them.
