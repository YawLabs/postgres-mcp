import { z } from "zod";
import {
  formatPgError,
  getPool,
  getServerVersionNum,
  isWritesAllowed,
  PG18,
  runInternal,
  withSharedClient,
} from "../api.js";
import { rowsOutput, warningsField } from "./output.js";
import { identSchema } from "./params.js";

/**
 * `server_version_num` cut point for PostgreSQL 19, which added the
 * per-relation `stats_reset` that pg_table_bloat reads below. Declared here
 * rather than beside the PG16 / PG17 / PG18 constants in api.ts only because
 * api.ts is being edited concurrently with this change; hoist it next to its
 * siblings once both land, so a version cut point keeps exactly one home.
 */
const PG19 = 190_000;

/**
 * Which of the two independent counters put a pg_advisor wraparound row over
 * the threshold. Non-optional on every wraparound row: a table listed purely
 * for multixact pressure needs a completely different remediation (find the
 * row-locking workload) than one listed for xid age (get a freeze VACUUM
 * through), and without this the operator cannot tell them apart from the
 * numbers alone.
 */
type WraparoundTrigger = "xid" | "multixact" | "both";
const wraparoundTriggerOutput = z
  .enum(["xid", "multixact", "both"])
  .describe("'xid' -> chase freezing/autovacuum; 'multixact' -> chase the lock-heavy workload burning members.");

/**
 * mxid_age / pct_of_multixact_freeze_max_age are nullable, unlike their xid
 * twins: rows whose minmxid is InvalidMultiXactId are excluded from the
 * multixact evaluation (see the guard in the query below) but still returned
 * when the xid side is dangerous. Null here means "no multixact horizon
 * recorded", and triggered_by will never be 'multixact'/'both' on such a row.
 *
 * pages / all_frozen_pages / frozen_page_fraction are PG18+ only, and OPTIONAL
 * rather than `number | null`: the columns are ABSENT from the row on older
 * servers, not null -- a caller seeing `frozen_page_fraction: null` would read
 * it as "no pages frozen" (an alarming, actionable value) rather than "this
 * server cannot report freeze coverage".
 */
type WraparoundTableRow = {
  schema: string;
  table: string;
  relkind: string;
  xid_age: number;
  freeze_max_age: number;
  pct_of_freeze_max_age: number | null;
  mxid_age: number | null;
  multixact_freeze_max_age: number;
  pct_of_multixact_freeze_max_age: number | null;
  triggered_by: WraparoundTrigger;
  pages?: number;
  all_frozen_pages?: number;
  frozen_page_fraction?: number | null;
};

/** Schema counterpart of {@link WraparoundTableRow}. */
const wraparoundTableRowOutput = z.object({
  schema: z.string(),
  table: z.string(),
  relkind: z.string().describe("Raw relkind: 'r' heap, 'm' materialized view, 't' TOAST -- the only three checked."),
  xid_age: z.number().describe("age(relfrozenxid)."),
  freeze_max_age: z.number().describe("EFFECTIVE limit: a per-table storage parameter wins over the cluster GUC."),
  pct_of_freeze_max_age: z.number().nullable().describe("At 1.0 autovacuum forces an anti-wraparound VACUUM."),
  mxid_age: z.number().nullable().describe("mxid_age(relminmxid). Null when no multixact was ever recorded."),
  multixact_freeze_max_age: z.number().describe("EFFECTIVE limit, resolved the same way as freeze_max_age."),
  pct_of_multixact_freeze_max_age: z.number().nullable(),
  triggered_by: wraparoundTriggerOutput,
  pages: z.number().optional().describe("PostgreSQL 18+ only, absent below that. relpages."),
  all_frozen_pages: z.number().optional().describe("PostgreSQL 18+ only, absent below that. relallfrozen."),
  frozen_page_fraction: z
    .number()
    .nullable()
    .optional()
    .describe("PostgreSQL 18+ only, absent below that. Null when relpages is 0, not when coverage is 0."),
});

type WraparoundDatabaseRow = {
  database: string;
  xid_age: number;
  mxid_age: number | null;
  pct_of_freeze_max_age: number | null;
  pct_of_multixact_freeze_max_age: number | null;
  triggered_by: WraparoundTrigger;
};

/** Schema counterpart of {@link WraparoundDatabaseRow}. */
const wraparoundDatabaseRowOutput = z.object({
  database: z.string().describe("Template databases included -- template0 ages like any other."),
  xid_age: z.number().describe("age(datfrozenxid)."),
  mxid_age: z.number().nullable().describe("mxid_age(datminmxid). Null when no multixact was ever recorded."),
  pct_of_freeze_max_age: z.number().nullable(),
  pct_of_multixact_freeze_max_age: z.number().nullable(),
  triggered_by: wraparoundTriggerOutput,
});

/**
 * Row shape shared by all three pg_table_bloat methods. `stats_reset` is PG19+
 * only and ABSENT rather than null below that: a caller seeing
 * `stats_reset: null` on a PG17 server would read it as "these counters have
 * never been reset" (a real and reassuring fact) when the truth is that the
 * server cannot say.
 */
type BloatRow = {
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
  stats_reset?: string | null;
};

/** Schema counterpart of {@link BloatRow}. */
const bloatRowOutput = z.object({
  schema: z.string(),
  table: z.string(),
  live_tuples: z.string().describe("Bigint as a decimal string."),
  dead_tuples: z.string().describe("Bigint as a decimal string."),
  dead_ratio: z.number().describe("dead / (live + dead), bounded [0, 1]. Rows with both counters at 0 are filtered."),
  size_pretty: z.string(),
  size_bytes: z.string(),
  last_vacuum: z.string().nullable(),
  last_autovacuum: z.string().nullable(),
  last_analyze: z.string().nullable(),
  stats_reset: z
    .string()
    .nullable()
    .optional()
    .describe(
      "PostgreSQL 19+ only, absent below that. When THIS relation's counters were last reset by " +
        "pg_stat_reset_single_table_counters() -- which zeroes the tuple counts AND clears every " +
        "last_* timestamp together. Null on PG19+ means never reset.",
    ),
});

export const adminTools = [
  {
    name: "pg_inspect_locks",
    description:
      "Show current lock contention: which sessions are blocked and who is blocking them. " +
      "Returns blocked PID, blocking PID, lock types, relation being contested, and the queries " +
      "involved. Use this first when a tool call hangs or the app feels stuck - it's the fastest " +
      "way to identify a long-held transaction holding a lock. " +
      "Row shape: one row per (blocked_pid, blocking_pid) pair. A session waiting on multiple " +
      "blockers appears on multiple rows -- group/deduplicate by `blocked_pid` if you want a " +
      "per-blocked-session count. " +
      "Caveat on `relation`: for non-relation waits (transactionid/virtualxid, where the wait " +
      "is on the blocker's xid rather than a table) `relation` is a best-effort hint -- an " +
      "alphabetical guess among the blocker's held write-intent locks -- not authoritative. " +
      "Use the blocked/blocking query text to disambiguate which table is actually contested.",
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
    // The user / query / state columns are NULLABLE, unlike the equivalents in
    // pg_health.active_queries. Both read pg_stat_activity, but pg_health
    // filters on `state IS NOT NULL`, which drops exactly the rows postgres
    // withholds; this query has no such filter -- it must show every blocker,
    // including ones the calling role can neither own nor read. postgres
    // withholds those columns from a role lacking pg_read_all_stats / pg_monitor
    // membership, and leaves usename NULL for a background process such as an
    // autovacuum worker (a classic blocker). The recommended posture for this
    // server is a least-privileged role, so declaring these non-null would fail
    // the tool at the exact moment of contention it exists to diagnose.
    outputSchema: rowsOutput(
      z.object({
        blocked_pid: z.number(),
        blocked_user: z.string().nullable(),
        blocked_query: z.string().nullable(),
        blocked_duration_seconds: z.number().nullable().describe("Since query_start."),
        blocking_pid: z.number(),
        blocking_user: z.string().nullable(),
        blocking_query: z.string().nullable(),
        blocking_state: z.string().nullable(),
        blocking_duration_seconds: z.number().nullable(),
        relation: z
          .string()
          .nullable()
          .describe(
            "schema.table. For transactionid / virtualxid waits this is a best-effort GUESS among " +
              "the blocker's held write-intent locks, not authoritative -- disambiguate with the query text.",
          ),
        lock_type: z.string().describe("pg_locks.locktype: relation, transactionid, virtualxid, tuple, ..."),
      }),
    ),
    handler: async (input: unknown) => {
      // Zod default re-applied for direct (non-MCP) callers, which bypass the
      // schema -- matches the precedent in pg_explain / pg_table_bloat.
      const { limit = 50 } = input as { limit?: number };
      // The user / query / state columns are `string | null`: see the note on
      // outputSchema above for why this query, unlike pg_health, can surface a
      // pg_stat_activity row whose restricted columns postgres withheld.
      return runInternal<{
        blocked_pid: number;
        blocked_user: string | null;
        blocked_query: string | null;
        blocked_duration_seconds: number | null;
        blocking_pid: number;
        blocking_user: string | null;
        blocking_query: string | null;
        blocking_state: string | null;
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
             ELSE (
               -- transactionid / virtualxid waits have bl.relation = NULL
               -- because the wait is on the blocker's xid, not on a relation.
               -- The contested table is usually identifiable from the
               -- blocker's held write-intent locks: SELECT FOR UPDATE takes
               -- RowShareLock, UPDATE/INSERT/DELETE take RowExclusiveLock,
               -- migrations take stronger modes. Filter out the AccessShare
               -- locks (plain SELECT) the blocker also holds on every table
               -- they read from -- those aren't the contention source. If
               -- the blocker has touched multiple write-intent tables in
               -- their transaction, this is a best-effort hint, not a
               -- definitive answer; the blocked/blocking queries above let
               -- the caller disambiguate.
               SELECT n.nspname || '.' || c.relname
               FROM pg_catalog.pg_locks blocker_locks
               JOIN pg_catalog.pg_class c ON c.oid = blocker_locks.relation
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE blocker_locks.pid = blocking.pid
                 AND blocker_locks.locktype = 'relation'
                 AND blocker_locks.granted
                 AND blocker_locks.mode IN (
                   'RowShareLock', 'RowExclusiveLock', 'ShareLock',
                   'ShareRowExclusiveLock', 'ShareUpdateExclusiveLock',
                   'ExclusiveLock', 'AccessExclusiveLock'
                 )
                 AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               ORDER BY n.nspname, c.relname
               LIMIT 1
             )
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
    outputSchema: rowsOutput(
      z.object({
        name: z.string(),
        can_login: z.boolean().describe("False for a group role."),
        superuser: z.boolean(),
        createdb: z.boolean(),
        createrole: z.boolean(),
        replication: z.boolean(),
        bypass_rls: z.boolean(),
        // COALESCEd to an empty array in SQL, so never null.
        member_of: z.array(z.string()).describe("Roles this one is a direct member of; empty when none."),
      }),
    ),
    handler: async (input: unknown) => {
      // Zod default re-applied for direct callers -- see pg_inspect_locks above.
      const { includeSystem = false } = input as { includeSystem?: boolean };
      // `starts_with` (pg 11+) is cleaner than LIKE for a literal-underscore
      // prefix match - LIKE requires escaping _ and the escape clause itself
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
      "answer 'who can write to this table?' or to audit schema-wide access before a migration. " +
      "Visibility caveat: backed by `information_schema.table_privileges`, which postgres filters " +
      "by what the calling role can see. A least-privileged role may not see grants involving " +
      "unrelated third-party roles. For a complete picture, run as a superuser or a member of " +
      "`pg_read_all_data`.",
    annotations: {
      title: "Show table privileges",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.default("public").describe("Schema name (defaults to 'public')."),
      table: identSchema.optional().describe("Table name. Omit to list privileges for all tables in the schema."),
    }),
    outputSchema: rowsOutput(
      z.object({
        table: z.string(),
        grantee: z.string().describe("Role name, or PUBLIC."),
        privilege_type: z.string().describe("SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER."),
        is_grantable: z.boolean().describe("True when the grantee may pass this privilege on (WITH GRANT OPTION)."),
      }),
    ),
    handler: async (input: unknown) => {
      // Zod default re-applied for direct callers -- see pg_inspect_locks above.
      const { schema = "public", table } = input as { schema?: string; table?: string };
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
           (is_grantable = 'YES') AS is_grantable
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
      "DATABASE_URL must have permission - cancelling another user's query needs the " +
      "`pg_signal_backend` role or superuser. Note: `pg_signal_backend` does NOT cover " +
      "superuser-owned backends - only a superuser can signal another superuser's session. " +
      "Cancel is graceful; terminate is forceful. When `signaled=false`, the `note` field " +
      "surfaces postgres's NOTICE explaining why (e.g. 'not a PostgreSQL backend process' for " +
      "a non-pg PID, 'must be a member of...' for permission denial) so an agent can act on " +
      "the specific cause rather than guess from a three-way list.",
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
    // `signaled: false` is a SUCCESS response, not an error -- postgres returned
    // false rather than raising -- so this schema has to cover it. `note` is the
    // field that makes it actionable, carrying the NOTICE postgres emitted
    // ("not a PostgreSQL backend process" vs "must be a member of...").
    outputSchema: z.object({
      pid: z.number().describe("Echoed back from the request."),
      mode: z.enum(["cancel", "terminate"]).describe("Echoed back, after the safer 'cancel' default is applied."),
      signaled: z.boolean().describe("What pg_cancel_backend / pg_terminate_backend returned."),
      note: z
        .string()
        .describe("On `signaled: false`, postgres's own NOTICE explaining why -- act on this, not on the boolean."),
    }),
    handler: async (input: unknown) => {
      // Zod default re-applied for direct callers -- see pg_inspect_locks above.
      // Defaulting to the SAFER of the two modes ("cancel") is deliberate: an
      // omitted `mode` must never escalate to terminate.
      const { pid, mode = "cancel" } = input as { pid: number; mode?: "cancel" | "terminate" };
      if (!isWritesAllowed()) {
        return {
          ok: false,
          error:
            "pg_kill requires ALLOW_WRITES=1 because cancelling or terminating a backend changes " +
            "session state. Set ALLOW_WRITES=1 in the MCP server env.",
        };
      }
      const fn = mode === "terminate" ? "pg_terminate_backend" : "pg_cancel_backend";

      // pg_cancel_backend / pg_terminate_backend return false for both
      // "no such PID" and "permission denied", but postgres emits a NOTICE
      // distinguishing them ("PID N is not a PostgreSQL server process" vs
      // "must be a member of the role whose query is being canceled or
      // member of pg_signal_backend"). Capture NOTICEs on the underlying
      // client during the call so we can surface them in the `note` field
      // -- the boolean alone is not actionable for a confused agent.
      const client = await getPool().connect();
      const notices: string[] = [];
      const onNotice = (n: { message?: string }) => {
        if (n.message) notices.push(n.message);
      };
      client.on("notice", onNotice);
      try {
        const result = await client.query<{ signaled: boolean }>(`SELECT ${fn}($1) AS signaled`, [pid]);
        const signaled = result.rows[0]?.signaled === true;
        const noticeText = notices.join(" ").trim();
        return {
          ok: true,
          data: {
            pid,
            mode,
            signaled,
            note: signaled
              ? `Sent ${mode === "terminate" ? "SIGTERM" : "SIGINT"} to backend ${pid}.`
              : noticeText
                ? `${noticeText} (Signal returned false for PID ${pid}.)`
                : `Signal returned false - PID ${pid} may not exist, may already be gone, or the current role lacks permission.`,
          },
        };
      } catch (err) {
        return { ok: false, error: formatPgError(err) };
      } finally {
        client.off("notice", onNotice);
        client.release();
      }
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
    // `slots` and `replicas` stay non-nullable arrays because a failed
    // sub-query degrades to [] plus a `_warnings` entry, but `is_replica` goes
    // NULL rather than false when its probe fails -- `false` would claim "this
    // is a primary" on a question that was never answered.
    outputSchema: z.object({
      is_replica: z.boolean().nullable().describe("pg_is_in_recovery(). Null means the probe failed, NOT 'primary'."),
      wal_position: z
        .string()
        .nullable()
        .describe("Last received LSN on a replica, current LSN on a primary. Null when the probe failed."),
      slots: z
        .array(
          z.object({
            slot_name: z.string(),
            slot_type: z.string().describe("physical | logical."),
            active: z.boolean().describe("False means nothing is consuming the slot -- WAL piles up behind it."),
            restart_lsn: z.string().nullable(),
            confirmed_flush_lsn: z.string().nullable().describe("Logical slots only; null on a physical slot."),
            wal_status: z.string().nullable().describe("reserved | extended | unreserved | lost."),
            database: z.string().nullable().describe("Logical slots only; null on a physical slot."),
            plugin: z.string().nullable().describe("Logical slots only; null on a physical slot."),
          }),
        )
        .describe("Empty both on a standalone database and when the fetch failed -- check `_warnings`."),
      replicas: z.array(
        z.object({
          application_name: z.string(),
          client_addr: z.string().nullable().describe("Null for a replica connected over a unix socket."),
          state: z.string().describe("startup | catchup | streaming | backup | stopping."),
          sync_state: z.string().describe("async | potential | sync | quorum."),
          write_lag_seconds: z.number().nullable().describe("Null until the primary has measured a round trip."),
          flush_lag_seconds: z.number().nullable(),
          replay_lag_seconds: z.number().nullable(),
        }),
      ),
      _warnings: warningsField,
    }),
    handler: async () => {
      // 3-way fanout sharing one connection -- see api.ts:withSharedClient.
      return withSharedClient(async (run) => {
        const [slotsRes, replicasRes, walRes] = await Promise.all([
          run<{
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
          run<{
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
          run<{ is_in_recovery: boolean; wal_position: string | null }>(
            `SELECT
               pg_is_in_recovery() AS is_in_recovery,
               CASE
                 WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()::text
                 ELSE pg_current_wal_lsn()::text
               END AS wal_position`,
          ),
        ]);

        // Partial-failure surfacing matches pg_health / pg_describe_table /
        // pg_advisor: collect failed sub-queries in a top-level _warnings array
        // and return the readable portion of the response. Previously we
        // short-circuited on the first failure, which meant a permission-
        // restricted view (e.g. pg_replication_slots is superuser-only on some
        // managed providers) hid the still-readable parts.
        //
        // is_replica / wal_position go null (not false / null) when walRes
        // fails. `false` would falsely claim "this is a primary" when we
        // couldn't actually check.
        const warnings: string[] = [];
        if (!slotsRes.ok) warnings.push(`slots fetch failed: ${slotsRes.error}`);
        if (!replicasRes.ok) warnings.push(`replicas fetch failed: ${replicasRes.error}`);
        if (!walRes.ok) warnings.push(`wal_position fetch failed: ${walRes.error}`);

        return {
          ok: true,
          data: {
            is_replica: walRes.ok ? (walRes.data?.[0]?.is_in_recovery ?? false) : null,
            wal_position: walRes.ok ? (walRes.data?.[0]?.wal_position ?? null) : null,
            slots: slotsRes.ok ? (slotsRes.data ?? []) : [],
            replicas: replicasRes.ok ? (replicasRes.data ?? []) : [],
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      });
    },
  },

  {
    name: "pg_advisor",
    description:
      "Rolled-up DBA lint pass. One call returns four categories of findings:\n" +
      "- sequence_exhaustion: SERIAL / BIGSERIAL / IDENTITY sequences whose `last_value` is " +
      "above `seqExhaustionThreshold` of `max_value`. The classic incident class.\n" +
      "- wraparound_risk: transaction-ID AND multixact wraparound pressure, the classic pageable " +
      "incident. `{autovacuum_freeze_max_age, autovacuum_multixact_freeze_max_age, databases[], " +
      "tables[]}`. Those two cluster GUCs are the divisors both lists are measured against (null " +
      "if unreadable). Multixact IDs are a SEPARATE 32-bit counter, consumed by row-level locking " +
      "(`SELECT ... FOR SHARE/UPDATE`, FK checks), so a lock-heavy workload can exhaust them while " +
      "relfrozenxid stays perfectly healthy -- both counters are checked here. `databases` rows: " +
      "`{database, xid_age (age(datfrozenxid)), mxid_age (mxid_age(datminmxid)), " +
      "pct_of_freeze_max_age, pct_of_multixact_freeze_max_age, triggered_by}` -- template databases " +
      "included, since template0 ages like any other and the cluster horizon is the minimum " +
      "across all of them. `tables` rows: `{schema, table, relkind, xid_age " +
      "(age(relfrozenxid)), freeze_max_age, pct_of_freeze_max_age, mxid_age (mxid_age(relminmxid)), " +
      "multixact_freeze_max_age, pct_of_multixact_freeze_max_age, triggered_by}`, where " +
      "`freeze_max_age` / `multixact_freeze_max_age` are the EFFECTIVE limits -- a per-table " +
      "`autovacuum_freeze_max_age` / `autovacuum_multixact_freeze_max_age` storage parameter wins " +
      "over the GUC. A row is returned when EITHER ratio is at or above `wraparoundThreshold`, and " +
      "`triggered_by` ('xid' | 'multixact' | 'both') says which one did it: 'xid' means chase " +
      "freezing/autovacuum, 'multixact' means chase the lock-heavy workload burning members. " +
      "`mxid_age` and `pct_of_multixact_freeze_max_age` are null on rows whose minmxid is " +
      "InvalidMultiXactId (no multixact ever recorded); such rows can only be xid-triggered. At " +
      "pct_of_freeze_max_age 1.0 autovacuum forces an anti-wraparound VACUUM, and near 2.1 " +
      "billion xids (or 4.2 billion multixacts) the server stops accepting writes. " +
      "`tables` deliberately includes " +
      "pg_catalog and pg_toast relations -- the culprit is more often a TOAST table or a system " +
      "catalog than a user table. On PG18+ table rows also carry `pages` / `all_frozen_pages` / " +
      "`frozen_page_fraction` from `pg_class.relallfrozen` (visibility-map freeze coverage); " +
      "those three keys are ABSENT on older servers rather than null.\n" +
      "- tables_without_primary_key: user tables (plain and partitioned) with no PK defined. Bloat " +
      "candidates and a sign of design drift; some replication setups also need PKs. " +
      "Foreign tables are excluded -- PostgreSQL forbids declaring PKs on foreign tables.\n" +
      "- public_tables_without_rls: tables in `public` (or any schema in `rlsSchemas`) with " +
      "row-level security disabled. Useful as a security baseline check.\n" +
      "Any category whose query fails (permission-gated catalogs on managed providers) appends to " +
      "`_warnings` and returns empty; the other categories still return.\n" +
      "Use this as the 'what should I be looking at?' starting point, then drill into " +
      "`pg_unused_indexes`, `pg_table_bloat`, `pg_seq_scan_tables` for the perf side.",
    annotations: {
      title: "Database advisor (DBA lints)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      seqExhaustionThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe("Minimum used-fraction (last_value / max_value) to flag a sequence (default 0.5 = 50%)."),
      wraparoundThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Minimum used-fraction to flag a database or table for wraparound risk (default 0.5 = " +
            "50%). Applied to BOTH ratios -- age(frozenxid) / autovacuum_freeze_max_age and " +
            "mxid_age(minmxid) / autovacuum_multixact_freeze_max_age -- and a row is flagged if " +
            "either one clears it. 1.0 is where autovacuum starts forcing anti-wraparound VACUUMs.",
        ),
      rlsSchemas: z
        .array(identSchema)
        .default(["public"])
        .describe("Schemas where RLS-missing should be flagged. Defaults to ['public']."),
      limit: z.number().int().min(1).max(500).default(50).describe("Max rows per category (default 50)."),
    }),
    // Every category stays a required array: a failed sub-query degrades to []
    // plus a `_warnings` entry rather than dropping the key. The two GUC
    // divisors are the exception -- they are `?? null` on purpose, because a
    // caller reading an empty `databases` list has no way to tell "nothing above
    // the threshold" from "the divisor was never readable" without them.
    outputSchema: z.object({
      sequence_exhaustion: z.array(
        z.object({
          schema: z.string(),
          sequence: z.string(),
          last_value: z.string().describe("Bigint as a decimal string."),
          max_value: z.string().describe("Bigint as a decimal string."),
          pct_used: z
            .number()
            .describe(
              "last_value / max_value, rounded for display. The FILTER runs at full precision, so a " +
                "displayed 0.5000 can sit just above the threshold.",
            ),
        }),
      ),
      wraparound_risk: z.object({
        autovacuum_freeze_max_age: z.number().nullable().describe("Cluster GUC; the divisor for the xid ratios."),
        autovacuum_multixact_freeze_max_age: z
          .number()
          .nullable()
          .describe("Cluster GUC; the divisor for the multixact ratios."),
        databases: z.array(wraparoundDatabaseRowOutput),
        tables: z
          .array(wraparoundTableRowOutput)
          .describe("Deliberately includes pg_catalog and pg_toast -- the culprit is usually one of those."),
      }),
      tables_without_primary_key: z
        .array(z.object({ schema: z.string(), table: z.string() }))
        .describe("Plain and partitioned tables only; foreign tables cannot have a PK and are excluded."),
      public_tables_without_rls: z.array(z.object({ schema: z.string(), table: z.string() })),
      _warnings: warningsField,
    }),
    handler: async (input: unknown) => {
      // Zod defaults re-applied for direct callers -- see pg_inspect_locks
      // above. `rlsSchemas` is the load-bearing one: undefined bound into
      // `n.nspname = ANY($1)` errors at bind time rather than defaulting.
      const {
        seqExhaustionThreshold = 0.5,
        wraparoundThreshold = 0.5,
        rlsSchemas = ["public"],
        limit = 50,
      } = input as {
        seqExhaustionThreshold?: number;
        wraparoundThreshold?: number;
        rlsSchemas?: string[];
        limit?: number;
      };

      // `pg_class.relallfrozen` (visibility-map freeze coverage) was added in
      // PG18. Naming it on PG15-17 fails the whole wraparound_risk.tables
      // sub-query with 42703 undefined_column, losing the age() numbers that
      // DO exist there -- so the column list is built from the server version
      // rather than selected unconditionally. getServerVersionNum returns 0
      // when the probe fails, which falls through to the pre-PG18 shape: a
      // slightly poorer answer instead of a broken one.
      //
      // Probed BEFORE withSharedClient, not inside it: the probe runs on its
      // own pooled connection, so holding the shared client across it would
      // put this one tool call at two concurrent connections out of a default
      // pool of five. Sequentially it is one at a time, and the result is
      // process-cached after the first success.
      const versionNum = await getServerVersionNum();
      const frozenCoverageCols =
        versionNum >= PG18
          ? `,
               c.relpages AS pages,
               c.relallfrozen AS all_frozen_pages,
               (c.relallfrozen::numeric / NULLIF(c.relpages, 0))::numeric(6, 4)::float8 AS frozen_page_fraction`
          : "";

      // WraparoundTrigger / WraparoundTableRow / WraparoundDatabaseRow live at
      // module scope beside the Zod schemas that mirror them -- keeping the two
      // adjacent is what stops the row type and the declared outputSchema from
      // drifting apart.

      // 6-way fanout sharing one connection -- see api.ts:withSharedClient.
      return withSharedClient(async (run) => {
        const [seqRes, wrapGucRes, wrapDbRes, wrapTblRes, noPkRes, rlsRes] = await Promise.all([
          run<{
            schema: string;
            sequence: string;
            last_value: string;
            max_value: string;
            pct_used: number;
          }>(
            // pg_sequences was added in PG10. last_value can be NULL on a never-
            // touched sequence; we filter those out (nothing to report yet).
            // Divide in `numeric`, not `float8`: BIGINT sequences past 2^53 lose
            // precision in float8, and the danger zone (>= threshold) is exactly
            // where the reported pct_used must stay accurate.
            // Filter vs display precision differ on purpose: the WHERE clause
            // tests the full-precision ratio while the SELECT rounds pct_used
            // to numeric(6,4) for display. So a displayed 0.5000 may correspond
            // to a true ratio slightly above the threshold -- the filter is
            // correct, the display is rounded.
            `SELECT
               schemaname AS schema,
               sequencename AS sequence,
               last_value::text AS last_value,
               max_value::text AS max_value,
               (last_value::numeric / NULLIF(max_value::numeric, 0))::numeric(6, 4)::float8 AS pct_used
             FROM pg_catalog.pg_sequences
             WHERE last_value IS NOT NULL
               AND max_value > 0
               AND (last_value::numeric / max_value::numeric) >= $1
             ORDER BY pct_used DESC NULLS LAST
             LIMIT $2`,
            [seqExhaustionThreshold, limit],
          ),
          run<{ autovacuum_freeze_max_age: number; autovacuum_multixact_freeze_max_age: number }>(
            // Fetched as its own row rather than repeated on every finding:
            // both wraparound lists are threshold-filtered, so on a healthy
            // cluster they are empty and a per-row copy of the GUC would leave
            // the category with no scale at all. The caller needs the divisor
            // to interpret an empty result as "nothing above the threshold"
            // rather than "could not measure".
            //
            // Both GUCs come back in ONE row, not two sub-queries: they are
            // the two divisors for the same category, and splitting them would
            // add a seventh round trip to the fanout for a second scalar that
            // fails or succeeds under exactly the same conditions as the first.
            // autovacuum_multixact_freeze_max_age exists as far back as PG9.3,
            // so unlike relallfrozen below it needs no version gate.
            `SELECT
               current_setting('autovacuum_freeze_max_age')::int AS autovacuum_freeze_max_age,
               current_setting('autovacuum_multixact_freeze_max_age')::int AS autovacuum_multixact_freeze_max_age`,
          ),
          run<WraparoundDatabaseRow>(
            // Template databases are deliberately NOT excluded. template0 has
            // datallowconn = false and so is never autovacuumed through the
            // normal path, but its datfrozenxid ages exactly like any other
            // database and the cluster-wide wraparound horizon is the MINIMUM
            // across all of pg_database. Filtering templates out is how a
            // wraparound incident hides from the check that was meant to catch
            // it.
            //
            // numeric(10, 4), not the numeric(6, 4) used for sequence
            // exhaustion: that ratio is bounded by 1 (a sequence cannot pass
            // its max_value), this one is not. age() tops out near 2.1e9 and
            // autovacuum_freeze_max_age can legally be set as low as 1e5, so a
            // ratio of ~21000 is reachable and would overflow a 6-digit
            // numeric -- turning a wraparound alarm into a numeric field
            // overflow error at the exact moment it matters. The multixact
            // ratio fits the same width: mxid_age tops out near 4.3e9 and the
            // GUC's floor is 10000, so ~430000 is the worst case.
            //
            // datminmxid is tracked SEPARATELY from datfrozenxid, and a
            // database can hit autovacuum_multixact_freeze_max_age with a
            // perfectly healthy relfrozenxid -- multixacts are burned by
            // row-level locking (SELECT ... FOR SHARE/UPDATE, FK checks), not
            // by transaction volume. Checking only the xid side reports a
            // lock-heavy cluster as clean right up to the multixact shutdown.
            //
            // The InvalidMultiXactId guard is `<> '0'::xid` because
            // pg_database.datminmxid is catalog-typed `xid` even though it
            // holds a MultiXactId -- there is no `mxid` type to cast to, and
            // mxid_age('0'::xid) would report a ~4.2-billion age for a
            // database that has simply never recorded a multixact. It yields
            // NULL rather than dropping the row: a NULL ratio can never
            // satisfy `>= $1`, so the row is still returned (and correctly
            // labelled 'xid') when its xid age is what is dangerous.
            //
            // ORDER BY is the GREATER of the two ratios, not age(datfrozenxid):
            // with the filter now an OR, ordering by the xid age alone would
            // sort a multixact-critical database near the bottom and let LIMIT
            // cut the only row that mattered. triggered_by is computed from
            // the same full-precision ratios the WHERE uses (not the rounded
            // pct_* columns), so the label can never disagree with the reason
            // the row came back.
            `SELECT
               d.datname AS database,
               age(d.datfrozenxid) AS xid_age,
               mx.mxid_age AS mxid_age,
               r.xid_ratio::numeric(10, 4)::float8 AS pct_of_freeze_max_age,
               r.mxid_ratio::numeric(10, 4)::float8 AS pct_of_multixact_freeze_max_age,
               CASE
                 WHEN r.xid_ratio >= $1 AND r.mxid_ratio >= $1 THEN 'both'
                 WHEN r.mxid_ratio >= $1 THEN 'multixact'
                 ELSE 'xid'
               END AS triggered_by
             FROM pg_catalog.pg_database d
             CROSS JOIN LATERAL (
               SELECT CASE WHEN d.datminmxid <> '0'::xid THEN mxid_age(d.datminmxid) END AS mxid_age
             ) mx
             CROSS JOIN LATERAL (
               SELECT
                 (age(d.datfrozenxid)::numeric
                    / NULLIF(current_setting('autovacuum_freeze_max_age')::numeric, 0)) AS xid_ratio,
                 (mx.mxid_age::numeric
                    / NULLIF(current_setting('autovacuum_multixact_freeze_max_age')::numeric, 0)) AS mxid_ratio
             ) r
             WHERE r.xid_ratio >= $1 OR r.mxid_ratio >= $1
             ORDER BY GREATEST(r.xid_ratio, r.mxid_ratio) DESC
             LIMIT $2`,
            [wraparoundThreshold, limit],
          ),
          run<WraparoundTableRow>(
            // Deliberately unfiltered by schema, unlike every other category
            // in this tool: an anti-wraparound emergency is usually driven by
            // a TOAST table (pg_toast.*) or a system catalog, and a check that
            // only looked at user tables would report "nothing wrong" while
            // the cluster approached a forced shutdown.
            //
            // relkind is restricted to relations that actually carry a
            // frozen-xid horizon: heap ('r'), materialized view ('m'), TOAST
            // ('t'). Everything else -- views, indexes, partitioned parents
            // ('p'), sequences -- stores InvalidTransactionId (0) in
            // relfrozenxid, and age('0'::xid) is a meaningless ~2.1-billion
            // number that would flood this list with false positives. The
            // explicit `relfrozenxid <> '0'::xid` guard catches the same case
            // for any relkind that stops carrying a horizon in a future major.
            //
            // freeze_max_age resolves the per-table storage parameter
            // (`ALTER TABLE ... SET (autovacuum_freeze_max_age = ...)`) and
            // falls back to the cluster GUC. Without this, a table with a
            // deliberately raised override reads as critical against the
            // cluster default, and -- worse -- a table with a LOWERED override
            // reads as safe when autovacuum is already forcing freezes on it.
            // pg_options_to_table is strict, so a NULL reloptions yields zero
            // rows and the scalar subquery returns NULL for COALESCE to
            // absorb. multixact_freeze_max_age resolves the same way from the
            // separate `autovacuum_multixact_freeze_max_age` storage parameter
            // -- a table with a lowered multixact override is already being
            // force-vacuumed while it still reads as safe against the cluster
            // default.
            //
            // relminmxid is the multixact twin of relfrozenxid and moves
            // independently of it: row-level locks (SELECT ... FOR
            // SHARE/UPDATE, FK checks) burn multixact IDs without consuming
            // xids, so a lock-heavy table can be at 90% of
            // autovacuum_multixact_freeze_max_age with an age(relfrozenxid) of
            // nearly zero. Filtering on the xid ratio alone reports that table
            // as clean.
            //
            // The InvalidMultiXactId guard mirrors the relfrozenxid one as
            // `<> '0'::xid` -- relminmxid is catalog-typed `xid` even though
            // it holds a MultiXactId, so there is no separate type to cast to,
            // and mxid_age('0'::xid) would return a meaningless ~4.2-billion
            // age for any relation that has never recorded a multixact. It is
            // expressed as a CASE yielding NULL, NOT as another AND in the
            // WHERE: dropping those rows outright would also drop rows whose
            // relfrozenxid IS dangerous. A NULL ratio cannot satisfy `>= $1`,
            // so such a row can only ever be xid-triggered.
            //
            // ORDER BY is the GREATER of the two ratios rather than
            // age(relfrozenxid): now that the filter is an OR, ordering on the
            // xid age would push a multixact-critical TOAST table below the
            // LIMIT cut and hide the exact row the operator was paged for.
            // triggered_by is computed from the same full-precision ratios as
            // the WHERE (not the rounded pct_* columns), so it can never
            // disagree with why the row was returned.
            `SELECT
               n.nspname AS schema,
               c.relname AS "table",
               c.relkind AS relkind,
               age(c.relfrozenxid) AS xid_age,
               fma.freeze_max_age AS freeze_max_age,
               r.xid_ratio::numeric(10, 4)::float8 AS pct_of_freeze_max_age,
               fma.mxid_age AS mxid_age,
               fma.multixact_freeze_max_age AS multixact_freeze_max_age,
               r.mxid_ratio::numeric(10, 4)::float8 AS pct_of_multixact_freeze_max_age,
               CASE
                 WHEN r.xid_ratio >= $1 AND r.mxid_ratio >= $1 THEN 'both'
                 WHEN r.mxid_ratio >= $1 THEN 'multixact'
                 ELSE 'xid'
               END AS triggered_by${frozenCoverageCols}
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL (
               SELECT
                 COALESCE(
                   (SELECT o.option_value::int
                    FROM pg_catalog.pg_options_to_table(c.reloptions) o
                    WHERE o.option_name = 'autovacuum_freeze_max_age'),
                   current_setting('autovacuum_freeze_max_age')::int
                 ) AS freeze_max_age,
                 COALESCE(
                   (SELECT o.option_value::int
                    FROM pg_catalog.pg_options_to_table(c.reloptions) o
                    WHERE o.option_name = 'autovacuum_multixact_freeze_max_age'),
                   current_setting('autovacuum_multixact_freeze_max_age')::int
                 ) AS multixact_freeze_max_age,
                 CASE WHEN c.relminmxid <> '0'::xid THEN mxid_age(c.relminmxid) END AS mxid_age
             ) fma
             CROSS JOIN LATERAL (
               SELECT
                 (age(c.relfrozenxid)::numeric / NULLIF(fma.freeze_max_age, 0)::numeric) AS xid_ratio,
                 (fma.mxid_age::numeric / NULLIF(fma.multixact_freeze_max_age, 0)::numeric) AS mxid_ratio
             ) r
             WHERE c.relkind IN ('r', 'm', 't')
               AND c.relfrozenxid <> '0'::xid
               AND (r.xid_ratio >= $1 OR r.mxid_ratio >= $1)
             ORDER BY GREATEST(r.xid_ratio, r.mxid_ratio) DESC
             LIMIT $2`,
            [wraparoundThreshold, limit],
          ),
          run<{ schema: string; table: string }>(
            // Includes partitioned parents (relkind='p') alongside plain heap
            // tables ('r'). A partitioned table with no PK is a real design-
            // drift signal -- if a PK exists on a partitioned table it must
            // include the partition key columns, but having no PK at all is
            // legal and usually unintended. Matches the relkind filter used
            // by public_tables_without_rls below.
            //
            // Partition children (relkind='r') inherit the parent's PK as an
            // indisprimary index on the child, so the NOT EXISTS clause keeps
            // already filtering them out.
            //
            // Foreign tables (relkind='f') are excluded: PostgreSQL forbids
            // PRIMARY KEY (and UNIQUE) constraints on foreign tables entirely,
            // so they would always appear here with no possible remediation.
            `SELECT
               n.nspname AS schema,
               c.relname AS "table"
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname NOT LIKE 'pg_%'
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_index i
                 WHERE i.indrelid = c.oid AND i.indisprimary
               )
             ORDER BY n.nspname, c.relname
             LIMIT $1`,
            [limit],
          ),
          run<{ schema: string; table: string }>(
            `SELECT
               n.nspname AS schema,
               c.relname AS "table"
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname = ANY($1)
               AND NOT c.relrowsecurity
             ORDER BY n.nspname, c.relname
             LIMIT $2`,
            [rlsSchemas, limit],
          ),
        ]);

        // One independent `if` per sub-query, never an early return: the
        // wraparound catalogs (pg_database.datfrozenxid, pg_class.relfrozenxid)
        // are permission-gated on several managed providers, so a partial
        // answer is the expected path here rather than an edge case. Losing
        // wraparound_risk must not also cost the caller the sequence and RLS
        // findings that came back fine.
        const warnings: string[] = [];
        if (!seqRes.ok) warnings.push(`sequence_exhaustion fetch failed: ${seqRes.error}`);
        if (!wrapGucRes.ok) {
          warnings.push(`wraparound_risk.autovacuum_freeze_max_age fetch failed: ${wrapGucRes.error}`);
        }
        if (!wrapDbRes.ok) warnings.push(`wraparound_risk.databases fetch failed: ${wrapDbRes.error}`);
        if (!wrapTblRes.ok) warnings.push(`wraparound_risk.tables fetch failed: ${wrapTblRes.error}`);
        if (!noPkRes.ok) warnings.push(`tables_without_primary_key fetch failed: ${noPkRes.error}`);
        if (!rlsRes.ok) warnings.push(`public_tables_without_rls fetch failed: ${rlsRes.error}`);

        return {
          ok: true,
          data: {
            sequence_exhaustion: seqRes.ok ? seqRes.data : [],
            wraparound_risk: {
              // `?? null` rather than leaving it undefined: an absent key
              // serializes away entirely, so a caller reading an empty
              // `databases` list would have no way to tell "nothing above the
              // threshold" from "the divisor was never readable".
              autovacuum_freeze_max_age: wrapGucRes.ok
                ? (wrapGucRes.data?.[0]?.autovacuum_freeze_max_age ?? null)
                : null,
              // Same `?? null` reasoning, and it is exposed even though the
              // two GUCs share a sub-query: a caller that only saw the xid
              // divisor would have no scale for pct_of_multixact_freeze_max_age
              // and no way to judge an empty `databases` list on the multixact
              // axis.
              autovacuum_multixact_freeze_max_age: wrapGucRes.ok
                ? (wrapGucRes.data?.[0]?.autovacuum_multixact_freeze_max_age ?? null)
                : null,
              databases: wrapDbRes.ok ? wrapDbRes.data : [],
              tables: wrapTblRes.ok ? wrapTblRes.data : [],
            },
            tables_without_primary_key: noPkRes.ok ? noPkRes.data : [],
            public_tables_without_rls: rlsRes.ok ? rlsRes.data : [],
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      });
    },
  },

  {
    name: "pg_table_bloat",
    description:
      "Estimate table bloat (dead tuples + free space) for tables in a schema. Returns live " +
      "tuples, dead tuples, dead-tuple ratio, last_vacuum / last_autovacuum timestamps, and " +
      "total relation size. A high dead_ratio with a stale last_autovacuum is a sign a table " +
      "needs VACUUM.\n" +
      "On PostgreSQL 19+ every row also carries `stats_reset`: the last time THAT relation's " +
      "counters were reset via `pg_stat_reset_single_table_counters()`. Read it before trusting " +
      "anything else in the row -- a reset zeroes live_tuples and dead_tuples AND clears " +
      "last_vacuum / last_autovacuum / last_analyze together, so a table reset a minute ago is " +
      "indistinguishable from a pristine one without it. The key is ABSENT on older servers " +
      "rather than null; null on PG19+ means this relation's counters have never been reset.\n\n" +
      "Three methods are available via the `method` parameter:\n" +
      "- `estimate` (default): reads pg_stat_user_tables -- fast, no extensions, ANALYZE-driven " +
      "approximations. Use this first.\n" +
      "- `approx`: uses pgstattuple_approx() -- fast sampling pass, more accurate than estimates, " +
      "requires the pgstattuple extension.\n" +
      "- `exact`: uses pgstattuple() -- full table scan, exact counts, slow on large tables, " +
      "requires the pgstattuple extension. Always pass `schema` with method='exact' -- scanning " +
      "all user tables in one statement will hit statement_timeout on non-trivial databases.\n" +
      "Install pgstattuple with `CREATE EXTENSION pgstattuple` (requires superuser).",
    annotations: {
      title: "Estimate table bloat",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.optional().describe("Limit to one schema. If omitted, all user schemas are included."),
      minDeadRatio: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe("Minimum dead-tuple fraction to include - dead / (live + dead). Default 0.1 = 10%."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return (default 50)."),
      method: z
        .enum(["estimate", "approx", "exact"])
        .default("estimate")
        .describe(
          "Bloat measurement method. 'estimate' (default) uses pg_stat_user_tables (fast, no extensions). " +
            "'approx' uses pgstattuple_approx() (fast sampling, more accurate). " +
            "'exact' uses pgstattuple() (full scan, exact but slow). " +
            "Both 'approx' and 'exact' require the pgstattuple extension.",
        ),
    }),
    // One schema for all three methods on purpose: the estimate / approx / exact
    // queries are built to return the SAME row shape on the same server, so a
    // caller comparing two runs never watches a key appear and disappear.
    outputSchema: rowsOutput(bloatRowOutput),
    handler: async (input: unknown) => {
      // Direct (non-MCP) callers bypass Zod, so its defaults never run for
      // them. Re-applied in the destructure -- matches the precedent in
      // pg_explain.
      const {
        schema,
        minDeadRatio = 0.1,
        limit = 50,
        method = "estimate",
      } = input as {
        schema?: string;
        minDeadRatio?: number;
        limit?: number;
        method?: "estimate" | "approx" | "exact";
      };
      const schemaFilter = schema
        ? "AND schemaname = $3"
        : "AND schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_%'";
      const params: unknown[] = [minDeadRatio, limit];
      if (schema) params.push(schema);

      // `stats_reset` on pg_stat_user_tables was added in PG19. Naming it on an
      // older server is a 42703 undefined_column that fails the whole tool
      // instead of degrading it, so the column list is built from the server
      // version. getServerVersionNum returns 0 when the probe itself fails,
      // which falls through to the pre-PG19 shape -- a slightly poorer answer
      // instead of a broken one -- and api.ts caches the result process-wide.
      //
      // Worth a round trip because every freshness signal this tool reports is
      // per-relation state that `pg_stat_reset_single_table_counters()` zeroes
      // in one go: n_live_tup, n_dead_tup AND last_vacuum / last_autovacuum /
      // last_analyze all drop to 0 / NULL together. Without the reset
      // timestamp a table whose counters were just discarded is
      // indistinguishable from a pristine one: it reads as "no dead tuples,
      // and autovacuum has never had to touch this", which is the most
      // reassuring possible rendering of "the evidence was thrown away".
      // pg_stat_database.stats_reset cannot stand in for it -- that clock only
      // moves on a database-wide reset.
      const versionNum = await getServerVersionNum();
      // Two spellings of one fragment because the two query shapes below scan
      // the same view under different aliases. Both methods must return the
      // same row shape on the same server, or a caller comparing an `estimate`
      // run against an `exact` one watches the key appear and disappear.
      const statsResetCol =
        versionNum >= PG19
          ? `,
           stats_reset::text AS stats_reset`
          : "";
      const statsResetColAliased =
        versionNum >= PG19
          ? `,
             s.stats_reset::text AS stats_reset`
          : "";

      // BloatRow lives at module scope beside the Zod schema that mirrors it --
      // see the note on the wraparound row types above.

      if (method !== "estimate") {
        // Check extension presence before opening a second connection.
        const check = await runInternal<{ installed: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgstattuple'
           ) AS installed`,
        );
        if (!check.ok) return check;
        if (!check.data?.[0]?.installed) {
          return {
            ok: false,
            error:
              `pgstattuple extension is not installed. Install with ` +
              "`CREATE EXTENSION pgstattuple;` (requires superuser), then retry " +
              `with method='${method}'.`,
          };
        }

        // pgstattuple_approx uses approx_tuple_count; pgstattuple uses tuple_count.
        const fn = method === "approx" ? "pgstattuple_approx" : "pgstattuple";
        const liveTuplesCol = method === "approx" ? "approx_tuple_count" : "tuple_count";
        // Join pg_class to filter to heap relations only (relkind='r' or 'm').
        // pg_stat_user_tables includes partitioned parents (relkind='p'), and
        // both pgstattuple() and pgstattuple_approx() raise an error on them.
        // Materialized views ('m') are valid heap targets and included.
        return runInternal<BloatRow>(
          `SELECT
             s.schemaname AS schema,
             s.relname AS "table",
             (p.${liveTuplesCol})::text AS live_tuples,
             p.dead_tuple_count::text AS dead_tuples,
             (p.dead_tuple_count::float8 / NULLIF(p.${liveTuplesCol} + p.dead_tuple_count, 0))::numeric(6, 3)::float8 AS dead_ratio,
             pg_size_pretty(pg_total_relation_size(s.relid)) AS size_pretty,
             pg_total_relation_size(s.relid)::text AS size_bytes,
             s.last_vacuum::text AS last_vacuum,
             s.last_autovacuum::text AS last_autovacuum,
             s.last_analyze::text AS last_analyze${statsResetColAliased}
           FROM pg_catalog.pg_stat_user_tables s
           JOIN pg_catalog.pg_class c ON c.oid = s.relid AND c.relkind IN ('r', 'm')
           CROSS JOIN LATERAL ${fn}(s.relid::regclass) p
           WHERE (p.${liveTuplesCol} + p.dead_tuple_count) > 0
             AND (p.dead_tuple_count::float8 / NULLIF(p.${liveTuplesCol} + p.dead_tuple_count, 0)) >= $1
             ${schemaFilter}
           ORDER BY p.dead_tuple_count DESC
           LIMIT $2`,
          params,
        );
      }

      return runInternal<BloatRow>(
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
           last_analyze::text AS last_analyze${statsResetCol}
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
