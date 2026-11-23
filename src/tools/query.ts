import { z } from "zod";
import { isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";
import { warningsField } from "./output.js";
import { paramsArray } from "./params.js";

/**
 * Mirrors api.ts:QueryResult, the shape `toQueryResult` builds for every
 * user-SQL path (runReadOnly / runReadWrite / runReadWriteRollback). Both tools
 * in this file return it unchanged, so they share one schema -- two copies
 * would drift apart the first time a field is added to one of them.
 *
 * `command`, `truncated` and `_warnings` are optional because `toQueryResult`
 * SPREADS them in conditionally: `command` is omitted on the cursor path (there
 * the tag describes the FETCH, not the user's statement), `truncated` appears
 * only when the row cap actually bit, and `_warnings` only when columns share a
 * name. None is ever null, so modelling them as nullable would advertise a
 * value the code cannot produce.
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
  // Not the multi-query partial-failure channel warningsField documents, but
  // the same key and shape: present only when there is something to say.
  _warnings: warningsField.describe(
    "Present only when result columns share a name: each row then holds only the last column of " +
      "that name. Alias the columns and re-run.",
  ),
});

export const queryTools = [
  {
    name: "pg_readonly",
    description:
      "Run one SQL statement inside a `BEGIN READ ONLY` transaction that is always rolled back, " +
      "regardless of `ALLOW_WRITES`. Postgres rejects INSERT/UPDATE/DELETE/DDL there. Use this " +
      "to read: SELECT, WITH ... SELECT, VALUES, TABLE, SHOW, EXPLAIN. Statements that escape or " +
      "reshape the transaction are refused (SET, RESET, DO, CALL, PREPARE, EXECUTE, COPY, LOCK, " +
      "transaction control and similar), as are calls to known out-of-transaction functions " +
      "(`dblink*`, `set_config`, `pg_read_file`, `lo_export`, `pg_terminate_backend`, ...). " +
      "These checks are best-effort and are NOT a security boundary: a function wrapper gets " +
      "past them, and a function can write through its own connection. The `DATABASE_URL` role " +
      "is the boundary, so do not auto-allow this tool unless that role is least-privilege. " +
      "Use `params` for parameterized queries to avoid SQL injection. " +
      "Params can be strings, numbers, booleans, null, arrays (for postgres arrays / ANY), or " +
      "objects (for json/jsonb columns). Large result sets are truncated to POSTGRES_MAX_ROWS " +
      "(default 1000) with a `truncated: true` flag; a result over POSTGRES_MAX_RESULT_BYTES " +
      "fails instead, and a call past POSTGRES_QUERY_DEADLINE_MS has its backend terminated.",
    // readOnlyHint states what this tool is FOR and what it enforces at the
    // transaction level. It is not a guarantee: with a privileged role a call
    // can still have effects outside the transaction (dblink, a SECURITY DEFINER
    // function). A host that auto-allows on this hint is safe only when the
    // DATABASE_URL role is least-privilege, which the description and README
    // say, and which the startup role check warns about. It stays true because
    // flipping it would misdescribe the tool under the role it is meant for.
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
      "managed databases where creating a second role is awkward. Without `ALLOW_WRITES` this " +
      "applies the same statement checks as `pg_readonly`, which stays read-only whatever the " +
      "flag says. Use `params` for " +
      "parameterized queries to avoid SQL injection. Params can be strings, numbers, booleans, " +
      "null, arrays (for postgres arrays / ANY), or objects (for json/jsonb columns). Dates and " +
      "UUIDs can be passed as ISO strings. Large result sets are truncated to " +
      "POSTGRES_MAX_ROWS (default 1000) with a `truncated: true` flag; a result over " +
      "POSTGRES_MAX_RESULT_BYTES fails instead. Session state does not carry over between calls. " +
      "Every statement runs inside a transaction block, with or without `ALLOW_WRITES`, so " +
      "statements that refuse one (VACUUM, CREATE INDEX CONCURRENTLY, CREATE DATABASE, " +
      "ALTER SYSTEM) cannot be run through this tool; use psql or a migration tool for those.",
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
