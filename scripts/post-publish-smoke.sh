#!/usr/bin/env bash
# Post-publish smoke test: install @yawlabs/postgres-mcp@<version> from the
# npm registry into a clean tmp dir, invoke the bin, confirm it reports the
# expected version. Use after a release to verify the published artifact
# actually runs end-to-end.
#
# Usage:
#   ./scripts/post-publish-smoke.sh             # uses repo's package.json version
#   ./scripts/post-publish-smoke.sh 0.6.16      # explicit version
#
# Why this script exists: the post-release smoke used to be ad-hoc bash
# one-liners. One had `TMP=$(mktemp -d); cd "$TMP"; npm init -y; npm install
# @yawlabs/postgres-mcp@VER`. Under wsl-from-Windows interop the `$(mktemp -d)`
# substitution silently captured an empty string, `cd ""` was a no-op (bash
# documents empty arg as success), so the script ran in cwd -- which happened
# to be the repo. `npm init -y` then rewrote the repo's own package.json with
# auto-inferred fields and the flattened tree of whatever sat in node_modules.
# The `${TMP:?...}` guard below aborts immediately if mktemp returned empty
# (or unset), so the same shape can't bite again. Verified 2026-05-18.

set -euo pipefail

PKG="@yawlabs/postgres-mcp"
BIN="postgres-mcp"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  VERSION=$(node -p "require('${SCRIPT_DIR}/../package.json').version")
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $VERSION (expected X.Y.Z)" >&2
  exit 1
fi

TMP=$(mktemp -d)
# The :? expansion aborts with the message if $TMP is unset OR empty. Without
# it, `cd ""` is a silent bash no-op and the smoke test would land in cwd --
# disastrous when cwd is a real project (see header comment).
cd "${TMP:?mktemp -d returned empty -- refusing to run npm in cwd}"

trap 'rm -rf "$TMP"' EXIT

echo "  -> installing ${PKG}@${VERSION} into ${TMP}"
npm init -y >/dev/null
npm install --no-save "${PKG}@${VERSION}" >/dev/null

echo "  -> invoking ${BIN} version"
GOT=$(./node_modules/.bin/"${BIN}" version 2>&1 | tail -1)

if [ "$GOT" = "$VERSION" ]; then
  echo "  ok smoke test passed: ${PKG}@${VERSION} reports ${GOT}"
else
  echo "  FAIL smoke test: expected ${VERSION}, got [${GOT}]" >&2
  exit 1
fi
