# Area B status: events, form controls, focus, HTML element specifics

Branch `feat/area-b-events-forms`. ROADMAP M4 (P0 + P1) and the area-B part of M5 (P0 + P1). `element.style`,
`getComputedStyle` and selectors are area A; window/globals/Vitest environment are area C.

## What is implemented

**Rust** (`crates/oxidom/src/forms/`, `crates/oxidom/src/focus.rs`)
- `forms/types.rs`: input type table (5-bit code mirrored into `NodeRec.state`, `text = 0`), value modes,
  value sanitization for every type jsdom sanitizes (text/search/tel/password/url/email(+multiple)/color/
  date/month/week/time/datetime-local/number/range), the date/time/week/month microsyntaxes, valid
  floating-point numbers, e-mail validation. `sanitize` borrows its input when nothing changes.
- `forms/mod.rs`: `FormState` (raw value, UTF-16 selection, custom validity) in `ElementExt.form`; dirty
  value / checkedness / selectedness bits in `state`; `form_ver = ++EP[FORM]` on every value, checkedness,
  selectedness or selection change. Input attribute-change steps (type change value-mode conversion, value
  and checked defaults, name/form), radio groups (name + form owner + tree), checkbox/radio legacy
  pre-activation and canceled activation, textarea (child text while clean, CRLF normalisation), select
  "asked for a reset" algorithm (on option insertion/removal, `selected`/`multiple`/`size` changes, parse,
  reset), option value/text/index, selectedIndex, form owner (`form` attribute), `form.elements`,
  `fieldset.elements`, submittable elements, form reset, HTML "actually disabled" incl. fieldset/legend,
  labelable elements, `label.control`, labels (memoised per root and (EP[TREE], EP[ATTR]), like jsdom's
  label-association memo), constraint validation bits (valueMissing for all control kinds and radio
  groups, email typeMismatch, range under/overflow and stepMismatch for numeric types, customError,
  willValidate; tooLong/tooShort are always false as in jsdom), cloning steps.
- `focus.rs`: focusability (jsdom `isFocusableAreaElement`), `setFocus`/`focusedOf`, `state::FOCUSED`,
  `EP[FOCUS]` for the main document, `EP[14]` focus version, removal fixup without blur, `EP[FOCUS]`
  follows `setMainDocument`.

**JS** (`packages/oxidom/lib/events.cjs`, `packages/oxidom/lib/forms.cjs`)
- EventTarget: listener lists on the wrapper (`_ev`), capture/passive/once/signal, dedup by (callback,
  capture), `handleEvent` looked up at call time, React's passive probe, jsdom's default-passive rule.
- Dispatch: path from the node table's parent links (zero FFI), then document, then window (not for
  `load`); capture/target/bubble over listener snapshots; stopPropagation / stopImmediatePropagation /
  preventDefault / passive / cancelBubble / returnValue / composedPath; return value; `window.event`
  (undefined when idle, restored after each listener); listener exceptions -> cancelable `ErrorEvent` on
  the window -> `process.emit('uncaughtException')` if not canceled; no `reportError`.
- Event classes (all with #private state, extensible instances so user-event can shadow members): Event,
  CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, DragEvent, KeyboardEvent (keyCode/charCode/
  which kept), FocusEvent, InputEvent, CompositionEvent, TouchEvent, ErrorEvent, SubmitEvent,
  AnimationEvent, TransitionEvent, ProgressEvent, PopStateEvent, PageTransitionEvent, HashChangeEvent,
  ClipboardEvent, StorageEvent. No TextEvent. Unknown init keys are ignored.
- Activation (MouseEvent/PointerEvent `click` only): checkbox/radio toggle with revert on cancel then
  `input` + `change`; submit button / image -> request submit (constraint validation unless `novalidate`,
  then a cancelable `SubmitEvent` with `submitter`; no navigation); reset button; label forwards a
  `detail: 1` click to its control (interactive-content rules); summary toggles `details[open]`.
- `HTMLElement#click()` (PointerEvent, detail 0, no-op when disabled incl. a disabled fieldset ancestor,
  re-entrancy guard). GlobalEventHandlers `on*` accessors on HTMLElement/SVGElement/Document prototypes,
  WindowEventHandlers on body/frameset (forwarded to the window) and on the window; return-value
  cancellation and the window `onerror` signature.
- `installWindow(win, document)`: the hidden WindowTarget (listeners, `event`, `on*`, add/remove/
  dispatchEvent) area C binds to `globalThis`; `createWindow()` calls it.
- Form controls: own `value`/`checked` accessors on `HTMLInputElement.prototype` (and `value` on the
  textarea/select prototypes), selection members own on the input and textarea prototypes, value memo in
  `_vm` keyed by FORM_VER (`OXIDOM_NO_MEMO=1` disables it; the setter seeds it when Rust reports that the
  stored value is exactly the argument), selection memo, checked/selected/indeterminate/type from state bits,
  file inputs (`FileList`, `C:\fakepath\` value), valueAsNumber, `list`, all jsdom reflections (incl.
  maxLength/minLength [ReflectNonNegative], size/rows/cols [ReflectPositive]), textarea, select
  (HTMLOptionsCollection with add/remove/length setter, selectedOptions, item/namedItem), option, `new
  Option()`, `new Image()`, button, form (elements = HTMLFormControlsCollection with RadioNodeList,
  method/enctype/action, submit() no-op, requestSubmit, reset, checkValidity), label, fieldset, legend,
  output (value/defaultValue override, htmlFor DOMTokenList), ValidityState, validationMessage,
  setCustomValidity, `formEntries(form, submitter)` (HTML "construct the entry list", equal to jsdom's
  FormData in `test/native/form-entries.test.mjs`).
- Focus: `focus()`/`blur()` on HTMLElement, SVGElement and MathMLElement (jsdom focusing / unfocusing
  steps: blur -> focusout -> focus -> focusin with relatedTarget, `activeElement` cleared before blur,
  blur listeners that move focus win), `document.activeElement` (EP[FOCUS] for the main document).
- HTML element specifics: classList (DOMTokenList memoised by ATTR_VER, index getters on the prototype),
  dataset (Proxy), hidden/title/lang/accessKey/dir/translate/draggable/tabIndex defaults/nonce,
  contentEditable (`'inherit'`) / isContentEditable, URL reflection against the document base URL
  (`<base href>` honoured) for a/area (all URL parts)/img/link/script/iframe/source/embed/media/base/form
  action/formAction, zero geometry, `scrollTop`/`scrollLeft` remember the last value (jsdom parity),
  HTMLImageElement (width/height, complete, `decode()` resolves immediately), HTMLDialogElement
  (open/show/showModal/close/returnValue), HTMLDetailsElement open.

## Tests

- Contract (jsdom oracle, happy-dom pinned where it diverges): `test/contract/events.test.mjs`,
  `forms.test.mjs` (prototype contract, React `trackValueOnNode`, DTL `setNativeValue`, the §6.8 oracle
  table, value modes, sanitization, select/option oracle, UTF-16 selection, labels/forms/reset, fieldset,
  validity), `focus.test.mjs` (§6.9 order oracle, gates, fixup), `html-elements.test.mjs`,
  `user-event.test.mjs` (user-event `type` with emoji: final value and every offset match jsdom).
- oxidom-only: `test/native/events-forms.test.mjs` (a 20-deep dispatch with React-like listeners makes
  zero N-API calls; checkbox activation crosses only for `preActivate` / `cancelActivation`; value memo;
  parser hook; clone; focus epochs; uncaught listener errors), `test/native/react-smoke.test.mjs` (React 19
  createRoot/render/click/onChange for checkbox and text input, label click, focus, unmount, plain Node on
  `createWindow()`), `test/native/form-entries.test.mjs`.
- Rust unit tests in `src/forms/` and `src/focus.rs`. All green with `OXIDOM_SHARED=0` and `OXIDOM_NO_MEMO=1`.

## Benchmarks (`bench/micro/events-forms.mjs`, results in `events-forms*.txt`)

Release build, median of 7, one process per DOM, measured while two other agents shared the 4 CPUs (noisy):

| operation | jsdom | happy-dom | oxidom |
|---|---|---|---|
| add + remove 143 listeners, one container | 96.8 us | 35.1 us | 19.0 us |
| fresh container + 143 new listeners, retained | 75.0 us | 45.7 us | 74.7 us |
| new MouseEvent + dispatch, 20 levels, React-like listeners | 18.4 us | 14.7 us | 4.1 us |
| dispatch only, 20 levels | 11.0 us | 16.3 us | 2.2 us |
| checkbox click() with activation | 27.0 us | 15.4 us | 6.4 us |
| focus() alternating two inputs | 284 us | 13.5 us | 2.4 us |
| document.activeElement | 358 ns | 7.4 ns | 9.8 ns |
| input.value get, unchanged | 67.6 ns | 33.8 ns | 5.9 ns |
| input.value set + get | 1201 ns | 230 ns | 137 ns |
| input.checked get | 31.4 ns | 2.2 ns | 3.4 ns |
| setSelectionRange + selectionStart get | 5393 ns | 3946 ns | 813 ns |
| select.value set + get | 1964 ns | 1209 ns | 216 ns |

Ablations (same run): with `OXIDOM_NO_MEMO=1` an unchanged `input.value` read is a crossing (74 ns, slower
than happy-dom's 64 ns in that run) and set + get is 218 ns; with `OXIDOM_SHARED=0` (crossing-getter fallback)
`input.checked` is 8.4 ns and `setSelectionRange` + `selectionStart` 2.4 us, dispatch stays ~4 us.

Honest reading: events are pure JS in all three DOMs, so the dispatch win is a JS-design effect (table
parent links, #private event state, no per-dispatch struct allocation), not Rust. The form wins come from
Rust-side state plus the FORM_VER memo (see the `-nomemo` / `-fallback` tables for the ablations). The one
loss: creating many containers with fresh listeners is GC-bound in oxidom because every wrapper (and its
listeners) is retained for the env's lifetime (no reclamation, DESIGN §11); one React root per test does not
hit this.

## Divergences and limits (documented)

- Lone surrogates: an intermediate value holding a lone surrogate (user-event types emoji code unit by code
  unit) reads back as U+FFFD (UTF-8 storage, CONTRIBUTING.md §8); final values and offsets match jsdom.
- `labels` returns a fresh static NodeList (jsdom: a live, SameObject one).
- Option selectedness is reset eagerly on child-list changes of the select / optgroup and once per parse; an
  option removed from a deeper non-optgroup wrapper does not trigger a reset (jsdom: any nearest-select change).
- No navigation: following hyperlinks and uncanceled form submission are no-ops (jsdom reports "not implemented").
- `select[i]` / `options[i]` (getter + setter) and `form[i]` (getter) are prototype accessors like the live
  lists' index getters (M7 round 1): `i in select` is true for any `i` below the accessor bound, indices are not
  own properties (`Object.keys`, `hasOwnProperty`), and `Object.defineProperty(select, 0, ...)` succeeds (jsdom's
  Proxy-based legacy platform objects answer per current length and reject the define). Replacing an option
  inside an `<optgroup>` through `select[i] = option` replaces it in its own parent (Chromium); jsdom throws
  NotFoundError. Named form properties (`form.username`) are not implemented (use `elements.namedItem`).
- Focus collapses the document selection to (element, 0) before the focus events, as jsdom does (wired at
  integration through area C's Selection).
- `scrollTop`/`scrollLeft` store the assigned value like jsdom (ROADMAP said "no-op setters").
- Beyond jsdom (happy-dom-like): `contentEditable`/`isContentEditable`, `AnimationEvent`, `TransitionEvent`,
  `DragEvent`, `ClipboardEvent`, dialog `show`/`showModal`/`close`, `img.decode()`.

## Cross-area contracts

- AREA A (integrated): `Env::is_focusable` (now `&mut self`) calls
  `style::cascade::display_none_inclusive_ancestor`, which fills A's computed-style core memo. Selector state:
  `state::{CHECKED, SELECTED, INDETERMINATE, FOCUSED}`, `forms::input_type(e, id)`, `Env::is_disabled(id)`
  (fieldset-aware), `Env::value_into(id, &mut s)` (for `:placeholder-shown`), `Env::is_candidate`-style
  validity via `Env::validity(id)` (bit 16 = willValidate, `vbits`). Epochs: `EP[FORM]` changes with every
  checked/selected/value change, `EP[14]` with every focus change (EP[STYLE] is never bumped by focus).
  `user.clear` in `test/contract/user-event.test.mjs` runs once `Element#matches` exists.
- AREA C: call `require('./events.cjs').installWindow(globalThis, document)` (idempotent) and set
  `document._win` (defaultView; focus needs a window). Expose `rt.classes` (Event classes, `Option`, `Image`,
  `DOMTokenList`, `ValidityState`, `FileList`, ...) as globals, overriding Node's `Event`/`EventTarget`/
  `CustomEvent` so `instanceof` and `dispatchEvent` accept them. React's `reportGlobalError` dispatches an
  ErrorEvent itself: add Vitest's `catchWindowErrors` equivalent (preventDefault + uncaughtException when no
  user `error` listener); listener exceptions then reach the process exactly once. FormData override:
  `require('./forms.cjs').formEntries(form, submitter)`. Epoch page slot 14 is taken by area B.
- Foundation touches (minimal, isolated): `hooks.rs` `hook_parsed(base)` + two calls in `parse.rs`;
  `dom.rs` `setMainDocument` calls `focus::on_main_doc_changed`; `index.cjs` `createWindow()` calls
  `installWindow`.
