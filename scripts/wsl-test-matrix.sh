#!/usr/bin/env bash
# Runs the integration suite against every Postgres major version this WSL
# Ubuntu has clusters for. Reports pass/fail per version. Exits non-zero if
# any version fails.
#
#   wsl -d Ubuntu -u root bash /mnt/c/path/to/postgres-mcp/scripts/wsl-test-matrix.sh
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
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >/dev/null
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
  if DATABASE_URL="postgres://postgres:postgres@localhost:${PORT}/postgres_mcp_test" \
     POSTGRES_MCP_INTEGRATION=1 npm run --silent test:integration 2>&1 | tail -20; then
    RESULTS+=("PG${V}: PASS")
  else
    RESULTS+=("PG${V}: FAIL")
    EXIT=1
  fi
done < <(pg_lsclusters -h | awk '$4=="online"{print $1, $2, $3}')

echo
echo "=============================================="
echo "  Matrix summary"
echo "=============================================="
printf '  %s\n' "${RESULTS[@]}"
exit $EXIT
