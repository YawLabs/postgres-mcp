import { z } from "zod";
import { isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";

// Any JSON value that can legally be bound as a postgres parameter. Covers
// scalars, arrays (for postgres array columns / ANY), and objects (for
// json/jsonb columns — pg serializes these automatically).
const paramValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(paramValue), z.record(z.string(), paramValue)]),
);

export const queryTools = [
  {
    name: "pg_query",
    description:
      "Run a SQL query against the configured PostgreSQL database. Read-only by default " +
      "(query runs in a READ ONLY transaction). Set ALLOW_WRITES=1 in the MCP server env " +
      "to enable DML/DDL. Use `params` for parameterized queries to avoid SQL injection. " +
      "Params can be strings, numbers, booleans, null, arrays (for postgres arrays / ANY), " +
      "or objects (for json/jsonb columns). Dates and UUIDs can be passed as ISO strings. " +
      "Large result sets are truncated to POSTGRES_MAX_ROWS (default 1000) with a " +
      "`truncated: true` flag.",
    annotations: {
      title: "Run SQL query",
      readOnlyHint: false, // conditionally destructive based on ALLOW_WRITES
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sql: z.string().min(1).max(1_000_000).describe("The SQL statement to execute. Hard cap of 1 MB."),
      params: z.array(paramValue).optional().describe("Positional parameters referenced as $1, $2, ... in the SQL."),
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
