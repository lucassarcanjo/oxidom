// DOM APIs for the static census (census.mjs) and the runtime availability probe
// (tests/_env-probe.test.ts). `re` is matched against library dist code; `probe` is evaluated
// inside each Vitest DOM environment and must return true when the API is usable. `andRe`, when set,
// must ALSO match the same file (used to approximate the receiver, e.g. Range vs Element geometry).
export const APIS = [
  // traversal
  { id: 'createTreeWalker', area: 'traversal', re: /\bcreateTreeWalker\b/, probe: "typeof document.createTreeWalker === 'function'" },
  { id: 'NodeFilter', area: 'traversal', re: /\bNodeFilter\b/, probe: "typeof NodeFilter !== 'undefined'" },
  { id: 'createNodeIterator', area: 'traversal', re: /\bcreateNodeIterator\b/, probe: "typeof document.createNodeIterator === 'function'" },
  // shadow DOM / custom elements
  { id: 'attachShadow', area: 'shadow-dom', re: /\battachShadow\b/, probe: "typeof Element.prototype.attachShadow === 'function'" },
  { id: 'ShadowRoot (global)', area: 'shadow-dom', re: /\bShadowRoot\b/, probe: "typeof ShadowRoot === 'function'" },
  { id: 'customElements', area: 'shadow-dom', re: /\bcustomElements\b/, probe: "typeof customElements === 'object' && customElements !== null" },
  { id: 'composedPath', area: 'shadow-dom', re: /\bcomposedPath\b/, probe: "typeof Event.prototype.composedPath === 'function'" },
  { id: 'assignedNodes/assignedElements', area: 'shadow-dom', re: /\bassigned(Nodes|Elements)\b/, probe: "typeof HTMLSlotElement === 'function' && typeof HTMLSlotElement.prototype.assignedNodes === 'function'" },
  // editing / selection
  { id: 'getSelection', area: 'editing', re: /\bgetSelection\b/, probe: "typeof getSelection === 'function'" },
  { id: 'createRange', area: 'editing', re: /\bcreateRange\b/, probe: "typeof document.createRange === 'function'" },
  { id: 'Selection collapse()/setBaseAndExtent() creates a Range', area: 'editing', re: /\bsetBaseAndExtent\b|\.collapse\(/, andRe: /\bgetSelection\b/, probe: "(() => { const p = document.createElement('p'); p.textContent = 'ab'; document.body.appendChild(p); const s = getSelection(); s.removeAllRanges(); s.collapse(p.firstChild, 1); const ok = s.rangeCount === 1; s.removeAllRanges(); p.remove(); return ok })()" },
  { id: 'execCommand', area: 'editing', re: /\bexecCommand\b/, probe: "typeof document.execCommand === 'function'" },
  { id: 'isContentEditable', area: 'editing', re: /\b(isContentEditable|contentEditable)\b/, probe: "'isContentEditable' in HTMLElement.prototype" },
  { id: 'InputEvent#getTargetRanges', area: 'editing', re: /\bgetTargetRanges\b/, probe: "typeof InputEvent === 'function' && 'getTargetRanges' in InputEvent.prototype" },
  { id: 'caretRangeFromPoint/caretPositionFromPoint', area: 'editing', re: /\bcaret(Range|Position)FromPoint\b/, probe: "typeof document.caretRangeFromPoint === 'function' || typeof document.caretPositionFromPoint === 'function'" },
  // geometry / layout
  { id: 'Element#getBoundingClientRect', area: 'geometry', re: /\bgetBoundingClientRect\b/, probe: "typeof Element.prototype.getBoundingClientRect === 'function'" },
  { id: 'Range#getBoundingClientRect', area: 'geometry', re: /\bgetBoundingClientRect\b/, andRe: /\b(createRange|getRangeAt)\b/, probe: "typeof Range === 'function' && typeof Range.prototype.getBoundingClientRect === 'function'" },
  { id: 'Element#getClientRects', area: 'geometry', re: /\bgetClientRects\b/, probe: "typeof Element.prototype.getClientRects === 'function'" },
  { id: 'Range#getClientRects', area: 'geometry', re: /\bgetClientRects\b/, andRe: /\b(createRange|getRangeAt)\b/, probe: "typeof Range === 'function' && typeof Range.prototype.getClientRects === 'function'" },
  { id: 'elementFromPoint', area: 'geometry', re: /\belementFromPoint\b/, probe: "typeof document.elementFromPoint === 'function'" },
  { id: 'elementsFromPoint', area: 'geometry', re: /\belementsFromPoint\b/, probe: "typeof document.elementsFromPoint === 'function'" },
  { id: 'scrollIntoView', area: 'geometry', re: /\bscrollIntoView\b/, probe: "typeof Element.prototype.scrollIntoView === 'function'" },
  { id: 'Element#scrollTo', area: 'geometry', re: /\.scrollTo\(/, probe: "typeof Element.prototype.scrollTo === 'function'" },
  { id: 'offsetWidth/offsetHeight/offsetParent', area: 'geometry', re: /\boffset(Width|Height|Parent)\b/, probe: "'offsetWidth' in HTMLElement.prototype" },
  { id: 'checkVisibility', area: 'geometry', re: /\bcheckVisibility\b/, probe: "typeof Element.prototype.checkVisibility === 'function'" },
  { id: 'visualViewport', area: 'geometry', re: /\bvisualViewport\b/, probe: "typeof visualViewport === 'object' && visualViewport !== null" },
  // observers / timing / media
  { id: 'ResizeObserver', area: 'observers', re: /\bResizeObserver\b/, probe: "typeof ResizeObserver === 'function'" },
  { id: 'IntersectionObserver', area: 'observers', re: /\bIntersectionObserver\b/, probe: "typeof IntersectionObserver === 'function'" },
  { id: 'MutationObserver', area: 'observers', re: /\bMutationObserver\b/, probe: "typeof MutationObserver === 'function'" },
  { id: 'matchMedia', area: 'observers', re: /\bmatchMedia\b/, probe: "typeof matchMedia === 'function'" },
  { id: 'requestAnimationFrame', area: 'observers', re: /\brequestAnimationFrame\b/, probe: "typeof requestAnimationFrame === 'function'" },
  { id: 'Element#animate (WAAPI)', area: 'animation', re: /\.animate\(/, probe: "typeof Element.prototype.animate === 'function'" },
  { id: 'getAnimations', area: 'animation', re: /\bgetAnimations\b/, probe: "typeof Element.prototype.getAnimations === 'function'" },
  // pointer / input events
  { id: 'setPointerCapture/hasPointerCapture', area: 'events', re: /\b(set|has|release)PointerCapture\b/, probe: "typeof Element.prototype.hasPointerCapture === 'function' && typeof Element.prototype.setPointerCapture === 'function'" },
  { id: 'PointerEvent', area: 'events', re: /\bPointerEvent\b/, probe: "typeof PointerEvent === 'function'" },
  { id: 'TouchEvent', area: 'events', re: /\bTouchEvent\b/, probe: "typeof TouchEvent === 'function'" },
  { id: 'CompositionEvent', area: 'events', re: /\bCompositionEvent\b|compositionstart/, probe: "typeof CompositionEvent === 'function'" },
  { id: 'DataTransfer', area: 'events', re: /\bDataTransfer\b/, probe: "typeof DataTransfer === 'function'" },
  // HTML features
  { id: 'inert', area: 'html', re: /\binert\b/, probe: "'inert' in HTMLElement.prototype" },
  { id: 'dialog.showModal', area: 'html', re: /\bshowModal\b/, probe: "typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function'" },
  { id: 'popover API', area: 'html', re: /\b(showPopover|togglePopover|hidePopover)\b/, probe: "typeof HTMLElement.prototype.showPopover === 'function'" },
  { id: 'history.pushState', area: 'html', re: /\bpushState\b/, probe: "typeof history.pushState === 'function'" },
  { id: 'history traversal fires popstate', area: 'html', re: /\bpopstate\b/, probe: null /* async: see diagnostics/facts.test.ts */ },
  // CSS
  { id: 'getComputedStyle', area: 'css', re: /\bgetComputedStyle\b/, probe: "typeof getComputedStyle === 'function'" },
  { id: 'CSSStyleSheet#insertRule', area: 'css', re: /\binsertRule\b/, probe: "typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.insertRule === 'function'" },
  { id: 'adoptedStyleSheets', area: 'css', re: /\badoptedStyleSheets\b/, probe: "'adoptedStyleSheets' in Document.prototype || 'adoptedStyleSheets' in document" },
  { id: 'CSS.supports/CSS.escape', area: 'css', re: /\bCSS\.(supports|escape)\b/, probe: "typeof CSS === 'object' && typeof CSS.supports === 'function' && typeof CSS.escape === 'function'" },
  // network / misc
  { id: 'XMLHttpRequest', area: 'network', re: /\bXMLHttpRequest\b/, probe: "typeof XMLHttpRequest === 'function'" },
  { id: 'fetch', area: 'network', re: /\bfetch\(/, probe: "typeof fetch === 'function'" },
  { id: 'DOMParser', area: 'misc', re: /\bDOMParser\b/, probe: "typeof DOMParser === 'function'" },
]
