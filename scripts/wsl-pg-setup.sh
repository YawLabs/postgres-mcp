#!/usr/bin/env bash
# Configures a WSL Ubuntu install with PostgreSQL 15, 17 and 18 ready for the
# integration test matrix. Run as root inside WSL:
#
#   wsl -d Ubuntu -u root bash /mnt/c/path/to/postgres-mcp/scripts/wsl-pg-setup.sh
#
# Installs from the PGDG apt repo (Ubuntu's default ships PG16 only).
# pg_createcluster auto-assigns ports (17 -> 5432, 18 -> 5433, 15 -> 5434 or
# whatever is free); wsl-test-matrix.sh reads them back from pg_lsclusters.
# Idempotent -- safe to re-run.
set -euo pipefail

# 17 and 18 are the current GA majors. 15 is here for COLUMN COVERAGE, not
# recency: pg_stat_statements renamed blk_read_time -> shared_blk_read_time in
# 1.11 (PG17), and pg_top_queries carries a branch for each. With only 17/18
# in the matrix the pre-1.11 branch is never selected, so a typo in those
# column names would only ever surface for a user on PG15/16.
PG_VERSIONS=(15 17 18)

apt-get install -y -qq curl ca-certificates gnupg >/dev/null

if [ ! -f /etc/apt/trusted.gpg.d/postgresql.gpg ]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
fi
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb http://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
fi
apt-get update -qq

# DEV/CI ONLY: this WSL setup script is purpose-built for the integration test
# matrix. Purges the Ubuntu-default PG16 if present so port 5432 is free for
# PG17. Do NOT run this on a host that uses PG16 for anything you care about --
# the apt purge takes the cluster, its config, and /var/lib/postgresql/16 with it.
if dpkg -l | grep -q '^ii  postgresql-16 '; then
  service postgresql stop || true
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq postgresql-16 postgresql-contrib-16
  rm -rf /var/lib/postgresql/16 /etc/postgresql/16
fi

for V in "${PG_VERSIONS[@]}"; do
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    "postgresql-${V}" "postgresql-contrib-${V}"
  # HypoPG (hypothetical-index extension) -- best effort. PGDG usually ships
  # it within a release of a new major; if it's not yet packaged for this
  # version, the integration test for hypothetical_indexes falls through to
  # exercising the "extension not installed" error path instead.
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "postgresql-${V}-hypopg" \
    || echo "  postgresql-${V}-hypopg not available -- HypoPG tests will skip"
done

# When multiple PG versions are installed in the same dpkg pass, the postinst
# auto-cluster hook can skip creation. Create explicitly if missing.
for V in "${PG_VERSIONS[@]}"; do
  if ! pg_lsclusters -h | grep -qE "^${V}\s+main\s"; then
    pg_createcluster "${V}" main --start
  fi
done

service postgresql start

for V in "${PG_VERSIONS[@]}"; do
  PGCONF=/etc/postgresql/${V}/main/postgresql.conf
  HBACONF=/etc/postgresql/${V}/main/pg_hba.conf

  # DEV/CI ONLY: bind to all interfaces and accept md5 password auth from any
  # source. Safe inside WSL (the network namespace is host-local) but lethal as
  # a production template -- do not copy this stanza outside this matrix script.
  sed -i "s/^#listen_addresses.*/listen_addresses = '*'/" "$PGCONF"
  grep -q '0.0.0.0/0' "$HBACONF" || echo 'host all all 0.0.0.0/0 md5' >> "$HBACONF"

  # pg_stat_statements needs to be PRELOADED -- `CREATE EXTENSION` alone fails
  # with "pg_stat_statements must be loaded via shared_preload_libraries".
  # Without this the whole pg_top_queries test group early-returns on
  # "extension is not installed" and proves nothing about the tool's SQL
  # (version detection, column selection, the dbid filter, the ORDER BY
  # qualification). Appended rather than sed-replaced so it survives whatever
  # the packaged default looks like; last setting in the file wins.
  grep -q "^shared_preload_libraries.*pg_stat_statements" "$PGCONF" \
    || echo "shared_preload_libraries = 'pg_stat_statements'" >> "$PGCONF"

  PORT=$(grep -E '^port' "$PGCONF" | awk '{print $3}')
  echo "PG${V} on port ${PORT}"

  pg_ctlcluster "${V}" main restart || pg_ctlcluster "${V}" main start
  sleep 1

  su - postgres -c "psql -p ${PORT} -c \"ALTER USER postgres PASSWORD 'postgres';\""
  su - postgres -c "psql -p ${PORT} -c 'CREATE DATABASE postgres_mcp_test;'" \
    || echo "  db exists on PG${V}, continuing"

  # Extensions the integration suite needs to exercise its real paths rather
  # than its "not installed" branches. pgstattuple backs pg_table_bloat's
  # approx/exact methods; pg_stat_statements backs pg_top_queries (and needs
  # the preload configured above, hence the restart before this point).
  # Best-effort per extension so a missing contrib package doesn't abort setup.
  for EXT in pg_stat_statements pgstattuple; do
    su - postgres -c "psql -p ${PORT} -d postgres_mcp_test -c 'CREATE EXTENSION IF NOT EXISTS ${EXT};'" \
      || echo "  ${EXT} unavailable on PG${V} -- related tests will take their not-installed branch"
  done
done

echo "---"
ss -ltnp | grep -E '543[2-9]' || echo "no postgres listeners found"
echo "---"
for V in "${PG_VERSIONS[@]}"; do
  PORT=$(grep -E '^port' /etc/postgresql/${V}/main/postgresql.conf | awk '{print $3}')
  psql "postgres://postgres:postgres@localhost:${PORT}/postgres_mcp_test" -tAc 'SELECT version();'
done
