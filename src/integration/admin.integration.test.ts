import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { adminTools } from "../tools/admin.js";
import { statsTools } from "../tools/stats.js";
import {
  FIXTURE_GROUP_ROLE,
  FIXTURE_MEMBER_ROLE,
  FIXTURE_SCHEMA,
  integrationEnabled,
  setupFixtures,
  teardownFixtures,
} from "./fixtures.js";

const inspectLocks = adminTools.find((t) => t.name === "pg_inspect_locks")!;
const listRoles = adminTools.find((t) => t.name === "pg_list_roles")!;
const tablePrivileges = adminTools.find((t) => t.name === "pg_table_privileges")!;
const tableBloat = adminTools.find((t) => t.name === "pg_table_bloat")!;
const advisor = adminTools.find((t) => t.name === "pg_advisor")!;
const replicationStatus = adminTools.find((t) => t.name === "pg_replication_status")!;
const pgKill = adminTools.find((t) => t.name === "pg_kill")!;
const seqScanTables = statsTools.find((t) => t.name === "pg_seq_scan_tables")!;
const unusedIndexes = statsTools.find((t) => t.name === "pg_unused_indexes")!;

// One setup/teardown for the whole file - every describe below shares the
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

    // 0.3.1 fixed member_of from raw postgres-text-array form (`{a,b}`) to
    // a real JS string[] via the `::text[]` cast in admin.ts. Without an
    // actual membership in the cluster, member_of stays `[]` for every row
    // and the cast is never exercised -- a regression that drops the cast
    // would silently re-introduce stringly-typed arrays in tool responses.
    it("returns member_of as a real JS string[] when role memberships exist", async () => {
      const res = (await listRoles.handler({ includeSystem: false })) as {
        ok: boolean;
        data?: { name: string; member_of: string[] }[];
      };
      assert.equal(res.ok, true);
      const member = (res.data ?? []).find((r) => r.name === FIXTURE_MEMBER_ROLE);
      assert.ok(
        member,
        `expected ${FIXTURE_MEMBER_ROLE} in roles, got ${JSON.stringify((res.data ?? []).map((r) => r.name))}`,
      );
      // Shape: real array, not stringly-typed.
      assert.ok(Array.isArray(member.member_of), `member_of must be an array, got ${typeof member.member_of}`);
      assert.ok(
        member.member_of.every((m) => typeof m === "string"),
        `every member_of entry must be a string, got ${JSON.stringify(member.member_of)}`,
      );
      assert.ok(
        member.member_of.includes(FIXTURE_GROUP_ROLE),
        `expected ${FIXTURE_GROUP_ROLE} in member_of, got ${JSON.stringify(member.member_of)}`,
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
      // Partitioned-parent coverage: no_pk_partitioned has relkind='p' and
      // no PK -- must be flagged now that the query includes ('r', 'p').
      // This is the regression guard for the relkind expansion landed in
      // this change.
      assert.ok(
        noPk.some((r) => r.schema === FIXTURE_SCHEMA && r.table === "no_pk_partitioned"),
        `expected no_pk_partitioned (partitioned parent, no PK) in tables_without_primary_key, got ${JSON.stringify(noPk)}`,
      );
      // Negative: `events` is a partitioned parent WITH a composite PK; the
      // indisprimary index lives on the parent oid, so NOT EXISTS filters
      // it out. Locks down the false-positive boundary.
      assert.ok(
        !noPk.some((r) => r.schema === FIXTURE_SCHEMA && r.table === "events"),
        `events has PK (id, occurred_at); should not appear, got ${JSON.stringify(noPk)}`,
      );
      // events_2026 is a partition child of `events` (which has a PK on
      // (id, occurred_at)); the inherited PK index has indisprimary=true on
      // the child, so the no-PK query's NOT EXISTS clause must filter it out.
      // Regression guard against a future schema change that breaks this.
      assert.ok(
        !noPk.some((r) => r.schema === FIXTURE_SCHEMA && r.table === "events_2026"),
        `events_2026 inherits a PK from events; should not appear, got ${JSON.stringify(noPk)}`,
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
      // The advanced `near_full_seq` sits at 80%, below the 99% threshold,
      // so it must NOT appear here. Other fresh fixture sequences sit at 0.
      assert.deepEqual(res.data?.sequence_exhaustion, []);
    });

    // Positive coverage for sequence_exhaustion. Fixture advances
    // near_full_seq to 800/1000 = 80%; at the default 50% threshold it
    // must be flagged with the right pct_used. 0.5.2 changed the formula
    // from float8 to numeric for BIGINT precision past 2^53 -- this test
    // pins the post-fix arithmetic so a regression can't go unnoticed.
    it("flags near_full_seq at the default threshold and reports pct_used near 0.80", async () => {
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.5,
        rlsSchemas: ["public"],
        limit: 100,
      })) as {
        ok: boolean;
        data?: {
          sequence_exhaustion: {
            schema: string;
            sequence: string;
            last_value: string;
            max_value: string;
            pct_used: number;
          }[];
        };
      };
      assert.equal(res.ok, true);
      const flagged = (res.data?.sequence_exhaustion ?? []).find(
        (r) => r.schema === FIXTURE_SCHEMA && r.sequence === "near_full_seq",
      );
      assert.ok(
        flagged,
        `expected near_full_seq in sequence_exhaustion, got ${JSON.stringify(res.data?.sequence_exhaustion)}`,
      );
      assert.equal(flagged.last_value, "800");
      assert.equal(flagged.max_value, "1000");
      // pct_used is numeric(6,4) -> float8, so 800/1000 = 0.8 exactly.
      assert.ok(Math.abs(flagged.pct_used - 0.8) < 1e-6, `expected pct_used ~ 0.8, got ${flagged.pct_used}`);
    });

    // Positive coverage for public_tables_without_rls. Default rlsSchemas
    // is ['public']; we redirect to FIXTURE_SCHEMA where no fixture table
    // enables RLS. The check should flag at least the `users` and `posts`
    // tables. Locks the relkind IN ('r', 'p') + NOT c.relrowsecurity logic.
    it("flags fixture tables in the configured rlsSchemas when RLS is disabled", async () => {
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.99,
        rlsSchemas: [FIXTURE_SCHEMA],
        limit: 200,
      })) as {
        ok: boolean;
        data?: { public_tables_without_rls: { schema: string; table: string }[] };
      };
      assert.equal(res.ok, true);
      const flagged = res.data?.public_tables_without_rls ?? [];
      const tables = new Set(flagged.filter((r) => r.schema === FIXTURE_SCHEMA).map((r) => r.table));
      // At least the basic fixture tables must be present.
      for (const expected of ["users", "posts", "products"]) {
        assert.ok(
          tables.has(expected),
          `expected ${expected} in public_tables_without_rls, got ${JSON.stringify([...tables])}`,
        );
      }
      // Partitioned parent should also appear because the SQL covers
      // relkind IN ('r', 'p').
      assert.ok(
        tables.has("no_pk_partitioned") || tables.has("events"),
        `expected at least one partitioned parent (no_pk_partitioned or events) in public_tables_without_rls, got ${JSON.stringify([...tables])}`,
      );
    });
  });

  describe("pg_replication_status", () => {
    it("returns the standalone-DB shape with no slots, no replicas, and no warnings", async () => {
      // The integration cluster is a single standalone instance -- no slots,
      // no replicas, is_replica=false, wal_position non-null. The shape
      // matters because the partial-failure refactor now drives all four
      // fields and an _warnings array; this test locks the success-case
      // shape so future regressions can't quietly insert nulls or warnings.
      const res = (await replicationStatus.handler()) as {
        ok: boolean;
        data?: {
          is_replica: boolean | null;
          wal_position: string | null;
          slots: unknown[];
          replicas: unknown[];
          _warnings?: string[];
        };
      };
      assert.equal(res.ok, true);
      assert.equal(res.data?.is_replica, false);
      assert.ok(typeof res.data?.wal_position === "string" && res.data.wal_position.length > 0);
      assert.ok(Array.isArray(res.data?.slots));
      assert.ok(Array.isArray(res.data?.replicas));
      assert.equal(res.data?._warnings, undefined, "no warnings expected on a healthy standalone instance");
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
      // posts_user_id_idx is a non-unique, non-primary index - should be eligible
      // to appear at some maxScans threshold.
    });

    // Locks the `AND NOT i.indisunique AND NOT i.indisprimary` filter that
    // keeps the tool from recommending dropping a unique-constraint index
    // or a primary-key index. A regression here would be a real
    // data-integrity hazard: the user follows the advice, drops the unique
    // index, the constraint goes with it, duplicates start landing.
    it("never lists primary-key or unique-constraint indexes", async () => {
      const res = (await unusedIndexes.handler({ schema: FIXTURE_SCHEMA, maxScans: 1_000_000, limit: 500 })) as {
        ok: boolean;
        data?: { table: string; index: string }[];
      };
      assert.equal(res.ok, true);
      const indexes = (res.data ?? []).map((r) => r.index);
      // users.email is `UNIQUE` -> implicit unique index. Must not appear.
      assert.ok(
        !indexes.some((i) => i.includes("users_email")),
        `users_email unique index should not appear, got ${JSON.stringify(indexes)}`,
      );
      // products.sku has CONSTRAINT products_sku_unique -> unique index.
      assert.ok(
        !indexes.some((i) => i === "products_sku_unique"),
        `products_sku_unique must not appear, got ${JSON.stringify(indexes)}`,
      );
      // PK indexes (users_pkey, posts_pkey, ...) carry indisprimary=true.
      assert.ok(
        !indexes.some((i) => i.endsWith("_pkey")),
        `no *_pkey index should appear, got ${JSON.stringify(indexes)}`,
      );
    });
  });

  describe("pg_kill", () => {
    // Nonexistent-PID path: the tool wraps the postgres function's boolean
    // return in a `note` that explains why a `false` came back. We exercise
    // with PID 1 -- guaranteed not to be a postgres backend, and the
    // current role lacks pg_signal_backend authority over it.
    it("returns signaled=false with a helpful note for a PID that is not a postgres backend", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const res = (await pgKill.handler({ pid: 1, mode: "cancel" })) as {
          ok: boolean;
          data?: { pid: number; mode: string; signaled: boolean; note: string };
        };
        assert.equal(res.ok, true);
        assert.equal(res.data?.pid, 1);
        assert.equal(res.data?.mode, "cancel");
        assert.equal(res.data?.signaled, false);
        assert.match(res.data?.note ?? "", /PID 1 may not exist|may already be gone|lacks permission/i);
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });

    // Positive-path coverage. Spawn an out-of-band Client that owns its own
    // backend, kick off a `pg_sleep` without awaiting, then invoke pg_kill
    // with mode='cancel' targeting that backend. The sleep should error
    // out with the postgres "canceling statement due to user request"
    // message, and pg_cancel_backend should return true (signaled).
    it("cancels a real running query and returns signaled=true (mode=cancel)", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      const sideClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await sideClient.connect();
      try {
        const pidRow = await sideClient.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
        const targetPid = pidRow.rows[0]!.pid;

        // Kick off a long sleep on the side connection without awaiting; the
        // promise will reject with the cancellation error once pg_kill fires.
        // 30s upper bound is generous -- the cancel should land within a
        // few hundred ms.
        const sleepPromise = sideClient.query("SELECT pg_sleep(30)").catch((e: unknown) => e);

        // Give postgres a moment to actually start executing pg_sleep before
        // we try to cancel it -- otherwise we may race the start and
        // pg_cancel_backend returns true without any in-flight statement.
        await new Promise((r) => setTimeout(r, 250));

        const res = (await pgKill.handler({ pid: targetPid, mode: "cancel" })) as {
          ok: boolean;
          data?: { pid: number; signaled: boolean; note: string };
        };
        assert.equal(res.ok, true);
        assert.equal(res.data?.pid, targetPid);
        assert.equal(res.data?.signaled, true);
        assert.match(res.data?.note ?? "", /SIGINT/);

        const settled = await sleepPromise;
        assert.ok(settled instanceof Error, `expected pg_sleep to reject after cancel, got ${typeof settled}`);
        assert.match(
          (settled as Error).message,
          /canceling statement|cancel/i,
          `expected cancellation error, got: ${(settled as Error).message}`,
        );
      } finally {
        try {
          await sideClient.end();
        } catch {
          // Best-effort: client may already be in error state from the cancel.
        }
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });

    // Same shape but mode='terminate' -- exercises the pg_terminate_backend
    // branch and asserts the note flips to SIGTERM. After termination, the
    // side connection is fully closed; the side query rejects with a
    // connection-terminated error.
    it("terminates a backend and returns signaled=true (mode=terminate)", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      const sideClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await sideClient.connect();
      try {
        const pidRow = await sideClient.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
        const targetPid = pidRow.rows[0]!.pid;

        const sleepPromise = sideClient.query("SELECT pg_sleep(30)").catch((e: unknown) => e);
        await new Promise((r) => setTimeout(r, 250));

        const res = (await pgKill.handler({ pid: targetPid, mode: "terminate" })) as {
          ok: boolean;
          data?: { pid: number; signaled: boolean; note: string };
        };
        assert.equal(res.ok, true);
        assert.equal(res.data?.signaled, true);
        assert.match(res.data?.note ?? "", /SIGTERM/);

        const settled = await sleepPromise;
        assert.ok(settled instanceof Error);
      } finally {
        try {
          await sideClient.end();
        } catch {
          // Expected: connection was terminated by us.
        }
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });
  });
});
