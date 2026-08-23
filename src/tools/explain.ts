import { z } from "zod";
import {
  type ApiResponse,
  getServerVersionNum,
  isWritesAllowed,
  PG16,
  PG17,
  type RunHooks,
  runInternal,
  runReadOnly,
  runReadWriteRollback,
} from "../api.js";
import { identSchema, paramsArray } from "./params.js";

/**
 * Two more `server_version_num` cut points, in the same major * 10000 shape as
 * the `PG16`/`PG17`/`PG18` constants api.ts exports. They live here rather than
 * there because nothing else in the codebase gates on 12 or 13 -- and a bare
 * `120_000` in a version comparison reads as a row count, not a major version.
 */
const PG12 = 120_000;
const PG13 = 130_000;

// EXPLAIN's SERIALIZE is an enum, not a boolean: it picks how far the executor
// takes the result rows (skip serialization / build text / build binary).
const SERIALIZE_MODES = ["none", "text", "binary"] as const;
const serializeMode = z.enum(SERIALIZE_MODES);

// Kept as a plain const array rather than living only inside the z.enum for
// the same reason SERIALIZE_MODES is: `using` is interpolated into the
// CREATE INDEX text, and validateHypoIndex has to re-check membership for
// callers who never run Zod.
const INDEX_ACCESS_METHODS = ["btree", "hash", "gin", "gist", "brin", "spgist"] as const;
const indexAccessMethod = z.enum(INDEX_ACCESS_METHODS);

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
function validateHypoIndex(idx: { table: string; columns: string[]; using?: string }): string | null {
  // `using` is the second value in this file (after `serialize`) whose VALUE
  // reaches raw SQL text -- it is interpolated into the CREATE INDEX string
  // handed to hypopg_create_index. The Zod enum narrows it on the MCP path,
  // but buildHypopgHooks only re-applies the `?? "btree"` DEFAULT, so an
  // explicitly supplied garbage value from a direct caller sailed past both
  // and landed inside the statement. `serialize` gets exactly this membership
  // re-check in the handler; without the matching one here the two paths were
  // asymmetrically guarded.
  if (idx.using !== undefined && !(INDEX_ACCESS_METHODS as readonly string[]).includes(idx.using)) {
    return (
      `Unsupported \`using\` value ${JSON.stringify(idx.using)}; ` +
      `expected one of: ${INDEX_ACCESS_METHODS.join(", ")}.`
    );
  }
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
      "Planner options (all optional): `buffers` reports shared/local/temp block hits and is the " +
      "fastest way to tell a bad plan from a cold cache - it defaults to TRUE whenever `analyze` " +
      "is true (matching PostgreSQL 18, which turns it on for you), pass `buffers: false` to " +
      "suppress it; requesting it WITHOUT `analyze` needs PostgreSQL 13+. `verbose` adds output " +
      "columns and schema-qualified names. `settings` (PostgreSQL 12+) lists planner GUCs set away " +
      "from their defaults - the usual explanation for a plan that looks impossible. `wal` " +
      "(PostgreSQL 13+) reports WAL generated and `serialize` (`none`|`text`|`binary`, " +
      "PostgreSQL 17+) charges the cost of building the result rows; both require `analyze`. " +
      "`memory` (PostgreSQL 17+) reports memory used by the PLANNER, so it works with or without " +
      "`analyze` - use it alone to ask why planning a statement is expensive. " +
      "`generic_plan` (PostgreSQL 16+) plans a " +
      "parameterized statement WITHOUT values for its $1/$2 placeholders and cannot be combined " +
      "with `analyze` or `params`. `costs` and `timing` default to true (as in postgres); set " +
      "either to false to drop those columns, and note `timing` only applies with `analyze`. " +
      "Options that need a newer server than the one connected are rejected with an explicit " +
      "error naming the required version instead of a confusing parse failure. " +
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
      // Deliberately NOT `.default(false)`: the effective default is "on when
      // analyzing", which Zod cannot express in terms of a sibling field. An
      // absent value means "follow analyze"; an explicit false still wins.
      buffers: z
        .boolean()
        .optional()
        .describe(
          "Report buffer hits/reads/dirtied. Defaults to TRUE when `analyze` is true (PostgreSQL 18 does " +
            "the same); pass false to suppress. Requesting it without `analyze` requires PostgreSQL 13+.",
        ),
      verbose: z.boolean().default(false).describe("Include output columns, schema-qualified names, and triggers."),
      settings: z
        .boolean()
        .default(false)
        .describe("Report planner GUCs set away from their defaults - explains a weird plan (PostgreSQL 12+)."),
      wal: z
        .boolean()
        .default(false)
        .describe("Report WAL generated by the statement. Requires `analyze` (PostgreSQL 13+)."),
      memory: z
        .boolean()
        .default(false)
        .describe(
          "Report memory used by the planner (PostgreSQL 17+). Works with or without `analyze`, " +
            "since planning happens either way.",
        ),
      serialize: serializeMode
        .optional()
        .describe(
          "Charge the cost of serializing result rows (network-bound queries hide it otherwise). " +
            "Requires `analyze` (PostgreSQL 17+).",
        ),
      generic_plan: z
        .boolean()
        .default(false)
        .describe(
          "Plan the statement with UNKNOWN values for its $1/$2 placeholders - the plan a prepared " +
            "statement would get. Cannot be combined with `analyze` or `params` (PostgreSQL 16+).",
        ),
      costs: z.boolean().default(true).describe("Include estimated cost/rows/width. Set false for a terser plan."),
      timing: z
        .boolean()
        .default(true)
        .describe(
          "Include per-node actual timing. Setting it to false REQUIRES `analyze: true` (it is " +
            "rejected otherwise, not silently ignored); false lowers measurement overhead.",
        ),
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
      // Direct (non-MCP) callers bypass Zod, so the analyze/format defaults the
      // schema would have applied never ran -- a caller omitting `format` would
      // otherwise fall into the json branch and get a raw text string back.
      // Re-applied in the destructure, mirroring the `using ?? "btree"`
      // precedent in buildHypopgHooks. Every other tool here does the same.
      const {
        sql,
        analyze = false,
        format = "text",
        buffers,
        verbose = false,
        settings = false,
        wal = false,
        memory = false,
        serialize,
        generic_plan = false,
        costs = true,
        timing = true,
        params,
        hypothetical_indexes,
      } = input as {
        sql: string;
        analyze?: boolean;
        format?: "text" | "json";
        buffers?: boolean;
        verbose?: boolean;
        settings?: boolean;
        wal?: boolean;
        memory?: boolean;
        // Widened to `string` on purpose: the Zod enum does not run for direct
        // callers, and this is the one option whose VALUE reaches the SQL text.
        // The membership check below is what narrows it.
        serialize?: string;
        generic_plan?: boolean;
        costs?: boolean;
        timing?: boolean;
        params?: unknown[];
        hypothetical_indexes?: { table: string; columns: string[]; using?: string }[];
      };

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

      // `serialize` is the only option whose VALUE is interpolated into the
      // option list, and direct (non-MCP) callers never run the Zod enum -- so
      // re-check membership here. Without it, an arbitrary string would be
      // pasted inside `EXPLAIN (...)`.
      if (serialize !== undefined && !(SERIALIZE_MODES as readonly string[]).includes(serialize)) {
        return {
          ok: false,
          error:
            `Unsupported \`serialize\` value ${JSON.stringify(serialize)}; ` +
            `expected one of: ${SERIALIZE_MODES.join(", ")}.`,
        };
      }

      // BUFFERS is the single most useful number in a slow-query plan (it
      // separates "the plan is bad" from "the data was not cached"), and
      // PostgreSQL 18 enables it for EXPLAIN ANALYZE by default. Match that on
      // every server version while leaving `buffers: false` a real opt-out --
      // hence `??` rather than `||`.
      const wantBuffers = buffers ?? analyze;

      // Options postgres rejects outright without ANALYZE ("EXPLAIN option WAL
      // requires ANALYZE") or that have nothing to measure when the statement
      // never runs. Named here so the caller gets the fix, not a server error.
      // `memory` is deliberately NOT in this list. It reports memory consumed
      // by the PLANNING phase, which happens whether or not the statement is
      // executed, and postgres accepts `EXPLAIN (MEMORY)` standalone. Rejecting
      // it here would make this tool stricter than the server and block a
      // legitimate question ("why is planning this thing expensive?").
      const analyzeOnly: string[] = [];
      if (!analyze) {
        if (wal) analyzeOnly.push("wal");
        if (serialize !== undefined) analyzeOnly.push("serialize");
        if (!timing) analyzeOnly.push("timing");
      }
      if (analyzeOnly.length > 0) {
        const named = analyzeOnly.map((o) => `\`${o}\``).join(", ");
        return {
          ok: false,
          error:
            `These EXPLAIN options only apply with \`analyze: true\`: ${named}. ` +
            "Set `analyze: true` (the statement is executed, and any write is rolled back) or drop them.",
        };
      }

      // GENERIC_PLAN asks the planner to plan with UNKNOWN parameter values;
      // ANALYZE has to execute, which needs real ones. Postgres errors on the
      // combination, so reject it here rather than paying a round trip to be
      // told the same thing less clearly.
      if (generic_plan && analyze) {
        return {
          ok: false,
          error:
            "`generic_plan` and `analyze` cannot be combined: GENERIC_PLAN plans the statement without " +
            "parameter values, while ANALYZE has to execute it with real ones. Pick one.",
        };
      }

      // Supplying `params` alongside generic_plan contradicts the whole point
      // of the option -- the placeholders must stay unbound for the planner to
      // produce the generic plan.
      if (generic_plan && (params?.length ?? 0) > 0) {
        return {
          ok: false,
          error:
            "`generic_plan` plans the statement WITHOUT parameter values -- drop `params` (leave the " +
            "$1/$2 placeholders in the SQL), or drop `generic_plan` and pass the values.",
        };
      }

      const hypoIndexes = hypothetical_indexes ?? [];

      // Validate identifier shapes before we open a connection -- pre-quoted
      // names (`"odd.name"`, `weird"col`) would split incorrectly on `.` or
      // produce confusing planner errors. Faster to reject here than to
      // round-trip a connection acquire and a CREATE INDEX failure.
      for (const idx of hypoIndexes) {
        const err = validateHypoIndex(idx);
        if (err) return { ok: false, error: err };
      }

      // Options that do not parse at all on an older server: postgres answers
      // with `unrecognized EXPLAIN option "generic_plan"`, which reads like the
      // caller typed a garbage keyword rather than "your server is too old".
      // Collect the floors first so one probe covers however many were asked
      // for, and so the probe runs ONLY when a gated option was requested --
      // `analyze`/`format`/`params`/`hypothetical_indexes` must keep working on
      // a server we cannot version-probe (getServerVersionNum returns the 0
      // "assume oldest" sentinel on any failure, and does not cache it).
      const gated: { option: string; min: number; since: string }[] = [];
      if (settings) gated.push({ option: "settings", min: PG12, since: "12" });
      if (wal) gated.push({ option: "wal", min: PG13, since: "13" });
      if (generic_plan) gated.push({ option: "generic_plan", min: PG16, since: "16" });
      if (memory) gated.push({ option: "memory", min: PG17, since: "17" });
      if (serialize !== undefined) gated.push({ option: "serialize", min: PG17, since: "17" });
      // BUFFERS itself is ancient; only PG13+ accepts it WITHOUT ANALYZE (older
      // servers: `EXPLAIN option BUFFERS requires ANALYZE`). Unreachable unless
      // the caller passed `buffers: true` explicitly, since the default tracks
      // `analyze` -- so the version-gated default never blocks anyone.
      // Label carries no backticks: the error formatter wraps `option` in them,
      // so an inner pair renders as `buffers (without `analyze`)` -- nested and
      // unreadable in every markdown-rendering host.
      if (wantBuffers && !analyze) gated.push({ option: "buffers without analyze", min: PG13, since: "13" });

      if (gated.length > 0) {
        const serverVersion = await getServerVersionNum();
        const unsupported = gated.filter((g) => serverVersion < g.min);
        if (unsupported.length > 0) {
          const server =
            serverVersion === 0
              ? "the server version could not be determined, so the oldest supported behavior is assumed"
              : `this server reports PostgreSQL ${Math.floor(serverVersion / 10_000)}`;
          return {
            ok: false,
            error: `Unsupported EXPLAIN option for this server: ${unsupported
              .map((g) => `\`${g.option}\` requires PostgreSQL ${g.since}+`)
              .join("; ")} (${server}). Drop the option and re-run.`,
          };
        }
      }

      // Every entry renders as a bare `EXPLAIN (...)` option token. COSTS and
      // TIMING default ON in postgres, so only their OFF form is emitted --
      // and `TIMING OFF` is legal only alongside ANALYZE, which the
      // analyze-only guard above already enforced. FORMAT JSON stays last so
      // the option list reads the way postgres documents it.
      const flags: string[] = [];
      if (analyze) flags.push("ANALYZE");
      if (wantBuffers) flags.push("BUFFERS");
      if (verbose) flags.push("VERBOSE");
      if (settings) flags.push("SETTINGS");
      if (wal) flags.push("WAL");
      if (memory) flags.push("MEMORY");
      if (generic_plan) flags.push("GENERIC_PLAN");
      if (!costs) flags.push("COSTS OFF");
      if (!timing) flags.push("TIMING OFF");
      if (serialize !== undefined) flags.push(`SERIALIZE ${serialize.toUpperCase()}`);
      if (format === "json") flags.push("FORMAT JSON");
      const explainSql = flags.length > 0 ? `EXPLAIN (${flags.join(", ")}) ${sql}` : `EXPLAIN ${sql}`;

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
