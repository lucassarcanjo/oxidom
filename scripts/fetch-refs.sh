#!/usr/bin/env bash
# Shallow-clones the upstream sources rsdom is measured against into refs/ (gitignored), at the exact
# versions the packages pin. Code comments cite paths like `refs/jsdom/lib/jsdom/living/...`; they resolve
# against these checkouts.
#
#   scripts/fetch-refs.sh            jsdom only (enough for scripts/gen-interfaces.mjs, conformance/*)
#   scripts/fetch-refs.sh --all      also happy-dom, vitest, dom-testing-library, react (reading material)
#
# RSDOM_REFS overrides the destination (default: <repo>/refs).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${RSDOM_REFS:-$root/refs}"
mkdir -p "$dest"

clone() { # name repo tag
  if [ -d "$dest/$1/.git" ]; then
    echo "refs/$1: present ($(git -C "$dest/$1" describe --tags 2>/dev/null || echo unknown))"
    return
  fi
  git clone --quiet --depth 1 --branch "$3" "https://github.com/$2.git" "$dest/$1"
  echo "refs/$1: $2@$3"
}

clone jsdom jsdom/jsdom v30.1.3
if [ "${1:-}" = "--all" ]; then
  clone happy-dom capricorn86/happy-dom v21.0.3
  clone vitest vitest-dev/vitest v5.0.5
  clone dom-testing-library testing-library/dom-testing-library v10.4.2
  clone react facebook/react v19.3.1
fi
