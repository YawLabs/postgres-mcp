#!/usr/bin/env bash
# Runs the integration suite against every Postgres major version this WSL
# Ubuntu has clusters for. Reports pass/fail per version. Exits non-zero if
# any version fails -- and also if a cluster is not online, if a major
# wsl-pg-setup.sh installs (15, 17, 18) has no cluster at all, or if nothing
# was tested: an empty matrix used to exit 0 and read as a pass.
# MATRIX_EXPECTED_MAJORS overrides the expected list (space-separated; empty
# turns that one check off).
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

LOCK_STAMP=".npm-ci-lock-stamp"

# No `set -e` here (the loop below must survive a failing cluster), so the two
# commands that decide WHICH tree gets tested are checked by hand: a failed
# rsync leaves the previous run's source in place, and a failed cd runs the
# suite wherever this happened to start. Either would be reported as this
# tree's matrix. The lock stamp is excluded because --delete removes anything
# the source lacks, which made the npm ci cache below miss on every run.
rsync -a --delete \
  --exclude=node_modules --exclude=dist --exclude=.git --exclude="${LOCK_STAMP}" \
  "${REPO_SRC}/" "${REPO_DST}/" \
  || { echo "rsync of ${REPO_SRC} to ${REPO_DST} FAILED -- refusing to test a stale tree"; exit 1; }

cd "${REPO_DST}" || { echo "cd ${REPO_DST} FAILED"; exit 1; }
# dist is excluded from the sync and the build only adds files, so a test whose
# source was deleted or renamed would keep running from its old compiled copy.
# Every cluster rebuilds it (test:integration starts with the build).
rm -rf dist
# Re-install when the lockfile CHANGES, not merely when node_modules is absent.
# The old `[ ! -d node_modules ]` guard cached the install forever, so a branch
# that changed a dependency was silently tested against the PREVIOUS branch's
# node_modules. That is a false-result generator in both directions: it produced
# a red matrix on all three majors when the MCP SDK went v1 -> v2 (TS2307, the
# new packages were simply not there), and it would just as happily go green
# against a dependency the branch had actually removed.
LOCK_HASH="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo "  installing dependencies (lockfile changed or node_modules absent)"
  npm ci --no-audit --no-fund >/dev/null || { echo "npm ci FAILED"; exit 1; }
  printf '%s' "$LOCK_HASH" > "$LOCK_STAMP"
fi

# A failed start is not fatal here: the checks below report every cluster that
# did not come up, by name, which says more than this command's exit status.
service postgresql start >/dev/null 2>&1 || true

declare -a RESULTS=()
EXIT=0
# Majors that have a cluster at all, online or not.
SEEN_MAJORS=""

while read -r V NAME PORT STATUS _; do
  [ -z "${V:-}" ] && continue
  SEEN_MAJORS="${SEEN_MAJORS} ${V}"
  # Every cluster is read, not only the online ones: a cluster that is down
  # (PG15 failing to start, say) used to be filtered out before the loop, so
  # the matrix went green on the majors that were left.
  if [ "${STATUS:-}" != "online" ]; then
    RESULTS+=("PG${V}: FAIL (cluster ${NAME} is ${STATUS:-in an unknown state}, not online -- NOT TESTED)")
    EXIT=1
    continue
  fi
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
done < <(pg_lsclusters -h | awk '{print $1, $2, $3, $4}')

# A major the setup script installs but that has no cluster here is a hole in
# the matrix, not a smaller matrix: PG15 is the only one that selects the
# pre-1.11 pg_stat_statements columns (see wsl-pg-setup.sh).
for M in ${MATRIX_EXPECTED_MAJORS-15 17 18}; do
  case " ${SEEN_MAJORS} " in
    *" ${M} "*) ;;
    *)
      RESULTS+=("PG${M}: FAIL (no cluster for this major -- NOT TESTED; run scripts/wsl-pg-setup.sh)")
      EXIT=1
      ;;
  esac
done

echo
echo "=============================================="
echo "  Matrix summary"
echo "=============================================="
# Nothing tested is a failure, never a pass: no cluster at all, pg_lsclusters
# missing or failing, or an expected-majors list emptied on a bare machine.
if [ "${#RESULTS[@]}" -eq 0 ]; then
  echo "  NO PostgreSQL cluster was tested (pg_lsclusters listed none) -- FAIL"
  echo "  Run scripts/wsl-pg-setup.sh, then check 'pg_lsclusters'."
  exit 1
fi
printf '  %s\n' "${RESULTS[@]}"
exit $EXIT
