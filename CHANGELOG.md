# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.

### Documentation

- **The README now carries a "What's new in 0.11.0" section.** The three
  breaking changes lived only in this file, where someone upgrading from
  0.10.x is unlikely to look before their first failing call -- and the
  stats-envelope change fails at the call site rather than at install time,
  since `data` becomes an object where it used to be an array.
- **Both WSL scripts and the README document the `MSYS_NO_PATHCONV=1` prefix
  they require when invoked from Git Bash on Windows.** Without it, Git Bash
  rewrites the `/mnt/c/...` argument into the Git install prefix before
  `wsl.exe` sees it, and the script exits "No such file or directory" having
  run no tests at all. Piping either script into `tail`/`head` is also called
  out, because the pipeline's exit status is the last command's -- so a red
  matrix reports success.

## [0.11.0] - 2026-08-23

### Added

- **`pg_io_stats`, a new tool for I/O observability.** `pg_stat_io` read /
  write / extend / fsync counts, bytes and times per backend type and context
  (PG16+), plus in-flight async I/O handles from `pg_aios` and the active
  `io_method` (PG18+). Byte accounting differs by server: PG16-17 expose
  `op_bytes` to multiply against operation counts, and PG18 removed it in favour
  of direct `read_bytes` / `write_bytes` / `extend_bytes`. Both branches are
  normalized to one figure, and neither ever names the other's column.

- **Server-version gating.** `getServerVersionNum()` in `api.ts` caches
  `server_version_num` per process and every version-dependent column now routes
  through it. A failed probe returns 0, the "assume oldest" sentinel, so an
  unknown server falls through to the conservative query rather than emitting
  SQL referencing a column it may not have. Probe failures are deliberately not
  cached: one transient blip during the first tool call would otherwise pin the
  process to degraded output for its whole lifetime.

- **`pg_describe_table` flags generated and identity columns.** `pg_attrdef`
  stores generation expressions alongside plain defaults, so a generated
  column's expression was surfacing as `default_value` with nothing marking it
  -- an agent read that as "optional column, has a default" and wrote an INSERT
  postgres rejects. Identity columns failed the other way: no `pg_attrdef` row
  at all, so they reported `default_value: null, nullable: false` and the agent
  supplied a value into `GENERATED ALWAYS AS IDENTITY`. Columns now carry
  `generated`, `identity`, and `generation_expression`.

- **PG18 constraint metadata in `pg_describe_table`.** Constraints carry
  `validated` on every version, plus `enforced` and `has_period` on PG18+. A
  `NOT ENFORCED` foreign key looks present but validates nothing, and a temporal
  `WITHOUT OVERLAPS` primary key previously rendered as an ordinary one. PG18
  also made NOT NULL a real `pg_constraint` row that can be `NOT VALID` -- its
  `attnotnull` docs now read "possibly invalid" -- so `not_null_validated` is
  reported on PG18+, where the question can arise.

- **`pg_explain` gained the planner options that actually diagnose a slow
  query**: `buffers`, `settings`, `verbose`, `wal`, `costs`, `timing`, plus
  `generic_plan` (PG16+) for planning a parameterized query with no values, and
  `memory` / `serialize` (PG17+). Options below the server's version are
  rejected up front by name and required major, rather than as a parse error
  from the server.

- **`pg_health` reports what a health check needs.** `max_connections` and a
  used-fraction (so a connection count is readable), `wait_event_type` /
  `wait_event` / `backend_type` / transaction age on active queries, and a
  `pg_stat_database` rollup: deadlocks, temp files and bytes, conflicts, cache
  hit ratio, `stats_reset`.

- **`pg_advisor` checks wraparound risk**, the classic pageable incident:
  per-database and per-table `age(relfrozenxid)` measured against
  `autovacuum_freeze_max_age`, with a `wraparoundThreshold` parameter mirroring
  the existing sequence-exhaustion one. Freeze coverage via `relallfrozen` on
  PG18+.

  Multixact wraparound is checked alongside it, on the same rows and with no
  extra round trip: `mxid_age(relminmxid)` against
  `autovacuum_multixact_freeze_max_age`. Multixacts are consumed by row-level
  locking (`SELECT ... FOR SHARE/UPDATE`, foreign-key checks), so a lock-heavy
  workload can exhaust them while `relfrozenxid` still looks perfectly healthy
  -- checking only xids reports such a cluster as clean. A row is flagged when
  EITHER counter crosses the threshold, and `triggered_by` (`xid` /
  `multixact` / `both`) says which, because the remediation differs.

- **`pg_health` connection buckets now reconcile against `total`.** Two
  separate ways the old breakdown lied. First, `pg_stat_activity` does not hide
  other users' sessions from an unprivileged role -- it returns the rows with
  `state` NULL -- so `total` was complete while `active` / `idle` counted only
  the caller's own sessions, and an operator could read `active: 0` on a busy
  database. A `state_unavailable` counter now makes that shortfall visible.
  Second, `idle in transaction (aborted)`, `starting`, `fastpath function
  call`, and `disabled` matched no filter and vanished from the breakdown; the
  aborted state is the one that holds locks and blocks vacuum, so it gets its
  own field, and an `other` catch-all absorbs the rest (a `NOT IN` list, so a
  future major's new state cannot silently disappear again).

- **`POSTGRES_APPLICATION_NAME`** (default `postgres-mcp`), so agent traffic is
  identifiable in `pg_stat_activity` instead of anonymous -- while `pg_health`
  itself reports `application_name` for every other session. An
  `application_name` in `DATABASE_URL` still wins.

### Changed

- **BREAKING: `pg_seq_scan_tables` and `pg_unused_indexes` return an envelope,
  not a bare row array.** `data` is now
  `{rows, stats_reset, stats_reset_age_seconds}`; callers read `data.rows`.
  The reason is `pg_unused_indexes` could tell an agent to drop a load-bearing
  index: a scan count is meaningless without knowing when the counters were
  reset, and if that happened an hour ago every index looks unused. Both tools
  also report `last_idx_scan` / `last_seq_scan` on PG16+, where "not scanned
  since March" beats a bare counter.

- **BREAKING: `pg_top_queries` returns the same envelope**, for the same
  reason -- it ranks cumulative `total_exec_time` / `calls`. Its clock is NOT
  `pg_stat_database.stats_reset` but `pg_stat_statements_info.stats_reset`, a
  genuinely independent reset point; using the wrong one would have been worse
  than omitting it. The same view supplies `dealloc`, which is the subtler
  trap: it counts how often entries for the least-executed statements were
  evicted for exceeding `pg_stat_statements.max`, so a non-zero value means
  the "top queries" ranking is drawn from an incomplete population. Both
  require extension 1.9 (PostgreSQL 14) and are omitted below it rather than
  returned as nulls that would read as "never reset".

- **BREAKING: `pg_explain` with `analyze: true` now emits `BUFFERS`.** PG18
  turns it on by default server-side; on PG15-17 it had to be requested and was
  absent. Plans gain buffer lines, so text plans roughly double in length and
  `POSTGRES_MAX_ROWS` truncation can fire where it previously did not. Pass
  `buffers: false` for the old output.

- **BREAKING: the Node floor is now 22.** Node 20 reached end of life; the
  supported lines are 22, 24 and 26. The esbuild target deliberately stays at
  `node20` -- it only controls syntax downleveling, so a lower floor keeps the
  bundle runnable under alternate runtimes.

- **Tools register through `registerTool` instead of `server.tool`.** All six
  `server.tool` overloads are deprecated as of SDK 1.30 and are gone in the v2
  packages. `registerTool` is also the only form that can carry `outputSchema`,
  so this is what makes structured tool output reachable later. Tools now
  advertise a top-level `title` as well as `annotations.title`; both are emitted,
  since dropping either regresses hosts that read only one.

- **`@modelcontextprotocol/sdk` 1.29.0 -> 1.30.0** (the final v1.x release) and
  **`pg` ^8.14.0 -> ^8.23.0**. The pg bump makes `sslnegotiation=direct`
  available in `DATABASE_URL`, which skips a round trip against PG17+ servers;
  it stays opt-in because a PG16-or-older server rejects the connection.

- **Documented where PostgreSQL support actually sits.** PG13 reached end of
  life on 2025-11-13 and PG14 does so on 2026-11-12. The integration matrix
  remains 15 / 17 / 18.

### Fixed

- **`POSTGRES_APPLICATION_NAME` was missing from the oam sandbox allowlist.**
  Under `POSTGRES_MCP_SANDBOX=1`, oam removes an undeclared variable from
  `process.env` rather than denying access, so the operator's configured name
  would have silently vanished and the server would have reported the default
  -- precisely the silent-misbehaviour failure the launcher's own comment warns
  about. `PGAPPNAME` is now granted too, since the pg driver reads it as its
  own fallback for the same setting. A new test scans the shipped bundle for
  literal `process.env` reads and fails if any config variable is absent from
  the allowlist, so the next one cannot ship silently.

- **`pg_io_stats` had no test coverage at all.** `tools.test.ts` builds its own
  `allTools` array separate from `index.ts`, and the new tool was added to one
  and not the other -- exempting it from every structural check, including the
  duplicate-name guard. Both arrays now agree, and the tool has a unit suite
  covering its version branches.

- **A version probe suspended across `shutdown()` could republish a stale
  server version.** `shutdown()` clears the cache, but a probe already awaiting
  its query would resolve afterwards and write the OLD server's version into
  the cache the NEW pool uses -- gating catalog queries against the wrong
  server, the exact failure the reset exists to prevent. A generation counter
  now invalidates in-flight probes, matching the guard `resolveTypeNames`
  already had.

- **Four `pg_explain` tests asserted the wrong thing whenever `DATABASE_URL`
  was set.** Their helper cleared the env var to force the version probe's
  "unknown" sentinel, but the pool and the version cache are module-scoped and
  survive that, so on any machine with `DATABASE_URL` exported the probe never
  re-ran. The suite passed or failed depending on the developer's environment.
  The helper now calls `shutdown()` on both edges.

### Security

- **`fast-uri` bumped past the host-confusion advisory (GHSA, high).** It
  reaches the published artifact rather than staying a build-time concern: the
  MCP SDK depends on `ajv`, which depends on `fast-uri`, and esbuild bundles the
  whole graph into `dist/index.js`. "It is only a devDependency" is not the
  right test for this package -- the bundle is what ships, and the dependency
  tree is flattened into it. `npm audit` now reports zero vulnerabilities.

## [0.10.0] - 2026-08-08

### Added

- **An opt-in `--permission` sandbox under oam**, via `POSTGRES_MCP_SANDBOX=1`.
  The network grant is derived from `DATABASE_URL` at launch rather than
  hardcoded, so the one endpoint the server may reach is the one it was
  configured to reach. Host and port are both pinned, because oam matches grants
  by prefix and a bare host would also admit every other port on it. Filesystem
  and child-process are denied outright.

  Opt-in rather than default because a wrong grant does not fail loudly: oam
  denies a non-granted environment variable by making it **absent** from
  `process.env` rather than throwing, so an under-granted `DATABASE_URL` would
  read as "not configured" instead of "denied". The environment allow-list is
  derived from what the shipped bundle actually reads, which is why it includes
  the pg driver's own lookups (`PGSSLMODE`, `PGCONNECT_TIMEOUT` and friends) that
  a hand-written list would have missed.

### Changed

- **oam 0.9.0 is now the minimum**, enforced in `bin/postgres-mcp.mjs`. Older
  releases ran `child_process.execFile` arguments through a shell, accepted
  `exec`'s `timeout` and ignored it, truncated `spawnSync` at `maxBuffer` while
  reporting success, and treated `stdio: 'inherit'` as `'pipe'`. This server
  spawns nothing, so the floor is enforced for consistency across
  `@yawlabs/*-mcp` rather than because this launcher was exposed. An older oam is
  not an error: the launcher falls back to Node and says so on stderr, and
  `POSTGRES_MCP_RUNTIME=oam` turns that into a hard error.

### Fixed

- **`release.sh` aborted instead of releasing when `[Unreleased]` was empty.**
  The body extraction pipes through `grep -v` to drop blank lines, and `grep`
  exits non-zero when it matches nothing — so under `set -e` an empty section
  killed the script at that line, and the `warn` branch written to handle
  exactly that case could never run.

## [0.9.1] - 2026-08-07

### Fixed

- **Corrected the runtime startup figures published in 0.9.0.** They were wrong
  in both magnitude and direction, and the README used them to advise opting
  out of the faster runtime.

  The 0.9.0 numbers (Node ~650-900ms, oam ~980-1290ms, launcher-to-oam ~1.8s)
  were measured against cold, freshly-built binaries. On Windows a binary that
  is not in the on-access scanner's cache is rescanned on every exec, while
  `node` resolved from PATH was cached long ago -- so the comparison measured
  the scanner and put the entire penalty on the binary under test.

  Re-measured on the same hardware with every binary warmed first, mean of 12
  runs, `postgres-mcp version` (full module init):

  | path | startup |
  |---|---|
  | standalone binary (`oam compile`) | 298ms |
  | `oam run dist/index.js` | 306ms |
  | `node dist/index.js` | 358ms |
  | launcher -> Node (in-process) | 370ms |
  | launcher -> oam (spawn) | 409ms |

  oam starts faster than Node. What the launcher costs is the spawn: reaching
  oam means Node has already booted, and that ~100ms hop outweighs oam's ~52ms
  advantage, so the two land within ~40ms of each other through the npm `bin`.
  `POSTGRES_MCP_RUNTIME=node` remains available but is now a marginal
  difference, not the meaningful one 0.9.0 described.

  No behavior changed -- `auto` (prefer oam) was and remains the default, and
  it was the right default for the wrong stated reason. README, CHANGELOG, and
  the launcher's header comment are corrected; the launcher comment also
  records the measurement trap so the mistake is not repeated.

## [0.9.0] - 2026-08-07

### Added

- The `postgres-mcp` command is now a runtime launcher (`bin/postgres-mcp.mjs`)
  that prefers the [oam](https://oamjs.org) runtime and falls back to Node.
  Selection is via `POSTGRES_MCP_RUNTIME` (`auto` | `oam` | `node`, default
  `auto`) and `OAM_BIN`.

  The fallback costs nothing: npm already started Node to run the launcher, so
  falling back is an `import()` into that same process -- no second spawn, no
  extra startup, behavior identical to running `dist/index.js` directly. Users
  without oam see no change and no stderr noise.

  Equivalence on the oam path is verified end to end, not assumed: all 21 tools
  register, a live query returns identical rows and `dataTypeName` values, and
  the error paths match. oam provides every `node:` builtin the pg driver needs
  (`net`, `tls`, `crypto`, `dns`), so SCRAM auth and the extended query protocol
  both work.

  **Latency, stated plainly:** taking the oam path means Node has booted first,
  so both startups are paid. On windows-arm64 against the 1.4 MB bundle, Node
  alone is ~650-900ms, oam alone ~980-1290ms, and launcher-to-oam ~1.8s. That is
  a one-time cost per MCP session rather than per tool call, but it is a real
  regression against plain Node -- `POSTGRES_MCP_RUNTIME=node` opts out.

  > **These figures are wrong. See 0.9.1.** They were measured against cold,
  > freshly-built binaries and reflect the Windows on-access virus scanner, not
  > either runtime. oam is in fact faster than Node here. Left in place rather
  > than rewritten so the correction has something to point at.

## [0.8.0] - 2026-08-07

### Changed (breaking)

- `QueryResult.command` is now OPTIONAL, and is omitted entirely for statements
  that run on the cursor path (every SELECT and other row-returning statement).
  Previously it reported `"FETCH"` for all of them -- the command tag of the
  internal `FETCH`, not of the user's statement. Postgres does not surface the
  inner tag through a cursor and there is no source of truth to substitute, so
  the field is absent rather than wrong. It is still present and correct on the
  direct-exec path (DDL and DML without `RETURNING`), where node-pg reports the
  first word of the real tag: `CREATE`, `INSERT`, etc.
- `rowCount` no longer exceeds `rows.length` on a truncated cursor-path result.
  The bounded fetch deliberately reads `POSTGRES_MAX_ROWS + 1` rows to detect
  truncation, and that extra probe row was leaking into `rowCount` -- callers
  saw `rowCount: 1001` next to 1000 rows. The direct-exec path is unchanged and
  still reports the AFFECTED-row count, which is independent of how many rows
  come back: a truncated `INSERT ... RETURNING` of 10 rows correctly reports
  `rowCount: 10`, `rows.length: 3`, `truncated: true`.
- `pg_top_queries` is now scoped to the database in `DATABASE_URL`.
  `pg_stat_statements` is cluster-wide, so on a shared cluster the tool
  previously returned normalized query text from unrelated databases. Results
  are filtered by `dbid`, matching every other tool in this server. Callers who
  relied on the cluster-wide view will see fewer rows.
- The CLI now exits 1 with a usage message on an unrecognized bare argument
  instead of silently starting the stdio server. `postgres-mcp doctor` used to
  print nothing and appear to hang while the server waited for MCP framing on
  stdin. Arguments beginning with `-` are still passed through untouched so
  host-supplied flags keep working, and a positionally-passed connection string
  gets a targeted message pointing at the `DATABASE_URL` env block.

### Fixed

- `pg_describe_table` no longer reports `INCLUDE` (covering) columns as part of
  `primary_key`. PostgreSQL 11+ allows `PRIMARY KEY (id) INCLUDE (label)`, and
  the covering column sits in `pg_index.indkey` next to the key column; the
  query matched the whole vector. An agent reading that would build an invalid
  `ON CONFLICT (id, label)` target. The key columns are now bounded by
  `indnkeyatts`.
- `resolveTypeNames` no longer throws when `shutdown()` lands mid-flight. The
  module-scoped type cache is nulled by `shutdown()`, and dereferencing it after
  an await (SIGTERM during a tool call, or a test calling `shutdown()` between
  calls) raised on null -- silently costing the response its `dataTypeName`
  fields. The cache is now bound to a local before the first await.
- Zod schema defaults are re-applied consistently by every tool handler for
  direct (non-MCP) callers, which bypass schema parsing. Previously only
  `pg_explain` and `pg_table_bloat` did this; `pg_advisor` in particular bound
  `undefined` into `n.nspname = ANY($1)` and errored at bind time. `pg_kill`
  defaults to the safer `cancel` mode, so an omitted `mode` can never escalate
  to `terminate`.

### Documentation

- `pg_readonly`'s description and the README now state the actual scope of
  `BEGIN READ ONLY`: it bounds writes to the DATABASE, not every side effect.
  Functions whose effect lands outside the table data -- `pg_terminate_backend`,
  `pg_cancel_backend`, `pg_read_file`, `lo_export`, `COPY ... TO PROGRAM` -- are
  not blocked by it and are not behind the `ALLOW_WRITES` gate that `pg_kill`
  sits behind. All of them still require privileges the `DATABASE_URL` role must
  hold, so the ROLE is what actually bounds this tool. Auto-allow `pg_readonly`
  with a least-privileged role.
- `release.sh` no longer suggests `npm login --auth-type=web` on an E401/E404.
  That command overwrites the automation token in `~/.npmrc` with a
  WebAuthn-bound session, and the next publish then fails on a challenge no
  script can answer. It now points at restoring the automation token.
- Removed stale references to a CI pipeline this repo does not have: there is no
  `.github/`, the binary build and the lint gate are both local.

### Testing

- `src/index.test.ts`: the CLI entrypoint had no automated coverage at all (it
  cannot be imported -- it calls `server.connect` at the top level), including
  the argv handling that runs before server startup. Now driven as a child
  process: both version flags, the argv guard's three branches, and a full MCP
  `initialize` + `tools/list` handshake that covers the tool-registration wiring.
- Coverage for the `DECLARE`-succeeded / `FETCH`-failed branch of
  `runUserQueryBounded`, which prevents re-executing a statement whose side
  effects already landed. Engineered with a short `statement_timeout`; a
  sequence acts as the double-execution detector, since `nextval` is
  non-transactional and survives the rollback.
- Coverage for `dbid` scoping (with a positive control proving the assertion is
  not vacuous), the truncated `INSERT ... RETURNING` row count, `command`
  presence on both paths, `PRIMARY KEY ... INCLUDE`, composite-PK ordering,
  `shutdown()` mid-bootstrap, and `getPool()` without `DATABASE_URL` including
  the win32-only hint branch.
- `scripts/wsl-pg-setup.sh` now provisions PostgreSQL 15 alongside 17 and 18,
  adds `pg_stat_statements` to `shared_preload_libraries`, and creates
  `pg_stat_statements` + `pgstattuple`. Without those extensions present, every
  `pg_top_queries` test and both `pg_table_bloat` `approx`/`exact` tests took
  their "extension not installed" early return and proved nothing about the
  tool's SQL. PG15 is there for column coverage, not recency:
  `pg_stat_statements` renamed `blk_read_time` to `shared_blk_read_time` in 1.11
  (PG17), and with only 17/18 in the matrix the pre-1.11 branch was never
  selected.

## [0.7.0] - 2026-07-21

Backfilled from `git log v0.6.20..v0.7.0` -- this release shipped without a
CHANGELOG entry. Summarized from commit subjects rather than re-derived from
the diff, so it is less detailed than the entries around it.

### Added

- `pg_table_bloat`: `approx` and `exact` methods via `pgstattuple` (#19).
- `pg_top_queries`: `io_read_time_ms` / `io_write_time_ms` on
  `pg_stat_statements` >= 1.10 (#16).
- Cross-platform single-binary release pipeline (Scoop + Homebrew), released
  as 0.6.21.

### Fixed

- `pg_list_tables`: cast `reltuples` to `float8` so `estimated_rows` is a
  number rather than a string (#17).
- 10 confirmed findings from a review of `f7b7cb3..a736200` (#21).

### Removed

- GitHub Actions workflows and the dependabot config (#24). This is why the
  repo has no `.github/` directory and why `release.sh` is the only release
  path; several stale comments referring to CI survived until 0.8.0.

## [0.6.20] - 2026-06-04

### Fixed
- `wrapToolHandler` now distinguishes a handler that returned a non-`ApiResponse`
  value (null, a primitive, a raw object) from a handler that returned
  `{ok: false}`. The former surfaces `"Error: tool handler returned a malformed
  result (missing ok)"`; the latter still surfaces `"Error: <error>"`. A
  misbehaving handler no longer collapses into the generic `Unknown error` path.
  `wrapToolHandler` is also now exported from `mcp-wrapper.ts` and covered by
  a dedicated unit test (`mcp-wrapper.test.ts`), so the production mapping is
  exercised without standing up `index.ts` and the stdio transport.
- `index.ts` resolves `package.json` by walking up from the emitted module path
  rather than via a hard-coded `"../package.json"`. A non-trivial `tsc` emit
  layout (e.g. `dist/src/index.js`) used to crash startup with an unresolvable
  require. Verified against the current `outDir: "dist"` layout; future layout
  changes don't need an `index.ts` patch.
- Shutdown is now idempotent. SIGINT, SIGTERM, and `stdin.end` can all fire
  near-simultaneously when a client closes the connection while the shell also
  sends a signal. An `exiting` flag short-circuits the second and third so
  `shutdown()` and `process.exit()` don't race.
- `index.ts` no longer fakes a `version` string when `__VERSION__` is unset
  (which only happens on a plain `tsc` build, not the esbuild bundled output).
  The new `readPackageVersion()` throws a clear error if it can't find
  `package.json` rather than silently emitting a malformed banner.

### Security
- `paramValue` (used by `pg_query`, `pg_readonly`, `pg_explain` for positional
  parameters) now uses `.finite()` on the number member, so `NaN`, `Infinity`,
  and `-Infinity` are rejected at the MCP boundary. Without `.finite()`, pg
  serializes the JS number to the literal string `'NaN'` / `'Infinity'`, which
  the server happily accepts on a text column and rejects opaquely on a numeric
  one. Now the request is rejected before it ever hits the database.
- `identSchema` dropped its redundant `.max(63)` so the byte-length `.refine`
  is the sole length guard. A 64-ASCII-char string now surfaces the tailored
  "exceeds PostgreSQL's 63-byte NAMEDATALEN limit" message instead of Zod's
  generic "at most 63 character(s)" -- agents that read the message act on it
  correctly.

### Added
- `pg_explain` rejects pre-wrapped `EXPLAIN ...` SQL with a clear hint. An LLM
  that calls the tool with `sql: "EXPLAIN ANALYZE SELECT ..."` no longer
  becomes the double-`EXPLAIN` syntax error from the server; the handler
  short-circuits with "the `sql` parameter should be the query to explain, not
  an EXPLAIN statement." Also re-applies Zod defaults (`analyze`, `format`,
  `using`) on the direct-call path so unit tests that bypass Zod still hit
  the documented behavior.
- `pg_explain` hypothetical_indexes pre-flight rejects over-qualified
  `schema.table.extra` table names, not just pre-quoted / over-63-byte ones.
  An `a.b.c` form previously rendered as `"a"."b"."c"` and surfaced a
  confusing planner error; now it's rejected with a clear message.
- `pg_describe_table` populates `_warnings` even when the `kind` sub-query
  returned zero rows (not just when it errored). The `?? "table"` default
  would otherwise silently mislabel a relation that was dropped between the
  `columns` and `kind` fetches.
- `pg_health` warns when the version sub-query returned zero rows (rather
  than silently emitting `version: undefined`). Symmetric with the other
  four sub-queries.
- Per-tool `inputSchema parses a type-correct sample input` test in
  `tools.test.ts`. Catches drift between the schema's declared shape and
  the keys the handler destructures at runtime. Uses public Zod 4
  constructors (`instanceof z.ZodString`, etc.) -- the `_def` introspection
  path is brittle across Zod majors.

### Docs
- `pg_query` description now leads with "Postgres itself is the primary
  safety gate" and presents `ALLOW_WRITES=1` as a secondary belt-and-braces.
  Pre-0.6.20 the order implied `ALLOW_WRITES` was the primary control, which
  is the opposite of the recommended posture (a least-privileged role in
  `DATABASE_URL`).
- `getPool()` env-var snapshot comment now leads with which two values
  (`getMaxRows`, `isWritesAllowed`) are intentionally re-read per request,
  with rationale, instead of burying the re-read list at the end of a
  paragraph about the snapshot.

### Infrastructure
- `release.sh` accepts `REQUIRE_MATRIX=1`. When set, the existing "WSL Ubuntu
  not detected" warning becomes a hard `fail`; default behavior is unchanged
  (warn-only so contributors without WSL can still tag). The matrix remains
  a local-only pre-tag gate; this is just an opt-in fail-fast.
- `package.json` `package-lock.json` and `server.json` all bumped to 0.6.20.

## [0.6.19] - 2026-06-02

Release-flow hardening; no library behavior changes shipped in this version.

### Fixed
- `release.sh` refuses to push when origin already has `v<version>` pointing
  at a different commit (rewound tag elsewhere, parallel release race) --
  previously `git push --follow-tags` silently skipped the stale tag and the
  GitHub release linked the wrong commit. Compares tag-object SHAs so resume
  runs don't false-abort.
- README "Add to Yaw MCP" badge points at the https forwarder so it renders
  as a link on github.com (raw `yaw://` hrefs are stripped).

### Added
- `SKIP_LINT=1` escape hatch in `release.sh` for hosts where the npm
  run-script wrapper segfaults on exit-cleanup (MINGW64-ARM64).
- `wrapToolHandler` extracted from `index.ts` for testability, with unit
  coverage of the MCP result wrapper and the connect-failure path (expanded
  further in 0.6.20).

## [0.6.18] - 2026-05-28

### Changed
- Release publishing consolidated into `release.sh`: the MCP Registry publish
  moved into the script and `release.yml` (plus the non-release CI workflows)
  was dropped. The script hands off to CI when a CI publish path exists and
  publishes from the workstation otherwise.

### Fixed
- `release.sh` syncs `server.json` unconditionally, not only inside the bump
  branch, so a resume run no longer asks mcp-publisher to re-publish the
  previous version (400 duplicate-version).
- `release.sh` falls back to the gh CLI session token when
  `MCP_REGISTRY_TOKEN` is unset.
- The release confirmation prompt is tty-gated so non-interactive runs don't
  hang on `read`.

### Docs
- README install badge swapped to the "Add to Yaw MCP" deep link; `npx`
  spawn examples pinned to `@latest` for auto-update.

## [0.6.17] - 2026-05-19

### Added
- `release.sh` accepts an optional pre-release commit message as a second
  argument: runs the pre-commit checklist, commits tracked changes, then
  proceeds with the release.
- Post-publish smoke script (`scripts/post-publish-smoke.sh`) wired into the
  release flow -- exercises the published tarball via a real `npx` install
  instead of trusting `npm view` registry metadata.

## [0.6.16] - 2026-05-18

### Tests
- The `pg_replication_status` `_warnings` integration test (which
  `REVOKE`s `EXECUTE ON pg_current_wal_lsn()` from `PUBLIC` to force a
  permission-denied path) now scopes the REVOKE/GRANT pair to a nested
  describe's `before` / `after` hooks instead of an inline try/catch.
  The previous shape left the cluster's `pg_current_wal_lsn()`
  ungrantable to `PUBLIC` if cleanup itself raised (e.g. a
  `shutdown()` throw between the URL restore and the GRANT), which
  would degrade unrelated tests on the same cluster. node:test runs
  `after()` whenever the matching `before()` ran -- assertion failure,
  body throw, or future second `it()` in the block. No production
  code change. Verified against PG17 and PG18 via the WSL integration
  matrix.

## [0.6.15] - 2026-05-16

### Docs
- `RunHooks` interface in `api.ts` now documents that `__pgmcp_sp` is a
  reserved savepoint name. `runUserQueryBounded` opens and releases that
  savepoint around the user SQL; a hook that opens a savepoint with the
  same name would be unwound by the inner `RELEASE`. Today no hook collides
  -- this is a contract note for future hook authors. Closes #8.

## [0.6.14] - 2026-05-16

### Security
- `paramValue` (used by `pg_query`, `pg_readonly`, `pg_explain` for positional
  parameters) was unbounded recursive via `z.lazy`. A pathologically nested
  request body could surface a `Maximum call stack size exceeded` RangeError
  out of the request path instead of a clear validation error. The new
  `paramsArray` schema wraps the top-level params array with an iterative
  depth check capped at 32 levels (arrays and objects each count as one
  level). Closes #7.

## [0.6.13] - 2026-05-16

### Fixed
- `pg_kill` now captures postgres's NOTICE channel during
  `pg_cancel_backend` / `pg_terminate_backend` and surfaces the message in
  the `note` field when `signaled=false`. Postgres distinguishes "PID N
  is not a PostgreSQL backend process" from "must be a member of the role
  whose query is being canceled or member of pg_signal_backend" via
  NOTICE, but the boolean return collapses both to `false`. Pre-0.6.13
  the handler returned a generic three-way list and the agent had to
  guess; now the cause is in the response. Closes #6.

### Docs
- `pg_kill` description now documents the NOTICE-derived `note` field.

### Internal
- `formatPgError` is now exported from `api.ts` so handlers that bypass
  `runInternal` / `withSharedClient` (currently only `pg_kill`) can format
  errors consistently with the rest of the codebase.

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
