import { z } from "zod";
import { type ApiResponse, getServerVersionNum, PG16, runInternal, withSharedClient } from "../api.js";
import { identSchema } from "./params.js";

/**
 * Row shape of {@link STATS_RESET_SQL} and {@link STATEMENTS_STATS_RESET_SQL}.
 * A type alias, not an interface: `withSharedClient`'s runner is generic over
 * `pg.QueryResultRow`, which carries an index signature, and interfaces get no
 * implicit one.
 *
 * `dealloc` is optional because only `pg_stat_statements_info` has it --
 * `pg_stat_database` has no analogue. It is `undefined` (key absent), never
 * null, on the pg_stat_database path, which is what keeps `withStatsReset`
 * from stamping a meaningless `dealloc: null` onto the two table/index tools.
 */
type StatsResetRow = {
  stats_reset: string | null;
  stats_reset_age_seconds: number | null;
  dealloc?: string | null;
};

/**
 * Every counter these tools rank on (`idx_scan`, `seq_scan`, ...) is cumulative
 * since the last statistics reset, so a row is only interpretable next to that
 * reset point -- "0 scans" after an hour-old reset says nothing at all.
 *
 * Probed as its own query rather than as a scalar subquery on the main SELECT
 * for two reasons: it must survive a zero-row result (an empty
 * `pg_unused_indexes` list is exactly the answer an agent acts on), and it is
 * one value for the whole database, not a per-row fact.
 *
 * Reading the result: `stats_reset` is NULL when the counters have never been
 * reset OR when the stats were discarded (crash recovery, immediate shutdown,
 * major-version upgrade), so NULL means "start point unknown", not "counting
 * since the beginning of time". It also only moves on database-wide resets --
 * `pg_stat_reset_single_table_counters()` zeroes one relation's counters
 * without touching it.
 *
 * The age cast is numeric(14, 2) rather than the numeric(10, 2) used elsewhere
 * in this repo on purpose: 10^8 seconds is only 3.2 years, and a cluster whose
 * stats were last reset before that would fail the whole tool with a numeric
 * field overflow instead of reporting a (very reassuring) large age.
 */
const STATS_RESET_SQL = `SELECT
     stats_reset::text AS stats_reset,
     EXTRACT(EPOCH FROM (now() - stats_reset))::numeric(14, 2)::float8 AS stats_reset_age_seconds
   FROM pg_catalog.pg_stat_database
   WHERE datname = current_database()`;

/**
 * Minimum `pg_stat_statements` extversion carrying the `pg_stat_statements_info`
 * view. Added in extension 1.9, which ships with PostgreSQL 14 ("Add
 * pg_stat_statements_info system view to show pg_stat_statements activity" --
 * PG14 release notes, commits 9fbc3f318 + 2e0fedf03); both `dealloc` and
 * `stats_reset` are present from 1.9 on, so one gate covers both columns.
 *
 * Below this the view does not exist and naming it is SQLSTATE 42P01
 * (undefined_table), which fails the whole tool rather than degrading it --
 * the same class of failure the PG16 last-scan gates prevent.
 */
export const PG_STAT_STATEMENTS_INFO_MIN_VERSION = "1.9";

/**
 * Whether this `pg_stat_statements` extversion has `pg_stat_statements_info`.
 * Exported for unit testing: the load-bearing assertion is that a pre-1.9
 * extension never causes the view to be named at all.
 */
export function hasStatementsInfo(extVersion: string): boolean {
  return compareVersions(extVersion, PG_STAT_STATEMENTS_INFO_MIN_VERSION) >= 0;
}

/**
 * Reset context for `pg_top_queries`. Deliberately NOT {@link STATS_RESET_SQL}:
 * `pg_stat_statements` keeps its own reset clock, moved by
 * `pg_stat_statements_reset()`, entirely independent of the
 * `pg_stat_database.stats_reset` the table/index tools read. Reporting the
 * pg_stat_database timestamp next to pg_stat_statements counters would be worse
 * than reporting nothing -- it would look authoritative while describing a
 * different window.
 *
 * Unqualified (no `pg_catalog.` prefix) because the view belongs to the
 * extension and lives in whatever schema it was installed into, matching the
 * bare `pg_stat_statements` reference in the main query below.
 *
 * The view is documented as holding exactly one row, so no WHERE clause is
 * needed; `withStatsReset` still warns rather than emitting a bare null if that
 * ever fails to hold.
 */
const STATEMENTS_STATS_RESET_SQL = `SELECT
     stats_reset::text AS stats_reset,
     EXTRACT(EPOCH FROM (now() - stats_reset))::numeric(14, 2)::float8 AS stats_reset_age_seconds,
     dealloc::text AS dealloc
   FROM pg_stat_statements_info`;

export const statsTools = [
  {
    name: "pg_top_queries",
    description:
      "Top N queries by total or mean execution time. Requires the `pg_stat_statements` " +
      "extension to be installed and enabled (most managed Postgres providers have it on " +
      "by default). Returns `{rows, stats_reset, stats_reset_age_seconds, dealloc}`: each row has " +
      "normalized query text (constants replaced with `?`), call count, " +
      "total/mean/min/max time in ms, rows returned, and cache hit ratio. Use this to find " +
      "slow queries worth optimizing.\n" +
      "`calls` and `total_time_ms` are cumulative since the last `pg_stat_statements_reset()`, so " +
      "this ranking only describes the window that started at the top-level `stats_reset` (with " +
      "`stats_reset_age_seconds` beside it). This is pg_stat_statements' OWN reset clock, read from " +
      "`pg_stat_statements_info` -- it is independent of the `stats_reset` reported by " +
      "`pg_seq_scan_tables` / `pg_unused_indexes`, which comes from pg_stat_database, so do not " +
      "compare the two timestamps or assume one implies the other. `stats_reset: null` means the " +
      "start of the window is unknown, not that it covers all time.\n" +
      "READ `dealloc` BEFORE TRUSTING THE RANKING: it counts how many times entries for the " +
      "LEAST-EXECUTED statements were evicted because more distinct statements were seen than " +
      "`pg_stat_statements.max` allows. A non-zero `dealloc` means this ranking is drawn from an " +
      "INCOMPLETE population -- queries may be missing from these results entirely, and an evicted " +
      "query's counters restart from zero if it runs again, understating it. The larger `dealloc` " +
      "is, the more churn, so 'not in the top N' stops being evidence that a query is cheap. Raise " +
      "`pg_stat_statements.max` to get a complete picture.\n" +
      "On pg_stat_statements < 1.9 (before Postgres 14) `pg_stat_statements_info` does not exist, " +
      "so `stats_reset`, `stats_reset_age_seconds` and `dealloc` are omitted entirely rather than " +
      "returned as nulls, and a `_warnings` entry says so.\n" +
      "On pg_stat_statements >= 1.10 (Postgres 15+), also returns " +
      "`io_read_time_ms` and `io_write_time_ms` to separate IO-bound from CPU-bound queries " +
      "(null when track_io_timing = off or the query did no measurable IO -- " +
      "enable track_io_timing in postgresql.conf to get non-null values). " +
      "Scoped to the database in DATABASE_URL: pg_stat_statements is cluster-wide, so results " +
      "are filtered by `dbid` to match every other tool here rather than leaking query text " +
      "from unrelated databases sharing the cluster.",
    annotations: {
      title: "Top queries by execution time",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      orderBy: z
        .enum(["total_time", "mean_time", "calls"])
        .default("total_time")
        .describe("Ranking: total_time (cumulative impact), mean_time (worst per-call), or calls (hottest)."),
      limit: z.number().int().min(1).max(100).default(20).describe("Number of rows to return (default 20)."),
    }),
    handler: async (input: unknown) => {
      // Direct (non-MCP) callers bypass Zod, so the schema defaults never ran.
      // Re-apply them in the destructure -- matches the precedent in
      // pg_explain / pg_table_bloat. Without this an omitted `limit` binds
      // undefined into `LIMIT $1` and postgres errors on the bind.
      const { orderBy = "total_time", limit = 20 } = input as {
        orderBy?: "total_time" | "mean_time" | "calls";
        limit?: number;
      };

      // Single probe answers BOTH "is the extension installed?" (no rows -> no)
      // AND "what's the extversion?" (used to pick column names below). Saves
      // a round-trip vs. issuing EXISTS and SELECT extversion separately --
      // the actual stats query is still a second round-trip, but it has to be
      // since the column names are dynamic.
      //
      // Column names changed in Postgres 13 (pg_stat_statements 1.8):
      // `total_time` -> `total_exec_time`, `mean_time` -> `mean_exec_time`,
      // etc. We pick the right column names from the version below.
      const versionRes = await runInternal<{ version: string }>(
        `SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'`,
      );
      if (!versionRes.ok) return versionRes;
      if (!versionRes.data || versionRes.data.length === 0) {
        return {
          ok: false,
          error:
            "pg_stat_statements extension is not installed. Install it with " +
            "`CREATE EXTENSION pg_stat_statements;` (may require superuser) and add " +
            "`pg_stat_statements` to `shared_preload_libraries` in postgresql.conf, then restart.",
        };
      }
      const extVersion = versionRes.data[0]?.version ?? "0";
      const useExecSuffix = compareVersions(extVersion, "1.8") >= 0;
      const totalCol = useExecSuffix ? "total_exec_time" : "total_time";
      const meanCol = useExecSuffix ? "mean_exec_time" : "mean_time";
      const minCol = useExecSuffix ? "min_exec_time" : "min_time";
      const maxCol = useExecSuffix ? "max_exec_time" : "max_time";
      // IO timing columns: blk_read_time / blk_write_time added in 1.10 (PG 15).
      // Renamed to shared_blk_read_time / shared_blk_write_time in 1.11 (PG 17);
      // the old names are gone in 1.11+. Both forms have identical ms semantics.
      // NULLIF(x, 0) maps both "timing off" and "no IO recorded" to null -- the
      // two cases are indistinguishable without querying current_setting().
      // Leading comma so the fragment appends cleanly after hit_percent.
      const hasIoTiming = compareVersions(extVersion, "1.10") >= 0;
      const hasSharedBlkCols = compareVersions(extVersion, "1.11") >= 0;
      const ioTimingCols = hasIoTiming
        ? `,
           NULLIF(${hasSharedBlkCols ? "shared_blk_read_time" : "blk_read_time"}, 0)::numeric(18, 2)::float8 AS io_read_time_ms,
           NULLIF(${hasSharedBlkCols ? "shared_blk_write_time" : "blk_write_time"}, 0)::numeric(18, 2)::float8 AS io_write_time_ms`
        : "";

      // The ORDER BY expression has to dodge an alias-shadowing trap: the
      // SELECT below aliases `calls::text AS calls`, and postgres resolves
      // `ORDER BY calls` to the output alias FIRST. Sorting text would mean
      // "9" beats "10" lexically. Qualify with the table name so postgres
      // routes to the source bigint column. The timing columns aren't aliased
      // back to themselves (they become *_ms), so they need no qualification.
      const orderCol =
        orderBy === "total_time" ? totalCol : orderBy === "mean_time" ? meanCol : "pg_stat_statements.calls";

      // Gated, not tried-and-caught: pg_stat_statements_info does not exist
      // below extension 1.9, and naming a missing view is SQLSTATE 42P01, which
      // takes the whole tool down instead of just costing the reset context.
      const infoSql = hasStatementsInfo(extVersion) ? STATEMENTS_STATS_RESET_SQL : null;

      // Two queries on one connection -- see api.ts:withSharedClient. The info
      // probe deliberately runs even when the ranking comes back empty: "no
      // queries recorded" is only interpretable next to when the counters were
      // last reset.
      return withSharedClient(async (run) => {
        const [rowsRes, infoRes] = await Promise.all([
          run<{
            query: string;
            calls: string;
            total_time_ms: number;
            mean_time_ms: number;
            min_time_ms: number;
            max_time_ms: number;
            rows: string;
            hit_percent: number | null;
            io_read_time_ms?: number | null;
            io_write_time_ms?: number | null;
          }>(
            // bigint counters (calls, rows) come back as `.text` for lossless
            // serialization, matching pg_seq_scan_tables / pg_unused_indexes /
            // pg_table_bloat. Timing fields stay as float8 because they are
            // inherently fractional milliseconds.
            `SELECT
           query,
           calls::text AS calls,
           ${totalCol}::numeric(18, 2)::float8 AS total_time_ms,
           ${meanCol}::numeric(18, 2)::float8 AS mean_time_ms,
           ${minCol}::numeric(18, 2)::float8 AS min_time_ms,
           ${maxCol}::numeric(18, 2)::float8 AS max_time_ms,
           rows::text AS rows,
           CASE
             WHEN (shared_blks_hit + shared_blks_read) > 0
             THEN (shared_blks_hit::float8 / (shared_blks_hit + shared_blks_read) * 100)::numeric(5, 2)::float8
             ELSE NULL
           END AS hit_percent${ioTimingCols}
         FROM pg_stat_statements
         WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
         ORDER BY ${orderCol} DESC NULLS LAST
         LIMIT $1`,
            [limit],
          ),
          infoSql ? run<StatsResetRow>(infoSql) : null,
        ]);
        // The info probe is context; the ranking is the answer. Only the latter
        // failing is a tool failure -- a failed probe degrades to a _warnings
        // entry inside withStatsReset.
        if (!rowsRes.ok) return { ok: false, error: rowsRes.error };
        if (!infoRes) {
          // Extension too old to have the view. Omit the three fields entirely
          // rather than emitting nulls: everywhere else in this file
          // `stats_reset: null` means "never reset / unknown start point", and
          // `dealloc: null` would read as "nothing was ever evicted" -- a
          // reassuring claim this extension version cannot actually support.
          return {
            ok: true,
            data: {
              rows: rowsRes.data ?? [],
              _warnings: [
                `pg_stat_statements ${extVersion} predates pg_stat_statements_info ` +
                  `(added in ${PG_STAT_STATEMENTS_INFO_MIN_VERSION}), so the reset point and the ` +
                  `dealloc eviction count are unavailable: this ranking's window and completeness are unknown`,
              ],
            },
          };
        }
        return { ok: true, data: withStatsReset(rowsRes.data ?? [], infoRes, "pg_stat_statements_info") };
      });
    },
  },

  {
    name: "pg_seq_scan_tables",
    description:
      "Tables with high sequential-scan counts relative to index scans - the first place to " +
      "look for missing-index candidates. Returns `{rows, stats_reset, stats_reset_age_seconds}`: " +
      "each row has seq_scans, idx_scans, live tuples, and the ratio. A high ratio on a large " +
      "table usually means a query is reading the whole table where an index would suffice. " +
      "Pair with `pg_top_queries` to find which query is doing it.\n" +
      "These counters are cumulative since the last statistics reset, so every ratio here is " +
      "only meaningful relative to the top-level `stats_reset` (and `stats_reset_age_seconds`). " +
      "A ratio measured over a window that was reset minutes ago describes that window, not the " +
      "workload; `stats_reset: null` means the start of the window is unknown.\n" +
      "On PostgreSQL 16+ each row also carries `last_seq_scan` and `last_idx_scan` timestamps " +
      "(null = no such scan since the reset), which separate 'scanned hard months ago' from " +
      "'being scanned right now' in a way the raw counts cannot.",
    annotations: {
      title: "Find tables with heavy sequential scans",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.optional().describe("Limit to one schema. If omitted, all user schemas are included."),
      minSize: z
        .number()
        .int()
        .min(0)
        .default(1000)
        .describe("Minimum live tuple count to include (default 1000, filters out tiny/empty tables)."),
      limit: z.number().int().min(1).max(100).default(20).describe("Max rows to return (default 20)."),
    }),
    handler: async (input: unknown) => {
      // Zod defaults re-applied for direct callers -- see pg_top_queries above.
      const {
        schema,
        minSize = 1000,
        limit = 20,
      } = input as {
        schema?: string;
        minSize?: number;
        limit?: number;
      };
      // Probed before the SQL is built because it decides which columns the
      // query may name -- last_seq_scan / last_idx_scan do not exist before
      // PG16 and referencing them there is a 42703 that fails the whole tool.
      // api.ts caches the probe process-wide, so this costs one extra
      // round-trip on the first stats call and nothing afterwards.
      const serverVersion = await getServerVersionNum();
      const schemaFilter = schema
        ? "AND schemaname = $3"
        : "AND schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_%'";
      const params: unknown[] = [minSize, limit];
      if (schema) params.push(schema);
      // Two queries on one connection -- see api.ts:withSharedClient. They are
      // independent (the shared client just serializes them), and the reset
      // probe deliberately runs even when the main query returns no rows.
      return withSharedClient(async (run) => {
        const [rowsRes, resetRes] = await Promise.all([
          run<{
            schema: string;
            table: string;
            seq_scans: string;
            idx_scans: string;
            live_tuples: string;
            seq_tup_read: string;
            ratio: number | null;
            last_seq_scan?: string | null;
            last_idx_scan?: string | null;
          }>(
            `SELECT
               schemaname AS schema,
               relname AS "table",
               seq_scan::text AS seq_scans,
               COALESCE(idx_scan, 0)::text AS idx_scans,
               n_live_tup::text AS live_tuples,
               seq_tup_read::text AS seq_tup_read,
               CASE
                 WHEN COALESCE(idx_scan, 0) = 0 THEN NULL
                 ELSE (seq_scan::numeric / idx_scan)::numeric(10, 2)::float8
               END AS ratio${tableLastScanCols(serverVersion)}
             FROM pg_catalog.pg_stat_user_tables
             WHERE n_live_tup >= $1
               ${schemaFilter}
             ORDER BY seq_scan DESC NULLS LAST
             LIMIT $2`,
            params,
          ),
          run<StatsResetRow>(STATS_RESET_SQL),
        ]);
        // The reset probe is context; the row query is the answer. Only the
        // latter failing is a tool failure -- a failed probe degrades to a
        // _warnings entry inside withStatsReset.
        if (!rowsRes.ok) return { ok: false, error: rowsRes.error };
        return { ok: true, data: withStatsReset(rowsRes.data ?? [], resetRes) };
      });
    },
  },

  {
    name: "pg_unused_indexes",
    description:
      "Indexes that have never been scanned or have very low usage, largest first. Each unused " +
      "index costs write amplification (every INSERT/UPDATE maintains it) and disk space, so " +
      "before adding a new index, check whether the fix is to drop a dead one. Returns " +
      "`{rows, stats_reset, stats_reset_age_seconds}`.\n" +
      "READ THIS BEFORE RECOMMENDING A DROP: `scans` is a counter, not a verdict. It only " +
      "counts since the last statistics reset, which is why the top-level `stats_reset` and " +
      "`stats_reset_age_seconds` are part of the answer. If the counters were reset an hour " +
      "ago, EVERY index looks unused; if `stats_reset` is null, the start of the window is " +
      "unknown and the counts prove nothing. This list is only trustworthy once the reset age " +
      "comfortably exceeds the slowest cycle that could use the index - a monthly report, a " +
      "quarterly close, a yearly job, a failover-only query path.\n" +
      "PRIMARY KEY and UNIQUE indexes are already excluded from these results: they enforce a " +
      "constraint and stay load-bearing at zero scans, so they never appear here and their " +
      "absence is not evidence of anything.\n" +
      "On PostgreSQL 16+ each row also carries `last_idx_scan`, the timestamp of the most " +
      "recent scan (null = never scanned since the reset). 'Not scanned since 2026-02-14' is a " +
      "far better basis for a decision than a bare count.\n" +
      "On PostgreSQL 18+, do not fall back on the old 'the leading column is never filtered, so " +
      "this index is dead weight' reasoning. Skip scan lets the planner use a multi-column " +
      "btree whose leading column is unconstrained, so such an index can now be doing real work.",
    annotations: {
      title: "Find unused indexes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.optional().describe("Limit to one schema. If omitted, all user schemas are included."),
      maxScans: z
        .number()
        .int()
        .min(0)
        .default(10)
        .describe("Include indexes with scan count <= this (default 10). Use 0 for 'never scanned'."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return (default 50)."),
    }),
    handler: async (input: unknown) => {
      // Zod defaults re-applied for direct callers -- see pg_top_queries above.
      const {
        schema,
        maxScans = 10,
        limit = 50,
      } = input as {
        schema?: string;
        maxScans?: number;
        limit?: number;
      };
      // See pg_seq_scan_tables above for why the version is probed first:
      // s.last_idx_scan does not exist before PG16.
      const serverVersion = await getServerVersionNum();
      const schemaFilter = schema
        ? "AND s.schemaname = $3"
        : "AND s.schemaname NOT IN ('pg_catalog', 'information_schema') AND s.schemaname NOT LIKE 'pg_%'";
      const params: unknown[] = [maxScans, limit];
      if (schema) params.push(schema);
      // Two queries on one connection -- see api.ts:withSharedClient. The
      // stats_reset probe is what keeps a zero-scan row from reading as
      // "safe to drop"; it has to run even when this returns no rows at all.
      return withSharedClient(async (run) => {
        const [rowsRes, resetRes] = await Promise.all([
          run<{
            schema: string;
            table: string;
            index: string;
            scans: string;
            size_pretty: string;
            size_bytes: string;
            definition: string;
            last_idx_scan?: string | null;
          }>(
            `SELECT
               s.schemaname AS schema,
               s.relname AS "table",
               s.indexrelname AS "index",
               s.idx_scan::text AS scans,
               pg_size_pretty(pg_relation_size(s.indexrelid)) AS size_pretty,
               pg_relation_size(s.indexrelid)::text AS size_bytes,
               pg_catalog.pg_get_indexdef(s.indexrelid) AS definition${indexLastScanCols(serverVersion)}
             FROM pg_catalog.pg_stat_user_indexes s
             JOIN pg_catalog.pg_index i ON i.indexrelid = s.indexrelid
             WHERE s.idx_scan <= $1
               AND NOT i.indisunique
               AND NOT i.indisprimary
               ${schemaFilter}
             ORDER BY pg_relation_size(s.indexrelid) DESC
             LIMIT $2`,
            params,
          ),
          run<StatsResetRow>(STATS_RESET_SQL),
        ]);
        if (!rowsRes.ok) return { ok: false, error: rowsRes.error };
        return { ok: true, data: withStatsReset(rowsRes.data ?? [], resetRes) };
      });
    },
  },
] as const;

/**
 * The stats-window envelope every counter-ranking tool in this file returns --
 * all three of pg_top_queries, pg_seq_scan_tables and pg_unused_indexes.
 *
 * Breaking change from the bare row array these tools used to return: the
 * counters are uninterpretable without the reset point, and an envelope is the
 * only place a single database-wide fact can live when the row list may be
 * empty. Callers read `data.rows` where they used to read `data`.
 *
 * If a fourth counter-ranking tool is added here, it belongs in this envelope
 * too -- a tool that ranks cumulative counters and returns a bare array is the
 * exact bug this type exists to prevent. Note the reset point is per-source,
 * not global: see `stats_reset` below.
 */
export interface StatsWindow<Row> {
  rows: Row[];
  /**
   * Timestamp of the last stats reset; null = unknown start point. Which clock
   * this is depends on the tool: pg_stat_database for the table/index tools,
   * pg_stat_statements' own (independent) reset for pg_top_queries. Never
   * compare one against the other.
   *
   * Optional ONLY because pg_top_queries can run against a pg_stat_statements
   * too old to have pg_stat_statements_info, where the honest answer is an
   * absent key plus a `_warnings` entry rather than a null that reads as "never
   * reset". `withStatsReset` always populates it, so every path that can read a
   * reset point at all reports one.
   */
  stats_reset?: string | null;
  /** Seconds since `stats_reset`; null whenever `stats_reset` is null. */
  stats_reset_age_seconds?: number | null;
  /**
   * pg_top_queries only, and only on pg_stat_statements >= 1.9: how many times
   * least-executed entries were evicted for exceeding `pg_stat_statements.max`.
   * Non-zero means the ranking is drawn from an incomplete population. Absent
   * on the table/index tools, whose sources have no such eviction concept.
   */
  dealloc?: string | null;
  /** Present only when the reset context could not be read. */
  _warnings?: string[];
}

/**
 * Wrap result rows with the stats-reset context. Exported for unit testing.
 *
 * A failed probe must NOT read as "never reset" -- both would surface
 * `stats_reset: null`, and the entire trustworthiness of a drop-this-index
 * recommendation hangs on that field. The `_warnings` entry is what separates
 * "we could not read it" from "the catalog says NULL", following the
 * partial-failure convention in pg_replication_status / pg_advisor.
 *
 * `sourceView` names the view the probe read so the no-row warning points at
 * the thing that was actually empty -- pg_top_queries reads
 * pg_stat_statements_info, not pg_stat_database, and a warning naming the wrong
 * view would send whoever debugs it to the wrong catalog.
 */
export function withStatsReset<Row>(
  rows: Row[],
  resetRes: ApiResponse<StatsResetRow[]>,
  sourceView = "pg_stat_database",
): StatsWindow<Row> {
  if (!resetRes.ok) {
    return {
      rows,
      stats_reset: null,
      stats_reset_age_seconds: null,
      _warnings: [`stats_reset lookup failed, so counter age is unknown: ${resetRes.error}`],
    };
  }
  const row = resetRes.data?.[0];
  if (!row) {
    // The source view should always have a row (pg_stat_database for
    // current_database(); pg_stat_statements_info is documented as exactly one
    // row). If it does not, say so rather than emitting a null that reads as
    // "never reset".
    return {
      rows,
      stats_reset: null,
      stats_reset_age_seconds: null,
      _warnings: [`${sourceView} returned no row, so counter age is unknown`],
    };
  }
  const out: StatsWindow<Row> = {
    rows,
    stats_reset: row.stats_reset,
    stats_reset_age_seconds: row.stats_reset_age_seconds,
  };
  // Key-present test, not a truthiness test: `dealloc: "0"` is both falsy-ish
  // as a string check and the single most common real value ("nothing evicted,
  // ranking is complete"), so it must survive onto the envelope. Only the
  // pg_stat_database probe, which never selects the column, is skipped here.
  if (row.dealloc !== undefined) out.dealloc = row.dealloc;
  return out;
}

/**
 * Trailing SELECT-list fragment adding `last_idx_scan` from
 * `pg_stat_user_indexes` (aliased `s`), or "" below PG16 where the column does
 * not exist. Same gating shape as the extversion checks in pg_top_queries.
 * Exported for unit testing: the load-bearing assertion is that a pre-16
 * server never sees the column name at all.
 */
export function indexLastScanCols(serverVersionNum: number): string {
  return serverVersionNum >= PG16
    ? `,
               s.last_idx_scan::text AS last_idx_scan`
    : "";
}

/**
 * Trailing SELECT-list fragment adding `last_seq_scan` / `last_idx_scan` from
 * `pg_stat_user_tables`, or "" below PG16. See indexLastScanCols.
 */
export function tableLastScanCols(serverVersionNum: number): string {
  return serverVersionNum >= PG16
    ? `,
               last_seq_scan::text AS last_seq_scan,
               last_idx_scan::text AS last_idx_scan`
    : "";
}

/**
 * Compare semver-like version strings. Returns negative, zero, or positive
 * for `a < b`, `a === b`, `a > b`. Exported for unit testing.
 *
 * Handles common pg-extension version oddities:
 *   - missing segments (`1.8` vs `1.8.0` -> 0)
 *   - longer suffixes (`1.7.99` vs `1.8` -> negative)
 *   - pre-release tags (`1.10-beta` parses leading digits per segment, so
 *     `1.10-beta` vs `1.8` -> positive, matching numeric intent)
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.split(".").map((seg) => {
      // Pull the leading run of digits from each segment so trailing tags
      // like `-beta`, `rc1`, `dev` don't poison the comparison with NaN.
      const m = seg.match(/^\d+/);
      return m ? Number.parseInt(m[0], 10) : 0;
    });
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
