#!/usr/bin/env bash
# Shallow-clones the upstream sources rsdom is measured against into refs/ (gitignored), at the exact
# versions the packages pin. Code comments cite paths like `refs/jsdom/lib/jsdom/living/...`; they resolve
# against these checkouts.
#
#   scripts/fetch-refs.sh            jsdom only (enough for scripts/gen-interfaces.mjs, conformance/api-surface)
#   scripts/fetch-refs.sh --wpt      also web-platform-tests at the commit jsdom pins, blob-filtered and sparse
#                                    (~300 MB; conformance/parity and conformance/wpt run it)
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

# The WPT commit jsdom 30.1.3 pins (refs/jsdom/test/web-platform-tests/tests submodule); conformance/wpt/lib.mjs
# (WPT_COMMIT) must name the same one.
WPT_COMMIT=2971340498805350babb6c167e0df98eaa380f98
fetch_wpt() {
  local wpt="$dest/wpt"
  if [ -d "$wpt/.git" ] && [ "$(git -C "$wpt" rev-parse HEAD 2>/dev/null)" = "$WPT_COMMIT" ]; then
    echo "refs/wpt: present ($WPT_COMMIT)"
    return
  fi
  if [ ! -d "$wpt/.git" ]; then
    git init --quiet "$wpt"
    git -C "$wpt" remote add origin https://github.com/web-platform-tests/wpt.git
    git -C "$wpt" config extensions.partialClone origin
    git -C "$wpt" config remote.origin.promisor true
    git -C "$wpt" config remote.origin.partialclonefilter blob:none
  fi
  git -C "$wpt" sparse-checkout init --no-cone
  # Directories the selection reads (conformance/wpt/select.mjs adds single helper files it needs on top).
  printf '%s\n' /resources/ /common/ /dom/ /domparsing/ /domxpath/ /encoding/ /FileAPI/ /css/cssom/ \
    /css/selectors/ /css/support/ /custom-elements/ /shadow-dom/ /uievents/ /html/dom/ /html/semantics/ \
    /html/syntax/ /html/resources/ /html/infrastructure/ /html/editing/ /html/interaction/ /html/webappapis/ \
    /selection/ /xhr/ /webstorage/ /images/ /fonts/ /interfaces/ > "$wpt/.git/info/sparse-checkout"
  git -C "$wpt" fetch --quiet --depth 1 --filter=blob:none origin "$WPT_COMMIT"
  git -C "$wpt" checkout --quiet "$WPT_COMMIT"
  echo "refs/wpt: web-platform-tests@$WPT_COMMIT (sparse)"
}

if [ "${1:-}" = "--wpt" ] || [ "${1:-}" = "--all" ]; then
  fetch_wpt
fi
if [ "${1:-}" = "--all" ]; then
  clone happy-dom capricorn86/happy-dom v21.0.3
  clone vitest vitest-dev/vitest v5.0.5
  clone dom-testing-library testing-library/dom-testing-library v10.4.2
  clone react facebook/react v19.3.1
fi
