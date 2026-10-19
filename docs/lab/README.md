# Lab record

rsdom started in a private research repository, rsdom-lab, as an experiment: can a DOM implemented in Rust beat
jsdom and happy-dom as a Vitest environment? The answer was yes, and the code moved here. These files are kept as
the record of how it was built, because code comments cite them:

| file | what |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | lab milestones M0-M9 with acceptance criteria and status (comments say "ROADMAP M6", "M9 review") |
| [`status/`](status) | per-area implementation reports: A selectors and CSS, B events and forms, C window, environment, benchmarks |
| [`research/`](research) | notes on how jsdom, happy-dom/linkedom, React DOM, Testing Library and Vitest environments work, and Node-API performance |

They are not kept up to date. Paths in them were rewritten to this repository's layout; the probe scripts,
traces and raw study data they mention stayed in rsdom-lab.
