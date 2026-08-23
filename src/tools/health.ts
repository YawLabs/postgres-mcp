import { z } from "zod";
import { withSharedClient } from "../api.js";
import { warningsField } from "./output.js";

export const healthTools = [
  {
    name: "pg_health",
    description:
      "Quick health snapshot: server version, database size, connection counts measured against " +
      "`max_connections`, active queries with their wait events, a pg_stat_database rollup, and " +
      "table count. Useful as a connection sanity check and to spot runaway queries, " +
      "connection-cap pressure, and lock/IO waits.\n" +
      "- connections: `total` for the CURRENT database, broken down into `active` / `idle` / " +
      "`idle_in_transaction` / `idle_in_transaction_aborted` / `other` (starting, fastpath " +
      "function call, disabled) / `state_unavailable` -- those six sum to `total`. " +
      "`idle_in_transaction_aborted` is called out separately because it holds locks and blocks " +
      "vacuum while doing no work and will never commit. `state_unavailable` counts sessions whose " +
      "`state` reads NULL because the role lacks pg_read_all_stats / pg_monitor membership; a " +
      "non-zero value means every other bucket is under-counted by at least that much, so do NOT " +
      "read `active: 0` next to it as an idle database. Plus " +
      "`cluster_client_backends` (client backends across ALL databases -- those are what " +
      "actually consume connection slots), `max_connections`, `superuser_reserved_connections`, " +
      "and `used_fraction` (cluster_client_backends / max_connections). A raw connection count " +
      "means nothing without the cap; read `used_fraction` first.\n" +
      "- active_queries: `pid`, `state`, `query`, `application_name`, `backend_type`, " +
      "`wait_event_type` / `wait_event` (both NULL when the backend is running rather than " +
      "waiting -- the single most diagnostic pair in pg_stat_activity). Both are reported " +
      "verbatim as the server spells them, and that spelling changes between majors: a backend " +
      "waiting on a buffer pin reports `wait_event_type` 'BufferPin' through PostgreSQL 18 and " +
      "'Buffer' from 19 on, with the `wait_event` names beneath it changing to match. Read them " +
      "against the reported `version` rather than hard-coding a literal. `duration_seconds` " +
      "(since query_start) and `transaction_age_seconds` (since xact_start). A large " +
      "transaction_age_seconds next to a small duration_seconds is a long-open transaction, the " +
      "usual root cause behind lock waits, bloat, and stalled autovacuum.\n" +
      "- database_stats: pg_stat_database for the current database -- `deadlocks`, `temp_files` / " +
      "`temp_bytes` (work_mem spills), `conflicts` (recovery conflicts, only ever non-zero on a " +
      "replica), `blks_hit` / `blks_read` / `cache_hit_ratio`, and `stats_reset`. Every counter " +
      "is CUMULATIVE since stats_reset, not a rate -- interpret them against that timestamp.\n" +
      "Sub-queries that fail (several of these are permission-gated on managed providers) append " +
      "to `_warnings` and leave their field null; the rest of the snapshot still returns.",
    annotations: {
      title: "Database health snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      activeQueryLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Max active queries to return (default 10, max 100)."),
    }),
    // Three distinct "no value" states show up below and they are not
    // interchangeable, so the schema keeps them apart:
    //   - null      -> the sub-query FAILED (permission-gated view); the reason
    //                  is in `_warnings`.
    //   - key absent-> the sub-query SUCCEEDED but returned no row, so the
    //                  handler's `?.[0]` yielded undefined and JSON dropped the
    //                  key. Only `database`, `connections`, `version` and
    //                  `table_count` can reach this state.
    //   - a value   -> a real measurement.
    // `database_stats` is the one single-row lookup that cannot go absent: the
    // handler pins it with `?? null` because pg_stat_database legitimately has
    // no row for a database the role cannot see.
    outputSchema: z.object({
      connected: z.boolean().describe("Always true on a success response -- the version probe answered."),
      version: z
        .string()
        .optional()
        .describe("Full `version()` banner. Absent (with a `_warnings` entry) if the row came back without it."),
      database: z
        .object({
          database: z.string(),
          size_pretty: z.string(),
          size_bytes: z.string().describe("Bigint as a decimal string -- past 2^53 a JS number would lose digits."),
        })
        .nullable()
        .optional(),
      connections: z
        .object({
          total: z.string().describe("Sessions in the CURRENT database. The six state buckets below sum to this."),
          active: z.string(),
          idle: z.string(),
          idle_in_transaction: z.string(),
          idle_in_transaction_aborted: z
            .string()
            .describe("Holds locks and blocks vacuum while doing no work, and can never commit."),
          other: z.string().describe("Catch-all: starting, fastpath function call, disabled, plus any future state."),
          state_unavailable: z
            .string()
            .describe(
              "Sessions whose `state` read NULL for lack of pg_read_all_stats / pg_monitor. Non-zero " +
                "means every other bucket is under-counted -- do NOT read `active: 0` beside it as an idle database.",
            ),
          cluster_client_backends: z
            .string()
            .describe("Client backends across ALL databases -- the ones that actually consume connection slots."),
          max_connections: z.number(),
          superuser_reserved_connections: z.number(),
          used_fraction: z
            .number()
            .nullable()
            .describe("cluster_client_backends / max_connections. Null only if max_connections read as 0."),
        })
        .nullable()
        .optional(),
      active_queries: z
        .array(
          z.object({
            pid: z.number(),
            state: z.string().nullable(),
            duration_seconds: z.number().nullable().describe("Since query_start."),
            transaction_age_seconds: z
              .number()
              .nullable()
              .describe(
                "Since xact_start; null outside a transaction block. Large here beside a small " +
                  "duration_seconds is a long-open transaction.",
              ),
            xact_start: z.string().nullable(),
            wait_event_type: z
              .string()
              .nullable()
              .describe(
                "Null when the backend is RUNNING rather than waiting. Spelling changes between " +
                  "majors ('BufferPin' through PG18, 'Buffer' from 19) -- read it against `version`.",
              ),
            wait_event: z.string().nullable(),
            backend_type: z.string(),
            query: z.string(),
            application_name: z.string(),
          }),
        )
        .describe("Empty array both when nothing is running and when the fetch failed -- check `_warnings`."),
      database_stats: z
        .object({
          deadlocks: z.string(),
          temp_files: z.string(),
          temp_bytes: z.string(),
          temp_bytes_pretty: z.string(),
          conflicts: z.string().describe("Recovery conflicts; only ever non-zero on a replica."),
          blks_hit: z.string(),
          blks_read: z.string(),
          cache_hit_ratio: z.number().nullable().describe("Null on a freshly reset database (both counters 0)."),
          stats_reset: z
            .string()
            .nullable()
            .describe("Every counter here is cumulative SINCE this timestamp. Null = never reset."),
        })
        .nullable()
        .describe("Null when pg_stat_database is unreadable OR has no row for this database."),
      table_count: z
        .string()
        .nullable()
        .optional()
        .describe("User tables and partitioned tables, as a decimal string."),
      _warnings: warningsField,
    }),
    handler: async (input: unknown) => {
      // Zod default re-applied for direct (non-MCP) callers, which bypass the
      // schema -- an omitted activeQueryLimit would otherwise bind undefined
      // into `LIMIT $1`. Matches the precedent in pg_explain / pg_table_bloat.
      const { activeQueryLimit = 10 } = input as { activeQueryLimit?: number };
      // 6-way catalog fanout on a single shared connection -- avoids
      // saturating the pool (default max 5) on one health probe.
      //
      // Nothing selected below is newer than PG15 (the oldest server in the
      // integration matrix): wait_event_type / wait_event landed in 9.6,
      // backend_type in 10, and every pg_stat_database column used here
      // predates 9.6 -- so this handler needs no server-version gate.
      //
      // PG19 renames no column this handler reads either. The one vocabulary
      // it DOES change is the wait-event pair, and that is passed through
      // rather than matched on -- see the active-queries query below.
      return withSharedClient(async (run) => {
        const [versionRes, sizeRes, connsRes, activeRes, dbStatsRes, tableCountRes] = await Promise.all([
          run<{ version: string }>(`SELECT version() AS version`),
          run<{ database: string; size_pretty: string; size_bytes: string }>(
            `SELECT
               current_database() AS database,
               pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
               pg_database_size(current_database())::text AS size_bytes`,
          ),
          run<{
            total: string;
            active: string;
            idle: string;
            idle_in_transaction: string;
            idle_in_transaction_aborted: string;
            other: string;
            state_unavailable: string;
            cluster_client_backends: string;
            max_connections: number;
            superuser_reserved_connections: number;
            used_fraction: number | null;
          }>(
            // The per-database counters keep their original meaning: the
            // old `WHERE datname = current_database()` moved into a FILTER on
            // each aggregate so the same statement can also count backends in
            // OTHER databases. Without that, a connection-cap check would
            // compare one database's session count against a cluster-wide
            // limit and under-report pressure on a multi-tenant server.
            //
            // used_fraction divides by max_connections using
            // `backend_type = 'client backend'`, not count(*): autovacuum
            // workers, background workers, walsenders and the checkpointer all
            // appear in pg_stat_activity but draw on their OWN process limits,
            // so counting them would inflate the fraction past 1.0 on an idle
            // server. The effective ceiling for a non-superuser is lower still
            // -- `max_connections - superuser_reserved_connections` (minus
            // reserved_connections on PG16+) -- which is why the reserve is
            // reported alongside rather than folded into the fraction.
            //
            // Visibility caveat: pg_stat_activity does NOT hide other users'
            // rows from an ordinary role. The row is still there -- existence,
            // datname and session user are visible to everyone -- but `state`
            // (along with query, wait_event, xact_start, ...) comes back NULL
            // unless the caller owns the session or holds pg_read_all_stats /
            // pg_monitor. So `total` and cluster_client_backends, which key off
            // datname / backend_type, are COMPLETE for any role, while the
            // state buckets below count only the caller's own sessions. Left
            // unmarked that renders as a confident `active: 0` on a busy
            // database, which reads as "nothing is running" rather than "you
            // cannot see it": state_unavailable counts the NULL-state rows so
            // the shortfall is visible. It is a visibility gap on a successful
            // query, not a failure, so it cannot be surfaced via _warnings.
            //
            // The buckets are meant to RECONCILE: every current-database row
            // lands in exactly one of active / idle / idle_in_transaction /
            // idle_in_transaction_aborted / other / state_unavailable, so those
            // six sum to `total`. Keep that invariant when editing -- it is the
            // only thing that makes a shortfall detectable.
            //
            // `other` is a NOT IN over the named buckets rather than one
            // counter per remaining documented state (starting, fastpath
            // function call, disabled): those are rare enough not to earn a
            // field, and a catch-all also absorbs any state a future major
            // adds, which an equality list would silently drop out of the sum.
            // 'idle in transaction (aborted)' does get its own field -- it is
            // an exact-equality state, not a prefix of 'idle in transaction',
            // and it is diagnostically distinct: it holds locks and blocks
            // vacuum while doing no work and can never commit.
            `SELECT
               count(*) FILTER (WHERE datname = current_database())::text AS total,
               count(*) FILTER (WHERE datname = current_database() AND state = 'active')::text AS active,
               count(*) FILTER (WHERE datname = current_database() AND state = 'idle')::text AS idle,
               count(*) FILTER (WHERE datname = current_database() AND state = 'idle in transaction')::text AS idle_in_transaction,
               count(*) FILTER (WHERE datname = current_database() AND state = 'idle in transaction (aborted)')::text AS idle_in_transaction_aborted,
               count(*) FILTER (WHERE datname = current_database()
                                  AND state IS NOT NULL
                                  AND state NOT IN ('active', 'idle', 'idle in transaction', 'idle in transaction (aborted)'))::text AS other,
               count(*) FILTER (WHERE datname = current_database() AND state IS NULL)::text AS state_unavailable,
               count(*) FILTER (WHERE backend_type = 'client backend')::text AS cluster_client_backends,
               current_setting('max_connections')::int AS max_connections,
               current_setting('superuser_reserved_connections')::int AS superuser_reserved_connections,
               (count(*) FILTER (WHERE backend_type = 'client backend')::numeric
                  / NULLIF(current_setting('max_connections')::numeric, 0))::numeric(6, 4)::float8 AS used_fraction
             FROM pg_stat_activity`,
          ),
          run<{
            pid: number;
            state: string | null;
            duration_seconds: number | null;
            transaction_age_seconds: number | null;
            xact_start: string | null;
            wait_event_type: string | null;
            wait_event: string | null;
            backend_type: string;
            query: string;
            application_name: string;
          }>(
            // wait_event_type / wait_event are the diagnostic pair here: they
            // say WHY a backend is not making progress (Lock, LWLock, IO,
            // Client, ...) instead of leaving the caller to infer it from the
            // query text. Both are NULL when the backend is actually running.
            //
            // The values are passed straight through, never filtered or
            // switched on: postgres renames these literals between majors, so
            // a `WHERE wait_event_type = '...'` or a CASE over them here would
            // silently match nothing on a newer server -- rendering a database
            // stalled on that exact wait as one with nothing waiting at all.
            // PG19 is the live case: the type a buffer-pin wait reports is
            // 'BufferPin' through PG18 and 'Buffer' from PG19 on, and the
            // wait_event names beneath it change with it ('BufferPin' becomes
            // BufferCleanup / BufferExclusive / BufferShared /
            // BufferShareExclusive). Note the PG19 release note spells that
            // rename `BUFFERPIN` -> `BUFFER`: those are the internal C enum
            // names, NOT what pg_stat_activity emits, so a filter written from
            // the release note would match nothing on ANY version.
            // Interpretation belongs to the caller, which can see the server
            // version. health.test.ts pins this passthrough, so adding a
            // predicate or a CASE here fails a test rather than shipping.
            //
            // transaction_age_seconds comes from xact_start, not query_start:
            // a backend that has been idle-in-transaction for an hour shows a
            // short (or NULL) query duration while holding snapshots and locks
            // the whole time. That gap is the tell for the long-open
            // transaction behind most of the rest of this snapshot. xact_start
            // is NULL for backends not in a transaction block.
            `SELECT
               pid,
               state,
               EXTRACT(EPOCH FROM (now() - query_start))::numeric(10, 2)::float8 AS duration_seconds,
               EXTRACT(EPOCH FROM (now() - xact_start))::numeric(10, 2)::float8 AS transaction_age_seconds,
               xact_start::text AS xact_start,
               wait_event_type,
               wait_event,
               backend_type,
               query,
               application_name
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND state IS NOT NULL
               AND state <> 'idle'
               AND pid <> pg_backend_pid()
             ORDER BY query_start ASC NULLS LAST
             LIMIT $1`,
            [activeQueryLimit],
          ),
          run<{
            deadlocks: string;
            temp_files: string;
            temp_bytes: string;
            temp_bytes_pretty: string;
            conflicts: string;
            blks_hit: string;
            blks_read: string;
            cache_hit_ratio: number | null;
            stats_reset: string | null;
          }>(
            // Every column here is a bigint counter that has been accumulating
            // since stats_reset, so stats_reset ships with them -- "12
            // deadlocks" is alarming since yesterday and unremarkable since
            // 2019. stats_reset is NULL when the stats have never been reset.
            //
            // ::text on the counters: they are bigint, and node-pg would hand
            // back a JS number that silently loses precision past 2^53 on a
            // long-lived cluster's temp_bytes.
            //
            // cache_hit_ratio divides in numeric rather than float8 for the
            // same reason, and NULLIF guards the freshly-reset case where both
            // blks_hit and blks_read are 0 (division by zero, not a 0% ratio).
            `SELECT
               deadlocks::text AS deadlocks,
               temp_files::text AS temp_files,
               temp_bytes::text AS temp_bytes,
               pg_size_pretty(temp_bytes) AS temp_bytes_pretty,
               conflicts::text AS conflicts,
               blks_hit::text AS blks_hit,
               blks_read::text AS blks_read,
               (blks_hit::numeric / NULLIF(blks_hit + blks_read, 0))::numeric(6, 4)::float8 AS cache_hit_ratio,
               stats_reset::text AS stats_reset
             FROM pg_catalog.pg_stat_database
             WHERE datname = current_database()`,
          ),
          run<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname NOT LIKE 'pg_toast%'
               AND n.nspname NOT LIKE 'pg_temp_%'`,
          ),
        ]);

        // If we can't even get the version, connectivity is broken -- surface
        // that directly instead of returning a half-empty object.
        if (!versionRes.ok) return versionRes;

        // Surface partial-failure messages on a top-level _warnings array
        // rather than nesting `{error: "..."}` inside the data fields. The
        // nested form makes `data.database.size_bytes` resolve to undefined
        // when an LLM looks it up, with no signal "failed" vs "missing key".
        // This path only covers per-catalog-query permission/visibility
        // failures (one of the six fanout queries erroring while the
        // connection is fine). Broad connectivity loss never reaches here --
        // it throws out of getPool().connect() inside withSharedClient and is
        // caught upstream in mcp-wrapper.
        //
        // Every check below is an independent `if`, never an early return:
        // pg_stat_database in particular is permission-gated on several
        // managed providers, so losing it while the rest of the snapshot is
        // readable is the expected path, not an edge case.
        const warnings: string[] = [];
        // versionRes.ok is guaranteed true here (early-returned above), but the
        // row/column could still be absent -- warn so the success object is
        // never silently missing its headline field, matching the other five.
        if (versionRes.data?.[0]?.version === undefined) {
          warnings.push(`version unavailable despite successful query`);
        }
        if (!sizeRes.ok) warnings.push(`database fetch failed: ${sizeRes.error}`);
        if (!connsRes.ok) warnings.push(`connections fetch failed: ${connsRes.error}`);
        if (!activeRes.ok) warnings.push(`active_queries fetch failed: ${activeRes.error}`);
        if (!dbStatsRes.ok) warnings.push(`database_stats fetch failed: ${dbStatsRes.error}`);
        if (!tableCountRes.ok) warnings.push(`table_count fetch failed: ${tableCountRes.error}`);

        return {
          ok: true,
          data: {
            connected: true,
            version: versionRes.data?.[0]?.version,
            database: sizeRes.ok ? sizeRes.data?.[0] : null,
            connections: connsRes.ok ? connsRes.data?.[0] : null,
            active_queries: activeRes.ok ? activeRes.data : [],
            // `?? null` matters here and not on the sibling single-row
            // lookups: pg_stat_database has no row for a database the role
            // cannot see, so a successful query can legitimately return zero
            // rows. Normalize that to null instead of undefined, which JSON
            // serialization would drop from the response entirely.
            database_stats: dbStatsRes.ok ? (dbStatsRes.data?.[0] ?? null) : null,
            table_count: tableCountRes.ok ? tableCountRes.data?.[0]?.count : null,
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      });
    },
  },
] as const;
