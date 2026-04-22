# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-04-22

### Fixed
- `pg_list_roles` with `includeSystem: false` (the default) now actually
  excludes built-in `pg_*` roles. The previous `LIKE 'pg\_%' ESCAPE '\\'`
  filter ended up as SQL `ESCAPE '\\'` (two backslashes), which Postgres
  rejects since `ESCAPE` requires a single character — so the whole filter
  was silently being dropped. Replaced with `starts_with(rolname, 'pg_')`.
- `pg_describe_table` foreign-key `columns` and `foreign_columns` are now
  proper JSON arrays. They were previously returned as the raw postgres
  text form (e.g. `"{user_id}"`) because `array_agg(name)` returns `name[]`,
  which node-pg doesn't auto-parse. Cast to `text[]` so the driver parses.

### Infrastructure (main branch CI hygiene; no user-facing changes)
- `.gitattributes` forces LF line endings in the working tree on every OS,
  so biome's formatter doesn't reject every file on Windows runners after
  git's auto-CRLF conversion.
- The integration CI job now starts postgres via `docker run` with
  `-c shared_preload_libraries=pg_stat_statements` instead of the `services:`
  block (which passes options to `docker create`, where `-c` means
  --cpu-shares and collided with the postmaster flag).
- Cross-platform test discovery via `scripts/run-tests.mjs`. `node --test dist`
  hangs on Windows; `dist/**/*.test.js` globs only expand in bash with
  globstar. The wrapper uses `fs.readdirSync({ recursive: true })` (stdlib)
  and passes explicit paths, plus `--test-concurrency=1` for the integration
  suite so fixture-schema setup doesn't race.

## [0.3.0] - 2026-04-22

### Added
- `pg_list_views` — list views and materialized views with SQL definitions.
- `pg_list_functions` — list functions, procedures, and aggregates with signatures.
- `pg_list_extensions` — list installed extensions (pgvector, postgis, etc.) with versions.
- `pg_search_columns` — find columns by name pattern across all user schemas.
- `pg_top_queries` — top N queries by total/mean execution time from
  `pg_stat_statements`. Detects extension version and picks the right column
  names (v1.8+ uses `total_exec_time`, older uses `total_time`). Returns clear
  setup instructions if the extension is not installed.
- `pg_list_tables` now accepts `limit` / `offset` for pagination on large schemas.
- `pg_health` now accepts `activeQueryLimit` (1–100) to override the default of 10.
- `pg_query` / `pg_explain` `params` now accept arrays and objects (for
  postgres arrays, `ANY`, and json/jsonb columns) in addition to scalars.
- `POSTGRES_SSL_REJECT_UNAUTHORIZED` env var to disable TLS cert verification for
  managed databases using private-CA certs (Supabase, Neon, RDS). Documented in
  a new "Connecting to managed Postgres" README section.
- `pg_describe_table` now surfaces partial failures via a `_warnings` array
  instead of silently collapsing FK/index fetch errors into empty lists.
- Troubleshooting section in README covering common failure modes (env vars,
  auth, timeouts, write-blocked, pool exhaustion, cold-start latency).
- CHANGELOG.md.
- Dependabot config for npm + github-actions (weekly, grouped dev deps).
- Windows CI matrix (ubuntu + windows × Node 18/20/22).
- Integration test suite (`npm run test:integration`) that exercises every
  tool against a real Postgres instance. Gated on `POSTGRES_MCP_INTEGRATION=1`
  so local `npm test` stays fast with no DB required. CI runs it on Linux via
  a `postgres:16` service container with `pg_stat_statements` preloaded.
- `pg_inspect_locks` — show current blocking locks (blocked PID, blocker PID,
  relation, lock type, both queries). First tool to reach for when a session
  hangs or the app feels stuck.
- `pg_list_roles` — database roles with login/superuser/createdb/createrole
  flags and inherited group memberships.
- `pg_table_privileges` — who has SELECT/INSERT/UPDATE/DELETE/etc. on a table,
  or on all tables in a schema. Useful for pre-migration audits.
- `pg_seq_scan_tables` — tables with heavy sequential scans relative to index
  scans. Missing-index candidates.
- `pg_unused_indexes` — non-unique, non-primary indexes with low/zero scan
  counts. Drop candidates (each unused index costs write amplification).
- `pg_kill` — cancel a running query or terminate a backend by PID. Requires
  `ALLOW_WRITES=1` since it changes session state. Distinguishes `cancel`
  (SIGINT-equivalent, graceful) from `terminate` (SIGTERM, forceful).
- `pg_table_bloat` — estimate dead tuples and vacuum-candidate tables from
  `pg_stat_user_tables`. No extensions required.
- `pg_replication_status` — replication slots, connected replicas with lag,
  and current WAL position. Returns empty arrays on a standalone DB rather
  than erroring, so it's safe to call unconditionally.
- New "What can an agent do with this?" README section with concrete example
  conversations mapped to tool calls.

### Changed
- Loosened identifier validation on `pg_list_tables` and `pg_describe_table`.
  Quoted identifiers (e.g. `"My Table"`) now work. Length capped at 63 bytes
  (the postgres limit) via zod schema; the previous regex-based whitelist
  blocked legitimate identifiers.
- Pool `idleTimeoutMillis` widened 10s → 60s. MCP sessions routinely have
  minute-long gaps; the short timeout was forcing a reconnect on every tool
  call.
- `pg_query` / `pg_explain` `sql` inputs now hard-capped at 1 MB.

### Fixed
- `pg_explain` now rejects pre-wrapped SQL (e.g. `"EXPLAIN SELECT 1"`) with a
  clear error instead of producing a `EXPLAIN (...) EXPLAIN SELECT 1` syntax
  error. LLMs frequently make this mistake.

## [0.1.1] - 2026-04-21

### Changed
- Release workflow: widened npm registry propagation wait from 1 min to 10 min
  to handle occasional stalls observed on initial publish.

## [0.1.0] - 2026-04-21

Initial release.

### Added
- `pg_query` — run SQL with read-only-by-default safety. Writes opt in via `ALLOW_WRITES=1`.
- `pg_list_schemas` — list non-system schemas.
- `pg_list_tables` — list tables (and optionally views) with estimated row counts.
- `pg_describe_table` — columns, PK, FKs, indexes.
- `pg_explain` — `EXPLAIN` / `EXPLAIN ANALYZE` with text or JSON output.
- `pg_health` — server version, db size, connections, active queries, table count.
- Single-file bundled distribution (zero runtime deps) for fast `npx` cold starts.
- Result row truncation at `POSTGRES_MAX_ROWS` (default 1000).
- Parameterized queries via `params` on `pg_query` and `pg_explain`.
