import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import { schemaTools } from "./schemas.js";

const pgDescribeTable = schemaTools.find((t) => t.name === "pg_describe_table")!;

// ─────────────────────────────────────────────────────────────────────────
// pg_describe_table WITHOUT a live DB.
//
// Same stubbed-connect pattern as the pg_advisor suite in
// src/tools/admin.test.ts: set DATABASE_URL so getPool() construction
// succeeds, stub pg.Pool.prototype.connect to resolve a fake client, and stub
// pg.Pool.prototype.query too -- getServerVersionNum() probes through the
// POOL, not through the shared client, so leaving it alone would send the
// probe at the real DATABASE_URL host and hang the suite.
//
// Everything here asserts on the SQL TEXT the handler emits. The version
// gating exists because naming a column the server does not have is a hard
// 42703 that fails the whole sub-query out to an empty list; a stub that
// answers happily no matter what is asked cannot reproduce that, so the
// emitted statement is the only thing worth checking.
// ─────────────────────────────────────────────────────────────────────────

type DescribeQuery =
  | "kind"
  | "columns"
  | "primaryKey"
  | "foreignKeys"
  | "indexes"
  | "constraints"
  | "referencedBy"
  | "partitionParent"
  | "partitionChildren"
  | "unknown";

/**
 * Which of the nine fanout sub-queries a SQL string is. Ordered so the
 * overlapping catalogs cannot be confused: the indexes query also selects
 * indisprimary, and both partition queries filter on relispartition.
 */
function categorize(sql: string): DescribeQuery {
  if (sql.includes("a.attgenerated")) return "columns";
  if (sql.includes("pg_get_indexdef")) return "indexes";
  if (sql.includes("pg_get_constraintdef")) return "constraints";
  if (sql.includes("i.indisprimary")) return "primaryKey";
  if (sql.includes("AS referenced_columns")) return "referencedBy";
  if (sql.includes("AS foreign_table")) return "foreignKeys";
  if (sql.includes("relpartbound")) return "partitionChildren";
  if (sql.includes("child.relispartition")) return "partitionParent";
  if (sql.includes("CASE c.relkind")) return "kind";
  return "unknown";
}

/**
 * The three queries that splice in the shared constraint-metadata fragment.
 * Two of them aggregate with array_agg; `constraints` does not, which is the
 * asymmetry the GROUP BY assertions below pin down.
 */
const CONSTRAINT_META_QUERIES = ["foreignKeys", "referencedBy", "constraints"] as const;
const AGGREGATING_QUERIES = ["foreignKeys", "referencedBy"] as const;

function rowsFor(sql: string): Record<string, unknown>[] {
  switch (categorize(sql)) {
    case "kind":
      return [{ kind: "table" }];
    case "columns":
      // Non-empty or the handler short-circuits to "Table ... not found."
      // The PG18-only column is mirrored the way the server would: present
      // only when the handler actually named it.
      return [
        {
          name: "id",
          type: "integer",
          nullable: false,
          default_value: null,
          generation_expression: null,
          generated: null,
          identity: "always",
          ordinal_position: 1,
          ...(sql.includes("not_null_validated") ? { not_null_validated: true } : {}),
        },
      ];
    case "primaryKey":
      return [{ column_name: "id" }];
    default:
      return [];
  }
}

interface DescribeResponse {
  ok: boolean;
  error?: string;
  data?: {
    schema: string;
    table: string;
    kind: string;
    columns: unknown[] | undefined;
    _warnings?: string[];
  };
}

/** The select list, i.e. everything ahead of the first FROM. */
function selectList(sql: string): string {
  const from = sql.indexOf("FROM");
  assert.ok(from >= 0, "query has no FROM clause");
  return sql.slice(0, from);
}

function groupByOf(sql: string): string | null {
  return /GROUP BY ([^\n]+)/.exec(sql)?.[1] ?? null;
}

describe("pg_describe_table version gating (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let seen: { sql: string; params: unknown[] }[] = [];

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   */
  function installStub(versionNum: number | null) {
    seen = [];
    pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
      if (versionNum === null) return Promise.reject(new Error("version probe unavailable"));
      const text = typeof sql === "string" ? sql : "";
      return Promise.resolve({ rows: text.includes("server_version_num") ? [{ v: String(versionNum) }] : [] });
    } as unknown as typeof pg.Pool.prototype.query;

    const client = {
      async query(sql: string, params: unknown[] = []) {
        seen.push({ sql, params });
        return { rows: rowsFor(sql) };
      },
      release() {
        /* no-op */
      },
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  function sqlFor(category: DescribeQuery): string {
    return seen.find((q) => categorize(q.sql) === category)?.sql ?? "";
  }

  beforeEach(async () => {
    // shutdown() clears the process-wide server_version_num cache, so each
    // case's stubbed version is actually probed instead of reusing whatever
    // the previous case (or a sibling suite in this runner) published.
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

  it("issues exactly the nine documented fanout sub-queries", async () => {
    installStub(180_000);
    const res = (await pgDescribeTable.handler({ schema: "public", table: "t" })) as DescribeResponse;
    assert.equal(res.ok, true);
    // An "unknown" here means a statement was rewritten past the column its
    // categorizer keys on, which would silently exempt it from every
    // version-gate assertion below.
    assert.deepEqual(seen.map((q) => categorize(q.sql)).sort(), [
      "columns",
      "constraints",
      "foreignKeys",
      "indexes",
      "kind",
      "partitionChildren",
      "partitionParent",
      "primaryKey",
      "referencedBy",
    ]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // conenforced / conperiod are PG18-only columns. Naming either on PG15/17
  // is a hard 42703 that kills the whole sub-query, so it reports as an empty
  // constraint list -- indistinguishable from "this table has no constraints"
  // in the response. The gate has to be on the version, and it has to hold in
  // all three queries that splice the fragment.
  // ───────────────────────────────────────────────────────────────────────

  it("PG18: all three constraint queries name conenforced and conperiod", async () => {
    installStub(180_000);
    await pgDescribeTable.handler({ table: "t" });
    for (const category of CONSTRAINT_META_QUERIES) {
      const sql = sqlFor(category);
      assert.match(sql, /con\.conenforced AS enforced/, `${category} should report enforced`);
      assert.match(sql, /con\.conperiod AS has_period/, `${category} should report has_period`);
      assert.match(sql, /con\.convalidated AS validated/, `${category} should report validated`);
    }
  });

  for (const version of [150_000, 170_000]) {
    it(`PG${version / 10_000}: conenforced and conperiod are never named anywhere`, async () => {
      installStub(version);
      const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
      assert.equal(res.ok, true);
      for (const { sql } of seen) {
        assert.doesNotMatch(sql, /conenforced|conperiod/, `${categorize(sql)} must not name a PG18-only column`);
      }
      // convalidated predates them and is always selected -- gating it out
      // alongside them would drop NOT VALID detection on every older server.
      for (const category of CONSTRAINT_META_QUERIES) {
        assert.match(sqlFor(category), /con\.convalidated AS validated/);
      }
    });
  }

  it("version probe failure falls through to the pre-18 shape", async () => {
    installStub(null);
    const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    assert.equal(res.ok, true);
    for (const { sql } of seen) {
      assert.doesNotMatch(sql, /conenforced|conperiod|not_null_validated/);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // GROUP BY. Postgres recognizes no functional dependency on a system
  // catalog's OID, so every non-aggregated column spliced into an aggregating
  // query must also reach its GROUP BY or the statement fails at plan time --
  // a failure no stubbed client can surface, since the stub never plans.
  // ───────────────────────────────────────────────────────────────────────

  for (const version of [150_000, 180_000]) {
    it(`PG${version / 10_000}: every spliced non-aggregated column reaches the GROUP BY`, async () => {
      installStub(version);
      await pgDescribeTable.handler({ table: "t" });
      for (const category of AGGREGATING_QUERIES) {
        const sql = sqlFor(category);
        assert.match(sql, /array_agg\(/, `${category} should aggregate`);
        const groupBy = groupByOf(sql);
        assert.ok(groupBy, `${category} aggregates and so needs a GROUP BY`);
        const selected = [...selectList(sql).matchAll(/con\.(\w+) AS/g)].map((m) => m[1]);
        // Guards the assertion itself: on PG18 this is conname + the three
        // metadata columns, below it conname + convalidated. An empty list
        // would make the loop below vacuously pass.
        assert.equal(selected.length, version >= 180_000 ? 4 : 2, `${category} selected ${selected.join(", ")}`);
        for (const col of selected) {
          assert.ok(groupBy.includes(`con.${col}`), `${category}: con.${col} is selected but missing from GROUP BY`);
        }
      }
    });
  }

  it("the constraints query neither aggregates nor carries the GROUP BY fragment", async () => {
    installStub(180_000);
    await pgDescribeTable.handler({ table: "t" });
    const sql = sqlFor("constraints");
    // It selects the same metadata fragment as its two aggregating siblings,
    // so the GROUP BY fragment is easy to splice in here by symmetry -- and a
    // GROUP BY over every selected column would silently collapse rows that
    // differ only in a column added later.
    assert.match(sql, /con\.conenforced AS enforced/);
    assert.doesNotMatch(sql, /array_agg\(/);
    assert.equal(groupByOf(sql), null);
  });

  // ───────────────────────────────────────────────────────────────────────
  // not_null_validated is a column-level PG18 gate, spliced into a fourth
  // query that does not carry the constraint fragment at all.
  // ───────────────────────────────────────────────────────────────────────

  it("PG18: the columns query reports not_null_validated", async () => {
    installStub(180_000);
    const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    const sql = sqlFor("columns");
    assert.match(sql, /AS not_null_validated/);
    // COALESCE to true: no matching pg_constraint row means nothing is pending
    // validation, not "unvalidated".
    assert.match(sql, /COALESCE\(bool_and\(nn\.convalidated\), true\)/);
    assert.match(sql, /nn\.contype = 'n'/);
    assert.equal((res.data?.columns?.[0] as Record<string, unknown>).not_null_validated, true);
  });

  for (const version of [150_000, 170_000]) {
    it(`PG${version / 10_000}: not_null_validated is omitted, and the field is absent rather than null`, async () => {
      installStub(version);
      const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
      assert.doesNotMatch(sqlFor("columns"), /not_null_validated/);
      // Absent, not null: a NOT NULL constraint cannot be invalid before
      // PG18, so `not_null_validated: null` would read as "we could not tell"
      // about a question that does not arise on this server.
      assert.equal("not_null_validated" in (res.data?.columns?.[0] as Record<string, unknown>), false);
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Unknown version. Degrading to the pre-18 shape is correct (the "assume
  // oldest" contract), but doing it silently is not: the caller cannot tell
  // an old server from an unreadable version.
  // ───────────────────────────────────────────────────────────────────────

  it("a version probe returning 0 warns, naming BOTH gated groups", async () => {
    installStub(null);
    const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    const warning = (res.data?._warnings ?? []).find((w) => w.includes("server version unknown")) ?? "";
    assert.notEqual(warning, "", "an unknown server version should warn");
    // A warning that names only the constraint fields reads as "your columns
    // are complete" while not_null_validated is missing from every one of
    // them.
    assert.match(warning, /enforced/);
    assert.match(warning, /has_period/);
    assert.match(warning, /not_null_validated/);
  });

  it("a known version emits no version warning", async () => {
    installStub(170_000);
    const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    assert.equal((res.data?._warnings ?? []).length, 0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Input defaults.
  // ───────────────────────────────────────────────────────────────────────

  it("re-applies the schema default for direct callers that pass no schema", async () => {
    installStub(180_000);
    await pgDescribeTable.handler({ table: "t" });
    // Direct (non-MCP) callers bypass Zod, so an un-defaulted schema would
    // bind undefined into `n.nspname = $1` -- which matches nothing and
    // reports as "Table undefined.t not found." rather than describing
    // public.t.
    assert.equal(seen.length, 9);
    for (const q of seen) {
      assert.deepEqual(q.params, ["public", "t"], `${categorize(q.sql)} should bind the re-applied default`);
    }
  });

  it("passes an explicit schema through to every sub-query", async () => {
    installStub(180_000);
    const res = (await pgDescribeTable.handler({ schema: "test_fixture", table: "t" })) as DescribeResponse;
    for (const q of seen) {
      assert.deepEqual(q.params, ["test_fixture", "t"], `${categorize(q.sql)} should bind the caller's schema`);
    }
    assert.equal(res.data?.schema, "test_fixture");
  });
});
