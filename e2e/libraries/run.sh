#!/usr/bin/env bash
# Re-runs the real-world library compatibility study (about 2 minutes). Needs the rsdom release addon
# (packages/rsdom/native/*.node; run `npm run build` in rsdom/ if it is missing). Runs one Vitest process at a time (maxWorkers 2).
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules/vitest ] || npm ci --no-audit --no-fund
node run.mjs          # tests/ with and without shims, diagnostics/  -> results/raw/*
node census.mjs       # static API census                          -> results/census.json
node aggregate.mjs    # rollup + root-cause matching               -> results/libs.json, results/summary.md
