// Verified root causes. aggregate.mjs matches every failing test / unhandled error of every run
// against this table (dom + file + message regex); anything unmatched is reported as UNEXPLAINED.
// `evidence` says how each cause was verified (stack frame, probe fact, or counterfactual run).
export const CAUSES = [
  {
    id: 'rsdom-no-treewalker', category: 'missing-api', doms: ['rsdom'],
    title: 'rsdom has no TreeWalker / NodeFilter (document.createTreeWalker undefined)',
    re: /NodeFilter is not defined|createTreeWalker is not a function/,
    evidence: 'First error is a ReferenceError/TypeError at the library call site: @radix-ui/react-focus-scope getTabbableCandidates (focus-scope.tsx:350), @headlessui/react hooks/use-tree-walker.js, react-aria overlays/ariaHideOutside.ts:128 and focus/FocusScope.tsx:858 (useHasTabbableChild), lit-html.ts:730 (template walker, at import time). Probe: typeof NodeFilter/createTreeWalker === "undefined" only in rsdom (diag-facts). docs/lab/ROADMAP.md lists TreeWalker as out of scope because "no target library uses them"; the static census (results/census.json) finds createTreeWalker in several of the libraries tested here.',
  },
  {
    id: 'rsdom-no-shadowroot-global', category: 'missing-api', doms: ['rsdom'],
    title: 'rsdom has no ShadowRoot global (Shadow DOM out of scope); @mui/utils contains() does `instanceof ShadowRoot` unguarded',
    re: /ShadowRoot is not defined/,
    evidence: 'ReferenceError at @mui/utils/contains/contains.mjs:26 called from @mui/material Unstable_TrapFocus/FocusTrap.mjs:126 (every MUI Modal/Dialog). Probe: typeof ShadowRoot === "undefined" only in rsdom.',
  },
  {
    id: 'rsdom-no-custom-elements', category: 'missing-api', doms: ['rsdom'],
    title: 'rsdom has no customElements: lit falls back to @lit-labs/ssr-dom-shim, whose registry never upgrades elements',
    re: /to be an instance of CounterButton|Cannot read properties of null \(reading 'querySelector'\)/, file: /lit/,
    evidence: 'Since TreeWalker landed (2026-10-19) lit imports, then @lit/reactive-element/node/reactive-element.js runs `globalThis.customElements ??= <ssr-dom-shim registry>`: define() succeeds but parsed <counter-button> is never upgraded (not an instance of the class), so it never renders into a shadow root. Probe: typeof customElements === "undefined" only in rsdom (diag-facts). attachShadow exists since 2026-10-20 (ROADMAP Stage 1 ShadowRoot); custom elements are Stage 4.',
  },
  {
    id: 'no-elementFromPoint', category: 'missing-api', doms: ['jsdom', 'rsdom'],
    title: 'document.elementFromPoint missing; ProseMirror mousedown handler (posAtCoords) throws on every click into the editor',
    re: /elementFromPoint is not a function/,
    evidence: 'Unhandled TypeError at prosemirror-view posAtCoords (dist/index.js:473) from handlers.mousedown. Probe: elementFromPoint missing in jsdom and rsdom, present in happy-dom.',
  },
  {
    id: 'jsdom-no-range-geometry', category: 'missing-api', doms: ['jsdom'],
    title: 'jsdom has no Range#getClientRects / Range#getBoundingClientRect; ProseMirror scrollToSelection throws inside dispatchTransaction, so tiptap never emits "update"',
    re: /getClientRects is not a function|getBoundingClientRect is not a function|to be called at least once/, file: /tiptap|counterfactual|lexical/,
    evidence: 'Unhandled TypeError at prosemirror-view singleRect (index.js:529) <- coordsAtPos <- scrollToSelection <- updateState <- @tiptap/core dispatchTransaction; the onUpdate spy is never called. Lexical hits the same gap (getCaretRect, Lexical.dev.js:21695) once typing works. Counterfactual (diagnostics/counterfactual.test.tsx): shimming Range#getClientRects/getBoundingClientRect + elementFromPoint makes the tiptap typing scenario pass in jsdom.',
  },
  {
    id: 'no-getTargetRanges', category: 'missing-api+tooling', doms: ['jsdom', 'happy-dom'],
    title: 'InputEvent#getTargetRanges missing, so Lexical disables its beforeinput path; its mutation fallback reverts the bare text node user-event inserts (user-event sends input with data=null)',
    re: /last "vi\.fn\(\)" call to have been called with \[ 'Hi' \]/, file: /lexical/,
    evidence: "lexical/dist/Lexical.dev.js:75 CAN_USE_BEFORE_INPUT = 'getTargetRanges' in new InputEvent('input'). Event trace: beforeinput(insertText,'H') not prevented, user-event inserts 'H', MutationObserver record removes it, editor text stays ''. Counterfactual: defining InputEvent.prototype.getTargetRanges before Lexical loads makes typing pass in jsdom and happy-dom (rsdom has it; since its Selection holds a real Range, 2026-10-20, Lexical typing passes there).",
  },
  {
    id: 'happy-dom-document-instanceof', category: 'wrong-behaviour', doms: ['happy-dom'],
    title: 'happy-dom: `document instanceof window.Document` is false (per-window Document subclass); react-aria isFocusWithin() returns false and useDialog steals focus from the autoFocus field',
    re: /toHaveFocus/, file: /react-aria/,
    evidence: 'Focus trace: react-aria focuses the autoFocus <input>, then useDialog.mjs:34 focuses the dialog <section> because isFocusWithin (utils/shadowdom/DOMFunctions.mjs) checks `root instanceof ownerWindow.Document`. diag-facts: false only in happy-dom (prototype chain HTMLDocument>HTMLDocument>Document, window.Document is a different subclass). Counterfactual: a Symbol.hasInstance fix on window.Document makes the scenario pass.',
  },
  {
    id: 'happy-dom-animation-cancel-unhandled', category: 'wrong-behaviour', doms: ['happy-dom'],
    title: 'happy-dom Animation.cancel() rejects `finished` without marking it handled -> Node unhandled rejection (spec: set [[PromiseIsHandled]] = true)',
    re: /The animation was canceled/,
    evidence: 'Unhandled Rejection AbortError from happy-dom/lib/animation/Animation.js:161 via motion-dom NativeAnimation.cancel (framer-motion uses WAAPI only where element.animate exists, i.e. only in happy-dom). Web Animations "cancel an animation" step 1.3 sets [[PromiseIsHandled]] on the rejected promise. Assertions pass; Vitest still fails the run (exit 1).',
  },
  {
    id: 'no-pointer-capture', category: 'missing-api (documented shim)', doms: ['jsdom'],
    title: 'Element#hasPointerCapture missing; Radix Select trigger pointerdown throws (only without the documented shim)',
    re: /hasPointerCapture is not a function|Unable to find role="option" and name "Banana"/,
    evidence: 'Unhandled TypeError at @radix-ui/react-select dist/index.mjs:230 (trigger onPointerDown); the listbox never opens. Passes once the shim from tests/setup.ts is applied. happy-dom implements pointer capture natively, rsdom since 2026-10-20 (packages/rsdom/lib/observers.cjs).',
  },
  {
    id: 'no-resizeobserver', category: 'missing-api (documented shim)', doms: ['jsdom'],
    title: 'ResizeObserver missing; Headless UI element-movement tracking throws (only without the documented shim)',
    re: /ResizeObserver is not defined/,
    evidence: 'Unhandled ReferenceError at @headlessui/react dist/utils/element-movement.js from menu/listbox machines. happy-dom implements ResizeObserver natively, rsdom since 2026-10-20 (inert, packages/rsdom/lib/observers.cjs).',
  },
]
