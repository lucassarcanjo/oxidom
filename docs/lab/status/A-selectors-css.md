# Area A status: selectors and CSS

Branch `feat/area-a-selectors-css`. Covers ROADMAP M3 (P0 and P1), `element.style` from M5, and
`getComputedStyle` from M6. Ownership follows rsdom/CONTRIBUTING.md: `src/select/**`, `src/style/**`,
`packages/rsdom/lib/select.cjs` and `packages/rsdom/lib/style.cjs`, the area's tests and benches, and
`data/atoms/41-style.txt`.

One file outside that list changed: `Cargo.toml` gained `precomputed-hash = "=0.1.1"`. The `selectors`
crate needs it for the `SelectorImpl` atom hashes.

## Done

### Selectors (M3, P0 and P1)

- The engine is `selectors` 0.41 with a `cssparser` 0.38 adapter in `src/select/adapter.rs`.
  - Names are interned into the Env atoms while a selector is parsed, through a thread-local hand-off
    with no `unsafe`.
  - The `Element` impl runs directly over the arena.
- `compileSel` returns a selector id and writes the prefilter metadata to OUT as
  `[flags, nTags, tags...]`. The flags are TAG_ONLY, STATE, FOCUS, PSEUDO_ELEMENT, TEXT and CACHES.
- `matches`, `closest`, `querySelector` and `querySelectorAll` work on Element, Document and
  DocumentFragment.
  - Each query does one preorder walk, returns results in document order and never duplicates.
  - A lone `#id` on a connected root goes through the id map.
  - Each rightmost compound gets cheap Rust rejects (`Pre`) before full matching: tag, id, class,
    attribute presence, `:link`, `:focus`, and never-matching pseudo-classes.
- `getElementById` uses the id map. `getElementsByTagName`, `getElementsByTagNameNS` and
  `getElementsByClassName` are live and validated by epoch: `liveQueryCollection` keyed on `EP[TREE]`,
  plus `EP[ATTR]` for the class version.
- The pseudo-classes follow jsdom's dom-selector semantics:
  - `:checked :disabled :enabled :focus :focus-within :focus-visible :required :optional :read-only
    :read-write :placeholder-shown :indeterminate :default :link :any-link :defined :open :valid
    :invalid :lang() :dir()`
  - Structural pseudo-classes and `:is/:where/:has/:not` come from `selectors` itself.
  - Pseudo-classes that can never match in a DOM without a renderer still parse: `:hover`, `:active`,
    `:visited`, `:target`, `:modal`, `:popover-open`, `:autofill`, and similar ones.
  - Unsupported syntax throws a `SyntaxError` `DOMException`.
- JS side (`select.cjs`):
  - The `SEL` cache holds up to 4096 entries. When full it evicts the oldest quarter (FIFO) and calls
    `selFree` for each one. Keys are internalized strings (see Perf).
  - The corrected tag prefilter (DESIGN §6.3) only applies to HTML elements of HTML documents.
  - The qSA/qs LRU memo holds 64 entries. It is validated by `EP[TREE]` and `EP[ATTR]`, plus `EP[TEXT]`
    for `:empty`/`:has`, and `EP[FORM]`/`EP[REC]` for state pseudo-classes. Every hit returns a fresh
    NodeList.
  - Ablations: `RSDOM_NO_MEMO=1` and `RSDOM_NO_PREFILTER=1`.
- Matching reuses one `SelectorCaches` for selector lists that contain no `:nth-*()` or `:has()`. Lists
  with them get fresh caches on each call.

### element.style (DESIGN §8.1)

- `CSSStyleDeclaration` and `CSSStyleProperties`. Accessors are generated from jsdom 30.1.3's property
  table (`data/css/properties.tsv`, produced by `scripts/gen-css-data.mjs`): camelCase, kebab-case,
  `Webkit*`/`webkit*` and `cssFloat`.
- Supported: `setProperty` with `important`, `getPropertyValue`, `getPropertyPriority`,
  `removeProperty`, `cssText`, `length`, `item` and iteration.
- Values are normalized the way jsdom does it:
  - colors become `rgb()`/`rgba()`
  - lengths, keywords and the generic descriptor
  - invalid values are ignored
- Shorthands are expanded and serialized: margin, padding, `border*`, flex, background and font.
  `overflow` keeps its 1-2 keywords unexpanded, as jsdom does.
- The style attribute syncs lazily. The declaration block is parsed from the attribute on first use and
  written back through the attribute path (attr_ver, MO, STYLE epoch), and only when something actually
  changed.

### getComputedStyle (M6)

- The UA sheet is jsdom's `default-stylesheet.css` (`data/css/default-stylesheet.css`). It is parsed
  once per process.
  - Built-in `display: none` covers `[hidden]`, `input[type=hidden]`, `dialog:not([open])` and the
    rest.
- Author `<style>` sheets are collected per document in tree order and indexed into rule buckets (id,
  class, attribute, tag, universal), with per-property and per-tag "core" indexes.
  - `@media` only applies the `all` and `screen` media, as in jsdom.
- The cascade has jsdom parity:
  - Specificity then order for normal declarations, with no origin split.
  - Important declarations sort after normal ones, and the later one wins.
  - Inline style counts, including `!important`.
  - Inherited properties are resolved iteratively up the ancestor chain.
- Core snapshot:
  - Rust `csCore` returns display, visibility, pointer-events, opacity == 1 and position packed into
    a u32.
  - It is memoized per element against `EP[STYLE]`. `EP[13]` (`EP_STYLE_DEP`) adds `REC`/`FORM` when an
    author sheet selects on state.
  - JS caches it on the wrapper (`_cs`).
- Non-core properties are computed on demand (`csStr`) and are live.
- Pseudo-elements return a declaration whose `content` is `none`.
- STYLE invalidation is fine-grained:
  - `aria-*`, `data-*`, `title` and text writes never bump it.
  - `style`, `hidden`, `type`, `open` and `popover` writes always bump it.
  - `class`, `id` and attributes used by the sheets bump it only while author sheets exist.
  - Child-list changes always bump it.
- The `getComputedStyle(elt, pseudo)` function is unbound and exported as `rt.getComputedStyle`.
- `style::cascade::display_none_inclusive_ancestor` (native `csHidden(id)`) is there for area B's
  focusability.

### Acceptance (ticked in ROADMAP)

- **M3, DTL role selectors and implicit roles.** `test/contract/select-roles.test.mjs` checks DTL's role
  selectors (`data/role-selectors.txt`: 108 distinct selectors from the aria-query 5.3.0 trace) and
  `getImplicitAriaRoles` against jsdom over a generated fixture. The results are
  identical with the prefilter and the memo on or off (`test/native/select.test.mjs`). The whole suite
  is green with `RSDOM_NO_MEMO=1 RSDOM_NO_PREFILTER=1`.
- **M3, perf.** Cold qSA on the 2702-element table takes 44-63 µs. A prefiltered `matches` miss takes
  7.8 ns.
- **M6, accessible name.** It is "Saved", checked through dom-accessibility-api on rsdom with
  `rt.getComputedStyle`.
- **M6, jest-dom.** `toHaveStyle('color: red')` and `toHaveStyle({fontWeight: 'bold'})` pass through
  the app's jest-dom matchers. They fail on jsdom 30, as the test documents.
- **M6, STYLE epoch.** The `EP[3]` unit tests are in `test/native/style.test.mjs`.
- **M6, cold getComputedStyle.** It takes about 0.76 µs net for a depth-6 element (mutation subtracted).
  In Rust, the core for a 10-level chain takes 0.96 µs. The bench's deep case is 1.5 µs because it
  includes the inline-style mutation on `<body>`; see Perf.

## Divergences (asserted or documented)

- **Computed values keep the specified serialization.**
  - Examples: `color: red` stays `red` and `font-weight: bold` stays `bold`.
  - This makes jest-dom `toHaveStyle` round-trip. jsdom 30 resolves the value (`rgb(255, 0, 0)`/`700`)
    and so fails it.
  - Unspecified properties return jsdom's resolved initials: `rgb(0, 0, 0)`, `rgba(0, 0, 0, 0)`,
    `400`, `16px` and the like.
- **`getElementsByName` returns a static NodeList.** Nothing in the target stack holds it live.
- **Computed declaration `length`** counts longhands only.
- **jsdom quirks that rsdom does not copy** (pinned in `test/contract/select.test.mjs`):
  - `ul.querySelectorAll('nav li > a')` returns `[]` in jsdom. rsdom follows the spec.
  - jsdom's stale `:empty` cache.
  - `matches()` accepting namespace prefixes.
- **happy-dom divergences** are pinned to jsdom with comments, per CONTRIBUTING.

## Not done / follow-ups

- P2: the custom right-to-left fast compiler and the positive-only attribute bloom. `selectors` plus
  `Pre` already meets the gates.
- M6 P1: no `CSSStyleSheet` stubs and no `document.styleSheets`. Author sheets are read straight from
  `<style>` elements; `<link rel=stylesheet>` is ignored, as in jsdom without resources.
- Integrated on main (merge of A, B, C): `control_value_len` is `Env::value_len16` (area B's API value),
  `control_is_valid` is B's `Env::validity` fail bits plus dom-selector's maxLength/minLength override.
  Divergence: the ECMAScript-only validity parts (`pattern`, URL parsing for `type=url`, `required` file
  inputs) are reported as `CHECK_*` bits to the facade and count as passing for `:valid`/`:invalid`.
  `:checked`/`:focus`/`:indeterminate` read B's state bits (validated by `EP[REC]`/`EP[FORM]`); C installs
  `window.getComputedStyle`. The test gates are removed; `test/contract/integration.test.mjs` covers the
  cross-area behaviour.

## Perf (release, Node 22, 4 shared vCPUs: noisy)

`node bench/micro/select-style.mjs --write` writes `bench/micro/select-style.txt`. The ablation
run writes `select-style-ablation.txt`.

| operation | jsdom | happy-dom | rsdom |
|---|---:|---:|---:|
| matches(), 108 DTL role selectors × every element (ns/call) | 5082 | 405 | 28.6 |
| matches() prefilter miss (ns) | 2256 | 135 | 7.8 |
| matches() hit through Rust (ns) | 2617 | 134 | 117 |
| closest(form) (ns) | 3018 | 678 | 112 |
| qSA cold `td button`, 3k table (µs) | 971 | 2591 | 44.3 |
| qSA cold `.row.odd a[href]` (µs) | 2341 | 7565 | 62.7 |
| getElementsByClassName(...).length after a mutation (µs) | 1180 | 7130 | 24.1 |
| `style.color = ...` (ns) | 52059 | 8316 | 700 |
| `style.marginLeft` read (ns) | 631 | 4799 | 98.5 |
| gcs(el).display cold after body style mutation, depth 8 (ns) | 504958 | 2776806 | 1527 |
| gcs(el).display warm (ns) | 2856 | 432 | 46.6 |
| gcs(el).color, non-core and inherited (ns) | 2902 | 263 | 519 |

Notes:

- **matches() hit.** A Rust match takes 65 ns. Reusing `SelectorCaches` saves about 25 ns of that. The
  crossing adds about 35-50 ns.
- **SEL keys.** Sliced or cons strings used as `Map` keys (from `split()` or template literals) made
  every later SEL lookup about 30 ns slower in V8. Interning the key at compile time brought the
  prefilter miss back from 39 ns to 8 ns.
- **Cold getComputedStyle.** The cost is about 96 ns per uncached ancestor level, dominated by matching
  the UA core candidates. Ancestors stay memoized, so DTL's ancestor walks (`isInaccessible`) pay the
  chain once per STYLE epoch.
