# oxidom

A Rust DOM (napi-rs addon + JS facade) meant as a drop-in replacement for jsdom in test environments.

- Read `CONTRIBUTING.md` before changing code: path conventions, how natives are declared (`natives!` blocks,
  no central list), facade conventions, and the invariants in §7 (Rust never calls into JS; JS only memoises
  Rust answers validated by Rust counters).
- Layout: Rust core in `crates/oxidom`, npm package in `packages/oxidom` (`lib/` facade, `test/contract` parity
  suite against jsdom and happy-dom), React app suite in `e2e/react-app`.
- Build before running JS tests: `npm ci && npm run build`. Checks: `npm run lint`, `npm test`,
  `npm run test:fallback`, `npm run test:parity` (jsdom's own test suite against `conformance/parity/expectations`;
  needs `scripts/fetch-refs.sh --wpt`; `--update` after a change that moves it, and commit the diff).
  `npm run check` runs all four plus a scoreboard-freshness check. GitHub Actions is disabled for this
  repository, so nothing runs them automatically: run `npm run check` locally before merging.
- Work through `docs/ROADMAP.md`; each item's parity-suite scope is in `conformance/parity/roadmap.yaml`
  (`npm run test:parity -- --item <id>`).
- Several sessions work on roadmap items in parallel: `docs/THREADS.md` says who owns which item, which DESIGN
  section each one uses, and how to merge generated parity files.
- `packages/oxidom/lib/generated/` is written by `crates/oxidom/build.rs`; never edit it by hand.
- Code comments cite `DESIGN §N` (docs/DESIGN.md), lab milestones `M0`-`M9` (docs/lab/ROADMAP.md) and
  `refs/...` upstream paths (`scripts/fetch-refs.sh`).
- jsdom is the behavioural oracle.
