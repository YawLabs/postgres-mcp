#!/bin/bash
# =============================================================================
# Release Script - Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    - full release from local machine
#   ./release.sh                  - CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version - each step is idempotent.
#
# Prerequisites:
#   - Node.js 20+ and npm installed
#   - npm authenticated (npm whoami) or NODE_AUTH_TOKEN set
#   - gh CLI authenticated (or GITHUB_TOKEN set)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  [X] Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Output uses ASCII status markers ([OK] / [!] / [X]) instead of Unicode
# check/cross/bang glyphs. The Unicode variants render as mojibake under
# Windows ConPTY when the active codepage races with UTF-8 output, and the
# corrupted bytes then get copy-pasted into bug reports.
step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  [OK] $1${NC}"; }
warn() { echo -e "${YELLOW}  [!] $1${NC}"; }
fail() { echo -e "${RED}  [X] $1${NC}"; exit 1; }

TOTAL_STEPS=8

# ---- Resolve version + optional pre-release commit message ----
VERSION="${1:-}"
PRE_COMMIT_MSG="${2:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode - version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version> [\"commit message\"]"
    echo "  e.g. ./release.sh 0.1.0"
    echo "       ./release.sh 0.1.0 \"feat: add foo\"   # commits tracked changes first"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

# ---- Optional: commit + push tracked changes before the release ----
# When a commit message is passed as $2 and the tree is dirty, run the pre-
# commit checklist (lint:fix + tsc + unit tests) and then commit only TRACKED
# changes (`git add -u`) -- never sweep untracked files, which can include
# .env / secrets. Push, then fall through to the existing clean-tree path
# below. The integration matrix runs again in step 2; we skip it here to
# keep the pre-commit fast (matrix gates the tag, not the feature commit).
if [ "$IS_CI" != "true" ] && [ -n "$PRE_COMMIT_MSG" ] && [ -n "$(git status --porcelain)" ]; then
  echo -e "${CYAN}Committing tracked changes before release...${NC}"
  npm run lint:fix >/dev/null || fail "lint:fix failed -- fix and re-run"
  npx tsc --noEmit         || fail "tsc failed -- fix type errors and re-run"
  npm test                 || fail "unit tests failed -- fix and re-run"
  git add -u || fail "git add -u failed"
  if [ -z "$(git diff --cached --name-only)" ]; then
    info "Nothing staged after lint:fix -- skipping pre-release commit"
  else
    git commit -m "$PRE_COMMIT_MSG" || fail "git commit failed"
    git push origin main           || fail "git push failed -- resolve and re-run"
    info "Pre-release commit pushed: $PRE_COMMIT_MSG"
  fi
fi

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} - resuming"
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first (or pass \"commit message\" as the 2nd arg)."
    fi
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + tests"
  echo "  2. Build"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, tag, and push"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Verify"
  echo "  8. Post-publish smoke"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# =============================================================================
# Step 1: Lint
# =============================================================================
step 1 "Lint"

npm run lint || fail "Lint failed"
info "Lint passed"

# =============================================================================
# Step 2: Test
# =============================================================================
step 2 "Test"

npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "Unit tests passed"

# Integration matrix against PG17 + PG18, run inside WSL Ubuntu (Windows-only
# until the matrix runner is portable to native Linux/Mac). Aborts the release
# on failure -- it's the only place the matrix has a real consumer.
#
# In CI, this step is intentionally skipped: the github-actions release.yml
# workflow gates the publish on integration.yml (PG17/18 service containers)
# completing successfully, so we don't need a redundant local-equivalent run
# inside the runner.
if [ "$IS_CI" = "true" ]; then
  info "CI mode -- integration matrix gated by integration.yml workflow, skipping local WSL run"
elif command -v wsl >/dev/null 2>&1 && wsl --list --quiet 2>/dev/null | tr -d '\0' | grep -q Ubuntu; then
  # Translate a Git Bash drive-letter prefix (/c/, /d/, ...) into the WSL
  # equivalent (/mnt/c/, /mnt/d/, ...). Hardcoding /c/ broke contributors
  # working from any other drive.
  WSL_REPO="$(echo "$SCRIPT_DIR" | sed -E 's|^/([a-z])/|/mnt/\1/|')"
  MSYS_NO_PATHCONV=1 wsl -d Ubuntu -u root bash "${WSL_REPO}/scripts/wsl-test-matrix.sh" \
    || fail "Integration matrix failed against PG17/PG18 -- aborting release"
  info "Integration matrix passed (PG17 + PG18)"
else
  warn "WSL Ubuntu not detected -- skipping integration matrix (run scripts/wsl-test-matrix.sh manually before tagging)"
fi

# =============================================================================
# Step 3: Bump version
# =============================================================================
step 3 "Bump version to $VERSION"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} - skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

# =============================================================================
# Step 4: Commit, tag, and push
# =============================================================================
step 4 "Commit, tag, and push"

if [ "$IS_CI" = "true" ]; then
  info "CI mode - skipping commit/tag/push (already tagged)"
else
  if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
    git add package.json package-lock.json
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists"
  else
    # Annotated (-a) so --follow-tags below picks it up; lightweight tags are
    # ignored by --follow-tags and would silently fail to publish.
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # --follow-tags pushes only annotated tags reachable from the pushed commits,
  # not every local tag. Avoids accidentally publishing dangling experimental
  # tags that happen to be lying around.
  git push origin main --follow-tags
  info "Pushed to origin"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"

PUBLISHED_VERSION=$(npm view "@yawlabs/postgres-mcp@${VERSION}" version 2>/dev/null || echo "")

if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm - skipping"
else
  if [ "$IS_CI" = "true" ]; then
    npm publish --access public --provenance
  else
    npm publish --access public
  fi
  info "Published @yawlabs/postgres-mcp@${VERSION} to npm"
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists - skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG"
  info "GitHub release created"
fi

# =============================================================================
# Step 7: Verify
# =============================================================================
step 7 "Verify"

# Registry propagation can lag a few seconds after publish succeeds. Mirror the
# CI smoke-test retry loop in release.yml (five attempts, 5s apart) instead of
# a single sleep-then-check that flakes on a slow registry.
NPM_VERSION=""
for i in 1 2 3 4 5; do
  NPM_VERSION=$(npm view "@yawlabs/postgres-mcp@${VERSION}" version 2>/dev/null || echo "")
  if [ "$NPM_VERSION" = "$VERSION" ]; then
    break
  fi
  sleep 5
done

if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/postgres-mcp@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION - may still be propagating)"
fi

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

if [ "$IS_CI" = "true" ]; then
  ATTEST=$(npm view "@yawlabs/postgres-mcp@${VERSION}" dist.attestations.provenance.predicateType 2>/dev/null || echo "")
  if [ -n "$ATTEST" ]; then
    info "provenance attestation: $ATTEST"
  else
    warn "no provenance attestation found on v${VERSION} (expected in CI publish)"
  fi
fi

# =============================================================================
# Step 8: Post-publish smoke
# =============================================================================
step 8 "Post-publish smoke"

# Exercise the published tarball end to end. `npm view` in step 7 only checks
# the registry metadata, which can show the right version even when the
# tarball or its dependencies aren't installable -- and CDN edges desync
# enough that a real `npx`/install probe catches things `npm view` misses.
if [ -x "${SCRIPT_DIR}/scripts/post-publish-smoke.sh" ]; then
  if "${SCRIPT_DIR}/scripts/post-publish-smoke.sh" "$VERSION"; then
    info "post-publish smoke: passed"
  else
    warn "post-publish smoke failed -- investigate before announcing v${VERSION}"
  fi
else
  warn "scripts/post-publish-smoke.sh not found or not executable -- skipping smoke"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/postgres-mcp"
echo -e "  git: https://github.com/YawLabs/postgres-mcp/releases/tag/v${VERSION}"
echo ""
