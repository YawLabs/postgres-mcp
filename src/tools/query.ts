import { z } from "zod";
import { isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";
import { paramsArray } from "./params.js";

export const queryTools = [
  {
    name: "pg_readonly",
    description:
      "Run a SQL statement with no persistent data changes. Always executes inside a " +
      "`BEGIN READ ONLY` transaction regardless of `ALLOW_WRITES`, so postgres itself rejects " +
      "any INSERT/UPDATE/DELETE/DDL and the transaction is always rolled back. " +
      "Use this whenever the goal is to read - SELECT, EXPLAIN, SHOW, VALUES, WITH ... SELECT, " +
      "etc. Scope caveat for hosts that auto-allow this tool: `READ ONLY` constrains writes to " +
      "the DATABASE, not every side effect. Functions whose effect is outside the table data - " +
      "`pg_cancel_backend` / `pg_terminate_backend`, `pg_read_file`, `lo_export`, " +
      "`COPY ... TO PROGRAM` - are NOT blocked here and are NOT behind the `ALLOW_WRITES` gate " +
      "that `pg_kill` sits behind. They still require the privileges the `DATABASE_URL` role " +
      "holds, so a least-privileged role (e.g. `pg_read_all_data`) is what actually bounds " +
      "this tool. Use `params` for parameterized queries to avoid SQL injection. " +
      "Params can be strings, numbers, booleans, null, arrays (for postgres arrays / ANY), or " +
      "objects (for json/jsonb columns). Large result sets are truncated to POSTGRES_MAX_ROWS " +
      "(default 1000) with a `truncated: true` flag.",
    // DELIBERATE, do not "fix" to match the caveat in the description above.
    // `BEGIN READ ONLY` does not block side-effecting functions
    // (pg_terminate_backend, pg_read_file, COPY ... TO PROGRAM), so these
    // hints are arguably too generous, and a review pass will keep noticing
    // that. The decision is to keep them: staying in the host auto-allow class
    // is the entire reason pg_readonly exists as a separate tool from
    // pg_query, and the DATABASE_URL role -- not the transaction mode -- is
    // the control that actually bounds this tool. The description and the
    // README carry the caveat; a least-privileged role is the enforcement.
    // Flipping these to destructive would move pg_readonly to "always prompt"
    // in every existing host config for a bound the role already provides.
    annotations: {
      title: "Run read-only SQL",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sql: z.string().min(1).max(1_000_000).describe("The SQL statement to execute. Hard cap of 1 MB."),
      params: paramsArray.optional().describe("Positional parameters referenced as $1, $2, ... in the SQL."),
    }),
    handler: async (input: unknown) => {
      const { sql, params } = input as { sql: string; params?: unknown[] };
      return runReadOnly(sql, params ?? []);
    },
  },
  {
    name: "pg_query",
    description:
      "Run a SQL query against the configured PostgreSQL database. Postgres itself is the " +
      "primary safety gate: the role in `DATABASE_URL` enforces what queries can succeed. " +
      "The recommended posture is a least-privileged role (e.g. one granted " +
      "`pg_read_all_data`), which makes writes server-rejected regardless of any env var. " +
      "`ALLOW_WRITES=1` is a secondary belt-and-braces gate - it lifts the in-server " +
      "`BEGIN READ ONLY` wrapper, but it cannot grant privileges the role lacks. Useful for " +
      "managed databases where creating a second role is awkward. For read-only access where " +
      "you want the guarantee in the tool name, prefer `pg_readonly`. Use `params` for " +
      "parameterized queries to avoid SQL injection. Params can be strings, numbers, booleans, " +
      "null, arrays (for postgres arrays / ANY), or objects (for json/jsonb columns). Dates and " +
      "UUIDs can be passed as ISO strings. Large result sets are truncated to " +
      "POSTGRES_MAX_ROWS (default 1000) with a `truncated: true` flag.",
    annotations: {
      title: "Run SQL query",
      readOnlyHint: false, // conditionally destructive based on role + ALLOW_WRITES
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sql: z.string().min(1).max(1_000_000).describe("The SQL statement to execute. Hard cap of 1 MB."),
      params: paramsArray.optional().describe("Positional parameters referenced as $1, $2, ... in the SQL."),
    }),
    handler: async (input: unknown) => {
      const { sql, params } = input as { sql: string; params?: unknown[] };
      if (isWritesAllowed()) {
        return runReadWrite(sql, params ?? []);
      }
      return runReadOnly(sql, params ?? []);
    },
  },
] as const;
