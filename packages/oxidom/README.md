# oxidom

A DOM for Node.js test environments, implemented in Rust. It's meant as a drop-in replacement for jsdom: change one
word of configuration and run the same tests, faster.

> **Preview.** oxidom runs an unmodified React 19 + Testing Library suite and passes 99.6% of what jsdom passes in
> jsdom's own test suite. `<script src>` / `<iframe src>` loading, layout and synchronous XMLHttpRequest
> aren't supported yet.

Prebuilt binaries ship for Linux x64/arm64 (glibc and musl), macOS x64/arm64 and Windows x64. Node.js 22+.

## Vitest

```bash
npm install --save-dev oxidom vitest-environment-oxidom
```

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'oxidom', // was: 'jsdom'
  },
})
```

A config written for Vitest's jsdom environment works unchanged. `test.environmentOptions.jsdom` (`url`, `html`,
`userAgent`, `pretendToBeVisual`, `console`, ...) is read the way Vitest reads it, and the `jsdom` global is there.
oxidom's own options go in `test.environmentOptions.oxidom` (`{ url, html }`) and take precedence over the `jsdom` ones.
The VM pools work too. For TypeScript, use `types: ["oxidom/vitest-globals"]` where you had `vitest/jsdom`.

## Jest

```bash
npm install --save-dev oxidom jest-environment-oxidom
```

Set `testEnvironment: 'oxidom'`. It's a port of `jest-environment-jsdom`: `testEnvironmentOptions`, the
`@jest-environment-options` docblock and fake timers work the same. Two differences: scripts and inline `on*` handlers
don't run, and arrays, promises and errors that oxidom creates come from Node's realm, so `instanceof Array` and
`toThrow(TypeError)` on them don't hold.

## Plain Node

```js
const { createWindow } = require('oxidom');

const { document } = createWindow({ url: 'https://example.test/' });
document.body.innerHTML = '<button class="primary">Save</button>';
document.querySelector('button.primary').textContent; // 'Save'
```

Or the jsdom API, unchanged:

```js
const { JSDOM } = require('oxidom');

const dom = new JSDOM('<!DOCTYPE html><p>Hello</p>', { url: 'https://example.test/', pretendToBeVisual: true });
dom.window.document.querySelector('p').textContent; // 'Hello'
```

`JSDOM` takes jsdom's options and has `serialize()`, `reconfigure()`, `getInternalVMContext()`, `JSDOM.fragment()`,
`JSDOM.fromFile()` and `JSDOM.fromURL()`. `includeNodeLocations` and subresource loading aren't supported yet.

## License

MIT
