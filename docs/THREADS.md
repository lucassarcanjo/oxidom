# Parallel threads

Several Claude Code sessions work on `docs/ROADMAP.md` items at the same time, one item per session, each on its own
branch, all tagged `rsdom-parity`. This file is the contract between them. Everything in `CLAUDE.md` and
`CONTRIBUTING.md` still applies.

## Who owns what

| thread | roadmap item (`roadmap.yaml` id) | branch | DESIGN section | status |
| --- | --- | --- | --- | --- |
| shadow-root | ShadowRoot + `attachShadow`, without retargeting (`shadow-root`) | `parity/shadow-root` | §22 | done |
| history | Session history traversal (`history`) | `parity/history` | §23 | done |
| observers | No-op observers and scrolling APIs (`observers`) | `parity/observers` | §24 | done |
| ranges | Range comparison and stringification, then live mutation (`ranges`) | `parity/ranges` | §25 | done |
| quick-wins | Web Storage named properties (`storage`), FileReader (`file-api`), `createEvent` (`events`), in that order | `parity/quick-wins` | §26, §27, §28 | done |
| selection | Selection backed by real Ranges (`selection`) | `parity/selection` | §29 | done |
| computed-values | Computed-value fidelity (`computed-values`) | `claude/project-thread-8t2nkv` | §30 | values and `:heading()` merged; cssstyle serialization quirks, `calc()` left |
| jsdom-api | Stage 2: `JSDOM` class (`jsdom-api`), Vitest `environmentOptions.jsdom`, Jest environment, VM pools, types | `claude/project-thread-8t2nkv` | §31-§34 | Stage 2 merged except the `JSDOM` class's "Left" list |
| cssom | CSSOM rule objects (`cssom`) | `claude/project-thread-8t2nkv` | §35 | done |
| forms | Forms remainder (`forms`) | `claude/project-thread-8t2nkv` | §36 | done |
| reflection | Reflected IDL attributes and ARIAMixin (`reflection`) | `claude/project-thread-8t2nkv` | §37 | done |
| xml | XML documents, XMLSerializer, DOMParser for XML types (`xml`) | `claude/project-thread-8t2nkv` | §38 | done |
| xpath | XPath (`xpath`) | `claude/project-thread-8t2nkv` | §39 | done |
| geometry | DOMRect and the remaining Window members (`geometry`) | `claude/project-thread-8t2nkv` | §40 | in review |

A thread works inside its item. Something it needs that belongs to another item goes to the coordinator (the session
that created the threads) instead of into the PR. Small enablers (an exported helper, an atom) are fine when called
out in the PR body.

## Shared files

These files are touched by every thread. Keep each edit small and append-only where possible.

- `lib/index.cjs` area list and install order: append your module; do not reorder.
- `lib/window.cjs`, `lib/events.cjs`, `lib/dom.cjs`: add members in a block of their own, not interleaved with others.
- `data/atoms/`: a new `NN-<item>.txt` file rather than edits to an existing one.
- `docs/DESIGN.md`: only your reserved section (plus a one-line pointer elsewhere if needed).
- `docs/ROADMAP.md`: only your item's line.
- `README.md`: only facts your item changes; the parity percentage and library count are taken from the generated
  summaries at merge time.
- `conformance/parity/expectations/*.yaml`, `conformance/parity/results/summary.md`, `e2e/libraries/results/*`:
  generated. Never merge them by hand (below).

## Getting into main

GitHub Actions is disabled; the local gate is the only gate. One PR per item (or per sub-item for quick-wins).

1. `git fetch origin main && git merge origin/main` (no rebase or force push on a pushed branch).
2. Generated files in conflict: take main's version (`git checkout --theirs <file>`), finish the merge, rebuild
   (`npm run build`), then regenerate: `npm run test:parity` first. A regression is a bug to fix (yours, or a bad
   interaction with what just landed), never something to record. Then `npm run test:parity -- --update` over the
   whole suite (no pattern, no `--item`) and `node e2e/libraries/aggregate.mjs` if the study changed.
3. `npm run check` must pass end to end.
4. Open the PR (or push to it) with the check results in the body: each step's counts, parity files as expected,
   regressed and progressed.
5. Merge right away (squash, with `expectedHeadSha`). If main moved since step 1, go back to step 1: the parity
   expectations of two items that both moved files only compose after a fresh run.
6. Update your row's status here in the same PR when the item is done.

## Measuring

`npm run test:parity -- --item <id>` while working; the scoreboard (`conformance/parity/results/summary.md`) shows the
item's gap and main causes. An item is done when its gap is 0, or every remaining entry has a reason that names a
cause outside the item.
