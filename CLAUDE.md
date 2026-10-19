# rsdom

A Rust DOM (napi-rs addon + JS facade) meant as a drop-in replacement for jsdom in test environments.

- Read `CONTRIBUTING.md` before changing code: path conventions, how natives are declared (`natives!` blocks,
  no central list), facade conventions, and the invariants in §7 (Rust never calls into JS; JS only memoises
  Rust answers validated by Rust counters).
- Layout: Rust core in `crates/rsdom`, npm package in `packages/rsdom` (`lib/` facade, `test/contract` parity
  suite against jsdom and happy-dom), React app suite in `e2e/react-app`.
- Build before running JS tests: `npm ci && npm run build`. Checks: `npm run lint`, `npm test`,
  `npm run test:fallback`.
- `packages/rsdom/lib/generated/` is written by `crates/rsdom/build.rs`; never edit it by hand.
- Code comments cite `DESIGN §N` (docs/DESIGN.md), lab milestones `M0`-`M9` (docs/lab/ROADMAP.md) and
  `refs/...` upstream paths (`scripts/fetch-refs.sh`).
- Next work is tracked in `docs/ROADMAP.md`; jsdom is the behavioural oracle.
