import { z } from "zod";
import { type ApiResponse, isWritesAllowed, runReadOnly, runReadWriteRollback } from "../api.js";
import { paramValue } from "./params.js";

export const explainTools = [
  {
    name: "pg_explain",
    description:
      "Get the query plan for a SQL statement. By default, this uses plain EXPLAIN (no execution). " +
      "Set `analyze: true` to run the query with EXPLAIN ANALYZE — for non-SELECT statements, " +
      "ALLOW_WRITES=1 is required (since ANALYZE actually executes the statement). Writes " +
      "executed during EXPLAIN ANALYZE are always rolled back, so you can inspect a plan for " +
      "an INSERT/UPDATE/DELETE without persisting the mutation. Format is `text` (default) or " +
      "`json`. Pass the raw SQL (not an EXPLAIN-prefixed statement).",
    annotations: {
      title: "Explain query plan",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sql: z.string().min(1).max(1_000_000).describe("The SQL statement to explain. Do NOT prefix with EXPLAIN."),
      analyze: z.boolean().default(false).describe("Run EXPLAIN ANALYZE (actually executes the query)."),
      format: z.enum(["text", "json"]).default("text").describe("Output format."),
      params: z.array(paramValue).optional().describe("Positional parameters referenced as $1, $2, ... in the SQL."),
    }),
    handler: async (input: unknown) => {
      const { sql, analyze, format, params } = input as {
        sql: string;
        analyze: boolean;
        format: "text" | "json";
        params?: unknown[];
      };

      // LLMs often pass pre-wrapped SQL like "EXPLAIN ANALYZE SELECT ..." which
      // would become "EXPLAIN (ANALYZE) EXPLAIN ANALYZE SELECT ..." below —
      // a syntax error. Reject with a clear hint so the next call is correct.
      if (/^\s*EXPLAIN\b/i.test(sql)) {
        return {
          ok: false,
          error:
            "The `sql` parameter should be the query to explain, not an EXPLAIN statement. " +
            "Use the `analyze` and `format` parameters on this tool instead of prefixing the SQL.",
        };
      }

      const flags: string[] = [];
      if (analyze) flags.push("ANALYZE");
      if (format === "json") flags.push("FORMAT JSON");
      const explainSql = flags.length > 0 ? `EXPLAIN (${flags.join(", ")}) ${sql}` : `EXPLAIN ${sql}`;

      // EXPLAIN without ANALYZE is always safe (parse + plan, no execution).
      // EXPLAIN ANALYZE actually executes the statement; when writes are
      // allowed, route through the rollback variant so the plan comes back
      // but any write the user asked to analyze does not persist. Without
      // ALLOW_WRITES, read-only is fine: reads work, writes fail with 25006.
      const result: ApiResponse =
        analyze && isWritesAllowed()
          ? await runReadWriteRollback(explainSql, params ?? [])
          : await runReadOnly(explainSql, params ?? []);

      if (!result.ok) return result;

      const data = result.data as { rows: Record<string, unknown>[] } | undefined;
      const rows = data?.rows ?? [];

      // EXPLAIN returns one row per plan line (`QUERY PLAN` column). Flatten for readability.
      if (format === "text") {
        const lines = rows.map((r) => String(r["QUERY PLAN"] ?? ""));
        return { ok: true, data: { plan: lines.join("\n") } };
      }

      // FORMAT JSON returns a single row with a JSON array in QUERY PLAN.
      const jsonPlan = rows[0]?.["QUERY PLAN"];
      return { ok: true, data: { plan: jsonPlan } };
    },
  },
] as const;
