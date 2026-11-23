import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stubClient, stubConnect, stubPoolQuery, useStubbedPool } from "../test-helpers/pool-stub.js";
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
  let seen: { sql: string; params: unknown[] }[] = [];

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   * @param overrides per-sub-query replacements for rowsFor: rows to return
   *   instead, or an Error for the sub-query to throw.
   */
  function installStub(
    versionNum: number | null,
    overrides: Partial<Record<DescribeQuery, Record<string, unknown>[] | Error>> = {},
  ) {
    seen = [];
    stubPoolQuery(async (text) => {
      if (versionNum === null) throw new Error("version probe unavailable");
      return { rows: text.includes("server_version_num") ? [{ v: String(versionNum) }] : [] };
    });

    const client = stubClient(async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      const override = overrides[categorize(sql)];
      if (override instanceof Error) throw override;
      return { rows: override ?? rowsFor(sql) };
    });
    stubConnect(() => client);
  }

  function sqlFor(category: DescribeQuery): string {
    return seen.find((q) => categorize(q.sql) === category)?.sql ?? "";
  }

  // The shutdown() on the way in clears the process-wide server_version_num
  // cache, so each case's stubbed version is actually probed instead of
  // reusing whatever the previous case (or a sibling suite in this runner)
  // published.
  useStubbedPool();

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
  // Foreign keys and partitioning. A foreign key that references a
  // partitioned table is stored as the declared pg_constraint row plus one
  // internal clone per referenced partition, so an unfiltered contype = 'f'
  // scan reports a 500-partition reference as 501 foreign keys. The stub
  // cannot hold a catalog, so these pin the predicates; the row counts are
  // pinned against a server in schemas.integration.test.ts.
  // ───────────────────────────────────────────────────────────────────────

  for (const version of [150_000, 180_000]) {
    it(`PG${version / 10_000}: foreign_keys drops the per-partition clones of a reference to a partitioned table`, async () => {
      installStub(version);
      await pgDescribeTable.handler({ table: "t" });
      const sql = sqlFor("foreignKeys");
      // A clone's parent constraint sits on the SAME referencing table.
      assert.match(
        sql,
        /NOT EXISTS \(\s*SELECT 1 FROM pg_catalog\.pg_constraint parent\s+WHERE parent\.oid = con\.conparentid AND parent\.conrelid = con\.conrelid\s*\)/,
      );
      // Not `conparentid = 0`: a partition's own copy of its parent's foreign
      // key has a parent too (on the partitioned table) and is the real
      // constraint on that partition -- filtering it would empty the list.
      assert.doesNotMatch(sql, /con\.conparentid = 0/);
    });

    it(`PG${version / 10_000}: referenced_by lists declared constraints, reaching a partition through its ancestors`, async () => {
      installStub(version);
      await pgDescribeTable.handler({ table: "t" });
      const sql = sqlFor("referencedBy");
      assert.match(sql, /AND con\.conparentid = 0/);
      assert.match(sql, /pg_catalog\.pg_partition_ancestors\(ref\.oid\)/);
      // pg_partition_ancestors returns nothing for a relation outside any
      // partition tree, so without the relation itself in the set every
      // ordinary table would lose its whole referenced_by list.
      assert.match(sql, /SELECT ref\.oid AS relid\s+UNION\s+SELECT anc\.relid::oid/);
      assert.match(sql, /JOIN pg_catalog\.pg_constraint con ON con\.confrelid = target\.relid/);
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Existence. `CREATE TABLE t ()` is legal, as is a table whose columns were
  // all dropped, so an empty column list is not "no such table" -- the
  // pg_class row is.
  // ───────────────────────────────────────────────────────────────────────

  it("describes an existing zero-column table instead of reporting it as not found", async () => {
    installStub(180_000, { columns: [] });
    const res = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
    assert.deepEqual(res.data?.columns, []);
    assert.equal(res.data?.kind, "table");
    assert.equal(res.data?._warnings, undefined);
  });

  it("reports 'not found' when pg_class has no such relation", async () => {
    installStub(180_000, { kind: [], columns: [] });
    const res = (await pgDescribeTable.handler({ schema: "s", table: "t" })) as DescribeResponse;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Table "s"."t" not found.');
  });

  it("falls back to the column list for existence when the kind fetch itself fails", async () => {
    installStub(180_000, { kind: new Error("permission denied") });
    const described = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    assert.equal(described.ok, true);
    assert.match((described.data?._warnings ?? []).join("\n"), /kind fetch failed, reported as "table"/);

    installStub(180_000, { kind: new Error("permission denied"), columns: [] });
    const missing = (await pgDescribeTable.handler({ table: "t" })) as DescribeResponse;
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /not found/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // The description is the only thing an agent reads before calling. It used
  // to file `validated` under "PostgreSQL 18+", so an agent on PG15-17 had no
  // reason to look at the one field that flags a NOT VALID constraint there.
  // ───────────────────────────────────────────────────────────────────────

  it("the description says `validated` is reported on every version, not only on PG18+", () => {
    const description = pgDescribeTable.description;
    assert.match(description, /report `validated` on every version/);
    assert.doesNotMatch(description, /18\+ constraints also report `validated`/);
    assert.match(description, /On PostgreSQL 18\+ they also report `enforced` \/ `has_period`/);
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
