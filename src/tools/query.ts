import { z } from "zod";
import { isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";
import { paramsArray } from "./params.js";

/**
 * Mirrors api.ts:QueryResult, the shape `toQueryResult` builds for every
 * user-SQL path (runReadOnly / runReadWrite / runReadWriteRollback). Both tools
 * in this file return it unchanged, so they share one schema -- two copies
 * would drift apart the first time a field is added to one of them.
 *
 * `command` and `truncated` are optional because `toQueryResult` SPREADS them
 * in conditionally: `command` is omitted on the cursor path (there the tag
 * describes the FETCH, not the user's statement) and `truncated` appears only
 * when the row cap actually bit. Neither is ever null, so modelling them as
 * nullable would advertise a value the code cannot produce.
 */
const queryResultOutput = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .describe("Result rows, capped at POSTGRES_MAX_ROWS. Values are whatever JSON type pg parsed the column into."),
  rowCount: z
    .number()
    .nullable()
    .describe(
      "Rows AFFECTED for DML -- not necessarily rows.length -- and rows returned on the cursor " +
        "path. Null when pg reported no count.",
    ),
  fields: z
    .array(
      z.object({
        name: z.string(),
        dataTypeID: z.number(),
        // Absent, not null, when the oid did not resolve to a typname:
        // safeResolveTypeNames drops unresolved oids instead of mapping them to
        // a placeholder, and toQueryResult then omits the key entirely.
        dataTypeName: z.string().optional(),
      }),
    )
    .describe("Result column descriptors, in select-list order."),
  command: z
    .string()
    .optional()
    .describe(
      "Postgres command tag (`INSERT`, `CREATE TABLE`, ...). Absent on the cursor path -- read " +
        "absence as 'row-returning statement, command unknown'.",
    ),
  truncated: z
    .boolean()
    .optional()
    .describe("Present and true only when the result hit POSTGRES_MAX_ROWS and rows were dropped."),
});

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
    outputSchema: queryResultOutput,
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
    outputSchema: queryResultOutput,
    handler: async (input: unknown) => {
      const { sql, params } = input as { sql: string; params?: unknown[] };
      if (isWritesAllowed()) {
        return runReadWrite(sql, params ?? []);
      }
      return runReadOnly(sql, params ?? []);
    },
  },
] as const;
