import { z } from "zod";
import { isWritesAllowed, runInternal } from "../api.js";

export const adminTools = [
  {
    name: "pg_inspect_locks",
    description:
      "Show current lock contention: which sessions are blocked and who is blocking them. " +
      "Returns blocked PID, blocking PID, lock types, relation being contested, and the queries " +
      "involved. Use this first when a tool call hangs or the app feels stuck — it's the fastest " +
      "way to identify a long-held transaction holding a lock.",
    annotations: {
      title: "Inspect blocking locks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(50).describe("Max blocked/blocker pairs (default 50)."),
    }),
    handler: async (input: unknown) => {
      const { limit } = input as { limit: number };
      return runInternal<{
        blocked_pid: number;
        blocked_user: string;
        blocked_query: string;
        blocked_duration_seconds: number | null;
        blocking_pid: number;
        blocking_user: string;
        blocking_query: string;
        blocking_state: string;
        blocking_duration_seconds: number | null;
        relation: string | null;
        lock_type: string;
      }>(
        `SELECT
           blocked.pid AS blocked_pid,
           blocked.usename AS blocked_user,
           blocked.query AS blocked_query,
           EXTRACT(EPOCH FROM (now() - blocked.query_start))::numeric(10, 2)::float8 AS blocked_duration_seconds,
           blocking.pid AS blocking_pid,
           blocking.usename AS blocking_user,
           blocking.query AS blocking_query,
           blocking.state AS blocking_state,
           EXTRACT(EPOCH FROM (now() - blocking.query_start))::numeric(10, 2)::float8 AS blocking_duration_seconds,
           CASE
             WHEN bl.relation IS NOT NULL
               THEN (SELECT n.nspname || '.' || c.relname
                     FROM pg_catalog.pg_class c
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE c.oid = bl.relation)
             ELSE NULL
           END AS relation,
           bl.locktype AS lock_type
         FROM pg_catalog.pg_locks bl
         JOIN pg_catalog.pg_stat_activity blocked ON blocked.pid = bl.pid
         JOIN LATERAL unnest(pg_blocking_pids(bl.pid)) AS bpid(pid) ON TRUE
         JOIN pg_catalog.pg_stat_activity blocking ON blocking.pid = bpid.pid
         WHERE NOT bl.granted
         ORDER BY blocked.query_start NULLS LAST
         LIMIT $1`,
        [limit],
      );
    },
  },

  {
    name: "pg_list_roles",
    description:
      "List database roles (users and groups) with their login/superuser/createdb/createrole " +
      "attributes and inherited role memberships. Use this to answer 'who has access to this " +
      "database?' without needing to read `pg_authid` directly.",
    annotations: {
      title: "List roles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      includeSystem: z
        .boolean()
        .default(false)
        .describe("If true, include built-in `pg_*` roles (pg_read_all_data, pg_monitor, etc.)."),
    }),
    handler: async (input: unknown) => {
      const { includeSystem } = input as { includeSystem: boolean };
      // `starts_with` (pg 11+) is cleaner than LIKE for a literal-underscore
      // prefix match — LIKE requires escaping _ and the escape clause itself
      // needs careful backslash handling through JS -> SQL.
      const filter = includeSystem ? "" : "WHERE NOT starts_with(r.rolname, 'pg_')";
      return runInternal<{
        name: string;
        can_login: boolean;
        superuser: boolean;
        createdb: boolean;
        createrole: boolean;
        replication: boolean;
        bypass_rls: boolean;
        member_of: string[];
      }>(
        // Cast member_of to text[] so node-pg parses it into a JS array.
        // Without the cast, it comes back as the postgres text form `{a,b}`.
        `SELECT
           r.rolname AS name,
           r.rolcanlogin AS can_login,
           r.rolsuper AS superuser,
           r.rolcreatedb AS createdb,
           r.rolcreaterole AS createrole,
           r.rolreplication AS replication,
           r.rolbypassrls AS bypass_rls,
           COALESCE(
             (SELECT array_agg(g.rolname::text ORDER BY g.rolname)
              FROM pg_catalog.pg_auth_members m
              JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
              WHERE m.member = r.oid),
             ARRAY[]::text[]
           ) AS member_of
         FROM pg_catalog.pg_roles r
         ${filter}
         ORDER BY r.rolname`,
      );
    },
  },

  {
    name: "pg_table_privileges",
    description:
      "Show which roles have which privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, " +
      "REFERENCES, TRIGGER) on a table or on every table in a schema. If `table` is omitted, " +
      "the result spans every table in `schema`, ordered by table then grantee. Use this to " +
      "answer 'who can write to this table?' or to audit schema-wide access before a migration.",
    annotations: {
      title: "Show table privileges",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: z.string().min(1).max(63).default("public").describe("Schema name (defaults to 'public')."),
      table: z
        .string()
        .min(1)
        .max(63)
        .optional()
        .describe("Table name. Omit to list privileges for all tables in the schema."),
    }),
    handler: async (input: unknown) => {
      const { schema, table } = input as { schema: string; table?: string };
      const tableFilter = table ? "AND table_name = $2" : "";
      const params: unknown[] = [schema];
      if (table) params.push(table);
      return runInternal<{
        table: string;
        grantee: string;
        privilege_type: string;
        is_grantable: boolean;
      }>(
        `SELECT
           table_name AS "table",
           grantee,
           privilege_type,
           is_grantable::boolean AS is_grantable
         FROM information_schema.table_privileges
         WHERE table_schema = $1
           ${tableFilter}
         ORDER BY table_name, grantee, privilege_type`,
        params,
      );
    },
  },

  {
    name: "pg_kill",
    description:
      "Cancel a running query (SIGINT-equivalent) or terminate a backend connection (SIGTERM-" +
      "equivalent) by PID. Find the PID via `pg_health` active_queries or `pg_inspect_locks`. " +
      "Requires ALLOW_WRITES=1 since this changes database session state. The role in " +
      "DATABASE_URL must have permission — cancelling another user's query needs the " +
      "`pg_signal_backend` role or superuser. Cancel is graceful; terminate is forceful.",
    annotations: {
      title: "Cancel or terminate a backend",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      pid: z.number().int().min(1).describe("Backend PID to signal."),
      mode: z
        .enum(["cancel", "terminate"])
        .default("cancel")
        .describe("`cancel` aborts the current query; `terminate` closes the connection entirely."),
    }),
    handler: async (input: unknown) => {
      const { pid, mode } = input as { pid: number; mode: "cancel" | "terminate" };
      if (!isWritesAllowed()) {
        return {
          ok: false,
          error:
            "pg_kill requires ALLOW_WRITES=1 because cancelling or terminating a backend changes " +
            "session state. Set ALLOW_WRITES=1 in the MCP server env.",
        };
      }
      const fn = mode === "terminate" ? "pg_terminate_backend" : "pg_cancel_backend";
      const result = await runInternal<{ signaled: boolean }>(`SELECT ${fn}($1) AS signaled`, [pid]);
      if (!result.ok) return result;
      const signaled = result.data?.[0]?.signaled === true;
      return {
        ok: true,
        data: {
          pid,
          mode,
          signaled,
          note: signaled
            ? `Sent ${mode === "terminate" ? "SIGTERM" : "SIGINT"} to backend ${pid}.`
            : `Signal returned false — PID ${pid} may not exist, may already be gone, or the current role lacks permission.`,
        },
      };
    },
  },

  {
    name: "pg_replication_status",
    description:
      "Replication overview: configured replication slots, connected replicas (from " +
      "`pg_stat_replication`), and current WAL position. Use on primary to spot lagging or " +
      "disconnected replicas, on replicas to see upstream status. Returns empty arrays on a " +
      "standalone (non-replicated) database rather than erroring.",
    annotations: {
      title: "Replication status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const [slotsRes, replicasRes, walRes] = await Promise.all([
        runInternal<{
          slot_name: string;
          slot_type: string;
          active: boolean;
          restart_lsn: string | null;
          confirmed_flush_lsn: string | null;
          wal_status: string | null;
          database: string | null;
          plugin: string | null;
        }>(
          `SELECT
             slot_name, slot_type, active,
             restart_lsn::text AS restart_lsn,
             confirmed_flush_lsn::text AS confirmed_flush_lsn,
             wal_status, database, plugin
           FROM pg_catalog.pg_replication_slots
           ORDER BY slot_name`,
        ),
        runInternal<{
          application_name: string;
          client_addr: string | null;
          state: string;
          sync_state: string;
          write_lag_seconds: number | null;
          flush_lag_seconds: number | null;
          replay_lag_seconds: number | null;
        }>(
          `SELECT
             application_name,
             client_addr::text AS client_addr,
             state,
             sync_state,
             EXTRACT(EPOCH FROM write_lag)::numeric(10, 2)::float8 AS write_lag_seconds,
             EXTRACT(EPOCH FROM flush_lag)::numeric(10, 2)::float8 AS flush_lag_seconds,
             EXTRACT(EPOCH FROM replay_lag)::numeric(10, 2)::float8 AS replay_lag_seconds
           FROM pg_catalog.pg_stat_replication
           ORDER BY application_name`,
        ),
        runInternal<{ is_in_recovery: boolean; wal_position: string | null }>(
          `SELECT
             pg_is_in_recovery() AS is_in_recovery,
             CASE
               WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()::text
               ELSE pg_current_wal_lsn()::text
             END AS wal_position`,
        ),
      ]);

      if (!slotsRes.ok) return slotsRes;
      if (!replicasRes.ok) return replicasRes;
      if (!walRes.ok) return walRes;

      return {
        ok: true,
        data: {
          is_replica: walRes.data?.[0]?.is_in_recovery ?? false,
          wal_position: walRes.data?.[0]?.wal_position ?? null,
          slots: slotsRes.data ?? [],
          replicas: replicasRes.data ?? [],
        },
      };
    },
  },

  {
    name: "pg_table_bloat",
    description:
      "Estimate table bloat (dead tuples + free space) for tables in a schema. Returns live " +
      "tuples, dead tuples, dead-tuple ratio, last_vacuum / last_autovacuum timestamps, and " +
      "total relation size. A high dead_ratio with a stale last_autovacuum is a sign a table " +
      "needs VACUUM. Cheap — uses `pg_stat_user_tables`, no extensions required.",
    annotations: {
      title: "Estimate table bloat",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: z
        .string()
        .min(1)
        .max(63)
        .optional()
        .describe("Limit to one schema. If omitted, all user schemas are included."),
      minDeadRatio: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe("Minimum dead-tuple fraction to include — dead / (live + dead). Default 0.1 = 10%."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return (default 50)."),
    }),
    handler: async (input: unknown) => {
      const { schema, minDeadRatio, limit } = input as {
        schema?: string;
        minDeadRatio: number;
        limit: number;
      };
      const schemaFilter = schema
        ? "AND schemaname = $3"
        : "AND schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_%'";
      const params: unknown[] = [minDeadRatio, limit];
      if (schema) params.push(schema);
      return runInternal<{
        schema: string;
        table: string;
        live_tuples: string;
        dead_tuples: string;
        dead_ratio: number;
        size_pretty: string;
        size_bytes: string;
        last_vacuum: string | null;
        last_autovacuum: string | null;
        last_analyze: string | null;
      }>(
        // dead_ratio = dead / (live + dead): bounded [0, 1]. A 100%-dead table
        // (live=0, dead>0) correctly reports 1.0 instead of 0. Tables with both
        // counters at 0 are filtered out -- nothing to report.
        `SELECT
           schemaname AS schema,
           relname AS "table",
           n_live_tup::text AS live_tuples,
           n_dead_tup::text AS dead_tuples,
           (n_dead_tup::float8 / (n_live_tup + n_dead_tup))::numeric(6, 3)::float8 AS dead_ratio,
           pg_size_pretty(pg_total_relation_size(relid)) AS size_pretty,
           pg_total_relation_size(relid)::text AS size_bytes,
           last_vacuum::text AS last_vacuum,
           last_autovacuum::text AS last_autovacuum,
           last_analyze::text AS last_analyze
         FROM pg_catalog.pg_stat_user_tables
         WHERE (n_live_tup + n_dead_tup) > 0
           AND (n_dead_tup::float8 / (n_live_tup + n_dead_tup)) >= $1
           ${schemaFilter}
         ORDER BY n_dead_tup DESC
         LIMIT $2`,
        params,
      );
    },
  },
] as const;
