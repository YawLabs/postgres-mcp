import { z } from "zod";
import { runInternal } from "../api.js";

const identSchema = z.string().min(1).max(63);

export const statsTools = [
  {
    name: "pg_top_queries",
    description:
      "Top N queries by total or mean execution time. Requires the `pg_stat_statements` " +
      "extension to be installed and enabled (most managed Postgres providers have it on " +
      "by default). Returns normalized query text (constants replaced with `?`), call count, " +
      "total/mean/min/max time in ms, rows returned, and cache hit ratio. Use this to find " +
      "slow queries worth optimizing.",
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
      const { orderBy, limit } = input as { orderBy: "total_time" | "mean_time" | "calls"; limit: number };

      // First check the extension is present — without it the query below fails
      // with a confusing "relation does not exist" error.
      const check = await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'
         ) AS installed`,
      );
      if (!check.ok) return check;
      if (!check.data?.[0]?.installed) {
        return {
          ok: false,
          error:
            "pg_stat_statements extension is not installed. Install it with " +
            "`CREATE EXTENSION pg_stat_statements;` (may require superuser) and add " +
            "`pg_stat_statements` to `shared_preload_libraries` in postgresql.conf, then restart.",
        };
      }

      // Column names changed in Postgres 13 (pg_stat_statements 1.8): `total_time`
      // became `total_exec_time`, `mean_time` became `mean_exec_time`. We query
      // the extension version and pick the right column names.
      const versionRes = await runInternal<{ version: string }>(
        `SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'`,
      );
      const extVersion = versionRes.ok ? (versionRes.data?.[0]?.version ?? "0") : "0";
      const useExecSuffix = compareVersions(extVersion, "1.8") >= 0;
      const totalCol = useExecSuffix ? "total_exec_time" : "total_time";
      const meanCol = useExecSuffix ? "mean_exec_time" : "mean_time";
      const minCol = useExecSuffix ? "min_exec_time" : "min_time";
      const maxCol = useExecSuffix ? "max_exec_time" : "max_time";

      const orderCol = orderBy === "total_time" ? totalCol : orderBy === "mean_time" ? meanCol : "calls";

      return runInternal<{
        query: string;
        calls: string;
        total_time_ms: number;
        mean_time_ms: number;
        min_time_ms: number;
        max_time_ms: number;
        rows: string;
        hit_percent: number | null;
      }>(
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
           END AS hit_percent
         FROM pg_stat_statements
         ORDER BY ${orderCol} DESC NULLS LAST
         LIMIT $1`,
        [limit],
      );
    },
  },

  {
    name: "pg_seq_scan_tables",
    description:
      "Tables with high sequential-scan counts relative to index scans — the first place to " +
      "look for missing-index candidates. Returns seq_scans, idx_scans, live tuples, and the " +
      "ratio. A high ratio on a large table usually means a query is reading the whole table " +
      "where an index would suffice. Pair with `pg_top_queries` to find which query is doing it.",
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
      const { schema, minSize, limit } = input as { schema?: string; minSize: number; limit: number };
      const schemaFilter = schema
        ? "AND schemaname = $3"
        : "AND schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_%'";
      const params: unknown[] = [minSize, limit];
      if (schema) params.push(schema);
      return runInternal<{
        schema: string;
        table: string;
        seq_scans: string;
        idx_scans: string;
        live_tuples: string;
        seq_tup_read: string;
        ratio: number | null;
      }>(
        `SELECT
           schemaname AS schema,
           relname AS "table",
           seq_scan::text AS seq_scans,
           COALESCE(idx_scan, 0)::text AS idx_scans,
           n_live_tup::text AS live_tuples,
           seq_tup_read::text AS seq_tup_read,
           CASE
             WHEN COALESCE(idx_scan, 0) = 0 AND seq_scan > 0 THEN NULL
             WHEN COALESCE(idx_scan, 0) = 0 THEN 0
             ELSE (seq_scan::numeric / NULLIF(idx_scan, 0))::numeric(10, 2)::float8
           END AS ratio
         FROM pg_catalog.pg_stat_user_tables
         WHERE n_live_tup >= $1
           ${schemaFilter}
         ORDER BY seq_scan DESC NULLS LAST
         LIMIT $2`,
        params,
      );
    },
  },

  {
    name: "pg_unused_indexes",
    description:
      "Indexes that have never been scanned or have very low usage. Each unused index costs " +
      "write amplification (every INSERT/UPDATE maintains it) and disk space. Excludes primary " +
      "keys and unique constraints (which are load-bearing even with zero scans). Use this " +
      "before adding new indexes — sometimes the fix is to drop a dead one.",
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
      const { schema, maxScans, limit } = input as { schema?: string; maxScans: number; limit: number };
      const schemaFilter = schema
        ? "AND s.schemaname = $3"
        : "AND s.schemaname NOT IN ('pg_catalog', 'information_schema') AND s.schemaname NOT LIKE 'pg_%'";
      const params: unknown[] = [maxScans, limit];
      if (schema) params.push(schema);
      return runInternal<{
        schema: string;
        table: string;
        index: string;
        scans: string;
        size_pretty: string;
        size_bytes: string;
        definition: string;
      }>(
        `SELECT
           s.schemaname AS schema,
           s.relname AS "table",
           s.indexrelname AS "index",
           s.idx_scan::text AS scans,
           pg_size_pretty(pg_relation_size(s.indexrelid)) AS size_pretty,
           pg_relation_size(s.indexrelid)::text AS size_bytes,
           pg_catalog.pg_get_indexdef(s.indexrelid) AS definition
         FROM pg_catalog.pg_stat_user_indexes s
         JOIN pg_catalog.pg_index i ON i.indexrelid = s.indexrelid
         WHERE s.idx_scan <= $1
           AND NOT i.indisunique
           AND NOT i.indisprimary
           ${schemaFilter}
         ORDER BY pg_relation_size(s.indexrelid) DESC
         LIMIT $2`,
        params,
      );
    },
  },
] as const;

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
