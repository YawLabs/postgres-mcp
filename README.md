# @yawlabs/postgres-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/postgres-mcp)](https://www.npmjs.com/package/@yawlabs/postgres-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Query a PostgreSQL database from Claude Code, Cursor, and any MCP client.** Read-only by default - writes opt in via a single env var - so an agent can't silently drop your tables.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Postgres&command=npx&args=-y%2C%40yawlabs%2Fpostgres-mcp&description=Query%20PostgreSQL%20-%20schema%20introspection%2C%20EXPLAIN%20plans%2C%20health%20diagnostics%2C%20read-only%20by%20default&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fpostgres-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Backstory

Anthropic's reference Postgres MCP server, `@modelcontextprotocol/server-postgres`, was [archived in May 2025](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres) and [marked deprecated on npm](https://www.npmjs.com/package/@modelcontextprotocol/server-postgres) in July 2025. Anthropic has not shipped a replacement. Despite the deprecation, the last published version (v0.6.2) is still pulled ~20,000 times per week - a lot of agents are pointed at an unmaintained package.

That unmaintained package also has a known, [publicly documented stacked-query SQL injection](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) (Datadog Security Labs) that bypasses its `BEGIN READ ONLY` wrapper with input like `COMMIT; DROP SCHEMA public CASCADE;`. It has never been patched at npm.

A handful of community forks have appeared, but each fills a narrow slice:

- [`@zeddotdev/postgres-context-server`](https://www.npmjs.com/package/@zeddotdev/postgres-context-server) - Zed's fork, primarily a security patch on the original shape.
- **Postgres MCP Pro** (Crystal DBA) - focused on index tuning and hypothetical-index / buffer-cache diagnostics.
- **AWS Labs Postgres MCP** - tied to Aurora / RDS Data API + Secrets Manager.

None of them position themselves as a general-purpose daily driver you'd hand to Claude Code or Cursor against an arbitrary Postgres: modern introspection, perf helpers, role/privilege awareness, and a write-safety posture out of the box. That's the gap `@yawlabs/postgres-mcp` fills.

## Why this one?

- **Read-only by default, with an unconditional read-only tool too** - `pg_query` runs user SQL in a `BEGIN READ ONLY` transaction, so postgres itself (not string parsing) blocks writes; opt in to writes with `ALLOW_WRITES=1`. `pg_readonly` is a separate tool that stays read-only regardless of `ALLOW_WRITES`, so hosts that gate tools individually (Claude Code permissions, mcp.hosting) can auto-allow it -- paired with a least-privileged role, since `READ ONLY` bounds writes to the database rather than every side effect ([details](#per-tool-gating-in-the-host)).
- **Role-based access as the primary control** - the recommended posture is to use a least-privileged postgres role in `DATABASE_URL` (e.g. one with `GRANT pg_read_all_data`); postgres itself then enforces the boundary, no env var needed. See [Configuring access](#configuring-access).
- **Extended query protocol for all user SQL** - `pg_query` sends user input with `queryMode: 'extended'`, which restricts each request to a single statement. This closes the [stacked-query injection class](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) (`COMMIT; DROP SCHEMA x CASCADE;`) that defeated the reference server's `BEGIN READ ONLY` wrapper. Integration test asserts the rejection.
- **Parameterized queries** - `pg_query` takes a `params` array for `$1`, `$2`, etc. No string-interpolated SQL in our code path.
- **Written from scratch, actively maintained** - not a fork of the deprecated code. Unit + integration tests (`npm test`, `npm run test:integration`) run against a real Postgres; releases cut via `release.sh`.
- **Schema introspection built in** - `pg_list_schemas`, `pg_list_tables`, `pg_describe_table` return columns, primary keys, foreign keys, and indexes without the agent having to remember `pg_catalog` joins.
- **`EXPLAIN` as a first-class tool** - text or JSON format, with optional `ANALYZE`. ANALYZE for non-SELECT statements requires `ALLOW_WRITES=1` and always rolls back, so the plan is real but the write doesn't persist.
- **Perf diagnostics the deprecated server never had** - `pg_top_queries` (from `pg_stat_statements`), `pg_seq_scan_tables`, `pg_unused_indexes`, `pg_table_bloat`, `pg_inspect_locks`, `pg_replication_status`. Answer "why is this slow?" in one tool call.
- **Health snapshot** - `pg_health` returns version, db size, connection counts, and the 10 longest-running active queries in one call.
- **Role and privilege awareness** - `pg_list_roles` and `pg_table_privileges` for the common "who can touch what?" questions.
- **Instant startup** - ships as a single bundled file with zero runtime dependencies. No multi-minute `node_modules` install on every `npx` cold start.
- **Result truncation** - large result sets are capped at `POSTGRES_MAX_ROWS` (default 1000) with a `truncated: true` flag, so a stray `SELECT * FROM events` doesn't blow out the model context.

## Quick start

**1. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@yawlabs/postgres-mcp@latest"],
      "env": {
        "DATABASE_URL": "postgres://user:password@host:5432/dbname"
      }
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/postgres-mcp@latest"],
      "env": {
        "DATABASE_URL": "postgres://user:password@host:5432/dbname"
      }
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**2. Restart and approve**

Restart Claude Code (or your MCP client) and approve the postgres MCP server when prompted.

**3. (Optional) Enable writes**

Read-only is the default. If you want the agent to be able to `INSERT`, `UPDATE`, `DELETE`, or run DDL, add `ALLOW_WRITES=1` to the `env` block:

```json
"env": {
  "DATABASE_URL": "postgres://...",
  "ALLOW_WRITES": "1"
}
```

Prefer scoping this to dev/test databases - for production, leave writes off and use migration tools out-of-band.

## Configuring access

The role in `DATABASE_URL` is the primary access control. Postgres has had a battle-tested permission system for 30 years; lean on it instead of relying on `ALLOW_WRITES` alone. A least-privileged role makes writes server-rejected no matter what tools or env vars are configured.

**Read-only agent (recommended default):**

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE your_db TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT pg_read_all_data TO mcp_reader;
```

Point `DATABASE_URL` at `mcp_reader`. Postgres rejects every write, every DDL, every privilege change - regardless of `ALLOW_WRITES`. No app-level guard to bypass; the database is the boundary.

**Scoped write agent (dev/test or narrow production use):**

```sql
CREATE ROLE mcp_writer LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE your_db TO mcp_writer;
GRANT USAGE ON SCHEMA public TO mcp_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO mcp_writer;
-- DDL not granted -- the agent can change data but not schema.
```

Set `ALLOW_WRITES=1` so `pg_query` will issue writes, and rely on the role to keep the agent away from DDL and other schemas.

**Per-tool gating in the host:**

Tools split cleanly across two authority classes:

- **Auto-allow:** `pg_readonly` (server-side `BEGIN READ ONLY`, unconditional), plus the introspection tools (`pg_list_*`, `pg_describe_table`, `pg_search_columns`, `pg_explain` without ANALYZE-of-write, `pg_health`, `pg_inspect_locks`, `pg_table_bloat`, `pg_unused_indexes`, `pg_top_queries`, `pg_replication_status`, `pg_advisor`, `pg_table_privileges`, `pg_list_roles`).
- **Always prompt:** `pg_query` (can write when the role allows it), `pg_kill` (changes session state).

Claude Code's `permissions` block and mcp.hosting's per-tool toggle both honor this split.

> **What `READ ONLY` does and does not cover.** A `BEGIN READ ONLY` transaction blocks writes to the *database* -- INSERT/UPDATE/DELETE, DDL, `nextval`/`setval`. It does not block functions whose effect lands outside the table data. `SELECT pg_terminate_backend(...)`, `pg_cancel_backend`, `pg_read_file`, `lo_export`, and `COPY ... TO PROGRAM` all run to completion inside `pg_readonly`, which means auto-allowing `pg_readonly` reaches the same capability that `pg_kill` puts behind `ALLOW_WRITES=1`. Every one of them still requires a privilege the `DATABASE_URL` role must actually hold (`pg_signal_backend`, `pg_read_server_files`, superuser), so **the role is the control that bounds this tool, not the transaction mode.** If you auto-allow `pg_readonly`, use a least-privileged role -- see [Configuring access](#configuring-access).

**`ALLOW_WRITES` as defense-in-depth:**

`ALLOW_WRITES` is a secondary belt-and-braces gate. Useful when:
- You're on a managed database where creating a second role is awkward (some Supabase/Neon plans).
- You want a single role that can write, but want the MCP server to refuse writes anyway during normal operation.

Otherwise, configure the role and stop relying on `ALLOW_WRITES`.

## What can an agent do with this?

Once connected, the agent picks tools automatically based on what you ask. A few single-tool examples:

- **"Describe the users table"** -> `pg_describe_table` -> returns kind, columns, PK, FKs, indexes.
- **"Which tables have a `user_id` column?"** -> `pg_search_columns` with pattern `user_id` -> one call instead of iterating every table.
- **"This query is slow, why?"** -> `pg_explain` with `analyze: true` -> returns the plan with actual row counts and timing.
- **"What's the slowest query we run?"** -> `pg_top_queries` -> returns the top N from `pg_stat_statements` with mean/total/min/max times.
- **"Do we have any unused indexes?"** -> `pg_unused_indexes` -> returns non-unique, non-primary indexes with zero or low scan counts + their size.
- **"Is `pgvector` installed?"** -> `pg_list_extensions` -> yes/no with version.

The bigger leverage is multi-tool reasoning. A few real workflows:

- **Unstick a hung app.** `pg_inspect_locks` returns blocked PID + blocking PID + the offending query, then `pg_kill` (`ALLOW_WRITES=1` required) cancels the blocker. The agent can run both in one turn - it's the fastest path from "the app is frozen" to "back up."
- **Chase a slow page.** `pg_top_queries` ranks the worst queries, `pg_explain` with `analyze: true` shows the plan for the top hit, `pg_seq_scan_tables` and `pg_unused_indexes` say whether the answer is "add an index here" or "drop a dead one there."
- **Oncall triage.** `pg_health` checks connectivity + active-query count + database size; `pg_inspect_locks` and `pg_replication_status` confirm whether contention or replication lag is in play before paging the on-call DBA.

## Tools

| Tool | Description |
|------|-------------|
| `pg_readonly` | Run a SQL statement with no persistent data changes - always inside `BEGIN READ ONLY`, regardless of `ALLOW_WRITES`. The recommended tool for read access, and the one to auto-allow; pair it with a least-privileged role ([why](#per-tool-gating-in-the-host)). |
| `pg_query` | Run a SQL query. Writes gated by the role in `DATABASE_URL` first, `ALLOW_WRITES` second. Supports parameterized queries via `params`. Result fields include `dataTypeName` (e.g. `int4`, `jsonb`) alongside `dataTypeID`. |
| `pg_list_schemas` | List non-system schemas. |
| `pg_list_tables` | List tables (and optionally views) in a schema with estimated row counts. Paginated via `limit`/`offset`. |
| `pg_describe_table` | Kind, columns, PK, outgoing FKs, incoming FKs (`referenced_by`), CHECK / UNIQUE / EXCLUDE constraints, indexes, and partition parent/children for a relation. Generated and identity columns are flagged (`generated`, `identity`, `generation_expression`) so an agent doesn't try to write to them. Constraints carry `validated`, plus `enforced` / `has_period` on PG18+. |
| `pg_list_views` | List views and materialized views in a schema, including their SQL definitions. |
| `pg_list_functions` | List functions, procedures, and aggregates in a schema with signatures and return types. |
| `pg_list_extensions` | List installed extensions (pgvector, postgis, pg_stat_statements, etc.) with versions. |
| `pg_search_columns` | Find columns by name pattern across all user schemas. Case-insensitive, supports SQL LIKE wildcards. |
| `pg_explain` | `EXPLAIN` or `EXPLAIN ANALYZE` for a SQL statement. Text or JSON output. Planner options: `buffers` (on by default with `analyze`), `settings`, `verbose`, `wal`, `costs`, `timing`, plus `generic_plan` (PG16+, plan a parameterized query with no values) and `memory` / `serialize` (PG17+). Optional `hypothetical_indexes` (requires the [HypoPG](https://github.com/HypoPG/hypopg) extension) lets you ask "what would the plan be with these indexes?" without creating them on disk. |
| `pg_health` | Server version, database size, connections against `max_connections`, active queries with wait events and transaction age, `pg_stat_database` rollup (deadlocks, temp files, cache hit ratio), table count. |
| `pg_top_queries` | Top N queries by total/mean execution time. Requires the `pg_stat_statements` extension. Returns `stats_reset` (from `pg_stat_statements_info`, a different clock from the other stats tools) and `dealloc` on extension 1.9+ - a non-zero `dealloc` means entries were evicted past `pg_stat_statements.max`, so the ranking is drawn from an incomplete population. |
| `pg_seq_scan_tables` | Tables with heavy sequential scans - missing-index candidates. Returns the `stats_reset` window alongside the rows, since the counters mean nothing without it. `last_seq_scan` / `last_idx_scan` on PG16+. |
| `pg_unused_indexes` | Non-unique, non-primary indexes with low scan counts - drop candidates. Also returns `stats_reset`: a recently reset counter makes every index look unused, which is how a load-bearing index gets dropped. `last_idx_scan` on PG16+. |
| `pg_io_stats` | I/O observability: `pg_stat_io` read/write/extend/fsync counts, bytes and times per backend type and context (PG16+), plus in-flight async I/O handles from `pg_aios` and the active `io_method` (PG18+). |
| `pg_inspect_locks` | Who is blocking whom right now (blocked PID, blocker PID, lock type, queries). |
| `pg_list_roles` | Database roles with login/superuser/createdb flags and group memberships. |
| `pg_table_privileges` | Who has SELECT/INSERT/UPDATE/DELETE/etc. on a table or whole schema. |
| `pg_table_bloat` | Tables with high dead-tuple ratios - VACUUM candidates. |
| `pg_replication_status` | Replication slots, connected replicas, and current WAL position. |
| `pg_advisor` | Rolled-up DBA lints in one call: sequence-exhaustion candidates, wraparound risk for both counters (per-database and per-table `age(relfrozenxid)` against `autovacuum_freeze_max_age`, and `mxid_age(relminmxid)` against `autovacuum_multixact_freeze_max_age` -- a lock-heavy workload can exhaust multixacts while xids look healthy; `triggered_by` says which), tables without a primary key, and (configurable) public tables with RLS disabled. The "what should I be looking at?" starting point. |
| `pg_kill` | Cancel a running query or terminate a backend connection. Requires `ALLOW_WRITES=1`. |

## Configuration

All env vars are read from the MCP server's environment:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | (required) | PostgreSQL connection string. |
| `ALLOW_WRITES` | unset | Secondary write gate for `pg_query` and `pg_explain` ANALYZE-of-writes. Set to `1` or `true` to lift the `BEGIN READ ONLY` wrapper. The role in `DATABASE_URL` is the primary control - see [Configuring access](#configuring-access). Does not affect `pg_readonly`, which is unconditional. |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout. |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `10000` | TCP connect timeout. Without this, a dead host hangs until the OS gives up (~2 minutes). |
| `POSTGRES_MAX_ROWS` | `1000` | Cap on rows returned by `pg_query`. |
| `POSTGRES_POOL_MAX` | `5` | Max pool connections. Set to `1` for single-threaded backends (pglite-socket, PgBouncer transaction mode). |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | unset | Set to `false` to skip TLS cert verification (for managed DBs using private-CA certs). Connection is still encrypted. |
| `POSTGRES_APPLICATION_NAME` | `postgres-mcp` | Value reported in `pg_stat_activity.application_name`, so agent traffic is identifiable to whoever is watching the database. An `application_name` in `DATABASE_URL` takes precedence over this. |
| `POSTGRES_MCP_RUNTIME` | `auto` | Which JS runtime executes the server: `auto` (prefer [oam](https://oamjs.org), fall back to Node), `oam` (require oam, fail if absent), `node` (never use oam). See [Runtime](#runtime). |
| `OAM_BIN` | unset | Explicit path to an `oam` binary, checked before PATH and the default install locations. |

### Supported Postgres versions

Tested on **PostgreSQL 15, 17 and 18** in the integration matrix.

Works on PG13+, but note where upstream support actually sits: **PG13 reached end of life on 2025-11-13 and PG14 does so on 2026-11-12.** PG13/14 are not exercised here and are not a compatibility target going forward. PG12 and below are further out of support and some tools rely on columns that landed in PG13 (`pg_replication_status` reading `wal_status`, `pg_top_queries` reading `*_exec_time`).

Newer server versions unlock extra fields rather than being required. Every version-dependent column is gated on `server_version_num` and simply omitted on servers that predate it, so nothing errors -- you get a slightly thinner answer. The cut points that matter:

| Server | What it adds |
|--------|--------------|
| PG16+ | `last_idx_scan` / `last_seq_scan` in the stats tools (index/table staleness rather than a bare counter), `pg_explain` `generic_plan` |
| PG17+ | `pg_explain` `memory` and `serialize` |
| PG18+ | Generated-column form (`stored` vs `virtual`), NOT NULL constraint validity, `conenforced` / `conperiod` constraint metadata in `pg_describe_table`, `relallfrozen` freeze coverage in `pg_advisor`. `BUFFERS` is on by default with `EXPLAIN ANALYZE` server-side |

If the version probe fails, the server assumes the oldest supported shape rather than emitting SQL a server might reject.

### Runtime

The published `postgres-mcp` command is a small launcher that prefers the [oam](https://oamjs.org) runtime and falls back to Node.

**If you do not have oam, nothing changes.** The fallback is not a re-exec: npm already started Node to run the launcher, so falling back is a plain `import()` of the server into that same process. It costs a few `existsSync` calls and no subprocess, and behaves identically to running `dist/index.js` under Node directly.

**If you do have oam,** the server runs under it. Verified equivalent on both runtimes: all 22 tools register, queries return identical rows and `dataTypeName` values, and the error paths match. oam supplies every `node:` builtin the driver needs, including `net`, `tls`, `crypto`, and `dns` (SCRAM auth and the extended query protocol both work).

**Startup cost, measured.** windows-arm64, 1.4 MB bundle, `postgres-mcp version` (full module init), every binary warmed first, mean of 12 runs:

| path | startup |
|---|---|
| standalone binary (`oam compile`) | 298ms |
| `oam run dist/index.js` | 306ms |
| `node dist/index.js` | 358ms |
| launcher -> Node (in-process) | 370ms |
| launcher -> oam (spawn) | 409ms |

oam starts **faster** than Node here. What the launcher costs is the *spawn*: reaching oam means Node has already booted, and that hop (~100ms) is larger than oam's ~52ms advantage. So through the npm `bin`, the two land within ~40ms of each other, and `POSTGRES_MCP_RUNTIME=node` is a marginal win rather than a meaningful one.

Either way it is a **one-time cost per MCP session**, not per tool call -- hosts spawn the server once and hold it open. If startup genuinely matters, the standalone binary avoids the launcher entirely and is the fastest option.

> Earlier releases of this README reported ~650-900ms for Node and ~980-1290ms for oam, and advised opting out of oam on that basis. Those figures were measured against cold, freshly-built binaries and reflected the Windows on-access virus scanner rather than either runtime. They were wrong in both magnitude and direction. Corrected in 0.9.1.

```jsonc
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@yawlabs/postgres-mcp"],
      "env": {
        "DATABASE_URL": "postgres://...",
        "POSTGRES_MCP_RUNTIME": "node"  // opt out of oam
      }
    }
  }
}
```

### Connecting to managed Postgres (Supabase, Neon, RDS, etc.)

Most managed databases require TLS but serve certs signed by a private CA that Node's default trust store doesn't recognize. The symptom is one of:

- `self signed certificate in certificate chain`
- `unable to get local issuer certificate`
- `unable to verify the first certificate`

To allow the connection while keeping traffic encrypted, add `POSTGRES_SSL_REJECT_UNAUTHORIZED=false` to the `env` block:

```json
"env": {
  "DATABASE_URL": "postgres://user:pass@host:5432/db?sslmode=require",
  "POSTGRES_SSL_REJECT_UNAUTHORIZED": "false"
}
```

This disables certificate chain verification only -- the TCP connection is still TLS-encrypted end-to-end. For production setups where you can install the CA, prefer putting the cert in the Node trust store (`NODE_EXTRA_CA_CERTS`) over disabling verification globally.

**Shaving a round trip on PG17+.** Postgres 17 added direct TLS negotiation, which skips the plaintext `SSLRequest` handshake before the TLS one. The bundled driver supports it, so append `sslnegotiation=direct` to your `DATABASE_URL`:

```
postgres://user:pass@host:5432/db?sslmode=require&sslnegotiation=direct
```

It is opt-in rather than a default because a PG16-or-older server will reject the connection outright, and the saving is one round trip per pooled connection -- worth it on a distant managed database, invisible on a local one.

## Troubleshooting

**`DATABASE_URL is not set`** - Your MCP client is launching the server without the env var. On Windows especially, env vars set in bash / PowerShell profiles are not inherited by MCP servers launched via `cmd`. Put `DATABASE_URL` directly in the `env` block of `.mcp.json`.

**`password authentication failed`** - Check the username, password, and that the user has `CONNECT` privilege on the database. URL-encode special characters in the password (`@` → `%40`, `#` → `%23`, `/` → `%2F`).

**`SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`** - The password in your connection string is empty or became `null` after URL decoding. Re-check your connection string.

**`canceling statement due to statement timeout`** - A single query exceeded `POSTGRES_STATEMENT_TIMEOUT_MS` (default 30s). Increase it, narrow the query with `WHERE`, or add an index. This is working as designed -- the timeout exists so a runaway query cannot hang the agent.

**`Write blocked: this server is in read-only mode`** - You asked the agent to write via `pg_query` but `ALLOW_WRITES` is not set. Either add `ALLOW_WRITES=1` to the `env` block of `.mcp.json` and restart your MCP client (dev/test DBs), or - cleaner for production - use a role with `INSERT/UPDATE/DELETE` grants in `DATABASE_URL` and keep `ALLOW_WRITES` unset. See [Configuring access](#configuring-access). Note that `pg_readonly` always rejects writes; if you want writes, the call has to go through `pg_query`.

**Connection pool exhaustion with PgBouncer transaction mode or pglite-socket** - These backends don't support concurrent queries on a single connection. Set `POSTGRES_POOL_MAX=1` in the env block.

**First query is slow, subsequent queries are fast** - Expected. The pg driver lazily establishes the first connection; subsequent queries reuse the pool.

## Development

Run the full suite (unit + integration) against a real Postgres:

```bash
DATABASE_URL='postgres://user:pass@host:5432/db' POSTGRES_MCP_INTEGRATION=1 npm run test:integration
```

The integration suite assumes a disposable database -- it creates and drops a `test_fixture` schema. Don't point it at anything you care about.

To also run the destructive tests (REVOKE / restricted-role path), add `POSTGRES_MCP_DESTRUCTIVE_TESTS=1`. Only safe on a disposable cluster:

```bash
DATABASE_URL='postgres://user:pass@host:5432/db' POSTGRES_MCP_INTEGRATION=1 POSTGRES_MCP_DESTRUCTIVE_TESTS=1 npm run test:integration
```

### Windows: integration tests via WSL2

Native Postgres on Windows ARM64 is fragile (UCRT runtime gaps, missing ARM64 builds). The reliable path is a disposable Ubuntu under WSL2 with the integration suite running inside WSL (WSL2's NAT blocks the Windows host from reaching :5432, so don't try to run the tests from PowerShell):

```powershell
wsl --install -d Ubuntu --no-launch
# reboot, then:
wsl -d Ubuntu -u root bash -c "apt-get update && apt-get install -y nodejs npm rsync"
wsl -d Ubuntu -u root bash /mnt/c/path/to/postgres-mcp/scripts/wsl-pg-setup.sh
wsl -d Ubuntu -u root bash /mnt/c/path/to/postgres-mcp/scripts/wsl-test-matrix.sh
```

`wsl-pg-setup.sh` installs PG17 and PG18 from the PGDG apt repo on ports 5432 and 5433, sets the `postgres` password to `postgres`, and creates `postgres_mcp_test` in each. `wsl-test-matrix.sh` rsyncs the working tree into `/root/postgres-mcp`, runs `npm ci` once, and runs the integration suite against every cluster found via `pg_lsclusters`.

Tear down when finished: `wsl --unregister Ubuntu`.

## License

MIT © 2026 YawLabs
