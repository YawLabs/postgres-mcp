// SERIALIZATION: these integration files MUST run serialized in one process
// (--test-concurrency=1 via scripts/run-tests.mjs). The pg pool, typeNameCache,
// and process.env are process-global singletons; running these files (or their
// tests) concurrently would let one test's pool swap / env mutation / cache
// reset race another's in-flight query. Do not parallelize without first
// removing those shared singletons.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { schemaTools } from "../tools/schemas.js";
import { fdwFixtureAvailable, FIXTURE_SCHEMA, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const listSchemas = schemaTools.find((t) => t.name === "pg_list_schemas")!;
const listTables = schemaTools.find((t) => t.name === "pg_list_tables")!;
const describeTable = schemaTools.find((t) => t.name === "pg_describe_table")!;
const listViews = schemaTools.find((t) => t.name === "pg_list_views")!;
const listFunctions = schemaTools.find((t) => t.name === "pg_list_functions")!;
const listExtensions = schemaTools.find((t) => t.name === "pg_list_extensions")!;
const searchColumns = schemaTools.find((t) => t.name === "pg_search_columns")!;

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
      })) as { ok: boolean; data?: { name: string; type: string }[] };
      assert.equal(res.ok, true);
      const names = (res.data ?? []).map((r) => r.name).sort();
      // Includes plain tables, partition parents (relkind='p'), partition child
      // (relkind='r'), and foreign table (relkind='f') when postgres_fdw is available.
      const expectedNames = [
        "Odd Table",
        "events",
        "events_2026",
        "no_pk_partitioned",
        "no_pk_table",
        "posts",
        "products",
        "users",
        ...(fdwFixtureAvailable() ? ["remote_users"] : []),
      ].sort();
      assert.deepEqual(names, expectedNames);
      const events = (res.data ?? []).find((r) => r.name === "events");
      assert.equal(events?.type, "partitioned_table");
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
