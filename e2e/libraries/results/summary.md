# Real-world library compatibility: jsdom vs happy-dom vs rsdom

Generated 2026-10-17T18:23:02.698Z by `e2e/libraries/aggregate.mjs`. Versions: node v22.22.0, vitest 5.0.5, jsdom 30.1.3, happy-dom 21.0.3, react 19.3.1, @testing-library/react 16.3.3, @testing-library/user-event 14.6.8, @testing-library/jest-dom 7.0.1, rsdom working tree, packages/rsdom/native/rsdom.linux-x64-gnu.node.

Each library gets 1 to 3 smoke tests written like app tests: render, then interact with user-event, then assert with jest-dom. The same files run under each DOM, and only `DOM_ENV` changes. The primary run applies the documented test-setup shims (see below). A second run applies no shims.

## Totals

| run | tests | pass | pass + unhandled error | fail | libraries fully passing |
|---|---|---|---|---|---|
| polyfills-jsdom | 41 | 39 | 0 | 2 | 18/20 |
| polyfills-happy-dom | 41 | 38 | 1 | 2 | 17/20 |
| polyfills-rsdom | 41 | 28 | 0 | 13 | 11/20 |
| nopolyfills-jsdom | 41 | 36 | 2 | 3 | 16/20 |
| nopolyfills-happy-dom | 41 | 38 | 1 | 2 | 17/20 |
| nopolyfills-rsdom | 41 | 26 | 1 | 14 | 10/20 |

`error*` means every assertion passed but Vitest reported an unhandled error or rejection from that library's test. Vitest then exits 1, so CI goes red.

## Per library (with documented shims)

| library | version | tests | jsdom | happy-dom | rsdom | without shims (jsdom / happy-dom / rsdom) |
|---|---|---|---|---|---|---|
| downshift | downshift@9.4.0 | 2 | pass 2/2 | pass 2/2 | pass 2/2 | pass / pass / pass |
| @floating-ui/react | @floating-ui/react@0.27.20 | 2 | pass 2/2 | pass 2/2 | pass 2/2 | pass / pass / pass |
| focus-trap + tabbable | focus-trap@8.2.3<br>tabbable@6.5.0 | 3 | pass 3/3 | pass 3/3 | pass 3/3 | pass / pass / pass |
| framer-motion | framer-motion@14.3.0 | 2 | pass 2/2 | error* 2/2 | pass 2/2 | pass / error* / pass |
| @headlessui/react | @headlessui/react@2.2.10 | 3 | pass 3/3 | pass 3/3 | **FAIL** 2/3 | error* / pass / **FAIL** |
| lexical | lexical@0.52.0<br>@lexical/react@0.52.0 | 2 | **FAIL** 1/2 | **FAIL** 1/2 | **FAIL** 1/2 | **FAIL** / **FAIL** / **FAIL** |
| lit | lit@3.3.3 | 2 | pass 2/2 | pass 2/2 | **FAIL** 0/2 | pass / pass / **FAIL** |
| @mui/material | @mui/material@9.5.0<br>@emotion/react@11.14.0<br>@emotion/styled@11.14.1 | 3 | pass 3/3 | pass 3/3 | **FAIL** 2/3 | pass / pass / **FAIL** |
| axios | axios@1.20.0 | 2 | pass 2/2 | pass 2/2 | **FAIL** 1/2 | pass / pass / **FAIL** |
| msw | msw@3.0.3 | 3 | pass 3/3 | pass 3/3 | pass 3/3 | pass / pass / pass |
| @radix-ui/react-dialog | @radix-ui/react-dialog@1.3.1 | 2 | pass 2/2 | pass 2/2 | **FAIL** 0/2 | pass / pass / **FAIL** |
| @radix-ui/react-select | @radix-ui/react-select@2.4.1 | 1 | pass 1/1 | pass 1/1 | pass 1/1 | **FAIL** / pass / **FAIL** |
| @radix-ui/react-dropdown-menu | @radix-ui/react-dropdown-menu@2.2.1 | 1 | pass 1/1 | pass 1/1 | pass 1/1 | pass / pass / pass |
| @radix-ui/react-tabs | @radix-ui/react-tabs@1.2.1 | 1 | pass 1/1 | pass 1/1 | pass 1/1 | pass / pass / pass |
| react-aria-components | react-aria-components@1.22.1 | 3 | pass 3/3 | **FAIL** 2/3 | **FAIL** 0/3 | pass / **FAIL** / **FAIL** |
| react-hook-form | react-hook-form@7.90.0 | 2 | pass 2/2 | pass 2/2 | pass 2/2 | pass / pass / pass |
| react-router | react-router@8.4.0 | 2 | pass 2/2 | pass 2/2 | **FAIL** 1/2 | pass / pass / **FAIL** |
| react-select | react-select@5.10.2 | 2 | pass 2/2 | pass 2/2 | pass 2/2 | pass / pass / pass |
| @tanstack/react-table | @tanstack/react-table@9.3.1 | 1 | pass 1/1 | pass 1/1 | pass 1/1 | pass / pass / pass |
| @tiptap/react | @tiptap/react@3.32.0<br>@tiptap/starter-kit@3.32.0 | 2 | **FAIL** 1/2 | pass 2/2 | **FAIL** 1/2 | **FAIL** / pass / **FAIL** |

## Root causes (each one verified)

### rsdom has no TreeWalker / NodeFilter (document.createTreeWalker undefined)

- **DOM(s):** rsdom. **Category:** missing-api. **Libraries hit:** @headlessui/react, lit, @radix-ui/react-dialog, react-aria-components
- **Evidence:** First error is a ReferenceError/TypeError at the library call site: @radix-ui/react-focus-scope getTabbableCandidates (focus-scope.tsx:350), @headlessui/react hooks/use-tree-walker.js, react-aria overlays/ariaHideOutside.ts:128 and focus/FocusScope.tsx:858 (useHasTabbableChild), lit-html.ts:730 (template walker, at import time). Probe: typeof NodeFilter/createTreeWalker === "undefined" only in rsdom (diag-facts). docs/lab/ROADMAP.md lists TreeWalker as out of scope because "no target library uses them"; the static census (results/census.json) finds createTreeWalker in several of the libraries tested here.

### rsdom has no ShadowRoot global (Shadow DOM out of scope); @mui/utils contains() does `instanceof ShadowRoot` unguarded

- **DOM(s):** rsdom. **Category:** missing-api. **Libraries hit:** @mui/material
- **Evidence:** ReferenceError at @mui/utils/contains/contains.mjs:26 called from @mui/material Unstable_TrapFocus/FocusTrap.mjs:126 (every MUI Modal/Dialog). Probe: typeof ShadowRoot === "undefined" only in rsdom.

### rsdom has no XMLHttpRequest (only Node fetch); axios `adapter: "xhr"` cannot run

- **DOM(s):** rsdom. **Category:** missing-api. **Libraries hit:** axios
- **Evidence:** AxiosError from axios/lib/adapters/adapters.js getAdapter. Default axios adapter list falls through to fetch, so the default-adapter test passes. Probe: typeof XMLHttpRequest === "undefined" only in rsdom.

### rsdom History.back()/forward()/go() are no-ops: no session history, no popstate

- **DOM(s):** rsdom. **Category:** missing-behaviour. **Libraries hit:** react-router
- **Evidence:** pushState works (pathname assertion passes) but after history.back() the route never changes. packages/rsdom/lib/window.cjs History: `back() {}` `forward() {}` `go() {}`. diag-facts: pushState+back -> popstate fired=false, pathname stays /b (jsdom, happy-dom: fired=true, /a).

### rsdom Selection is a stub: collapse()/setBaseAndExtent() set anchor/focus but create no Range (rangeCount 0), so getRangeAt(0) throws

- **DOM(s):** rsdom. **Category:** wrong-behaviour. **Libraries hit:** lexical, @tiptap/react
- **Evidence:** IndexSizeError from packages/rsdom/lib/window.cjs Selection.getRangeAt, called by @testing-library/user-event event/selection/getInputRange.js when typing into any contenteditable. diag-facts: after collapse(text,1) rangeCount=0 in rsdom (1 in jsdom/happy-dom). Spec: collapse() must set a new collapsed range.

### document.elementFromPoint missing; ProseMirror mousedown handler (posAtCoords) throws on every click into the editor

- **DOM(s):** jsdom, rsdom. **Category:** missing-api. **Libraries hit:** @tiptap/react
- **Evidence:** Unhandled TypeError at prosemirror-view posAtCoords (dist/index.js:473) from handlers.mousedown. Probe: elementFromPoint missing in jsdom and rsdom, present in happy-dom.

### jsdom has no Range#getClientRects / Range#getBoundingClientRect; ProseMirror scrollToSelection throws inside dispatchTransaction, so tiptap never emits "update"

- **DOM(s):** jsdom. **Category:** missing-api. **Libraries hit:** @tiptap/react
- **Evidence:** Unhandled TypeError at prosemirror-view singleRect (index.js:529) <- coordsAtPos <- scrollToSelection <- updateState <- @tiptap/core dispatchTransaction; the onUpdate spy is never called. Lexical hits the same gap (getCaretRect, Lexical.dev.js:21695) once typing works. Counterfactual (diagnostics/counterfactual.test.tsx): shimming Range#getClientRects/getBoundingClientRect + elementFromPoint makes the tiptap typing scenario pass in jsdom.

### InputEvent#getTargetRanges missing, so Lexical disables its beforeinput path; its mutation fallback reverts the bare text node user-event inserts (user-event sends input with data=null)

- **DOM(s):** jsdom, happy-dom. **Category:** missing-api+tooling. **Libraries hit:** lexical
- **Evidence:** lexical/dist/Lexical.dev.js:75 CAN_USE_BEFORE_INPUT = 'getTargetRanges' in new InputEvent('input'). Event trace: beforeinput(insertText,'H') not prevented, user-event inserts 'H', MutationObserver record removes it, editor text stays ''. Counterfactual: defining InputEvent.prototype.getTargetRanges before Lexical loads makes typing pass in jsdom and happy-dom (rsdom already has it, but fails on the Selection stub).

### happy-dom: `document instanceof window.Document` is false (per-window Document subclass); react-aria isFocusWithin() returns false and useDialog steals focus from the autoFocus field

- **DOM(s):** happy-dom. **Category:** wrong-behaviour. **Libraries hit:** react-aria-components
- **Evidence:** Focus trace: react-aria focuses the autoFocus <input>, then useDialog.mjs:34 focuses the dialog <section> because isFocusWithin (utils/shadowdom/DOMFunctions.mjs) checks `root instanceof ownerWindow.Document`. diag-facts: false only in happy-dom (prototype chain HTMLDocument>HTMLDocument>Document, window.Document is a different subclass). Counterfactual: a Symbol.hasInstance fix on window.Document makes the scenario pass.

### happy-dom Animation.cancel() rejects `finished` without marking it handled -> Node unhandled rejection (spec: set [[PromiseIsHandled]] = true)

- **DOM(s):** happy-dom. **Category:** wrong-behaviour. **Libraries hit:** framer-motion
- **Evidence:** Unhandled Rejection AbortError from happy-dom/lib/animation/Animation.js:161 via motion-dom NativeAnimation.cancel (framer-motion uses WAAPI only where element.animate exists, i.e. only in happy-dom). Web Animations "cancel an animation" step 1.3 sets [[PromiseIsHandled]] on the rejected promise. Assertions pass; Vitest still fails the run (exit 1).

### Element#hasPointerCapture missing; Radix Select trigger pointerdown throws (only without the documented shim)

- **DOM(s):** jsdom, rsdom. **Category:** missing-api (documented shim). **Libraries hit:** @radix-ui/react-select (no-shim run only)
- **Evidence:** Unhandled TypeError at @radix-ui/react-select dist/index.mjs:230 (trigger onPointerDown); the listbox never opens. Passes once the shim from tests/setup.ts is applied. happy-dom implements pointer capture natively.

### ResizeObserver missing; Headless UI element-movement tracking throws (only without the documented shim)

- **DOM(s):** jsdom, rsdom. **Category:** missing-api (documented shim). **Libraries hit:** @headlessui/react (no-shim run only)
- **Evidence:** Unhandled ReferenceError at @headlessui/react dist/utils/element-movement.js from menu/listbox machines. happy-dom implements ResizeObserver natively.

Every failing test and every unhandled error, in all six runs, maps to one of the causes above (`unexplained` is empty).

## Counterfactual checks (diagnostics/counterfactual.test.tsx)

Each check re-runs a failing scenario after shimming only the API named as the root cause. A pass confirms the diagnosis. On rsdom these scenarios hit an earlier blocker first, which is listed below.

| scenario | jsdom | happy-dom | rsdom |
|---|---|---|---|
| with getTargetRanges shimmed before lexical loads, user-event typing reaches the editor | pass, then unhandled: TypeError: range.getBoundingClientRect is not a function | pass | fail (rsdom-selection-stub) |
| with those three shimmed (zero rects / null), click + type updates the editor and fires onUpdate | pass | pass | fail (rsdom-selection-stub) |
| with Symbol.hasInstance fixed on window.Document, the autoFocus field keeps focus | pass | pass | fail (rsdom-no-treewalker) |

## Shims ("polyfills")

Only shims that library docs or the Jest docs tell jsdom users to add are allowed: `matchMedia`, `ResizeObserver`, `Element#scrollIntoView`, and `Element#hasPointerCapture`/`setPointerCapture`/`releasePointerCapture`. Each one is installed only when the API is missing. The two "Testing in JSDom" READMEs of tabbable and focus-trap say to pass `displayCheck: 'none'`, and the tests do that for every DOM. The shims each DOM actually needed:

- jsdom: matchMedia, ResizeObserver, scrollIntoView, hasPointerCapture, setPointerCapture, releasePointerCapture
- happy-dom: none (all present natively)
- rsdom: ResizeObserver, scrollIntoView, hasPointerCapture, setPointerCapture, releasePointerCapture

Without shims, Radix Select and Headless UI fail on jsdom and on rsdom. happy-dom needs no shims.

## Static census: DOM APIs referenced by the 20 libraries

Method: regex search of the shipped `.js`/`.mjs`/`.cjs` of each library plus its dependency closure, excluding react and react-dom. "Used by" means the identifier appears in the code. It does not mean a test executed it. The Range rows also require `createRange` or `getRangeAt` in the same file, which approximates the receiver. "Native" is measured inside each Vitest environment with no shims (`tests/_env-probe.test.ts`, `LIBS_POLYFILLS=0`).

| API | area | used by (of 20) | jsdom | happy-dom | rsdom |
|---|---|---|---|---|---|
| getComputedStyle | css | 14 | yes | yes | yes |
| requestAnimationFrame | observers | 13 | yes | yes | yes |
| Element#getBoundingClientRect | geometry | 12 | yes | yes | yes |
| MutationObserver | observers | 12 | yes | yes | yes |
| ShadowRoot (global) | shadow-dom | 11 | yes | yes | **no** |
| offsetWidth/offsetHeight/offsetParent | geometry | 11 | yes | yes | yes |
| IntersectionObserver | observers | 11 | **no** | yes | **no** |
| scrollIntoView | geometry | 10 | **no** | yes | **no** |
| visualViewport | geometry | 10 | **no** | **no** | **no** |
| ResizeObserver | observers | 10 | **no** | yes | **no** |
| inert | html | 10 | **no** | yes | **no** |
| CSS.supports/CSS.escape | css | 10 | yes | yes | yes |
| composedPath | shadow-dom | 9 | yes | yes | yes |
| Element#getClientRects | geometry | 9 | yes | yes | yes |
| getSelection | editing | 8 | yes | yes | yes |
| isContentEditable | editing | 8 | **no** | yes | yes |
| Element#scrollTo | geometry | 8 | **no** | yes | **no** |
| checkVisibility | geometry | 8 | **no** | yes | **no** |
| createTreeWalker | traversal | 7 | yes | yes | **no** |
| NodeFilter | traversal | 7 | yes | yes | **no** |
| assignedNodes/assignedElements | shadow-dom | 6 | yes | yes | **no** |
| CompositionEvent | events | 6 | yes | yes | yes |
| matchMedia | observers | 5 | **no** | yes | yes |
| PointerEvent | events | 5 | yes | yes | yes |
| CSSStyleSheet#insertRule | css | 5 | yes | yes | **no** |
| createRange | editing | 4 | yes | yes | yes |
| Selection collapse()/setBaseAndExtent() creates a Range | editing | 4 | yes | yes | **no** |
| InputEvent#getTargetRanges | editing | 4 | **no** | **no** | yes |
| caretRangeFromPoint/caretPositionFromPoint | editing | 4 | **no** | **no** | **no** |
| Range#getBoundingClientRect | geometry | 4 | **no** | yes | yes |
| elementFromPoint | geometry | 4 | **no** | yes | **no** |
| setPointerCapture/hasPointerCapture | events | 4 | **no** | yes | **no** |
| DataTransfer | events | 4 | **no** | yes | **no** |
| fetch | network | 4 | yes | yes | yes |
| getAnimations | animation | 3 | **no** | yes | **no** |
| TouchEvent | events | 3 | yes | yes | yes |
| adoptedStyleSheets | css | 3 | **no** | yes | **no** |
| DOMParser | misc | 3 | yes | yes | yes |
| execCommand | editing | 2 | **no** | **no** | **no** |
| Range#getClientRects | geometry | 2 | **no** | yes | yes |
| XMLHttpRequest | network | 2 | yes | yes | **no** |
| attachShadow | shadow-dom | 1 | yes | yes | **no** |
| customElements | shadow-dom | 1 | yes | yes | **no** |
| elementsFromPoint | geometry | 1 | **no** | **no** | **no** |
| Element#animate (WAAPI) | animation | 1 | **no** | yes | **no** |
| history.pushState | html | 1 | yes | yes | yes |
| history traversal fires popstate | html | 1 | yes | yes | **no** |
| createNodeIterator | traversal | 0 | yes | yes | **no** |
| dialog.showModal | html | 0 | **no** | yes | yes |
| popover API | html | 0 | **no** | **no** | **no** |

### Referenced-but-missing APIs per DOM (count of libraries referencing each)

- **jsdom** (21 APIs): IntersectionObserver (11), scrollIntoView (10), visualViewport (10), ResizeObserver (10), inert (10), isContentEditable (8), Element#scrollTo (8), checkVisibility (8), matchMedia (5), InputEvent#getTargetRanges (4), caretRangeFromPoint/caretPositionFromPoint (4), Range#getBoundingClientRect (4), elementFromPoint (4), setPointerCapture/hasPointerCapture (4), DataTransfer (4), getAnimations (3), adoptedStyleSheets (3), execCommand (2), Range#getClientRects (2), elementsFromPoint (1), Element#animate (WAAPI) (1)
- **happy-dom** (5 APIs): visualViewport (10), InputEvent#getTargetRanges (4), caretRangeFromPoint/caretPositionFromPoint (4), execCommand (2), elementsFromPoint (1)
- **rsdom** (26 APIs): ShadowRoot (global) (11), IntersectionObserver (11), scrollIntoView (10), visualViewport (10), ResizeObserver (10), inert (10), Element#scrollTo (8), checkVisibility (8), createTreeWalker (7), NodeFilter (7), assignedNodes/assignedElements (6), CSSStyleSheet#insertRule (5), Selection collapse()/setBaseAndExtent() creates a Range (4), caretRangeFromPoint/caretPositionFromPoint (4), elementFromPoint (4), setPointerCapture/hasPointerCapture (4), DataTransfer (4), getAnimations (3), adoptedStyleSheets (3), execCommand (2), XMLHttpRequest (2), attachShadow (1), customElements (1), elementsFromPoint (1), Element#animate (WAAPI) (1), history traversal fires popstate (1)

## Caveats

- These are smoke tests, 1 to 3 per library. A pass shows that a typical happy path works. It does not prove full compatibility.
- Static census hits come from identifier presence. Many are feature-detected or sit on code paths the tests never reach. Use them as a risk indicator. They do not predict failures.
- Typing into contenteditable editors (Lexical, tiptap) also depends on how @testing-library/user-event simulates input. The Lexical typing failure on jsdom and happy-dom is partly a tooling limit. The counterfactual shows that the missing `getTargetRanges` is enough to explain it.
- Unhandled errors are attributed to a test with Vitest's "last test to run" heuristic.
- On rsdom, 8 tests stop at the first missing API (mostly TreeWalker/NodeFilter, including lit at import). Gaps further along those scenarios (for example Shadow DOM for lit) are therefore not observed.
