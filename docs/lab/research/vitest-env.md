# Vitest 5.0.5: custom environments, phase timings and benchmarking (requirements for rsdom)

Scope: how to plug rsdom into Vitest 5.0.5 as a test environment, how jsdom and happy-dom install
their window onto `globalThis`, what React Testing Library expects from the global, how to read the
per-phase timings, how to run the suite N times for a fair benchmark, and what changes when the DOM
is a native N-API addon that runs inside Vitest workers.

Companion notes, not repeated here:
- `docs/lab/research/jsdom.md`: jsdom internals, including the window shape the Vitest jsdom env installs.
- `docs/lab/research/happy-dom-linkedom.md`, `docs/lab/research/react-dom.md`, `docs/lab/research/testing-library.md`.

Path conventions:
- `vitest/...` is relative to `refs` (shallow clone at tag `v5.0.5`, commit
  `7a825db4`). Same for `react-testing-library/...`, `jest-dom/...`, `napi-rs/...`, `react/...`.
- `vitest/src/...` is short for `vitest/packages/vitest/src/...`. `vitest/docs/...` is the docs site source.
- Vitest 3 and 4 are not in `refs`. For the version-history claims I unpacked `vitest@3.2.4` and
  `vitest@4.1.12` from npm into the scratchpad and read their `dist`. Those claims are marked "(npm dist)".

Evidence: every behaviour flagged **[verified]** was reproduced with Vitest 5.0.5 from
`e2e/react-app/node_modules` (vite 8.3.4, react 19.3.1, jsdom 30.1.3, happy-dom 21.0.3) on the 4 vCPU container
with Node v22.22.0. The probe scripts are in `docs/lab/research/vitest-env-probes/`, and the raw output is in
`docs/lab/research/vitest-env-probes/results-vitest-5.0.5.txt`.

---

## 0. TL;DR

1. **The env is a default-exported object** `{ name, viteEnvironment: 'client', setup(global, options) { ...; return { teardown(global) {} } } }`.
   The type is `Environment` from `vitest/runtime`; v5 removed `vitest/environments`. Omitting
   `viteEnvironment` breaks the run: it falls back to `name`, and you get `The environment rsdom was not defined in the Vite config.` **[verified]**
2. **There are three ways to reference it.**
   - A path in config: `environment: '/abs/or/./relative/path.(js|ts)'`. This is what `e2e/react-app/vitest.config.ts` already does.
   - A bare name `rsdom`, which loads the package `vitest-environment-rsdom`.
   - A docblock `// @vitest-environment rsdom`, which accepts **only names**. Paths are silently ignored and the
     file falls back to the config env (regex `[\w-]+`). **[verified]**
3. **Setup happens once per worker, before anything else.** In v5, `setup()` runs when the worker starts
   (`'start'` message), before Vitest's own globals (`afterEach`, `expect`, ...), before safe timers are
   captured, before `console` is replaced, and before any setup file or test file is imported.
   - With `isolate: true` (default) every test file gets a new worker, so there is one `setup()` per file.
   - With `isolate: false` there is one `setup()` per worker, and the DOM persists across files.
   - `teardown()` runs when the worker stops. **[verified]**
4. **`populateGlobal` semantics matter for rsdom**:
   - The globals it installs are accessor properties (getter + setter), and `window`, `self`, `top`, `parent` are all set to `globalThis`.
   - `document.defaultView` is rewritten to return `globalThis`.
   - All 227 names in `KEYS` are defined even when the window lacks them, and any Node global in `KEYS`
     (`Event`, `EventTarget`, `Blob`, typed arrays, ...) is overridden **even with `undefined`**. **[verified]**
   - rsdom should either provide every overlapping key, or install its globals itself as data properties.
     An accessor global costs about 20 ns per read, a data property about 1-2 ns. **[verified]**
5. **RTL auto-cleanup only works with `globals: true`**, because it needs a global `afterEach` when the module is first imported.
   - With `isolate: false` it registers only for the **first** file of each worker, because the RTL module stays cached.
   - Always add `afterEach(cleanup)` in a setup file for benchmarks. `e2e/react-app/src/test/setup.ts` already does. **[verified]**
6. **Phase timings.**
   - The v5 `Duration` line shows **percentages**: `Duration 3.02s (environment 72%, import 19%, tests 7%, transform 2%, worker 1%)`.
     v3 and v4 showed absolute ms.
   - The JSON reporter has **no** phase timings.
   - For absolute ms, use a tiny custom reporter that reads `testModule.diagnostic()` plus `task.setupFetchDuration`/`collectFetchDuration`
     (`docs/lab/research/vitest-env-probes/phase-reporter.js`).
   - Beware: with `isolate: false` and `maxWorkers > 1`, `environmentLoad` is re-reported for every file a reused worker runs. **[verified]**
7. **Benchmarking.**
   - Run `vitest run` in a fresh process per sample, with 1 warm-up and N ≥ 5, and compare medians of the external wall time.
   - `fsModuleCache` is on by default in v5, so the warm-up makes the samples warm-cache runs.
   - Pin `--maxWorkers`, and use the same `viteEnvironment: 'client'` and the same `setupFiles` for all three DOMs.
   - Measure at least `forks + isolate` (the default) and `threads + --no-isolate` (the fast path).
   - v4 removed `poolOptions`. Everything is top-level now: `pool`, `isolate`, `maxWorkers`, `fileParallelism`, `execArgv`, `vmMemoryLimit`.
8. **Native addon.** napi-rs addons are context-aware, so they load fine in `pool: 'threads'`.
   - Each worker thread gets its own `napi_env`, and the module init and class registration run per thread.
   - Rust `static`s are **shared by all threads in the process**; `thread_local!` is per worker. **[verified]**
   - Load the `.node` with `createRequire(import.meta.url)` from the env file, or ship the env as a real package inside `node_modules`.
   - A static `import` of a `.node` file, or of a CJS file outside `node_modules`, fails in the env loader. **[verified]**
   - vm pools need `setupVM`, and N-API objects are cross-realm there (`arr instanceof Array === false`). **[verified]** Skip vm pools initially.

---

## 1. The `Environment` contract

Source: `vitest/src/types/environment.ts` (whole file, 35 lines).

```ts
export interface EnvironmentReturn { teardown: (global: any) => Awaitable<void> }
export interface VmEnvironmentReturn {
  getVmContext: () => { [key: string]: any }
  teardown: () => Awaitable<void>
}
export interface Environment {
  name: string
  /** @deprecated use `viteEnvironment` instead */
  transformMode?: 'web' | 'ssr'
  viteEnvironment?: 'client' | 'ssr' | ({} & string)   // falls back to `name`
  prewarmModules?: boolean                              // vm pools only, default true
  setupVM?: (options: Record<string, any>) => Awaitable<VmEnvironmentReturn>
  setup: (global: any, options: Record<string, any>) => Awaitable<EnvironmentReturn>
}
```

Field by field:

- **`name`** is used in error messages, OpenTelemetry attributes and `expect.setState({ environment })`
  (`vitest/src/runtime/setup-node.ts:24-26`). It does **not** select the env. The config string or docblock does that.
- **`viteEnvironment`** names the Vite environment that transforms the *test files*.
  - Every reader uses `environment.viteEnvironment || environment.name`:
    `vitest/src/runtime/runners/test.ts:55`, `vitest/src/runtime/setup-node.ts:34`,
    `vitest/src/runtime/moduleRunner/startVitestModuleRunner.ts:65`.
  - Only `client` and `ssr` exist by default (`vitest/src/node/plugins/runnerTransform.ts:25-27`).
    A custom name throws `The environment <name> was not defined in the Vite config.` **[verified]**
  - jsdom and happy-dom use `'client'` (`vitest/src/integrations/env/jsdom.ts:70`, `happy-dom.ts:18`).
    node and edge-runtime use `'ssr'`.
  - Choosing `'client'` gives:
    - `process.env.SSR = ''`, so `import.meta.env.SSR` is false.
    - `require.extensions` stubs for `.css/.scss/.sass/.less` and asset extensions
      (`vitest/src/runtime/setup-node.ts:34-49`).
    - The same transform pipeline, and therefore the same `fsModuleCache` entries, as jsdom and happy-dom.
  - **rsdom must use `'client'`** for an apples-to-apples benchmark.
  - Resolve conditions are the server conditions in both cases: `mainFields: []`, and the default server
    conditions minus `module` (`vitest/src/node/plugins/utils.ts:163-184`).
- **`transformMode`** is accepted for backwards compatibility. It prints a deprecation warning and is mapped to
  `viteEnvironment` (`vitest/src/integrations/env/loader.ts:88-105`).
- **`prewarmModules`** is new in v5. It is read only by the vm worker (`vitest/src/runtime/workers/vm.ts:56-63`),
  where it lets the server transform the test file graph while a slow `setupVM` runs. Set it to `false` for a fast env.
- **`setup(global, options)`** is called with `global === globalThis` of the worker (thread or child process)
  (`vitest/src/runtime/workers/base.ts:124-133`).
  - It returns `{ teardown(global) }`.
  - The awaited time of the call, plus loading the env module, becomes `environmentLoad` (section 8).
- **`setupVM(options)`** is required for `pool: 'vmThreads' | 'vmForks'`, otherwise you get `... doesn't support vm environment because it doesn't provide "setupVM" method.`
  (`vitest/src/runtime/workers/vm.ts:65-72`) **[verified]**.
  - `getVmContext()` must return a `vm.createContext` object, which is checked with `isContext` (`vm.ts:89-101`).
- **`options`**: the call is `environment.setup(globalThis, environmentOptions || config.environmentOptions || {})`
  (`base.ts:132`), so `options` is one of two things:
  - **The whole `test.environmentOptions` object**, when the env comes from config or from a docblock without
    `-options`. Read your slice yourself, the way jsdom destructures `{ jsdom = {} }` (`jsdom.ts:177`).
  - **Only the docblock options**, wrapped under the env name, when the file has `@vitest-environment-options`:
    `{ [name]: json }`. The single exception is `happy-dom`, which becomes `happyDOM`
    (`vitest/src/utils/test-helpers.ts:43-56`). They *replace* the config options rather than merging with them. **[verified]**
  - Convention for rsdom: `environmentOptions: { rsdom: { url, ... } }`, read as `options.rsdom ?? {}`.

Public helpers (`vitest/src/public/runtime.ts:12-19`):
`import { builtinEnvironments, populateGlobal, type Environment } from 'vitest/runtime'`.
- `vitest/environments` was removed in v5 (`vitest/docs/guide/migration/index.md:634-640`). The old file
  `environments.d.ts` still ships at the package root but is not in `exports` and points at a missing `dist/environments`.
- `vitest/docs/config/environment.md` still shows `import type { Environment } from 'vitest'` and
  `vitest/environments`. Both are stale: `Environment` is exported only from `vitest/runtime`.

Recommended skeleton for rsdom. It is a sketch: the real globals list comes from the rsdom facade.

```ts
// rsdom/js/vitest-environment.ts  (ESM; loaded by Vitest's env ModuleRunner, see section 2)
import { createRequire } from 'node:module'
import type { Environment } from 'vitest/runtime'

const require = createRequire(import.meta.url)
// CJS, so it goes through Node's native require: shared CJS cache, never transformed by Vite
const rsdom = require('../index.cjs')

export default <Environment>{
  name: 'rsdom',
  viteEnvironment: 'client',
  prewarmModules: false,
  async setup(global, options) {
    const opts = (options.rsdom ?? {}) as { url?: string }
    const win = rsdom.createWindow({ url: opts.url ?? 'http://localhost:3000' })
    const restore = installGlobals(global, win)   // section 5: data properties + saved descriptors
    return {
      teardown(global) {
        win.close()                                 // free the Rust arena deterministically
        restore(global)
      },
    }
  },
}
```

---

## 2. How Vitest finds and loads an environment

Source: `vitest/src/integrations/env/loader.ts`.

1. **Builtins.** `node`, `jsdom`, `happy-dom` and `edge-runtime` come from the static map in
   `vitest/src/integrations/env/index.ts:7-17`, checked by `isBuiltinEnvironment` (`loader.ts:13-15`).
2. **With the default `experimental.viteModuleRunner: true`** (`loader.ts:108-139`):
   - **Path:** if `name[0] === '.' || name[0] === '/'`, it is `resolve(root, name)`. Absolute and relative POSIX paths
     work, and TypeScript works too. **[verified: absolute path to a `.ts` env]**
     A Windows path like `C:\...` does **not** start with `.` or `/`, so it would be treated as a package name.
   - **Bare name:** `rpc.resolve('vitest-environment-' + name, undefined, '__vitest__')`. If that does not resolve,
     it falls back to `resolve(root, name)`.
   - The module is imported by a **dedicated `ModuleRunner`** (`createEnvironmentLoader`, `loader.ts:20-58`).
     That runner is cached per root and fetches modules through the special Vite environment
     `__vitest__`, which is defined in `vitest/src/node/plugins/config.ts:66-74`.
   - Consequences (all **[verified]**):
     - The env file is transformed by Vite, so TS and ESM are fine.
     - Modules **outside `node_modules` are inlined**, that is, executed by Vite's `ESModulesEvaluator`. This is
       Vitest's externalization rule in `vitest/src/node/resolver.ts:246-293`: only library modules, which sit under
       `/node_modules/`, are externalized. An inlined CommonJS file fails with `ReferenceError: module is not defined`.
       A static `import x from './binding.node'` fails with `Failed to parse source for import analysis ... .node file format`.
       Use `createRequire(import.meta.url)` for both.
     - The same JS file imported by the env **and** by a test file is **evaluated twice**, once per ModuleRunner,
       so its classes are not identical. Dynamic `import(fileUrl)` goes through the runner too.
       Only Node-native loads, `createRequire` or externalized `node_modules` packages, share one instance.
       Therefore **tests must reach rsdom only through globals**, or rsdom's JS must be loaded via `createRequire`.
     - When the env lives in a real package under `node_modules`, for example `vitest-environment-nativepkg`
       with `"type": "module"`, it is externalized and loaded by native Node `import`. Static imports of a CJS
       binding that `require`s a `.node` then work, in forks and in threads.
     - `teardown` also calls `loader.close()` (`vitest/src/runtime/workers/base.ts:141-144`).
3. **With `experimental.viteModuleRunner: false`** the env is loaded with native `import()` and
   `import.meta.resolve('vitest-environment-<name>')` (`loader.ts:60-74`).
4. **Validation** (`loader.ts:76-106`): the default export must be an object, and `transformMode`, if set, must be `web` or `ssr`.

Practical choices for the lab:
- **Today:** `e2e/react-app/vitest.config.ts` passes the absolute path `../rsdom/js/vitest-environment.js`. This works, but the
  docblock form `@vitest-environment rsdom` will not. Load the `.node` with `createRequire`.
- **For per-file docblocks:** add `"vitest-environment-rsdom": "file:../rsdom"` to the app's devDependencies.
  npm makes a symlink. Vite resolves to the real path outside `node_modules`, so the module is still inlined
  and the `createRequire` rule still applies. Alternatively, publish or pack it so it sits physically in `node_modules`.
- **Test code gotcha (viteEnvironment `client`):** Vite rewrites `new URL('./x', import.meta.url)` in test files relative
  to `self.location` (`http://localhost:3000/...`) **[verified]**. This is irrelevant to env code, which is transformed in `__vitest__`.

---

## 3. When `setup()` runs, and in which worker

Worker flow in v5, for the `forks` and `threads` pools:

| step | where | what |
|---|---|---|
| 1 | `vitest/src/node/pools/poolRunner.ts:200-251` | Spawn a `child_process.fork` (`node/pools/workers/forksWorker.ts:58-64`, `serialization: 'advanced'`) or a `worker_threads` `Worker` (`threadsWorker.ts:41-48`), then send the `'start'` message with `{ environment: { name, options } }`. The whole start time, including env setup, is added to `state.startupTime` / `state.workersSpawned` (`poolRunner.ts:247-250`). |
| 2 | `vitest/src/runtime/workers/init.ts:103-145` | `'start'` calls `worker.setup(setupContext)`, which is `setupBaseEnvironment` (`runtime/workers/forks.ts`, `threads.ts`). |
| 3 | `vitest/src/runtime/workers/base.ts:88-145` | `setupEnv(config.env)` runs, then `loadEnvironment`, then **`environment.setup(globalThis, opts)`**. `_environmentTime` is measured from before loading the module to after `setup()` resolves (`base.ts:102,135`). |
| 4 | `init.ts:147-205` / `runtime/worker.ts:14-83` | `'run'` starts the `prepare` clock (`worker.ts:20`), then calls `runBaseTests`. That sets `state.durations.environment = _environmentTime` (`base.ts:155`). |
| 5 | `vitest/src/runtime/runBaseTests.ts:33-47` | **After** the env: `setupGlobalEnv`. It calls `setupCommonEnv`: defines, then `setSafeTimers()` (captures `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `nextTick` from `globalThis` *now*), then `registerApiGlobally()` if `globals: true` (`runtime/setup-common.ts:10-23`). Next come `__vitest_index__`, the CSS/asset `require` hooks for `client`, and the custom `console` (`setup-node.ts:13-61`). |
| 6 | `runBaseTests.ts:64-110` | For each file: `resetModules` if `isolate`, then `setupFiles` and the test file are imported with `{ invalidate: true }` (`runtime/runners/test.ts:65-81`; `runtime/runner/collect.ts:58-108`), then the tests run. |
| 7 | `init.ts:271-314` | `'stop'` runs `entrypoint.teardown()`, then the env's `teardown(globalThis)` and `loader.close()`. Forks are then SIGTERMed, with SIGKILL after 500 ms (`forksWorker.ts:9,99-101`). Threads get `terminate()`. |

Implications for rsdom:
- **The env cannot rely on Vitest globals.** `typeof global.afterEach === 'undefined'` inside `setup()` **[verified]**.
  Do not install `afterEach` hooks from the env. Leave that to setup files.
- **Do not override the timer family or `console`.** Vitest captures safe timers and replaces `console` right after env setup.
  jsdom and happy-dom leave `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` and `console` as Node's:
  they are commented out of `KEYS` in `vitest/src/integrations/env/jsdom-keys.ts:196-249`.
  `vi.useFakeTimers()` later fakes whatever timers exist on `globalThis` at install time, including `requestAnimationFrame`
  and `performance` if they are present, but not `nextTick` or `queueMicrotask` (`vitest/src/integrations/mock/timers.ts:153-185`).
- **The env must be fully installed before any test module is imported.** It is: React DOM evaluates `canUseDOM` at import time
  (`react/packages/shared/ExecutionEnvironment.js:10-14`).
- **Teardown time is not attributed to any phase.** Pool shutdown is awaited only at the end of the whole run
  (`vitest/src/node/pools/pool.ts:176-198`), so a slow `teardown()` shows up only in wall time.

Worker and runner reuse (who calls `setup()` how many times):
- `isolate: true` (default) gives a new runner per file, so one `setup()` per file **[verified: 5 setups for 5 files in forks and in threads]**.
- `isolate: false`: runners are pooled and reused for the next task only if `isEqualRunner` holds.
  That requires the same pool and project, plus the same env name and deep-equal options
  (`vitest/src/node/pools/pool.ts:165-174,245-254,338-358`).
  `reconfigure()` does **not** re-run `setup()` (`poolRunner.ts:130-136`), so there is one `setup()` per worker **[verified]**.
- `isolate: false` together with `maxWorkers: 1` batches all files with an equal env into one `'run'` request
  (`vitest/src/node/pool.ts:409-429`). vm pools are excluded.
- vm pools force `isolate = false` (`vitest/src/node/config/resolveConfig.ts:690-696`). They call `setupVM()` **per run request, that is, per file**,
  but the env *module* is loaded once per worker (`vitest/src/runtime/workers/vm.ts:35-85`).
- **Difference from v3 (npm dist):** v3 wrapped every `run` in `withEnv()` (`dist/chunks/runBaseTests.*.js`).
  `setup()` ran **after** `setupGlobalEnv`, so globals existed, and `teardown()` ran at the end of each run.
  v5 moved setup to worker start and teardown to worker stop.

---

## 4. Selecting the environment per project or per file

- Config: `test.environment: 'node' | 'jsdom' | 'happy-dom' | 'edge-runtime' | string` (default `'node'`).
  CLI: `--environment=<env>` (`vitest/docs/config/environment.md`; types in `vitest/src/node/types/config.ts:47-49,343-356`).
- Docblock or comment, first match in the file. The regex is `/@(?:vitest|jest)-environment\s+([\w-]+)\b/`,
  and options use `/@(?:vitest|jest)-environment-options\s+(.+)/` with a trailing `*/` stripped
  (`vitest/src/utils/test-helpers.ts:60-80`).
  - **Names only.** `// @vitest-environment ./envs/x.js` does not match, and the file silently uses the config env **[verified]**.
  - `@jest-environment` is accepted as an alias.
  - The docblock is read from the raw file **on the main thread** before scheduling (`getSpecificationsOptions`, `test-helpers.ts:6-26`).
    Files with different envs never share a worker.
- Mixing DOMs in one run: use `test.projects` with a different `environment` per project.
  v4 removed `environmentMatchGlobs` and `poolMatchGlobs` (present in v3 types, absent in v4 and v5 (npm dist)).
- For the benchmark, keep the app's approach: one config, with `DOM_ENV` choosing the environment, so that pool, setup files
  and transforms are identical.

---

## 5. How jsdom and happy-dom populate globals (`populateGlobal`)

Source: `vitest/src/integrations/env/utils.ts` (117 lines) and `jsdom-keys.ts` (255 lines).

**Key selection** (`getWindowKeys`, `utils.ts:5-21`):
- The candidates are `additionalKeys` + `KEYS` + `Object.getOwnPropertyNames(win)`. Only **own** properties count,
  so methods on a `Window.prototype` are not copied unless they are listed in `KEYS` **[verified]**.
- `window`, `self`, `top` and `parent` are skipped (`utils.ts:3`).
- A candidate already present on `global` is kept **only if it is in `KEYS`/`additionalKeys`**. In that case Node's value is overridden.
- `KEYS` = 173 `LIVING_KEYS` + 54 `OTHER_KEYS` = **227 names** (`jsdom-keys.ts:3-188`, `190-253`, `255`).
  - 23 of them exist on Node 22's `globalThis`: `DOMException`, `EventTarget`, `Event`, `CustomEvent`, `MessageEvent`, `Crypto`,
    `Performance`, `Navigator`, `FormData`, `Blob`, `File`, `WebSocket`, all 9 typed arrays, `ArrayBuffer` and `navigator`.
  - That is exactly the `originals` list observed with happy-dom **[verified]**.
- Deliberately *not* in `KEYS` because they conflict with Node: `Headers`, `AbortController`, `AbortSignal`, `URL`,
  `URLSearchParams`, `atob`, `btoa`, the timers, `console`, `toString` (`jsdom-keys.ts:182-187,193-249`).
- Notable names **missing** from `KEYS`: `PointerEvent`, `DataTransfer`, `ResizeObserver`, `IntersectionObserver`, `getSelection`,
  `customElements`, `requestIdleCallback`, `AnimationEvent`, `TransitionEvent`, `DragEvent`, `ClipboardEvent`,
  `CSSStyleDeclaration`, `HTMLDocument` and `event`. They reach `globalThis` only if they are **own** properties of the window object.

**Installation** (`populateGlobal`, `utils.ts:37-117`):
- **Accessors.** Every key becomes `Object.defineProperty(global, key, { get, set, configurable: true })`, non-enumerable (`utils.ts:71-89`).
  - `get` returns a user override if one was set, else the bound function, else `win[key]`.
    Window getters (`document`, `innerWidth`, ...) are therefore evaluated **lazily on every access**.
  - `set(v)` stores the override **and** writes `win[key] = v`. This propagation is a v5 change
    (`vitest/docs/guide/migration/index.md:511-513`; `utils.ts:80-87`).
- **`bindFunctions: true`.**
  - Every non-class function (first letter not uppercase, `isClassLikeName` at `utils.ts:23-25`) is bound to `win` once at populate time.
    Later replacements on `win` are not seen through the global unless they are made via the global setter.
  - Side effect: `typeof win[key]` is evaluated for **every** key during populate, so every window getter runs once at setup **[verified]**.
- **Undefined globals.** **Every key in `KEYS` is defined on `global` even if `win` lacks it.** The global then returns `undefined`,
  but `'XMLHttpRequest' in globalThis === true`. If the key existed in Node, for example `Event`, Node's working value is
  **replaced by `undefined`** **[verified]**. The docs state this too: "a list of all keys that were copied, even if value doesn't
  exist on original object" (`vitest/docs/guide/environment.md`, Custom Environment).
- **Originals.** These are saved as **property descriptors** (`utils.ts:58-69`; v5 change, `vitest/docs/guide/migration/index.md:515-524`).
  This avoids triggering Node's lazy `localStorage` getter. Restore them with `Object.defineProperty`.
- **Aliases.** `global.window = global.self = global.top = global.parent = global` are plain assignments, so they are data properties.
  If `global.global` exists it is set to `global`, and the skip keys are added to the returned `keys` so teardown deletes them (`utils.ts:92-110`).
- **`document.defaultView`.** It is redefined on the document *instance* as a getter returning `global`, **only if it was truthy** (`utils.ts:101-108`).
  This matters for consumers that do `node.ownerDocument.defaultView.HTMLElement`:
  `jest-dom/src/utils.js:50-80`, `dom-testing-library/src/helpers.ts:28-40`.
- **Teardown pattern** used by the builtins: `keys.forEach(k => delete global[k]); originals.forEach((d, k) => Object.defineProperty(global, k, d))`
  (`jsdom.ts:236-243`, `happy-dom.ts:81-85`).

**jsdom env specifics** (`vitest/src/integrations/env/jsdom.ts:177-245`):
- It is constructed with `new JSDOM(html, { url: 'http://localhost:3000', pretendToBeVisual: true, runScripts: 'dangerously', contentType: 'text/html', ...})`.
- `patchAddEventListener` maps a Node `AbortSignal` passed in `addEventListener` options onto jsdom's own (`jsdom.ts:348-395`).
- `catchWindowErrors` turns un-listened window `error` events into `process.emit('uncaughtException')` (`jsdom.ts:8-34`).
- It sets `global.jsdom` and replaces `Request` and `URL` with Blob/FormData-compatible subclasses (`jsdom.ts:231-233,248-288`).

**happy-dom env specifics** (`vitest/src/integrations/env/happy-dom.ts:49-87`):
- It uses `GlobalWindow ?? Window` with `settings.disableErrorCapturing: true`.
- `additionalKeys` = `Request`, `Response`, `MessagePort`, `fetch`, `Headers`, `AbortController`, `AbortSignal`, `URL`,
  `URLSearchParams`, `FormData`, so happy-dom's fetch stack *overrides* Node's.
- Teardown runs `await happyDOM.abort()` and then `close()`.

**Recommendation for rsdom.** There are two viable designs.
- **A.** Build a plain JS "window" object whose **own** properties include every interface and window function rsdom implements,
  then call `populateGlobal(global, win, { bindFunctions: true })`.
  - Pass through Node's own values for the 23 overlapping keys you do not implement (`win.Uint8Array = globalThis.Uint8Array`, ...),
    otherwise they become `undefined`.
  - Expect about 20 ns of accessor overhead per global read.
- **B (preferred for speed).** Install directly on `globalThis`, like happy-dom's `GlobalWindow` idea.
  - Define each interface and function as a writable, configurable data property, after saving the existing descriptor.
  - Set `window`, `self`, `top` and `parent` to `globalThis`, make `document.defaultView` return `globalThis`, and restore everything in `teardown`.
  - Data-property globals cost about 1-2 ns per read versus 18-28 ns for the accessor style (`global-access.mjs`) **[verified]**.
    That is small per access, but `document` and `window` are read constantly by RTL and React.
  - Either way, never define names you do not implement, because feature detection with `in` would be fooled.

---

## 6. What React Testing Library needs from the global

`react-testing-library/src/index.js:9-39`:
- **Auto-cleanup.** `if (typeof afterEach === 'function') afterEach(() => cleanup())`. The fallback is `teardown`.
  Opt out with `RTL_SKIP_AUTO_CLEANUP`.
- **Act environment.** `if (typeof beforeAll === 'function' && typeof afterAll === 'function')`, RTL sets
  `globalThis.IS_REACT_ACT_ENVIRONMENT = true` for the file and restores it afterwards
  (`react-testing-library/src/act-compat.js:7-34`).
- These checks run **when `@testing-library/react` is first evaluated**. Vitest's `afterEach` and `beforeAll` exist as globals
  only with `test.globals: true`, via `registerApiGlobally` (`vitest/src/runtime/setup-common.ts:20-22`;
  `vitest/src/integrations/globals.ts`). The environment does not provide them, and must not.

Observed behaviour **[verified]**:
- `globals: false` and no setup file: the DOM is not cleaned between tests. The second test in a file sees `body.children.length === 1`.
- `globals: true` and `isolate: false`: RTL's module is **cached per worker**, because only setup and test files are invalidated
  (`runtime/runners/test.ts:77-78`; `runBaseTests.ts:65-68` resets modules only when `isolate`).
  Its top-level `afterEach` registration therefore runs only for the first file in each worker, and later files leak DOM.
  With `maxWorkers: 1` this produced `Found multiple elements with the role "button"`.
- Fix: `setupFiles` with `import { cleanup } from '@testing-library/react'; afterEach(() => cleanup())`. Setup files are re-imported
  with `invalidate: true` for every file. `e2e/react-app/src/test/setup.ts` already does this, and also `vi.restoreAllMocks()`.

DOM-side expectations for the env that relate to the global (details in `docs/lab/research/testing-library.md`):
- `window === globalThis` and `document` must exist before React DOM is imported (`canUseDOM`).
- `document.defaultView === globalThis`, and `node instanceof node.ownerDocument.defaultView.HTMLElement`/`SVGElement`/`Node` must hold
  (`jest-dom/src/utils.js:60-80`). The facade classes on `globalThis` must be the ones used to build nodes.
- `globalThis.IS_REACT_ACT_ENVIRONMENT` is a plain global written by RTL. Do not freeze `globalThis` or make unknown globals non-writable.

---

## 7. Pools and config options (v5) and what changed since v3

v5 options. All are top-level and project-level (`vitest/src/node/types/config.ts:351-406`):

| option | v5 default | notes |
|---|---|---|
| `pool` | `'forks'` (`resolveConfig.ts:275`) | `'threads' \| 'forks' \| 'vmThreads' \| 'vmForks'`, or a custom `PoolRunnerInitializer` (`resolveConfig.ts:258-261`) |
| `isolate` | `true` | a new worker per file. Forced to `false` for vm pools (`resolveConfig.ts:690-696`) |
| `maxWorkers` | `availableParallelism() - 1`, or half in watch mode (`vitest/src/utils/workers.ts:3-6`) | number or `'50%'`. **3 on this 4-vCPU box.** The docs say "all available parallelism" (`vitest/docs/config/maxworkers.md`), but the code subtracts 1 |
| `fileParallelism` | `true` | `false` forces `maxWorkers = 1` (`resolveConfig.ts:396-403`) |
| `execArgv` | `[]` | for example `['--cpu-prof', '--cpu-prof-dir=prof']` (`vitest/docs/guide/profiling-test-performance.md`) |
| `vmMemoryLimit` | — | vm pools only |
| `sequence.groupOrder` | 0 | groups run sequentially, each with its own `maxWorkers` (`vitest/src/node/pool.ts:323-452`) |

History (npm dist):
- **v3.2** had `poolOptions.{threads,forks,vmThreads,vmForks}` with `minThreads`, `maxThreads`, `singleThread`, `useAtomics`, `isolate`,
  `execArgv` and `memoryLimit`. It also had top-level `minWorkers` and `maxWorkers`, `poolMatchGlobs` and `environmentMatchGlobs`.
- **v4** rewrote the pools ("pool rework", no tinypool). `test.poolOptions` now only prints
  `` `test.poolOptions` was removed in Vitest 4. All previous `poolOptions` are now top-level options `` (`resolveConfig.ts:263-268`).
  The mapping:

  | v3 | v4/v5 |
  |---|---|
  | `maxThreads`, `maxForks` | `maxWorkers` |
  | `singleThread`, `singleFork` | `maxWorkers: 1, isolate: false` |
  | `poolOptions.*.isolate` | `isolate` |
  | `poolOptions.*.execArgv` | `execArgv` |
  | `poolOptions.vm*.memoryLimit` | `vmMemoryLimit` |
  | `minWorkers`, `useAtomics`, `poolMatchGlobs`, `environmentMatchGlobs` | removed (use `projects`) |
- **v5** made worker and pool ids 1-based. `VITEST_POOL_ID` and `VITEST_WORKER_ID` now range from 1 to N, and
  `TestModule.diagnostic()` gained `concurrencyId` (`vitest/docs/guide/migration/index.md:591-607`).
  It also added `fsModuleCache` (default on), `vitest doctor`, and the percentage `Duration` line.

Pool trade-offs relevant to rsdom (`vitest/docs/config/pool.md`; `vitest/docs/guide/improving-performance.md:105-146`):
- **`forks`** (default): one OS process per worker. Each spawn plus bundle load cost about 172 ms per file here,
  with environment `node` and 8 trivial files **[verified]**.
- **`threads`**: workers are `worker_threads` inside the main Vitest process, at about 147 ms each. `process.chdir` is not available.
  The docs warn that native modules may segfault there (`vitest/docs/guide/common-errors.md:125-145`).
- **`isolate: false`** reuses workers: 236 ms wall for the same 8 files versus 570-671 ms. It is the fastest mode, but tests must tolerate a shared DOM.
- **`vmThreads`/`vmForks`**: one env module per worker and a fresh `setupVM()` context per file. See section 10 for why rsdom should not start here.

---

## 8. Measuring per-phase durations

### 8.1 Per-file fields recorded by the worker

All of these are on the `File` task (`vitest/src/runtime/runner/types.ts:303-357`):

| field | measured where | meaning |
|---|---|---|
| `environmentLoad` | `base.ts:102,135` → `runners/index.ts:101-105` | Import of the env module plus `await setup()`. In vm pools: load + `setupVM` (`vm.ts:42,85`). |
| `prepareDuration` | `worker.ts:20` → `runBaseTests.ts:54` | From the `'run'` message to "runner ready". Covers resolving the runner, `setupGlobalEnv`, coverage start and the snapshot env. Excludes the env in base pools. |
| `setupDuration` / `setupFetchDuration` | `collect.ts:58-72` | Importing `setupFiles`, and the part of that spent waiting on the server for transforms. |
| `collectDuration` / `collectFetchDuration` | `collect.ts:74-108` | Importing the test file graph and running the suite callbacks, and the transform-wait part of it. |
| `result.duration` | runner | All tests and hooks of the file. |
| `importDurations` | `collect.ts:78-81` | Per-module self and total times, collected when `experimental.importDurations.limit > 0`. |

`prepareDuration` and `environmentLoad` are attached to the **first file collected in each run request** and then zeroed
(`vitest/src/runtime/runners/index.ts:98-106`).
- **Pitfall A** **[verified]**: with `isolate: false` and `maxWorkers > 1`, every file is its own run request on a *reused* runner.
  `runBaseTests` re-assigns `state.durations.environment = _environmentTime` each time (`base.ts:155`), so **every file reports the same
  env time** even though `setup()` ran once. The summed `environment` phase is inflated.
  Observed: three files on one worker each reported 393.7 ms.
- **Pitfall B** **[verified]**: with `isolate: false` and `maxWorkers: 1`, all files go in one request, so only the first file carries the env time.
- For env-cost comparisons, either use `isolate: true`, or count env setups in the env itself (a log or a counter).

Pool-level numbers live on the state (`vitest/src/node/state.ts:32-34`, read in `reporters/base.ts:1010-1060`):
- `vitest.state.startupTime`: the summed spawn + bundle + env time across workers (`poolRunner.ts:247-250`).
- `vitest.state.workersSpawned`.

### 8.2 The `Duration` summary line

v5 (`vitest/src/node/reporters/base.ts:726-760`, `vitest/src/node/reporters/durationBreakdown.ts:23-68`):

```
Duration  3.02s (environment 72%, import 19%, tests 7%, transform 2%, worker 1%)     <- [verified]
```

- The leading time is the wall time of the run, `this.end - this.start`.
- The percentages are **shares of the sum of all tracked phases**, which run in parallel workers. They are not shares of the wall time.
- Phases are sorted by time, and phases below 0.5% are dropped. Sub-1% shares print as `1%`.
- Phase definitions, summed over files:
  - `transform` = `setupFetchDuration + collectFetchDuration`, the worker's wait on Vite.
  - `setup` = `setupDuration - setupFetchDuration`
  - `import` = `collectDuration - collectFetchDuration`
  - `tests` = `result.duration`
  - `environment` = `environmentLoad`
  - `worker` = `prepareDuration`
  - `typecheck`
- Explained for users in `vitest/docs/guide/improving-performance.md:3-24`.
  `vitest/docs/guide/reporters.md` and `vitest/docs/guide/profiling-test-performance.md` still show the old absolute format.
- Hints after the summary are controlled by `experimental.diagnostics` (`resolveConfig.ts:1020-1037`; `base.ts:779-1060`):
  - `Environment ... was created N times`
  - `Isolate N workers spawned · ~X startup each`
  - `Import ...`
  - `Transform ...`
  - Disable them with `experimental: { diagnostics: false }` in benchmark runs.

History (npm dist). Phase names changed, so do not compare lines across majors:
- v3.2: `Duration X (transform, setup, collect, tests, environment, prepare)`, absolute ms. Here `transform` was the server-side vite-node total.
- v4.1: `Duration X (transform, setup, import, tests, environment[, typecheck])`, absolute ms. `prepare` was dropped from the line and `collect` was renamed `import`.
- v5.0: percentages. `prepare` returns as `worker`, `transform` becomes worker-side wait, and `import` and `setup` exclude that wait.

### 8.3 Reporters that carry timings

- **JSON reporter** (`vitest/src/node/reporters/json.ts:33-74,108-246`). It is Jest-compatible:
  - Run level: `numTotalTests`, `numPassedTests`, ..., `startTime` (epoch ms), `success`, `snapshot`, `testResults[]`.
  - Per file: `{ name, status, message, startTime, endTime, assertionResults[] }`. `startTime` is the earliest test start, and
    `endTime` is the latest test start plus its duration, so it covers **test execution only**.
  - Per test: `{ ancestorTitles, fullName, title, status, duration, failureMessages, location, meta, tags, benchmarks }`.
  - **It has no environment, setup, import or transform timings** **[verified]**.
  - v5 writes `.vitest/json/output.json` by default instead of stdout. Use `--outputFile.json=path`, or `[['json', { stdout: true }]]`
    (`vitest/docs/guide/migration/index.md:552-563`; `vitest/docs/guide/reporters.md:63-109`).
- **Blob reporter** (`vitest/src/node/reporters/blob.ts:48-112`). It writes `flatted.stringify([version, files, errors, coverage, executionTime, ...])`
  to `.vitest/blob/blob-*.json`. The `files` are full `File` tasks, so all fields from 8.1 are included. Parse it with `flatted`.
- **Custom reporter (recommended).** `docs/lab/research/vitest-env-probes/phase-reporter.js` uses about 30 lines:
  - In `onTestRunEnd(testModules)` it reads `testModule.diagnostic()` (`reported-tasks.ts:558-576,702-760`):
    `environmentSetupDuration`, `prepareDuration`, `collectDuration`, `setupDuration`, `duration`, `heap`, `importDurations`,
    `workerId` and `concurrencyId`.
  - It adds `testModule.task.setupFetchDuration + collectFetchDuration` for transform wait, plus `vitest.state.startupTime` and `workersSpawned`.
  - It writes JSON to `$PHASES_OUT`. Use it with `--reporter=dot --reporter=./phase-reporter.js`.
  - `heap` is filled only with `--logHeapUsage`.
  - `testModule.project.config.environment` shows the *config* env, not a docblock override.

Deeper profiling:
- `execArgv: ['--cpu-prof','--cpu-prof-dir=...']` with `fileParallelism: false` gives one `.cpuprofile` per worker.
  `--prof` does not work with threads (`vitest/docs/guide/profiling-test-performance.md:24-56`).
- `experimental.openTelemetry` emits spans such as `vitest.runtime.environment.import`, `vitest.runtime.environment.setup` and
  `vitest.runtime.environment.teardown` (`loader.ts:69-72,126-133`; `base.ts:124-133,142`).
- `vitest doctor` reruns the suite under candidate configs (forks, threads, vmThreads, vmForks, `isolate: false`, lower `maxWorkers`)
  and reports min-of-3 (`vitest/docs/guide/cli.md:128-162`). It is handy for finding the fastest pool per DOM.
  Note that it would also try swapping jsdom for happy-dom.

---

## 9. Running the suite N times for benchmarking

Recommended protocol. The prototype harness is `docs/lab/research/vitest-env-probes/bench-runner.mjs`.

1. **One fresh `vitest run` process per sample.** Do not loop `startVitest()` in one process, because the in-memory Vite transform
   cache and module state would carry over. Measure the **external wall time** (`spawnSync`) as the primary metric. It includes config
   load and Vite server start, which are about the same for all DOMs. Collect the phase reporter JSON as the secondary breakdown.
2. **Warm-up and N.** Use 1 untimed warm-up and then N ≥ 5 (10 for the final numbers). Report median, min and sd.
   - `fsModuleCache` is **on by default** in v5 and persists transforms under `node_modules/.vitest-cache`
     (`vitest/docs/config/fsmodulecache.md`, `fsmodulecachepath.md`). The warm-up makes the samples warm-cache runs, which is what developers see.
   - For cold numbers, pass `--fsModuleCache=false` or run `vitest --clearCache` before each sample.
   - Optionally set `NODE_COMPILE_CACHE` for every config (`vitest/docs/guide/improving-performance.md:148-158`).
3. **Same pipeline for all DOMs.** Use the same config file and `setupFiles`, `globals: true`, and `viteEnvironment: 'client'` in rsdom.
   That way transforms and the cache are shared, and only `environment` differs. This matches `e2e/react-app/vitest.config.ts` with `DOM_ENV`.
4. **Pin parallelism.** Pass `--maxWorkers=N` explicitly (default 3 here), and add a serial row
   (`--no-file-parallelism`, or `--maxWorkers=1`) to get per-file costs without CPU contention.
   - Contention matters: happy-dom env setup was about 400-800 ms per file under 3 parallel workers.
   - jsdom's import alone is 200-500 ms (`vitest/docs/guide/improving-performance.md:107`).
   - Optionally pin the whole run with `taskset -c 0-3`.
5. **The matrix to run per DOM:**

   | config | why |
   |---|---|
   | `--pool=forks` (`isolate` default true) | the default user experience, with env cost paid per file |
   | `--pool=threads` | tests the N-API addon in worker threads |
   | `--pool=threads --no-isolate` | the fast path, with env cost paid per worker, so per-test DOM speed dominates |
   | `--pool=threads --no-isolate --maxWorkers=1` | serial, the least noisy view of DOM-operation cost |
6. **Quiet output.** Use `--reporter=dot --reporter=./phase-reporter.js` and `experimental.diagnostics: false`. Avoid `verbose` and console spam.
   `--silent` hides test console output; `disableConsoleIntercept: true` (`vitest/src/node/types/config.ts:930`) skips the interception itself.
   Whichever you pick, use the same setting for every DOM.
7. **Validity.** Discard samples with a non-zero exit code. A DOM that fails tests is not "faster". The harness reports and skips these.
   - In-test repetition: `--repeats <n>` repeats every test (`vitest/docs/config/repeats.md`). It is useful to amplify the `tests` phase
     without paying spawn and env costs again, but it changes the RTL cleanup pattern, so treat it as a separate micro-benchmark.
   - For in-process DOM micro-benchmarks, v5's `bench` fixture inside `*.bench.ts` files works (`vitest/docs/guide/benchmarking.md`).
     The file runs inside the configured environment.

Sample (indicative, N=3, 4 small RTL files, warm cache; raw in `results-vitest-5.0.5.txt`):

| config | wall median | Σ environment | Σ import | Σ tests |
|---|---|---|---|---|
| happy-dom forks iso | 2217 ms | 1745 ms | 833 ms | 236 ms |
| jsdom forks iso | 3310 ms | 3633 ms | 795 ms | 787 ms |
| happy-dom threads no-isolate | 1376 ms | 1495 ms* | 186 ms | 194 ms |
| jsdom threads no-isolate | 2072 ms | 3316 ms* | 214 ms | 701 ms |
| happy-dom no-isolate, 1 worker | 1281 ms | 301 ms | 67 ms | 99 ms |

\* inflated by Pitfall A in section 8.1.

Floor with environment `node` (8 trivial files): forks 671 ms, threads 570 ms, threads no-isolate 236 ms.
- With `isolate: true` the per-file cost that rsdom cannot remove is about 150-170 ms of worker spawn, plus re-importing React and RTL
  (about 200-300 ms of `import` per file here).
- rsdom wins in `isolate: true` only through the `environment` phase. In `isolate: false` it wins only through the `tests` phase.

---

## 10. Native addons (`.node`) in Vitest workers: threads vs forks

Node rule: an addon loaded in `worker_threads` must be *context-aware*, meaning initialised once per `napi_env` and not once per process.
- N-API modules registered through `napi_register_module_v1` are context-aware by construction.
- napi-rs exports exactly that symbol (`napi-rs/crates/napi/src/bindgen_runtime/module_register.rs:818`).

napi-rs details that matter:
- **Class constructors are per thread.** They live in a `thread_local!` registry (`module_register.rs:131-133`, `REGISTERED_CLASSES`).
  The comment at `module_register.rs:166-173` states the invariant "ONE `napi_env` per OS thread ... Node's main thread, each
  `worker_threads` worker (its own V8 isolate + env + loop thread)". Class metadata without `napi_value`s is a process-wide
  `RwLock` static (`module_register.rs:79-90,116`).
- **Cleanup hooks.** `napi_register_module_v1` registers a cleanup hook with `napi_add_env_cleanup_hook` for every env
  (`module_register.rs:325-327`). The public APIs are `Env::add_env_cleanup_hook`, `Env::set_instance_data` / `get_instance_data` and
  `Env::adjust_external_memory` (`napi-rs/crates/napi/src/env.rs:1134,1332,1372,440`).

Measured with a 30-line napi-rs 3.x probe that holds a process `static AtomicUsize`, a `thread_local!` counter and a `#[napi]` class
(`docs/lab/research/vitest-env-probes/napi-probe-lib.rs`) **[verified]**:
- `pool: 'threads'`: all workers are **one PID** with different `threadId`s.
  - The process `static` keeps counting across workers (1, 2, 3, 4).
  - The `thread_local` starts fresh per worker.
  - New worker threads re-register the module fine, including under `isolate: true`, with no segfaults.
  - `dlopen` and init take 0.4-0.9 ms per worker, so it is negligible.
- `pool: 'forks'`: one process per worker, so every `static` is fresh.
- The env and the test file get the **same** addon object from `createRequire`, because the CJS cache is per thread.

Design rules for the Rust side:
1. **Keep no per-DOM state in Rust `static`s.** It would be shared and raced by all worker threads of the `threads` pool,
   and it would leak across test files. Put the arena or document store behind an object owned by the JS window,
   or in `thread_local!` / instance data keyed per env. `static` is fine only for immutable tables, such as interned tag names and selector caches,
   and only if they are `Sync`.
2. **Never move `napi_value` or `napi_ref` across threads or envs.**
3. **Free the whole DOM in `teardown()`** with one call that drops the arena. Do not rely on thousands of per-node finalizers.
   - Threads get `worker.terminate()`. Node then tears down that worker's env: it runs the napi cleanup hooks and may run pending
     finalizers, and that time is attributed to no phase.
   - Forks get SIGTERM, whose default action exits without running JS or cleanup hooks, and SIGKILL after 500 ms (`forksWorker.ts:9,99-101`).
   - An explicit O(1) teardown keeps both cases cheap and deterministic.
4. **Report external memory** with `adjust_external_memory` if Rust holds large buffers, so V8's GC heuristics stay sane.
5. **Loading:**
   - Use `createRequire(import.meta.url)('…/rsdom.linux-x64-gnu.node')`, or a CJS loader `index.cjs`, from the env module.
   - Do **not** `import` the `.node` file or the napi-generated CJS `index.js` statically from an env file outside `node_modules`:
     that fails with `Failed to parse source for import analysis ... .node`, or with `module is not defined` **[verified]**.
6. **vm pools**: `setupVM` must return a `vm` context. Objects created by N-API belong to the **main** realm.
   - Inside a `vm` context, `Array.isArray(arr)` is true but `arr instanceof Array` is false, and class instances do not chain to the
     context's `Object.prototype` **[verified, vm-realm.cjs]**.
   - The Vitest docs list the same family of issues for `toStrictEqual` and DOM methods returning arrays (`vitest/docs/config/pool.md`, vmThreads warning).
   - Supporting vm pools properly would mean evaluating the JS facade *inside* each context and creating arrays and objects there
     instead of in Rust. Defer this, and do not offer `setupVM` in v0, so users get a clear error instead of subtle realm bugs.
7. The docs advise `forks` when native modules crash in `threads` (`vitest/docs/guide/common-errors.md:125-145`). rsdom should still
   benchmark `threads`, because it is the fastest non-vm mode and the probe shows napi-rs is safe there.

---

## 11. Pitfalls checklist

- [ ] `viteEnvironment: 'client'` is set. Without it the run fails with `environment rsdom was not defined in the Vite config`.
- [ ] Do not expect `@vitest-environment ./path` docblocks to work. They are silently ignored, so use names (packages) or projects.
- [ ] `options` is the **whole** `environmentOptions` object, or only the docblock options. Read `options.rsdom`.
- [ ] Do not install `afterEach` or other Vitest globals from the env. They do not exist yet.
- [ ] Do not override `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` or `console`. Vitest captures and replaces them after the env.
- [ ] If you use `populateGlobal`, provide values for every `KEYS` entry that exists in Node (`Event`, `EventTarget`, `Blob`, `FormData`,
      typed arrays, `navigator`, ...), or they become `undefined`. Also remember that every `KEYS` name exists as a global even if unimplemented.
- [ ] Interfaces must be **own** properties of the window object passed to `populateGlobal`. Prototype methods are not copied unless they are in `KEYS`.
- [ ] `document.defaultView` must be `globalThis`, and the classes on `globalThis` must be the classes of the created nodes (jest-dom `instanceof` checks).
- [ ] Tests must not import rsdom JS modules directly. The env and the tests run in different ModuleRunners and get different class identities.
      Expose everything via globals, or load the JS via `createRequire`.
- [ ] Use `createRequire` for the `.node` file. Never statically import `.node`, or CJS outside `node_modules`, in the env file.
- [ ] Keep no mutable per-document state in Rust `static`s. The threads pool shares the process.
- [ ] Benchmarks need an explicit `afterEach(cleanup)` setup file, because RTL auto-cleanup breaks under `isolate: false` and without `globals`.
- [ ] Do not compare the `environment` phase across `isolate: false` runs with `maxWorkers > 1` (over-count). Prefer wall time, or count setups.
- [ ] The v5 `Duration` line shows percentages and the JSON reporter has no phases. Use the custom phase reporter or the blob reporter for ms.
- [ ] `fsModuleCache` is on by default. Warm up, or disable it consistently, for every DOM.
- [ ] Teardown time is invisible in the phases. Keep `teardown()` O(1) by dropping the arena.

---

## 12. Probe files

`docs/lab/research/vitest-env-probes/`:

| file | what it is |
|---|---|
| `probe-env.js` | Custom env (happy-dom inside) that logs `module-evaluated`, `setup` and `teardown` with pid, threadId, option keys, `typeof afterEach` and the `populateGlobal` result. Set `PROBE_LOG=/path/log.jsonl`. |
| `native-env.js` | Custom env that loads a napi-rs `.node` via `createRequire` and logs process and thread counters. |
| `napi-probe-lib.rs`, `napi-probe-Cargo.toml` | The 30-line napi-rs probe (napi 3 + napi-derive 3; `cargo build --release` takes about 16 s here). |
| `phase-reporter.js` | Custom reporter that writes absolute per-file phases and pool startup stats to `$PHASES_OUT`. |
| `bench-runner.mjs` | Multi-config, N-run, fresh-process harness: median, min and sd of wall time plus phase sums. |
| `pg-probe.mjs` | `populateGlobal` semantics on a fake window. |
| `global-access.mjs` | Cost of an accessor global versus a data-property global. |
| `vm-realm.cjs` | N-API objects inside a `vm` context (cross-realm). |
| `results-vitest-5.0.5.txt` | Raw outputs of all of the above. |
