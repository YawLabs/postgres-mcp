import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { schemaTools } from "../tools/schemas.js";
import { FIXTURE_SCHEMA, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const listSchemas = schemaTools.find((t) => t.name === "pg_list_schemas")!;
const listTables = schemaTools.find((t) => t.name === "pg_list_tables")!;
const describeTable = schemaTools.find((t) => t.name === "pg_describe_table")!;
const listViews = schemaTools.find((t) => t.name === "pg_list_views")!;
const listFunctions = schemaTools.find((t) => t.name === "pg_list_functions")!;
const listExtensions = schemaTools.find((t) => t.name === "pg_list_extensions")!;
const searchColumns = schemaTools.find((t) => t.name === "pg_search_columns")!;

// One setup/teardown for the whole file — every describe below shares the
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
      // Includes plain tables, the partition parent (relkind='p'), and the
      // partition child (which is also relkind='r'). Order alphabetical.
      assert.deepEqual(names, ["Odd Table", "events", "events_2026", "posts", "products", "users"]);
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

    it("paginates with limit and offset", async () => {
      const allRes = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: false,
        limit: 500,
        offset: 0,
      })) as { ok: boolean; data?: { name: string }[] };
      const allNames = (allRes.data ?? []).map((r) => r.name).sort();

      const page1 = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: false,
        limit: 2,
        offset: 0,
      })) as { ok: boolean; data?: { name: string }[] };
      const page2 = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: false,
        limit: 2,
        offset: 2,
      })) as { ok: boolean; data?: { name: string }[] };
      const page3 = (await listTables.handler({
        schema: FIXTURE_SCHEMA,
        includeViews: false,
        limit: 2,
        offset: 4,
      })) as { ok: boolean; data?: { name: string }[] };

      assert.equal(page1.data?.length, 2);
      assert.equal(page2.data?.length, 2);
      assert.equal(page3.data?.length, allNames.length - 4);
      const combined = [...(page1.data ?? []), ...(page2.data ?? []), ...(page3.data ?? [])].map((r) => r.name);
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

    it("returns 'not found' for missing table", async () => {
      const res = (await describeTable.handler({ schema: FIXTURE_SCHEMA, table: "does_not_exist" })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /not found/i);
    });
  });

  describe("pg_list_views", () => {
    it("returns the user_post_counts view with a definition", async () => {
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
      // Should find at least the fixture — may find more if other test schemas linger.
      assert.ok((res.data ?? []).some((r) => r.schema === FIXTURE_SCHEMA));
    });
  });
});
