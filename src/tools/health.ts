import { z } from "zod";
import { withSharedClient } from "../api.js";

export const healthTools = [
  {
    name: "pg_health",
    description:
      "Quick health snapshot: server version, database size, connection count, active queries, " +
      "and table count. Useful as a connection sanity check and to spot runaway queries.",
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
    handler: async (input: unknown) => {
      const { activeQueryLimit } = input as { activeQueryLimit: number };
      // 5-way catalog fanout on a single shared connection -- avoids
      // saturating the pool (default max 5) on one health probe.
      return withSharedClient(async (run) => {
        const [versionRes, sizeRes, connsRes, activeRes, tableCountRes] = await Promise.all([
          run<{ version: string }>(`SELECT version() AS version`),
          run<{ database: string; size_pretty: string; size_bytes: string }>(
            `SELECT
               current_database() AS database,
               pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
               pg_database_size(current_database())::text AS size_bytes`,
          ),
          run<{ total: string; active: string; idle: string; idle_in_transaction: string }>(
            `SELECT
               count(*)::text AS total,
               count(*) FILTER (WHERE state = 'active')::text AS active,
               count(*) FILTER (WHERE state = 'idle')::text AS idle,
               count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction
             FROM pg_stat_activity
             WHERE datname = current_database()`,
          ),
          run<{
            pid: number;
            state: string | null;
            duration_seconds: number | null;
            query: string;
            application_name: string;
          }>(
            `SELECT
               pid,
               state,
               EXTRACT(EPOCH FROM (now() - query_start))::numeric(10, 2)::float8 AS duration_seconds,
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
        const warnings: string[] = [];
        if (!sizeRes.ok) warnings.push(`database fetch failed: ${sizeRes.error}`);
        if (!connsRes.ok) warnings.push(`connections fetch failed: ${connsRes.error}`);
        if (!activeRes.ok) warnings.push(`active_queries fetch failed: ${activeRes.error}`);
        if (!tableCountRes.ok) warnings.push(`table_count fetch failed: ${tableCountRes.error}`);

        return {
          ok: true,
          data: {
            connected: true,
            version: versionRes.data?.[0]?.version,
            database: sizeRes.ok ? sizeRes.data?.[0] : null,
            connections: connsRes.ok ? connsRes.data?.[0] : null,
            active_queries: activeRes.ok ? activeRes.data : [],
            table_count: tableCountRes.ok ? tableCountRes.data?.[0]?.count : null,
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      });
    },
  },
] as const;
