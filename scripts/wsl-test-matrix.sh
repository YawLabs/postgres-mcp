#!/usr/bin/env bash
# Runs the integration suite against every Postgres major version this WSL
# Ubuntu has clusters for. Reports pass/fail per version. Exits non-zero if
# any version fails.
#
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -u root bash \
#     /mnt/c/path/to/postgres-mcp/scripts/wsl-test-matrix.sh
#
# The MSYS_NO_PATHCONV=1 prefix is REQUIRED when invoking from Git Bash on
# Windows, and its absence fails silently in the worst way. Git Bash rewrites
# a Unix-shaped argument bound for a native .exe before wsl.exe sees it, so
# `/mnt/c/...` arrives as `C:/Users/<you>/scoop/apps/git/<ver>/mnt/c/...` and
# bash reports "No such file or directory" -- having run no tests at all.
# Invoking from PowerShell or a real Linux shell needs no prefix.
#
# Do NOT pipe this script into `tail`/`head` to trim its output. The pipeline's
# exit status is the LAST command's, so a failing matrix (or the path failure
# above) reports success and a red run reads as green. Redirect to a file and
# grep it instead.
#
# Assumes wsl-pg-setup.sh has already been run.
set -uo pipefail

REPO_DST=/root/postgres-mcp
# Derive REPO_SRC from this script's location so any contributor can run it.
# Script lives at <repo>/scripts/wsl-test-matrix.sh, so go one dir up.
REPO_SRC="$(cd "$(dirname "$0")/.." && pwd)"

rsync -a --delete \
  --exclude=node_modules --exclude=dist --exclude=.git \
  "${REPO_SRC}/" "${REPO_DST}/"

cd "${REPO_DST}"
# Re-install when the lockfile CHANGES, not merely when node_modules is absent.
# The old `[ ! -d node_modules ]` guard cached the install forever, so a branch
# that changed a dependency was silently tested against the PREVIOUS branch's
# node_modules. That is a false-result generator in both directions: it produced
# a red matrix on all three majors when the MCP SDK went v1 -> v2 (TS2307, the
# new packages were simply not there), and it would just as happily go green
# against a dependency the branch had actually removed.
LOCK_STAMP=".npm-ci-lock-stamp"
LOCK_HASH="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo "  installing dependencies (lockfile changed or node_modules absent)"
  npm ci --no-audit --no-fund >/dev/null || { echo "npm ci FAILED"; exit 1; }
  printf '%s' "$LOCK_HASH" > "$LOCK_STAMP"
fi

service postgresql start >/dev/null 2>&1 || true

declare -a RESULTS
EXIT=0

while read -r V _ PORT _; do
  [ -z "${V:-}" ] && continue
  echo
  echo "=============================================="
  echo "  PostgreSQL ${V} on port ${PORT}"
  echo "=============================================="
  # Capture full output to a temp log so a failure can dump the whole thing.
  # Piping straight to `tail -20` discards earlier failing-test names when the
  # final lines are summary noise, leaving the operator with no way to map a
  # FAIL back to a specific test without re-running.
  LOG="$(mktemp)"
  if DATABASE_URL="postgres://postgres:postgres@localhost:${PORT}/postgres_mcp_test" \
     POSTGRES_MCP_INTEGRATION=1 POSTGRES_MCP_DESTRUCTIVE_TESTS=1 npm run --silent test:integration >"${LOG}" 2>&1; then
    tail -20 "${LOG}"
    RESULTS+=("PG${V}: PASS")
  else
    echo "--- PG${V} FAILED: full test output below ---"
    cat "${LOG}"
    echo "--- end PG${V} output ---"
    RESULTS+=("PG${V}: FAIL")
    EXIT=1
  fi
  rm -f "${LOG}"
done < <(pg_lsclusters -h | awk '$4=="online"{print $1, $2, $3}')

echo
echo "=============================================="
echo "  Matrix summary"
echo "=============================================="
printf '  %s\n' "${RESULTS[@]}"
exit $EXIT
