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
#   - npm automation token in ~/.npmrc (npmjs.com -> Access Tokens -> Generate
#     -> Automation), or NODE_AUTH_TOKEN set when running as CI. Do NOT use
#     `npm login --auth-type=web` -- it OVERWRITES the automation token with a
#     2FA-bound web session and the next publish EOTPs on a WebAuthn challenge.
#   - gh CLI authenticated (or GITHUB_TOKEN set)
#
# Reading the result:
#   Every terminal path prints exactly one sentinel as its FINAL line --
#   RELEASE_RESULT=SUCCESS / FAILED / ABORTED -- and the FAILED one is written
#   to stdout AND stderr. Grep for that line. Do NOT judge a run by a trailing
#   `echo "RELEASE_EXIT=$?"` (that reports echo's status) or by the exit code
#   of a pipeline like `./release.sh 1.2.3 | tail` (that reports tail's).
# =============================================================================

set -euo pipefail

# State the failure banner reads back. The ERR and EXIT traps fire from
# arbitrary depth with no way to know where they came from, so the position is
# tracked as it moves rather than reconstructed after the fact.
CURRENT_STEP="pre-flight"
FAIL_MSG=""
ERR_LINE=""
ERR_STATUS=""

# The ERR trap only RECORDS (plus the line it always printed). The banner is
# printed from the EXIT trap instead, so it lands last on every failing path --
# a bare command failing under `set -e`, a fail(), or an `exit 1` that ERR
# never sees at all.
trap 'ERR_STATUS=$?; ERR_LINE=$LINENO; echo -e "\n\033[0;31m  [X] Release failed at line $ERR_LINE (exit code $ERR_STATUS)\033[0m"' ERR

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
step() { CURRENT_STEP="step $1/$TOTAL_STEPS ($2)"; echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  [OK] $1${NC}"; }
# warn() writes to stderr so warnings survive stdout redirects -- e.g. the
# pre-commit path runs `npm run lint:fix >/dev/null`, which would otherwise
# swallow the SKIP_LINT noop notice and silently skip the formatting gate.
warn() { echo -e "${YELLOW}  [!] $1${NC}" >&2; }
# fail() stashes the message so the exit banner can repeat the specific
# remedy; without it the banner could only say "something exited non-zero".
fail() { FAIL_MSG="$1"; echo -e "${RED}  [X] $1${NC}"; exit 1; }

# The failure banner. Two releases read as successes today: a harness reported
# "exit code 0" that was really the status of a trailing
# `echo "RELEASE_EXIT=$?"`, and piping into `tail` reported success for a run
# that had executed ZERO tests, because a pipeline's status is the LAST
# command's. So the banner (a) goes to stdout AND stderr, so redirecting either
# one still captures it, (b) is the final output on every failing path, and
# (c) ends in a RELEASE_RESULT= line to grep for when `$?` cannot be trusted.
# Deliberately uncolored -- this text exists to be read out of a captured log,
# where ANSI escapes are noise.
release_exit_banner() {
  local status="$1"
  local bar="=========================================================================="
  local detail="${FAIL_MSG:-}"
  if [ -z "$detail" ]; then
    detail="  The command at line ${ERR_LINE:-?} exited ${ERR_STATUS:-$status}. See the output above."
  fi
  # The version can legitimately be unresolved here -- a missing or malformed
  # argument fails before VERSION is set -- and a bare "v" in the headline
  # reads as a corrupted banner rather than a missing input.
  local vlabel="v${VERSION:-}"
  [ "$vlabel" = "v" ] && vlabel="(version not resolved)"
  local body
  body=$(printf '%s\n' \
    "" \
    "$bar" \
    "  RELEASE FAILED -- ${vlabel} -- ${CURRENT_STEP}" \
    "$bar" \
    "$detail" \
    "" \
    "  Nothing after ${CURRENT_STEP} ran. Fix the cause above, then re-run" \
    "  './release.sh ${VERSION:-<version>}' -- every step is idempotent." \
    "$bar" \
    "RELEASE_RESULT=FAILED version=${VERSION:-unknown} exit=${status} step=[${CURRENT_STEP}]")
  printf '%s\n' "$body"
  printf '%s\n' "$body" >&2
}

# Installed only after release_exit_banner exists, so an early failure cannot
# call a function that is not defined yet. The trailing `exit $RELEASE_STATUS`
# is load-bearing: a trap that just returns lets the status of the last command
# INSIDE the trap become the script's status, which is exactly the class of
# accident this banner exists to stop.
trap 'RELEASE_STATUS=$?; if [ "$RELEASE_STATUS" -ne 0 ]; then release_exit_banner "$RELEASE_STATUS"; fi; exit $RELEASE_STATUS' EXIT

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so lint-related runs are
# no-ops. Workaround for the MINGW64-ARM64 npm-run-script wrapper that
# segfaults on exit-cleanup (platform-windows.md). NOTE: this repo has no CI
# lint gate (release.yml was dropped when registry publish moved into this
# script), so with SKIP_LINT=1 lint runs NOWHERE for this release -- run
# `npx biome check src/` on a working runner before tagging.
if [ "${SKIP_LINT:-}" = "1" ]; then
  warn "SKIP_LINT=1 -- lint will not run anywhere this release (no CI lint gate exists); run 'npx biome check src/' on a working runner before tagging"
  npm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'npm run $2'"
      return 0
    fi
    command npm "$@"
  }
  pnpm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'pnpm run $2'"
      return 0
    fi
    command pnpm "$@"
  }
fi

TOTAL_STEPS=9

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
    FAIL_MSG="No version argument given. Pass the version to release, e.g. ./release.sh 0.1.0"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

# Pipeline / redirect guard. `./release.sh 1.2.3 | tail -20` reports the exit
# status of `tail`, never of the release -- the same shape that let a
# wsl-test-matrix.sh run which executed ZERO tests read as a pass. The caller's
# command line is not visible from inside the script, but a non-tty stdout is
# the necessary condition for that misread, so flag it up front. The banner is
# written to stdout AND stderr and ends in RELEASE_RESULT= precisely so a run
# captured despite this warning is still unambiguous.
if [ ! -t 1 ]; then
  if [ -p /dev/stdout ]; then
    warn "stdout is a PIPE -- a pipeline's exit status is the LAST command's, not this script's. Run the caller with 'set -o pipefail', read \${PIPESTATUS[0]}, or grep the output for the final 'RELEASE_RESULT=' line."
  else
    warn "stdout is redirected, not a tty -- do not judge this release by a trailing 'echo \$?' (that reports echo's own status). Grep the captured output for the final 'RELEASE_RESULT=' line."
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

# The branch to push to. Every push below used to hardcode `main`, so running
# this from any other branch pushed a STALE local main -- and if that main was
# behind origin, the push was rejected and the release died with a generic
# "git push failed" while the actual commit sat unpushed on the real branch.
# Resolve it once, here, from the branch actually checked out.
RELEASE_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ -z "$RELEASE_BRANCH" ] || [ "$RELEASE_BRANCH" = "HEAD" ]; then
  fail "Could not determine the current branch (detached HEAD?). Check out a branch and re-run."
fi

# Releasing from a non-default branch tags a commit that is not on the default
# branch, which is almost always a mistake -- but not always (hotfix branches
# are real), so warn rather than block. RELEASE_BRANCH_OK=1 silences it.
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
if [ "$RELEASE_BRANCH" != "$DEFAULT_BRANCH" ] && [ "${RELEASE_BRANCH_OK:-}" != "1" ]; then
  warn "Releasing from '$RELEASE_BRANCH', not '$DEFAULT_BRANCH' -- the tag will point at a commit that may not be on $DEFAULT_BRANCH. Set RELEASE_BRANCH_OK=1 to silence."
fi

# ---- Optional: commit + push tracked changes before the release ----
# When a commit message is passed as $2 and the tree is dirty, run the pre-
# commit checklist (lint:fix + tsc + unit tests) and then commit only TRACKED
# changes (`git add -u`) -- never sweep untracked files, which can include
# .env / secrets. Push, then fall through to the existing clean-tree path
# below. The integration matrix runs again in step 2; we skip it here to
# keep the pre-commit fast (matrix gates the tag, not the feature commit).
if [ "$IS_CI" != "true" ] && [ -n "$PRE_COMMIT_MSG" ] && [ -n "$(git status --porcelain)" ]; then
  CURRENT_STEP="pre-release commit (before step 1)"
  echo -e "${CYAN}Committing tracked changes before release...${NC}"
  npm run lint:fix >/dev/null || fail "lint:fix failed -- fix and re-run"
  npx tsc --noEmit         || fail "tsc failed -- fix type errors and re-run"
  npm test                 || fail "unit tests failed -- fix and re-run"
  git add -u || fail "git add -u failed"
  if [ -z "$(git diff --cached --name-only)" ]; then
    info "Nothing staged after lint:fix -- skipping pre-release commit"
  else
    git commit -m "$PRE_COMMIT_MSG" || fail "git commit failed"
    git push origin "$RELEASE_BRANCH" \
      || fail "git push of the pre-release commit to '$RELEASE_BRANCH' was REJECTED (usually non-fast-forward: another session pushed while this ran).

  No tag exists yet, so the recovery is only the branch:

      git fetch origin
      git log --oneline HEAD..origin/${RELEASE_BRANCH}    # what landed meanwhile
      git rebase origin/${RELEASE_BRANCH}
      ./release.sh ${VERSION} \"${PRE_COMMIT_MSG}\"

  The commit itself already exists locally -- the re-run sees a clean tree and
  will not duplicate it."
    info "Pre-release commit pushed to $RELEASE_BRANCH: $PRE_COMMIT_MSG"
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
  echo "  7. Publish to MCP Registry"
  echo "  8. Verify"
  echo "  9. Post-publish smoke"
  echo ""
  if [ -t 0 ]; then
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Aborted."
      # A decline exits 0, which is indistinguishable from a completed release
      # by exit code alone. The sentinel is what tells the two apart in a
      # captured log, so every terminal path emits exactly one.
      echo "RELEASE_RESULT=ABORTED version=${VERSION}"
      exit 0
    fi
  elif [ "${RELEASE_YES:-}" = "1" ]; then
    info "RELEASE_YES=1 -- proceeding without confirmation"
  else
    # stdin is not a tty: honor a piped reply (`echo y |` proceeds, `echo n |`
    # aborts) instead of releasing unconditionally -- a piped decline used to
    # be read and honored before the tty-gate. -t 5 bounds the wait so an
    # open-but-silent pipe can't hang the release.
    REPLY=""
    IFS= read -r -t 5 -n 1 REPLY || true
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      info "Non-interactive stdin -- proceeding on piped 'y'"
    else
      fail "Non-interactive stdin and no 'y' confirmation -- pipe 'y' or set RELEASE_YES=1 to release non-interactively."
    fi
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
# In CI, this step is intentionally skipped: GitHub Actions runners don't
# have WSL, and release.yml does not spin up PG service containers. The
# matrix is now a LOCAL pre-tag gate only -- if you tag without running
# scripts/wsl-test-matrix.sh first, you're publishing without PG-version
# coverage (unit tests + prepublishOnly are still the CI gates).
if [ "$IS_CI" = "true" ]; then
  info "CI mode -- integration matrix is a local-only pre-tag gate, skipping in CI"
elif command -v wsl >/dev/null 2>&1 && wsl --list --quiet 2>/dev/null | tr -d '\0' | grep -q Ubuntu; then
  # Translate a Git Bash drive-letter prefix (/c/, /d/, ...) into the WSL
  # equivalent (/mnt/c/, /mnt/d/, ...). Hardcoding /c/ broke contributors
  # working from any other drive.
  WSL_REPO="$(echo "$SCRIPT_DIR" | sed -E 's|^/([a-z])/|/mnt/\1/|')"
  MSYS_NO_PATHCONV=1 wsl -d Ubuntu -u root bash "${WSL_REPO}/scripts/wsl-test-matrix.sh" \
    || fail "Integration matrix failed against PG17/PG18 -- aborting release"
  info "Integration matrix passed (PG17 + PG18)"
elif [ "${REQUIRE_MATRIX:-}" = "1" ]; then
  # REQUIRE_MATRIX=1 turns the "WSL not detected" warning into a hard fail.
  # Default is still warn-only so contributors without WSL can tag -- the
  # unit tests + prepublishOnly are the CI gates, and the matrix is a
  # pre-tag-best-effort on top. Set REQUIRE_MATRIX=1 when you specifically
  # want a real-PG-major signal before cutting a release.
  fail "REQUIRE_MATRIX=1 set but WSL Ubuntu not detected -- run scripts/wsl-test-matrix.sh manually or install WSL"
else
  warn "WSL Ubuntu not detected -- skipping integration matrix (set REQUIRE_MATRIX=1 to fail-fast; run scripts/wsl-test-matrix.sh manually before tagging)"
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

# server.json is published to the MCP Registry in step 7 and must match the
# tag's version. This runs UNCONDITIONALLY (not inside the bump else above)
# so a resume run where package.json was bumped in a prior invocation still
# syncs server.json -- otherwise mcp-publisher tries to re-publish the
# previous version and gets 400 "cannot publish duplicate version".
# Idempotent: the inner if skips the write when server.json is already in
# sync, so a clean re-run produces no working-tree dirt.
if [ -f server.json ]; then
  CURRENT_SERVER_VERSION=$(jq -r '.version' server.json 2>/dev/null || echo "")
  if [ "$CURRENT_SERVER_VERSION" != "$VERSION" ]; then
    jq --arg v "$VERSION" '.version = $v | .packages[0].version = $v' server.json > server.tmp
    mv server.tmp server.json
    info "server.json synced to $VERSION"
  fi
fi

# Promote CHANGELOG's [Unreleased] section to this version.
#
# This script used to bump package.json and server.json but never touch
# CHANGELOG.md, so shipped releases stayed filed under [Unreleased] and the
# file silently drifted -- 0.7.0 shipped with no entry at all, and 0.8.0 and
# 0.9.0 both shipped with their notes still sitting under [Unreleased].
#
# Idempotent on three axes, because this runs on resume too:
#   1. Already has a [$VERSION] heading -> no-op.
#   2. No [Unreleased] heading at all -> no-op (nothing to promote).
#   3. [Unreleased] present but EMPTY -> no-op. Promoting it would leave an
#      empty version heading, which is worse than no heading: it reads as
#      "this release changed nothing" rather than "nobody wrote it down".
if [ -f CHANGELOG.md ]; then
  if grep -q "^## \[${VERSION}\]" CHANGELOG.md; then
    info "CHANGELOG already has a [${VERSION}] heading - skipping"
  elif ! grep -q "^## \[Unreleased\]" CHANGELOG.md; then
    warn "CHANGELOG.md has no [Unreleased] heading -- not promoting anything. Add release notes by hand."
  else
    # Body = every non-blank line between [Unreleased] and the next `## [`.
    # `|| true` is load-bearing: grep exits 1 when it matches nothing, which is
    # exactly the empty-[Unreleased] case, and under `set -e` that aborted the
    # whole release here -- making the `warn` branch below unreachable for the
    # one condition it was written to handle.
    UNRELEASED_BODY=$(awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md | { grep -v '^[[:space:]]*$' || true; } | head -1)
    if [ -z "$UNRELEASED_BODY" ]; then
      warn "CHANGELOG [Unreleased] is empty -- releasing v${VERSION} with no release notes."
    else
      # Insert the version heading right after [Unreleased], leaving
      # [Unreleased] in place and empty for the next cycle. `done` guards
      # against a second match later in the file.
      awk -v ver="$VERSION" -v d="$(date +%Y-%m-%d)" '
        !seen && /^## \[Unreleased\]/ { print; print ""; print "## [" ver "] - " d; seen=1; next }
        { print }
      ' CHANGELOG.md > CHANGELOG.tmp && mv CHANGELOG.tmp CHANGELOG.md
      info "CHANGELOG: [Unreleased] promoted to [${VERSION}]"
    fi
  fi
fi

# =============================================================================
# Step 4: Commit, tag, and push
# =============================================================================
step 4 "Commit, tag, and push"

if [ "$IS_CI" = "true" ]; then
  info "CI mode - skipping commit/tag/push (already tagged)"
else
  BUMP_FILES="package.json package-lock.json"
  [ -f server.json ] && BUMP_FILES="$BUMP_FILES server.json"
  # CHANGELOG.md is bumped above (Unreleased -> this version) and must ride
  # the same commit, or the promotion is left as uncommitted working-tree dirt.
  [ -f CHANGELOG.md ] && BUMP_FILES="$BUMP_FILES CHANGELOG.md"
  if [ -n "$(git status --porcelain $BUMP_FILES 2>/dev/null)" ]; then
    git add $BUMP_FILES
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  RELEASE_SHA=$(git rev-parse HEAD)
  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    # Re-entrancy guard. A run that dies between `git tag` and `git push`
    # leaves the tag behind; the operator then fetches and rebases or resets --
    # exactly what the push-rejected remedy below tells them to do -- which
    # rewrites or discards the commit that tag points at. On the re-run the tag
    # is an ORPHAN, and "tag already exists" used to be treated as success:
    # npm would publish THIS working tree while step 6 cut the GitHub release
    # from a commit that is on no branch. Two artifacts, two different trees,
    # one version number.
    TAG_COMMIT=$(git rev-parse "v${VERSION}^{}")
    if [ "$TAG_COMMIT" != "$RELEASE_SHA" ]; then
      if git merge-base --is-ancestor "$TAG_COMMIT" "$RELEASE_SHA"; then
        DRIFT="behind HEAD (still an ancestor -- commits were added after the tag was created)"
      else
        DRIFT="NOT an ancestor of HEAD -- its commit was rewritten or discarded (rebase / reset / amend) and is now orphaned"
      fi
      # Whether the tag also reached origin decides which recovery is safe, so
      # look it up instead of making the operator guess. Best-effort: a network
      # failure here must not replace the real error with a git one.
      TAG_ON_ORIGIN=$(git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | awk '{print $1}' || true)
      if [ -n "$TAG_ON_ORIGIN" ]; then
        REMOTE_STATE="  origin ALSO has tag v${VERSION}, at ${TAG_ON_ORIGIN}. Anything built from it
  downstream (GitHub release, MCP Registry entry, anyone who fetched) already
  points at the wrong commit -- prefer cutting the next patch version over
  moving a tag that is already public."
      else
        REMOTE_STATE="  origin does NOT have tag v${VERSION} yet, so nothing downstream has seen it
  -- deleting and recreating it locally is safe."
      fi
      fail "Local tag v${VERSION} points at ${TAG_COMMIT}, but the commit about to be
  released is ${RELEASE_SHA}. The tag is ${DRIFT}.

${REMOTE_STATE}

  Recover, EITHER move the tag onto the commit being released:

      git tag -d v${VERSION}
      git push origin :refs/tags/v${VERSION}   # ONLY if origin has it, per above
      ./release.sh ${VERSION}

  OR -- the safe option once the tag is public -- leave the bad tag alone and
  cut the next patch version instead:

      ./release.sh <next-patch>

  Refusing to publish npm from ${RELEASE_SHA} while the GitHub release would be
  cut from ${TAG_COMMIT}."
    fi
    info "Tag v${VERSION} already exists and points at the commit being released"
  else
    # Annotated (-a) so --follow-tags below picks it up; lightweight tags are
    # ignored by --follow-tags and would silently fail to publish.
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # --follow-tags pushes only annotated tags reachable from the pushed commits,
  # not every local tag. Avoids accidentally publishing dangling experimental
  # tags that happen to be lying around.
  # Tag-drift safety: refuse to push if origin already has a tag at this name
  # pointing to a different commit (rewound tag elsewhere, parallel release race).
  # Without this check, `git push --follow-tags` SILENTLY skips updating the
  # tag on origin (the tag exists, no fast-forward happens). The main push
  # reports success, but origin's tag stays at the old SHA -- and the later
  # `gh release create` step then creates a GitHub release linked to that
  # stale commit while npm carries the new one.
  # No stderr suppression and an explicit failure branch: under `set -euo
  # pipefail` a failing ls-remote (network blip, auth) inside the command
  # substitution would otherwise kill the script with only the generic
  # ERR-trap line and git's actual error discarded.
  ORIGIN_TAG_SHA=$(git ls-remote --tags origin "refs/tags/v${VERSION}" | awk '{print $1}') \
    || fail "Could not query origin for tag v${VERSION} (network or auth failure -- see git's error above). Resolve and re-run."
  if [ -n "$ORIGIN_TAG_SHA" ]; then
    LOCAL_TAG_SHA=$(git rev-parse "v${VERSION}")
    if [ "$ORIGIN_TAG_SHA" != "$LOCAL_TAG_SHA" ]; then
      fail "Tag v${VERSION} exists on origin at $ORIGIN_TAG_SHA but local tag points to $LOCAL_TAG_SHA -- resolve the drift before re-running"
    fi
  fi

  git push origin "$RELEASE_BRANCH" --follow-tags \
    || fail "git push of '$RELEASE_BRANCH' was REJECTED. The recurring cause is non-fast-forward:
  another session pushed to '$RELEASE_BRANCH' while this release was running.

  Nothing after this ran -- npm publish, the GitHub release and the MCP Registry
  publish have NOT happened. The bump commit and the annotated tag v${VERSION}
  DO exist locally, and the tag MAY ALSO have reached origin: this push is not
  atomic, so a rejected branch ref does not roll back an accepted tag ref.
  Check both before rewriting anything:

      git fetch origin
      git log --oneline HEAD..origin/${RELEASE_BRANCH}     # what landed meanwhile
      git ls-remote --tags origin refs/tags/v${VERSION}    # empty => tag is local-only

  Then EITHER replay the bump commit on top of what landed:

      git tag -d v${VERSION}
      git push origin :refs/tags/v${VERSION}   # ONLY if ls-remote found it
      git rebase origin/${RELEASE_BRANCH}
      ./release.sh ${VERSION}

  OR, if the bump commit is the only local work and rebasing is messier than
  letting the script rebuild it, discard it:

      git tag -d v${VERSION}
      git push origin :refs/tags/v${VERSION}   # ONLY if ls-remote found it
      git reset --hard origin/${RELEASE_BRANCH}
      ./release.sh ${VERSION}

  Delete the tag in EITHER path: rebase and reset both move the commit out from
  under it, and the re-run refuses to proceed on a tag that no longer matches
  the commit being released."
  info "Pushed $RELEASE_BRANCH + tag v${VERSION} to origin"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"
# Three publish paths, picked by environment:
#   1. IS_CI=true                    -> WE are CI. Do the publish (NODE_AUTH_TOKEN
#                                       is set; --provenance for sigstore).
#   2. IS_CI=false + release.yml     -> CI will publish on the tag we just pushed.
#      exists with CI publish path      Watch `gh run watch` for that run and
#                                       verify via `npm view`. Workstation MUST
#                                       NOT also publish -- stale ~/.npmrc fails
#                                       E404, valid one races CI for the same
#                                       version. CI is authoritative.
#   3. IS_CI=false + no CI publish   -> Workstation IS the publisher. Try locally
#      path                             with EOTP retry for fresh WebAuthn sessions.
PUBLISHED_VERSION=$(npm view "@yawlabs/postgres-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm - skipping"
  # Resume-path safety: a prior interrupted run may have published but never
  # observed `gh run watch` to completion. Later CI steps (smoke test, MCP
  # Registry publish, attestation upload) could have failed silently. Look
  # up the most recent Release run for this tag and warn if its conclusion
  # was non-success. Best-effort -- if the tag isn't on origin yet or the
  # run isn't visible, the warn just doesn't fire.
  if [ "$IS_CI" != "true" ] && [ -f ".github/workflows/release.yml" ]; then
    RESUME_TAG_SHA=$(git rev-parse "v${VERSION}^{}" 2>/dev/null || echo "")
    if [ -n "$RESUME_TAG_SHA" ]; then
      RESUME_CONCLUSION=$(gh run list --workflow=Release --event=push --commit="$RESUME_TAG_SHA" --limit=1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo "")
      if [ -n "$RESUME_CONCLUSION" ] && [ "$RESUME_CONCLUSION" != "success" ]; then
        warn "Prior CI Release run for v${VERSION} ended with conclusion='$RESUME_CONCLUSION' (not 'success'). A post-publish step (smoke test, MCP Registry publish, attestation) may have failed silently. Inspect: gh run list --workflow=Release --commit=$RESUME_TAG_SHA --limit=3"
      fi
    fi
  fi
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/postgres-mcp@${VERSION} to npm (with provenance)"
elif [ -f ".github/workflows/release.yml" ] && grep -q "npm publish\|NODE_AUTH_TOKEN" .github/workflows/release.yml; then
  info "CI release.yml fires on v* tag push -- workstation hands off to CI"
  # Verify the tag landed on origin BEFORE looking up the CI run. A local
  # push that succeeded but the remote rejected (protected-tag rule, network
  # blip) would otherwise dead-end in the lookup loop with a misleading
  # "Push may have failed" error 62s later. ls-remote is one round-trip --
  # cheap relative to gh run watch.
  if ! git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -q "refs/tags/v${VERSION}$"; then
    fail "Tag v${VERSION} not visible on origin. Step 4's 'git push --follow-tags' may have failed silently (protected-tag rule, network blip), or the tag was deleted between push and now. Re-run step 4."
  fi
  TAG_SHA=$(git rev-parse "v${VERSION}^{}")
  RUN_ID=""
  # Exponential backoff: 2+4+8+16+32 = 62s upper bound on GitHub's
  # tag-push -> actions queue visibility lag. Cheap relative to the CI run
  # itself (~6 min on aws-mcp).
  DELAY=2
  for i in 1 2 3 4 5; do
    RUN_ID=$(gh run list --workflow=Release --event=push --commit="$TAG_SHA" --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
    [ -n "$RUN_ID" ] && break
    sleep $DELAY
    DELAY=$((DELAY * 2))
  done
  if [ -z "$RUN_ID" ]; then
    fail "Could not find Release workflow run for tag v${VERSION} (commit $TAG_SHA) after 62s of polling. The actions queue may be backed up; check 'gh run list --limit 5' and rerun the script to retry."
  fi
  info "Watching CI Release run $RUN_ID"
  gh run watch "$RUN_ID" --exit-status || fail "CI Release run $RUN_ID failed. See 'gh run view $RUN_ID --log-failed'."
  # CI is authoritative on the publish itself -- if `gh run watch` exited 0,
  # the package is live on npm regardless of how long the registry mirror
  # takes to surface it. Verification here is a courtesy check; warn rather
  # than fail when the mirror lags (existing memory: lag can exceed a minute).
  NPM_NOW=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    NPM_NOW=$(npm view "@yawlabs/postgres-mcp@${VERSION}" version 2>/dev/null || echo "")
    [ "$NPM_NOW" = "$VERSION" ] && break
    sleep 6
  done
  if [ "$NPM_NOW" = "$VERSION" ]; then
    info "Published @yawlabs/postgres-mcp@${VERSION} via CI Release run $RUN_ID"
  else
    DISPLAY_NPM="${NPM_NOW:-(not found)}"
    warn "CI Release run $RUN_ID succeeded but npm registry still shows '$DISPLAY_NPM' for @yawlabs/postgres-mcp@${VERSION} after 60s. Likely registry propagation lag -- verify with 'npm view @yawlabs/postgres-mcp@${VERSION}' in a minute. Publish is authoritative on CI's exit code."
  fi
else
  # Workstation IS the publisher (no CI fallback). Retry only on EOTP/EAUTH/OTP
  # for fresh WebAuthn sessions; fail fast on everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      # Do NOT recommend `npm login --auth-type=web` here: it OVERWRITES the
      # automation token in ~/.npmrc with a WebAuthn-bound session, and the
      # next publish then EOTPs on a challenge no script can answer. E401/E404
      # means the automation token is missing or wrong -- restore it.
      fail "npm publish failed (non-OTP error -- see output above).

  If the error was E401 or E404, the automation token in ~/.npmrc is dead.
  npm answers an UNAUTHORIZED PUT with 404, not 401, so 'could not be found
  or you do not have permission' here almost always means 'not authorized'
  -- the package is fine. Confirm which it is:

      npm whoami          # E401 => the token is dead

  Fix: mint a NEW automation token (npmjs.com -> Access Tokens -> Generate
  -> Automation), then write these two lines to ~/.npmrc:

      @yawlabs:registry=https://registry.npmjs.org/
      //registry.npmjs.org/:_authToken=npm_YOURTOKEN

  Do NOT run 'npm login --auth-type=web'. It OVERWRITES the automation token
  with a 2FA-bound web session; the next publish then EOTPs on a WebAuthn
  challenge, and any CI sharing that token starts failing too."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  info "Published @yawlabs/postgres-mcp@${VERSION} to npm (workstation)"
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
# Step 7: Publish to the Official MCP Registry
# =============================================================================
# Downstream catalogs (Glama, PulseMCP, mcpservers.org) auto-source from the
# Official MCP Registry; publishing here is what makes the new version visible
# to them. server.json was already bumped in step 3 so the version matches the
# tag.
step 7 "Publish to MCP Registry"

if [ ! -f server.json ]; then
  info "No server.json -- not an MCP server, skipping registry publish"
else
  # mcp-publisher binary cached at ~/.local/bin. Pinned to "latest" upstream;
  # if the registry's CLI introduces a breaking change, the next release will
  # surface it. The OS/arch detection handles Linux, macOS, and Git Bash on
  # Windows (MINGW/MSYS uname -s starts with "mingw" / "msys").
  MP="${MCP_PUBLISHER:-$HOME/.local/bin/mcp-publisher}"
  if ! [ -x "$MP" ]; then
    info "mcp-publisher not found at $MP -- downloading"
    mkdir -p "$(dirname "$MP")"
    OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS_RAW" in mingw*|msys*|cygwin*) OS=windows ;; *) OS="$OS_RAW" ;; esac
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    TMP=$(mktemp -d)
    curl -sL -o "$TMP/mp.tar.gz" \
      "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      || fail "Failed to download mcp-publisher (${OS}/${ARCH})"
    tar xzf "$TMP/mp.tar.gz" -C "$TMP" || fail "Failed to extract mcp-publisher tarball"
    if [ -f "$TMP/mcp-publisher.exe" ]; then
      mv "$TMP/mcp-publisher.exe" "$MP"
    else
      mv "$TMP/mcp-publisher" "$MP"
    fi
    rm -rf "$TMP"
    chmod +x "$MP" 2>/dev/null || true
  fi

  # OIDC auth (used by the old release.yml) only works inside Actions; locally
  # we use a GitHub PAT via `login github -token <PAT>`. The PAT needs read:org
  # for YawLabs so the registry can verify org membership for the
  # io.github.YawLabs/* namespace.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  # Track which source supplied the token so a login failure names the thing
  # the operator actually controls instead of an env var they never set.
  TOKEN_SOURCE="env"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    MCP_REGISTRY_TOKEN="$(gh auth token 2>/dev/null || true)"
    TOKEN_SOURCE="gh-cli"
  fi
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset and 'gh auth token' returned nothing -- set a GitHub PAT with read:org for YawLabs, or 'gh auth login' first (or run '$MP login github' once interactively to cache the session)."
  fi
  # stdout stays quiet; stderr passes through so mcp-publisher's own
  # diagnostic isn't hidden behind the generic fail message.
  if ! "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null; then
    if [ "$TOKEN_SOURCE" = "gh-cli" ]; then
      fail "mcp-publisher login failed using the gh CLI session token (MCP_REGISTRY_TOKEN was unset). The gh token likely lacks read:org for YawLabs -- run 'gh auth refresh -h github.com -s read:org' and re-run."
    else
      fail "mcp-publisher login failed -- check MCP_REGISTRY_TOKEN scopes (needs read:org for YawLabs)."
    fi
  fi
  "$MP" publish \
    || fail "mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not. Retry the step (re-run the script) once the cause is identified."
  info "Published to MCP Registry"
fi

# =============================================================================
# Step 8: Verify
# =============================================================================
step 8 "Verify"

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
# Step 9: Post-publish smoke
# =============================================================================
step 9 "Post-publish smoke"

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
# Counterpart to the FAILED banner and the last line of a successful run. Only
# reachable when every step above ran, so a caller that cannot trust `$?`
# (pipeline, trailing echo) can grep for this and get a true answer.
echo "RELEASE_RESULT=SUCCESS version=${VERSION}"
