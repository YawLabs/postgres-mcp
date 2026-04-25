#!/usr/bin/env bash
# Configures a WSL Ubuntu install with PostgreSQL 17 and 18 (both current GA)
# ready for the integration test matrix. Run as root inside WSL:
#
#   wsl -d Ubuntu -u root bash /mnt/c/path/to/postgres-mcp/scripts/wsl-pg-setup.sh
#
# Installs from the PGDG apt repo (Ubuntu's default ships PG16 only).
# PG17 gets port 5432, PG18 gets port 5433 (pg_createcluster auto-assigns).
# Idempotent -- safe to re-run.
set -euo pipefail

PG_VERSIONS=(17 18)

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

# Purge the Ubuntu-default PG16 if present so port 5432 is free for PG17.
if dpkg -l | grep -q '^ii  postgresql-16 '; then
  service postgresql stop || true
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq postgresql-16 postgresql-contrib-16
  rm -rf /var/lib/postgresql/16 /etc/postgresql/16
fi

for V in "${PG_VERSIONS[@]}"; do
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    "postgresql-${V}" "postgresql-contrib-${V}"
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

  sed -i "s/^#listen_addresses.*/listen_addresses = '*'/" "$PGCONF"
  grep -q '0.0.0.0/0' "$HBACONF" || echo 'host all all 0.0.0.0/0 md5' >> "$HBACONF"

  PORT=$(grep -E '^port' "$PGCONF" | awk '{print $3}')
  echo "PG${V} on port ${PORT}"

  pg_ctlcluster "${V}" main restart || pg_ctlcluster "${V}" main start
  sleep 1

  su - postgres -c "psql -p ${PORT} -c \"ALTER USER postgres PASSWORD 'postgres';\""
  su - postgres -c "psql -p ${PORT} -c 'CREATE DATABASE postgres_mcp_test;'" \
    || echo "  db exists on PG${V}, continuing"
done

echo "---"
ss -ltnp | grep -E '543[2-9]' || echo "no postgres listeners found"
echo "---"
for V in "${PG_VERSIONS[@]}"; do
  PORT=$(grep -E '^port' /etc/postgresql/${V}/main/postgresql.conf | awk '{print $3}')
  psql "postgres://postgres:postgres@localhost:${PORT}/postgres_mcp_test" -tAc 'SELECT version();'
done
