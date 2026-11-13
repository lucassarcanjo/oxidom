# Changelog

All three packages (`oxidom`, `vitest-environment-oxidom`, `jest-environment-oxidom`) share one version.

## 0.1.0 (2026-11-13)

First preview on npm.

- A DOM implemented in Rust with a JS facade. It passes 99.6% of the subtests jsdom passes in jsdom's own test
  suite, all 20 libraries of the real-library study (jsdom: 18) and a 90-test React 19 + Testing Library suite.
- `vitest-environment-oxidom` (`environment: 'oxidom'`) reads `environmentOptions.jsdom` like Vitest's jsdom
  environment and supports the VM pools.
- `jest-environment-oxidom` (`testEnvironment: 'oxidom'`) is a port of `jest-environment-jsdom`.
- The jsdom API: `JSDOM`, `serialize()`, `reconfigure()`, `getInternalVMContext()`, `JSDOM.fragment()`,
  `JSDOM.fromFile()`, `JSDOM.fromURL()`.
- Prebuilt binaries for Linux x64/arm64 (glibc and musl), macOS x64/arm64 and Windows x64. Requires Node.js 22+.
- Not supported yet: loading `<script src>` and `<iframe src>`, layout, synchronous XMLHttpRequest,
  `includeNodeLocations`. Every known difference from jsdom is in [docs/MIGRATING.md](docs/MIGRATING.md).
