# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- User SQL fetches are now memory-bounded by Postgres, not by Node. The
  prior flow had node-pg materialize the entire result set into memory and
  then sliced down to `POSTGRES_MAX_ROWS` for output -- so a payload like
  `SELECT * FROM big1 CROSS JOIN big2` could OOM the MCP process before
  the 30 s `statement_timeout` fired. User SQL now runs through a
  server-side `DECLARE ... NO SCROLL CURSOR FOR ...` + `FETCH MAX_ROWS+1`
  pattern; only the response-sized batch is ever materialized in Node.
  Non-cursorable statements (DDL, DML without RETURNING, utility commands)
  fall back to a direct execute via `SAVEPOINT` so the outer transaction
  stays alive -- those statements never produce a runaway result set
  anyway.
- User SQL is now sent with `queryMode: 'extended'`, forcing pg to use the
  extended query protocol regardless of whether `params` is empty. The
  extended protocol restricts each request to a single statement, closing
  the stacked-query injection pattern documented by
  [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/)
  against the now-archived `@modelcontextprotocol/server-postgres`. Without
  this fix, a payload like `SELECT 1; COMMIT; DROP SCHEMA x CASCADE;` passed
  to `pg_query` would escape the `BEGIN READ ONLY` wrapper and run DDL in
  autocommit. Added an integration regression test that asserts the
  multi-statement request is rejected by Postgres.
- `pg` minimum bumped from `^8.13.0` to `^8.14.0`. The `queryMode: 'extended'`
  option that backs the stacked-query guard above is silently ignored on pg
  8.13.x -- a fresh `npm install` resolving to that range would have regressed
  the security guard with no visible signal. Today's lockfile pins 8.20.0;
  the range bump prevents future installs from sliding back.
- `@types/pg` bumped from `^8.11.10` to `^8.20.0` to track pg 8.20.0 runtime.

### Added
- `pg_describe_table` now returns four new fields:
  - `referenced_by` -- incoming FKs (other tables whose foreign keys point at
    this one). Answers "what depends on this table?" before a destructive
    change. None of the surveyed competing Postgres MCP servers expose this;
    in psql you'd run `\d+` on every candidate table and squint.
  - `constraints` -- CHECK / UNIQUE non-PK / EXCLUDE constraints with each
    constraint's full definition string from `pg_get_constraintdef()`. PK and
    FK still live in their dedicated fields, so no double-listing.
  - `partition_of` -- when the relation is a partition, the parent
    schema / table.
  - `partitions` -- when the relation is a `partitioned_table`, the list of
    children with their `pg_get_expr()` partition bounds.
- `pg_query` result `fields` now include `dataTypeName` (e.g. `int4`, `text`,
  `jsonb`) alongside `dataTypeID`. Previously LLMs saw only the OID and had
  to map it themselves. Resolution is process-cached against `pg_type`, with
  a single miss-fill query for any OID introduced by `CREATE TYPE` mid-session.
- npm tarball now ships `LICENSE`, `README.md`, and `CHANGELOG.md` alongside
  the bundle. Previously the `files` allowlist was `["dist/index.js"]` only,
  so `npm pack` produced a tarball with no docs and no license file -- bad
  for downstream consumers and registry surfaces that read README from the
  tarball rather than the repo.
- README workflow examples now show three multi-tool sequences (unstick a
  hung app via `pg_inspect_locks` -> `pg_kill`, chase a slow page via
  `pg_top_queries` -> `pg_explain` -> `pg_unused_indexes`, oncall triage via
  `pg_health` -> `pg_inspect_locks` -> `pg_replication_status`). The previous
  example list was single-tool only.
- New `pg_table_bloat` integration test asserts every returned `dead_ratio`
  is a finite number in `[0, 1]`. Locks down the invariant that the recent
  `dead / (live + dead)` formula change was meant to enforce.
- New `pg_query` integration tests for the `$1`-without-params error path
  and the result-count-equals-`POSTGRES_MAX_ROWS` boundary (must NOT flag
  `truncated: true`).
- New `pg_explain` integration tests for `analyze: true` on a SELECT in
  read-only mode (works) and on an INSERT in read-only mode (errors with
  the ALLOW_WRITES hint).
- npm `keywords` expanded with `agent`, `claude`, `claude-code`, `cursor`,
  `llm` so registry / search engine queries for "postgres mcp claude code"
  surface this package.
- `POSTGRES_CONNECTION_TIMEOUT_MS` env var (default `10000`). Without it, a
  dead host hangs the first connection attempt until the OS times out
  (~2 minutes on most platforms), and the agent waits the whole time before
  surfacing an error.
- `pg_describe_table` now returns a `kind` field (`table` / `view` /
  `materialized_view` / `partitioned_table` / `foreign_table`). Previously
  the tool silently accepted views and matviews and returned columns with
  empty `primary_key` / `foreign_keys` / `indexes` -- correct, but an LLM
  couldn't tell whether the relation was writable.

### Changed
- README now states the supported Postgres versions: tested on 17 and 18,
  expected to work on 13+.

### Changed
- `pg_top_queries` now returns `calls` and `rows` as JS numbers (cast to
  `float8` in SQL) instead of strings. The previous `::text` cast forced
  consumers to parse `"42"` to use it; the timing fields next to them were
  already numbers, so the response shape was inconsistent. float8 is fine
  -- 2^53 is well above any realistic per-query call/row count.
- `pg_health` partial-failure shape: failed sub-queries now contribute to a
  top-level `_warnings: string[]` array, and the affected fields stay null
  instead of becoming `{error: "..."}`. Previously a failure of the size
  query made `data.database.size_bytes` resolve to `undefined` with no
  signal -- LLMs couldn't tell "missing" from "errored". This matches the
  `_warnings` convention `pg_describe_table` already uses.
- `shutdown()` now races `pool.end()` against a 5 s timer. `pool.end()`
  waits for in-flight queries with no upper bound, so a wedged query
  (frozen NFS, network hang) could leave the MCP server appearing stuck on
  exit until the OS reaped the TCP sockets.
- `pg_table_privileges` description tightened to spell out that omitting
  `table` returns privileges for every table in the schema.
- README now lists supported PG versions explicitly and groups workflow
  examples by single-tool / multi-tool intent.

### Fixed
- `pg_table_bloat` now uses `dead / (live + dead)` for `dead_ratio` instead of
  `dead / live`. The previous formula reported `0` for tables with `live = 0`
  even when `dead > 0`, hiding the most-bloated tables (an empty-shell table
  full of dead tuples is the textbook VACUUM target). The new formula is
  bounded `[0, 1]`, behaves correctly at edges, and the `WHERE` filter now
  excludes tables with both counters at 0 entirely. The `minDeadRatio`
  parameter description was updated to match.
- `npm test` now serializes test files with `--test-concurrency=1`. Unit tests
  in `api.test.ts` and `tools/admin.test.ts` both mutate `process.env`
  (`ALLOW_WRITES`, `POSTGRES_MAX_ROWS`, etc.); under Node's default parallel
  test-file scheduling these races could flap on CI.
- README integration-suite paragraph corrected: the schema is named
  `test_fixture`, not `postgres_mcp_integration`.
- `scripts/wsl-test-matrix.sh` derives `REPO_SRC` from its own location instead
  of a hardcoded `/mnt/c/Users/jeff/...` path. Anyone other than the original
  author can now run the matrix from their own clone.
- `release.sh` creates annotated tags (`git tag -a`) and pushes with
  `--follow-tags` instead of `--tags`. The previous `--tags` form pushed every
  local tag, including any unrelated experimental ones lying around;
  `--follow-tags` only pushes the tag(s) reachable from the commits being
  pushed -- but it ignores lightweight tags, so the tag-creation step had to
  switch to annotated to keep working.

## [0.3.2] - 2026-04-24

### Fixed
- `pg_explain` with `analyze: true` and `ALLOW_WRITES=1` no longer persists
  writes executed by `EXPLAIN ANALYZE`. Previously the write ran inside a
  `BEGIN; ... COMMIT` transaction, so `pg_explain { analyze: true, sql:
  "INSERT ..." }` would actually insert the row. Now writes run inside a
  `BEGIN; ... ROLLBACK` transaction — the plan (with real row counts and
  timing) comes back but the mutation is rolled back. This matches the user
  expectation when asking for a plan, and the tool description has been
  updated to reflect it.
- `pg_health` `table_count` now excludes `pg_temp_%` schemas, matching the
  filter in `pg_list_schemas`. The `relkind` filter already masked most
  divergence, but the two queries are now consistent.
- `pg_seq_scan_tables` ratio column simplified. The previous CASE had a
  branch that only fired when `idx_scan = 0 AND seq_scan = 0` (practically
  unreachable given the table was ordered by `seq_scan DESC`), returning
  `0` and implying a distinction that didn't exist. Now returns `NULL`
  whenever `idx_scan = 0`, which is the meaningful ratio-undefined case.

### Added
- `process.stdin` `end` handler cleans up the pg pool when the MCP client
  disconnects. Previously the server kept running for up to 60 seconds
  (the pool's idle timeout) after the parent closed the pipe.
- Shared `src/tools/params.ts` for the `paramValue` zod schema, previously
  duplicated verbatim in `query.ts` and `explain.ts`.

### Infrastructure
- Integration test suites now share one `before(setupFixtures)` /
  `after(teardownFixtures)` per file via an outer `describe`, instead of
  running DROP/CREATE per inner `describe`. Each file previously reset
  the fixture schema 3-4 times; now it resets once.

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
