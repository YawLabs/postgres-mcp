# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.12] - 2026-05-16

### Fixed
- `pg_inspect_locks` now resolves `relation` for the common case of row-level
  contention. Previously, `SELECT FOR UPDATE` + `UPDATE` row-level waits
  queued on a `transactionid` lock with `pg_locks.relation = NULL`, so the
  handler returned `relation: null` and gave the agent no hint as to which
  table was contested. A fallback subquery now resolves the contested table
  from the blocker's held write-intent relation locks (RowShareLock,
  RowExclusiveLock, etc.), filtering out plain SELECT's AccessShareLock so
  unrelated tables the blocker only read from don't show up. Closes #5.

## [0.6.11] - 2026-05-16

### Infrastructure
- Tightened the `pg_inspect_locks` real-contention test: replaced the
  500ms hardcoded sleep with a 5s polling loop on `pg_blocking_pids()`
  (avoids flakes on slow CI hosts and wasted time on fast ones), and
  moved the `waiterPromise` await into the `finally` block so an
  assertion failure mid-test still drains the queued waiter query
  rather than leaving a floating promise.

## [0.6.10] - 2026-05-16

### Infrastructure
- Closed six coverage gaps surfaced by a coverage audit. No behavior
  changes; each test pins a branch the existing suite exercised on only
  one side, or a structural property a regression could silently violate:
  - `pg_inspect_locks` real ACCESS EXCLUSIVE contention with two side
    clients. Covers the LATERAL `unnest(pg_blocking_pids(...))` and the
    per-(blocked, blocker) row shape the v0.6.6 description claims.
  - `pg_table_bloat` `minDeadRatio` threshold filter, as a relative
    property (filtered rows are at or above the threshold; baseline rows
    below the threshold are absent from filtered). Order-independent.
  - `pg_table_bloat` with-schema filter -- no cross-schema leakage when
    scoped.
  - `pg_seq_scan_tables` and `pg_unused_indexes` no-schema branch --
    spans user schemas and excludes `pg_*` / `information_schema`.
  - `pg_describe_table` on a materialized view -- `kind='materialized_view'`
    branch of the relkind CASE.

## [0.6.6] - 2026-05-16

### Docs
- `pg_table_privileges` description now flags the visibility caveat:
  `information_schema.table_privileges` is filtered by what the calling role
  can see, so a least-privileged role may miss grants involving unrelated
  third-party roles. Recommends superuser or `pg_read_all_data` for a
  complete picture.
- `pg_inspect_locks` description now documents the row shape: one row per
  (blocked_pid, blocking_pid) pair, so a session waiting on multiple
  blockers appears on multiple rows. Suggests grouping by `blocked_pid`
  for a per-blocked-session count.

## [0.6.5] - 2026-05-15

### Fixed
- `pg_explain` now returns an explicit error if EXPLAIN comes back with zero
  rows instead of a misleading `{plan: ""}` (text) or `{plan: undefined}`
  (json) payload. Pathological in practice -- EXPLAIN always returns at least
  one row -- but the response shape is now tight either way.

### Docs
- `pg_kill` description clarifies that `pg_signal_backend` does NOT authorize
  signalling a superuser-owned backend; only a superuser can signal another
  superuser's session. The `note` field already disambiguated post-hoc; the
  description now matches.

## [0.6.3] - 2026-05-15

### Infrastructure
- Closed the partial-failure coverage gap deferred in 0.6.2:
  `pg_replication_status` `_warnings`-populated path is now exercised
  by an integration test that REVOKEs `EXECUTE` on
  `pg_current_wal_lsn()` from PUBLIC, swaps `DATABASE_URL` to a
  fixture LOGIN role (`mcp_test_restricted`, CONNECT-only), rebuilds
  the pool, and asserts `ok=true` with `_warnings` populated,
  `is_replica: null` (not `false`), `wal_position: null`, and a
  42501-tagged `wal_position fetch failed` entry. The grant is
  restored unconditionally outside `finally` so the primary assertion
  error (if any) isn't shadowed by a cleanup throw.
- `pg_health`, `pg_describe_table`, and `pg_advisor` share the same
  partial-failure pattern but query catalogs PUBLIC can read;
  engineering a realistic partial failure for them would require
  revoking grants on catalog views, which would break the rest of the
  suite. The success-case shape assertions already in their tests
  protect the construction code from regression.
- No behavior changes for tool consumers.

## [0.6.2] - 2026-05-15

### Infrastructure
- Closed integration / unit coverage gaps surfaced by the coverage audit:
  `pg_kill` positive paths (cancel + terminate against an out-of-band
  `pg.Client` backend) and `signaled=false` on a non-postgres PID;
  `pg_advisor.public_tables_without_rls` and `sequence_exhaustion`
  positive cases (the latter pins the post-0.5.2 numeric-precision
  formula via a fixture sequence at 80%); `pg_unused_indexes` excluding
  unique + primary indexes (data-integrity hazard if regressed);
  `pg_search_columns` case-insensitive ILIKE; `pg_list_views` with
  `includeMaterialized=false`; `pg_list_roles.member_of` as a real
  JS `string[]` (0.3.1 regression guard via grouped fixture roles);
  `typeNameCache` miss-fill on a CREATE TYPE issued mid-session;
  `safeResolveTypeNames` fallback contract via a stub `PoolClient`
  whose `.query` rejects (helper exported with an
  `@internal -- for testing` note). Fixtures grew a materialized view,
  a `near_full_seq` sequence, and two cluster-scoped roles; teardown
  drops the roles in member-before-group order.
- No behavior changes for tool consumers.

## [0.6.1] - 2026-05-15

### Fixed
- `pg_advisor` `tables_without_primary_key` now includes partitioned-table
  parents (`relkind='p'`) alongside plain heap tables. A partitioned table
  with no PK is a real design-drift signal -- and the neighboring
  `public_tables_without_rls` check already covered both relkinds, so the
  inconsistency was an oversight. Partition children still inherit the
  parent's PK as an `indisprimary` index, so they remain filtered out by
  the existing `NOT EXISTS` clause.
- `pg_replication_status` now surfaces partial failures via a top-level
  `_warnings` array instead of short-circuiting on the first sub-query
  failure. Matches the convention already used by `pg_health`,
  `pg_describe_table`, and `pg_advisor`. When the WAL position lookup
  fails, `is_replica` is now `null` rather than `false` so a permission
  error can't be mistaken for "this is a primary."
- `identSchema` (shared schema/table/column-name validator) now enforces
  postgres's 63-byte `NAMEDATALEN` limit on byte length, not JS char
  length. A multi-byte identifier like 32x `é` (64 UTF-8 bytes) used to
  pass validation but postgres would silently truncate it; now it fails
  at the call boundary with a clear message. Centralized in `params.ts`
  so `schemas.ts`, `stats.ts`, `admin.ts`, and `explain.ts` share one
  definition. `pg_explain.hypothetical_indexes` validates the same byte
  limit per-piece on the `schema.table` form and per-column inside
  `validateHypoIndex`, so direct handler calls that bypass Zod still
  get the protection.
- `getSslConfig` now logs a one-shot stderr warning when
  `POSTGRES_SSL_REJECT_UNAUTHORIZED` is set to an unrecognized value
  (typo, empty string, ...). Previously the typo silently fell through
  to pg's default, indistinguishable from "env var unset" -- a connection
  with unintended TLS posture could land without any signal.

### Changed
- `pg_top_queries` extension-presence and version probes consolidated
  into a single catalog round-trip (was two). The actual stats query
  remains a second round-trip since the column names are version-dynamic.

## [0.6.0] - 2026-05-14

### Added
- New `pg_readonly` tool. Always runs inside `BEGIN READ ONLY` regardless of
  `ALLOW_WRITES`, so postgres itself rejects any write attempt. The point is
  to give hosts that gate tools individually (Claude Code permissions,
  mcp.hosting per-tool toggles) a stable always-safe target to auto-allow,
  independent of how the server is configured. Same input shape as `pg_query`
  (`sql` + `params`).
- New "Configuring access" README section walking through the recommended
  least-privileged-role posture: `CREATE ROLE mcp_reader ... GRANT
  pg_read_all_data` for read-only agents, and a `mcp_writer` example with
  table-level grants for scoped writes. The role is the primary access
  control; `ALLOW_WRITES` is positioned as secondary belt-and-braces.

### Changed
- `pg_query` description leads with role-based access control. `ALLOW_WRITES`
  is now framed as a secondary gate, with the role in `DATABASE_URL` as the
  authoritative one. No behavior change.
- README "Why this one?" read-only bullet expanded: `pg_query` continues to
  default to read-only via `BEGIN READ ONLY`, and `pg_readonly` is the new
  unconditional read tool. Configuration table and troubleshooting entry
  for `ALLOW_WRITES` updated to point at the Configuring access section.

## [0.5.3] - 2026-05-14

### Security
- Transitive deps patched via `npm audit fix`: in-range bumps to `hono`,
  `fast-uri`, `express-rate-limit`, and `ip-address`. All four reach us
  only through `@modelcontextprotocol/sdk`'s HTTP-transport path, which
  this server doesn't use (stdio only) and which esbuild tree-shakes out
  of `dist/index.js`. Practical exposure was already nil; this clears the
  audit noise on future `npm install` runs.

### Infrastructure
- `release.yml` smoke test now retries the `npx -y --version` call itself
  (6 x 10s) instead of probing `npm view` once and trusting the result.
  Registry propagation has two desynchronized CDN cache layers --
  `npm view` (metadata) and `npx -y` (tarball) can land on different
  edges and return inconsistent results. Observed on the v0.5.2 publish
  (2026-05-14): `npm view` returned 0.5.2 immediately but the subsequent
  `npx -y` got `ETARGET` and turned the Release workflow red despite a
  successful publish. The retry now covers both layers.

### Changed
- Dev dependencies bumped via Dependabot (`@biomejs/biome`, `zod`, plus
  transitives) -- in-range, dev-only.

## [0.5.2] - 2026-05-14

### Fixed
- `pg_describe_table` now emits a `kind fetch failed, reported as "table"`
  warning instead of silently defaulting to `"table"` when the kind query
  fails. The other partial-failure fields already followed this pattern; the
  `kind` field is reported at the top level so a silent default could
  mislabel a view or materialized view as a regular table.
- `pg_advisor` `sequence_exhaustion` divides `last_value / max_value` in
  `numeric` rather than `float8`. BIGINT sequences past 2^53 lose precision
  in `float8`, and the danger zone (>= threshold) is exactly where the
  reported `pct_used` needs to stay accurate. The WHERE filter and the
  reported value both switched.
- `pg_explain` `hypothetical_indexes` handler defaults `using` to `"btree"`
  defensively. The Zod schema already applies this default on the protocol
  path, but a unit-test-style direct handler call bypasses Zod -- so a
  missing `using` would render as `USING undefined` in the generated SQL and
  hypopg_create_index would surface a confusing syntax error. New
  integration regression test covers the omitted-`using` path against a real
  HypoPG-installed database.

### Changed
- `api.ts` `getPool()` docstring spells out the env-var snapshot semantics --
  which vars are bake-on-first-call (`DATABASE_URL`,
  `POSTGRES_STATEMENT_TIMEOUT_MS`, `POSTGRES_CONNECTION_TIMEOUT_MS`,
  `POSTGRES_POOL_MAX`, `POSTGRES_SSL_REJECT_UNAUTHORIZED`) and which are
  read per-request (`POSTGRES_MAX_ROWS`, `ALLOW_WRITES`). Previously a
  hidden assumption.
- `api.ts` `typeNameCache` comment now explains the OID-wraparound staleness
  bound: a `DROP TYPE` / `CREATE TYPE` in-session gets a new OID and the
  miss-fill path picks it up; the dead entry under the old OID is wasted
  memory, not a correctness bug.
- `scripts/wsl-pg-setup.sh` now carries DEV/CI ONLY warnings on the PG16
  purge and on the `0.0.0.0/0 md5` pg_hba stanza. Both are safe inside WSL
  but lethal as a production template -- the warnings prevent silent
  copy-paste into a real host config.
- `release.sh` Verify step uses the same 5x5s retry loop as the CI
  smoke test, instead of a one-shot `sleep 3 && npm view` that flaked on a
  slow registry.

### Infrastructure
- `release.yml` concurrency group locked to the literal string
  `release-npm` instead of an interpolated `${{ github.workflow }}` /
  `${{ github.ref }}`. The interpolated form fragmented across different
  tags (each ref-name got its own queue, defeating the serialization the
  group was meant to provide) and could silently re-fragment on a workflow
  rename. The literal key serializes all release runs into one queue.
- `release.yml` integration build step de-duplicated -- the redundant
  pre-publish `npm run build` was rebuilding the same artifact the
  `prepublishOnly` hook would build moments later. Removed.
- `release.sh` now creates annotated tags (`git tag -a`) and the workflow
  uses `git push --follow-tags`; lightweight tags are silently skipped by
  `--follow-tags`, which previously left `release.yml` un-triggered on
  manual tags.

## [0.5.1] - 2026-05-05

### Fixed
- Type-name lookup failures no longer drop the user's successful query
  rows. `runReadOnly` / `runReadWrite` / `runReadWriteRollback` now route
  catalog lookups through a `safeResolveTypeNames` wrapper that logs to
  stderr and falls back to `{}` on a transient `pg_type` error, instead
  of letting the catalog failure throw past the user's already-successful
  result.
- `release.sh` WSL matrix step uses a sed regex to translate Git Bash
  drive prefixes (`/c/`, `/d/`, ...) into the WSL form (`/mnt/c/`,
  `/mnt/d/`, ...). The previous hardcoded `/c/` broke contributors
  working from any other drive.

## [0.5.0] - 2026-05-04

### Changed
- **BREAKING:** `engines.node` raised from `>=18` to `>=20`. The CI matrix
  has been on `[20, 22]` since 0.4.1 and the integration + release jobs
  ran exclusively on Node 20+, so Node 18 was effectively unsupported in
  practice; this release makes the declared support match. esbuild
  `target` and `release.sh` prerequisite comment updated to match.

## [0.4.1] - 2026-05-04

### Changed
- Multi-query handlers (`pg_describe_table`, `pg_health`, `pg_advisor`,
  `pg_replication_status`) now share a single connection across their
  internal catalog fan-out via a new `withSharedClient` helper, so one
  tool call's 3-9 query fan-out can no longer saturate the pool (default
  max 5) and starve concurrent calls. Previously, a single
  `pg_describe_table` issued 9 parallel `Promise.all` queries against the
  pool; under concurrent load this could block other tool calls until
  the describe drained.
- `pg_top_queries` now returns `calls` and `rows` as text strings,
  matching the bigint serialization of `pg_seq_scan_tables`,
  `pg_unused_indexes`, and `pg_table_bloat`. Timing fields stay as JSON
  numbers since they are inherently fractional milliseconds.

### Fixed
- `runUserQueryBounded` now distinguishes "DECLARE failed" (re-running
  on the direct-exec path is safe -- the user SQL never executed) from
  "FETCH/CLOSE/RELEASE failed" (re-running could double-execute side
  effects). Previously, a transient FETCH-time failure on a
  RETURNING-DML statement would silently re-run the mutation.
- `pg_top_queries` `orderBy: "calls"` now sorts numerically rather than
  lexically. The 0.4.1 change to return `calls` as `text` shadowed the
  source bigint column with a text output alias in the ORDER BY, so
  "9" beat "10". The fix qualifies the ORDER BY expression with the
  source table. Caught in the post-implementation review before tagging.
- `pg_describe_table` "not found" error message now escapes user-supplied
  schema/table names via `JSON.stringify`, so a name containing `"` no
  longer renders as broken-looking nested quotes.
- `pg_explain` `hypothetical_indexes` now pre-flight rejects pre-quoted
  identifiers (`"odd.name"`, `weird"col`) with a clear validation error
  before opening a database connection, instead of producing a confusing
  planner error after the fact.

### Added
- New CI release plumbing mirroring `@yawlabs/tailscale-mcp`:
  `.github/workflows/ci.yml` (lint + build + test on push/PR across
  Node 18/20/22), `.github/workflows/integration.yml` (PG17 + PG18
  service-container matrix, scheduled nightly + on-demand), and
  `.github/workflows/release.yml` (tag-pushes-trigger-publish gated
  on integration). `npm publish` now runs in CI with `--provenance`
  via the org-level `NPM_TOKEN`; `release.sh` retains a local-dev
  path that runs the WSL integration matrix as a pre-flight when
  cutting a release from a workstation.
- New regression tests:
  - `compareVersions` unit tests covering pre-release tags,
    missing/longer segments, and the actual `1.8` boundary used by
    `pg_top_queries`.
  - Integration guard that partition children inheriting a parent's
    primary key are correctly excluded from `pg_advisor`'s
    `tables_without_primary_key` list.
  - Integration coverage for the cursor-fallback path on both DDL
    (`CREATE TABLE`) and DML-without-RETURNING (`INSERT`).

## [0.4.0] - 2026-04-25

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
- New `pg_advisor` tool: rolled-up DBA lints in one call. Returns three
  categories of findings -- `sequence_exhaustion` (sequences whose
  last_value is past `seqExhaustionThreshold` of max_value, default 50%;
  the classic "BIGINT, eventually" incident class), `tables_without_primary_key`
  (bloat candidates and a sign of design drift), and
  `public_tables_without_rls` (default `public`; configurable via
  `rlsSchemas`). Use as the "what should I be looking at?" starting
  point and drill into `pg_unused_indexes` / `pg_table_bloat` /
  `pg_seq_scan_tables` for the perf side.
- `pg_explain` accepts a `hypothetical_indexes` parameter -- list of
  `{table, columns, using?}` -- which asks the planner "what would the
  plan be if these indexes existed?". Requires the
  [HypoPG](https://github.com/HypoPG/hypopg) extension
  (`CREATE EXTENSION hypopg;`); the tool returns a friendly hint pointing
  at that command if HypoPG isn't installed. Indexes are session-scoped
  and torn down at the end of the call via `hypopg_reset()`, so they
  never persist across MCP requests and never touch real disk. Closes
  the biggest competitive gap vs. Crystal DBA's Postgres MCP Pro per
  the comp-landscape audit. WSL setup script now installs the
  `postgresql-${V}-hypopg` package opportunistically; the matrix test
  runs against PG17 and PG18 and verifies the planner switches a Seq
  Scan to an Index/Bitmap scan when a hypothetical index is supplied.
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
  `BEGIN; ... ROLLBACK` transaction - the plan (with real row counts and
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
  rejects since `ESCAPE` requires a single character - so the whole filter
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
- `pg_list_views` - list views and materialized views with SQL definitions.
- `pg_list_functions` - list functions, procedures, and aggregates with signatures.
- `pg_list_extensions` - list installed extensions (pgvector, postgis, etc.) with versions.
- `pg_search_columns` - find columns by name pattern across all user schemas.
- `pg_top_queries` - top N queries by total/mean execution time from
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
- `pg_inspect_locks` - show current blocking locks (blocked PID, blocker PID,
  relation, lock type, both queries). First tool to reach for when a session
  hangs or the app feels stuck.
- `pg_list_roles` - database roles with login/superuser/createdb/createrole
  flags and inherited group memberships.
- `pg_table_privileges` - who has SELECT/INSERT/UPDATE/DELETE/etc. on a table,
  or on all tables in a schema. Useful for pre-migration audits.
- `pg_seq_scan_tables` - tables with heavy sequential scans relative to index
  scans. Missing-index candidates.
- `pg_unused_indexes` - non-unique, non-primary indexes with low/zero scan
  counts. Drop candidates (each unused index costs write amplification).
- `pg_kill` - cancel a running query or terminate a backend by PID. Requires
  `ALLOW_WRITES=1` since it changes session state. Distinguishes `cancel`
  (SIGINT-equivalent, graceful) from `terminate` (SIGTERM, forceful).
- `pg_table_bloat` - estimate dead tuples and vacuum-candidate tables from
  `pg_stat_user_tables`. No extensions required.
- `pg_replication_status` - replication slots, connected replicas with lag,
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
- `pg_query` - run SQL with read-only-by-default safety. Writes opt in via `ALLOW_WRITES=1`.
- `pg_list_schemas` - list non-system schemas.
- `pg_list_tables` - list tables (and optionally views) with estimated row counts.
- `pg_describe_table` - columns, PK, FKs, indexes.
- `pg_explain` - `EXPLAIN` / `EXPLAIN ANALYZE` with text or JSON output.
- `pg_health` - server version, db size, connections, active queries, table count.
- Single-file bundled distribution (zero runtime deps) for fast `npx` cold starts.
- Result row truncation at `POSTGRES_MAX_ROWS` (default 1000).
- Parameterized queries via `params` on `pg_query` and `pg_explain`.
