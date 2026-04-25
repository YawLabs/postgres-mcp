import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adminTools } from "../tools/admin.js";
import { statsTools } from "../tools/stats.js";
import { FIXTURE_SCHEMA, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const inspectLocks = adminTools.find((t) => t.name === "pg_inspect_locks")!;
const listRoles = adminTools.find((t) => t.name === "pg_list_roles")!;
const tablePrivileges = adminTools.find((t) => t.name === "pg_table_privileges")!;
const tableBloat = adminTools.find((t) => t.name === "pg_table_bloat")!;
const advisor = adminTools.find((t) => t.name === "pg_advisor")!;
const seqScanTables = statsTools.find((t) => t.name === "pg_seq_scan_tables")!;
const unusedIndexes = statsTools.find((t) => t.name === "pg_unused_indexes")!;

// One setup/teardown for the whole file — every describe below shares the
// same fixture schema, so running DROP/CREATE per-describe is wasted work.
describe("integration: admin + stats tools", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  describe("pg_inspect_locks", () => {
    it("returns an array (usually empty under no contention)", async () => {
      const res = (await inspectLocks.handler({ limit: 50 })) as {
        ok: boolean;
        data?: unknown[];
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.ok(Array.isArray(res.data));
      // No contention expected in isolated test run, but we don't hard-assert 0
      // since a parallel test could incidentally hold a lock.
    });
  });

  describe("pg_list_roles", () => {
    it("returns the current role and excludes pg_* by default", async () => {
      const res = (await listRoles.handler({ includeSystem: false })) as {
        ok: boolean;
        data?: { name: string; can_login: boolean }[];
      };
      assert.equal(res.ok, true);
      const names = (res.data ?? []).map((r) => r.name);
      assert.ok(names.length > 0);
      assert.ok(names.includes("postgres"), `expected 'postgres' role, got ${JSON.stringify(names)}`);
      assert.ok(!names.some((n) => n.startsWith("pg_")), `expected no pg_* roles, got ${JSON.stringify(names)}`);
    });

    it("with includeSystem includes pg_* built-in roles", async () => {
      const res = (await listRoles.handler({ includeSystem: true })) as {
        ok: boolean;
        data?: { name: string }[];
      };
      assert.equal(res.ok, true);
      const names = (res.data ?? []).map((r) => r.name);
      assert.ok(
        names.some((n) => n.startsWith("pg_")),
        `expected at least one pg_* role`,
      );
    });
  });

  describe("pg_table_privileges", () => {
    it("returns privileges for a specific table", async () => {
      const res = (await tablePrivileges.handler({ schema: FIXTURE_SCHEMA, table: "users" })) as {
        ok: boolean;
        data?: { table: string; grantee: string; privilege_type: string }[];
      };
      assert.equal(res.ok, true);
      // The fixture owner (postgres) will have all privileges on the table.
      const owner = (res.data ?? []).filter((r) => r.grantee === "postgres");
      assert.ok(owner.length > 0, `expected postgres privileges on users table`);
      const privs = new Set(owner.map((r) => r.privilege_type));
      assert.ok(privs.has("SELECT"));
    });

    it("without table arg lists all schema tables", async () => {
      const res = (await tablePrivileges.handler({ schema: FIXTURE_SCHEMA })) as {
        ok: boolean;
        data?: { table: string }[];
      };
      assert.equal(res.ok, true);
      const tables = new Set((res.data ?? []).map((r) => r.table));
      assert.ok(tables.has("users"));
      assert.ok(tables.has("posts"));
    });
  });

  describe("pg_seq_scan_tables", () => {
    it("returns an array of table stats", async () => {
      // Trigger some stats by querying the users table.
      await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 0, limit: 20 });
      const res = (await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 0, limit: 20 })) as {
        ok: boolean;
        data?: { schema: string; table: string; seq_scans: string; idx_scans: string }[];
      };
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data));
      // Should find the fixture tables (minSize=0 includes everything).
      const tables = (res.data ?? []).map((r) => r.table);
      assert.ok(tables.length > 0, "expected some stats rows from fixture schema");
    });
  });

  describe("pg_table_bloat", () => {
    it("returns finite dead_ratio in [0, 1] for every row", async () => {
      const res = (await tableBloat.handler({ minDeadRatio: 0, limit: 100 })) as {
        ok: boolean;
        data?: { table: string; dead_ratio: number }[];
      };
      assert.equal(res.ok, true);
      for (const row of res.data ?? []) {
        assert.ok(Number.isFinite(row.dead_ratio), `dead_ratio must be finite for ${row.table}, got ${row.dead_ratio}`);
        assert.ok(
          row.dead_ratio >= 0 && row.dead_ratio <= 1,
          `dead_ratio must be in [0,1] for ${row.table}, got ${row.dead_ratio}`,
        );
      }
    });
  });

  describe("pg_advisor", () => {
    it("flags tables without a primary key (fixture has `no_pk_table`)", async () => {
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.5,
        rlsSchemas: ["public"],
        limit: 100,
      })) as {
        ok: boolean;
        data?: {
          sequence_exhaustion: unknown[];
          tables_without_primary_key: { schema: string; table: string }[];
          public_tables_without_rls: unknown[];
        };
      };
      assert.equal(res.ok, true);
      const noPk = res.data?.tables_without_primary_key ?? [];
      assert.ok(
        noPk.some((r) => r.schema === FIXTURE_SCHEMA && r.table === "no_pk_table"),
        `expected no_pk_table in tables_without_primary_key, got ${JSON.stringify(noPk)}`,
      );
      assert.ok(Array.isArray(res.data?.sequence_exhaustion));
      assert.ok(Array.isArray(res.data?.public_tables_without_rls));
    });

    it("threshold filters sequence_exhaustion: 0.99 hides everything in a fresh fixture", async () => {
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.99,
        rlsSchemas: ["public"],
        limit: 100,
      })) as { ok: boolean; data?: { sequence_exhaustion: unknown[] } };
      assert.equal(res.ok, true);
      // Fresh sequences in the fixture are nowhere near max_value, so a 99%
      // threshold should produce an empty list.
      assert.deepEqual(res.data?.sequence_exhaustion, []);
    });
  });

  describe("pg_unused_indexes", () => {
    it("returns an array", async () => {
      const res = (await unusedIndexes.handler({ schema: FIXTURE_SCHEMA, maxScans: 1000, limit: 50 })) as {
        ok: boolean;
        data?: { index: string; scans: string }[];
      };
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data));
      // posts_user_id_idx is a non-unique, non-primary index — should be eligible
      // to appear at some maxScans threshold.
    });
  });
});
