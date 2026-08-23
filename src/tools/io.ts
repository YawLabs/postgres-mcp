import { z } from "zod";
import { getServerVersionNum, PG16, PG18, withSharedClient } from "../api.js";
import { warningsField } from "./output.js";

/**
 * Row shape of the `pg_stat_io` query below. A type alias, not an interface:
 * `withSharedClient`'s runner is generic over `pg.QueryResultRow`, which
 * carries an index signature, and interfaces get no implicit one. (Same
 * reason as StatsResetRow in stats.ts.)
 *
 * Every counter is `string | null`, not `string`: pg_stat_io returns NULL --
 * not 0 -- for a (backend_type, object, context) combination where the
 * operation is not possible at all (a checkpointer never "reuses" a strategy
 * buffer; the WAL context records no hits). Coalescing those to 0 would report
 * "this op happened zero times" where the truth is "this op cannot happen
 * here", and an agent hunting a stall would waste a step on the difference.
 */
type IoRow = {
  backend_type: string;
  io_object: string;
  io_context: string;
  reads: string | null;
  read_bytes: string | null;
  read_time_ms: number | null;
  writes: string | null;
  write_bytes: string | null;
  write_time_ms: number | null;
  writebacks: string | null;
  writeback_time_ms: number | null;
  extends: string | null;
  extend_bytes: string | null;
  extend_time_ms: number | null;
  hits: string | null;
  evictions: string | null;
  reuses: string | null;
  fsyncs: string | null;
  fsync_time_ms: number | null;
  stats_reset: string | null;
};

/**
 * Row shape of the `pg_aios` query. PG18+ only -- see the handler for why the
 * whole key is absent rather than empty on older servers.
 *
 * `off` and `length` come back as decimal strings for the same reason every
 * other bigint in this repo does (stats.ts, health.ts): node-pg hands back a
 * JS number for int8 and silently loses precision past 2^53. `off` is a file
 * offset, so the cast is cheap insurance rather than a live concern; `::text`
 * is correct whether the underlying column is int4 or int8, so it also
 * insulates this query from a future widening of either column.
 */
type AioRow = {
  pid: number;
  io_id: number;
  op: string | null;
  state: string | null;
  off: string | null;
  length: string | null;
  target_desc: string | null;
};

/**
 * Schema counterpart of {@link IoRow}. Every counter is `.nullable()` for the
 * reason IoRow spells out: pg_stat_io reports NULL, not 0, where an operation
 * is impossible for a (backend_type, object, context) combination. Declaring
 * any of them non-null would reject the response on essentially every server,
 * since a real pg_stat_io result always contains such rows.
 */
const ioRowOutput = z.object({
  backend_type: z.string(),
  io_object: z.string().describe("The view's `object` column, renamed -- it is a postgres keyword."),
  io_context: z.string().describe("The view's `context` column, renamed for symmetry with io_object."),
  reads: z.string().nullable(),
  read_bytes: z.string().nullable().describe("Source named by the top-level `byte_accounting`."),
  read_time_ms: z
    .number()
    .nullable()
    .describe("0 next to a non-zero op count means track_io_timing is OFF, not that the I/O was free."),
  writes: z.string().nullable(),
  write_bytes: z.string().nullable(),
  write_time_ms: z.number().nullable(),
  writebacks: z.string().nullable(),
  writeback_time_ms: z.number().nullable(),
  extends: z.string().nullable(),
  extend_bytes: z.string().nullable(),
  extend_time_ms: z.number().nullable(),
  hits: z.string().nullable(),
  evictions: z.string().nullable(),
  reuses: z.string().nullable(),
  fsyncs: z.string().nullable(),
  fsync_time_ms: z.number().nullable(),
  stats_reset: z.string().nullable().describe("These counters are cumulative SINCE this point. Null = never reset."),
});

/** Schema counterpart of {@link AioRow}. */
const aioRowOutput = z.object({
  pid: z.number().describe("Line this up against pg_health / pg_inspect_locks output for the same backend."),
  io_id: z.number(),
  op: z.string().nullable(),
  state: z.string().nullable(),
  off: z.string().nullable().describe("File offset, cast to text so a widened column stays lossless."),
  length: z.string().nullable(),
  target_desc: z.string().nullable(),
});

export const ioTools = [
  {
    name: "pg_io_stats",
    description:
      "I/O observability: cumulative per-backend-type I/O from `pg_stat_io` (PostgreSQL 16+), " +
      "plus in-flight asynchronous I/O handles from `pg_aios` (PostgreSQL 18+). This is the " +
      "layer underneath `pg_top_queries` and `pg_health` -- it says WHICH subsystem is doing " +
      "the I/O (client backends vs autovacuum vs checkpointer vs walwriter) and through which " +
      "path, which a per-query or per-table view cannot.\n" +
      "- io: one row per (`backend_type`, `io_object`, `io_context`) combination. Counters " +
      "`reads` / `writes` / `extends` / `writebacks` / `hits` / `evictions` / `reuses` / " +
      "`fsyncs` are bigints returned as decimal strings; `read_time_ms` / `write_time_ms` / " +
      "`writeback_time_ms` / `extend_time_ms` / `fsync_time_ms` are float8 milliseconds. A " +
      "timing of 0 next to a non-zero op count means `track_io_timing` is off, NOT that the " +
      "I/O was free -- turn it on to get real numbers. A NULL counter means the operation is " +
      "not possible for that combination, which is different from 0.\n" +
      "- io[].read_bytes / write_bytes / extend_bytes: a normalized byte figure that means the " +
      "same thing on every supported server. On PG16-17 it is computed as `op_bytes * <op " +
      "count>`; on PG18 `op_bytes` was removed and the server reports bytes directly. The " +
      "top-level `byte_accounting` field says which source produced the numbers.\n" +
      "- io[].stats_reset: these are CUMULATIVE counters, so a row is only interpretable next " +
      "to its reset point. Reported per row because that is how the view reports it; " +
      "`pg_stat_reset_shared('io')` resets them together in practice, but this tool does not " +
      "assert that.\n" +
      "- Rows whose counters are all zero are omitted by default (`pg_stat_io` is mostly zeros " +
      "on a quiet system, and the noise buries the handful of rows that matter). Pass " +
      "`includeZeroRows: true` for the full matrix.\n" +
      "- in_flight + io_method: PostgreSQL 18+ ONLY, and both keys are ABSENT on older servers " +
      "rather than empty/null -- an empty `in_flight` array would read as 'nothing is stalled' " +
      "when the truth is 'this server cannot tell you'. `in_flight` is live, currently-" +
      "outstanding async I/O (`pid`, `io_id`, `op`, `state`, `off`, `length`, `target_desc`), " +
      "which is what you want while a stall is happening rather than after it. `io_method` " +
      "(`worker` / `io_uring` / `sync`) explains what `in_flight` can contain: with " +
      "`io_method = sync` there is no asynchronous submission, so the array is legitimately " +
      "empty no matter how much I/O is running.\n" +
      "Requires PostgreSQL 16+. Sub-queries that fail (`pg_stat_io` and `pg_aios` are " +
      "permission-gated on some managed providers) append to `_warnings` and set their field " +
      "to null; the rest of the response still returns.",
    annotations: {
      title: "I/O statistics and in-flight async I/O",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      includeZeroRows: z
        .boolean()
        .default(false)
        .describe(
          "If true, return every (backend_type, io_object, io_context) row including the ones " +
            "with no recorded activity. Default false -- the view is mostly zeros on a quiet " +
            "system.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(200)
        .describe(
          "Max rows per section (default 200). pg_stat_io has well under 200 combinations, so " +
            "this effectively bounds the in-flight list on a busy PG18 server.",
        ),
    }),
    // `io_method` and `in_flight` are `.optional()`, never nullable-and-required:
    // the handler spreads them in only on PG18+, and the whole point of that
    // gate is that an absent key forces the caller to notice the server cannot
    // look, where `in_flight: []` would read as a confident "nothing is
    // stalled". Both are ALSO nullable, for the separate case where the server
    // can look and the sub-query was refused.
    outputSchema: z.object({
      server_version_num: z
        .number()
        .describe("Echoed so a caller can tell WHY the PG18-only keys are absent without a second round-trip."),
      byte_accounting: z
        .string()
        .describe("Which source produced read_bytes / write_bytes / extend_bytes: native columns, or op_bytes * ops."),
      include_zero_rows: z
        .boolean()
        .describe("Echoed because it changes what an empty `io` means: no recorded I/O, vs the view returned nothing."),
      io: z
        .array(ioRowOutput)
        .nullable()
        .describe("Null (not []) when the fetch was refused -- [] is a real answer on a freshly reset cluster."),
      io_method: z
        .string()
        .nullable()
        .optional()
        .describe(
          "PostgreSQL 18+ only. worker | io_uring | sync. With `sync` there is no async submission, " +
            "so `in_flight` is legitimately empty however much I/O is running.",
        ),
      in_flight: z
        .array(aioRowOutput)
        .nullable()
        .optional()
        .describe(
          "PostgreSQL 18+ only. Currently-outstanding async I/O. Null (not []) when the fetch was " +
            "refused -- reading a denial as 'nothing outstanding' would point the investigation the wrong way.",
        ),
      _warnings: warningsField,
    }),
    handler: async (input: unknown) => {
      // Zod defaults re-applied for direct (non-MCP) callers, which bypass the
      // schema -- matches the precedent in pg_explain / pg_table_bloat. `limit`
      // is the load-bearing one: undefined bound into `LIMIT $1` errors at bind
      // time rather than defaulting.
      const { includeZeroRows = false, limit = 200 } = input as {
        includeZeroRows?: boolean;
        limit?: number;
      };

      // Probed BEFORE withSharedClient, not inside it: the probe runs on its
      // own pooled connection, so holding the shared client across it would put
      // this one tool call at two concurrent connections out of a default pool
      // of five. Sequentially it is one at a time, and api.ts caches the result
      // process-wide after the first success. Same reasoning as pg_advisor.
      //
      // It also has to happen before any SQL is built, because the version
      // decides which columns the statements may NAME -- `op_bytes` does not
      // exist on PG18 and `read_bytes` does not exist on PG16/17, so a single
      // unconditional column list is guaranteed to 42703 on one of them.
      const serverVersion = await getServerVersionNum();

      if (serverVersion < PG16) {
        // getServerVersionNum returns 0 when the probe failed, and 0 lands here
        // too. That is the intended "assume oldest" behaviour, but the caller
        // must be able to tell "your server is too old" (act: upgrade) from "we
        // could not check" (act: retry) -- an undifferentiated version error
        // would send an agent to the wrong remediation.
        const detected =
          serverVersion > 0
            ? `this server reports server_version_num=${serverVersion}`
            : "this server's version could not be determined (the `server_version_num` probe " +
              "failed, so the oldest supported behaviour is assumed) -- retry once before " +
              "concluding the server is too old";
        return {
          ok: false,
          error:
            `pg_io_stats requires PostgreSQL 16 or newer: ${detected}. Unlike a missing ` +
            "extension there is nothing to install -- `pg_stat_io` was added in PostgreSQL 16 " +
            "and has no backport. Until the server is upgraded, use `pg_health` " +
            "(database_stats.blks_hit / blks_read) for the cluster-wide cache picture and " +
            "`pg_top_queries` (io_read_time_ms / io_write_time_ms, needs pg_stat_statements " +
            ">= 1.10 and track_io_timing = on) for per-query I/O.",
        };
      }

      // PG18 removed `op_bytes` and replaced it with direct `read_bytes` /
      // `write_bytes` / `extend_bytes` columns. Both branches below must
      // produce the SAME three output names so a caller never has to branch on
      // server version to read a byte figure -- that normalization is the whole
      // point of this fragment.
      //
      // Multiplied in `numeric`, not bigint: `reads * op_bytes` is a bigint
      // product that can in principle overflow int8 on a long-lived cluster,
      // and an overflow would fail the entire tool with a numeric-out-of-range
      // instead of reporting a large number. numeric has no such ceiling, and
      // ::text keeps it lossless on the way out, matching the bigint-as-text
      // convention in stats.ts / health.ts.
      //
      // NULL is deliberately allowed to propagate through the multiplication:
      // where `reads` is NULL (operation not possible for that combination)
      // the byte figure must be NULL too, not 0. A COALESCE here would invent
      // a "0 bytes read" that reads as a measurement.
      const isPg18 = serverVersion >= PG18;
      const byteCols = isPg18
        ? `read_bytes::text AS read_bytes,
               write_bytes::text AS write_bytes,
               extend_bytes::text AS extend_bytes,`
        : `(reads::numeric * op_bytes)::text AS read_bytes,
               (writes::numeric * op_bytes)::text AS write_bytes,
               (extends::numeric * op_bytes)::text AS extend_bytes,`;

      // Provenance for the three columns above. Reported unconditionally (not
      // only on the computed branch) so the field is never absent -- a caller
      // comparing byte figures across two servers needs to know that one side
      // is `op_bytes`-derived and therefore always a multiple of the block
      // size, while the PG18 side is the real byte count.
      const byteAccounting = isPg18
        ? "native read_bytes / write_bytes / extend_bytes columns (PG18+)"
        : "op_bytes * operation count (PG16-17; op_bytes was removed in PG18)";

      // The all-zero filter has to COALESCE, unlike the SELECT list: a row
      // where every applicable counter is 0 and the rest are NULL is exactly
      // the noise this filter exists to drop, and `NULL + 0 > 0` evaluates to
      // NULL (not true), which would keep every such row.
      //
      // `hits` is included in the sum on purpose: a combination with millions
      // of buffer hits and zero reads is not an idle row, it is the shared-
      // buffers success story, and dropping it would make the cache picture
      // look worse than it is.
      const zeroFilter = includeZeroRows
        ? ""
        : `WHERE (COALESCE(reads, 0) + COALESCE(writes, 0) + COALESCE(extends, 0)
                    + COALESCE(writebacks, 0) + COALESCE(hits, 0) + COALESCE(evictions, 0)
                    + COALESCE(reuses, 0) + COALESCE(fsyncs, 0)) > 0`;

      // Up to 3 queries on one connection -- see api.ts:withSharedClient.
      return withSharedClient(async (run) => {
        const [ioRes, aiosRes, methodRes] = await Promise.all([
          run<IoRow>(
            // `object` and `context` are quoted and renamed: both are keywords
            // (non-reserved, so bare use happens to parse today) and both are
            // far more legible to a caller as io_object / io_context, matching
            // how the postgres docs name the underlying enum types.
            //
            // Timings are NOT NULLIF'd to hide zeros, unlike pg_top_queries.
            // There, 0 was ambiguous between "timing off" and "no IO". Here the
            // op counters sit on the same row, so `read_time_ms: 0` next to
            // `reads: "48213"` is an unambiguous, actionable signal that
            // track_io_timing is off -- nulling it would destroy that.
            //
            // ORDER BY qualifies every counter with the table name to dodge the
            // alias-shadowing trap documented in pg_top_queries: the SELECT
            // aliases `reads::text AS reads`, and postgres resolves a BARE
            // output name in ORDER BY to the output alias first, which would
            // sort text ("9" ahead of "10"). Qualified names always route to
            // the source bigint column.
            `SELECT
               backend_type,
               "object" AS io_object,
               context AS io_context,
               reads::text AS reads,
               ${byteCols}
               read_time::numeric(18, 2)::float8 AS read_time_ms,
               writes::text AS writes,
               write_time::numeric(18, 2)::float8 AS write_time_ms,
               writebacks::text AS writebacks,
               writeback_time::numeric(18, 2)::float8 AS writeback_time_ms,
               extends::text AS extends,
               extend_time::numeric(18, 2)::float8 AS extend_time_ms,
               hits::text AS hits,
               evictions::text AS evictions,
               reuses::text AS reuses,
               fsyncs::text AS fsyncs,
               fsync_time::numeric(18, 2)::float8 AS fsync_time_ms,
               stats_reset::text AS stats_reset
             FROM pg_catalog.pg_stat_io
             ${zeroFilter}
             ORDER BY (COALESCE(pg_stat_io.reads, 0) + COALESCE(pg_stat_io.writes, 0)
                       + COALESCE(pg_stat_io.extends, 0) + COALESCE(pg_stat_io.hits, 0)) DESC,
                      backend_type, "object", context
             LIMIT $1`,
            [limit],
          ),
          // pg_aios does not exist before PG18 -- naming it there is a 42P01
          // that would take the whole tool down with it, so the query is not
          // issued at all rather than issued and caught. Promise.resolve(null)
          // keeps the Promise.all destructure positional on every version.
          isPg18
            ? run<AioRow>(
                // These are handles outstanding RIGHT NOW, so there is no
                // cumulative counter to compare against and no stats_reset to
                // interpret them by -- the value is entirely in the snapshot.
                // Ordered by pid so a caller can line rows up against the
                // pg_health / pg_inspect_locks output for the same backend,
                // which is the actual diagnostic move: "pid 4821 is blocked ->
                // pid 4821 has 12 reads outstanding against this relation".
                //
                // `off` is quoted because OFF is a postgres keyword; the view's
                // own column is spelled that way, so it has to be quoted on the
                // input side rather than renamed away.
                `SELECT
                   pid,
                   io_id,
                   operation AS op,
                   state,
                   "off"::text AS "off",
                   length::text AS length,
                   target_desc
                 FROM pg_catalog.pg_aios
                 ORDER BY pid, io_id
                 LIMIT $1`,
                [limit],
              )
            : Promise.resolve(null),
          // `io_method` is a PG18 GUC. The two-argument form of
          // current_setting() returns NULL for an unknown setting instead of
          // raising 42704, which keeps this from becoming a hard failure if a
          // build reports >= 180000 without the parameter (an alternative
          // distribution, a future rename). Issued separately from pg_aios on
          // purpose: pg_aios is the permission-gated one, and losing it must
          // not also lose the setting that explains what it would have held.
          isPg18
            ? run<{ io_method: string | null }>(`SELECT current_setting('io_method', true) AS io_method`)
            : Promise.resolve(null),
        ]);

        // Partial-failure surfacing matches pg_health / pg_replication_status /
        // pg_advisor: collect failed sub-queries in a top-level _warnings array
        // and return the readable portion. Each check is an independent `if`,
        // never an early return -- pg_stat_io is superuser / pg_monitor gated on
        // several managed providers, so losing it while pg_aios and the GUC are
        // still readable is an expected path, not an edge case.
        const warnings: string[] = [];
        if (!ioRes.ok) warnings.push(`io fetch failed: ${ioRes.error}`);
        if (aiosRes && !aiosRes.ok) warnings.push(`in_flight fetch failed: ${aiosRes.error}`);
        if (methodRes && !methodRes.ok) warnings.push(`io_method fetch failed: ${methodRes.error}`);

        return {
          ok: true,
          data: {
            // Echoed so a caller can tell WHY the PG18-only keys below are
            // absent without a second round-trip to version().
            server_version_num: serverVersion,
            byte_accounting: byteAccounting,
            // Echoed because it changes what an empty `io` array means: with
            // the filter on, empty means "no recorded I/O anywhere"; with it
            // off, empty means the view itself returned nothing.
            include_zero_rows: includeZeroRows,
            // null, not [], on failure. An empty array is a real and reachable
            // answer here (a freshly reset cluster), so it must not double as
            // the error value -- a caller seeing [] would conclude the server
            // is idle when it actually refused to answer. The _warnings entry
            // above carries the reason.
            io: ioRes.ok ? (ioRes.data ?? []) : null,
            // PG18+ keys are spread in, so on PG16/17 they are ABSENT from the
            // response rather than null or []. That distinction is the whole
            // point: `in_flight: []` reads as "nothing is stalled", which is a
            // confident wrong answer on a server that has no way to look. A
            // missing key forces the caller to notice.
            ...(isPg18
              ? {
                  // NULL here is legitimate (see current_setting's missing_ok
                  // above) and is also the failure value -- disambiguated by
                  // the _warnings entry rather than by the field.
                  io_method: methodRes?.ok ? (methodRes.data?.[0]?.io_method ?? null) : null,
                  // Same null-on-failure reasoning as `io`, and it matters more
                  // here: this tool gets called BECAUSE something is stalling,
                  // so a permission denial that renders as "no in-flight I/O"
                  // would actively point the investigation the wrong way.
                  in_flight: aiosRes?.ok ? (aiosRes.data ?? []) : null,
                }
              : {}),
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      });
    },
  },
] as const;
