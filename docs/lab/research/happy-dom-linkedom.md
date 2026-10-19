# happy-dom 21.0.3 and linkedom 0.18.13: what makes them fast, what they skip, and what rsdom should copy

Scope: the source of happy-dom (`refs/happy-dom`, tag `v21.0.3`, commit `875ef5c`), the Vitest
happy-dom environment (`refs/vitest`, 5.0.5) and linkedom (`refs/linkedom`, 0.18.13, commit `3fcf145`).
The goal is to explain *why* happy-dom beats jsdom where it does, where it does not, and which data
structures and tricks rsdom (Rust arena + N-API + JS facade) should adopt or avoid.

All source paths below are relative to `refs`. `HD/` is shorthand for
`happy-dom/packages/happy-dom/src/`, `LK/` for `linkedom/esm/`, `VT/` for
`vitest/packages/vitest/src/integrations/env/`.

Measurements come from new probes in `docs/lab/research/happy-dom-probes/`. They run **the same operation
list** as the jsdom probes in `docs/lab/research/jsdom-probes/ops.cjs`, so the numbers sit side by side
with `docs/lab/research/jsdom-probes/results-jsdom-30.1.3.txt`. Raw output is in
`docs/lab/research/happy-dom-probes/results-happy-dom-21.0.3-linkedom-0.18.13.txt`, and §7 says how to
reproduce it. Setup: Node 22.22.0, 4 CPUs, plain Node process (not inside Vitest). Single runs are
noisy (±20-30 %), so read them as orders of magnitude.

Companion notes: `jsdom.md` (jsdom internals, hot spots H1-H14), `react-dom.md` (what React needs),
`app-notes.md` (end-to-end suite timings). This file does not repeat them.

---

## 0. TL;DR

1. **happy-dom is not uniformly faster than jsdom. It is faster where it caches or where it skips a layer.**
   - Faster: environment creation (import ≈330-400 ms vs 626 ms; a warm window 0.9-1.6 ms vs 8.4 ms), event
     *construction* (`new MouseEvent` 0.28 µs vs 6.9 µs), `focus()`/`blur()` (21-26 µs vs 625 µs),
     `getAttribute` (38 ns vs 252 ns), `getElementById` (56 ns vs 476 ns), and **any repeated
     query on an unchanged tree** (warm `querySelectorAll` 0.3-0.7 µs, warm `matches` 0.13 µs, warm
     `getComputedStyle().display` 2 µs).
   - Slower or equal: almost every **mutation**:
     - `setAttribute` 1.8-2.0 µs vs 0.65 µs
     - `className=` 1.7-1.9 µs vs 0.44 µs
     - `appendChild` 7.5 µs vs 6.5 µs
     - `style.x=` 3.9-4.6 µs vs 3.5 µs
   - Also slower or equal: dispatch (13.6-14.6 µs vs 8.8 µs at depth 20), `textContent` get (634-648 µs
     vs 242 µs per 4k nodes), serialization (2.7-3.7 ms vs 1.4 ms), **cold** selector queries (1.6-11 ms on a
     3k-element table, often *slower* than jsdom), **cold** computed style (4-6 ms vs 0.25-0.32 ms)
     and memory (3.7 KB per `div` vs 1.6 KB; 2.5 KB per Text vs 218 B).
   - This matches `app-notes.md`: role queries are 3-5× faster on happy-dom (warm caches inside a
     query), while render and re-order of 1000 rows is equal or slower.
2. **Design choices behind the wins:**
   - (a) **No wrapper/impl split and no WebIDL conversion layer.** Public classes *are* the
     implementation, and internals hang off Symbol-keyed properties (§2.1).
   - (b) **Module-level classes shared by all windows.** Only ~45 "constructable" classes get a
     per-window subclass (§2.11), so a window is cheap.
   - (c) **Aggressive memoisation with reverse-dependency invalidation.** This covers parsed
     selectors per window, results per (node, selector) for `querySelector(All)`, `matches`,
     `getElementsBy*`, `getElementById`, and computed style per element (§2.5, §2.6).
   - (d) **A lazily evaluated, cached computed `CSSStyleDeclaration`** (§2.6).
   - (e) Cheap shortcuts:
     - `document.getElementById` via an id → elements map
     - `children`/`childNodes` wrap the live backing arrays
     - zero-delay timers are grouped into one `setTimeout`
     - `requestAnimationFrame` is `setImmediate`
     - `focus()` without focusability or style checks
3. **Design choices behind the losses:**
   - The tree is **arrays of children** (`nodeArray`/`elementArray`) plus a parent pointer.
     `nextSibling` is `indexOf` (O(n); a 5000-child walk takes 4.8-13.6 ms).
   - Every insert re-walks the whole inserted subtree (`connectedToNode`). React builds detached
     trees bottom-up, so this costs O(n·depth): a 1001-node, depth-200 build takes 65-69 ms. jsdom
     pays the same O(n·depth), and more (96-111 ms), because the spec's insertion steps visit every
     inclusive descendant. This is an open opportunity for rsdom (§5.1).
   - Every node eagerly allocates **7 cache `Map`s, 4 listener `Map`s, 4 arrays**, and every
     Element a `NamedNodeMap` with 3 more `Map`s plus a `Set` and a `Map`. That is 49 symbol-keyed
     own properties per `div`.
   - Every attribute is a full `Attr` *Node*.
   - Every mutation allocates a `MutationRecord` and clears caches.
   - `MutationObserver({subtree})` pushes the listener into *every descendant*. In probes, observe
     takes 4.1-4.5 ms and disconnect 3.5-3.8 ms on 4k nodes, and DTL's `waitFor` does this per call.
4. **happy-dom's caching is clever but leaky and sometimes wrong.**
   - Each cached result is pushed into the `affectsCache` array of every node the query visited, and
     into `document`'s. It is only released when *that* node mutates.
   - Arrays on nodes that never change therefore grow without bound: +1 entry per cold query; 1000
     cold `qSA('*')` on 3k elements left ≈57 MB retained after GC.
   - Dependencies are incomplete. Computed style only registers ancestors, so `.a + li` rules go
     stale (verified, §2.13).
   - `focus()` clears the document's cache, which drops *every* connected selector cache.
   - **rsdom should copy the memoisation, not the invalidation scheme. Use generation counters
     (epochs).**
5. **linkedom keeps the document as one doubly linked list in document order.** Each element has a
   start node and an `END` marker, and attributes sit inline after the start. As a result:
   - A subtree is a contiguous segment.
   - Moving a ~4,000-node `<tbody>` (3,000 elements + text) is an O(1) splice: remove + re-append
     takes 139-239 ns.
   - Serialization and `textContent` are a single flat loop.
   - Parsing appends at the tail in O(1), with mutation bookkeeping switched off while parsing.
   - `qSA` is a flat `while (next !== end)` loop with no recursion.

   It is slow wherever the DOM needs *child-indexed* or *ancestor* information:
   - `childNodes`/`children` allocate a fresh array on every access (`childNodes[i]` on a 5000-child
     list takes 254-288 µs).
   - `isConnected`, `contains` and `compareDocumentPosition` walk ancestors.
   - css-select's `:first-child` and sibling combinators re-materialise sibling lists per element.
   - `compareDocumentPosition` is **wrong**: it compares depths, not order (verified).
6. **What rsdom should take:**
   - **From happy-dom:**
     - shared module-level classes
     - lazy computed style with per-element memo
     - a per-environment parsed-selector cache
     - an id map
     - the per-tag UA `display` table
     - activation behaviour hooked into dispatch
     - zero-delay timer grouping (optional)
     - Symbol-keyed internals on the JS facade (keeps `Object.keys`, JSON and pretty-format clean)
     - exact `constructor.name` per interface (DTL's pretty-format plugin depends on it)
   - **From linkedom:**
     - O(1) structural moves
     - flat pre-order iteration
     - an "is anyone observing?" flag that skips MutationObserver work entirely
     - a parser fast path that bypasses the mutation pipeline
   - **From neither:**
     - an index-based tree (happy-dom)
     - inline attributes in the node list (linkedom)
     - per-node reverse-dependency arrays
     - Proxies on hot objects
     - eager per-node allocations
7. **Recommended Rust layout:**
   - Arena of nodes addressed by `u32`.
   - Five links per node (`parent`, `first_child`, `last_child`, `prev_sibling`, `next_sibling`).
     These give O(1) everything happy-dom does with `indexOf`, O(1) splice like linkedom, and
     pre-order "next" by `first_child`/`next_sibling`/climb.
   - Inline small-vec attributes keyed by interned atoms.
   - A per-document id map.
   - A global `tree_epoch` plus `style_epoch` for cache validity.
   - Selector and computed-style memo tables keyed by `(node, selector-id, epoch)`.
   - See §5.

---

## 1. Why this matters for rsdom

| Fact | Source |
|---|---|
| Tests interleave render → query → event → re-render → query | `app-notes.md`, `jsdom.md` §5 |
| A single `getByRole` calls `el.matches(sel)` up to ~100 times *per candidate element* (implicit-role table) and `getComputedStyle` per element and ancestor | `dom-testing-library/src/role-helpers.js:68-78, 100-160`, `dom-testing-library/src/queries/role.ts:186-212` |
| `waitFor`/`findBy*` poll every 50 ms **and** on every mutation via `MutationObserver(container, {subtree, childList, attributes, characterData})` | `dom-testing-library/src/wait-for.js:25-37, 101-104` |
| Each failed attempt inside `waitFor` builds an error with `prettyDOM(container)`, a full DOM walk through the public API | `dom-testing-library/src/config.ts:36-48` |
| Accessible-name computation reads `getComputedStyle(child).display` for every child element | `dom-accessibility-api/sources/accessible-name-and-description.ts:399-416` |

So the shape of the workload is: **many reads per mutation, of a small set of distinct selectors,
over a mostly unchanged tree**. That is exactly where happy-dom's memoisation pays off, and why it
wins end to end despite slower mutations.

---

## 2. happy-dom internals

### 2.1 Object model: one class per interface, Symbol-keyed internals, no wrapper layer

- **Public classes are the implementation.** `Node`, `Element`, `HTMLElement`, `HTMLInputElement`, …
  are ordinary TypeScript classes. Methods run directly on the object the user holds. Compare jsdom:
  generated wrapper → brand check → `implForWrapper` → impl → `tryWrapperForImpl`
  (`jsdom.md` §1.1, about 220-250 ns floor per call). happy-dom pays none of that:
  - `getAttribute` is 38 ns (jsdom 252 ns)
  - `new MouseEvent` is 0.28 µs (jsdom 6.9 µs, which runs WebIDL dictionary conversion)
- **Internals are Symbol-keyed properties.** There are 429 exported symbols in `HD/PropertySymbol.ts`,
  for example `PropertySymbol.parentNode`, `.nodeArray`, `.cache`, `.affectsCache`, `.tagName`,
  `.attributes`. Fields are declared with `public declare [PropertySymbol.x]` and initialised in
  constructors (`HD/nodes/node/Node.ts:72-149`, `HD/nodes/element/Element.ts:55-123`).
  - Why symbols rather than `#private`: any module can reach them. For example, `QuerySelector`
    reads `element[PropertySymbol.elementArray]` and `CSSComputedStyle` writes
    `element[PropertySymbol.cache].computedStyle`. They work as "friend" access across files.
  - Why symbols rather than `_underscore` fields: they are invisible to `Object.keys`, `for…in`,
    `JSON.stringify` and pretty-format's object printer. Verified: `Object.keys(div)` is `[]`,
    `JSON.stringify(div)` is `{}`, and a `div` has **49 symbol-keyed own properties**
    (`happy-dom-probes/env.mjs`).
  - V8 treats symbol keys like named properties with stable hidden classes, so access is
    inline-cached and as fast as a string field.
- A few things use real `#private` fields. Examples: `HTMLInputElement` selection state
  (`HD/nodes/html-input-element/HTMLInputElement.ts:76-78`) and `EventTarget`'s dispatch helpers
  (`HD/event/EventTarget.ts:212, 272`).
- **Per-tag classes with the right names.**
  - `createElement('input').constructor.name === 'HTMLInputElement'` and a text node's is `'Text'`.
  - DTL's pretty-format DOM plugin only recognises nodes whose `constructor.name` matches
    `/^((HTML|SVG)\w*)?Element$/`, `Text`, `Comment` or `DocumentFragment`
    (`dom-testing-library/src/DOMElementFilter.ts:159-185`).
  - **rsdom wrappers must use the real interface names**, or DTL error messages print nodes as
    plain objects instead of markup.
- **The value accessor sits on the exact prototype.** `HTMLInputElement.prototype` owns `value` and
  `checked` accessors, and `node.constructor.prototype` is that prototype, because `HTMLInputElement`
  is *not* subclassed per window (§2.11). React's value tracker requires this
  (`react/packages/react-dom-bindings/src/client/inputValueTracking.js:54-71`). Verified in `env.mjs`.
- **`new HTMLDivElement()` throws `Illegal constructor`, yet internal code can construct nodes.** The
  trick is `NodeFactory` (`HD/nodes/NodeFactory.ts:9-37`):
  - Internal callers push the owner document onto a static stack, then call `new Class()`.
  - The `Node` constructor pops it (`HD/nodes/node/Node.ts:141-154`).
  - Classes extended per window carry `prototype[PropertySymbol.window]` instead, so `new Text()`
    from user code works and finds its window without arguments.
- **Custom element upgrade in place.** Every constructor in the chain first checks
  `this.constructor[customElementUpgradeTarget]` and returns the existing object
  (`HD/nodes/node/Node.ts:104-117`, `HD/event/EventTarget.ts:32-43`).

### 2.2 Tree representation: child arrays plus a parent pointer

Each `Node` holds the following (`HD/nodes/node/Node.ts:72-85, 118-135`):

- `[parentNode]`
- `[nodeArray]` (all children) and `[elementArray]` (element children only, kept in sync)
- `[childNodes]` (lazy `NodeList` over `nodeArray`)
- `[rootNode]`, `[isConnected]`
- "context" pointers propagated down the tree: `[formNode]`, `[selectNode]`, `[textAreaNode]` and
  `[styleNode]`. These answer "which `<form>`/`<select>`/`<textarea>`/`<style>` am I inside" in O(1).

Costs this creates:

| Operation | Implementation | Complexity |
|---|---|---|
| `firstChild`, `lastChild`, `childNodes[i]`, `children[i]`, `childElementCount`, `hasChildNodes` | array index | O(1) |
| `nextSibling` / `previousSibling` | `parent.nodeArray.indexOf(this)` (`Node.ts:266-293`) | **O(siblings)**, so a sibling walk is O(n²). Measured: 100 children 32 µs, 1000 → 320-400 µs, 5000 → 4.8-13.6 ms |
| `next/previousElementSibling` | loops of `nextSibling` (`HD/nodes/child-node/NonDocumentChildNodeUtility.ts:6-21`) | O(n²) in the worst case |
| `appendChild` | `push` + `connectedToNode()` on the inserted node (`Node.ts:509-576`) | O(subtree) |
| `insertBefore` | `includes` + `indexOf` + `splice` on both arrays, plus a scan for the element-array position (`Node.ts:649-760`) | O(siblings + subtree) |
| `removeChild` | `indexOf` + `splice` ×2 + `disconnectedFromNode()` recursion (`Node.ts:582-638`) | O(siblings + subtree) |
| `contains` | ancestor walk (`HD/nodes/node/NodeUtility.ts` `isInclusiveAncestor`) | O(depth) |
| `compareDocumentPosition` | ancestor chains, then a *recursive numbering of the whole common-ancestor subtree* (`Node.ts:1140-1306`) | O(subtree) |

**The subtree walk on every insert.**
- `connectedToNode()` (`Node.ts:964-1028`) recomputes for the inserted node: `isConnected`,
  `ownerDocument`, `window`, `rootNode` and the four context pointers.
- It then recurses into **every child** (`nodeArray.slice()` at every level).
- This runs on *every* insertion, including into a detached parent.
- React's commit builds host trees **detached and bottom-up** (`react-dom.md` §4.1): each level is
  appended into its parent before that parent is attached. The total cost is therefore
  Σ subtree sizes = O(n·depth). Measured (`ops.mjs`):
  - depth 10 / 51 nodes: 0.5 ms
  - depth 50 / 251 nodes: 4.1-5.3 ms
  - depth 200 / 1001 nodes: **65-69 ms** (≈65 µs per node)
- jsdom has the same asymptotics. Its `_insert` runs the spec's per-descendant insertion steps and
  then a post-connection pass over every inclusive descendant, connected or not
  (`jsdom/lib/jsdom/living/nodes/Node-impl.js:1088-1116`). Measured with the same probe
  (`happy-dom-probes/bottomup-jsdom.cjs`): 2.7-3.3 ms, 6.8-10.6 ms and **96-111 ms** for depth
  10/50/200. So happy-dom is ~1.5× better here, not worse. Neither skips the walk when nothing in the
  subtree needs it. rsdom can: walk only when connectivity changes, or when the subtree contains
  nodes with insertion steps (a per-subtree count of `script`/`iframe`/`style`/`link`/form-associated
  or custom elements).

### 2.3 Per-node memory: everything is eager

`Node` constructor (`HD/nodes/node/Node.ts:118-135`):
- 4 arrays (`mutationListeners`, `nodeArray`, `elementArray`, `affectsCache`)
- a `cache` object with **7 `Map`s** (`querySelector`, `querySelectorAll`, `matches`,
  `elementsByTagName`, `elementsByTagNameNS`, `elementByTagName`, `elementById`)

`EventTarget` constructor (`HD/event/EventTarget.ts:46-53`): 4 more `Map`s (listeners and options,
for each of capture and bubble).

`Element` constructor (`HD/nodes/element/Element.ts:83-123`):
- a `NamedNodeMap` with 3 `Map`s (`HD/nodes/element/NamedNodeMap.ts:14-23`)
- `pointerCaptures: new Set()`
- `propertyEventListeners: new Map()`
- `animations: []`

Measured heap per node (`ops2.mjs`, `--expose-gc`; jsdom from `jsdom-probes/mem.cjs`):

| node | happy-dom | jsdom | linkedom (structure) |
|---|---:|---:|---|
| Text | **2,522 B** | 218 B | 3 links + value |
| `div` | **3,730 B** | 1,595 B | start + END object |
| `div` + id + class | **9,084 B** | 2,365 B | + 2 Attr nodes in the list |
| `input` | 3,909 B | 1,706 B | |

Lesson: happy-dom's speed is **not** from lean nodes. rsdom should allocate nothing optional per
node: caches, listener maps, `classList`, `style` and `dataset` all lazy. In Rust, the node itself
should be a compact struct.

### 2.4 Attributes

- **Storage.** `NamedNodeMap` holds 3 `Map`s keyed by template strings (`${ns}:${localName}`,
  `${ns}:${name}`, and name → `Attr[]`) (`HD/nodes/element/NamedNodeMap.ts:14-23, 194-243`).
- **Reads.** `getAttribute` does `asciiLowerCase(name)`, one `Map.get` and returns `[value]`
  (`NamedNodeMap.ts:88-101`, `Element.ts:820-826`). Fast: 38 ns.
- **Writes.** `setAttribute` (`Element.ts:737-788`):
  1. validates the name
  2. **creates an `Attr` node**, a full `Node`, so 7 cache Maps and more
  3. `setNamedItem`: three map writes, then `onSetAttribute`
  4. `onSetAttribute` (`Element.ts:1542-1605`) handles slot updates, invalidates `on*` property
     listeners, maintains the id map, then `reportMutation(new MutationRecord(...))`
  5. `reportMutation` (`Node.ts:836-878`) runs `clearCache()` and then the listeners
  - Even an unchanged value re-runs all of this. Cost: 1.8-2.0 µs (jsdom 0.65 µs). `className=` costs
    1.7-1.9 µs (jsdom 0.44 µs).
- **Derived data keyed by the source string.** This pattern is worth copying:
  - `DOMTokenList` (`classList`) re-tokenises only when the attribute string differs from the last
    one it saw (`HD/dom/DOMTokenList.ts`, `[getTokenList]`).
  - The inline `style` declaration re-parses only when the `style` attribute string changes
    (`HD/css/declaration/CSSStyleDeclaration.ts:332-353`).
  - No invalidation plumbing is needed: the attribute value *is* the version.

### 2.5 Selector engine and query caching

**Parsing** (`HD/query-selector/SelectorParser.ts`):
- Two big regexes:
  - `SELECTOR_GROUP_REGEXP` splits on combinators and commas while tracking bracket and quote
    depth.
  - `SELECTOR_REGEXP` (`:47`) tokenises compounds into `SelectorItem { tagName, id, classNames[],
    attributes[] (with a precompiled RegExp for ~= |= ^= $= *=), pseudos[], combinator }`.
- **Parsed selectors are cached per window** in `window[PropertySymbol.querySelectorCache]: Map<string,
  SelectorItem[][]>` (`SelectorParser.ts:135-148`, `HD/window/BrowserWindow.ts:877`). They are never
  evicted until the window is destroyed. Parsing errors are built lazily because creating a
  `DOMException` captures a stack (`SelectorParser.ts:150-166`).
- Simplifications:
  - `:not()`, `:is()`, `:where()` and `:has()` keep only `group[0]`, the first compound of each
    argument (`SelectorParser.ts:535-622`, cases at `:567-612`). So `:not(div span)` is treated as
    `:not(div)` (verified, §2.13).
  - `nth` expressions are compiled to closures (`:634-680`).

**Matching one element** (`HD/query-selector/SelectorItem.ts:68-120`):
- tag: `this.tagName !== element[tagName].toUpperCase()`, which allocates or upper-cases per test
- id: `element.id` → `getAttribute`
- classes: `element.classList.contains`, going through the `DOMTokenList` Proxy (§2.10)
- attributes: `NamedNodeMap.getNamedItem` + RegExp
- pseudos: a `switch` over about 30 names
- Missing: `:enabled`, `:required`, `:valid`, `:link` and others fall to `default: return null`.
- `:empty` checks `elementArray.length` and so ignores text nodes (`:280`); `<p>hi</p>` matches
  `:empty` (verified).

**`querySelectorAll`** (`HD/query-selector/QuerySelector.ts:80-171`) is **top-down
(left-to-right)**:
- `findAll` recurses over `elementArray`s, matching the first compound and descending for the next
  (`:593-712`).
- To order results without `compareDocumentPosition`, each match gets a **document-position
  string**: the path of child indices encoded as `String.fromCharCode(i)` joined with `'>'`
  (`:615`). Results go into a `Map<string, Element>` (which also dedupes across comma groups) and
  are sorted lexicographically (`:163-171`).
- This is neat, but it allocates a string per visited element and does `matched.concat(...)` at
  every level.
- **`matches()` and `closest()` are right-to-left** via `parentNode` (`:326-560`).

**Result caches, and how they are invalidated** (the core trick):

1. Each node's `[cache]` holds `Map<selector, {result}>` for `querySelector`, `querySelectorAll`,
   `matches`, `getElementsByTagName(NS)`, `getElementByTagName` and `getElementById`
   (`Node.ts:85-94, 129-138`). Results are `WeakRef`s (`HD/nodes/node/ICached*.ts`).
   - Warm `qSA` returns **the same `NodeList` object**: 0.26-0.72 µs for any selector on a
     3k-element table.
   - Warm `el.matches` takes 0.13-0.18 µs.
2. While matching, the cache item is **pushed into the `[affectsCache]` array of every node it
   visits**:
   - every element in `findAll`/`findFirst` (`QuerySelector.ts:617, 742`, helper `:840-848`)
   - every parent and sibling in `matchSelector` (`:478, 502, 530-535`)
   - **the owner document**, for any query on a connected node, "because of `:target`"
     (`:142-147, 272-277, 391-401`)
3. Any mutation of a node calls `reportMutation` → `clearCache()` (`Node.ts:836-960`). That empties
   the node's own caches and sets `result = null` on every item in its `affectsCache`, then resets
   the array. A mutation on node X therefore invalidates exactly the cached queries that visited X.
   Mutations include child-list changes on the parent, attribute changes on the element, and
   `characterData`.
4. `document.getElementById` bypasses all of this. It uses
   `document[elementIdMap]: Map<id, {elements[]}>`, maintained on connect, disconnect and id change
   (`HD/nodes/parent-node/ParentNodeUtility.ts:281-330`, `Element.ts:1719-1760`). Cost: 56 ns.
   `document.body` and `document.head` use the cached `getElementByTagName`
   (`HD/nodes/document/Document.ts:1309-1326`).

Measured cold vs warm (`ops.mjs`; container mutated before each cold query). jsdom figures are from
`jsdom-probes/ops.cjs` and `sel.cjs`, which repeat the query without mutations. Repeated jsdom `qSA`
calls are not memoised to O(1) (`jsdom.md` §2.5), so those figures are effectively jsdom's cold
cost. linkedom (non-cached) has no result cache, so its column is always cold:

| query on 3,002-element table | happy-dom warm | happy-dom cold | jsdom 30.1.3 | linkedom | linkedom/cached warm |
|---|---:|---:|---:|---:|---:|
| `qSA('*')` | 0.5-0.7 µs | **10.0-10.5 ms** | 0.72 ms | 0.35 ms | 0.14-0.30 µs |
| `qSA('tr.row')` | 0.26-0.64 µs | 3.6-5.3 ms | 0.27 ms | 0.44 ms | 0.16-0.20 µs |
| `qSA('*[role~="link"],a[href],area[href]')` | 0.3-0.7 µs | 7.4-11.1 ms | 11.8 ms | 0.46-0.49 ms | 0.12-0.13 µs |
| `qSA('input[type="checkbox"]:checked')` | 0.3 µs | 1.6-3.8 ms | 3.2 ms | 0.37-0.41 ms | 0.13-0.14 µs |
| `qSA('tr td a')` | n/a | 7.3-9.9 ms | 9.9 ms | 0.33-0.36 ms | 0.13-0.53 µs |
| `qSA('td:first-child')` | n/a | 3.6-5.2 ms | 2.2 ms | 1.05-1.2 ms | 0.14-0.16 µs |
| `a.matches('a[href],area[href]')` | 0.13-0.18 µs | 4.4-7.0 µs | 2.7 µs | 2.6-2.7 µs | 2.7 µs |
| `a.closest('tr')` | 0.38-0.46 µs | n/a | 2.8 µs | 0.95-0.98 µs | 1.4 µs |

Takeaways:
- happy-dom's *uncached* engine is no faster than jsdom's, and is often 3-10× slower: allocation
  heavy, with string positions and `toUpperCase` per test.
- linkedom, using css-select-compiled closures over a flat list, is 10-30× faster than either when
  cold.
- happy-dom's win comes **entirely from memoisation**.

**Pathologies of the invalidation scheme** (measured in `ops2.mjs` and `ops.mjs`):

- **Unbounded growth.** Arrays on nodes that never mutate are never reset.
  - An untouched `<td>` had **5,819** entries after the benchmark loop, plus one per further cold
    query.
  - 1000 cold `qSA('*')` (each after a container mutation) left **≈57 MB** retained after a yield
    and a full GC: about 19 B per visited element per cold query. Mutating the container resets
    only *its* array; the 3,001 descendants were only read, so theirs keep growing.
  - `document[affectsCache]` reached **55,805** entries in `ops.mjs`.
  - In a long test file with many `waitFor` retries this is real memory pressure.
- **Coarse document-level invalidation.** Every connected query registers on `document`, so
  anything that clears the document's cache drops *all* selector caches. This includes `focus()`
  and `blur()` (`HD/nodes/html-element/HTMLElementUtility.ts:31, 83`) and child-list changes of the
  document. Verified: after `focus()`, `qSA` returns a new object.
- **Cold queries are pricier than uncached ones would be**, because they also push into thousands of
  arrays.
- **Correctness depends on every reader registering every dependency.** Computed style misses
  siblings (§2.6). `WeakRef` results can also be collected, which simply forces recomputation.

### 2.6 Computed style: lazy, memoised, string-concatenating

- **`window.getComputedStyle(el)` is O(1).** It returns a cached `CSSStyleDeclaration` with
  `computed: true` (`HD/window/BrowserWindow.ts:2255-2265`). Measured: 42-75 ns (jsdom 2.4 µs, which
  allocates a declaration + Proxy per call).
- **Work happens on property read.**
  - The declaration is a `Proxy` (`HD/css/declaration/CSSStyleDeclaration.ts:70-195`).
  - Each read → `[getPropertyManager]()` → `new CSSComputedStyle(element).getComputedStyle()`
    (`:332-353`).
  - That first checks `element[cache].computedStyle` (a `WeakRef`) and returns it on a hit
    (`HD/css/declaration/computed-style/CSSComputedStyle.ts:58-80`).
  - Warm `getComputedStyle(a).display` costs 1.7-2.15 µs: the Proxy trap, a fresh `CSSComputedStyle`
    object and a property-manager lookup.
- **On a miss** (`CSSComputedStyle.ts:82-308`):
  1. Walk ancestors up to the document, stopping early at any ancestor with a valid cached result.
  2. For the uncached part, fetch all stylesheets:
     `root.querySelectorAll('style,link[rel="stylesheet"]')` (`:314-333`), a **document-wide query**,
     itself cached by §2.5.
  3. For every rule, run `QuerySelector.matches(element, selectorText)` per uncached ancestor
     (`parseCSSRules`, `:347-455`).
  4. For each element, **concatenate strings**: the default CSS for its tag from
     `config/CSSComputedStyleElementDefault.ts`, the matched rules' `cssText` (sorted by
     `priorityWeight`, roughly specificity: id 100, class/attr/pseudo 10, tag 1, from
     `SelectorItem.ts`), and the inline `style` attribute.
  5. **Re-parse that concatenated string** with `CSSTextParser.parse` (`:196-225`).
  6. Resolve `var()` and inherit properties listed in `CSSComputedStyleInheritedProperties`.
  7. Convert `em/rem/%` font-size measurements to px (skipped with `disableComputedStyleRendering`).
- **Caching on a miss.** The result is stored per element. The cache item is pushed into
  `document[affectsComputedStyleCache]` and into the `affectsCache` of **each ancestor**
  (`:278-296`). Any stylesheet change (style element connected, removed or text changed) clears all
  of them (`HD/nodes/document/Document.ts:2268-2273`, called from `HTMLStyleElement.ts:95-123`,
  `HTMLLinkElement.ts`, `ShadowRoot.ts:212`).
- **Cost of a cold read** (`ops2.mjs`, fresh 4k-node document, no stylesheets):

  | scenario | happy-dom | jsdom |
  |---|---:|---:|
  | warm | 1.7-2.15 µs | 2.3 µs |
  | mutate the element itself, then read | **4.1-4.8 ms** | 324 µs |
  | mutate `<body>`, then read | **4.4-6.1 ms** | 255 µs |
  | mutate an unrelated subtree, then read | 6-7 µs (cache still valid) | n/a |

  The reason: the element's mutation also clears the cached document-wide
  `qSA('style,link[rel="stylesheet"]')`, whose item sits in *every* element's `affectsCache`. So
  the cold path re-walks the entire document, even with zero stylesheets. The first `ops.mjs` run
  had ~150k leftover elements in `<body>`, and this path kept it from finishing within a 10-minute
  timeout.
- **Correctness gaps** (verified, `quirks.mjs`):
  - The computed-style cache only depends on ancestors. Given `.on + li { display:none }`, adding
    `.on` to the previous sibling leaves `li2` at `list-item` until an unrelated parent mutation
    busts the cache.
  - There is no UA rule for `[hidden]`: `getComputedStyle(hiddenDiv).display` is `block`, while
    browsers and jsdom give `none`. Testing Library survives because DTL, jest-dom and
    dom-accessibility-api check `hidden` explicitly (`app-notes.md`).
  - `getComputedStyle(el, '::before')` ignores the pseudo argument. This is harmless because DTL
    sets `computedStyleSupportsPseudoElements: false` (`dom-testing-library/src/config.ts:50`).

Lessons:
- Keep the API shape: `getComputedStyle()` cheap and lazy, compute on first property read, memoise
  per element.
- Replace the implementation:
  - **no string concatenation and re-parse**: cascade typed declarations directly
  - **a precompiled per-tag UA table including `[hidden]`**
  - **a no-author-stylesheets fast path**: the app has none, so the computed value is UA default
    + inline + inherited, all O(depth) without any selector matching
  - **epoch-based validity**, not dependency lists

### 2.7 Inline style (`element.style`)

- `HTMLElement.style` is lazily created (`HD/nodes/html-element/HTMLElement.ts:811-820`). It is the
  same Proxy-based `CSSStyleDeclaration`, backed by a `CSSPropertyManager` parsed from the `style`
  attribute and cached by attribute string (`CSSStyleDeclaration.ts:345-353`).
- Writes (`style.color = …`, `setProperty`) update the manager, **reserialize the whole
  declaration** and call `setAttribute('style', …)` (`:240-275`), which runs the full §2.4 pipeline.
  Cost: 3.9-4.7 µs (jsdom 2.3-3.5 µs).
- camelCase and kebab-case lookups go through two static tables (`HD/css/declaration/CSSPropertyList.ts`).
- Lesson for rsdom: store the declaration block natively and serialize the `style` attribute
  **lazily on read**. React writes styles property by property.

### 2.8 Events

- **Listeners.** Per target there are two `Map<type, listener[]>` plus parallel options arrays
  (`HD/event/EventTarget.ts:46-53`). `addEventListener` dedupes with `includes`.
- **Dispatch** (`HD/event/EventTarget.ts:142-396`):
  - `event.composedPath()` walks `parentNode`, then the shadow host if composed, then document →
    window (`HD/event/Event.ts:148-183`).
  - The capture loop runs from the end of the path, then at-target, then bubble. For each path entry
    it calls **`entry.dispatchEvent(event)` recursively**; the `event[dispatching]` flag routes the
    inner call to `#callDispatchEventListeners`.
  - Listener arrays are `slice()`d per node.
  - `on*` property handlers come from `propertyEventListeners`.
  - Error capture is a `try/catch` + `window[dispatchError]` unless `disableErrorCapturing` is set
    (Vitest sets it, `VT/happy-dom.ts:27, 59`).
- **Activation behaviour is an override of `dispatchEvent`** on the element class, active only for
  the outermost call (`eventPhase === none`):
  - `HTMLInputElement` toggles checkbox or radio *before* dispatch, restores on `preventDefault`,
    then fires `input` + `change` or submits/resets the form
    (`HD/nodes/html-input-element/HTMLInputElement.ts:1439-1506`).
  - `HTMLLabelElement` forwards clicks to its control (`HD/nodes/html-label-element/HTMLLabelElement.ts:110-130`).
  - `HTMLButtonElement` submits or resets (`HD/nodes/html-button-element/HTMLButtonElement.ts:373-400`).

  This is simple and is all that `fireEvent.click` and `user-event` need. rsdom can do the same in
  its JS facade.
- **Skipped:**
  - shadow-DOM retargeting
  - `window.event` (always `undefined`, verified)
  - `isTrusted` semantics
  - passive-listener rules beyond a flag
- **Cost.** Event *construction* is cheap: no WebIDL dictionary conversion, 0.28 µs
  (jsdom 6.9 µs). Dispatch at depth 20 is 13.6-14.6 µs (jsdom 8.8 µs): one recursive public
  `dispatchEvent` per path entry, slices and per-listener settings lookups
  (`new WindowBrowserContext(window).getSettings()` on every node, `EventTarget.ts:274`).

### 2.9 MutationObserver

- **Registration is push-based.** `observe(target, {subtree:true})` pushes the listener into the
  target's `mutationListeners` and **recursively into every descendant**
  (`HD/nodes/node/Node.ts:801-829`, `HD/mutation-observer/MutationObserver.ts:41-130`).
  - Inserted nodes inherit the subtree listeners of their new parent (`Node.ts:558-563, 742-747`).
  - Removed nodes lose them (`Node.ts:621-626`).
  - Reporting is local: `reportMutation` iterates only the node's own listeners (`Node.ts:836-878`).
- **Cost** (`ops.mjs`): observe on a ~4,000-node container takes **4.1-4.5 ms**, disconnect **3.5-3.8 ms**,
  and every subsequent insert or remove pays a per-node walk. DTL's `waitFor` observes the
  container on each call (`dom-testing-library/src/wait-for.js:101-104`), so each `findBy*` pays
  this up front.
- jsdom instead walks *inclusive ancestors* at mutation time and looks for registered observers:
  O(depth) per mutation, zero cost at observe (`jsdom/lib/jsdom/living/helpers/mutation-observers.js:38-80`, loop at `:56`).
- **Batching.** Records are queued with `window.queueMicrotask` per listener
  (`HD/mutation-observer/MutationObserverListener.ts:57-87`), as in the spec.
- **Waste.** happy-dom allocates a `MutationRecord` for **every** mutation even when nobody observes
  (`Node.ts:566, 629, 750`, `Element.ts:1596, 1634`).
- Lesson:
  - Use jsdom's ancestor-walk model, cheap in Rust (`parent` links, observer lists only on observed
    nodes).
  - Add linkedom's **document-level "any observers?" flag** (`LK/interface/mutation-observer.js:38,
    80`) so record creation is skipped entirely when the count is zero.

### 2.10 Proxies and `ClassMethodBinder`

- **What is a Proxy.** happy-dom implements indexed and named access with `Proxy`:
  - `NodeList` (`HD/nodes/node/NodeList.ts:33`)
  - `HTMLCollection` (`HD/nodes/element/HTMLCollection.ts:35`)
  - `DOMTokenList` (`HD/dom/DOMTokenList.ts:49`)
  - `CSSStyleDeclaration` (`HD/css/declaration/CSSStyleDeclaration.ts:70`)
  - the `attributes` NamedNodeMap (`HD/nodes/element/NamedNodeMapProxyFactory.ts:21`)
  - `HTMLFormElement` and `HTMLSelectElement` themselves (`HD/nodes/html-form-element/HTMLFormElement.ts:55`,
    `HD/nodes/html-select-element/HTMLSelectElement.ts:56`): the constructor returns a Proxy, so
    `Node` code everywhere does `this[PropertySymbol.proxy] || this`.
- **Why the Proxies are not as slow as they could be.** `ClassMethodBinder`
  (`HD/utilities/ClassMethodBinder.ts`) binds each prototype method or accessor to the *raw target*
  on first access, as an own property. Later calls run with `this = target` and internal accesses
  bypass the traps.
- **Liveness.** `childNodes` wraps the live `nodeArray` directly, so it costs nothing to keep live.
- **Cost.** `childNodes[i]` is 166 ns (jsdom 223 ns, a plain array read is ~1 ns). `classList`
  operations pay a trap plus `getAttribute`.
- Lesson: avoid Proxies on per-element hot paths (`classList.contains` inside selector matching,
  style reads). Where index access on a live list is mandatory (`childNodes[i]`, `children[i]`), a
  Proxy is acceptable, but give `item()`, `length` and iteration non-trapping fast paths.

### 2.11 Window and global setup

**`BrowserWindow`** (`HD/window/BrowserWindow.ts`):
- **Shared constructors.** Interface constructors are class fields assigning **module-level
  classes**, for example `public readonly Node = Node;` (`:402` onward). They are the same objects
  for every window: `w1.HTMLElement === w2.HTMLElement` is `true` (verified).
- **Per-window subclasses** exist only for the ~45 classes user code can `new` and that need their
  window: `Document`, `HTMLDocument`, `DocumentFragment`, `Text`, `Comment`, `Image`, `Audio`,
  `MutationObserver`, `DOMException`, `Request`/`Response`/`Headers`, `XMLHttpRequest`, `Range`,
  `URL`, `FileReader`, `WebSocket`, … Each is a one-line `class Text extends TextImplementation {}`
  with `Text.prototype[PropertySymbol.window] = window`
  (`HD/window/WindowContextClassExtender.ts:60-287`). The subclass keeps the name `Text`, so
  pretty-format still recognises it.
- **jsdom by contrast** runs `installInterfaces(window)`, which calls `install()` on ~210 generated
  interfaces per window. Each creates fresh constructor and prototype objects
  (`jsdom/lib/jsdom/living/interfaces.js:256-270`, `jsdom/lib/jsdom/browser/Window.js:77`).
- **Constructor order** (`:899-954`): browser frame, location, history, storages,
  `setupVMContext()`, `extendClasses()`, `document = new this.HTMLDocument()`, ready-state task,
  then `bindMethods()`.
- **`bindMethods()`** (`:3048-3073`) re-defines every method and accessor of
  `BrowserWindow.prototype` and `EventTarget.prototype` as an own property bound to the window. So
  `const { addEventListener } = window` works, and so do Vitest's global getters.
- **Two realm modes:**
  - `Window` calls `VM.createContext(this)` and copies the context's intrinsics (`Array`,
    `Promise`, …) onto the window (`:2941-2949`, `HD/window/VMGlobalPropertyScript.ts`). Vitest's
    `setupVM()` (vmThreads pool) uses this, so `win.Array !== Array`.
  - **`GlobalWindow`** (`HD/window/GlobalWindow.ts`) overrides `setupVMContext` to do nothing and
    assigns **the host realm's intrinsics** as class fields (`Array = globalThis.Array`, …, `:11-61`).
    Vitest's normal `setup()` uses this, so `instanceof Array`, `Error` and the rest agree with
    the test code. Verified: `w.Array === Array`.
- **Timers:**
  - Zero-delay `setTimeout`s are grouped into a single Node timer whose callback drains a queue
    (`:2427-2500`).
  - `requestAnimationFrame` is `setImmediate` (`:2633-2700`).
  - Every timer is registered with the `AsyncTaskManager`, so `happyDOM.waitUntilComplete()` and
    `happyDOM.abort()` can await or cancel them.
  - The `preventTimerLoops` setting captures `new Error().stack` per call, which is expensive and
    off by default.
- **Cost** (`env.mjs`; jsdom from `jsdom-probes/envcreate.cjs`):
  - `import('happy-dom')` 330-407 ms: 611 module files, 7 small dependencies
    (`e2e/react-app/node_modules/happy-dom/package.json`)
  - jsdom: `require` 626 ms, 3,651 module loads (`jsdom-probes/results-jsdom-30.1.3.txt`)
  - happy-dom window: first 5-10 ms, warm 0.9-1.6 ms (`GlobalWindow`) / 1.7-2.6 ms (`Window`)
  - jsdom window: 84.5 ms first, 8.4 ms warm
  - `GlobalWindow` has **586 own string properties** and 23 symbols. Vitest copies all of them to
    `globalThis` (next section).

### 2.12 The Vitest happy-dom environment (`VT/happy-dom.ts`)

- `name: 'happy-dom'`, `viteEnvironment: 'client'` (`:16-18`). Client resolve conditions apply, so
  dependencies resolve to their browser builds.
- **`setup(global, { happyDOM })`** (`:49-86`):
  1. `new (GlobalWindow || Window)({ ...happyDOM, console: global.console, url: happyDOM.url ||
     'http://localhost:3000', settings: { ...happyDOM.settings, disableErrorCapturing: true } })`.
     Listener exceptions therefore propagate to Vitest instead of becoming window `error` events.
  2. `populateGlobal(global, win, { bindFunctions: true, additionalKeys: ['Request', 'Response',
     'MessagePort', 'fetch', 'Headers', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
     'FormData'] })` (`:63-77`).
  3. `teardown`: `await win.happyDOM.abort()` (cancels timers, fetches, …), then `win.close()`,
     then delete the copied keys and restore originals (`:6-14, 80-85`).
- **`setupVM`** (`:19-47`) for the vm pools: a plain `Window` whose own VM context *is* the test
  context (`getVmContext() { return win }`), plus `win.Buffer = Buffer` and `structuredClone`.
- **`populateGlobal`** (`VT/utils.ts:37-117`, details in `jsdom.md` §3.3):
  - Keys = `Object.getOwnPropertyNames(win)` ∪ the jsdom KEYS list ∪ additionalKeys, minus
    `window`/`self`/`top`/`parent`. A key already on `global` is overridden only if it is in KEYS
    (`VT/utils.ts:5-21`).
  - Each key becomes a **getter/setter on `globalThis`** that reads `win[key]` (or the pre-bound
    function). Bound functions are created once at populate time (`:55-56`).
  - `setTimeout`, `setInterval` and friends are *not* in KEYS (`VT/jsdom-keys.ts:247`), so tests
    keep Node's timers. `requestAnimationFrame`, `Event`, `document` and `navigator` *are* overridden.
  - Then `global.window = global.self = global.top = global.parent = global`, and
    `document.defaultView` is redefined to return `global` (`VT/utils.ts:92-108`).
- **Consequences for an rsdom environment:**
  - Everything the window must expose has to be an **own property of the window object** or in
    Vitest's KEYS list. Prototype getters are not enumerated by `getOwnPropertyNames`.
  - `bindFunctions` calls `.bind(win)` on every non-class function key. Keep the function count
    reasonable and make sure methods tolerate `this === window`.
  - A custom environment is loaded as `vitest-environment-<name>` or by path
    (`VT/loader.ts:60-70`). It may set `prewarmModules` (`vitest/packages/vitest/src/types/environment.ts:26-32`).

### 2.13 What happy-dom skips or simplifies (verified with `happy-dom-probes/quirks.mjs` unless cited)

| Area | happy-dom 21.0.3 behaviour | Spec / jsdom |
|---|---|---|
| WebIDL argument conversion and brand checks | none: `appendChild('str')` → `TypeError: Cannot read properties of undefined` | `TypeError: parameter 1 is not of type 'Node'` |
| HTML parsing | regex tokenizer (`HD/html-parser/HTMLParser.ts:35-58`) + content-model table (`HD/config/HTMLElementConfig.ts`): implied end tags and a subset of nesting rules; no full tree-construction algorithm | parse5 (spec) |
| Selector grammar | regex based; `:not/:is/:where/:has` keep only the first compound per argument; `:empty` ignores text; many pseudo-classes unsupported | full Selectors 4 (dom-selector) |
| Cascade | `priorityWeight` approximation of specificity; inherited-property whitelist; no `[hidden]` UA rule; pseudo-elements ignored | real specificity + UA sheet |
| Computed-style invalidation | ancestors only; sibling combinators go stale | document-wide cache clear (coarse but correct) |
| `focus()` | any connected, non-disabled, non-inert element, even a plain `div` or an input inside `display:none` (`HD/nodes/html-element/HTMLElementUtility.ts:56-118`) | focusable-area check incl. rendering |
| `getElementById` with duplicate ids | first *connected*, not first in tree order (`Element.ts:1719-1760` pushes in connect order) | tree order |
| Event path | no retargeting; `window.event` undefined | spec |
| `compareDocumentPosition` | correct, but numbers the whole common-ancestor subtree recursively | spec |
| Layout | none (`getBoundingClientRect` zeros) | none (same) |
| Cached `qSA` result identity | the same `NodeList` object is returned until invalidated | new static `NodeList` each call |
| `HTMLTableSectionElement.rows` | missing (`app-notes.md`) | present |

---

## 3. Why happy-dom is faster than jsdom: the full balance sheet

Side by side, the same operation list (`happy-dom-probes/ops.mjs` vs `jsdom-probes/ops.cjs`; linkedom
from `happy-dom-probes/linkedom.mjs`).

| operation | happy-dom 21.0.3 | jsdom 30.1.3 | linkedom 0.18.13 | why (happy-dom) |
|---|---:|---:|---:|---|
| import / require | 330-407 ms | 626 ms | 103 ms | 611 modules vs 3,651 |
| new window (first / warm) | 6-10 / 0.9-1.6 ms | 84.5 / 8.4 ms | 2.7-4.7 ms (parseHTML) | shared classes; no `installInterfaces` |
| `createElement('div')` | 1.43-1.54 µs | 2.69 µs | 0.97-1.01 µs | no wrapper; but 7+4+3 Maps |
| `createTextNode` | 0.74-0.96 µs | 0.79 µs | 0.88-1.06 µs | Text pays all the Node Maps too |
| `appendChild` (connected) | 7.4-7.5 µs | 6.5 µs | 1.66-2.05 µs | `connectedToNode` subtree walk, `MutationRecord`, `clearCache` |
| append+remove at depth 20 | 4.4-7.3 µs | 5.9 µs | 1.4-1.67 µs | |
| `setAttribute` existing | 1.8-2.0 µs | 0.65 µs | 0.06-0.08 µs | new `Attr` Node + record + `clearCache` |
| `setAttribute` new + `removeAttribute` | 2.5-3.2 µs | 2.3 µs | 3.7-4.6 µs | |
| `className =` | 1.7-1.9 µs | 0.44 µs | n/a | |
| `getAttribute` | 38-40 ns | 252 ns | 19-22 ns | one `Map.get`, no wrapper |
| `text.nodeValue =` | 228-286 ns | 484 ns | n/a | |
| `el.textContent = 'abc'` | 2.3-2.6 µs | 3.0 µs | n/a | |
| sibling walk, 100 children | 3.2 µs | 6.4 µs | 0.72-0.74 µs | `indexOf` (O(n²) at scale: 5000 → 4.8-13.6 ms) |
| `children.length` after append | 3.9-4.5 µs | 8.8 µs | 5.2-5.5 µs (fresh list) | `elementArray` is the live list |
| `childNodes[i]` | 149-166 ns | 223 ns | 4.5 µs (fresh list; cached: 26-29 ns) | Proxy over the live array |
| `insertBefore` reorder among 100 | 2.0-2.65 µs | 3.56 µs | **0.14-0.17 µs** | |
| bottom-up detached build, depth 200 (1001 nodes) | 65-69 ms | 96-111 ms | n/a | both walk the inserted subtree per insert |
| `style.color =` | 3.9-4.6 µs | 3.5 µs | n/a | reserialize + `setAttribute` |
| `dispatchEvent` depth 20 | 13.6-14.6 µs | 8.8 µs | n/a | recursive `dispatchEvent` per path entry |
| `new MouseEvent` | **0.26-0.28 µs** | 6.9 µs | n/a | no WebIDL dictionary conversion |
| `el.click()` depth 20 | 16.1-18.1 µs | 14.2 µs | n/a | |
| `innerHTML =` 4k nodes (first / warm) | 67-82 / 65-70 ms | 115 / 71 ms | **32-37 / 16-17.5 ms** | regex parser, but every node goes through `appendChild` |
| `qSA` warm | **0.26-0.72 µs** | 0.27-12 ms | 0.33-1.2 ms (cached: 0.12-0.5 µs) | per-node result cache |
| `qSA` cold | 1.6-11 ms | 0.27-12 ms | 0.33-1.2 ms | slower than jsdom for simple selectors |
| `el.matches` warm / cold | 0.13-0.18 / 4-7 µs | 2.7 µs | 2.6-2.7 µs | per-element result cache |
| `getComputedStyle(el)` call | 42-75 ns | 2.4 µs | n/a (no gCS) | cached lazy declaration |
| gCS `.display` warm | 1.7-2.15 µs | 2.3 µs | n/a | |
| gCS after mutating the element | **4.1-4.8 ms** | 324 µs | n/a | doc-wide stylesheet `qSA` re-run (§2.6) |
| `getElementById` | 56-63 ns | 476 ns | n/a | id map |
| `textContent` get, 4k nodes | 634-648 µs | 242 µs | 194-213 µs | recursive `+=` through getters |
| `innerHTML` serialize, 4k nodes | 2.7-3.7 ms | 1.4 ms | 1.76-2.06 ms | |
| `focus()` + `blur()` | **21-26 µs** | 625 µs | n/a | no focusability or style checks |
| bytes per `div` / Text | 3,730 / 2,522 | 1,595 / 218 | small | eager Maps |

**The causes, ranked by effect on Testing Library suites:**

1. **Memoised queries and matches** (§2.5). DTL's role query calls `matches()` with up to ~100
   implicit-role selectors per element and repeats whole queries inside `waitFor`. With caching,
   only the first pass costs. This one feature explains most of the 3-5× role-query advantage in
   `app-notes.md`: `getAllByRole('link')` over 1000 links takes 331 ms vs 1514 ms.
2. **Cheap, lazy, cached computed style** (§2.6). `isInaccessible` and accessible-name computation
   hit it per element and ancestor. Warm reads cost about the same as jsdom's. The win is no
   per-call allocation and no style invalidation on focus.
3. **Cheaper focus** (§2.13). user-event focuses on every click and type: 21-26 µs vs 625 µs.
4. **No WebIDL layer.** Event construction, attribute reads, `getElementById` and `closest` are all
   3-25× cheaper.
5. **Environment creation.** About half the import cost, and windows 5-10× cheaper. Per test file
   this saves roughly 0.3 s (`app-notes.md`: ~0.56 s per happy-dom worker vs ~0.85 s jsdom env
   setup).

**What it costs in return:** slower and allocation-heavy mutations, 2-10× memory, unbounded
cache-registration growth, and correctness gaps.

---

## 4. linkedom internals

### 4.1 The data structure: one doubly linked list in document order

Every node has `[NEXT]` and `[PREV]` (`LK/interface/node.js:49-57`). Every element (and fragment and
document, through `ParentNode`) also owns an **`END` marker**, a tiny object
`{[NEXT], [PREV], [START]: element, nodeType: NODE_END}` (`LK/mixin/parent-node.js:50-62`). The
whole document is one sequence:

```
<div id=a><p>hi</p>!</div>     →    div ⇄ @id ⇄ p ⇄ "hi" ⇄ END(p) ⇄ "!" ⇄ END(div)
                                     ↑ attributes come first, inline in the list
```

- **Attributes are list nodes too.** `setAttribute` splices the `Attr` right after the element start
  (`LK/shared/attributes.js:42-50`), and `getAttributeNode` scans forward while
  `nodeType === ATTRIBUTE_NODE` (`LK/interface/element.js:237-245`).
- **`parentNode`** is a plain pointer on each top-level child (a "shortcut").
- **A subtree is the closed segment `[node, node[END]]`.** `getEnd(node)` is `node[END]` for
  elements and `node` itself for leaves (`LK/shared/utils.js:7`).
- **Derived navigation:**
  - `nextSibling` = `getEnd(node)[NEXT]` unless that is an `END` (`LK/shared/node.js:45-48`): O(1).
  - `previousSibling` = `node[PREV]`, or `prev[START]` if `prev` is an `END`
    (`LK/shared/node.js:33-43`): O(1).
  - `lastChild` = `this[END][PREV]`, or its `START` (`LK/mixin/parent-node.js:107-116`): O(1).
  - `firstChild` = `this[NEXT]` after skipping attributes (`:87-92`): O(#attrs).
  - `isConnected` walks `parentNode` to the document every time (`LK/shared/node.js:13-20`): O(depth).

### 4.2 Why it is fast for parsing, serialization and moves

- **O(1) structural edits on segments.** `insertBefore` and `remove` only relink the segment's two
  boundary pairs (`knownBoundaries`/`knownSegment`, `LK/shared/utils.js:16-24`;
  `LK/mixin/parent-node.js:216-265`; `LK/mixin/child-node.js:49-62`) and set `parentNode` on the
  top node. Descendants are untouched, whatever their count. A `DocumentFragment` insert splices
  its whole contents at once and fixes `parentNode` on the top-level children only.
  - Measured: removing and re-appending a ~4,000-node `<tbody>`: **139-239 ns**. Reordering
    `insertBefore` among 100 siblings: 143-171 ns (happy-dom 2.0-2.65 µs, jsdom 3.56 µs).
- **Parsing.** htmlparser2's SAX callbacks append each node at `parent[END][PREV]` in O(1)
  (`LK/shared/parse-from-string.js:20-28, 50-110`). A module-level `notParsing` flag
  (`:18, 48, 119`) lets the cached variant skip invalidation during parsing, and custom-element and
  MutationObserver callbacks are skipped unless active. Measured: 4k nodes in 16-37 ms, 2-4×
  faster than both happy-dom and jsdom.
- **Serialization and `textContent` are one flat loop** from `this` to `this[END]`, with no recursion
  and no stack (`LK/interface/element.js:184-195, 439-490`). linkedom claims this avoids "Maximum
  call stack size exceeded" on deep documents (`linkedom/README.md:253`).
- **Query is a flat loop.** `querySelectorAll` compiles the selector with css-select once per call,
  then walks `next` until `end`, testing elements and jumping over `<template>` content via `END`
  (`LK/mixin/parent-node.js:182-207`). There is no recursion, and results come out in document
  order with no sorting. Cold `qSA` costs 0.33-0.49 ms on the 3k-element table, 10-30× faster than
  happy-dom cold.

### 4.3 Why it is slow for some traversals

- **No child index.**
  - `childNodes` and `children` build a **new `NodeList` (an Array subclass) on every access** by
    hopping siblings (`LK/mixin/parent-node.js:64-84`).
  - `childNodes[i]` therefore costs O(n) *plus an allocation*: 4.5 µs for 100 children, 52 µs for
    1000, **254-288 µs for 5000** (`linkedom.mjs`).
  - `children.length` is O(n), as is `childElementCount`.
- **Ancestor questions walk.** `isConnected`, `contains` (`:209-214`), `getRootNode` and
  `parentElement` checks are all O(depth), recomputed on every call (80 ns at depth 20).
- **css-select's adapter hits the slow paths.** `getChildren` = `node.childNodes` and `getSiblings`
  = `parent.childNodes` (`LK/shared/matches.js:21-35`). Every `:first-child`, `:nth-*`, `+` or `~`
  test allocates the full sibling array, so `qSA('td:first-child')` is 3× slower than `qSA('*')`
  (1.05-1.2 ms vs 0.35 ms).
- **`compareDocumentPosition` is wrong.** It compares *depths* (`getParentNodeCount`) and only
  checks order when both nodes sit at the same depth under the same parent
  (`LK/interface/node.js:26-33, 139-167`). Verified: a deep earlier node vs a later shallower node
  returns `PRECEDING` instead of `FOLLOWING`.
- **The cached variant (`LK/cached.js`, `LK/shared/cache.js`)** keeps `WeakMap`s for `childNodes`,
  `children`, `querySelector` and `querySelectorAll` results per parent. Any attribute change,
  `remove` or character-data change resets the entries for **the whole ancestor chain**
  (`LK/shared/cache.js:16-26`).
  - Warm `qSA` drops to 0.12-0.53 µs and `childNodes[i]` to 26-29 ns.
  - Every mutation pays an ancestor walk plus `WeakMap.delete`s
    (`setAttribute` 61-79 ns → 251-366 ns; append+remove 1.4-1.7 → 3.1-4.2 µs).
  - The README itself says caching suits "rarely changed" trees (`linkedom/README.md:276-290`).
- **Not a test environment:**
  - no `getComputedStyle`
  - `focus()` only dispatches an event, with no `activeElement` (`LK/interface/element.js:228`)
  - events have **no capture phase** (`LK/interface/event-target.js:70-80`, "intentionally
    simplified")
  - `getElementsBy*` return static arrays
  - parsing is htmlparser2, not HTML5 tree construction
  - The README sends people needing a browser-like environment to jsdom
    (`linkedom/README.md:119-125`).

### 4.4 linkedom ideas worth keeping

1. **A subtree as a contiguous range.** In Rust this is achievable *without* END marker nodes. With
   `first_child`/`last_child`/`next_sibling`/`prev_sibling`/`parent` links, moving a subtree is
   already O(1) (relink 2-4 pointers and set one `parent`), and "next in pre-order" is
   `first_child`, else `next_sibling`, else climb. linkedom's END marker buys O(1) "skip subtree" and
   O(1) `lastChild`; both are free with 5 links.
2. **A flat iterative pre-order walk for every bulk algorithm** (qSA, `textContent`, serialization,
   style cascade): no recursion, no allocation per level.
3. **A "parsing" mode** that skips mutation bookkeeping, observer records, cache invalidation and
   custom-element reactions for nodes created by the parser, followed by a single "subtree inserted"
   notification.
4. **Per-document "active" flags** for MutationObserver and custom elements
   (`LK/interface/mutation-observer.js:38`, `LK/shared/parse-from-string.js:42`), so the common case
   pays nothing.

Do **not** keep:
- attributes inline in the child list: it makes `firstChild` O(#attrs) and mixes two concerns
- recomputed `isConnected`
- fresh `childNodes` arrays
- depth-based `compareDocumentPosition`

---

## 5. Lessons and concrete data-structure recommendations for rsdom

### 5.1 Tree storage (Rust)

- **Arena / slab of nodes, `NodeId = u32`** (`NonZeroU32` so `Option<NodeId>` stays 4 bytes). One
  arena per document group (environment), freed at teardown. `jsdom.md` §8 and `react-dom.md` §16
  reach the same conclusion.
- **Five links per node:** `parent`, `first_child`, `last_child`, `prev_sibling`, `next_sibling`.
  - Every operation happy-dom does with `indexOf`/`splice` becomes O(1).
  - linkedom's O(1) splice is kept.
  - Sibling iteration is pointer chasing with no allocation.
- **Node header fields:** `node_type: u8`, `flags: u16`, `local_name: Atom`, `namespace: u8`,
  `owner_doc`. Flags include `IS_CONNECTED`, `IN_SHADOW`, `HAS_ID`, `HAS_STYLE_ATTR`,
  `HAS_LISTENERS_HINT`, `PARSER_CREATED`.
- **Payload by kind:**
  - Text and Comment: `data: String` (or a rope for large data)
  - Element: `attrs: SmallVec<[(Atom name, Atom ns, String value); 4]>`, plus an optional
    `Box<ElementRareData>` for inline style block, `classList` tokens cache, form-control state and
    shadow root
- **`childNodes[i]` / `children[i]`:** keep `child_count` and `element_child_count`, plus an optional
  per-parent **lazily rebuilt `Vec<NodeId>` index stamped with the tree epoch**. This avoids
  linkedom's O(n) per index read without paying happy-dom's eager array maintenance on every
  insert.
- **Connectedness:**
  - Maintain `IS_CONNECTED` flags, updated with one pre-order walk *only when connectivity changes*.
    That is O(subtree) on attach and detach to the document, and **nothing** for detached-to-detached
    inserts unless the subtree holds nodes with insertion steps (track a per-node "descendants with
    insertion steps" count, or a document-level flag). This avoids the O(n·depth) bottom-up cost that
    both happy-dom and jsdom pay (§2.2).
  - Do not propagate `formNode`-style pointers eagerly. Compute "form owner" or "inside `<select>`"
    by ancestor walk on demand. Walks are cheap in Rust and rare.
- **Ids:** a per-document `HashMap<Atom, SmallVec<NodeId>>` maintained on connect, disconnect and id
  change. Resolve duplicates by tree order on lookup (sort or compare by pre-order when `len > 1`),
  not insertion order (happy-dom's bug).
- **Tree order:** `compareDocumentPosition` by finding the common ancestor and then walking siblings
  from the smaller branch. Optionally cache pre-order indices per epoch for heavy sorting.

### 5.2 Attributes, names and strings

- **Intern names** as atoms (tag names, attribute names, common values such as
  `type`/`role`/`aria-*`/`class`). Keep a JS-side `Map<string, number>` atom cache so a name crosses
  N-API as an integer after the first use. Precompute the uppercase `tagName` per atom, avoiding
  happy-dom's per-test `toUpperCase()`.
- **Linear scan of a small inline vector beats hashing** for typical elements: linkedom scans 9
  attrs in 18-23 ns. Do not allocate `Attr` objects until `attributes`/`getAttributeNode` is used, then
  cache them on the wrapper.
- **"Derived data keyed by source string"** (happy-dom's `DOMTokenList`, style declaration):
  - Store the class token list and parsed inline style alongside the attribute.
  - Invalidate them when *that* attribute is set.
  - Better: parse on set, since writes are rarer than reads in tests.
  - Keep an atom set of classes for O(1) class matching.

### 5.3 Caching and invalidation: copy the memo, not the dependency lists

happy-dom proves memoisation is the key win. Its per-node reverse-dependency arrays are its biggest
liability: memory growth, misses, and global wipes on focus. Use **epochs**:

- `tree_epoch: u64`, bumped on any child-list change, attribute change, or character-data change
  *that can affect selectors*. Attribute changes to `aria-*`/`data-*` still bump it whenever any
  compiled selector references such an attribute. Keep a bitset of "attribute atoms referenced by
  compiled selectors": an attribute write whose atom is not in the set does not bump the selector
  epoch. This is a minimal version of browsers' invalidation sets.
- `style_epoch: u64`, bumped on changes that can affect computed style:
  - `style`/`class`/`id`/`hidden`/`type`/`open`/`dir`/`disabled`
  - stylesheet changes
  - child-list changes, only if author sheets contain structural pseudo-classes or combinators
  - **not** focus, unless an author sheet uses `:focus*`
- **Memo tables:**
  - `(scope NodeId, SelectorId) → (epoch, Vec<NodeId>)` for `qSA`/`qS`
  - `(NodeId, SelectorId) → (epoch, bool)` for `matches`: a small open-addressing table, or a
    per-element tiny cache; DTL's role selectors are a fixed set of about 100
  - `NodeId → (style_epoch, ComputedStyleSubset)` for computed style
  - Validity check = one integer compare.
  - Eviction: drop everything on epoch change (lazy: the stale epoch makes entries dead), or use an
    LRU bound. Memory is then bounded by the number of distinct queries, not by queries × visited
    nodes.
- **Why coarse epochs are enough.**
  - In a `getByRole` call there are zero mutations between the ~100 × N `matches` calls, so the hit
    rate is the same as happy-dom's.
  - Between `waitFor` retries there usually *are* mutations (that is why the retry happened), so
    happy-dom's fine-grained precision buys little there either.
  - The cold path must therefore also be fast. That is Rust's job: linkedom-style flat walks with a
    precompiled matcher, which should run at least 10× faster than happy-dom cold (§2.5 table).
- **Returning the same `NodeList` object** for a cached `qSA` (as happy-dom does) is observable but
  harmless, since the list is static. rsdom can return a fresh JS array-backed `NodeList` built from
  the cached id vector. Identity does not matter.

### 5.4 Selector engine

- **Parse once per distinct string.** Keep a JS-side `Map<string, SelectorId>` so repeated calls do
  not re-send the string; the selector cache must persist across calls.
  - In Rust, compile into a right-to-left matcher with compounds as small structs: tag atom, id atom,
    class atoms, attribute tests with pre-lowered values, pseudo-class enum.
  - Either hand-roll it or use Servo's `selectors` crate behind a thin adapter. `selectors` is
    battle-tested but generic and heavy; for v0 a hand-written matcher covering what the app uses
    (`app-notes.md` "Selectors": type, `#id`, `.class`, `[attr]`, `[attr=v]`, `[attr~=v]`,
    descendant `>` `+` `~`, `:not()`, `:checked`, `:disabled`, `:first-child`, `*`, lists) is
    simpler.
- **Matching strategy:**
  - `qSA` does one pre-order walk of the scope subtree and right-to-left matches each element.
    Output is naturally in document order: no position strings, no sorting.
  - Fast paths:
    - `#id` alone → id map
    - a single `.class` or tag compound → flat scan comparing atoms
    - comma lists → match each element against the list once, which dedupes for free
  - `matches`/`closest` are right-to-left on the single element.
  - An ancestor bloom filter (as in browsers) is optional; DTL's selectors are mostly compound.
- **Batch for DTL:** an internal `rs.matchesAny(id, selectorListId)` that returns the *index* of the
  first matching selector. This would let rsdom expose a faster path for implicit-role computation
  if it ever patches `getImplicitAriaRoles`. Not required; plain `matches` with memo is enough.
- **Return `Uint32Array`s of ids** and map them to wrappers in JS through the id-indexed wrapper
  table (`jsdom.md` §8.2, `react-dom.md` §16.2).

### 5.5 Computed style

- `getComputedStyle(el)` returns a lightweight JS object, cached per element on the wrapper, whose
  property getters call into Rust **once per property read**. Even better, read a small fixed
  *subset struct* once per `style_epoch`: `display`, `visibility`, `opacity`, `pointer-events`,
  `content`, `color`, `background-color`, `font-*`.
- Rust cascade order:
  1. a **precompiled per-tag UA table** (happy-dom's `CSSComputedStyleElementDefault.ts` is a good
     starting point; add `[hidden] → display:none`, `dialog:not([open])`, `details` content, and
     `display:list-item` for `li`)
  2. author sheets, if any (skip entirely when the document has none)
  3. the inline declaration block
  4. inheritance from the parent's memoised computed values
- Memoise per element by `style_epoch`, computing ancestors on demand: O(depth) the first time,
  O(1) after.
- Never build cssText strings to re-parse them (happy-dom's §2.6 approach).
- **Never run a document-wide query to find stylesheets.** Keep a per-document list of style sheets,
  updated when `<style>`/`<link>` elements connect or disconnect.

### 5.6 JS facade patterns to adopt from happy-dom

- **Module-level classes shared across environments.** Per-environment state hangs off the
  document/window objects. Only constructors users call with `new` (`Event` and subclasses, `Text`,
  `Comment`, `DocumentFragment`, `MutationObserver`, `Image`, …) need to find "their" document.
  Use happy-dom's prototype-tagging or the current-environment variable, since there is one
  environment per worker.
- **Symbol-keyed (or a single private-field) node id plus cached immutable facts on wrappers**:
  `nodeType`, `localName`, `tagName`, `namespaceURI`, `ownerDocument`. This keeps
  `Object.keys(node)`, JSON and pretty-format clean and gives monomorphic property access. React
  adds its `__reactFiber$…` expandos as string keys, which is fine.
- **Exact interface names and prototype chains.** `HTMLInputElement.prototype` owns
  `value`/`checked` accessors (React value tracker). `constructor.name` must be `HTMLDivElement`,
  `Text`, … for pretty-format.
- **`bindMethods`-style own bound methods on the window** for `addEventListener`,
  `getComputedStyle` and the like, because Vitest copies them to `globalThis` (§2.12). The window
  must expose interface constructors as **own properties**.
- **Use `GlobalWindow` semantics** (host-realm intrinsics, no VM context) for `setup()`. Provide
  `setupVM` only later.
- **Activation behaviour as a dispatch hook** in the facade (§2.8). Keep listeners in JS: they are
  JS functions. Build the propagation path with one Rust call (`rs.ancestors(id)`), or from wrapper
  `parentNode` reads.
- Optional: **zero-delay timer grouping** is only relevant if rsdom overrides timers. It should not:
  Vitest keeps Node's timers (§2.12).

### 5.7 Patterns to avoid (from happy-dom and linkedom)

1. Index-based child arrays with `indexOf` for siblings (O(n²) walks).
2. Re-walking the inserted subtree on every insert when connectivity did not change (O(n·depth)
   React builds; jsdom does it too).
3. Eager per-node allocation of caches, listener maps, `NamedNodeMap`s, `Set`s. A happy-dom Text
   node is 2.5 KB.
4. A full `Attr` node per attribute and a `MutationRecord` per mutation with no observers.
5. Reverse-dependency arrays (`affectsCache`) that grow without bound and miss dependencies.
6. Document-wide queries inside per-element algorithms (`getStyleSheets` in computed style).
7. Push-based subtree MutationObserver registration (O(subtree) per `waitFor`).
8. Proxies on hot per-element objects (`classList` inside selector matching, `style`).
9. linkedom's fresh `childNodes` arrays, O(depth) `isConnected`, and depth-based
   `compareDocumentPosition`.
10. Regex-based HTML and selector parsing with silent truncation (`:not(a b)` → `:not(a)`). If
    rsdom does not support something, it should throw `SyntaxError`, not answer wrongly.

### 5.8 Where Rust can win, and where it cannot (boundary economics)

- An N-API call costs roughly 50-150 ns plus string marshalling (`jsdom.md` H5). happy-dom's
  `getAttribute` is 38 ns and its `nodeType` read is about 1 ns. **Rust cannot beat happy-dom on
  single cheap reads.** rsdom must keep those in JS (cached immutable facts) or at least at parity
  (`getAttribute` through an atom id).
- Rust wins on **bulk algorithms**, where a single crossing replaces thousands of JS operations:
  - cold `qSA` (target ≤0.2 ms on the 3k table, vs 3-10 ms for happy-dom cold)
  - `matches` misses
  - computed-style misses (target ≤5 µs vs 4 ms)
  - `textContent` (target ≤50 µs per 4k nodes)
  - `innerHTML` parse via html5ever with a bulk insert (target ≤5 ms per 4k nodes)
  - serialization
  - subtree insert and remove (O(1) relink plus connectivity flags)
  - DOM-order sort
- Rust also wins on **memory**: a node at around 64-128 B plus an optional rare-data box, vs 1.6 KB
  (jsdom) and 3.7 KB (happy-dom). Wrappers are created only when a node crosses to JS.
- **Mutations are where happy-dom is weakest** and React render/re-order dominates the heavy tests
  (`app-notes.md`: render 1000 rows 553 ms on happy-dom vs 475 ms on jsdom). An rsdom `appendChild`
  at ≈0.3-0.5 µs (one crossing + O(1) relink + epoch bump) would be 10-20× faster than both.

---

## 6. Pitfalls checklist for rsdom (derived from this study)

- [ ] `constructor.name` per interface; `HTMLInputElement.prototype` owns `value`/`checked` accessors (§2.1).
- [ ] Window exposes constructors and functions as **own** properties; methods bound or `this`-tolerant (§2.12).
- [ ] Host-realm intrinsics in `setup()` (`GlobalWindow` semantics) (§2.11).
- [ ] `getComputedStyle([hidden]).display === 'none'`; no stale results with sibling combinators (§2.6).
- [ ] `:empty` counts text; `:not(complex)` either works or throws (§2.5).
- [ ] `getElementById` returns the first in tree order with duplicate ids (§2.13).
- [ ] `focus()` respects focusability (jsdom semantics; see `jsdom.md` §6.9) without paying jsdom's style invalidation (§2.13).
- [ ] `compareDocumentPosition` correct for different depths (linkedom bug, §4.3).
- [ ] `window.event` set during dispatch (§2.8, `react-dom.md` §17).
- [ ] Memo caches bounded (epoch-validated), with no per-node registration arrays (§5.3).
- [ ] MutationObserver: zero cost when unobserved; O(depth) per mutation when observed; O(1) `observe()` (§2.9).
- [ ] Insert into a detached parent must not walk the subtree unless something in it needs insertion steps (§2.2).
- [ ] Sibling navigation O(1); `childNodes[i]` O(1) amortised (§4.3, §5.1).
- [ ] No Proxy on per-element hot paths (§2.10).

---

## 7. Reproducing the measurements

```sh
cd rsdom-lab
node docs/lab/research/happy-dom-probes/env.mjs                  # import + window creation, realm facts
node docs/lab/research/happy-dom-probes/ops.mjs                  # same op list as jsdom-probes/ops.cjs (+ cold/warm qSA, structural probes)
node --expose-gc docs/lab/research/happy-dom-probes/ops2.mjs     # computed style cold/warm, textContent, serialize, focus, affectsCache growth, bytes/node
node docs/lab/research/happy-dom-probes/quirks.mjs               # behaviour checks cited in §2.13
node docs/lab/research/happy-dom-probes/bottomup-jsdom.cjs       # jsdom counterpart of the bottom-up build probe (§2.2)
# linkedom is not an app dependency:
mkdir -p /tmp/lk && (cd /tmp/lk && npm i linkedom@0.18.13)
LINKEDOM=/tmp/lk/node_modules/linkedom node docs/lab/research/happy-dom-probes/linkedom.mjs
LINKEDOM=/tmp/lk/node_modules/linkedom node docs/lab/research/happy-dom-probes/linkedom.mjs cached
```

Notes:
- The `ops.mjs` "cold" queries mutate the container first (`setAttribute` on the scope element),
  which every query visits. The mutation cost (2-4 µs) is negligible next to the query.
- `ops.mjs` keeps every node created by the mutation benches. By the selector section `<body>` holds
  ~150k elements, which is why the computed-style section moved to `ops2.mjs` with a fresh document
  (§2.6).
- All numbers are single runs in a plain Node process, not inside Vitest workers. Use them for
  ratios, not absolutes. The raw output is in
  `docs/lab/research/happy-dom-probes/results-happy-dom-21.0.3-linkedom-0.18.13.txt`.
