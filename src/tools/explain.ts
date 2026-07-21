import { z } from "zod";
import {
  type ApiResponse,
  isWritesAllowed,
  type RunHooks,
  runInternal,
  runReadOnly,
  runReadWriteRollback,
} from "../api.js";
import { identSchema, paramsArray } from "./params.js";

const indexAccessMethod = z.enum(["btree", "hash", "gin", "gist", "brin", "spgist"]);

const hypotheticalIndex = z.object({
  // `table` is `schema.table` or `table`. The 127-char ceiling is a generous
  // upper bound on the combined form -- the actual NAMEDATALEN (63-byte)
  // limit on each piece after the split is enforced in validateHypoIndex,
  // since splitting and per-piece byte-checking is awkward in Zod.
  table: z
    .string()
    .min(1)
    .max(127)
    .describe("Target table. Use `schema.table` (e.g. `public.users`) or just `table` for the search_path."),
  columns: z
    .array(identSchema)
    .min(1)
    .describe("Column names in index order. Quoted identifiers are not supported here -- pass plain names."),
  using: indexAccessMethod
    .default("btree")
    .describe("Index access method. btree is the right answer for almost every query."),
});

// Quote a single SQL identifier (table or column) using double-quotes,
// doubling any embedded quote so a value like `weird"col` becomes `"weird""col"`.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Quote `schema.table` if dotted, else just `table`. Each piece quoted
// independently so `public.users` -> `"public"."users"`. Names with literal
// dots or pre-quoting are rejected upstream by validateHypoIndex; we never
// reach this with adversarial input.
function quoteQualifiedTable(name: string): string {
  return name
    .split(".")
    .map((p) => quoteIdent(p))
    .join(".");
}

/**
 * Pre-flight check on hypothetical_indexes input. Catches pre-quoted names
 * (`"odd.name"`, `weird"col`) and per-identifier byte-length overflow before
 * we open a DB connection, so the user gets a clear validation error instead
 * of a confusing planner error or a mis-split on `.`. Returns null on
 * success, or an error string on the first offending entry.
 *
 * The byte cap mirrors `identSchema` in params.ts: postgres caps each
 * identifier at NAMEDATALEN-1 = 63 BYTES, and a multi-byte name (e.g.
 * `pré.café_logs`) can pass the Zod char ceiling while each piece exceeds
 * the byte limit. The `columns` array element is already guarded by
 * `identSchema` on the MCP-protocol path; we duplicate the byte check here
 * so direct handler calls (unit tests, library consumers) that bypass Zod
 * still get the same protection -- matches the precedent set by the `using`
 * default re-application in buildHypopgHooks.
 */
function validateHypoIndex(idx: { table: string; columns: string[] }): string | null {
  // Check the RAW string for pre-quoting BEFORE splitting on `.`: a pre-quoted
  // name with an embedded dot (`public."odd.name"`) splits into 3+ pieces, and
  // the over-qualified message alone gives the caller no hint that removing
  // the quotes is the fix. JSON.stringify the offending value so a name
  // containing `"` renders unambiguously instead of producing a broken
  // nested-quote message.
  if (idx.table.includes('"')) {
    return `Hypothetical index table ${JSON.stringify(idx.table)} contains a double-quote; pass plain identifier names without pre-quoting.`;
  }
  const pieces = idx.table.split(".");
  // Only `schema.table` (1 or 2 pieces) is a legal dotted shape. A 3+ part
  // name like `a.b.c` passes the per-piece checks below but renders as
  // `"a"."b"."c"`, which the planner rejects with a confusing error this
  // pre-flight exists to prevent.
  if (pieces.length > 2) {
    return `Hypothetical index table ${JSON.stringify(idx.table)} is over-qualified; use only \`schema.table\` or \`table\`.`;
  }
  for (const piece of pieces) {
    if (Buffer.byteLength(piece, "utf8") > 63) {
      return `Hypothetical index table piece ${JSON.stringify(piece)} exceeds PostgreSQL's 63-byte NAMEDATALEN limit (multi-byte characters count as multiple bytes).`;
    }
  }
  for (const col of idx.columns) {
    if (col.includes('"')) {
      return `Hypothetical index column ${JSON.stringify(col)} contains a double-quote; pass plain identifier names without pre-quoting.`;
    }
    if (Buffer.byteLength(col, "utf8") > 63) {
      return `Hypothetical index column ${JSON.stringify(col)} exceeds PostgreSQL's 63-byte NAMEDATALEN limit (multi-byte characters count as multiple bytes).`;
    }
  }
  return null;
}

// Build setup/teardown hooks that create HypoPG hypothetical indexes inside
// the EXPLAIN's transaction and reset them on the way out. HypoPG indexes
// are session-scoped (not transaction-scoped), so the teardown is essential
// even though the transaction is going to ROLLBACK -- otherwise indexes
// from one call leak into the next.
function buildHypopgHooks(indexes: { table: string; columns: string[]; using?: string }[]): {
  setup: (client: import("pg").PoolClient) => Promise<void>;
  teardown: (c: import("pg").PoolClient) => Promise<void>;
} {
  return {
    setup: async (client) => {
      for (const idx of indexes) {
        const cols = idx.columns.map(quoteIdent).join(", ");
        const tbl = quoteQualifiedTable(idx.table);
        // `using` has a Zod default of "btree", but unit tests that call the
        // handler directly bypass Zod -- so re-apply the default here. Without
        // this guard, an omitted `using` would render as `USING undefined` and
        // hypopg_create_index would surface a confusing syntax error.
        const using = idx.using ?? "btree";
        // The CREATE INDEX text is passed as a parameter to hypopg_create_index;
        // identifiers inside the text are double-quoted by us so the function
        // parses them as already-quoted ident tokens. The whole call still uses
        // the extended query protocol (queryMode default for runInternal-style),
        // so multi-statement injection is impossible.
        const createSql = `CREATE INDEX ON ${tbl} USING ${using} (${cols})`;
        const r = await client.query<{ indexname: string | null }>(
          "SELECT (hypopg_create_index($1)).indexname AS indexname",
          [createSql],
        );
        if (!r.rows[0]?.indexname) {
          throw new Error(`hypopg_create_index returned no index for: ${createSql}`);
        }
      }
    },
    teardown: async (client) => {
      // hypopg_reset() drops every hypothetical index for the session, so a
      // single call covers however many we created above. Safe even if no
      // indexes were created (early failure in setup).
      await client.query("SELECT hypopg_reset()");
    },
  };
}

export const explainTools = [
  {
    name: "pg_explain",
    description:
      "Get the query plan for a SQL statement. By default, this uses plain EXPLAIN (no execution). " +
      "Set `analyze: true` to run the query with EXPLAIN ANALYZE - for non-SELECT statements, " +
      "ALLOW_WRITES=1 is required (since ANALYZE actually executes the statement). Writes " +
      "executed during EXPLAIN ANALYZE are always rolled back, so you can inspect a plan for " +
      "an INSERT/UPDATE/DELETE without persisting the mutation. Format is `text` (default) or " +
      "`json`. Pass the raw SQL (not an EXPLAIN-prefixed statement). " +
      "Set `hypothetical_indexes` to a list of `{table, columns, using?}` to ask the planner " +
      "'what would the plan be if these indexes existed?' -- requires the HypoPG extension " +
      "(`CREATE EXTENSION hypopg`). The hypothetical indexes are torn down at the end of the " +
      "call, never touching real disk.",
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
      params: paramsArray.optional().describe("Positional parameters referenced as $1, $2, ... in the SQL."),
      hypothetical_indexes: z
        .array(hypotheticalIndex)
        .optional()
        .describe(
          "List of indexes the planner should pretend exist for this EXPLAIN. Requires the HypoPG " +
            "extension. Indexes are session-scoped and reset at the end of the call.",
        ),
    }),
    handler: async (input: unknown) => {
      const {
        sql,
        analyze: rawAnalyze,
        format: rawFormat,
        params,
        hypothetical_indexes,
      } = input as {
        sql: string;
        analyze?: boolean;
        format?: "text" | "json";
        params?: unknown[];
        hypothetical_indexes?: { table: string; columns: string[]; using?: string }[];
      };

      // Direct (non-MCP) callers bypass Zod, so the analyze/format defaults the
      // schema would have applied never ran -- a caller omitting `format` would
      // otherwise fall into the json branch and get a raw text string back.
      // Re-apply the documented defaults here, mirroring the `using ?? "btree"`
      // precedent in buildHypopgHooks.
      const analyze = rawAnalyze ?? false;
      const format = rawFormat ?? "text";

      // LLMs often pass pre-wrapped SQL like "EXPLAIN ANALYZE SELECT ..." which
      // would become "EXPLAIN (ANALYZE) EXPLAIN ANALYZE SELECT ..." below -
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

      const hypoIndexes = hypothetical_indexes ?? [];

      // Validate identifier shapes before anything else -- pre-quoted names
      // (`"odd.name"`, `weird"col`) would split incorrectly on `.` or produce
      // confusing planner errors. Faster to reject here than to round-trip
      // a connection acquire and a CREATE INDEX failure.
      for (const idx of hypoIndexes) {
        const err = validateHypoIndex(idx);
        if (err) return { ok: false, error: err };
      }

      const hooks: RunHooks = hypoIndexes.length > 0 ? buildHypopgHooks(hypoIndexes) : {};

      // Verify HypoPG is installed before we even start the txn -- otherwise
      // the user gets a confusing 'function hypopg_create_index does not
      // exist' from inside the rollback path.
      if (hypoIndexes.length > 0) {
        const check = await runInternal<{ installed: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg'
           ) AS installed`,
        );
        if (!check.ok) return check;
        if (!check.data?.[0]?.installed) {
          return {
            ok: false,
            error:
              "hypothetical_indexes requires the HypoPG extension. Install with " +
              "`CREATE EXTENSION hypopg;` (a superuser-equivalent role usually). " +
              "HypoPG is read-only at the disk level - it lives entirely in shared memory.",
          };
        }
      }

      // EXPLAIN without ANALYZE is always safe (parse + plan, no execution).
      // EXPLAIN ANALYZE actually executes the statement; when writes are
      // allowed, route through the rollback variant so the plan comes back
      // but any write the user asked to analyze does not persist. Without
      // ALLOW_WRITES, read-only is fine: reads work, writes fail with 25006.
      const result: ApiResponse =
        analyze && isWritesAllowed()
          ? await runReadWriteRollback(explainSql, params ?? [], hooks)
          : await runReadOnly(explainSql, params ?? [], hooks);

      if (!result.ok) return result;

      const data = result.data as { rows: Record<string, unknown>[] } | undefined;
      const rows = data?.rows ?? [];

      // EXPLAIN always returns at least one row in normal operation. A zero-row
      // result here means something pathological happened (driver quirk, server
      // returned an empty result set), so surface it as an error instead of a
      // misleading `{plan: ""}` or `{plan: undefined}` payload.
      if (rows.length === 0) {
        return { ok: false, error: "EXPLAIN returned no rows; unable to produce a plan." };
      }

      // EXPLAIN returns one row per plan line (`QUERY PLAN` column). Flatten for readability.
      if (format === "text") {
        const lines = rows.map((r) => String(r["QUERY PLAN"] ?? ""));
        // The cursor FETCH caps at POSTGRES_MAX_ROWS; toQueryResult sets
        // `truncated` when it does. For a text plan that means the plan was
        // chopped mid-output, so flag it rather than returning a silently
        // incomplete plan.
        if ((result.data as { truncated?: boolean }).truncated) {
          lines.push(`... [plan truncated at ${rows.length} lines; raise POSTGRES_MAX_ROWS to see the full plan]`);
        }
        return { ok: true, data: { plan: lines.join("\n") } };
      }

      // FORMAT JSON returns a single row with a JSON array in QUERY PLAN -- so
      // truncation can't fire here (one row is always under POSTGRES_MAX_ROWS).
      const jsonPlan = rows[0]?.["QUERY PLAN"];
      return { ok: true, data: { plan: jsonPlan } };
    },
  },
] as const;
