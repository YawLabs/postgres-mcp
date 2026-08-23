import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import {
  compareVersions,
  hasStatementsInfo,
  indexLastScanCols,
  PG_STAT_STATEMENTS_INFO_MIN_VERSION,
  statsTools,
  tableLastScanCols,
  withStatsReset,
} from "./stats.js";

describe("compareVersions", () => {
  it("equal versions return 0", () => {
    assert.equal(compareVersions("1.8", "1.8"), 0);
    assert.equal(compareVersions("1.8.0", "1.8.0"), 0);
  });

  it("missing trailing segments compare as 0 (1.8 == 1.8.0)", () => {
    assert.equal(compareVersions("1.8", "1.8.0"), 0);
    assert.equal(compareVersions("1.8.0", "1.8"), 0);
  });

  it("a < b returns negative", () => {
    assert.ok(compareVersions("1.7", "1.8") < 0);
    assert.ok(compareVersions("1.8", "1.10") < 0, "numeric, not lexical: 1.8 < 1.10");
    assert.ok(compareVersions("1.7.99", "1.8") < 0, "patch-level vs minor bump");
    assert.ok(compareVersions("1.8", "1.8.1") < 0, "extra patch beats no patch");
  });

  it("a > b returns positive", () => {
    assert.ok(compareVersions("1.8", "1.7") > 0);
    assert.ok(compareVersions("1.10", "1.8") > 0);
    assert.ok(compareVersions("2.0", "1.99") > 0);
  });

  it("trailing pre-release tag (1.10-beta) parses leading digits per segment", () => {
    // 1.10-beta should be treated like 1.10 for the column-rename detection.
    assert.equal(compareVersions("1.10-beta", "1.10"), 0);
    assert.ok(compareVersions("1.10-beta", "1.8") > 0);
    assert.ok(compareVersions("1.10-beta", "1.11") < 0);
  });

  it("trailing alphanumeric tag (1.8rc1) parses to 1.8", () => {
    assert.equal(compareVersions("1.8rc1", "1.8"), 0);
    assert.ok(compareVersions("1.8rc1", "1.7") > 0);
  });

  it("non-numeric segment falls back to 0 rather than NaN", () => {
    // Defensive: an extversion of `dev` or `unknown` shouldn't crash the
    // comparator; treat as 0 so we err on the "old" side and use the
    // pre-1.8 column names.
    assert.ok(compareVersions("dev", "1.8") < 0);
    assert.equal(compareVersions("dev", "0"), 0);
  });

  it("the 1.8 boundary used by pg_top_queries works correctly", () => {
    // This is the actual production check in stats.ts.
    assert.ok(compareVersions("1.7", "1.8") < 0, "1.7 uses pre-rename columns");
    assert.ok(compareVersions("1.8", "1.8") >= 0, "1.8 uses _exec_ columns");
    assert.ok(compareVersions("1.9", "1.8") >= 0, "1.9 uses _exec_ columns");
    assert.ok(compareVersions("1.10", "1.8") >= 0, "1.10 uses _exec_ columns (numeric, not lexical)");
  });
});

describe("last-scan column gating (PG16)", () => {
  // The whole point of the gate: pg_stat_user_indexes.last_idx_scan and
  // pg_stat_user_tables.last_seq_scan / last_idx_scan were added in PG16.
  // Naming them on an older server is SQLSTATE 42703 (undefined_column),
  // which fails the entire tool rather than degrading the answer.
  it("emits nothing at all below PG16", () => {
    for (const v of [0, 90_600, 120_000, 150_000, 159_999]) {
      assert.equal(indexLastScanCols(v), "", `index fragment leaked at ${v}`);
      assert.equal(tableLastScanCols(v), "", `table fragment leaked at ${v}`);
    }
  });

  it("never names the PG16 columns below PG16", () => {
    // Stronger than the equality above: even a whitespace-only fragment must
    // not carry the column name, since that is what postgres would reject.
    for (const v of [0, 150_000, 159_999]) {
      assert.ok(!indexLastScanCols(v).includes("last_idx_scan"));
      assert.ok(!tableLastScanCols(v).includes("last_seq_scan"));
      assert.ok(!tableLastScanCols(v).includes("last_idx_scan"));
    }
  });

  it("0 (version unknown) takes the conservative pre-16 branch", () => {
    // api.ts returns 0 when the probe fails. Assume-oldest keeps a transient
    // probe failure from producing SQL the server cannot parse.
    assert.equal(indexLastScanCols(0), "");
    assert.equal(tableLastScanCols(0), "");
  });

  it("includes the columns from PG16 up, with no upper bound", () => {
    for (const v of [160_000, 170_000, 180_000, 190_000]) {
      assert.ok(
        indexLastScanCols(v).includes("s.last_idx_scan::text AS last_idx_scan"),
        `index fragment missing at ${v}`,
      );
      assert.ok(
        tableLastScanCols(v).includes("last_seq_scan::text AS last_seq_scan"),
        `table seq fragment missing at ${v}`,
      );
      assert.ok(
        tableLastScanCols(v).includes("last_idx_scan::text AS last_idx_scan"),
        `table idx fragment missing at ${v}`,
      );
    }
  });

  it("the boundary is exactly 160000, not 160001", () => {
    assert.equal(indexLastScanCols(159_999), "");
    assert.notEqual(indexLastScanCols(160_000), "");
    assert.equal(tableLastScanCols(159_999), "");
    assert.notEqual(tableLastScanCols(160_000), "");
  });

  it("fragments start with a comma so they append after the last SELECT column", () => {
    // Without the leading comma the fragment fuses onto the previous column
    // (`... AS ratio last_seq_scan::text ...`) and postgres rejects the query.
    assert.ok(indexLastScanCols(160_000).startsWith(","));
    assert.ok(tableLastScanCols(160_000).startsWith(","));
  });

  it("timestamps are cast to text, matching the repo's serialization rule", () => {
    // timestamptz through the pg driver becomes a JS Date whose JSON form is
    // UTC-shifted; ::text keeps the server's own rendering.
    assert.ok(indexLastScanCols(180_000).includes("::text"));
    assert.ok(tableLastScanCols(180_000).includes("::text"));
  });
});

describe("pg_stat_statements_info gating (extversion 1.9)", () => {
  // pg_stat_statements_info arrived with extension 1.9 (PostgreSQL 14).
  // Naming the view on an older extension is SQLSTATE 42P01 (undefined_table),
  // which fails all of pg_top_queries rather than just costing the context.
  it("the floor is 1.9, matching the PG14 release note", () => {
    assert.equal(PG_STAT_STATEMENTS_INFO_MIN_VERSION, "1.9");
  });

  it("is false for every extversion below 1.9", () => {
    for (const v of ["1.0", "1.4", "1.7", "1.8", "1.8.1"]) {
      assert.equal(hasStatementsInfo(v), false, `view would have been named at ${v}`);
    }
  });

  it("is true from 1.9 up, with no upper bound", () => {
    for (const v of ["1.9", "1.10", "1.11", "1.12", "2.0"]) {
      assert.equal(hasStatementsInfo(v), true, `view wrongly skipped at ${v}`);
    }
  });

  it("the boundary is exactly 1.9, and 1.10 is numerically above it", () => {
    // The lexical trap: "1.10" < "1.9" as strings. compareVersions is numeric,
    // so 1.10 (PG15) must not fall back to the no-view branch.
    assert.equal(hasStatementsInfo("1.8"), false);
    assert.equal(hasStatementsInfo("1.9"), true);
    assert.equal(hasStatementsInfo("1.10"), true, "numeric, not lexical: 1.10 > 1.9");
  });

  it("an unparseable extversion takes the conservative no-view branch", () => {
    // compareVersions maps a non-numeric segment to 0, so a weird extversion
    // errs toward omitting the columns rather than emitting SQL that throws.
    assert.equal(hasStatementsInfo("dev"), false);
    assert.equal(hasStatementsInfo("0"), false);
  });

  it("a pre-release tag on the boundary version still counts as 1.9", () => {
    assert.equal(hasStatementsInfo("1.9-beta"), true);
  });
});

describe("withStatsReset", () => {
  const rows = [{ index: "idx_a", scans: "0" }];

  it("carries the reset point through on a successful probe", () => {
    const out = withStatsReset(rows, {
      ok: true,
      data: [{ stats_reset: "2026-02-14 09:00:00+00", stats_reset_age_seconds: 604_800 }],
    });
    assert.deepEqual(out.rows, rows);
    assert.equal(out.stats_reset, "2026-02-14 09:00:00+00");
    assert.equal(out.stats_reset_age_seconds, 604_800);
    assert.equal(out._warnings, undefined, "clean probe must not emit warnings");
  });

  it("passes a genuine catalog NULL through without a warning", () => {
    // NULL means "never reset / start point unknown" -- a real answer, not a
    // failure. The description tells the caller how to read it.
    const out = withStatsReset(rows, {
      ok: true,
      data: [{ stats_reset: null, stats_reset_age_seconds: null }],
    });
    assert.equal(out.stats_reset, null);
    assert.equal(out.stats_reset_age_seconds, null);
    assert.equal(out._warnings, undefined);
  });

  it("warns (does not silently null) when the probe fails", () => {
    // The failure this guards: a failed probe and a never-reset database both
    // surface stats_reset: null. Only the warning distinguishes them, and a
    // drop-this-index recommendation hangs on that distinction.
    const out = withStatsReset(rows, { ok: false, error: "permission denied for view pg_stat_database" });
    assert.equal(out.stats_reset, null);
    assert.equal(out.stats_reset_age_seconds, null);
    assert.ok(out._warnings, "expected a _warnings entry");
    assert.equal(out._warnings?.length, 1);
    assert.match(out._warnings?.[0] ?? "", /permission denied/, "original pg error must survive");
  });

  it("warns when the probe succeeds but returns no row", () => {
    const out = withStatsReset(rows, { ok: true, data: [] });
    assert.equal(out.stats_reset, null);
    assert.ok(out._warnings?.[0]?.includes("pg_stat_database"));
  });

  it("preserves rows on every branch, including the failure branches", () => {
    // The reset probe is context, not the answer: losing the rows because the
    // context could not be read would be a worse failure than no context.
    assert.deepEqual(withStatsReset(rows, { ok: false, error: "boom" }).rows, rows);
    assert.deepEqual(withStatsReset(rows, { ok: true, data: [] }).rows, rows);
  });

  it("an empty row list is still a valid answer with context attached", () => {
    // 'No unused indexes found' is exactly the result an agent acts on, and it
    // is the case a per-row stats_reset column could not have covered.
    const out = withStatsReset([], {
      ok: true,
      data: [{ stats_reset: "2026-08-22 00:00:00+00", stats_reset_age_seconds: 60 }],
    });
    assert.deepEqual(out.rows, []);
    assert.equal(out.stats_reset_age_seconds, 60);
  });

  it("names the probed view in the no-row warning", () => {
    // pg_top_queries reads pg_stat_statements_info, not pg_stat_database. A
    // warning naming the wrong view sends the debugger to the wrong catalog.
    const out = withStatsReset(rows, { ok: true, data: [] }, "pg_stat_statements_info");
    assert.ok(out._warnings?.[0]?.includes("pg_stat_statements_info"));
    assert.ok(!out._warnings?.[0]?.includes("pg_stat_database"));
  });

  it("defaults the source view to pg_stat_database for the table/index tools", () => {
    assert.ok(withStatsReset(rows, { ok: true, data: [] })._warnings?.[0]?.includes("pg_stat_database"));
  });
});

describe("withStatsReset dealloc pass-through", () => {
  const rows = [{ query: "SELECT ?", calls: "10" }];

  it("carries dealloc through from pg_stat_statements_info", () => {
    const out = withStatsReset(
      rows,
      { ok: true, data: [{ stats_reset: "2026-08-01 00:00:00+00", stats_reset_age_seconds: 1000, dealloc: "42" }] },
      "pg_stat_statements_info",
    );
    assert.equal(out.dealloc, "42");
    assert.equal(out.stats_reset, "2026-08-01 00:00:00+00");
  });

  it('keeps a "0" dealloc rather than dropping it as falsy', () => {
    // "nothing was evicted, so the ranking is complete" is the most common real
    // answer and the one a caller most needs to see. A truthiness check on the
    // string would silently omit exactly this case.
    const out = withStatsReset(
      rows,
      { ok: true, data: [{ stats_reset: null, stats_reset_age_seconds: null, dealloc: "0" }] },
      "pg_stat_statements_info",
    );
    assert.ok("dealloc" in out, "dealloc key must survive a 0 value");
    assert.equal(out.dealloc, "0");
  });

  it("omits the dealloc key entirely for the pg_stat_database probe", () => {
    // pg_stat_database has no eviction concept, so the table/index tools must
    // not grow a dealloc: null that reads as "nothing was ever evicted".
    const out = withStatsReset(rows, {
      ok: true,
      data: [{ stats_reset: "2026-08-01 00:00:00+00", stats_reset_age_seconds: 1000 }],
    });
    assert.ok(!("dealloc" in out), `dealloc leaked onto the pg_stat_database envelope: ${JSON.stringify(out)}`);
  });

  it("does not invent a dealloc when the probe fails or returns no row", () => {
    // Same rule as stats_reset: a failure must not surface as a reassuring
    // value. Absent + warned, never a fabricated count.
    const failed = withStatsReset(rows, { ok: false, error: "boom" }, "pg_stat_statements_info");
    assert.ok(!("dealloc" in failed), `dealloc appeared on a failed probe: ${JSON.stringify(failed)}`);
    assert.ok(failed._warnings, "expected a warning on the failed-probe branch");

    const empty = withStatsReset(rows, { ok: true, data: [] }, "pg_stat_statements_info");
    assert.ok(!("dealloc" in empty), `dealloc appeared on an empty probe: ${JSON.stringify(empty)}`);
    assert.ok(empty._warnings, "expected a warning on the no-row branch");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pg_top_queries and the stats envelope WITHOUT a live DB.
//
// Two things the suites above cannot reach.
//
// First, the sub-1.9 degraded envelope. `hasStatementsInfo` is tested as a
// predicate and `withStatsReset` as a formatter, but nothing checks that the
// handler WIRES them together -- a handler that computed the gate correctly
// and then ignored it stays green in both. Its only other test lives in the
// integration suite, which early-returns whenever hasStatementsInfo() is true,
// i.e. on every cluster anyone still runs, so that branch has never actually
// executed anywhere.
//
// Second, which ARGUMENTS each handler passes withStatsReset. Calling the
// helper directly proves the formatting; it cannot catch a handler that drops
// the sourceView positional and warns about the wrong catalog.
//
// Same stub shape as the pg_io_stats suite in io.test.ts: stub BOTH
// `pg.Pool.prototype.connect` (the shared client the paired queries run on)
// and `pg.Pool.prototype.query`, because runInternal's extversion probe and
// getServerVersionNum both go through the POOL rather than the shared client.
// Leaving the pool query alone sends those at the fake DATABASE_URL host and
// hangs on a connect timeout.
// ─────────────────────────────────────────────────────────────────────────

const pgTopQueries = statsTools.find((t) => t.name === "pg_top_queries")!;
const pgSeqScanTables = statsTools.find((t) => t.name === "pg_seq_scan_tables")!;
const pgUnusedIndexes = statsTools.find((t) => t.name === "pg_unused_indexes")!;

/** Which statement of which stats tool a given SQL string is. */
type StatsCategory = "version" | "extversion" | "info" | "ranking" | "reset" | "tables" | "indexes" | "unknown";

function categorize(sql: string): StatsCategory {
  if (sql.includes("server_version_num")) return "version";
  if (sql.includes("pg_catalog.pg_extension")) return "extversion";
  // Tested before "ranking": `pg_stat_statements` is a strict prefix of
  // `pg_stat_statements_info`, so the looser check would swallow the info
  // probe and this whole suite would assert against the wrong statement.
  if (sql.includes("pg_stat_statements_info")) return "info";
  if (sql.includes("FROM pg_stat_statements")) return "ranking";
  if (sql.includes("pg_stat_database")) return "reset";
  if (sql.includes("pg_stat_user_tables")) return "tables";
  if (sql.includes("pg_stat_user_indexes")) return "indexes";
  return "unknown";
}

function rowsFor(sql: string): Record<string, unknown>[] {
  switch (categorize(sql)) {
    case "ranking":
      return [
        {
          query: "SELECT ?",
          calls: "10",
          total_time_ms: 12.5,
          mean_time_ms: 1.25,
          min_time_ms: 0.5,
          max_time_ms: 4,
          rows: "10",
          hit_percent: 99.5,
        },
      ];
    case "info":
      // dealloc "0" on purpose: the most common real value, and the one a
      // truthiness check would silently drop off the envelope.
      return [{ stats_reset: "2026-08-01 00:00:00+00", stats_reset_age_seconds: 1000, dealloc: "0" }];
    case "reset":
      // No dealloc key at all -- pg_stat_database has no eviction concept.
      return [{ stats_reset: "2026-08-01 00:00:00+00", stats_reset_age_seconds: 1000 }];
    case "tables":
      return [
        {
          schema: "public",
          table: "orders",
          seq_scans: "5",
          idx_scans: "0",
          live_tuples: "1000",
          seq_tup_read: "5000",
          ratio: null,
        },
      ];
    case "indexes":
      return [
        {
          schema: "public",
          table: "orders",
          index: "idx_orders_note",
          scans: "0",
          size_pretty: "8192 bytes",
          size_bytes: "8192",
          definition: "CREATE INDEX idx_orders_note ON public.orders USING btree (note)",
        },
      ];
    default:
      return [];
  }
}

/** The envelope every tool in this file returns, as a stubbed caller sees it. */
interface StatsResponse {
  ok: boolean;
  error?: string;
  data: {
    rows: Record<string, unknown>[];
    stats_reset?: string | null;
    stats_reset_age_seconds?: number | null;
    dealloc?: string | null;
    _warnings?: string[];
  };
}

describe("stats tools (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let seen: { sql: string; params: unknown[] }[] = [];
  let pooled: string[] = [];

  /**
   * @param extVersion the `pg_stat_statements` extversion the probe reports.
   * @param failing statements that throw, standing in for the permission-gated
   *   catalogs on managed providers.
   * @param empty statements that succeed with zero rows -- the branch that must
   *   not be reported as "never reset".
   */
  function installStub(
    extVersion: string,
    { failing = [], empty = [] }: { failing?: StatsCategory[]; empty?: StatsCategory[] } = {},
  ) {
    seen = [];
    pooled = [];
    pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
      const text = typeof sql === "string" ? sql : "";
      pooled.push(text);
      switch (categorize(text)) {
        // PG18 so the PG16 last-scan gates never fire: this suite is about the
        // extversion gate and the reset envelope, not those.
        case "version":
          return Promise.resolve({ rows: [{ v: "180000" }] });
        case "extversion":
          return Promise.resolve({ rows: [{ version: extVersion }] });
        default:
          return Promise.resolve({ rows: [] });
      }
    } as unknown as typeof pg.Pool.prototype.query;

    const client = {
      async query(sql: string, params: unknown[] = []) {
        seen.push({ sql, params });
        const category = categorize(sql);
        if (failing.includes(category)) throw new Error("permission denied for view");
        return { rows: empty.includes(category) ? [] : rowsFor(sql) };
      },
      release() {
        /* no-op */
      },
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  beforeEach(async () => {
    // shutdown() clears the pool AND the process-wide cached
    // server_version_num. Without it the first test's version leaks into every
    // later one and this suite becomes order-dependent.
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  // ── The pre-1.9 degraded envelope ──────────────────────────────────────

  it("1.8: the ranking survives and the three context keys are ABSENT, not null", async () => {
    installStub("1.8");
    const res = (await pgTopQueries.handler({})) as StatsResponse;
    assert.equal(res.ok, true);
    // Losing the ranking because the CONTEXT view is missing would be a far
    // worse failure than shipping the ranking without context.
    assert.equal(res.data.rows.length, 1);
    // Asserted with `in` / Object.hasOwn rather than `== null` on purpose:
    // everywhere else in this file `stats_reset: null` MEANS "never reset /
    // start point unknown", and `dealloc: null` reads as "nothing was ever
    // evicted, the ranking is complete" -- a reassuring claim this extension
    // version has no way to support.
    for (const key of ["stats_reset", "stats_reset_age_seconds", "dealloc"]) {
      assert.equal(key in res.data, false, `${key} leaked onto the degraded envelope: ${JSON.stringify(res.data)}`);
      assert.equal(Object.hasOwn(res.data, key), false);
    }
  });

  it("1.8: pg_stat_statements_info is never NAMED -- the gate is not a try/catch", async () => {
    installStub("1.8");
    await pgTopQueries.handler({});
    // Naming a view that does not exist is SQLSTATE 42P01, which takes the
    // whole tool down rather than costing only the context. So: not "issued
    // and caught" -- not issued. Exactly one statement reaches the client.
    assert.equal(seen.length, 1, `expected only the ranking query, saw: ${seen.map((s) => categorize(s.sql))}`);
    assert.equal(categorize(seen[0]?.sql ?? ""), "ranking", "the ranking itself must still be issued");
    for (const sql of [...seen.map((s) => s.sql), ...pooled]) {
      assert.ok(!sql.includes("pg_stat_statements_info"), `the pre-1.9 path named the missing view: ${sql}`);
    }
  });

  it("1.8: the warning names the view, the running extversion and the 1.9 floor", async () => {
    installStub("1.8");
    const res = (await pgTopQueries.handler({})) as StatsResponse;
    const warnings = res.data._warnings ?? [];
    // Three absent keys with no explanation read as "the tool forgot them".
    // The warning is the only thing that says which view is missing and which
    // extension version to upgrade past, so all three facts have to be in it.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /pg_stat_statements_info/);
    assert.match(warnings[0] ?? "", /1\.8/);
    assert.match(warnings[0] ?? "", /1\.9/);
  });

  it("1.9: the same handler populates all three keys (the gate is version-driven)", async () => {
    installStub("1.9");
    const res = (await pgTopQueries.handler({})) as StatsResponse;
    // Without this the assertions above would also pass for a handler that had
    // stopped reading the info view entirely, on every version.
    assert.equal(res.data.stats_reset, "2026-08-01 00:00:00+00");
    assert.equal(res.data.stats_reset_age_seconds, 1000);
    assert.equal(res.data.dealloc, "0", 'a "0" dealloc must survive onto the envelope');
    assert.equal("_warnings" in res.data, false);
    assert.ok(
      seen.some((s) => categorize(s.sql) === "info"),
      "1.9 must actually read pg_stat_statements_info",
    );
  });

  it("1.10: the boundary is numeric, not lexical, at handler level too", async () => {
    // "1.10" < "1.9" as strings. A lexical comparison here would demote every
    // PG15+ cluster to the degraded envelope, making that branch the only one
    // anyone ever saw.
    installStub("1.10");
    const res = (await pgTopQueries.handler({})) as StatsResponse;
    assert.equal("_warnings" in res.data, false);
    assert.equal(res.data.dealloc, "0");
  });

  // ── Which arguments each handler hands withStatsReset ───────────────────

  it("pg_top_queries: a failed info probe warns and keeps the ranking", async () => {
    installStub("1.9", { failing: ["info"] });
    const res = (await pgTopQueries.handler({})) as StatsResponse;
    // The probe is context, the ranking is the answer: only the ranking
    // failing is a tool failure. Handler-level counterpart of the
    // withStatsReset unit test -- it also proves the handler hands the INFO
    // result, not the ranking result, to the helper.
    assert.equal(res.ok, true);
    assert.equal(res.data.rows.length, 1);
    assert.equal(res.data.stats_reset, null);
    assert.match((res.data._warnings ?? []).join("\n"), /stats_reset lookup failed/);
    assert.match((res.data._warnings ?? []).join("\n"), /permission denied/, "the original pg error must survive");
    // A failed probe must not fabricate an eviction count.
    assert.equal("dealloc" in res.data, false);
  });

  it("pg_top_queries: an empty info view names THAT view, not pg_stat_database", async () => {
    installStub("1.9", { empty: ["info"] });
    const res = (await pgTopQueries.handler({})) as StatsResponse;
    const warning = (res.data._warnings ?? [])[0] ?? "";
    // The positional-argument regression: withStatsReset DEFAULTS sourceView to
    // pg_stat_database, so a handler that dropped its third argument still
    // warns -- about a catalog pg_top_queries never reads, sending whoever
    // debugs it to the wrong place. Only this assertion catches that.
    assert.match(warning, /pg_stat_statements_info/);
    assert.doesNotMatch(warning, /pg_stat_database/);
  });

  it("pg_unused_indexes: an empty pg_stat_database keeps the default view name", async () => {
    installStub("1.9", { empty: ["reset"] });
    const res = (await pgUnusedIndexes.handler({})) as StatsResponse;
    const warning = (res.data._warnings ?? [])[0] ?? "";
    // The mirror of the case above: the table/index tools must not inherit
    // pg_top_queries' source view, and must not grow a dealloc key from a
    // catalog that has no eviction concept.
    assert.match(warning, /pg_stat_database/);
    assert.doesNotMatch(warning, /pg_stat_statements_info/);
    assert.equal("dealloc" in res.data, false);
  });

  it("pg_seq_scan_tables: a failed reset probe warns and keeps the rows", async () => {
    installStub("1.9", { failing: ["reset"] });
    const res = (await pgSeqScanTables.handler({})) as StatsResponse;
    assert.equal(res.ok, true);
    assert.equal(res.data.rows.length, 1, "the reset point is context; the rows are the answer");
    assert.equal(res.data.stats_reset, null);
    assert.equal(res.data.stats_reset_age_seconds, null);
    assert.match((res.data._warnings ?? []).join("\n"), /stats_reset lookup failed/);
  });
});
