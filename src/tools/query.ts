import { z } from "zod";
import { isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";

export const queryTools = [
  {
    name: "pg_query",
    description:
      "Run a SQL query against the configured PostgreSQL database. Read-only by default " +
      "(query runs in a READ ONLY transaction). Set ALLOW_WRITES=1 in the MCP server env " +
      "to enable DML/DDL. Use `params` for parameterized queries to avoid SQL injection. " +
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
      sql: z.string().min(1).describe("The SQL statement to execute."),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Positional parameters referenced as $1, $2, ... in the SQL."),
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
