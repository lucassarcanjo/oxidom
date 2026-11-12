#!/usr/bin/env bash
# Re-runs the whole API surface census. Needs e2e/react-app/node_modules (npm ci in app/) and the oxidom release addon
# (packages/oxidom/native/*.node; `npm run build` in oxidom/ if missing). Each DOM is probed in its own Node process.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules/webidl2 ] || npm install --no-audit --no-fund
node parse-idl.mjs
for dom in jsdom happy-dom oxidom; do node probe.mjs "$dom"; done
node analyze.mjs
