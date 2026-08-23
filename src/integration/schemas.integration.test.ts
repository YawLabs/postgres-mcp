// SERIALIZATION: these integration files MUST run serialized in one process
// (--test-concurrency=1 via scripts/run-tests.mjs). The pg pool, typeNameCache,
// and process.env are process-global singletons; running these files (or their
// tests) concurrently would let one test's pool swap / env mutation / cache
// reset race another's in-flight query. Do not parallelize without first
// removing those shared singletons.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PG18, runInternal } from "../api.js";
import { schemaTools } from "../tools/schemas.js";
import {
  FIXTURE_GENERATED_STORED_COLUMN,
  FIXTURE_GENERATED_TABLE,
  FIXTURE_IDENTITY_ALWAYS_COLUMN,
  FIXTURE_IDENTITY_BY_DEFAULT_COLUMN,
  FIXTURE_PG18_NOT_ENFORCED_CHECK,
  FIXTURE_PG18_NOT_ENFORCED_FK,
  FIXTURE_PG18_NOT_ENFORCED_TABLE,
  FIXTURE_PG18_NOT_NULL_COLUMN,
  FIXTURE_PG18_NOT_NULL_TABLE,
  FIXTURE_PG18_TEMPORAL_PERIOD_COLUMN,
  FIXTURE_PG18_TEMPORAL_PK,
  FIXTURE_PG18_TEMPORAL_TABLE,
  FIXTURE_PG18_VIRTUAL_COLUMN,
  FIXTURE_PG18_VIRTUAL_TABLE,
  FIXTURE_PLAIN_DEFAULT_COLUMN,
  FIXTURE_SCHEMA,
  fdwFixtureAvailable,
  integrationEnabled,
  pg18NotEnforcedAvailable,
  pg18NotNullNotValidAvailable,
  pg18TemporalKeyAvailable,
  pg18VirtualColumnAvailable,
  setupFixtures,
  teardownFixtures,
} from "./fixtures.js";

const listSchemas = schemaTools.find((t) => t.name === "pg_list_schemas")!;
const listTables = schemaTools.find((t) => t.name === "pg_list_tables")!;
const describeTable = schemaTools.find((t) => t.name === "pg_describe_table")!;
const listViews = schemaTools.find((t) => t.name === "pg_list_views")!;
const listFunctions = schemaTools.find((t) => t.name === "pg_list_functions")!;
const listExtensions = schemaTools.find((t) => t.name === "pg_list_extensions")!;
const searchColumns = schemaTools.find((t) => t.name === "pg_search_columns")!;

// Server-version probe for the PG18-gated `not_null_validated` / `enforced` /
// `has_period` fields. Asks the server directly rather than importing the
// handler's own getServerVersionNum(), so a regression in the probe the handler
// gates on cannot also move this file's expectation. Returns 0 when the probe
// itself fails; callers treat that as "cannot tell" and skip, matching this
// file's habit of skipping rather than failing when a capability is absent.
async function probeServerVersionNum(): Promise<number> {
  const res = await runInternal<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  if (!res.ok || !res.data?.length) return 0;
  const parsed = Number.parseInt(res.data[0].v, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// pg_describe_table's row shapes, shared by the generated / identity /
// constraint-metadata cases below. The PG18-only keys are declared OPTIONAL on
// purpose: their ABSENCE below 18 is itself under test, so the type has to
// permit a row that simply lacks the key -- which is the distinction the `in`
// assertions draw, and which a `boolean | null` typing would erase.
type DescribedColumn = {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
  generation_expression: string | null;
  generated: string | null;
  identity: string | null;
  not_null_validated?: boolean;
};

// validated / enforced / has_period come from ONE SQL fragment spliced into
// three separate queries, and the two aggregated ones must also carry every
// column through their GROUP BY. The three row types below repeat the trio
// rather than sharing a base so a regression that reaches only one of the
// queries stays visible per row shape.
type DescribedConstraint = {
  name: string;
  type: string;
  definition: string;
  validated: boolean;
  enforced?: boolean;
  has_period?: boolean;
};

type DescribedForeignKey = {
  constraint_name: string;
  columns: string[];
  foreign_table: string;
  foreign_schema: string;
  foreign_columns: string[];
  validated: boolean;
  enforced?: boolean;
  has_period?: boolean;
};

type DescribedReferencedBy = {
  constraint_name: string;
  schema: string;
  table: string;
  columns: string[];
  referenced_columns: string[];
  validated: boolean;
  enforced?: boolean;
  has_period?: boolean;
};

type DescribedTable = {
  kind: string;
  columns: DescribedColumn[];
  primary_key: string[];
  foreign_keys: DescribedForeignKey[];
  referenced_by: DescribedReferencedBy[];
  constraints: DescribedConstraint[];
  indexes: { name: string; definition: string; is_unique: boolean; is_primary: boolean }[];
  _warnings?: string[];
};

/** Describe a fixture-schema relation, failing loudly instead of yielding undefined. */
async function describeFixtureTable(table: string): Promise<DescribedTable> {
  const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table })) as {
    ok: boolean;
    data?: DescribedTable;
    error?: string;
  };
  assert.equal(res.ok, true, `describe ${table}: expected ok, got error: ${res.error}`);
  assert.ok(res.data, `describe ${table}: expected data`);
  return res.data;
}

/** Pick one column out of a describe result, reporting the available names on a miss. */
function column(data: DescribedTable, name: string): DescribedColumn {
  const col = data.columns.find((c) => c.name === name);
  assert.ok(col, `expected column ${name}, got ${JSON.stringify(data.columns.map((c) => c.name))}`);
  return col;
}

// One setup/teardown for the whole file - every describe below shares the
// same fixture schema, so running DROP/CREATE per-describe is wasted work.
describe("integration: schema tools", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  describe("pg_list_schemas", () => {
    it("returns the fixture schema and excludes pg_catalog", async () => {
      const res = (await listSchemas.handler()) as { ok: boolean; data?: { schema_name: string }[] };
      assert.equal(res.ok, true);
      const names = (res.data ?? []).map((r) => r.schema_name);
      assert.ok(names.includes(FIXTURE_SCHEMA), `expected ${FIXTURE_SCHEMA} in ${JSON.stringify(names)}`);
      assert.ok(!names.includes("pg_catalog"));
      assert.ok(!names.includes("information_schema"));
    });
  });

  describe("pg_list_tables", () => {
    it("returns the fixture tables, partition parent, and the quoted 'Odd Table'", async () => {
      const res = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: false,
        limit: 500,
        offset: 0,
      })) as { ok: boolean; data?: { name: string; type: string; estimated_rows: unknown }[] };
      assert.equal(res.ok, true);
      const names = (res.data ?? []).map((r) => r.name).sort();
      // Includes plain tables, partition parents (relkind='p'), partition child
      // (relkind='r'), and foreign table (relkind='f') when postgres_fdw is available.
      const expectedNames = [
        "Odd Table",
        "covering_pk",
        "events",
        "events_2026",
        "no_pk_partitioned",
        "no_pk_table",
        "posts",
        "products",
        "users",
        ...(fdwFixtureAvailable() ? ["remote_users"] : []),
      ].sort();
      // CONTAINMENT, not deep-equality. This asserted an exact set until the
      // fixture grew the generated-column and wraparound tables, at which point
      // it failed on all three majors -- reporting a schema-listing regression
      // that did not exist. The relations this case actually cares about are
      // the relkind variants enumerated above; a fixture gaining an unrelated
      // table is not a pg_list_tables defect, and pinning the exact set makes
      // every future fixture addition break a test in a different file.
      //
      // The negative half still matters, so it is asserted directly below
      // rather than being dropped along with the equality: nothing outside this
      // schema, and no system relation, may appear.
      for (const expected of expectedNames) {
        assert.ok(names.includes(expected), `expected ${expected} in pg_list_tables, got ${JSON.stringify(names)}`);
      }
      assert.ok(
        !names.some((n) => n.startsWith("pg_") || n.startsWith("sql_")),
        `pg_list_tables leaked a system relation: ${JSON.stringify(names.filter((n) => n.startsWith("pg_")))}`,
      );
      const events = (res.data ?? []).find((r) => r.name === "events");
      assert.equal(events?.type, "partitioned_table");
      // estimated_rows must be a JS number (or null), not a string. pg_class.reltuples is
      // float4 and was previously cast to ::bigint, which node-pg parses as a
      // string (int8 OID 20). The fix casts via NULLIF(round(reltuples), -1)::float8:
      // - node-pg returns a proper number (not string)
      // - the PG 14+ sentinel -1 (never ANALYZEd) surfaces as null
      // - fractional estimates are rounded to integral row counts
      // Regression guard: a revert would silently produce "0" or "-1"
      // instead of a number/null in the JSON response.
      const users = (res.data ?? []).find((r) => r.name === "users");
      const er = users?.estimated_rows;
      assert.ok(
        er === null || typeof er === "number",
        `estimated_rows must be a number or null, got ${JSON.stringify(er)}`,
      );
      if (typeof er === "number") {
        assert.equal(er, Math.round(er), `estimated_rows must be integral, got ${er}`);
      }
    });

    it("with includeViews returns the view too", async () => {
      const res = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: true,
        limit: 500,
        offset: 0,
      })) as { ok: boolean; data?: { name: string; type: string }[] };
      assert.equal(res.ok, true);
      const view = (res.data ?? []).find((r) => r.name === "user_post_counts");
      assert.ok(view, "expected user_post_counts view");
      assert.equal(view.type, "view");
    });

    // Locks the 'm' branch of the `('r','v','m','f','p')` kinds filter when
    // includeViews=true. A regression that drops 'm' would silently hide
    // materialized views from this tool with no signal in the existing
    // includeViews test (which only asserts the plain view).
    it("with includeViews includes the materialized view with type='materialized_view'", async () => {
      const res = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: true,
        limit: 500,
        offset: 0,
      })) as { ok: boolean; data?: { name: string; type: string }[] };
      assert.equal(res.ok, true);
      const mv = (res.data ?? []).find((r) => r.name === "user_post_counts_mv");
      assert.ok(mv, "expected user_post_counts_mv when includeViews=true");
      assert.equal(mv.type, "materialized_view");
    });

    // Assumes a STABLE table set across the N+1 sequential handler calls below
    // (the allNames snapshot, then one call per page). Safe under serial
    // in-process execution (see the file-level SERIALIZATION note): nothing
    // concurrently creates/drops tables in FIXTURE_SCHEMA between calls. If this
    // file is ever parallelized, the per-page `got.length === expectedSize`
    // assertions become racy -- replace them with a set assertion that the
    // union of all pages equals allNames, which tolerates ordering/size drift.
    it("paginates with limit and offset", async () => {
      const allRes = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: false,
        limit: 500,
        offset: 0,
      })) as { ok: boolean; data?: { name: string }[] };
      const allNames = (allRes.data ?? []).map((r) => r.name).sort();

      // Walk the table list two-at-a-time and verify each page is the
      // expected size (full pages of 2, then a final partial page with
      // whatever's left). Resilient to fixture growth.
      const pageSize = 2;
      const pages: { name: string }[][] = [];
      for (let offset = 0; offset < allNames.length; offset += pageSize) {
        const page = (await listTables.handler({
          schema: FIXTURE_SCHEMA,
          includeViews: false,
          limit: pageSize,
          offset,
        })) as { ok: boolean; data?: { name: string }[] };
        const got = page.data ?? [];
        const expectedSize = Math.min(pageSize, allNames.length - offset);
        assert.equal(got.length, expectedSize, `page at offset=${offset} should have ${expectedSize} rows`);
        pages.push(got);
      }
      const combined = pages.flat().map((r) => r.name);
      assert.deepEqual(combined.sort(), allNames);
    });
  });

  describe("pg_describe_table", () => {
    it("returns kind, columns, PK, FKs, and indexes for posts", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "posts" })) as {
        ok: boolean;
        data?: {
          kind: string;
          columns: { name: string; type: string; nullable: boolean }[];
          primary_key: string[];
          foreign_keys: { columns: string[]; foreign_table: string; foreign_columns: string[] }[];
          indexes: { name: string; is_primary: boolean }[];
        };
      };
      assert.equal(res.ok, true);
      assert.equal(res.data?.kind, "table");
      const colNames = res.data?.columns.map((c) => c.name).sort();
      assert.deepEqual(colNames, ["body", "id", "title", "user_id"]);
      assert.deepEqual(res.data?.primary_key, ["id"]);
      assert.equal(res.data?.foreign_keys.length, 1);
      assert.equal(res.data?.foreign_keys[0].foreign_table, "users");
      assert.deepEqual(res.data?.foreign_keys[0].columns, ["user_id"]);
      assert.ok((res.data?.indexes ?? []).some((i) => i.is_primary));
      assert.ok((res.data?.indexes ?? []).some((i) => i.name === "posts_user_id_idx"));
    });

    it("reports kind=view for a view", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "user_post_counts" })) as {
        ok: boolean;
        data?: { kind: string; primary_key: string[]; foreign_keys: unknown[] };
      };
      assert.equal(res.ok, true);
      assert.equal(res.data?.kind, "view");
      assert.deepEqual(res.data?.primary_key, []);
      assert.deepEqual(res.data?.foreign_keys, []);
    });

    it("returns CHECK and UNIQUE constraints in `constraints`", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "products" })) as {
        ok: boolean;
        data?: { constraints: { name: string; type: string; definition: string }[] };
      };
      assert.equal(res.ok, true);
      const types = (res.data?.constraints ?? []).map((c) => c.type);
      assert.ok(types.includes("check"), `expected CHECK constraint, got types=${JSON.stringify(types)}`);
      assert.ok(types.includes("unique"), `expected UNIQUE constraint, got types=${JSON.stringify(types)}`);
      const check = res.data?.constraints.find((c) => c.type === "check");
      assert.match(check?.definition ?? "", /price > 0/i);
    });

    it("lists incoming FKs in `referenced_by` (users is referenced by posts)", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "users" })) as {
        ok: boolean;
        data?: { referenced_by: { table: string; columns: string[]; referenced_columns: string[] }[] };
      };
      assert.equal(res.ok, true);
      const incoming = res.data?.referenced_by ?? [];
      const fromPosts = incoming.find((r) => r.table === "posts");
      assert.ok(fromPosts, `expected posts in referenced_by, got ${JSON.stringify(incoming)}`);
      assert.deepEqual(fromPosts.columns, ["user_id"]);
      assert.deepEqual(fromPosts.referenced_columns, ["id"]);
    });

    it("returns partitions on a partitioned_table parent", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "events" })) as {
        ok: boolean;
        data?: { kind: string; partitions?: { schema: string; table: string; bound: string }[] };
      };
      assert.equal(res.ok, true);
      assert.equal(res.data?.kind, "partitioned_table");
      const children = res.data?.partitions ?? [];
      assert.ok(
        children.some((c) => c.table === "events_2026"),
        `expected events_2026 in partitions, got ${JSON.stringify(children)}`,
      );
    });

    it("returns partition_of on a partition child", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "events_2026" })) as {
        ok: boolean;
        data?: { partition_of?: { schema: string; table: string } };
      };
      assert.equal(res.ok, true);
      assert.equal(res.data?.partition_of?.table, "events");
      assert.equal(res.data?.partition_of?.schema, FIXTURE_SCHEMA);
    });

    it("handles quoted identifiers like 'Odd Table'", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "Odd Table" })) as {
        ok: boolean;
        data?: { columns: { name: string }[] };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const names = (res.data?.columns ?? []).map((c) => c.name).sort();
      assert.deepEqual(names, ["id", "weird-col"]);
    });

    it("reports kind=foreign_table for a foreign table (skipped without postgres_fdw)", async () => {
      if (!fdwFixtureAvailable()) return;
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "remote_users" })) as {
        ok: boolean;
        data?: { kind: string; columns: { name: string }[] };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.equal(res.data?.kind, "foreign_table");
      // Columns should still be present even for foreign tables.
      const colNames = (res.data?.columns ?? []).map((c) => c.name).sort();
      assert.deepEqual(colNames, ["email", "id"]);
    });

    // PRIMARY KEY (id) INCLUDE (label): the covering column sits in
    // pg_index.indkey next to the key column, so a query matching on the whole
    // vector reports it as part of the PK. It is not -- indnkeyatts bounds the
    // key columns. A regression here hands an agent a wrong row identity: it
    // would build `ON CONFLICT (id, label)`, which postgres rejects since no
    // unique constraint spans those columns.
    it("excludes INCLUDE (covering) columns from primary_key", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "covering_pk" })) as {
        ok: boolean;
        data?: { primary_key: string[]; columns: { name: string }[]; indexes: { name: string }[] };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.deepEqual(
        res.data?.primary_key,
        ["id"],
        `INCLUDE column 'label' must not appear in primary_key, got ${JSON.stringify(res.data?.primary_key)}`,
      );
      // The covering column is still a real column and the index is still listed --
      // only the PK membership claim changed.
      const colNames = (res.data?.columns ?? []).map((c) => c.name).sort();
      assert.deepEqual(colNames, ["id", "label", "note"]);
      assert.ok(
        (res.data?.indexes ?? []).some((i) => i.name === "covering_pk_pkey"),
        `expected covering_pk_pkey in indexes, got ${JSON.stringify(res.data?.indexes)}`,
      );
    });

    // Composite-PK ordering guard. The rewrite swapped array_position(indkey,
    // attnum) for unnest WITH ORDINALITY; both must yield declared key order,
    // and `events` is the only multi-column PK in the fixture.
    it("returns composite primary key columns in declared order", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "events" })) as {
        ok: boolean;
        data?: { primary_key: string[] };
      };
      assert.equal(res.ok, true);
      assert.deepEqual(res.data?.primary_key, ["id", "occurred_at"]);
    });

    it("returns 'not found' for missing table", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "does_not_exist" })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /not found/i);
    });

    // The `kind` field is what tells an agent "this is a matview, REFRESH
    // not INSERT". The plain-view branch is covered above; this pins the
    // 'm' branch of the relkind CASE so a regression that mislabels matviews
    // as plain views or plain tables can't slip through.
    it("reports kind=materialized_view for a materialized view", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "user_post_counts_mv" })) as {
        ok: boolean;
        data?: { kind: string; columns: { name: string }[] };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.equal(res.data?.kind, "materialized_view");
      // Sanity check: the matview's projected columns come through.
      const colNames = (res.data?.columns ?? []).map((c) => c.name).sort();
      assert.deepEqual(colNames, ["email", "id", "post_count"]);
    });

    // A generated column's expression used to surface as `default_value`.
    // Reported there it reads as "optional, has a default", so an agent puts
    // the column in its INSERT list and postgres rejects the whole statement.
    // Routing the pg_attrdef row on attgenerated is what keeps the two apart --
    // asserting only `generated` would still pass with the expression parked in
    // the wrong field, which is exactly the shape of the bug.
    it("reports a STORED generated column's expression in generation_expression, not default_value", async () => {
      const data = await describeFixtureTable(FIXTURE_GENERATED_TABLE);
      const area = column(data, FIXTURE_GENERATED_STORED_COLUMN);
      assert.equal(area.generated, "stored");
      assert.match(area.generation_expression ?? "", /width/);
      assert.match(area.generation_expression ?? "", /height/);
      assert.equal(
        area.default_value,
        null,
        `a generated column must not report a default_value, got ${JSON.stringify(area.default_value)}`,
      );
      assert.equal(area.identity, null);
    });

    // Control for the `default_value` CASE. Both of its arms read the same
    // pg_attrdef row and differ only on attgenerated, so an inverted or widened
    // test nulls out every ordinary default across the whole tool while the
    // generated column above still looks correct. Without this case that
    // regression ships green.
    it("keeps an ordinary DEFAULT in default_value with generation_expression null", async () => {
      const data = await describeFixtureTable(FIXTURE_GENERATED_TABLE);
      const label = column(data, FIXTURE_PLAIN_DEFAULT_COLUMN);
      assert.match(
        label.default_value ?? "",
        /unlabeled/,
        `an ordinary DEFAULT must survive in default_value, got ${JSON.stringify(label.default_value)}`,
      );
      assert.equal(label.generation_expression, null);
      assert.equal(label.generated, null);
    });

    // Identity columns have no pg_attrdef row at all, so without attidentity
    // they read as an ordinary NOT NULL column with no default -- and an agent
    // dutifully supplies a value into GENERATED ALWAYS AS IDENTITY, which
    // postgres refuses. The null default_value is asserted alongside because it
    // is what makes the `identity` flag load-bearing rather than redundant:
    // null-and-not-nullable is the exact signal that misleads without it.
    it("reports identity always / by_default, and no default_value, for identity columns", async () => {
      const data = await describeFixtureTable(FIXTURE_GENERATED_TABLE);
      const always = column(data, FIXTURE_IDENTITY_ALWAYS_COLUMN);
      assert.equal(always.identity, "always");
      assert.equal(always.default_value, null, "an identity column has no pg_attrdef row to report");
      assert.equal(always.generated, null);
      assert.equal(always.generation_expression, null);

      const byDefault = column(data, FIXTURE_IDENTITY_BY_DEFAULT_COLUMN);
      assert.equal(byDefault.identity, "by_default");
      assert.equal(byDefault.default_value, null, "an identity column has no pg_attrdef row to report");
      assert.equal(byDefault.generated, null);
    });

    // Negative control for both CASEs. attgenerated and attidentity are "char"
    // and use '' -- never NULL -- for "not set", so a regression that tested
    // against NULL would tag every ordinary column as generated or identity and
    // an agent would stop writing to columns it must write to. `width` is the
    // plain column of the generated fixture, so it rides the same fetch as the
    // positive cases above.
    it("reports generated: null and identity: null for an ordinary column", async () => {
      const data = await describeFixtureTable(FIXTURE_GENERATED_TABLE);
      const width = column(data, "width");
      assert.equal(width.generated, null);
      assert.equal(width.identity, null);
      assert.equal(width.generation_expression, null);
      assert.equal(width.default_value, null);
    });

    // `validated` is selected unconditionally -- unlike enforced / has_period it
    // is not version-gated -- so a missing key on any supported major means the
    // shared constraint-metadata fragment stopped reaching the constraints
    // query entirely, and every NOT VALID CHECK starts reading as a live
    // guarantee.
    it("reports validated on constraints for every supported version", async () => {
      const data = await describeFixtureTable("products");
      assert.ok(data.constraints.length > 0, "products should expose CHECK + UNIQUE constraints");
      for (const con of data.constraints) {
        const keys = Object.keys(con).join(", ");
        assert.ok("validated" in con, `${con.name}: validated key missing, got keys: ${keys}`);
        // Every products constraint is declared inline with the table, so all
        // of them are validated. A false here means the flag is being read from
        // the wrong catalog column rather than merely being absent.
        assert.equal(con.validated, true, `${con.name}: an inline constraint must report validated: true`);
      }
    });

    // The metadata fragment is spliced into the two aggregated FK queries too,
    // and those must carry every added column through their GROUP BY -- omit
    // one and postgres errors at plan time, which this handler converts into an
    // EMPTY list plus a `_warnings` entry rather than a visible failure. So the
    // assertion has to be "the row is here AND it carries validated": an empty
    // foreign_keys alone is indistinguishable from a table with no FKs.
    it("carries constraint metadata on foreign_keys and referenced_by rows", async () => {
      const posts = await describeFixtureTable("posts");
      const fk = posts.foreign_keys.find((f) => f.foreign_table === "users");
      assert.ok(fk, `expected a FK to users, got ${JSON.stringify(posts.foreign_keys)}`);
      assert.ok("validated" in fk, `foreign_keys row missing validated, got keys: ${Object.keys(fk).join(", ")}`);
      assert.equal(fk.validated, true);

      const users = await describeFixtureTable("users");
      const incoming = users.referenced_by.find((r) => r.table === "posts");
      assert.ok(incoming, `expected posts in referenced_by, got ${JSON.stringify(users.referenced_by)}`);
      const keys = Object.keys(incoming).join(", ");
      assert.ok("validated" in incoming, `referenced_by row missing validated, got keys: ${keys}`);
      assert.equal(incoming.validated, true);

      // A GROUP BY omission surfaces as a warning, not as a missing key, so
      // check that channel explicitly instead of inferring from the rows.
      const warnings = users._warnings ?? [];
      assert.ok(
        !warnings.some((w) => w.startsWith("foreign_keys fetch failed") || w.startsWith("referenced_by fetch failed")),
        `an FK sub-query failed rather than returning rows: ${JSON.stringify(warnings)}`,
      );
    });

    // attgenerated = 'v' exists only on PG18+, and it is the arm of the
    // `generated` CASE that STORED coverage never reaches: a regression
    // collapsing the CASE to `attgenerated <> '' -> 'stored'` passes every
    // assertion above. A VIRTUAL column is computed on read and is just as
    // unwritable as a stored one, so mislabeling it is the same INSERT failure.
    it("reports generated: 'virtual' for a VIRTUAL generated column (skipped without the PG18 fixture)", async () => {
      if (!pg18VirtualColumnAvailable()) return;
      const data = await describeFixtureTable(FIXTURE_PG18_VIRTUAL_TABLE);
      const doubled = column(data, FIXTURE_PG18_VIRTUAL_COLUMN);
      assert.equal(doubled.generated, "virtual");
      assert.match(doubled.generation_expression ?? "", /base/);
      assert.equal(doubled.default_value, null);
    });

    // The hazard in one line: attnotnull is true, so `nullable` reads false,
    // while the fixture's pre-existing NULL row is still sitting in the table.
    // Only not_null_validated separates the two, and an agent that skips a null
    // check on the strength of `nullable: false` meets rows it believed could
    // not exist. Both controls are asserted because the sub-query COALESCEs a
    // missing constraint row to true -- an inverted bool_and would flip them.
    it("reports not_null_validated false for a NOT VALID not-null constraint (skipped without fixture)", async () => {
      if (!pg18NotNullNotValidAvailable()) return;
      const data = await describeFixtureTable(FIXTURE_PG18_NOT_NULL_TABLE);
      const maybeNull = column(data, FIXTURE_PG18_NOT_NULL_COLUMN);
      assert.equal(maybeNull.nullable, false, "attnotnull is set even while the constraint is NOT VALID");
      assert.equal(maybeNull.not_null_validated, false, "a NOT VALID not-null constraint must report false");

      // Control on the same relation: `id` takes its NOT NULL from the primary
      // key, which PG18 records as its own validated contype 'n' row.
      assert.equal(column(data, "id").not_null_validated, true);

      // Control on an unrelated table: a plain declared NOT NULL, the shape an
      // agent meets far more often than the NOT VALID one.
      const users = await describeFixtureTable("users");
      assert.equal(column(users, "email").not_null_validated, true);
    });

    // A NOT ENFORCED constraint is a referential guarantee that enforces
    // nothing: the CHECK and the FK are both listed exactly like live ones, and
    // an agent leaning on either writes rows the database never validates. The
    // FK also proves conenforced survived the aggregated queries' GROUP BY --
    // and it is checked on `referenced_by` as well, since that is a third
    // splice of the same fragment with its own GROUP BY to get wrong.
    it("reports enforced: false for NOT ENFORCED constraints (skipped without the PG18 fixture)", async () => {
      if (!pg18NotEnforcedAvailable()) return;
      const data = await describeFixtureTable(FIXTURE_PG18_NOT_ENFORCED_TABLE);
      const check = data.constraints.find((c) => c.name === FIXTURE_PG18_NOT_ENFORCED_CHECK);
      assert.ok(check, `expected ${FIXTURE_PG18_NOT_ENFORCED_CHECK}, got ${JSON.stringify(data.constraints)}`);
      assert.equal(check.enforced, false);

      const fk = data.foreign_keys.find((f) => f.constraint_name === FIXTURE_PG18_NOT_ENFORCED_FK);
      assert.ok(fk, `expected ${FIXTURE_PG18_NOT_ENFORCED_FK}, got ${JSON.stringify(data.foreign_keys)}`);
      assert.equal(fk.enforced, false);

      const users = await describeFixtureTable("users");
      const incoming = users.referenced_by.find((r) => r.constraint_name === FIXTURE_PG18_NOT_ENFORCED_FK);
      assert.ok(incoming, `expected ${FIXTURE_PG18_NOT_ENFORCED_FK} in referenced_by of users`);
      assert.equal(incoming.enforced, false);

      // Controls: enforced constraints on the same server must report true, so
      // a regression that hardcoded false (or read the wrong catalog column)
      // cannot hide behind the negative cases above.
      const products = await describeFixtureTable("products");
      for (const con of products.constraints) {
        assert.equal(con.enforced, true, `${con.name}: an ordinary constraint must report enforced: true`);
      }
      const posts = await describeFixtureTable("posts");
      const postsFk = posts.foreign_keys.find((f) => f.foreign_table === "users");
      assert.equal(postsFk?.enforced, true, "an ordinary FK must report enforced: true");
    });

    // A temporal (WITHOUT OVERLAPS) PRIMARY KEY is contype 'p' with
    // conperiod = true, and contype 'p' is served by the dedicated primary_key
    // query -- which carries none of the constraint metadata. The fragment is
    // spliced only into the constraints query ('c'/'u'/'x') and the two FK
    // queries ('f'), so `has_period: true` is not reachable through this tool
    // today and the overlap key renders exactly like an equality key. This pins
    // that behavior rather than asserting a flag the tool never emits; if the
    // constraints filter ever widens to 'p', the new claim belongs here.
    it("renders a temporal WITHOUT OVERLAPS primary key as an ordinary key (skipped without the fixture)", async () => {
      if (!pg18TemporalKeyAvailable()) return;
      const data = await describeFixtureTable(FIXTURE_PG18_TEMPORAL_TABLE);
      assert.deepEqual(data.primary_key, ["id", FIXTURE_PG18_TEMPORAL_PERIOD_COLUMN]);
      const pkIndex = data.indexes.find((i) => i.name === FIXTURE_PG18_TEMPORAL_PK);
      const names = JSON.stringify(data.indexes.map((i) => i.name));
      assert.ok(pkIndex, `expected ${FIXTURE_PG18_TEMPORAL_PK} in indexes, got ${names}`);
      assert.equal(pkIndex.is_primary, true);
      // The GiST backing is the only place the overlap semantics survive into
      // this response; a btree definition would mean WITHOUT OVERLAPS was
      // silently dropped and the fixture is no longer temporal at all.
      assert.match(pkIndex.definition, /gist/i);
      // The gap the comment above describes, pinned so it cannot shift silently.
      assert.equal(
        data.constraints.find((c) => c.name === FIXTURE_PG18_TEMPORAL_PK),
        undefined,
        "a contype 'p' constraint is not part of the constraints list",
      );
    });

    // The PG18-only fields are dropped from the SQL below 18, not selected as
    // NULL, and the difference is the whole point: `null` reads as "postgres
    // says this constraint has no period", while an absent key reads as "this
    // server cannot say". A truthiness or `=== null` check passes either way,
    // so these assertions go through `in` deliberately.
    it("omits not_null_validated / enforced / has_period below PG18 and includes them on 18+", async () => {
      const version = await probeServerVersionNum();
      if (version === 0) return; // version undeterminable -- nothing to gate on

      const data = await describeFixtureTable("products");
      assert.ok(data.constraints.length > 0, "products should expose CHECK + UNIQUE constraints");
      for (const con of data.constraints) {
        const keys = Object.keys(con).join(", ");
        if (version >= PG18) {
          assert.ok("enforced" in con, `${con.name}: enforced must be present on PG18+, got keys: ${keys}`);
          assert.ok("has_period" in con, `${con.name}: has_period must be present on PG18+, got keys: ${keys}`);
          // The false branch of has_period: an ordinary equality constraint.
          // The true branch is unreachable through this tool -- see the
          // temporal-key case above.
          assert.equal(con.has_period, false, `${con.name}: an ordinary constraint has no period`);
        } else {
          assert.ok(
            !("enforced" in con),
            `${con.name}: enforced must be ABSENT below PG18 (server_version_num=${version}), got keys: ${keys}`,
          );
          assert.ok(
            !("has_period" in con),
            `${con.name}: has_period must be ABSENT below PG18 (server_version_num=${version}), got keys: ${keys}`,
          );
        }
      }

      const price = column(data, "price");
      const priceKeys = Object.keys(price).join(", ");
      if (version >= PG18) {
        assert.ok("not_null_validated" in price, `not_null_validated must be present on PG18+, got: ${priceKeys}`);
      } else {
        assert.ok(
          !("not_null_validated" in price),
          `not_null_validated must be ABSENT below PG18 (server_version_num=${version}), got: ${priceKeys}`,
        );
      }
    });
  });

  describe("pg_list_views", () => {
    it("returns the user_post_counts view AND the materialized view when includeMaterialized=true", async () => {
      const res = (await listViews.handler({ schema: FIXTURE_SCHEMA, includeMaterialized: true })) as {
        ok: boolean;
        data?: { name: string; type: string; definition: string }[];
      };
      assert.equal(res.ok, true);
      const view = res.data?.find((v) => v.name === "user_post_counts");
      assert.ok(view);
      assert.equal(view.type, "view");
      assert.match(view.definition, /SELECT/i);
      assert.match(view.definition, /users/);
      // The materialized view should also be returned with type='materialized_view'.
      const mv = res.data?.find((v) => v.name === "user_post_counts_mv");
      assert.ok(mv, "expected user_post_counts_mv to appear when includeMaterialized=true");
      assert.equal(mv.type, "materialized_view");
      // pg_get_viewdef() goes through a slightly different code path for
      // matviews than for plain views; pin that it actually returns the SQL
      // body, not an empty string. A regression here would surface as a
      // listing with empty `definition` fields for matviews only.
      assert.ok(mv.definition.length > 0, "matview definition must not be empty");
      assert.match(mv.definition, /SELECT/i, "matview definition should look like SQL");
    });

    // Locks the false branch of the conditional `('v', 'm')` vs `('v')` SQL
    // filter. A regression that drops the filter would silently surface
    // materialized views to a caller who asked for plain views only.
    it("excludes materialized views when includeMaterialized=false", async () => {
      const res = (await listViews.handler({ schema: FIXTURE_SCHEMA, includeMaterialized: false })) as {
        ok: boolean;
        data?: { name: string; type: string }[];
      };
      assert.equal(res.ok, true);
      const names = (res.data ?? []).map((v) => v.name);
      assert.ok(names.includes("user_post_counts"), `expected plain view, got ${JSON.stringify(names)}`);
      assert.ok(
        !names.includes("user_post_counts_mv"),
        `materialized view must NOT appear when includeMaterialized=false, got ${JSON.stringify(names)}`,
      );
      // Every returned row should be type='view', never 'materialized_view'.
      const types = new Set((res.data ?? []).map((v) => v.type));
      assert.ok(!types.has("materialized_view"));
    });
  });

  describe("pg_list_functions", () => {
    it("returns the user_count function", async () => {
      const res = (await listFunctions.handler({ schema: FIXTURE_SCHEMA })) as {
        ok: boolean;
        data?: { name: string; return_type: string; kind: string; language: string }[];
      };
      assert.equal(res.ok, true);
      const fn = res.data?.find((f) => f.name === "user_count");
      assert.ok(fn);
      assert.equal(fn.kind, "function");
      assert.equal(fn.language, "sql");
      assert.match(fn.return_type, /bigint/i);
    });
  });

  describe("pg_list_extensions", () => {
    it("includes plpgsql (always present)", async () => {
      const res = (await listExtensions.handler()) as {
        ok: boolean;
        data?: { name: string; version: string }[];
      };
      assert.equal(res.ok, true);
      assert.ok((res.data ?? []).some((e) => e.name === "plpgsql"));
    });
  });

  describe("pg_search_columns", () => {
    it("finds 'user_id' in posts table", async () => {
      const res = (await searchColumns.handler({
        pattern: "user_id",
        schema: FIXTURE_SCHEMA,
        limit: 100,
      })) as { ok: boolean; data?: { schema: string; table: string; column: string }[] };
      assert.equal(res.ok, true);
      const rows = res.data ?? [];
      assert.ok(rows.some((r) => r.table === "posts" && r.column === "user_id"));
    });

    it("with wildcard pattern finds 'email'-like columns", async () => {
      const res = (await searchColumns.handler({
        pattern: "%email%",
        schema: FIXTURE_SCHEMA,
        limit: 100,
      })) as { ok: boolean; data?: { column: string }[] };
      assert.equal(res.ok, true);
      const cols = (res.data ?? []).map((r) => r.column);
      assert.ok(cols.includes("email"));
    });

    it("without a schema arg searches across user schemas", async () => {
      const res = (await searchColumns.handler({ pattern: "user_id", limit: 100 })) as {
        ok: boolean;
        data?: { schema: string }[];
      };
      assert.equal(res.ok, true);
      // Should find at least the fixture - may find more if other test schemas linger.
      assert.ok((res.data ?? []).some((r) => r.schema === FIXTURE_SCHEMA));
    });

    // The relkind filter is `('r','p','v','m','f')` so columns on views and
    // materialized views appear in results. `post_count` is the matview /
    // view exclusive column in the fixture (no fixture table exposes it),
    // so a regression that drops 'v' or 'm' from the filter returns zero
    // matches here.
    it("matches columns on views and materialized views, not just tables", async () => {
      const res = (await searchColumns.handler({
        pattern: "post_count",
        schema: FIXTURE_SCHEMA,
        limit: 100,
      })) as { ok: boolean; data?: { table: string; column: string }[] };
      assert.equal(res.ok, true);
      const tables = (res.data ?? []).map((r) => r.table);
      assert.ok(
        tables.includes("user_post_counts"),
        `expected view 'user_post_counts' in matches for 'post_count', got ${JSON.stringify(tables)}`,
      );
      assert.ok(
        tables.includes("user_post_counts_mv"),
        `expected matview 'user_post_counts_mv' in matches for 'post_count', got ${JSON.stringify(tables)}`,
      );
    });

    // The description advertises case-insensitive matching via ILIKE. A
    // regression to plain LIKE would silently miss every uppercase / mixed-
    // case query, and the tool would look like it returns no results for
    // perfectly reasonable patterns.
    it("matches case-insensitively (ILIKE, not LIKE)", async () => {
      // Fixture column is `user_id` lowercase. Upper-case pattern must match.
      const upperRes = (await searchColumns.handler({
        pattern: "USER_ID",
        schema: FIXTURE_SCHEMA,
        limit: 100,
      })) as { ok: boolean; data?: { table: string; column: string }[] };
      assert.equal(upperRes.ok, true);
      assert.ok(
        (upperRes.data ?? []).some((r) => r.table === "posts" && r.column === "user_id"),
        `case-insensitive match should find posts.user_id with pattern "USER_ID", got ${JSON.stringify(upperRes.data)}`,
      );

      // Mixed-case wildcard with `%` should also match.
      const mixedRes = (await searchColumns.handler({
        pattern: "%EMAIL%",
        schema: FIXTURE_SCHEMA,
        limit: 100,
      })) as { ok: boolean; data?: { column: string }[] };
      assert.equal(mixedRes.ok, true);
      assert.ok(
        (mixedRes.data ?? []).map((r) => r.column).includes("email"),
        `case-insensitive wildcard should match 'email', got ${JSON.stringify(mixedRes.data)}`,
      );
    });
  });
});
