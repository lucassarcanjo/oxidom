# Benchmark subject app: `e2e/react-app/`

A dummy React 19 app plus a realistic Vitest + Testing Library suite. It is the
end-to-end benchmark subject for **jsdom vs happy-dom vs oxidom**. The suite passes
100% under jsdom and happy-dom (90/90 tests, 11 files). oxidom is wired in through
a config hook (see below), but the environment file does not exist yet.

## How to run

```bash
cd app
npm ci
npm run test:jsdom        # DOM_ENV=jsdom     vitest run   (default if DOM_ENV is unset)
npm run test:happy-dom    # DOM_ENV=happy-dom vitest run
npm run test:oxidom        # DOM_ENV=oxidom     vitest run   (needs packages/oxidom/lib/vitest-environment.mjs)
npm run typecheck         # tsc --noEmit (TypeScript 7.0.2)
```

An unknown `DOM_ENV` makes the config throw (`Unknown DOM_ENV "x"`).
`DOM_ENV=oxidom` currently fails with `Failed to load url oxidom-lab/oxidom/js/vitest-environment.js ... Does the file exist?`,
which is expected until the oxidom package ships that file.

## Pinned versions (`e2e/react-app/package.json`, exact versions)

| package | version |
|---|---|
| react / react-dom | 19.3.1 |
| vitest | 5.0.5 |
| vite | 8.3.4 (required peer of vitest 5, see `refs/vitest/packages/vitest/package.json` → `peerDependencies.vite` with `optional: false`) |
| jsdom | 30.1.3 |
| happy-dom | 21.0.3 |
| @testing-library/react | 16.3.3 |
| @testing-library/dom | 10.4.2 |
| @testing-library/jest-dom | 7.0.1 |
| @testing-library/user-event | 14.6.8 |
| typescript | 7.0.2 (typecheck only; Vitest never type-checks) |
| @types/react / @types/react-dom | 19.3.0 |

Node is v22.22.0. jsdom 30.1.3 and some of its dependencies declare
`engines.node: ^22.22.2`, so npm prints `EBADENGINE` warnings. They are harmless
here, because the whole suite passes on jsdom.

## Config decisions

- **JSX / TSX works out of the box. `@vitejs/plugin-react` is not installed.**
  Vite 8 transforms `.ts/.tsx` with Oxc. The default JSX runtime is automatic,
  with `importSource` `react`. In non-production mode it uses `jsx-dev-runtime`
  (see `e2e/react-app/node_modules/vite/dist/node/chunks/node.js` around lines 7605-7690
  and 37773). The Vitest docs list "Out-of-the-box ES Module / TypeScript / JSX support"
  (`refs/vitest/docs/guide/features.md:41`). `tsconfig.json` sets `"jsx": "react-jsx"`
  for editors and `tsc`.
- **`e2e/react-app/vitest.config.ts`**: `environment` comes from `DOM_ENV`, with `globals: true`,
  `setupFiles: ['./src/test/setup.ts']`, `include: ['src/**/*.test.{ts,tsx}']` and
  `testTimeout: 5000`. The pool, isolation and transforms are left at their
  defaults (pool `forks`, isolate `true`). That means **one fresh environment per
  test file**, which is what most real projects run.
- **oxidom hook**: `DOM_ENV=oxidom` maps to
  `fileURLToPath(new URL('../oxidom/js/vitest-environment.js', import.meta.url))`,
  which is `oxidom-lab/oxidom/js/vitest-environment.js`. Vitest treats an
  environment name that starts with `/` or `.` as a path
  (`refs/vitest/packages/vitest/src/integrations/env/loader.ts`, `loadEnvironment`).
  With the default Vite module runner, the file is imported **through Vite's
  module runner** (`loader.import(packageId)`), not through a plain Node
  `import`. So the oxidom environment should load its `.node` addon with
  `createRequire(import.meta.url)`, not with a bare `import`. The default export
  must be an `Environment` object (`name`, `viteEnvironment: 'client'`,
  `setup()`, and optionally `setupVM()`), as documented in
  `refs/vitest/docs/guide/environment.md` ("Custom Environment"). The built-in
  envs expose the window on Node's global through `populateGlobal(global, win, { bindFunctions: true })`
  (`refs/vitest/packages/vitest/src/integrations/env/jsdom.ts:224`,
  `refs/vitest/packages/vitest/src/integrations/env/happy-dom.ts:63`). The list of
  keys jsdom copies is in `refs/vitest/packages/vitest/src/integrations/env/jsdom-keys.ts`.
- **`e2e/react-app/src/test/setup.ts`**: imports `@testing-library/jest-dom/vitest`,
  registers `afterEach(() => { cleanup(); vi.restoreAllMocks() })`. With
  `globals: true`, RTL also auto-registers `afterEach(cleanup)` and sets
  `IS_REACT_ACT_ENVIRONMENT` in `beforeAll`
  (`refs/react-testing-library/src/index.js`). That double cleanup is harmless
  because `cleanup()` is idempotent.

## Files

```
app/
  package.json, package-lock.json, tsconfig.json, vitest.config.ts
  src/test/setup.ts
  src/data/generateRows.ts          deterministic (mulberry32-seeded) user rows
  src/components/
    Counter.tsx                     buttons, disabled states, <output>, role=note
    TodoApp.tsx                     controlled input, form submit, toggle, delete, filter all/active/done, counts, clear completed, validation (role=alert, aria-invalid, aria-describedby)
    DataTable.tsx                   sortable headers (aria-sort + buttons), search filter, pagination (First/Prev/Next/Last), row + page selection checkboxes (indeterminate), role=status range text
    Tabs.tsx                        WAI-ARIA tablist/tab/tabpanel, roving tabindex, Arrow/Home/End keys, disabled tab, `hidden` panels
    Modal.tsx                       portal to document.body, role=dialog + aria-modal + labelledby/describedby, focus into dialog, restore focus, Escape (document keydown), backdrop click, Tab trap, body scroll lock; DeleteAccountDialog consumer
    SignupForm.tsx                  label/input association, email/password/name validation on blur, select, textarea w/ counter, radio group (fieldset/legend), checkboxes, password visibility toggle, submit disabled until valid, async submit → success status
    AsyncUserList.tsx               injected fetch fn (AbortSignal), loading/error/success, retry, refresh, client-side search + "only active" filter
    Accordion.tsx                   heading > button[aria-expanded][aria-controls] + role=region[hidden], single/multiple mode
    Theme.tsx                       ThemeProvider context, className + inline style, mirrors data-theme / color-scheme onto <html>, ThemeToggle (aria-pressed), ThemedCard
    Dashboard.tsx                   composition: ThemeProvider + header nav + DeleteAccountDialog + summary cards + Tabs(Overview: Counter+Accordion, Tasks: TodoApp, Team: AsyncUserList, Data: DataTable(300 rows), Billing: disabled)
  src/__tests__/                    (11 files, 90 tests)
```

| test file | tests | what it exercises |
|---|---:|---|
| `Counter.test.tsx` | 7 | getByRole {name}, fireEvent.click, toBeDisabled/Enabled, `rerender`, `unmount`, toBeEmptyDOMElement |
| `TodoApp.test.tsx` | 10 | fireEvent.change/click/submit, `within`, getByRole('form'), toHaveAccessibleDescription, toHaveAccessibleName, toHaveClass, a 30-add/10-toggle "long session" |
| `DataTable.test.tsx` | 10 | 300 rows, page size 25-300: rowgroup/row/cell/columnheader roles, aria-sort, searchbox, pagination nav, toBePartiallyChecked (indeterminate), selection |
| `DataTable.heavy.test.tsx` | 6 | **heavy**: 1000 rows (~17k nodes) on one page: getAllByRole('link') over 1000 links, 11 successive filters, sort id/name both directions over all rows, select-all then filter. Timeout raised to 30s for this file |
| `Tabs.test.tsx` | 8 | tablist/tab/tabpanel, `{ hidden: true }`, `{ selected: true }`, roving tabindex, fireEvent.keyDown Arrow/Home/End, toHaveFocus, toBeVisible on `hidden` panels |
| `Modal.test.tsx` | 9 | **user-event**: click, keyboard('{Escape}'), tab / tab({shift}), type; portal, toContainElement, toHaveStyle on body, focus trap/restore, fireEvent.keyDown(document) |
| `SignupForm.test.tsx` | 11 | **user-event**: type, clear, click, tab, selectOptions; toBeInvalid, toHaveAccessibleDescription (multi-id), toHaveDisplayValue, option.selected, toHaveFormValues, findByRole, fireEvent.blur |
| `AsyncUserList.test.tsx` | 8 | vi.fn mockResolvedValue/RejectedValue/Implementation, findByRole/findAllByRole, waitFor, waitForElementToBeRemoved, act + deferred promises, AbortSignal, unmount before resolve |
| `Accordion.test.tsx` | 6 | region role only when expanded, aria-expanded/controls, toBeVisible on `hidden`, aria-hidden icons, heading levels |
| `Theme.test.tsx` | 7 | context, toHaveClass, toHaveStyle (object + string form, hex→rgb normalisation, shorthands), `document.documentElement.dataset`, `style.getPropertyValue`, renderHook + act, render throwing |
| `Dashboard.test.tsx` | 8 | integration: landmarks (banner/main/navigation/article), lazy tab content, nested within() queries, async fetch on tab switch, dialog flow |
| **total** | **90** | |

## Durations (Vitest `Duration` line, `vitest run`, default pool, 4 CPUs)

The runs were interleaved (jsdom, happy-dom, jsdom, ...). The extra summary
lines that Vitest prints are included.

| run | jsdom | happy-dom |
|---|---|---|
| 1 | `Duration  12.22s (tests 65%, environment 28%, setup 5%, import 1%, transform 1%)` | `Duration  10.19s (tests 70%, environment 20%, setup 8%, import 1%, transform 1%)` |
| 2 | `Duration  11.55s (tests 64%, environment 29%, setup 5%, import 1%)` | `Duration  9.96s (tests 70%, environment 20%, setup 8%, import 1%)` |
| 3 | `Duration  11.74s (tests 66%, environment 28%, setup 5%, import 1%)` | `Duration  10.63s (tests 69%, environment 21%, setup 8%, import 1%, transform 1%)` |

- jsdom: `jsdom was created 11 times · 9.71s / 9.41s / 9.20s total, ~28% of tracked time`.
  That is about **0.85s of environment setup per test file**.
- happy-dom: `11 workers spawned · ~563ms / ~558ms / ~606ms startup each (spawn + environment, per file)`.

An earlier warm-up round with the same code (only one comment differed) gave
jsdom 11.97 / 12.14 / 12.54s and happy-dom 10.26 / 10.51 / 11.01s.

### Per-file test time (sum of test durations, one `--reporter=json` run each; indicative only)

| file | jsdom ms | happy-dom ms |
|---|---:|---:|
| Accordion | 443 | 180 |
| AsyncUserList | 543 | 207 |
| Counter | 339 | 84 |
| Dashboard | 999 | 506 |
| **DataTable.heavy** | **11094** | **8834** |
| DataTable | 3519 | 2078 |
| Modal | 849 | 305 |
| SignupForm | 2519 | 1607 |
| Tabs | 399 | 121 |
| Theme | 255 | 94 |
| TodoApp | 2112 | 922 |
| total | 23070 | 14937 |

The heavy file is on the critical path of the 4-worker run. Wall-clock
`Duration` is therefore roughly "heavy file + its env setup". Report per-file
numbers alongside the total.

### Where the heavy-file time goes (ad-hoc probe, 1000 rows, single test, ms)

| operation | jsdom | happy-dom |
|---|---:|---:|
| `render(<DataTable rows=1000 pageSize=1000/>)` | 475 | 553 |
| first `getByRole('button', {name:'Name'})` | 315 | 128 |
| click sort asc (React re-orders 1000 keyed `<tr>`) | 189 | 337 |
| click sort desc | 138 | 167 |
| read column via `querySelectorAll('tr')` + `querySelectorAll('td')` | 47 | 52 |
| `getAllByRole('link')` (1000 links, a11y checks) | **1514** | 331 |
| `getAllByRole('row')` | 350 | 104 |
| `getByLabelText('Filter rows')` | 84 | 108 |
| `getByText(...)` | 187 | 90 |
| filter change → 1000→few rows | 120 | 128 |
| filter clear → few→1000 rows (mount 1000 rows) | 382 | 436 |
| click "select all" (`getByRole('checkbox',{name})` over 1001 checkboxes + rerender) | 642 | 394 |
| `document.body.textContent` | 7 | 10 |

The main cost is **role queries**, whose per-element cost is
`getComputedStyle` + ancestor walks + accessible-name computation. The second
cost is **mounting and reordering large subtrees** (createElement /
insertBefore / removeChild / setAttribute / text). happy-dom is not faster than
jsdom at DOM mutation: its render and sort numbers are equal or worse. That is
the opening for oxidom.

## Notable findings and adjustments

1. **happy-dom 21.0.3 lacks `HTMLTableSectionElement.rows`**: `tbody.rows` is
   `undefined`. `refs/happy-dom/packages/happy-dom/src/nodes/html-table-section-element/HTMLTableSectionElement.ts`
   only has `insertRow`/`deleteRow`, while
   `refs/happy-dom/packages/happy-dom/src/nodes/html-table-row-element/HTMLTableRowElement.ts:23`
   does have `cells`. jsdom implements it in
   `refs/jsdom/lib/jsdom/living/nodes/HTMLTableSectionElement-impl.js:9`. The heavy
   test was rewritten to use `tbody.querySelectorAll('tr')` and
   `row.querySelectorAll('td')`, the more common real-world form. oxidom can
   still implement `rows`/`cells` cheaply.
2. **`toBeValid()` / `toBeInvalid()` also consult `checkValidity()`**
   (`refs/jest-dom/src/to-be-invalid.js:7-19`). Both envs implement email
   `typeMismatch`, so an `<input type=email required>` holding `not-an-email` is
   invalid even without `aria-invalid`. The test asserts `aria-invalid="false"`
   before blur instead. **oxidom must implement constraint validation
   (`required`, `type=email`) or `toBeValid`/`toBeInvalid` diverge.**
3. **`fireEvent.click` does not move focus.** The Dashboard dialog test calls
   `trigger.focus()` before `fireEvent.click(trigger)` so focus restoration can
   be asserted. user-event does move focus (Modal tests).
4. The suite produces **no console warnings** under either env: no act()
   warnings and no React errors. The intentional error test mocks
   `console.error`.
5. A render that throws (`Theme.test.tsx`: "throws a helpful error outside the
   provider") is rethrown by React 19 `act` under both envs. oxidom needs no
   special handling, but window `error` event plumbing should not swallow it.

## DOM APIs and features the suite exercises (the oxidom target)

The list is grouped by consumer. Paths are relative to `refs/` unless they say
`e2e/react-app/node_modules/...` (user-event and scheduler are not cloned under `refs/`).

### Globals / environment

- The window object and its globals copied onto Node's `global` (`populateGlobal`):
  `window`, `document`, `navigator`, `HTMLElement` and all `HTML*Element`
  subclasses used (div, span, p, h1-h4, button, input, select, option,
  textarea, label, fieldset, legend, form, table, caption, thead, tbody, tr, th,
  td, ul, li, a, nav, header, main, footer, section, article, strong, output),
  `SVGElement` (only for `instanceof`), `Node`, `Element`, `Text`, `Comment`,
  `DocumentFragment`, `Event` and its subclasses, `MutationObserver`, and
  `getComputedStyle`. `CSS.escape` is optional, because jest-dom imports the
  `css.escape` polyfill. `DataTransfer` is only referenced lazily by DTL
  `createEvent`.
  See `vitest/packages/vitest/src/integrations/env/jsdom-keys.ts`.
- `node.ownerDocument.defaultView` must return the window, because DTL and
  jest-dom fetch `getComputedStyle`, `MutationObserver`, `HTMLElement` and
  `Node` from it (`dom-testing-library/src/helpers.ts:29-32`,
  `jest-dom/src/utils.js:51-76`, which uses `instanceof window.Node`,
  `instanceof window.HTMLElement` and `instanceof window.SVGElement`).
- Timers come from Node (`setTimeout`, `setInterval`, `queueMicrotask`). The
  React scheduler uses `setImmediate` when present
  (`e2e/react-app/node_modules/scheduler/cjs/scheduler.development.js:210`).
  `AbortController` / `AbortSignal` are used by `AsyncUserList`, and the test
  does `expect.any(AbortSignal)`. The global the component sees must be the
  global the test sees.

### Tree construction and mutation (React DOM commit phase)

- `document.createElement(type)`, `createTextNode`, `appendChild`,
  `insertBefore`, `removeChild`, `textInstance.nodeValue = ...`, and the
  `textContent` setter
  (`react/packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js:471, 696, 772, 1019, 1036, 1140, 1213`).
  `createElementNS` is only needed for SVG, which this suite does not use.
- `createPortal(..., document.body)` appends directly to `body`.
- RTL creates each container with
  `document.body.appendChild(document.createElement('div'))` and then
  `createRoot` (`react-testing-library/src/pure.js:274-281`).
- `cleanup()` unmounts and removes containers after every test.
- Keyed list reordering (DataTable sort) means many `insertBefore` moves of
  existing nodes.

### Attributes and properties React writes

- `setAttribute` / `removeAttribute` for `id`, `class` (`className`), `role`,
  `aria-*`, `data-*`, `type`, `name`, `href`, `for` (`htmlFor`), `tabindex`,
  `hidden`, `disabled`, `required`, `autocomplete`, `placeholder`, `rows`,
  `scope`, `value` (option).
- Properties: `value`, `checked`, `defaultValue`/`defaultChecked`, `selected`,
  `indeterminate` (set via ref; read by `toBePartiallyChecked`, see
  `jest-dom/src/to-be-partially-checked.js:28`).
- **Value tracking:** React does
  `Object.getOwnPropertyDescriptor(node.constructor.prototype, 'value'|'checked')`
  and needs a getter **and** a setter, then redefines it on the instance
  (`react/packages/react-dom-bindings/src/client/inputValueTracking.js:59-77`).
  DTL `fireEvent.change` calls the **prototype** setter
  (`dom-testing-library/src/events.js:106-123`). user-event wraps
  `value`/`setSelectionRange` the same way
  (`e2e/react-app/node_modules/@testing-library/user-event/dist/esm/document/interceptor.js:8`).
  So `HTMLInputElement.prototype`, `HTMLTextAreaElement.prototype` and
  `HTMLSelectElement.prototype` must own real accessors, and
  `el.constructor === HTMLInputElement` and so on.
- Inline styles: `style[camelCase] = v`, `style.setProperty(name, v)`, and
  `style.cssFloat` (`react/packages/react-dom-bindings/src/client/CSSPropertyOperations.js:78-99`).
  Unitless numbers get `px` (`borderWidth: 1`).

### Events

- Constructors: `Event`, `MouseEvent`, `PointerEvent`, `KeyboardEvent`,
  `FocusEvent`, `InputEvent`, `UIEvent`. DTL picks `window[EventType]`
  (`dom-testing-library/src/events.js:50-57`) and user-event does the same
  (`e2e/react-app/node_modules/@testing-library/user-event/dist/esm/event/createEvent.js:38-42`).
- `addEventListener` with capture/bubble and `{passive}` options. React
  attaches roughly 80 listener types to the root container, plus
  `selectionchange` on the document
  (`react/packages/react-dom-bindings/src/events/DOMPluginEventSystem.js:432-455`).
- `dispatchEvent` with correct capture → target → bubble propagation,
  `stopPropagation`, `preventDefault` / `defaultPrevented`, `target`,
  `currentTarget`, `key`, `shiftKey`.
- **Activation behaviour.** Clicking a checkbox or radio toggles `checked`
  (radio groups uncheck siblings by `name`). React reads checkbox and radio
  changes from `click` (`react/packages/react-dom-bindings/src/events/plugins/ChangeEventPlugin.js:231-239`).
  Clicking a `<button type=submit>` fires `submit` on its form (TodoApp "Add").
  The suite never clicks a `<label>` element: `getByLabelText` returns the
  control, so label activation behaviour is not exercised yet.
- Focus: `el.focus()` / `blur()` update `document.activeElement` and fire
  `focus`/`blur`/`focusin`/`focusout` (Modal focus management, Tabs roving
  focus). user-event patches `HTMLElement.prototype.focus/blur`
  (`e2e/react-app/node_modules/@testing-library/user-event/dist/esm/document/patchFocus.js:12-13`)
  and listens for `focus`/`blur` on `document` in capture
  (`.../document/prepareDocument.js:13,26`). `tabIndex` must reflect the
  defaults: 0 for focusable controls, -1 otherwise. `user.tab()` computes the
  order from a focusable selector
  (`.../utils/focus/selector.js`) and `tabIndex`.
- `user.type` and `user.clear` use the selection API on inputs
  (`selectionStart`/`selectionEnd`/`setSelectionRange`) and
  `document.getSelection()`. React's commit also reads selection info
  (`react/packages/react-dom-bindings/src/client/ReactInputSelection.js:59-121`,
  `instanceof win.HTMLIFrameElement`).
- user-event checks `getComputedStyle(el).pointerEvents` up the ancestor chain
  (`e2e/react-app/node_modules/@testing-library/user-event/dist/esm/utils/pointer/cssPointerEvents.js:14`).

### Selectors (`querySelector` / `querySelectorAll` / `matches` / `closest`)

- DTL role queries run `container.querySelectorAll(makeRoleSelector(role))`,
  a large comma list such as `*[role~="button"],button,input[type="button"],...`
  (`dom-testing-library/src/queries/role.ts:187, 307-322`). Implicit roles are
  then checked with `node.matches(selector)`
  (`dom-testing-library/src/role-helpers.js:138`).
- `ByText` and `ByLabelText` scan `querySelectorAll('*')`
  (`dom-testing-library/src/queries/text.ts:40`,
  `dom-testing-library/src/queries/label-text.ts:25, 59`) with
  `matches('script, style')` for the ignore list.
- Selectors in app and test code: `tbody`, `tr`, `td`,
  `input[type="checkbox"]:checked`, `tr.row--selected`,
  `[aria-hidden="true"]`, `label`, `[name="..."]` (jest-dom
  `toHaveFormValues`), the Modal focusable selector `a[href], button:not([disabled]), ..., [tabindex]:not([tabindex="-1"])`,
  and `closest('li')`, `closest('tr')`, `closest('.accordion__item')`,
  `closest('fieldset')` (jest-dom `toBeDisabled`).
- Required selector features: type, class, id, attribute (`=`, `~=`),
  `:not()`, `:checked`, `*`, descendant combinator and selector lists.

### CSSOM and computed style (the hottest path in role queries)

- `window.getComputedStyle(el)`: `display`, `visibility`, `opacity`,
  `pointerEvents` and `getPropertyValue`. It is called per candidate element
  and per ancestor (`dom-testing-library/src/role-helpers.js:15-60`,
  `dom-accessibility-api/sources/is-inaccessible.ts:26-41`,
  `jest-dom/src/to-be-visible.js:4-36`).
- **The `hidden` attribute must be honoured.** That is what excludes hidden
  tabpanels and accordion regions from `getByRole`. Four checks depend on it:
  - DTL checks the `element.hidden` IDL property first
    (`dom-testing-library/src/role-helpers.js:16`).
  - dom-accessibility-api checks `hasAttribute('hidden')`
    (`dom-accessibility-api/sources/accessible-name-and-description.ts:79-84`).
  - jest-dom `toBeVisible` checks `hasAttribute('hidden')`
    (`jest-dom/src/to-be-visible.js:29`).
  - jsdom computes `display: none` for `[hidden]`, as browsers do from the UA
    stylesheet. happy-dom 21.0.3 returns `display: block` (checked with a
    standalone script). The suite still passes on happy-dom only because of the
    explicit checks above. oxidom should match jsdom and browsers.
- Cheap early exits matter. `aria-hidden="true"` and `element.hidden` are
  checked before `getComputedStyle`, and `visibility` is inherited, so one
  `getComputedStyle(el).visibility` check covers the whole ancestor chain
  (`dom-testing-library/src/role-helpers.js:46-60`).
- Pseudo-element styles (`getComputedStyle(el, '::before')`) are **not** needed
  by default, because DTL sets `computedStyleSupportsPseudoElements: false`
  (`dom-testing-library/src/config.ts:50`).
- `toHaveStyle` writes the expected CSS onto a scratch `div.style[prop]`, then
  compares with `computedStyle[prop]` or `getPropertyValue(prop)`
  (`jest-dom/src/to-have-style.js:4-31`). Requirements:
  - camelCase and kebab-case property access
  - identical colour normalisation for inline and computed values (`#1e1e1e` → `rgb(30, 30, 30)`)
  - shorthands (`padding: 8px 12px`, `border-*`)
  - `body.style.overflow`
  - `documentElement.style.setProperty('color-scheme', ...)` and
    `getPropertyValue` / `removeProperty`
- Stylesheets: none. The app imports no CSS, so computed style is UA defaults,
  inheritance and inline style.

### Accessibility tree (dom-accessibility-api, via DTL `{name}` and jest-dom)

- Implicit roles in use: button, link (`a[href]`), heading (h1-h4 with
  `level`), textbox (text, email, textarea), searchbox (`type=search`), combobox
  (`select`), option, checkbox, radio, group (`fieldset`, `role=group`), list,
  listitem, table, rowgroup, row, cell, columnheader, form (needs a name),
  region (needs a name), navigation, banner (`header` not inside a sectioning
  element), main, article, status (`output`), alert, note, dialog, tablist,
  tab, tabpanel.
- Accessible name sources: `aria-labelledby` (resolved with `getElementById`
  on the root), `aria-label`, `<label for>` and wrapping labels (`el.labels`),
  `<legend>` for fieldset, `<caption>` for table, subtree text (childNodes
  traversal), `aria-hidden` subtrees excluded, `title`
  (`dom-accessibility-api/sources/accessible-name-and-description.ts:281-310, 394-420`).
  DTL `getByLabelText` also uses `el.labels` or `label.control`
  (`dom-testing-library/src/label-helpers.ts:39-47`).
- Descriptions: `aria-describedby` with several ids joined by spaces
  (`toHaveAccessibleDescription`).
- State filters: `{ selected: true }` (aria-selected), `{ hidden: true }`,
  `{ level }`. `checked` and `indeterminate` feed `toBeChecked` /
  `toBePartiallyChecked`.

### Forms

- `form.elements` (jest-dom `toHaveFormValues`, `jest-dom/src/to-have-form-values.js:52-64`).
- `select.value`, `option.selected`, `select.options` / `selectedOptions`
  (`toHaveDisplayValue`, `user.selectOptions`).
- `textarea.value`, radio groups by `name`, `checkbox.checked`, `disabled` on
  controls, `fieldset` disabled semantics (`jest-dom/src/to-be-disabled.js`).
- `checkValidity()` with `required` and `type=email` (see finding 2).
- Submit: `fireEvent.submit(form)`, plus implicit submission via a submit
  button click; React calls `preventDefault`.

### Observers and misc

- `MutationObserver` with `{subtree, childList, attributes, characterData}` on
  the container, used by `waitFor` / `findBy*` / `waitForElementToBeRemoved`
  (`dom-testing-library/src/wait-for.js:32-36, 102-104`).
- `classList.contains` (app tests) and `getAttribute('class')` (jest-dom
  `toHaveClass`, `jest-dom/src/to-have-class.js:34`), `dataset` (DOMStringMap set/delete on
  `<html>`), `getRootNode({composed: true})` and `ownerDocument.contains`
  (`jest-dom/src/to-be-in-the-document.js:11`), `Node.contains`
  (`toContainElement`), `childNodes` / `nodeType` (`toBeEmptyDOMElement`),
  `textContent` getter everywhere (`toHaveTextContent`), and
  `document.activeElement` (`jest-dom/src/to-have-focus.js:7`).
- `parentElement` walks (toBeVisible, isInaccessible).
- Only on failure: DTL's `prettyDOM` serialises the tree. It needs `outerHTML`
  and the node shape that pretty-format's DOMElement plugin expects
  (`dom-testing-library/src/pretty-dom.js:39-91`). A passing run never pays for
  it, but error messages need it.
