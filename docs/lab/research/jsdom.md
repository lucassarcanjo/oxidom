# jsdom 30.1.3: architecture, hot spots and spec traps (requirements for rsdom)

Scope: what jsdom provides that React 19 + Testing Library rely on, where jsdom spends its time,
and which spec behaviours are easy to get wrong. It also covers how the Vitest jsdom environment
installs the window onto `globalThis`.

Companion notes, not repeated here:
- `docs/lab/research/app-notes.md`: the benchmark app and the per-consumer DOM API list.
- `docs/lab/research/react-dom.md`: everything react-dom touches.

This file is the jsdom-side view. Each item is mapped to the jsdom source that implements it, so
that rsdom can copy the semantics without copying the costs.

Path conventions:
- `jsdom/...`, `vitest/...`, `dom-testing-library/...` etc. are relative to `refs`.
- The webidl2js-**generated** wrappers are not in the git clone, because they are produced by
  `npm run prepare` (`jsdom/package.json` "wireit" `prepare:convert-idl`, `scripts/webidl/convert.js`).
  They are cited from the installed package, `e2e/react-app/node_modules/jsdom/lib/generated/idl/*.js`, which is
  the same version (30.1.3).
- jsdom's selector engine `@asamuzakjp/dom-selector` (10.0.3) is not cloned either. It is cited from
  `e2e/react-app/node_modules/@asamuzakjp/dom-selector/src/...`.

Measurements: these are single-machine runs (4 vCPU container, Node 22.22.0, jsdom 30.1.3), so treat
them as indicative. Run-to-run noise is up to about 2x for the selector numbers. The scripts are in
`docs/lab/research/jsdom-probes/` and the raw output is in `docs/lab/research/jsdom-probes/results-jsdom-30.1.3.txt`.

---

## 0. TL;DR

1. **The selector engine is no longer nwsapi.** jsdom 30 uses `@asamuzakjp/dom-selector`
   (`jsdom/package.json` deps; `jsdom/lib/jsdom/living/nodes/Document-impl.js:270-281`). That library
   embeds a fork of nwsapi 2.2.2 (`e2e/react-app/node_modules/@asamuzakjp/dom-selector/src/js/nwsapi.js:1-5`),
   but uses it **only for `matches`/`closest`/internal `check`**. `querySelector(All)` never takes the
   nwsapi path (`.../src/js/selector.js:236-239`). They go through a css-tree-AST "Finder" that walks
   the tree with `document.createTreeWalker` on **public wrappers**
   (`.../src/index.js:#wrapNode`, `.../src/js/traverser.js:68-80`).
2. **cssstyle has been absorbed into jsdom.** `CSSStyleDeclaration` now lives in
   `jsdom/lib/jsdom/living/css/CSSStyleDeclaration-impl.js` and 60+ property handlers in
   `jsdom/lib/jsdom/living/css/properties/*.js`. It parses with `css-tree` and handles colours with
   `@asamuzakjp/css-color`. The generated `CSSStyleProperties` wrapper is 47,854 lines with 1,638
   property accessors.
3. **symbol-tree is gone.** Tree links are in `jsdom/lib/jsdom/living/helpers/dom-tree.js`: a lazily
   allocated `Links` record per node with O(1) `childCount` and a cached sibling index.
4. **Two JS objects per node, created eagerly.** Every node is a wrapper (branded with private fields)
   plus an impl. Every `HTMLElement` also eagerly allocates its `style` declaration, which is an impl, a
   wrapper and a **Proxy** (`jsdom/lib/jsdom/living/nodes/HTMLElement-impl.js:20`,
   `jsdom/lib/jsdom/living/css/ElementCSSInlineStyle-impl.js:5-10`). That comes to about **1.6 KB of
   heap per `<div>`** and **~2.5 µs per `createElement`**.
5. **Every public call pays a fixed tax of ~200-250 ns**:
   - brand check `$requireImpl`
   - webidl-conversions
   - `[CEReactions]` stack push/pop, even on some getters
   - `tryWrapperForImpl` on the return value

   rsdom pays an N-API crossing instead. It is only faster if a crossing costs less than this, or if
   more work happens per crossing.
6. **Mutations do broad, eager invalidation.** Each insert or remove:
   - bumps `_version` on **every ancestor**
   - drops memoized collections
   - resets the **whole document's computed-style cache**
   - clears the selector engine's result caches
   - walks the inserted or removed subtree several times (id cache, window named props, insertion
     steps, CE reactions, post-connection steps, `_cachedRoot` reset)

   See `jsdom/lib/jsdom/living/nodes/Node-impl.js:472-485, 1012-1127, 1202-1292`.
7. **The biggest single hot spot for Testing Library is `getComputedStyle` after any mutation.** A
   cold read costs 150-700 µs, because the cascade re-runs against the 112-block UA stylesheet and
   inherited properties walk the ancestors. A warm read costs 2-60 µs. Focus changes clear the style
   cache too (`Document-impl.js:262-267`), and `focus()` computes `display` for every ancestor
   (`helpers/focusing.js:31-42`), so **`el.focus()` costs ~450-650 µs**.
8. **`querySelectorAll` costs 0.25-15 ms on a 3,000-element subtree.** The Testing Library role
   selector `*[role~="link"],a[href],area[href]` takes ~12 ms per call (measured). Role queries call it
   per query and then call `matches()` per candidate.
9. **Most of the environment cost is module load, not window creation.**
   - `require("jsdom")` takes **~630-740 ms**: 3,651 module loads, of which the generated IDL wrappers
     are about 150 ms, undici 65 ms, css-tree 64 ms and dom-selector 63 ms.
   - `new JSDOM()` takes ~85 ms the first time and ~9 ms after that.
   - Vitest pays this once per test file, which is about 0.85 s/file in `app-notes.md`.

   A native addon with a slim JS facade can win here by an order of magnitude.
10. **The Vitest jsdom environment** uses `runScripts: 'dangerously'` (a separate `vm` realm) and
    `pretendToBeVisual: true`. `populateGlobal` then copies about 485 window own-properties onto Node's
    `globalThis` as get/set accessors, and binds lower-case functions to the window. It sets
    `window/self/top/parent = globalThis` and redefines `document.defaultView` to return
    `globalThis`. jsdom's `DOMException`, its TypeErrors and its typed arrays come from **another
    realm**: `instanceof Error` and `instanceof Uint8Array` are false in the test realm (measured).
    rsdom should not reproduce that.
11. **jsdom quirks the suite can see** (measured; tests may rely on these accidentally):
    - `getComputedStyle()` returns a **snapshot**, not a live object.
    - Detached elements still get UA-default computed values (`div` gives `display: block`).
    - All layout APIs return 0.
    - `matchMedia`, `scrollIntoView`, `ResizeObserver` and `DataTransfer` are absent.
    - `HTMLElement.click()` dispatches a `PointerEvent` with `detail 0`.
    - `event.timeStamp` is `Date.now()`.
    - Removing the focused element moves focus to `body` with **no** blur event.
    - Listener exceptions are reported through a window `error` event. Vitest turns that into an
      uncaught exception.

---

## 1. Layered architecture

### 1.1 Three layers: generated wrapper → impl → helpers

| layer | where | role |
|---|---|---|
| WebIDL sources | `jsdom/lib/jsdom/living/**/X.webidl` | Interface definitions, extended attributes `[CEReactions]`, `[Reflect]`, `[SameObject]`, `[LegacyUnforgeable]`, ... |
| Generated wrappers | `e2e/react-app/node_modules/jsdom/lib/generated/idl/X.js` (281 files) | The public classes installed on `window`. They do argument conversion, brand checks, `[Reflect]` code, Proxies for legacy platform objects, and CEReactions bracketing. |
| Impl classes | `jsdom/lib/jsdom/living/**/X-impl.js` | The real algorithms. Plain JS classes with `_underscored` internals; mixins via `utils.mixin` (`jsdom/lib/jsdom/living/nodes/Element-impl.js:546-550`). |
| Helpers | `jsdom/lib/jsdom/living/helpers/*.js`, `jsdom/lib/jsdom/living/attributes.js`, `jsdom/lib/jsdom/living/node.js` | Tree links, mutation observers, focus, forms, shadow DOM, events, strings |
| Browser glue | `jsdom/lib/jsdom/browser/Window.js`, `browser/parser/*.js`, `browser/default-stylesheet.css` | Window object, timers, rAF, getComputedStyle, parse5 adapter, UA stylesheet |

**Wrapper and impl pairing** (`e2e/react-app/node_modules/jsdom/lib/generated/idl/utils.js`):

- `WrapperData.registerWrapper(wrapper, impl, interfaceDescriptor)` stamps two private fields
  (`#impl`, `#interfaceDescriptor`) onto the wrapper. Private fields mean the wrapper has **no own
  enumerable or symbol keys**: `Object.keys(el)` is `[]` and `getOwnPropertySymbols(el)` is `[]`
  (measured). React's `__reactFiber$…` expandos are the only own props a test sees.
- `impl[wrapperSymbol] = wrapper` gives the reverse link (`utils.js` `wrapperForImpl`).
- `implForWrapperWithInterface` is the brand check. It does `#impl in wrapper`, then compares the
  interface chain at `inheritanceDepth`.
- `createImpl()` **always creates the wrapper too** (`exports.createImpl = (...) => utils.implForWrapper(exports.create(...))`
  in `e2e/react-app/node_modules/jsdom/lib/generated/idl/Node.js:55-58`). There is no lazy wrapper creation:
  every node, Attr, NodeList, DOMTokenList and CSSStyleDeclaration exists twice.

**A generated method, end to end.** `appendChild`, from `e2e/react-app/node_modules/jsdom/lib/generated/idl/Node.js:343-362`:

```js
appendChild(node) {
  const $impl = $requireImpl(this ?? globalObject, globalObject, "appendChild"); // brand check
  if (arguments.length < 1) throw new globalObject.TypeError(...);
  const args = [];
  { let curArg = arguments[0];
    curArg = exports.convert(globalObject, curArg, { context: "..." });            // wrapper -> impl
    args.push(curArg); }
  ceReactionsPreSteps(globalObject);                                             // push []
  try { return utils.tryWrapperForImpl($impl.appendChild(...args)); }            // impl -> wrapper
  finally { ceReactionsPostSteps(globalObject); }                                // pop + invoke
}
```

Notes:
- `[CEReactions]` wraps **getters** too (`get nodeValue`, `get textContent`, `Node.js:481-532`). Each
  bracket allocates an array (`jsdom/lib/jsdom/living/helpers/custom-elements.js:49-55`).
- Errors are created with `new globalObject.TypeError(...)`. That is the **window's realm**, which is a
  different realm when `runScripts` is set (see §3.4).
- `[SameObject]` attributes such as `childNodes` are cached on the wrapper through
  `utils.getSameObject` (`Node.js:454-459`).
- **Legacy platform objects are Proxies.** Interfaces with indexed or named getters are wrapped in
  `new Proxy(wrapper, handler)`. This applies to `NodeList`, `HTMLCollection`, `NamedNodeMap`,
  `DOMTokenList`, `DOMStringMap`, `CSSStyleDeclaration`, `CSSStyleProperties`, `HTMLFormElement`,
  `HTMLSelectElement`, `HTMLOptionsCollection`, `HTMLFormControlsCollection`, `RadioNodeList` and
  `Storage` (`grep 'new Proxy'` in those generated files). Every `nodeList[i]` goes through the `get`
  trap: `isArrayIndexPropName` → `impl.item(i)` → `tryWrapperForImpl`. Measured cost: 223 ns.
- **Interfaces are installed per window.** `installInterfaces(window, ["Window"])`
  (`jsdom/lib/jsdom/browser/Window.js:77`, `jsdom/lib/jsdom/living/interfaces.js:256-271`) runs
  `install()` for about 210 interfaces. Each one creates a fresh `class X extends globalObject.Parent`,
  so every window has its own constructors and prototypes. `DOMException.prototype` is re-parented to
  `window.Error.prototype` (`interfaces.js:267`).

### 1.2 Tree storage (`jsdom/lib/jsdom/living/helpers/dom-tree.js`)

- `class Links { parent, previousSibling, nextSibling, firstChild, lastChild, childCount, cachedChildren, cachedIndex }`
  (`dom-tree.js:13-24`). It is allocated lazily by `ensureLinks`, the first time a node joins a tree or
  gains a child (`dom-tree.js:26-33`). Reads such as `node._links?.firstChild ?? null` never allocate
  (`Node-impl.js:423-461`).
- **Sibling index.** `treeIndex(node)` (`dom-tree.js:256-286`):
  - first child: O(1)
  - last child: O(1), via `childCount - 1`
  - append-only parents: O(1), via `cachedIndex`
  - otherwise it lazily builds a `cachedChildren` prefix array, which `insertBefore` and `remove`
    truncate (`dom-tree.js:304-358`).

  Used by `compareDocumentPosition`, Range offsets and `window` named-property ordering.
- **Iterators.** `ChildrenIterator`, `DescendantsIterator` and `ShadowIncludingIterator` capture the
  next node before yielding (`dom-tree.js:73-137`). "Array" variants (`childrenToArray`,
  `descendantsToArray`, `dom-tree.js:139-159`) are used to refresh live collections.
- `compareTreePosition` and `commonAncestorInfo` walk both ancestor chains together
  (`dom-tree.js:161-254`).
- **Root caching.** `getRootNode()` caches `_cachedRoot` on the whole path, **but only when the root
  is a Document**, because detached trees are not invalidated (`Node-impl.js:367-395`). `_remove`
  clears it for the removed subtree (`Node-impl.js:1246-1252`). `isConnected` is
  `shadowIncludingRoot(this).nodeType === DOCUMENT_NODE` (`Node-impl.js:429-432`). It is O(1) when
  cached and O(depth) for detached trees, which is the common case during React's render phase.

**rsdom takeaway:** this is roughly what an arena with `u32` links gives for free. Store
`parent/first/last/prev/next` as indices, `child_count` per node, and an optional sibling-index cache.
Do not tie root caching to Documents. A per-node "tree id" or generation counter works for detached
trees too.

### 1.3 Node impl: caches and invalidation (`jsdom/lib/jsdom/living/nodes/Node-impl.js`)

Per-node state set in the constructor (`Node-impl.js:178-194`):
- `_links`
- `_ownerDocument`
- `_childNodesList` / `_childrenList` (live collections)
- `_version` (collection invalidation counter)
- `_cachedRoot`
- `_isInDocumentTree`
- `_registeredObserverList` (MutationObserver)
- `_referencedRanges` (a Set of `WeakRef<Range>`)
- `#memoizedQueries`, which holds the `getElementsBy*` collection maps and label associations
  (`Node-impl.js:105-113`)

Invalidation entry points:
- `_invalidateCaches()` (`Node-impl.js:472-485`). It walks **every ancestor**, bumps `_version` and
  nulls the memoized queries. It then calls `_invalidate()` on its own `children`/`childNodes` lists,
  and resets the document style cache if the node is connected. It is called from `_insert` **once per
  inserted node** (`Node-impl.js:1071`), from `_remove` (`Node-impl.js:1267`) and from every
  attribute change (`Element-impl.js:63`).
- `_invalidateSelectorState()` (`Node-impl.js:464-469`). It clears the dom-selector result cache, plus
  the style cache if the node is connected. It is called on focus change, checkedness, input value and
  indeterminate changes (`HTMLInputElement-impl.js:170-175, 366-385`; `Document-impl.js:262-267`).
- `Document#_clearStyleCache()` replaces the per-document `WeakMap` of computed declarations
  (`Document-impl.js:254-256`). This is an O(1) reset, and everything is cold afterwards.

Document-level caches:
- **`_byIdCache`** (`jsdom/lib/jsdom/living/helpers/by-id-cache.js`). A map from id to
  `{element|null, count}`. When duplicates exist, `get()` falls back to a full tree scan
  (`by-id-cache.js:46-64`). It is maintained by `addSubtreeToDocumentCaches` and
  `removeSubtreeFromDocumentCaches` (`Node-impl.js:133-173`), and by id attribute changes
  (`Element-impl.js:67-75`).
- **Window named properties** (`jsdom/lib/jsdom/living/window-properties.js`). Per-window trackers of
  `id`/`name` → `Set<Element>`. They are updated for every attached element
  (`Node-impl.js:141`) and every attribute change (`Element-impl.js:65`). P2 for rsdom: Vitest copies
  only *own* window props, and named properties live on the prototype chain
  (`Window.js:92`, `windowProperties.create`).

---

## 2. Subsystem walkthrough

### 2.1 Mutation algorithms (`Node-impl.js:833-1292`)

**pre-insert** (`_preInsert`, `Node-impl.js:998-1009`):
1. `_preInsertValidity` (§6.1)
2. if `child === node`, use `node.nextSibling` as the reference
3. `_insert`

**insert** (`_insert`, `Node-impl.js:1012-1127`), in order:
1. If `node` is a DocumentFragment, take its children, remove each with observers suppressed, and
   queue **one** childList record on the fragment (`:1015-1030`).
2. Fix up live Ranges whose boundary is in `this` after the child index (`:1034-1049`).
3. `previousChildImpl = child ? child.previousSibling : this.lastChild`. This is computed **before**
   adoption removes the node from its old parent (`:1051-1053`), and that matches the spec's step order.
4. For each node:
   - `_ownerDocument._adoptNode(node)`. This **removes it from its old parent** (full `_remove`, with
     its own mutation record) and fixes `ownerDocument` on the subtree if the document changed
     (`Document-impl.js:1070-1108`).
   - link it in with `treeHelpers.appendChild` or `insertBefore`
   - slot assignment, if this is a shadow host
   - `_invalidateCaches()` (ancestor walk)
   - `getRootNode()` plus slot assignment for the shadow root
   - `addSubtreeToDocumentCaches(node)` if the parent is in the document tree (walks the whole subtree)
   - `updateRadioButtonGroupsForTreeChange`
   - a walk over the **shadow-including inclusive descendants** that runs `_insertionSteps` and
     connected-callback / CE upgrade for each connected element (`:1055-1101`)
5. Queue a childList record on `this` unless suppressed (`:1103-1105`).
6. Run `_childrenInsertedSteps()`, which by default is `_childrenChangedSteps` and clears the style
   cache (`:493-505`).
7. Walk all inserted subtrees again for `_postConnectionSteps` and run them if connected
   (`:1109-1124`).

**remove** (`_remove`, `Node-impl.js:1202-1292`):
1. A walk over inclusive descendants for slot detection and Range fixups.
2. Parent Range fixups.
3. `NodeIterator` pre-remove steps.
4. Unlink.
5. Reset `_cachedRoot` over the shadow-including descendants.
6. Slot reassignment.
7. `_invalidateCaches`.
8. `removeSubtreeFromDocumentCaches`.
9. `_removingSteps` on the node, then on each descendant: focus fixup (§6.9), `<option>` select
   reset and so on, plus `disconnectedCallback`.
10. Radio groups.
11. Mutation record.
12. `_childrenChangedSteps`.

**replace** (`_replace`, `:1135-1159`): validity runs with `childrenToExclude = {child}`. The node is
adopted first, then the child is removed silently and the node inserted silently. It queues **one**
record carrying both added and removed nodes.

**replace all** (`_replaceAll`, `:1162-1185`): used by the `textContent` setter, `innerHTML` and
`replaceChildren`. It removes all children silently, inserts silently, and queues **one** record if
anything changed.

**Parser insertion uses the full algorithm.** `JSDOMParse5Adapter.appendChild` calls
`parentNode._append(newNode)`, i.e. the full pre-insert path
(`jsdom/lib/jsdom/browser/parser/html.js:99-105`). Text runs are merged with `lastChild.data += text`,
which goes through `replaceData` and queues a characterData record (`html.js:139-159`). There is no
bulk-build fast path. Measured: **`innerHTML =` a 500-row table (~4,000 nodes) takes 70-115 ms**,
about 18-28 µs per node.

### 2.2 Elements and attributes (`Element-impl.js`, `attributes.js`)

- Storage is `_attributeList: Attr[]` (insertion order) plus `_attributesByNameMap: Map<qualifiedName, Attr[]>`
  (`Element-impl.js:47-50`). `getAttribute` lowercases HTML names when the element is HTML in an HTML
  document (`attributes.js:136-151`). `getAttributeNS` does a linear scan (`attributes.js:153-169`).
- **Every attribute is a full Attr node with its own wrapper**: `document._createAttribute` →
  `generatedAttr.createImpl` (`Document-impl.js:1009-1023`). `setAttribute` on a new name allocates two
  objects plus a Map entry array.
- **Attribute change pipeline**: `handleAttributeChanges` (`attributes.js:29-43`) runs:
  1. `queueAttributeMutationRecord`, which walks ancestors looking for observers
  2. `attributeChangedCallback` for custom elements
  3. `element._attributeChangeSteps(...)`. The steps chain is `Element` → `HTMLElement` → the element
     class:
     - **Element** (`Element-impl.js:62-88`): `_invalidateCaches` (ancestor walk + style cache reset),
       window named props, `_byIdCache`, `classList.attrModified()`, `_clearDOMSelector()`,
       slotable `name`.
     - **HTMLElement** (`HTMLElement-impl.js:169-180`): `style` attribute → `this.style.cssText = value`
       (guarded by `_settingCssText` to avoid ping-pong); `on*` attributes → event handler
       compilation.
     - **Input** (`HTMLInputElement-impl.js:235-284`): `value` → value if not dirty, `checked` →
       checkedness if not dirty, type change → value mode conversion.
     - **Option** (`HTMLOptionElement-impl.js:72-82`): `selected` → selectedness + select reset.
- **`setAttribute` with the same value still runs the whole pipeline and queues a MutationRecord.**
  That is spec behaviour: "change an attribute" has no equality short-circuit (`attributes.js:46-50`).
- `tagName` is cached in a private field because it is hot in `getComputedStyle`
  (`Element-impl.js:102-114`).
- `classList` is created lazily (`Element-impl.js:159-167`). jsdom's own code touches it a lot:
  `getElementsByClassName` (`helpers/html-collections.js:20-39`) and `ruleMightMatchElement` in the
  cascade (`css/helpers/computed-style.js:225-236`). So most elements end up with a DOMTokenList, which
  is another wrapper plus Proxy.
- `DOMTokenList` update steps do not create an empty `class=""` when the attribute is absent and the
  token set is empty (`nodes/DOMTokenList-impl.js:68-73`). Measured:
  `classList.remove('a')` on a class-less element leaves no attribute.

### 2.3 Live collections (`nodes/HTMLCollection-impl.js`, `nodes/NodeList-impl.js`, `helpers/html-collections.js`)

- A live collection is a **version-stamped snapshot**. `_update()` compares `this._version` with
  `this._element._version`. If they differ it re-runs the whole `query()`, which is O(subtree) for
  `getElementsBy*` and O(children) for `children` and `childNodes` (`HTMLCollection-impl.js:48-57`,
  `NodeList-impl.js:31-42`).
- Because `_invalidateCaches` bumps `_version` on **all ancestors**, any mutation deep in the document
  forces a full re-query of `document.getElementsByTagName('*')`-style collections on next access.
  `children.length` after each `appendChild` measured **8.8 µs** with 100 children; that is a full
  rebuild every time.
- `childNodes` / `children` are cached per node (`Node-impl.js:442-453`, `ParentNode-impl.js:9-19`)
  and are `[SameObject]` (the identity check passes). `getElementsByTagName(name)` is memoized in
  `#memoizedQueries`, but **any subtree mutation drops the memo**, so identity is lost (measured:
  `ul.getElementsByTagName('li') === previous` is `false` after an append). The spec allows either.
- `childElementCount` is `this.children.length` (`ParentNode-impl.js:41-43`), so it can trigger a rebuild.
- `querySelectorAll` returns a **static** NodeList (`ParentNode-impl.js:70-77`).

### 2.4 Events (`events/EventTarget-impl.js`, `events/Event-impl.js`)

- Listeners are stored as `this._eventListeners = Object.create(null)`, mapping `type` →
  `[{callback, capture, once, passive, signal}]` (`EventTarget-impl.js:28-78`). Duplicates are
  detected by `(callback.objectReference, capture)`.
  - The callback is a generated `EventListener.convert` closure. It re-reads
    `handleEvent` **at call time** for listener objects
    (`e2e/react-app/node_modules/jsdom/lib/generated/idl/EventListener.js:6-32`).
  - `passive` defaults to true for `touchstart`/`touchmove`/`wheel`/`mousewheel` on window, document,
    html and body (`EventTarget-impl.js:439-458`).
  - `signal` registers an abort algorithm (`:70-77`).
- **The dispatch algorithm** (`_dispatch`, `EventTarget-impl.js:147-298`) follows the DOM spec
  closely, including shadow-DOM retargeting:
  - The path is an array of structs `{item, itemInShadowTree, shadowAdjustedTarget, effectiveTarget, relatedTarget, touchTargets, rootOfClosedTree, slotInClosedTree}`
    (`appendToEventPath`, `:461-487`).
  - The parent comes from `_getTheParent(event)`:
    - Node: `assignedSlot ?? parentNode` (`Node-impl.js:283-289`).
    - Document: the window, **unless `event.type === "load"`** (`Document-impl.js:355-361`).
    - ShadowRoot: the host, unless the event is not composed and the root is the event's own root
      (`ShadowRoot-impl.js:18-24`).
  - Activation target: the first `_hasActivationBehavior` node on the path, for `MouseEvent`s of
    type `click` (`:164-216`). `_legacyPreActivationBehavior` runs **before** listeners;
    `_activationBehavior` or `_legacyCanceledActivationBehavior` runs **after** (`:238-295`).
  - **Capture pass.** Walk the path backwards; the phase is AT_TARGET where `shadowAdjustedTarget` is
    set, otherwise CAPTURING. **Bubble pass.** Walk forwards; skip non-target entries unless
    `bubbles` (`:242-270`).
  - Invocation (`innerInvokeEventListeners`, `:329-398`):
    - copy the listener list with `slice()`
    - skip listeners removed during dispatch (`listeners[type].includes(listener)`, which is O(n²)
      with many listeners)
    - skip phase mismatches
    - remove `once` listeners before calling
    - set `window._currentEvent`
    - call with `this = currentTarget wrapper`
    - **catch exceptions and `reportException(window, e)`**
    - stop on `stopImmediatePropagation`
  - Afterwards: `eventPhase = 0`, `currentTarget = null`, `_path = []`, flags reset. `target` is
    nulled only if `clearTargets` (shadow trees).
- **Exceptions in listeners never propagate to `dispatchEvent`'s caller.** `reportException`
  (`helpers/runtime-script-errors.js:48-75`) dispatches a cancelable `ErrorEvent` on the window. If it
  is not handled, it emits a `jsdomError` on the virtual console. Vitest's `catchWindowErrors`
  (`vitest/packages/vitest/src/integrations/env/jsdom.ts:8-34`) calls `preventDefault()` on it and
  re-emits it as `process.emit('uncaughtException', e.error)` **unless user code registered an `error`
  listener**. Vitest reports that as an unhandled error. React 19 relies on the same path:
  `reportGlobalError` falls back to `window.dispatchEvent(new ErrorEvent(...))` when there is no global
  `reportError`, which neither Node 22 nor jsdom provides (`react/packages/shared/reportGlobalError.js:10-49`).
- `Event-impl.js`:
  - Init dicts are copied with `for...in` over the converted dictionary (`:14-21`).
  - `timeStamp = Date.now()` (`:37`). This is **not** `performance.now()`.
  - `composedPath()` handles closed shadow trees (`:91-167`).
  - `initEvent` is a no-op while dispatching (`:183-189`).
  - `returnValue` and `cancelBubble` are implemented as legacy aliases (`:51-77`).
- Event constructors run full dictionary conversion. `new MouseEvent('click', {...})` measured
  **~7 µs**. `UIEventInit.view` accepts **anything** (`tryImplForWrapper`, no Window type check,
  `e2e/react-app/node_modules/jsdom/lib/generated/idl/UIEventInit.js:24-35`), which helps because Vitest's
  "window" is Node's global. `KeyboardEventInit` includes legacy `keyCode`/`charCode`
  (`events/KeyboardEvent.webidl:50-62`), and `UIEventInit` includes `which`.
- `HTMLElement.click()` (`HTMLElement-impl.js:66-90`):
  - returns early if the element is disabled (`isDisabled`)
  - guards re-entrancy with `_clickInProgress`
  - fires a **`PointerEvent`** with `{bubbles, cancelable, composed, isTrusted:false, pointerId:-1, view}`

  `detail` stays 0. The `<label>` activation behaviour sends a synthetic `MouseEvent` click with
  `detail: 1` (`HTMLLabelElement-impl.js:9-22, 55-80`).

### 2.5 Selector engine (`@asamuzakjp/dom-selector` 10.0.3)

- jsdom creates **one `DOMSelector` per document**, lazily (`Document-impl.js:270-277`). It is called
  from `ParentNode-impl.js:59-77` (`querySelector`/`All`) and `Element-impl.js:514-522`
  (`closest`/`matches`). Its result caches are cleared on every attribute change
  (`Element-impl.js:83`) and on selector-state changes (`Node-impl.js:464-469`), via
  `DOMSelector.clear()` → `finder.clearResults(true)` + `nwsapi.clear()`
  (`e2e/react-app/node_modules/@asamuzakjp/dom-selector/src/index.js` `clear()`).
- **It works on public wrappers.** `#wrapNode(node)` calls `idlUtils.wrapperForImpl(node)`
  (`index.js` `#wrapNode`), and traversal uses `document.createTreeWalker(...)` on the wrapper
  (`src/js/traverser.js:68-80`, `src/js/utility.js:938-953`). Each step therefore pays the generated
  wrapper tax: brand check, then the TreeWalker impl, then filter callbacks.
- Paths taken:
  - **`matches` / `closest` / `check`**: if the node is connected, HTML, in this document, and
    `filterSelector(selector, TARGET_SELF|LINEAL)` accepts it, use the **nwsapi fork**. That fork
    compiles selectors to JS functions with `Function(...)` (`src/js/nwsapi.js:1111`) and caches them
    in an LRU (4,096 entries). Otherwise use the Finder.
  - **`querySelector`**: the exact `#id` fast path through `getElementById`; `*` gives
    `firstElementChild`; otherwise the Finder (`index.js` `querySelector`).
  - **`querySelectorAll`**: `*` collects all descendants with a TreeWalker; simple `[attr]` presence
    uses a TreeWalker plus `hasAttributeLocalName` (`utility.js:1024-1062`); otherwise the Finder.
    **`filterSelector` returns false for `TARGET_ALL`/`TARGET_FIRST`**
    (`src/js/selector.js:236-239`), so the nwsapi fast path never serves `qSA`.
- The Finder parses with css-tree (AST cached in an LRU) and picks a traversal strategy from the
  rightmost compound (`utility.js` `getTraversalStrategy`). It matches with `matcher.js` /
  `pseudo-class.js` and returns a `Set`, which is spread into an Array and wrapped in a static NodeList.
- Measured on a 3,002-element subtree (500 table rows; `docs/lab/research/jsdom-probes/sel.cjs`):

| selector | time per qSA call |
|---|---:|
| `.row` | 0.25-0.32 ms |
| `script, style` | 0.015-0.03 ms |
| `input:checked` | 0.86-1.0 ms |
| `#nope` (on an element root) | 1.6-1.8 ms |
| `a[href]` | 1.8-2.3 ms |
| `input[type="checkbox"]` | 2.5-3.1 ms |
| `[aria-label]` | 2.3-5.6 ms |
| `tr > td > a` | 4.9-6.4 ms |
| `tr td a` | 8.4-9.9 ms |
| `*[role~="link"],a[href],area[href]` (DTL `getAllByRole('link')` selector, `dom-testing-library/src/queries/role.ts:307-322`) | **11-15 ms** |
| `el.matches('a[href],area[href]')` (nwsapi path) | 2.5-2.7 µs |
| `el.closest('tr')` | 2.5-2.8 µs |

  That is roughly 0.5-4 µs per element visited. A Rust matcher over an arena should do 10-50 ns per
  element, and **the whole query should run in one crossing** that returns an id array.

### 2.6 Parsing and serialization

- HTML parsing uses parse5 8 with a custom tree adapter, `JSDOMParse5Adapter`
  (`jsdom/lib/jsdom/browser/parser/html.js`):
  - `createElement` goes through `helpers/create-element.js` and the custom-element lookup, then
    attributes go through `attributes.setAttributeValue` (`html.js:60-93, 161-166`).
  - `<template>` contents are swapped in by `setTemplateContent` (`html.js:107-127`).
  - Fragment parsing is `parse5.parseFragment(contextElement, markup, {treeAdapter})` (`html.js:182-194`).
  - Scripting is enabled when `runScripts === "dangerously"` (`Window.js:194-203`), and that changes
    how `<noscript>` parses.
- `innerHTML` setter: `parseFragment` then `_replaceAll(fragment)`. For `<template>` the target is
  `_templateContents` (`domparsing/InnerHTML-impl.js:19-29`).
- `outerHTML` setter: replaces itself in the parent. On a fragment parent it uses a `<body>` context.
  On a document parent it throws `NoModificationAllowedError` (`Element-impl.js:134-157`).
- `insertAdjacentHTML`: uses a `<body>` context for non-elements and for `<html>` (`Element-impl.js:452-512`).
- Serialization:
  - HTML documents use the parse5 serializer through `domparsing/parse5-adapter-serialization.js`.
  - XML documents use `w3c-xmlserializer` on wrappers (`domparsing/serialization.js:10-37`).
  - Measured: serializing ~4,000 nodes takes **1.4-1.5 ms**; `textContent` on ~4,000 nodes takes
    **0.24-0.27 ms** (a generator walk with string `+=`, `Node-impl.js:770-798`).
- Entity and attribute escaping follow the HTML fragment serialization algorithm (measured):
  - text: `<a&b>NBSP"` serializes as `&lt;a&amp;b&gt;&nbsp;"`
  - attributes: `"`, `&` and NBSP are escaped, `<` and `>` are **not** (`title="a&quot;b&amp;<"`)

### 2.7 CSSOM: `CSSStyleDeclaration` (formerly cssstyle)

- `el.style` is a `CSSStyleProperties` impl (`css/CSSStyleProperties-impl.js`), a subclass of
  `CSSStyleDeclarationImpl` (`css/CSSStyleDeclaration-impl.js`). It holds `#values: Map` and
  `_priorities: Map`, plus caches (`:26-56`). It is **created eagerly for every HTML and SVG element**
  (`HTMLElement-impl.js:20`, `SVGElement-impl.js:14`).
- 1,638 generated property descriptors, covering camelCase, dashed and `webkit`/`Webkit` variants
  (`e2e/react-app/node_modules/jsdom/lib/generated/css-property-descriptors.js`). They are installed on the impl
  prototype, and the wrapper forwards to them (`css/CSSStyleProperties-impl.js:16-25`). Each setter
  wraps in `_updateStyle`.
- A property write such as `el.style.color = 'red'` (measured ~3.5 µs):
  1. `_updateStyle` reads `cssText` (serializes all declarations, cached) (`:374-390`)
  2. the property handler parses and validates with css-tree / css-color (`cssValues.parsePropertyValue`)
  3. `_setProperty` stores the value and invalidates the cached cssText (`:414-442`)
  4. the cssText is compared with the original
  5. `#notifyChange` → `ownerNode.setAttributeNS(null, "style", cssText)` (`:392-412`), which runs the
     **full attribute-change pipeline** (§2.2)
  6. `_settingCssText` prevents the attribute-change step from re-parsing (`HTMLElement-impl.js:172-176`)
- `cssText` setter: css-tree `parse(text, {context:"declarationList"})`, then property-by-property
  `setProperty`. Invalid values are dropped (`:113-185`).
- Value normalisation, measured:
  - `color: #1e1e1e` becomes `rgb(30, 30, 30)` in both the inline and the computed value
  - `padding: 8px 12px` round-trips as the shorthand; computed `padding-left` is `12px`
  - `style.width = 10` (a number) is **rejected**, so the value stays `''`; React appends `px` itself
  - invalid values (`color: notacolor`) are ignored
  - custom properties are stored trimmed (`'--foo': ' bar '` reads back as `'bar'`)

### 2.8 `getComputedStyle` (`browser/Window.js:849-867`, `css/helpers/computed-style.js`)

- `window.getComputedStyle(elt, pseudo)`:
  1. `Element.convert` (brand check)
  2. a non-empty pseudo-element emits a "not implemented" `jsdomError`; `::part`/`::slotted` throw
  3. `getComputedStyleDeclaration(elementImpl)`
- **Document style cache**: `document._styleCache: WeakMap<Element, CSSStyleProperties(computed)>`,
  **replaced** by any mutation of a connected node and by selector-state changes (§1.3). Two modes
  (`computed-style.js:55-104`):
  - *On-demand.* Internal callers such as `focusing.js` use `getComputedStylePropertyValue(el, prop)`.
    The cached declaration cascades one longhand at a time: `_cascadedProperties: Set` plus
    `_candidateStyles`, collected once per element.
  - *Complete.* The public `getComputedStyle()` **always allocates a new declaration** (impl + wrapper
    + Proxy). It copies from a cached complete declaration, or builds one by applying all candidate
    rules. It is marked `_readonly`. **It is a snapshot, not live** (measured: setting
    `style.display='none'` after `getComputedStyle()` still reads `block` from the old object).
    Browsers return a live object.
- **Candidate collection** (`collectCandidateStyles`, `:135-166`):
  - first the parsed UA stylesheet (`browser/default-stylesheet.css`, 415 lines, 112 rule blocks,
    parsed once per process, `:20-23, 136-142`), then `document.styleSheets` (honouring
    `@import`/`@media`)
  - per rule, `ruleMightMatchElement` (`:213-251`) prefilters on the rightmost compound's
    id/class/tag/attr keys, using `domSelector.extractSubjects` (cached on the rule)
  - surviving candidates are matched lazily with `domSelector.check(selectorText, el)`
    (`:168-179, 253-264`); specificity comes from `@bramus/specificity`
  - inline style is applied last (`:119-131`)
- **Inheritance**:
  - `getInheritedPropertyValue` recurses into `getCachedDeclaration(parent)._getComputedPropertyValue(prop)`
    (`:286-319`). An inherited property such as `visibility`, `pointer-events` or `color` computes the
    **whole ancestor chain**, which is cold after any mutation.
  - Colours walk ancestors for the nearest specified value.
  - `font-size` resolution (`:370-383`, `css/helpers/font-sizes.js`) feeds `em` units.
- **Resolved values**: the generated `css-property-resolved-value-resolvers.js` handles things like
  `width: auto`. `getPropertyValue(shorthand)` serializes from longhands
  (`CSSStyleDeclaration-impl.js:226-241`).
- **`[hidden]` gives `display:none`** through the UA sheet
  (`default-stylesheet.css:391-406`, `[hidden]:not([hidden=until-found i]):not(embed) { display: none }`).
  Measured: `[hidden]` gives `display none`, its child stays `inline` (`display` is not inherited), and
  `visibility: hidden` is inherited by children.
- **Detached elements**: jsdom computes UA defaults anyway (detached `<div>` gives `display: block`).
  Browsers return empty values for elements not in a document.
- `<style>` elements work: the sheet is parsed and appended to `document.styleSheets`, and selectors
  match (measured: `.red{color:red}` gives `rgb(255, 0, 0)`). The app imports no CSS, so only UA
  defaults, inheritance and inline style matter for the benchmark (`app-notes.md`).
- Measured costs (`docs/lab/research/jsdom-probes/sel.cjs`, `ops.cjs`):

| scenario | cost per call |
|---|---:|
| `getComputedStyle(el)` with no property read | 1.6-2.4 µs (allocation + Proxy) |
| `.display`, warm cache | 2.3 µs |
| `.display` over 500 different anchors, first pass cold | 60-110 µs average |
| `.visibility` (inherited) on a depth-8 anchor, warm | 18-38 µs |
| `setAttribute` on `<body>`, then `.display` on a depth-8 anchor | 166-255 µs |
| `setAttribute` on any element, then `.visibility` | 300-325 µs |
| fresh small document, mutation, then `.display` at depth 4 | ~690 µs (cold JIT) |

- Consumers that hammer this:
  - DTL `isInaccessible`, called for every role-query candidate, plus ancestor `isSubtreeInaccessible`
    (`dom-testing-library/src/role-helpers.js:15-60`)
  - dom-accessibility-api (`dom-accessibility-api/sources/is-inaccessible.ts:26-41, 66-82`;
    `accessible-name-and-description.ts:361-385, 413`, which keeps a per-call `Map` cache)
  - jest-dom `toBeVisible`, which reads display, visibility and opacity per ancestor
    (`jest-dom/src/to-be-visible.js:4-36`)
  - user-event `pointer-events` checks up the ancestor chain
    (`e2e/react-app/node_modules/@testing-library/user-event/dist/esm/utils/pointer/cssPointerEvents.js:14`)

### 2.9 Focus (`helpers/focusing.js`, `nodes/HTMLOrSVGElement-impl.js`, `nodes/DocumentOrShadowRoot-impl.js`)

- `el.focus()` → `focusingSteps(this)` (`HTMLOrSVGElement-impl.js:44-47`, `focusing.js:151-180`):
  1. If the target is not a *focusable area*, use `getFocusableArea` (`documentElement` → the
     document/viewport), otherwise do nothing.
  2. Compute the old and new focus chains (element, then document(s)).
  3. Run `focusUpdateSteps` (§6.9).
- `isFocusableAreaElement` (`focusing.js:17-93`) requires:
  - a window
  - **connected**
  - **no ancestor with computed `display: none`**: `getComputedStylePropertyValue` for **every flat-tree
    ancestor** (`:31-42`)

  Then:
  - `input` (not `type=hidden`), `select`, `textarea` and `button` are focusable unless disabled
  - any element with a parseable `tabindex` (including `-1`)
  - `iframe`, `a[href]`, the first `summary` of a `details`, `[contenteditable]`
  - SVG `a[href]` or a rendered SVG with a tabindex
- `blur()` → `unfocusingSteps`. This only acts if the element is in the current focus chain and is
  focusable, and then focuses the top document (viewport) (`focusing.js:183-201`).
- `document.activeElement` (`DocumentOrShadowRoot-impl.js:5-22`): `_lastFocusedElement || body`,
  retargeted to this root. If the candidate is the Document it returns `body`, else `documentElement`.
- `Document#_lastFocusedElement` setter calls `_invalidateSelectorState()` (`Document-impl.js:262-267`),
  which **drops the style cache**. Combined with the ancestor `display` checks, `focus()`/`blur()`
  measured **~450-650 µs** per call. user-event's `click`, `tab` and `type` focus elements, and Modal
  focus traps call `focus()` repeatedly (`app-notes.md`).
- On focus, the selection collapses to `(newFocusTarget, 0)` (`focusing.js:277-280`). Inputs keep
  their own `selectionStart/End`: after `value=` the caret goes to the end (measured `3,3` for "abc").

### 2.10 Forms

- **`<input>`** (`nodes/HTMLInputElement-impl.js`):
  - Private `#value`, `#dirtyValue`, `#checkedness`, `#dirtyCheckedness`, `#indeterminate` (`:108-113`).
  - `valueAttributeMode(type)` returns `value`/`default`/`default/on`/`filename` (`:86-97`); the
    `value` getter and setter dispatch on it (`:387-440`).
  - Sanitization per type: `sanitizeValueByType` in `helpers/form-controls.js`. Numbers drop
    non-numbers (measured: `'abc'` becomes `''`).
  - Changing `type` converts the value mode (`:253-283`).
  - Value changes call `_invalidateSelectorState` (they affect `:placeholder-shown`, `:valid` and so
    on), which drops the style cache.
  - Checkbox/radio activation (`:177-233`):
    - `_legacyPreActivationBehavior` toggles checkbox `checked` and clears `indeterminate`, or sets a
      radio checked (remembering the previous checked radio), **before** listeners run.
    - `_activationBehavior` fires `input` then `change` (both bubble) if connected.
    - On cancel, `_legacyCanceledActivationBehavior` restores the previous state.
    - Submit/image buttons call `form._doRequestSubmit(this)`; reset buttons call `form._doReset()`.
  - Radio groups: `#getOtherRadioGroupElements` searches `getElementsByTagNameNS(HTML_NS,'input')`
    under the form owner, or under the root (`:308-327`). Groups are updated on insertion
    (`:285-290`) and on `name`/`form` changes (`:247-251`).
- **`<textarea>`** (`nodes/HTMLTextAreaElement-impl.js`): `#rawValue` and `#dirtyValue`.
  - `defaultValue` is the child text content, and its setter sets `textContent` (`:72-78`).
  - Non-dirty value follows child changes through `_childrenChangedSteps` (`:56-62`).
  - The API value normalizes CRLF/CR to LF (`:36-38`).
- **`<select>` / `<option>`** (`nodes/HTMLSelectElement-impl.js`, `nodes/HTMLOptionElement-impl.js`):
  - `_selectedness` plus `_dirtyness` per option.
  - The select "asked for a reset" algorithm (`HTMLSelectElement-impl.js:61-100`) runs when options
    are inserted or removed (`HTMLOptionElement-impl.js:20-50`) and on `selected` attribute changes.
  - `select.value = v` selects the first matching option, or sets `selectedIndex = -1` if none match
    (measured: `value='nope'` gives `''` and `-1`). It does not touch the `selected` attribute.
  - `option.value` falls back to `text` (stripped and collapsed).
- **Labels**: `getLabelsForLabelable` returns a live `NodeList` whose query is memoized as a
  `labelsByControl` WeakMap over the whole root (`helpers/form-controls.js:140-180`); any subtree
  mutation drops it. `label.control` uses `for` → `firstElementWithId(root)`, or the first labelable
  descendant (`HTMLLabelElement-impl.js:31-46`).
- **Form owner**: no `form` attribute means the closest ancestor `form`; an explicit `form` attribute
  means id lookup (`helpers/form-controls.js:317-331`).
- **`isDisabled`**: the element's own `disabled` attribute, or a disabled `fieldset` ancestor unless the
  element sits inside that fieldset's first `legend` (`helpers/form-controls.js:27-47`).
- **Submission**: `requestSubmit` / implicit submission fires a `SubmitEvent` with `submitter`
  (measured). If it is not cancelled, jsdom has no navigation: `form.submit()` emits a "Not
  implemented: HTMLFormElement's submit() method" `jsdomError` to the console (measured).
- **Constraint validation** (`constraint-validation/DefaultConstraintValidation-impl.js`, mixed into
  form controls): `required`, email `typeMismatch` and the rest. `validationMessage` is the generic
  `'Constraints not satisfied'` (measured). jest-dom `toBeInvalid` depends on it (`app-notes.md` finding 2).

### 2.11 Window and environment creation (`jsdom/lib/api.js`, `jsdom/lib/jsdom/browser/Window.js`)

- `new JSDOM(html, opts)` (`api.js:34-48`):
  1. `createWindow` (`Window.js:42-...`)
  2. `beforeParse`
  3. `parseIntoDocument`
  4. `document.close()`
- `createWindow`:
  - With `runScripts` `dangerously`/`outside-only`: `vm.createContext(vm.constants.DONT_CONTEXTIFY)`,
    then copies JS globals from the context (`Window.js:53-64`).
  - Otherwise: aliases Node's globals (`:65-74`).
  - Then `installInterfaces` (about 210 interface classes), the Window prototype chain with the
    named-properties object, `EventTarget.setup(window)`, own properties (document, storage, selection,
    BarProp, navigator, performance, screen, crypto, CustomElementRegistry, `innerWidth` 1024,
    `innerHeight` 768, ...), event-handler accessors, and a `process.nextTick` that fires `load`.
  - Result: 485 own property names (measured).
- Timers: jsdom has its own `setTimeout`/`setInterval` that wrap Node timers (`Window.js:523-562`), but
  **Vitest does not copy them** (they are commented out in `jsdom-keys.ts`). Tests use Node's timers.
- `requestAnimationFrame` exists only with `pretendToBeVisual` (Vitest default `true`). It is
  implemented as a `setInterval(1000/60)` that runs while callbacks are pending (`Window.js:592-645`),
  and Vitest copies it (`jsdom-keys.ts:229`).
- Not implemented and therefore absent or stubbed:
  - `alert`, `confirm`, `prompt`, `open`, `print`, `scroll*`, `moveBy`/`moveTo`, `resizeBy`/`resizeTo`
    emit a not-implemented `jsdomError` (`Window.js:908-928`)
  - `matchMedia`, `Element.prototype.scrollIntoView` (commented out in `Element.webidl:75`),
    `ResizeObserver`, `IntersectionObserver` and `DataTransfer` are absent (measured)
  - `getBoundingClientRect` is all zeros, `getClientRects` is `[]`, and `scroll*`/`client*`/`offset*`
    are all 0 (`Element-impl.js:310-349`, `HTMLElement-impl.js:182-200`)
- **Measured cost:**

| step | cost |
|---|---:|
| `require("jsdom")`, cold process | 626-740 ms (3,651 module loads) |
| first `new JSDOM`, `runScripts: "dangerously"` | 82-85 ms |
| first `new JSDOM`, no `runScripts` | 14-23 ms |
| later `new JSDOM`, either setting | ~8-9 ms |

  The biggest require-time contributors, by self time:

| module | self time |
|---|---:|
| `lib/generated/idl/*` | 140-158 ms |
| `undici` | 65 ms |
| `css-tree` | 64 ms |
| `@asamuzakjp/dom-selector` | 63 ms |
| `living/nodes` | 37 ms |
| `living/css` + `css/helpers` + `css/properties` | ~78 ms |
| `@exodus/bytes` | 25 ms |
| `mdn-data` | 18 ms |
| `@asamuzakjp/css-color` | 14 ms |
| `parse5` | 13 ms |

  (`docs/lab/research/jsdom-probes/reqprofile.cjs`.)

---

## 3. The Vitest jsdom environment

Sources: `vitest/packages/vitest/src/integrations/env/jsdom.ts`, `.../env/jsdom-keys.ts`,
`.../env/utils.ts`, `.../env/loader.ts`, `vitest/packages/vitest/src/types/environment.ts`,
`vitest/packages/vitest/src/runtime/workers/base.ts:102-145`.

### 3.1 Lifecycle

- `Environment` is `{ name, viteEnvironment?, prewarmModules?, setup(global, options), setupVM?(options) }`
  (`types/environment.ts:12-35`).
- `setup` returns `{ teardown(global) }`.
- `setupVM` returns `{ getVmContext(), teardown() }` and is only used with `pool: 'vmThreads'/'vmForks'`.
- The worker calls `loadEnvironment` and then `environment.setup(globalThis, environmentOptions || config.environmentOptions || {})`.
  Both are counted as **"environment" time** (`runtime/workers/base.ts:110-135`). That is why jsdom's
  ~0.7 s module load shows up as "environment 28%" in the app's runs (`app-notes.md`).
- A path-like environment name (`./` or `/`) is imported with `import(pathToFileURL(...))` when the
  native loader is used. Otherwise it goes through Vite's module runner (`loader.ts:68-80`;
  `app-notes.md` covers the `createRequire` advice for loading a `.node` addon).

### 3.2 `setup()` for jsdom, step by step (`jsdom.ts:177-245`)

1. Snapshot Node's `FormData`, `Blob` and `Request` for the compat wrappers.
2. `await import('jsdom')`. This is the ~0.7 s cost.
3. `new JSDOM(html = '<!DOCTYPE html>', { pretendToBeVisual: true, runScripts: 'dangerously', url: 'http://localhost:3000', contentType: 'text/html', includeNodeLocations: false, virtualConsole (only if console:true), cookieJar, resources, ...rest })`.
   - The `<!DOCTYPE html>` means **standards mode**. Without a doctype `compatMode` would be
     `BackCompat` (`Document-impl.js:363-365`), and `getElementsByClassName` would become
     case-insensitive (`helpers/html-collections.js:24-31`).
   - With `console: false` (the default), the `virtualConsole` option is `undefined`, so jsdom's
     default `new VirtualConsole().forwardTo(console)` applies (`jsdom/lib/api.js:210-212`). jsdom's
     "Not implemented" errors **do** print to the test console.
4. `patchAddEventListener(dom.window)` (`jsdom.ts:348-395`). This replaces
   `EventTarget.prototype.addEventListener` so that a Node `AbortSignal` in `{signal}` is bridged to a
   jsdom `AbortController`. `AbortController`/`AbortSignal` are **not** overridden on the global
   (commented out in `jsdom-keys.ts:184-185`), so user code passes Node signals.
5. `populateGlobal(global, dom.window, { bindFunctions: true })` (§3.3).
6. `catchWindowErrors(global)` (`jsdom.ts:8-34`):
   - adds an `error` listener that, **when no user `error` listener is registered** and
     `e.error != null`, calls `e.preventDefault()` and `process.emit('uncaughtException', e.error)`
   - wraps `addEventListener`/`removeEventListener` to count user `error` listeners
7. Set `global.jsdom = dom`, `global.Request = compat Request` and `global.URL = compat URL`. The
   compat classes subclass Node's, convert jsdom `Blob`/`FormData` bodies by reaching into jsdom
   internals (`jsdom.ts:248-346`), and define `Symbol.hasInstance` so that `instanceof` against Node's
   classes passes.
8. `teardown`: undo the addEventListener patch and the error handlers, call `dom.window.close()`,
   delete every installed key, and restore the original descriptors.

### 3.3 `populateGlobal` semantics (`utils.ts:37-117`)

- **Key set** (`getWindowKeys`, `utils.ts:5-21`): `KEYS ∪ Object.getOwnPropertyNames(win)`, minus
  `window/self/top/parent`. A key **already present on Node's global is kept only if it is in `KEYS`**.
  So:
  - Node's `setTimeout`, `queueMicrotask`, `console`, `URL`, `AbortController`, `fetch`,
    `TextEncoder`, `structuredClone`, `Error`, `TypeError`, `Promise` and so on stay Node's.
  - `Event`, `EventTarget`, `DOMException`, `Blob`, `File`, `FormData`, `MessageEvent`,
    `Performance`, `Navigator`, `Crypto` and similar are in `KEYS` (`jsdom-keys.ts:3-188`). Node's
    versions are **replaced** by jsdom's.
  - **`Uint8Array`, `Uint16Array`, ..., `Float64Array` and `ArrayBuffer` are in `KEYS`**
    (`jsdom-keys.ts:162-171`). With `runScripts:'dangerously'` they are the **vm realm's** typed
    arrays, so Node APIs that return a Node-realm `Uint8Array` fail `instanceof Uint8Array` in tests
    (measured: `window.Uint8Array === Uint8Array` is `false`).
  - Every other own property of the window is copied. That includes all ~200 interface constructors,
    `on*` handler accessors, and even jsdom privates such as `_document`, `_globalObject` and
    `_settings`.
- **Installation**: each key becomes
  `Object.defineProperty(global, key, { get, set, configurable: true })`:
  - `get`: an override value if one was set, else the bound function, else `win[key]`
  - `set`: stores the override and also writes `win[key] = v`
  - With `bindFunctions`, **lower-case** function values are `bind(win)`-ed once (e.g.
    `addEventListener`, `getComputedStyle`, `requestAnimationFrame`, `dispatchEvent`). Class-like names
    (upper-case first letter) are not bound (`utils.ts:23-25, 55-56`).
  - Every global read of `document`, `HTMLElement` or `getComputedStyle` therefore costs a getter call.
    Test code that does `window.matchMedia = vi.fn()` goes through the setter and reaches the jsdom
    window as well.
- `global.window = global.self = global.top = global.parent = global`, and `global.global = global` if
  present (`utils.ts:92-99`).
- **`document.defaultView` is redefined as an own accessor returning `global`** (`utils.ts:102-108`).
  But jsdom-internal references still point at the jsdom window:
  - `event.view` for focus and click events uses `ownerDocument._defaultView`
  - the event path's last entry is the jsdom window impl
  - `window._currentEvent`
  - So `event.view === window` is **false** in a jsdom Vitest test. Window-level listeners still work,
    because `global.addEventListener` is bound to the jsdom window.

### 3.4 Realm consequences of `runScripts: 'dangerously'` (measured, `jsdom-probes/envcreate.cjs`)

- `window.TypeError !== TypeError`. Wrapper argument errors are created with
  `new globalObject.TypeError` (`generated/idl/Node.js` everywhere), so they are **not**
  `instanceof TypeError` in the test realm, only `instanceof window.TypeError`.
- `DOMException.prototype` inherits from the **vm realm's** `Error.prototype` (`interfaces.js:267`), so
  `domException instanceof Error` is **false** in the test realm. `global.DOMException` is jsdom's,
  because it is in `KEYS`, so `toThrow(DOMException)` still works.
- rsdom can do better than jsdom on both points: create errors in the realm Vitest runs tests in, and
  do not override Node's typed arrays.

### 3.5 What an rsdom Vitest environment has to mirror

- `name`, `viteEnvironment: 'client'`, `setup(global, options)` (and optionally `setupVM`).
  `options.rsdom` mirrors `options.jsdom`.
- **The same globals jsdom exposes**, or at least: `KEYS` plus every interface constructor the app and
  libraries touch (`app-notes.md` §Globals), and `window/self/top/parent === globalThis`.
  `document.defaultView === globalThis` must hold. Prefer making the real window object *be*
  `globalThis` (install directly, no proxying getters) so the `event.view`/`defaultView` split
  disappears.
- **Error plumbing**: dispatch listener exceptions to a window `error` `ErrorEvent`, and keep Vitest's
  semantics: an unhandled one becomes `process.emit('uncaughtException')`. Provide `ErrorEvent` so
  React's `reportGlobalError` fallback works.
- **AbortSignal**: accept Node's `AbortSignal` in `addEventListener({signal})` natively. No patch needed.
- **Teardown**: remove installed globals and restore originals, and free the Rust document arena.
- **Budget**: jsdom pays ~0.7 s import + ~85 ms window + ~485 `defineProperty` calls per test file.
  An rsdom env that loads in tens of milliseconds saves about **0.8 s per test file**. On the 11-file
  app with 4 workers that is about 2+ s of wall clock, before any DOM-op speedups.

---

## 4. (a) Minimal spec surface React + Testing Library need, mapped to jsdom implementations

The priority matches `react-dom.md` §12 and `app-notes.md`:
- **P0**: the benchmark suite fails without it.
- **P1**: a common real-world test touches it.
- **P2**: rare in tests.

Each row names the jsdom reference to read when implementing it.

| API / behaviour | P | jsdom reference implementation |
|---|---|---|
| Tree links, `parentNode/firstChild/lastChild/previousSibling/nextSibling`, `childNodes` (live, SameObject), `hasChildNodes` | P0 | `helpers/dom-tree.js`, `nodes/Node-impl.js:283-461` |
| `appendChild / insertBefore / removeChild / replaceChild` incl. move semantics, fragments, validity | P0 | `nodes/Node-impl.js:833-1292` |
| `append/prepend/replaceChildren/remove/before/after` | P1 | `nodes/ParentNode-impl.js:45-57`, `nodes/ChildNode-impl.js`, `node.js` `convertNodesIntoNode` |
| `textContent` get/set, `nodeValue`, `CharacterData.data/length` (UTF-16 lengths) | P0 | `nodes/Node-impl.js:732-831`, `nodes/CharacterData-impl.js:70-112` |
| `nodeType/nodeName/tagName/localName/namespaceURI`, `ownerDocument`, `isConnected`, `getRootNode({composed})`, `contains`, `compareDocumentPosition` | P0 (`compareDocumentPosition` P1: jest-dom `toAppearBefore`) | `nodes/Node-impl.js:367-699`, `nodes/Element-impl.js:90-114` |
| `cloneNode(deep)` (jest-dom failure messages, `role-helpers.js:208`) | P1 | `node.js` `clone`, plus the `_cloningSteps` per element (input copies value and dirty flags, `HTMLInputElement-impl.js:1100-1106`) |
| `document.createElement/createElementNS/createTextNode/createComment/createDocumentFragment` | P0 | `nodes/Document-impl.js:940-990`, `helpers/create-element.js` (tag → interface table `:16-133`) |
| `document.body/head/documentElement/activeElement/getElementById/defaultView/readyState`, `implementation.createHTMLDocument` | P0 | `nodes/Document-impl.js`, `nodes/DocumentOrShadowRoot-impl.js`, `helpers/by-id-cache.js` |
| Attributes: `get/set/remove/has/toggleAttribute`, `getAttributeNames`, `attributes` (NamedNodeMap, pretty-format uses it), `hasAttributes` | P0 | `nodes/Element-impl.js:116-308`, `attributes.js`, `attributes/NamedNodeMap-impl.js` |
| Reflection: `id`, `className`, `classList`, `dataset`, `hidden`, `title`, `lang`, `tabIndex`, `htmlFor`, `href` (resolved), `disabled`, `required`, `type`, `name`, `placeholder`, `checked`/`defaultChecked`, `value`/`defaultValue`, `selected`, `indeterminate` | P0 | generated via `scripts/webidl/reflection.js` (§6.7) + impl getters (`HTMLOrSVGElement-impl.js:28-39` for `tabIndex`) |
| `innerHTML` get/set, `outerHTML` get | P0/P1 | `domparsing/InnerHTML-impl.js`, `browser/parser/html.js`, `domparsing/serialization.js` |
| `querySelector(All)`, `matches`, `closest` (selector features in `app-notes.md`) | P0 | `nodes/ParentNode-impl.js:59-77`, `nodes/Element-impl.js:514-526`, dom-selector |
| `children`, `firstElementChild`, `nextElementSibling`, `childElementCount` | P0/P1 | `nodes/ParentNode-impl.js:9-43`, `nodes/NonDocumentTypeChildNode-impl.js` |
| `getElementsByTagName/ClassName` (live) | P1 (user-event, jsdom internals) | `helpers/html-collections.js` |
| `EventTarget.add/removeEventListener` (capture/once/passive/signal), `dispatchEvent` | P0 | `events/EventTarget-impl.js` |
| `Event`, `UIEvent`, `MouseEvent`, `PointerEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`, `CustomEvent`, `ErrorEvent`, `SubmitEvent` constructors + init dicts | P0 | `events/*-impl.js` + `*.webidl` dictionaries |
| Activation behaviour: checkbox/radio, submit/reset buttons, label → control, summary | P0 (label P1) | `HTMLInputElement-impl.js:177-233`, `HTMLButtonElement-impl.js`, `HTMLLabelElement-impl.js`, `HTMLElement-impl.js:32-43` |
| `HTMLElement.click()`, `focus()`, `blur()`, `document.activeElement`, focus/blur/focusin/focusout order | P0 | `HTMLElement-impl.js:66-90`, `HTMLOrSVGElement-impl.js:44-51`, `helpers/focusing.js` |
| Form controls: input value modes + sanitization, `selectionStart/End`, `setSelectionRange`, `select()`, textarea, select/option/`options`/`selectedOptions`/`selectedIndex`, `form.elements`, `labels`, `form`, `checkValidity`, `validity`, `validationMessage`, `requestSubmit` | P0 | `HTMLInputElement-impl.js`, `HTMLTextAreaElement-impl.js`, `HTMLSelectElement-impl.js`, `HTMLOptionElement-impl.js`, `HTMLFormElement-impl.js`, `helpers/form-controls.js`, `constraint-validation/*` |
| Prototype-level `value`/`checked` accessors on `HTMLInputElement.prototype`, `HTMLTextAreaElement.prototype` and `HTMLSelectElement.prototype` (own descriptors with get+set), plus `el.constructor === HTMLInputElement` | P0 | Generated classes. React `inputValueTracking.js` and DTL `setNativeValue` (`dom-testing-library/src/events.js:106-123`) depend on it. Measured true in jsdom. |
| `el.style` (camelCase + dashed + `setProperty/getPropertyValue/removeProperty/cssText/cssFloat`), colour normalisation, shorthands | P0 | `css/CSSStyleDeclaration-impl.js`, `css/properties/*` |
| `window.getComputedStyle(el)`: `display`, `visibility`, `opacity`, `pointerEvents`, `color`/colours, `getPropertyValue`; `[hidden]` → `display:none` | P0 | `browser/Window.js:849-867`, `css/helpers/computed-style.js`, `browser/default-stylesheet.css` |
| `MutationObserver` (DTL `waitFor`, RTL), microtask delivery, `takeRecords` | P0 | `mutation-observer/*`, `helpers/mutation-observers.js` |
| `document.getSelection()`, `document.createRange()` (RTL `asFragment`, user-event `setSelectionPerMouse`, jest-dom `toHaveSelection`) | P1 | `range/*`, `selection/*` |
| `window.requestAnimationFrame` (Vitest copies jsdom's), `innerWidth/innerHeight`, `navigator`, `location`, `localStorage/sessionStorage`, `CSS.escape` | P1 | `browser/Window.js` |
| `getBoundingClientRect` (zeros), `offset*/client*/scroll*` = 0 | P1 | `nodes/Element-impl.js:310-349`, `nodes/HTMLElement-impl.js:182-200` |
| Shadow DOM, slots, custom elements, ranges beyond basics, XML, iframes, window named props | P2 | `helpers/shadow-dom.js`, `helpers/custom-elements.js`, `range/*` |

---

## 5. (b) Performance hot spots

Ordered roughly by impact on the benchmark suite. "Cost" figures are measured as described in the
header. "Why" cites the code.

| # | hot spot | cost (jsdom 30.1.3) | why | rsdom opportunity |
|---|---|---|---|---|
| H1 | **Environment creation** (per test file) | `require('jsdom')` 0.63-0.74 s + first window 85 ms + `populateGlobal` (~485 defines) | 3,651 modules, 281 generated wrapper files including the 47,854-line `CSSStyleProperties.js`, undici, css-tree, mdn-data. `vm.createContext` and installing about 210 interfaces per window (§2.11) | A small JS facade + `.node` addon, with lazily defined interfaces. Target < 50 ms per file |
| H2 | **`getComputedStyle` after a mutation** | 150-700 µs cold, 2-60 µs warm; plus 1.6-2.4 µs allocation per call | Whole-document style cache dropped on any connected mutation, focus change, value or checkedness change (§1.3). The UA sheet is re-matched per element through dom-selector on wrappers. Inherited props recurse to the root (§2.8). A new declaration + Proxy per call | Cascade in Rust over a precompiled UA sheet (keyed by tag/attr). **Fine-grained invalidation**: only properties that depend on the changed attribute or tag, or a per-node style generation. Memoize inherited values per ancestor. Return a cheap read-only object (or a lazy one with getters calling Rust once per property) |
| H3 | **`focus()` / `blur()`** | 450-650 µs | `isFocusableAreaElement` computes `display` for every flat-tree ancestor (`focusing.js:31-42`), and `_lastFocusedElement` changes drop the style cache (`Document-impl.js:262-267`) | Cheap "has display:none ancestor" check in Rust (UA rules + inline + `hidden`). Do not invalidate style on focus unless an author sheet uses `:focus*` |
| H4 | **`querySelectorAll` and role-selector lists** | 0.25-15 ms per call on 3k elements; `matches` 2.5 µs | dom-selector Finder walks wrappers with a public TreeWalker. nwsapi is never used for qSA. Caches are cleared on every attribute change (§2.5) | Native selector engine. One crossing per query returns an `Int32Array`/array of ids. Pre-parse and cache selector lists such as DTL's role selectors (keyed by string). Bucket by tag/id/class |
| H5 | **Per-call wrapper tax** | ~220-250 ns floor (`getAttribute` 252 ns, `childNodes[i]` 223 ns via Proxy) | Brand check via private-field `in` + interface-chain compare, argument conversion, CEReactions array push/pop (even on `textContent` getters), `tryWrapperForImpl` (§1.1) | An N-API call is likely 50-150 ns + string marshalling. **Cache immutable facts on the JS wrapper** (`nodeType`, `localName`, `tagName`, `namespaceURI`) to avoid crossings entirely. Never use Proxies for `childNodes[i]` if avoidable; for example, materialise plain arrays lazily per version |
| H6 | **Node creation** | `createElement` 2.4-2.7 µs, 1.6 KB per `div`; `createTextNode` 0.8 µs, 218 B | Wrapper + impl eagerly. `HTMLElement` eagerly allocates the `style` impl + wrapper + Proxy + Maps. `_attributesByNameMap = new Map()` per element. Linear `includes()` scans in `getHTMLElementInterface` (`helpers/create-element.js:135-154`) | Rust arena node + one JS wrapper object created lazily when the node first crosses to JS. `style`, `classList` and `dataset` are lazy. Interned tag names |
| H7 | **Insert/remove** | `appendChild` 6-8 µs; `insertBefore` move 3.6 µs; append+remove at depth 20: 5.9 µs | Ancestor walk in `_invalidateCaches` per inserted node. Several subtree walks (document caches, insertion steps, CE, post-connection, `_cachedRoot` reset, removing steps). Range/NodeIterator bookkeeping. MutationObserver ancestor walk. Radio groups (§2.1) | Generation counters instead of eager ancestor walks. A single subtree walk with flags. Skip work when no observers, ranges, ids or radios are present (keep per-document counters) |
| H8 | **Live collections** | `children.length` after a mutation: 8.8 µs / 100 kids (full rebuild) | Version stamp on all ancestors forces a full re-query (§2.3) | Children list = sibling links (no rebuild). Per-root version for `getElementsBy*`. Incremental where trivial |
| H9 | **Attribute writes** | existing attr 0.65 µs; new + remove 2.3 µs; `className=` 0.44 µs | Attr node + wrapper allocation. Full change pipeline incl. ancestor walk, selector-cache clear, style-cache reset, MO ancestor walk (§2.2) | Attributes as an inline small-vec of interned name + string in Rust; Attr wrappers only on demand (`attributes`/`getAttributeNode`) |
| H10 | **Inline style writes** | `style.color=` 3.5 µs; `setProperty('--x')` 2.3 µs | css-tree parse + validation, full `cssText` reserialization, then an attribute write that triggers the H9 pipeline (§2.7) | A declaration block in Rust with lazy serialization of the `style` attribute (serialize on attribute read), and a fast path for common properties and values. React writes styles on every render that changes them |
| H11 | **Event dispatch** | `dispatchEvent` depth 20: 8.8-9 µs; `new MouseEvent` 7 µs; `click()` 14-15 µs | Path array of 8-field structs. `getRootNode` per entry. `slice()` + `includes()` per listener list. Dictionary conversion copying ~20 init members. Shadow retarget checks even without shadow trees | Path built in Rust as an id array, or in JS from cached parent pointers. Listeners can stay in JS (they are JS functions). Skip retargeting when the document has no shadow roots |
| H12 | **HTML parsing** | `innerHTML` with 4k nodes: 70-115 ms (18-28 µs/node) | parse5 in JS, plus every node inserted through the full mutation algorithm, plus text merging via `replaceData` (§2.6) | Parse in Rust (html5ever) straight into the arena with a bulk "parser insert" that skips per-node mutation machinery. This matters for RTL `asFragment`, `innerHTML` in tests, and `dangerouslySetInnerHTML` |
| H13 | `textContent` getter / serialization | 0.24-0.27 ms / 1.4-1.5 ms per 4k nodes | Generator iteration + string `+=`; the parse5 serializer over the adapter | Native walk; one string crossing |
| H14 | `getElementById` with duplicates / `label.labels` | `getElementById` 0.48 µs normally | `ByIdCache` falls back to a full scan when an id is duplicated; label associations rebuild over the whole root after any mutation (`helpers/form-controls.js:140-166`) | Id → sorted node list in Rust; labels index invalidated by generation |

Notes on methodology and caveats:
- The probes run in a plain Node process with `runScripts:'dangerously'`, `pretendToBeVisual:true` and
  `url:'http://localhost:3000'`, which matches Vitest's options. They are not run through Vitest.
- jsdom cost depends heavily on **what was invalidated since the last read**. A fair benchmark
  interleaves mutations with reads, as React + Testing Library do (render → query → fireEvent →
  re-render → query). Pure read loops make jsdom look better than it is in tests.
- `app-notes.md` already shows the end-to-end symptoms. Role queries (`getAllByRole('link')` over 1,000
  links = 1.5 s) and subtree mounts dominate; H2 + H4 + H5 explain the role-query cost.

---

## 6. (c) Spec behaviours that are easy to get wrong

Each subsection gives the spec rule, jsdom's implementation, and the **observed jsdom output**
(`docs/lab/research/jsdom-probes/oracle.cjs`), which can be used as a test oracle.

### 6.1 Ensure pre-insert validity (DOM §4.2.3)

The order matters, because different exceptions win:
1. The parent must be a Document, DocumentFragment or Element. Otherwise `HierarchyRequestError`.
2. If `node` is a **host-including inclusive ancestor** of the parent, `HierarchyRequestError`. This
   includes `node === parent` and crosses shadow hosts (`Node-impl.js:115-129`).
3. If `child` is non-null and its parent is not `parent`, `NotFoundError`. This comes **after** step 2.
4. `node` must be a DocumentFragment, DocumentType, Element, Text, CDATASection, ProcessingInstruction
   or Comment. Otherwise `HierarchyRequestError`.
5. Text into a Document, or a doctype into a non-Document, is `HierarchyRequestError`.
6. Document-only rules:
   - at most one element child
   - doctype only before the element
   - no Text
   - fragments are checked by their children
   - `replaceChild` and `replaceChildren` **exclude** the replaced child(ren) from these checks
     (`childrenToExclude`, `Node-impl.js:854-995`)

Then **pre-insert** adjusts `if (child === node) child = node.nextSibling` (`Node-impl.js:1001-1004`).
Observed: `p.insertBefore(c1, c1)` is a no-op, c1 stays in place, and nothing throws.

Observed errors:
- appending an ancestor into its descendant: `HierarchyRequestError`
- `insertBefore(x, foreignRef)`: `NotFoundError`
- text into a document: `HierarchyRequestError`
- a 2nd element into a document: `HierarchyRequestError`
- `appendChild({})`: **TypeError** "parameter 1 is not of type 'Node'". This comes from the wrapper
  conversion, not from a DOMException.
- `removeChild(nonChild)`: `NotFoundError`

### 6.2 Insert, remove and move details

- **Moving** a node that already has a parent removes it from the old parent inside *adopt*. The move
  produces **two** MutationRecords: removal from the old parent, then insertion. The old parent's
  "children changed" and `_removingSteps` run, and so do focus fixup and option/select resets
  (`Document-impl.js:1070-1077`). React's keyed reorders (DataTable sort) are all moves.
- `previousSibling` for the insertion record is computed **before** the node is removed from its old
  position (`Node-impl.js:1051-1053`), so it can be the node itself when moving within one parent.
  That quirk matches the spec.
- **Fragments**: inserting a DocumentFragment moves its children. The fragment ends up empty, the call
  returns the fragment (measured `ret===frag true`, `frag.childNodes=0`), the fragment gets its own
  removal record, and the parent gets **one** record listing all children.
- Inserting into a parent whose subtree contains a focused element and then removing that element is
  the "focus fixup" case (§6.9).
- **Live Range offsets** must shift on insert and remove (`Node-impl.js:1034-1049, 1207-1237`). This is
  P1 for rsdom: user-event and React selection restore use Ranges/Selection only lightly.

### 6.3 Adopting nodes (DOM "adopt")

- Adoption **removes the node from its old parent first**, even when the document does not change.
  Only when the document changes does it:
  - update `ownerDocument` on the shadow-including subtree, **including Attr nodes**
  - clear memoized queries
  - enqueue `adoptedCallback`
  - run `_adoptingSteps` (`Element` resets the cached `tagName`, because HTML-ness may differ)

  See `Document-impl.js:1070-1108` and `Element-impl.js:53-57`.
- `appendChild` of a node from another document adopts it implicitly. Measured: `ownerDocument`
  becomes the new document.
- `adoptNode(document)` raises `NotSupportedError`; `adoptNode(shadowRoot)` raises
  `HierarchyRequestError`. `importNode` clones (`Document-impl.js:1033-1066`).
- An rsdom design with **one arena per Document** has to support cross-arena moves:
  `document.implementation.createHTMLDocument()` is used by some libraries, and DOMParser output gets
  adopted. The simplest approach is one arena per *environment*, with `ownerDocument` as a field.

### 6.4 Live `HTMLCollection` / `NodeList` semantics

- `childNodes` and `children` are **live** and **the same object on every access** (measured `true`).
- `querySelectorAll` results are **static** (measured: still 2 after a 3rd `li` is appended, while the
  live collection says 3).
- **Iterating a live collection while removing from it skips items.** Measured: `for (const c of ul.children) c.remove()`
  over 4 items iterates 2 and leaves 2, exactly as in browsers. Code that relies on this behaviour, or
  works around it with `Array.from`, must observe the same results. An rsdom "materialise an array
  snapshot at iterator creation" shortcut would **change** behaviour. Iterators must index the live
  list on each step: `ArrayIterator` over the Proxy, as `HTMLCollection-impl.js:81-84` does with
  `this._list[Symbol.iterator]()` after `_update()`. The `_list` array is mutated in place by later
  `_update()` calls.
- `HTMLCollection.namedItem` / named properties use `id`, then `name` (HTML elements only), and skip
  `""` (`HTMLCollection-impl.js:25-42`). `NodeList` has `forEach/keys/values/entries`;
  `HTMLCollection` has only `Symbol.iterator` (legacy).
- `getElementsByTagName` in HTML documents compares lowercased names for HTML elements and exact names
  otherwise (`helpers/html-collections.js:56-73`). `getElementsByClassName` is case-insensitive only
  in quirks mode.
- The collection identity of `getElementsBy*` across mutations differs from browsers (jsdom returns a
  new object after a mutation). Nothing in the app depends on it.

### 6.5 Event path, retargeting and invocation

- **Path for a node target in a document**: target, then ancestors, then Document, then **Window**,
  except for `load` events, where the document's parent is null (`Document-impl.js:355-361`).
  Observed order for a bubbling event with listeners everywhere:
  `doc-capture(phase 1), outer-capture, inner-capture, inner-bubble, outer-bubble, window-bubble(phase 3)`.
  At the target, capture and non-capture listeners both run with `eventPhase === AT_TARGET (2)`. They
  run in the **capturing pass first** for capture listeners and in the bubbling pass for non-capture
  ones (`EventTarget-impl.js:242-270`). Registration order alone does not decide it.
- **Detached trees**: the path ends at the detached root. There is no Document or Window entry.
- **Retargeting** (shadow DOM): `retarget(A, B)` repeatedly replaces A with its root's host while A's
  root is a shadow root that is not a shadow-including ancestor of B (`helpers/shadow-dom.js:76-92`).
  `relatedTarget` is retargeted per path entry. If target and relatedTarget become equal at some host,
  the path stops there (`EventTarget-impl.js:206-207`). Shadow DOM is P2 for rsdom. Keep the struct
  shape so it can be added later.
- **`composedPath()`** during dispatch returns wrappers: target, ancestors, `#document`, Window
  (measured `SPAN>DIV>BODY>HTML>#document>Window`). After dispatch it returns `[]`.
- **After dispatch**: `currentTarget === null` and `eventPhase === 0`. `target` is kept (unless shadow
  `clearTargets` applies). The event can be **re-dispatched** (measured `true`); re-dispatching during
  dispatch throws `InvalidStateError`.
- **Listener list snapshot**:
  - a listener removed during dispatch does **not** run
  - a listener added during dispatch to the **same** target does **not** run in this dispatch
  - Measured: `remove-during-dispatch: l1`.
- **Duplicates**: same callback and same capture flag are deduplicated; capture vs bubble are distinct
  registrations (measured 2 calls).
- **`once`**: removed **before** invocation. **`passive`**: `preventDefault()` is ignored inside it.
  **`signal`**: listeners are removed on abort, and `addEventListener` with an already-aborted signal
  is a no-op.
- **`handleEvent` objects**: the `handleEvent` property is looked up **at call time** (measured
  `replaced`) and called with `this = the object`.
- **Exceptions**: reported to the window `error` event; **the next listener still runs**; dispatch
  returns `!canceled` (measured `dispatchReturn=true`).
- **`stopPropagation`** stops at the current entry after all its listeners have run.
  **`stopImmediatePropagation`** stops at once.
- **Activation behaviour**:
  - only for `MouseEvent` (PointerEvent included) of type `click`
  - `new Event('click')` dispatched on a checkbox does **not** toggle it; `new MouseEvent('click')`
    does (measured `false` / `true`)
  - the activation target is the target itself if it is activatable, otherwise the nearest
    activatable ancestor **when the event bubbles** (`EventTarget-impl.js:164-216`). So a bubbling
    click on a `<span>` inside a `<button type=submit>` submits the form
  - the legacy pre-activation (checkbox toggle) happens **before** listeners, and is reverted if the
    event is cancelled (measured: `click checked=true, input, change, after=true`; with
    `preventDefault`, `afterPrevented=true`, i.e. restored)

### 6.6 `textContent` setter (DOM "string replace all")

- For Element and DocumentFragment: if the value is `""` or `null`, **remove all children and insert
  nothing**. Otherwise create **one** Text node and replace all children with it.
  - **One** MutationRecord carries all removed and added nodes (measured `records 1, added 1, removed 3`).
  - No record at all if there were no children and the value is empty.
  - The setter **converts `null` to `""`** (`[LegacyNullToEmptyString]`-like: `Node.js` generated
    setter converts `null`/`undefined` to `null`, and the impl treats `null` as `""`;
    `Node-impl.js:799-831`).
- For Text, Comment and PI it is `replaceData(0, length, value)`; for Attr, "set an existing attribute
  value"; for Document and Doctype it is a **no-op** (and the getter returns `null`; measured
  `document.textContent === null`).
- **Getter**: concatenation of **Text and CDATA descendants only**. Comments and PIs are excluded
  (measured `a<!--c-->b` → `ab`). Not `innerText`: no CSS awareness, `<script>`/`<style>` text included.
- React uses `textContent = ''` to clear containers and for single-string children
  (`setTextContent`). `nodeValue =` updates text instances.

### 6.7 Boolean, numeric and string attribute reflection (HTML §2.6.1)

Generated by `jsdom/scripts/webidl/reflection.js`:
- **boolean**: the getter is `hasAttribute(name)`, so **any** value counts as true, including
  `"false"` (measured `setAttribute('disabled','false')` gives `disabled === true`). The setter sets
  `""` or removes the attribute (measured `disabled=true` gives attribute `''`, and `disabled=0`
  removes it) (`reflection.js:149-161`).
- **DOMString**: the getter returns `attr ?? ""`, the setter sets the stringified value. **Nullable**
  DOMString reflection (nonstandard in jsdom) returns `null` and removes the attribute on a `null` set
  (`reflection.js:122-147`).
- **USVString with `[ReflectURL]`** (`a.href`, `img.src`, ...): resolved against the document base URL,
  falling back to the raw value if unparseable, and cached per (value, baseURL) (`reflection.js:76-106`).
  Measured: `href="/p?q"` gives `http://localhost:3000/p?q`. The base URL depends on the Vitest `url`
  option.
- **long**: the getter parses with the HTML integer rules. If the value is invalid or out of range it
  returns the default (0, or -1 for `[ReflectNonNegative]`). The setter writes `String(V)`;
  NonNegative setters throw `IndexSizeError` for negative values (`reflection.js:163-206`).
- **unsigned long**: has range clamping and `[ReflectPositive]` minimums (`reflection.js:208-...`).
- **Not plain reflection**:
  - `tabIndex`: a custom getter. Without the attribute it is **0 for `a, area, button, frame, iframe, input, object, select, textarea`, `summary` of `details` and SVG `a`, else -1**. An invalid attribute gives 0 (measured `tabindex="abc"` → 0) (`HTMLOrSVGElement-impl.js:28-39`). user-event's tab order depends on it.
  - `className`: reflects `class`. `htmlFor` reflects `for`.
  - `classList` / `dataset` are live views of the attribute.
  - `hidden`: plain boolean in jsdom 30 (`HTMLElement.webidl:12`). The current HTML spec has
    `(boolean or unrestricted double or DOMString)? hidden` with `"until-found"`. DTL reads
    `element.hidden === true`, so the boolean form is what the suite needs.
  - `value` / `checked` / `selected`: **not** reflections (see 6.8). `defaultValue`, `defaultChecked`
    and `defaultSelected` are the reflections.
  - `input.type`: reflects with a fallback to `text` for unknown values (`getTypeFromAttribute`,
    `HTMLInputElement-impl.js:99-105`). `button.type` defaults to `submit` (measured).

### 6.8 Form control value vs defaultValue vs the `value` attribute

`<input>` in value mode **"value"** (text-like types):

| step | `.value` | `.defaultValue` | `getAttribute('value')` |
|---|---|---|---|
| `setAttribute('value','a')` on a fresh input | `a` | `a` | `a` |
| `.value = 'typed'` (sets the **dirty** flag) | `typed` | `a` | `a` (attribute untouched) |
| `setAttribute('value','b')` while dirty | `typed` (no longer follows) | `b` | `b` |
| `.defaultValue = 'c'` | `typed` | `c` | `c` |
| clean input, `.defaultValue = 'x'` | `x` (follows while not dirty) | `x` | `x` |

(All measured; `HTMLInputElement-impl.js:235-243, 387-422`.)

- Other value modes:
  - **"default"** (`hidden`, `submit`, `image`, `reset`, `button`): `.value` *is* the attribute, and
    setting it writes the attribute.
  - **"default/on"** (`checkbox`, `radio`): the attribute, else `"on"` (measured `'on'`).
  - **"filename"** (`file`): `C:\fakepath\…`; only `""` can be set, anything else is `InvalidStateError`.
- **Sanitization** on set and on type change (number: invalid becomes `""`; email/url/text: strip
  newlines; and so on) (`helpers/form-controls.js` `sanitizeValueByType`).
- **`checked`** works the same way: `checked` attribute → `defaultChecked`, and `.checked` sets
  dirty-checkedness. Radio group exclusivity is enforced on every set to true, by name, within the
  form owner or the root (measured `r1=false r2=true`).
- Setting `.value` moves the selection to the end if the value changed (`HTMLInputElement-impl.js:418-421`).
  user-event relies on `selectionStart/End`.
- **Reset** (`form.reset()` / reset button) restores the default value and checkedness and clears the
  dirty flags (`HTMLInputElement-impl.js:299-305`).
- **Cloning** copies `#value`, checkedness and the dirty flags (`:1100-1106`).
- **`<textarea>`**: `defaultValue` = child text content; `.value` setter → dirty; the raw value
  follows child changes only while not dirty (measured: after `value='x'`, `textContent='dv2'` gives
  `value` still `x` and `defaultValue` `dv2`). CRLF is normalized in the API value.
- **`<select>`**: `.value` setter picks the first option with that value, or none (`selectedIndex -1`).
  `option.selected` is selectedness; the `selected` *attribute* is `defaultSelected` (measured: after
  `select.value='bv'`, `opt.selected` is true and `hasAttribute('selected')` is false). The
  select's "selectedness setting algorithm" makes a single-select with no selected option select the
  first non-disabled option on reset.
- **Why this matters**: React's controlled inputs install a value tracker. It defines an **own**
  `value` property on the element that delegates to the **prototype descriptor**
  (`react/packages/react-dom-bindings/src/client/inputValueTracking.js`, see `react-dom.md` §6.1).
  DTL `fireEvent.change(el, {target:{value}})` calls the **prototype's** setter directly so that the
  tracker sees a change (`dom-testing-library/src/events.js:106-123`). rsdom needs:
  1. own `get`/`set` accessors for `value`/`checked` on `HTMLInputElement.prototype` (not inherited
     from a shared base)
  2. the tracker redefinition on the instance must not break internal reads; rsdom-internal code must
     read the Rust-side value and **never** go through the JS property

### 6.9 `focus` / `blur` and event order

Measured sequence (listeners in capture on `document`):

```
a.focus():   focus:a (active=a, related=null) | focusin:a (active=a)
b.focus():   blur:a (active=BODY, related=b) | focusout:a (active=BODY, related=b)
             | focus:b (active=b, related=a) | focusin:b (active=b, related=a)
b.blur():    blur:b (active=BODY, related=null) | focusout:b (active=BODY)
```

- Order: **blur → focusout → focus → focusin**. `blur` and `focus` do **not bubble**;
  `focusin`/`focusout` do. All are `composed: true` `FocusEvent`s with `detail 0` and `view = window`
  (`focusing.js:99-118`). React's `onFocus`/`onBlur` listen to `focusin`/`focusout` on the root
  (`react-dom.md` §5).
- **`activeElement` is cleared before blur fires** (it reads `body` during blur/focusout) and set
  before focus fires (`focusing.js:245-255, 287-293`).
- `relatedTarget` is the other element only when both chain ends are elements.
- **Re-entrancy**: if a blur listener moves focus elsewhere, the original focus is abandoned
  (`focusing.js:269-275`). The same applies to focus listeners (`:308-311`).
- **Focusability gates** (measured):
  - a plain `<div>` does not take focus, but `div[tabindex=-1]` does
  - a **detached** input does not take focus
  - a `display:none` ancestor prevents focus
  - a disabled control is not focusable
- **Focus fixup on removal**: removing the focused element (or an ancestor) makes `activeElement` fall
  back to `body` and **fires no blur/focusout** (measured `blurFired=false`; `Node-impl.js:509-515`).
  This matches the current HTML spec; older Chrome behaved differently. Modal "restore focus" tests
  are sensitive to it.
- **`element.focus()` on the already-focused element** is a no-op (no events).
- `window.focus()`/`window.blur()` are not implemented in jsdom (`Window.js:916-918`).
- user-event patches `HTMLElement.prototype.focus/blur` and listens for `focus`/`blur` on `document`
  in capture mode (`app-notes.md`). So `focus`/`blur` must exist **on `HTMLElement.prototype`** (and
  SVGElement), and capture listeners on `document` must see non-bubbling focus events (they do: the
  capture path reaches the document).

### 6.10 Other traps worth listing

- **UTF-16 everywhere**: `CharacterData.length`, `substringData`/`replaceData` offsets,
  `selectionStart`/`selectionEnd`/`setSelectionRange`, `maxlength`, `textLength` and Range offsets are
  **UTF-16 code units** (measured `"😀".length === 2`; `setSelectionRange(1,3)` on `a😀b` → `1,3`). A
  Rust store in UTF-8 must convert offsets, or store UTF-16 for text-bearing nodes.
- **HTML-document case rules**:
  - `createElement('Div')` gives `localName 'div'` and `tagName 'DIV'`
  - `setAttribute('ARIA-Label')` lowercases for HTML elements in HTML documents only
  - SVG `foreignObject` keeps its case (measured)
  - `getAttribute` lowercases its argument under the same condition
- **Attribute order** = insertion order. Re-setting an existing name keeps its position (measured
  `b=3,a=2`). pretty-format sorts names itself; snapshot tests depend on that, not on DOM order.
- **`dataset`**: `fooBar` ↔ `data-foo-bar`. Spreading `{...el.dataset}` enumerates own props in
  attribute order (measured).
- **`Event.timeStamp`** is epoch ms (`Date.now()`) in jsdom; browsers use a `performance.now()`-based
  value. React only uses it for its own scheduling heuristics.
- **`MutationObserver` delivery** happens in a microtask via `Promise.resolve().then` with a global
  "queued" flag. Observers are notified in creation order, and the record queue is swapped before the
  callback (`helpers/mutation-observers.js:157-213`). Exceptions in callbacks go to the window `error`
  event. DTL `waitFor` relies on at least one callback per macrotask with DOM changes.
- **`checkValidity()`** fires an `invalid` event (cancelable) when it returns false. `required` on an
  empty input → `valueMissing`. email `typeMismatch` (measured: empty false, bad false, good true).
- **`label` activation**: clicking a label clicks its control unless the click target is interactive
  content inside the label, or the control itself (`HTMLLabelElement-impl.js:55-80`). Not exercised by
  the app yet (`app-notes.md`), but common in user code.
- **`document.body.innerHTML = ...` in tests** replaces React containers. RTL's `cleanup` removes its
  own containers with `removeChild`; leftovers are a common source of cross-test leakage. jsdom does
  nothing special here.

---

## 7. jsdom deviations and quirks that tests may (accidentally) depend on

| quirk | jsdom 30.1.3 (measured / cited) | browser | rsdom suggestion |
|---|---|---|---|
| `getComputedStyle()` result | snapshot, read-only | live | Live is cheap if it is a lazy getter object; either choice passes the suite |
| Computed style of detached element | UA defaults (`display:block`) | empty strings | Match jsdom (tests sometimes call it before attaching) |
| Layout | all zeros; `innerWidth` 1024 / `innerHeight` 768 | real | Match jsdom |
| `click()` event type | `PointerEvent`, `detail 0`, `isTrusted false` | PointerEvent, `detail 1` | Match jsdom |
| Removing focused element | focus → body, no blur | spec: same (no blur) | Match |
| Errors thrown by wrappers | realm of the vm context (`instanceof TypeError` false in tests) | n/a | Throw test-realm errors |
| `DOMException instanceof Error` | **false** in the test realm | true | Make it true |
| Typed arrays on global | replaced by the vm realm's | n/a | Do not override |
| `event.view === window` in Vitest | false (`view` is the jsdom window, global is Node's) | true | Make the window *be* `globalThis` |
| `getElementsByTagName` identity | new object after any mutation | usually cached | Either |
| Unprevented form submission / `form.submit()` | "Not implemented" `jsdomError` printed to the console | navigates | Silent no-op (or the same message, for parity) |
| `getComputedStyle(el, '::before')` | "Not implemented" `jsdomError` + element styles | pseudo styles | Return an empty or `content: none` declaration silently. DTL does not ask by default (`dom-testing-library/src/config.ts:50`) |
| `matchMedia`, `scrollIntoView`, `ResizeObserver`, `IntersectionObserver`, `DataTransfer` | absent | present | Absent, or present as no-op stubs. **Note**: adding `matchMedia` changes code paths in libraries that feature-detect it; keep parity first |
| Window named properties (`window.someId`) | implemented (prototype chain) | yes | P2 |

---

## 8. Design recommendations for rsdom (derived from jsdom)

1. **Copy jsdom's semantics, not its structure.** jsdom's impl files are close transliterations of
   the spec algorithms and are good references. Its *structure* is the problem: eager wrapper and impl
   pairs, eager style objects, Proxies, generic WebIDL glue on every call, and broad eager
   invalidation.
2. **Minimise boundary crossings; do whole algorithms natively.** In priority order:
   - selector matching for `querySelector(All)`, `matches` and `closest`
   - the computed-style cascade, including the "is hidden / display:none ancestor" helpers used by
     focus
   - `textContent` get/set
   - `innerHTML` parse and serialize
   - the subtree walks in insert and remove
   - id lookup
   - label association

   These are exactly where jsdom spends most of its time per Testing Library query. A single crossing
   should return a typed array of node ids that JS maps to wrappers through a per-environment
   `Array`/`Map` id → wrapper table.
3. **Keep a JS-side cache of immutable per-node facts on the wrapper** (`nodeType`, `localName`,
   `namespaceURI`, `tagName`, and perhaps `ownerDocument`). Every DTL/jest-dom/React call reads these
   repeatedly, and a crossing for each would cost more than jsdom's private-field read.
4. **Create wrappers lazily, keep them stable.** React stores expandos on DOM nodes and compares
   identities, so the id → wrapper mapping must persist. Free the arena at teardown. Tests are short
   and a per-environment arena is simpler than GC-coupled node lifetimes.
5. **Invalidate with generation counters instead of eager walks.** Use one document-wide
   "tree/attribute generation", plus per-node "style-relevant generation" if needed. Live collections
   and caches compare generations lazily. For styles, distinguish mutations that can change a
   computed value (tag, `hidden`, `style`, `class`/`id` only if author sheets exist, attributes used by
   UA selectors such as `type`, `open`, `dir`) from those that cannot (`aria-*`, `data-*`, text data).
   That alone turns most of jsdom's 150-700 µs cold reads into warm ones for role queries.
6. **Precompile the UA stylesheet** (or the subset that matters: `display` per tag, `[hidden]`,
   `visibility`, `pointer-events`, colours, `font-*`) into Rust tables keyed by tag and attribute.
   Author `<style>` sheets are rare in RTL tests (the app has none), but they must still be supported
   for correctness.
7. **Treat prototypes as part of the public contract.** Own accessors per interface prototype
   (`HTMLInputElement.prototype.value`, `checked`, `HTMLSelectElement.prototype.value`,
   `HTMLTextAreaElement.prototype.value`), `focus`/`blur`/`click` on `HTMLElement.prototype`, and
   correct `constructor`, `instanceof` and `Symbol.toStringTag`. pretty-format identifies DOM nodes by
   `constructor.name` and `nodeType`; DTL and jest-dom use `instanceof window.HTMLElement`.
8. **Get the error realm right** (§3.4) and replicate Vitest's error-event semantics (§3.2 step 6).
9. **Benchmark mutation-interleaved workloads** (§5 caveats). The jsdom probes in
   `docs/lab/research/jsdom-probes/` can be pointed at rsdom (same API) for apples-to-apples
   micro-benchmarks.

---

## 9. Reproducing the measurements

```bash
cd rsdom-lab/docs/research/jsdom-probes
node envcreate.cjs        # require + new JSDOM timings, realm checks
node reqprofile.cjs       # module-load self-time by package
node ops.cjs              # DOM op micro-benchmarks (table in §5)
node sel.cjs              # selector variants + computed-style + focus
node oracle.cjs           # spec-behaviour oracle outputs (§6)
node --expose-gc mem.cjs  # heap bytes per node
```

All scripts `require("rsdom-lab/app/node_modules/jsdom")` (30.1.3) and print to stdout.
The output of one full run is saved in `results-jsdom-30.1.3.txt`. npm prints `EBADENGINE` warnings
because jsdom 30 declares `node ^22.22.2` and Node here is 22.22.0; they are harmless.
