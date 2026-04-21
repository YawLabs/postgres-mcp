import { z } from "zod";
import { runInternal } from "../api.js";

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
    inputSchema: z.object({}),
    handler: async () => {
      const [versionRes, sizeRes, connsRes, activeRes, tableCountRes] = await Promise.all([
        runInternal<{ version: string }>(`SELECT version() AS version`),
        runInternal<{ database: string; size_pretty: string; size_bytes: string }>(
          `SELECT
             current_database() AS database,
             pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
             pg_database_size(current_database())::text AS size_bytes`,
        ),
        runInternal<{ total: string; active: string; idle: string; idle_in_transaction: string }>(
          `SELECT
             count(*)::text AS total,
             count(*) FILTER (WHERE state = 'active')::text AS active,
             count(*) FILTER (WHERE state = 'idle')::text AS idle,
             count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction
           FROM pg_stat_activity
           WHERE datname = current_database()`,
        ),
        runInternal<{
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
           LIMIT 10`,
        ),
        runInternal<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p')
             AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg_toast%'`,
        ),
      ]);

      // If we can't even get the version, connectivity is broken — surface that
      // directly instead of returning a half-empty object.
      if (!versionRes.ok) return versionRes;

      return {
        ok: true,
        data: {
          connected: true,
          version: versionRes.data?.[0]?.version,
          database: sizeRes.ok ? sizeRes.data?.[0] : { error: sizeRes.error },
          connections: connsRes.ok ? connsRes.data?.[0] : { error: connsRes.error },
          active_queries: activeRes.ok ? activeRes.data : [],
          table_count: tableCountRes.ok ? tableCountRes.data?.[0]?.count : null,
        },
      };
    },
  },
] as const;
