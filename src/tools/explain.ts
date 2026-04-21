import { z } from "zod";
import { type ApiResponse, isWritesAllowed, runReadOnly, runReadWrite } from "../api.js";

export const explainTools = [
  {
    name: "pg_explain",
    description:
      "Get the query plan for a SQL statement. By default, this uses plain EXPLAIN (no execution). " +
      "Set `analyze: true` to run the query with EXPLAIN ANALYZE — for non-SELECT statements, " +
      "ALLOW_WRITES=1 is required (since ANALYZE actually executes the statement). " +
      "Format is `text` (default) or `json`.",
    annotations: {
      title: "Explain query plan",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      sql: z.string().min(1).describe("The SQL statement to explain."),
      analyze: z.boolean().default(false).describe("Run EXPLAIN ANALYZE (actually executes the query)."),
      format: z.enum(["text", "json"]).default("text").describe("Output format."),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Positional parameters referenced as $1, $2, ... in the SQL."),
    }),
    handler: async (input: unknown) => {
      const { sql, analyze, format, params } = input as {
        sql: string;
        analyze: boolean;
        format: "text" | "json";
        params?: unknown[];
      };

      const flags: string[] = [];
      if (analyze) flags.push("ANALYZE");
      if (format === "json") flags.push("FORMAT JSON");
      const explainSql = flags.length > 0 ? `EXPLAIN (${flags.join(", ")}) ${sql}` : `EXPLAIN ${sql}`;

      // EXPLAIN without ANALYZE is always safe (parse + plan, no execution).
      // EXPLAIN ANALYZE executes the statement — route through read-write
      // when writes are enabled so writable plans work; otherwise read-only.
      const result: ApiResponse =
        analyze && isWritesAllowed()
          ? await runReadWrite(explainSql, params ?? [])
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
