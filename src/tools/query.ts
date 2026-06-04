import { z } from "zod";
import { isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";
import { paramsArray } from "./params.js";

export const queryTools = [
  {
    name: "pg_readonly",
    description:
      "Run a SQL statement guaranteed read-only. Always executes inside a `BEGIN READ ONLY` " +
      "transaction regardless of `ALLOW_WRITES`, so postgres itself rejects any write attempt. " +
      "Use this whenever the goal is to read - SELECT, EXPLAIN, SHOW, VALUES, WITH ... SELECT, " +
      "etc. Hosts that gate tools individually (Claude Code permissions, mcp.hosting) can safely " +
      "auto-allow this one. Use `params` for parameterized queries to avoid SQL injection. " +
      "Params can be strings, numbers, booleans, null, arrays (for postgres arrays / ANY), or " +
      "objects (for json/jsonb columns). Large result sets are truncated to POSTGRES_MAX_ROWS " +
      "(default 1000) with a `truncated: true` flag.",
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
