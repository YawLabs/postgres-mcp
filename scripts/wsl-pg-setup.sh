#!/usr/bin/env bash
# Configures a fresh WSL Ubuntu install with PostgreSQL ready for the
# integration test suite. Run as root inside WSL:
#
#   wsl -d Ubuntu -u root bash /mnt/c/path/to/postgres-mcp/scripts/wsl-pg-setup.sh
#
# Assumes `apt-get install -y postgresql postgresql-contrib` has already run.
# Idempotent -- safe to re-run.
set -euo pipefail

su - postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
su - postgres -c "psql -c 'CREATE DATABASE postgres_mcp_test;'" || echo "db exists, continuing"

PGCONF=/etc/postgresql/16/main/postgresql.conf
HBACONF=/etc/postgresql/16/main/pg_hba.conf

sed -i "s/^#listen_addresses.*/listen_addresses = '*'/" "$PGCONF"
grep -q '0.0.0.0/0' "$HBACONF" || echo 'host all all 0.0.0.0/0 md5' >> "$HBACONF"

service postgresql restart
sleep 2
service postgresql status | head -3
echo "---"
ss -ltnp | grep 5432 || echo "no listener on 5432"
