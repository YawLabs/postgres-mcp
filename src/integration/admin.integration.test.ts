import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adminTools } from "../tools/admin.js";
import { statsTools } from "../tools/stats.js";
import { FIXTURE_SCHEMA, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const inspectLocks = adminTools.find((t) => t.name === "pg_inspect_locks")!;
const listRoles = adminTools.find((t) => t.name === "pg_list_roles")!;
const tablePrivileges = adminTools.find((t) => t.name === "pg_table_privileges")!;
const seqScanTables = statsTools.find((t) => t.name === "pg_seq_scan_tables")!;
const unusedIndexes = statsTools.find((t) => t.name === "pg_unused_indexes")!;

describe("admin + stats tools (integration)", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  it("pg_inspect_locks returns an array (usually empty under no contention)", async () => {
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

  it("pg_list_roles returns the current role and excludes pg_* by default", async () => {
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

  it("pg_list_roles with includeSystem includes pg_* built-in roles", async () => {
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

  it("pg_table_privileges returns privileges for a specific table", async () => {
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

  it("pg_table_privileges without table arg lists all schema tables", async () => {
    const res = (await tablePrivileges.handler({ schema: FIXTURE_SCHEMA })) as {
      ok: boolean;
      data?: { table: string }[];
    };
    assert.equal(res.ok, true);
    const tables = new Set((res.data ?? []).map((r) => r.table));
    assert.ok(tables.has("users"));
    assert.ok(tables.has("posts"));
  });

  it("pg_seq_scan_tables returns an array of table stats", async () => {
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

  it("pg_unused_indexes returns an array", async () => {
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
