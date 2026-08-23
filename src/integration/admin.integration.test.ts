// SERIALIZATION: these integration files MUST run serialized in one process
// (--test-concurrency=1 via scripts/run-tests.mjs). The pg pool, typeNameCache,
// and process.env are process-global singletons; running these files (or their
// tests) concurrently would let one test's pool swap / env mutation / cache
// reset race another's in-flight query. Do not parallelize without first
// removing those shared singletons.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { PG16, PG18, runInternal, shutdown } from "../api.js";
import { adminTools } from "../tools/admin.js";
import { statsTools } from "../tools/stats.js";
import {
  destructiveTestsEnabled,
  FIXTURE_GROUP_ROLE,
  FIXTURE_LIMITED_PASSWORD,
  FIXTURE_LIMITED_ROLE,
  FIXTURE_MEMBER_ROLE,
  FIXTURE_SCHEMA,
  FIXTURE_WRAPAROUND_CONTROL_TABLE,
  FIXTURE_WRAPAROUND_FREEZE_MAX_AGE,
  FIXTURE_WRAPAROUND_MULTIXACT_FREEZE_MAX_AGE,
  FIXTURE_WRAPAROUND_OVERRIDE_TABLE,
  fdwFixtureAvailable,
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

// Server-version capability probe for the PG16-gated last_*_scan columns.
// Asks the server directly rather than importing the handler's own
// getServerVersionNum(), for the same reason the pgstattuple check in
// pg_table_bloat re-queries pg_extension instead of trusting the tool: a
// regression in the probe the handler uses to gate those columns must not
// also move the test's expectation. Returns 0 when the probe itself fails,
// which callers treat as "cannot tell" and skip -- matching this file's habit
// of skipping rather than failing when a capability can't be established.
async function probeServerVersionNum(): Promise<number> {
  const res = await runInternal<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  if (!res.ok || !res.data?.length) return 0;
  const parsed = Number.parseInt(res.data[0].v, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// pg_seq_scan_tables and pg_unused_indexes return the same stats-window
// envelope, so the window assertions live here instead of being duplicated in
// both describes (same rationale as waitForActiveSleep in pg_kill below).
//
// stats_reset is legitimately null on a cluster whose counters were never
// reset, or whose stats were discarded by crash recovery / an immediate
// shutdown / a major-version upgrade -- so this asserts the KEY is present and
// the TYPE is right, never that the value is non-null.
function assertStatsWindow(
  data: { stats_reset: string | null; stats_reset_age_seconds: number | null; _warnings?: string[] } | undefined,
  label: string,
): void {
  assert.ok(data, `${label}: expected a stats-window envelope, got ${JSON.stringify(data)}`);
  assert.ok(
    "stats_reset" in data,
    `${label}: stats_reset key must be present, got keys: ${Object.keys(data).join(", ")}`,
  );
  assert.ok(
    "stats_reset_age_seconds" in data,
    `${label}: stats_reset_age_seconds key must be present, got keys: ${Object.keys(data).join(", ")}`,
  );
  assert.ok(
    data.stats_reset === null || typeof data.stats_reset === "string",
    `${label}: stats_reset must be string | null, got ${JSON.stringify(data.stats_reset)}`,
  );
  assert.ok(
    data.stats_reset_age_seconds === null || typeof data.stats_reset_age_seconds === "number",
    `${label}: stats_reset_age_seconds must be number | null, got ${JSON.stringify(data.stats_reset_age_seconds)}`,
  );
  if (data.stats_reset_age_seconds !== null) {
    assert.ok(
      Number.isFinite(data.stats_reset_age_seconds) && data.stats_reset_age_seconds >= 0,
      `${label}: stats_reset_age_seconds must be finite and non-negative, got ${data.stats_reset_age_seconds}`,
    );
  }
  // The two fields move together: an age without a reset point (or vice
  // versa) means the envelope was assembled from a half-read probe row.
  assert.equal(
    data.stats_reset === null,
    data.stats_reset_age_seconds === null,
    `${label}: stats_reset and stats_reset_age_seconds must both be null or both be set, got ${JSON.stringify({
      stats_reset: data.stats_reset,
      stats_reset_age_seconds: data.stats_reset_age_seconds,
    })}`,
  );
  // The probe reads pg_stat_database for current_database(), which the test
  // role can always see -- so the degraded path must not fire here. Mirrors
  // the "no warnings on a healthy standalone instance" pin in
  // pg_replication_status.
  assert.equal(data._warnings, undefined, `${label}: no _warnings expected, got ${JSON.stringify(data._warnings)}`);
}

// pg_advisor's wraparound_risk row shapes. Split so the tables and databases
// halves can share assertTriggeredByConsistent below: the triggered_by CASE is
// duplicated across the two sub-queries, so a fix applied to one and not the
// other is a live regression that a per-list assertion would miss.
type WraparoundRatios = {
  xid_age: number;
  mxid_age: number | null;
  pct_of_freeze_max_age: number | null;
  pct_of_multixact_freeze_max_age: number | null;
  triggered_by: string;
};

type WraparoundTableRow = WraparoundRatios & {
  schema: string;
  table: string;
  relkind: string;
  freeze_max_age: number;
  multixact_freeze_max_age: number;
  // PG18+ only, and ABSENT rather than null on older servers -- see the
  // freeze-coverage test in the pg_advisor describe.
  pages?: number;
  all_frozen_pages?: number;
  frozen_page_fraction?: number | null;
};

type AdvisorResult = {
  ok: boolean;
  data?: {
    sequence_exhaustion: unknown[];
    wraparound_risk: {
      autovacuum_freeze_max_age: number | null;
      autovacuum_multixact_freeze_max_age: number | null;
      databases: (WraparoundRatios & { database: string })[];
      tables: WraparoundTableRow[];
    };
    tables_without_primary_key: { schema: string; table: string }[];
    public_tables_without_rls: { schema: string; table: string }[];
    _warnings?: string[];
  };
  error?: string;
};

// pct_of_* ship as numeric(10, 4) while the WHERE clause and the triggered_by
// CASE both compare the UNROUNDED ratio, so a reported value can legitimately
// sit up to half a ten-thousandth on the wrong side of the threshold. Exactly
// that much slack and no more -- anything wider stops catching a genuinely
// mislabelled row.
const WRAPAROUND_PCT_SLACK = 5e-5;

/**
 * Ratio the wraparound control table currently sits at: age(relfrozenxid) over
 * the cluster GUC. Neither term is controllable from a test -- the XID counter
 * moves with every statement the suite runs -- so the wraparound cases derive
 * their threshold from the live number instead of hardcoding one. Half of it is
 * a threshold both fixture tables clear, and age() only ever grows between the
 * probe and the handler call, so the margin cannot close underneath them.
 *
 * Returns 0 when the probe fails or the table is missing; callers treat that as
 * "cannot tell" and skip, matching probeServerVersionNum above.
 */
async function probeControlXidRatio(): Promise<number> {
  const res = await runInternal<{ ratio: string | null }>(
    `SELECT (age(c.relfrozenxid)::numeric
               / NULLIF(current_setting('autovacuum_freeze_max_age')::numeric, 0))::text AS ratio
     FROM pg_catalog.pg_class c
     WHERE c.oid = to_regclass($1)`,
    [`${FIXTURE_SCHEMA}.${FIXTURE_WRAPAROUND_CONTROL_TABLE}`],
  );
  if (!res.ok || !res.data?.length) return 0;
  const parsed = Number(res.data[0].ratio ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * triggered_by must agree with the row's OWN ratios. The label is what tells an
 * operator whether to chase a freeze VACUUM or the lock-heavy workload burning
 * multixact members, and the unit tests only ever see the literal a stubbed
 * client handed back -- the CASE has never been evaluated by a server.
 */
function assertTriggeredByConsistent(row: WraparoundRatios, threshold: number, label: string): void {
  assert.ok(
    ["xid", "multixact", "both"].includes(row.triggered_by),
    `${label}: triggered_by must be xid | multixact | both, got ${JSON.stringify(row.triggered_by)}`,
  );
  const xid = row.pct_of_freeze_max_age;
  const mxid = row.pct_of_multixact_freeze_max_age;
  // 'xid' is the CASE's ELSE arm, reached only when the multixact side did not
  // clear the threshold -- which the WHERE's OR then makes an assertion that
  // the xid side did.
  if (row.triggered_by !== "multixact") {
    assert.ok(
      xid !== null && xid + WRAPAROUND_PCT_SLACK >= threshold,
      `${label}: triggered_by=${row.triggered_by} claims the xid side cleared threshold=${threshold}, but ` +
        `pct_of_freeze_max_age=${xid}`,
    );
  }
  if (row.triggered_by !== "xid") {
    assert.ok(
      mxid !== null && mxid + WRAPAROUND_PCT_SLACK >= threshold,
      `${label}: triggered_by=${row.triggered_by} claims the multixact side cleared threshold=${threshold}, but ` +
        `pct_of_multixact_freeze_max_age=${mxid}`,
    );
  }
  if (row.triggered_by === "multixact") {
    // Arm ordering: 'multixact' fires only when the xid side did NOT clear the
    // threshold; a row over both belongs in 'both'. Collapsing that ordering
    // sends the operator after a locking workload while the xid horizon is the
    // thing about to stop writes.
    assert.ok(
      xid === null || xid - WRAPAROUND_PCT_SLACK < threshold,
      `${label}: triggered_by=multixact but pct_of_freeze_max_age=${xid} also clears threshold=${threshold}; ` +
        `that row should be labelled 'both'`,
    );
  }
  if (row.mxid_age === null) {
    // InvalidMultiXactId rows get a null multixact ratio, and null can never
    // satisfy `>= $1` -- so they can only ever be xid-triggered. A regression
    // that dropped the guard would report a ~4.2-billion mxid_age here and
    // relabel every never-locked relation as multixact-critical.
    assert.equal(
      row.triggered_by,
      "xid",
      `${label}: mxid_age is null (no multixact horizon) so triggered_by must be 'xid', got ${row.triggered_by}`,
    );
  }
}

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

    // Real-contention coverage, table-lock variant. Proves the LATERAL
    // unnest of pg_blocking_pids() and the per-(blocked, blocker) row shape
    // advertised in the description actually fire. Exercises the
    // `bl.relation IS NOT NULL` branch of the relation CASE -- the waiter
    // queues on a relation lock directly because ACCESS EXCLUSIVE conflicts
    // with the AccessShareLock a plain SELECT needs. The row-level FOR
    // UPDATE variant below exercises the `bl.relation IS NULL` fallback.
    it("reports a blocked-by-blocker pair with relation under table-lock contention", async () => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      const waiter = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await waiter.connect();
      // Hoisted out of the try block so the finally cleanup can await it
      // on assertion-failure paths (try-block `const` is not visible in
      // finally).
      let waiterPromise: Promise<unknown> | undefined;
      try {
        const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]!.pid;
        const waiterPid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]!.pid;

        // Holder takes an ACCESS EXCLUSIVE lock -- the same lock ALTER TABLE
        // and VACUUM FULL acquire. Conflicts with every other lock mode,
        // including the AccessShareLock a plain SELECT needs.
        await holder.query("BEGIN");
        await holder.query(`LOCK TABLE ${FIXTURE_SCHEMA}.users IN ACCESS EXCLUSIVE MODE`);

        // Waiter's SELECT needs AccessShareLock on users -- blocks on a
        // relation lock, so bl.relation in the handler's CASE is non-null.
        waiterPromise = waiter.query(`SELECT 1 FROM ${FIXTURE_SCHEMA}.users LIMIT 1`).catch((e: unknown) => e);

        // Poll pg_blocking_pids() until postgres actually registers the
        // wait. Beats a hardcoded sleep, which can be too short on a slow
        // CI host (waiter not yet queued) or too long on a fast one.
        const deadline = Date.now() + 5000;
        let registered = false;
        while (Date.now() < deadline) {
          const probe = (await runInternal<{ blockers: number[] }>("SELECT pg_blocking_pids($1)::int[] AS blockers", [
            waiterPid,
          ])) as { ok: boolean; data?: { blockers: number[] }[] };
          if (probe.ok && (probe.data?.[0]?.blockers ?? []).length > 0) {
            registered = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(registered, `waiter pid ${waiterPid} never appeared in pg_blocking_pids within 5s`);

        const res = (await inspectLocks.handler({ limit: 50 })) as {
          ok: boolean;
          data?: {
            blocked_pid: number;
            blocking_pid: number;
            blocked_query: string;
            relation: string | null;
            lock_type: string;
          }[];
        };
        assert.equal(res.ok, true);
        const pair = (res.data ?? []).find((r) => r.blocked_pid === waiterPid && r.blocking_pid === holderPid);
        assert.ok(pair, `expected a blocked=${waiterPid} blocking=${holderPid} pair, got ${JSON.stringify(res.data)}`);
        // The blocked query is the waiter's SELECT.
        assert.match(pair.blocked_query, /SELECT/i);
        // Relation lock -> bl.relation set -> CASE returns schema.table form.
        assert.ok(
          pair.relation?.includes("users"),
          `expected relation to include 'users', got ${JSON.stringify(pair.relation)}`,
        );
        assert.equal(pair.lock_type, "relation");

        // Release the holder so the waiter completes.
        await holder.query("ROLLBACK");
      } finally {
        // Order matters: close the holder first (which releases the lock if
        // an assertion threw before the explicit ROLLBACK), then await the
        // waiter (which can now make progress), then close the waiter. This
        // keeps the floating waiterPromise from outliving the test on
        // assertion-failure paths.
        try {
          await holder.end();
        } catch {
          // Best-effort.
        }
        if (waiterPromise) {
          try {
            await waiterPromise;
          } catch {
            // May reject if waiter.end() raced ahead -- benign.
          }
        }
        try {
          await waiter.end();
        } catch {
          // Best-effort.
        }
      }
    });

    // Row-level FOR UPDATE contention -- the common case in app workloads.
    // The blocked waiter queues on a `transactionid` lock with bl.relation
    // = NULL (the wait is on the holder's xid, not on a relation). Pre-#5
    // the handler returned `relation: null` here; the fallback subquery
    // now resolves the contested table from the blocker's held write-intent
    // relation locks (SELECT FOR UPDATE takes RowShareLock on `users`).
    it("reports a blocked-by-blocker pair with relation under row-level FOR UPDATE contention", async () => {
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      const waiter = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await waiter.connect();
      let waiterPromise: Promise<unknown> | undefined;
      try {
        const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]!.pid;
        const waiterPid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]!.pid;

        // Holder grabs the row lock and keeps the transaction open. This
        // takes a tuple lock + RowShareLock on the relation, plus an xid.
        await holder.query("BEGIN");
        await holder.query(`SELECT * FROM ${FIXTURE_SCHEMA}.users WHERE id = 1 FOR UPDATE`);

        // Waiter's UPDATE on the same row queues on the holder's xid via
        // a transactionid lock. bl.relation is NULL for this entry.
        waiterPromise = waiter
          .query(`UPDATE ${FIXTURE_SCHEMA}.users SET email = email WHERE id = 1`)
          .catch((e: unknown) => e);

        const deadline = Date.now() + 5000;
        let registered = false;
        while (Date.now() < deadline) {
          const probe = (await runInternal<{ blockers: number[] }>("SELECT pg_blocking_pids($1)::int[] AS blockers", [
            waiterPid,
          ])) as { ok: boolean; data?: { blockers: number[] }[] };
          if (probe.ok && (probe.data?.[0]?.blockers ?? []).length > 0) {
            registered = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(registered, `waiter pid ${waiterPid} never appeared in pg_blocking_pids within 5s`);

        const res = (await inspectLocks.handler({ limit: 50 })) as {
          ok: boolean;
          data?: {
            blocked_pid: number;
            blocking_pid: number;
            blocked_query: string;
            relation: string | null;
            lock_type: string;
          }[];
        };
        assert.equal(res.ok, true);
        const pair = (res.data ?? []).find((r) => r.blocked_pid === waiterPid && r.blocking_pid === holderPid);
        assert.ok(pair, `expected a blocked=${waiterPid} blocking=${holderPid} pair, got ${JSON.stringify(res.data)}`);
        assert.match(pair.blocked_query, /UPDATE/i);
        // lock_type is transactionid (the wait kind), but the fallback
        // subquery resolves relation from the blocker's RowShareLock on users.
        assert.equal(
          pair.lock_type,
          "transactionid",
          `expected transactionid lock_type for row-level wait, got ${pair.lock_type}`,
        );
        assert.ok(
          pair.relation?.includes("users"),
          `expected relation to resolve to users via blocker-held-locks fallback, got ${JSON.stringify(pair.relation)}`,
        );

        await holder.query("ROLLBACK");
      } finally {
        try {
          await holder.end();
        } catch {
          // Best-effort.
        }
        if (waiterPromise) {
          try {
            await waiterPromise;
          } catch {
            // May reject if waiter.end() raced ahead -- benign.
          }
        }
        try {
          await waiter.end();
        } catch {
          // Best-effort.
        }
      }
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
    // The handler returns superuser/createdb/createrole/replication/bypass_rls
    // as booleans alongside name and member_of, but the existing tests only
    // assert on name + member_of + can_login. A regression that drops an AS
    // alias, swaps two columns, or breaks the boolean cast would only surface
    // when a caller actually relied on the field. The postgres bootstrap role
    // and the fixture NOLOGIN role have known-stable values worth pinning.
    it("returns superuser/createdb/createrole booleans for postgres and NOLOGIN flag for fixture role", async () => {
      const res = (await listRoles.handler({ includeSystem: false })) as {
        ok: boolean;
        data?: {
          name: string;
          can_login: boolean;
          superuser: boolean;
          createdb: boolean;
          createrole: boolean;
          replication: boolean;
          bypass_rls: boolean;
        }[];
      };
      assert.equal(res.ok, true);

      const postgres = (res.data ?? []).find((r) => r.name === "postgres");
      assert.ok(postgres, "postgres role not present in listing");
      // The bootstrap superuser always has these attributes; pinning catches
      // a column-swap regression.
      assert.equal(postgres.superuser, true, "postgres.superuser should be true");
      assert.equal(postgres.can_login, true, "postgres.can_login should be true");
      assert.equal(typeof postgres.createdb, "boolean");
      assert.equal(typeof postgres.createrole, "boolean");
      assert.equal(typeof postgres.replication, "boolean");
      assert.equal(typeof postgres.bypass_rls, "boolean");

      // FIXTURE_MEMBER_ROLE is created NOLOGIN -- locks the can_login=false
      // path. If the AS alias for rolcanlogin gets dropped, this fails.
      const member = (res.data ?? []).find((r) => r.name === FIXTURE_MEMBER_ROLE);
      assert.ok(member, `${FIXTURE_MEMBER_ROLE} not present in listing`);
      assert.equal(member.can_login, false, "NOLOGIN fixture role should report can_login=false");
      assert.equal(member.superuser, false);
      assert.equal(member.replication, false);
    });

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
        data?: {
          rows: { schema: string; table: string; seq_scans: string; idx_scans: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
          _warnings?: string[];
        };
      };
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data?.rows));
      // Should find the fixture tables (minSize=0 includes everything).
      const tables = (res.data?.rows ?? []).map((r) => r.table);
      assert.ok(tables.length > 0, "expected some stats rows from fixture schema");
    });

    // Locks `WHERE n_live_tup >= $1`. Without ANALYZE, fixture tables sit at
    // n_live_tup=0 in pg_stat_user_tables; ANALYZing seeds the counter so
    // empty tables are distinguishable from populated ones. A regression
    // that drops or inverts the predicate would leak the zero-tuple tables
    // through at minSize=1.
    it("minSize threshold actually excludes tables below it", async () => {
      const analyzeUsers = await runInternal(`ANALYZE ${FIXTURE_SCHEMA}.users`);
      const analyzePosts = await runInternal(`ANALYZE ${FIXTURE_SCHEMA}.posts`);
      const analyzeNoPk = await runInternal(`ANALYZE ${FIXTURE_SCHEMA}.no_pk_table`);
      assert.equal(analyzeUsers.ok, true);
      assert.equal(analyzePosts.ok, true);
      assert.equal(analyzeNoPk.ok, true);

      const baseline = (await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 0, limit: 100 })) as {
        ok: boolean;
        data?: {
          rows: { table: string; live_tuples: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(baseline.ok, true);
      const empty = (baseline.data?.rows ?? []).filter((r) => Number(r.live_tuples) === 0);
      // If the cluster happens to have no zero-tuple tables in the fixture
      // schema, the test is vacuous -- threshold-filtering has nothing to
      // bite on. The fixture's no_pk_table / no_pk_partitioned / matview /
      // products usually satisfy this.
      if (empty.length === 0) return;

      const filtered = (await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 1, limit: 100 })) as {
        ok: boolean;
        data?: {
          rows: { table: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(filtered.ok, true);
      // Property: every baseline row with live_tuples=0 is absent at minSize=1.
      for (const b of empty) {
        assert.ok(
          !(filtered.data?.rows ?? []).some((f) => f.table === b.table),
          `${b.table} (live_tuples=0) should be excluded at minSize=1`,
        );
      }
    });

    // Locks the CASE WHEN COALESCE(idx_scan,0)=0 THEN NULL guard. Without
    // it, the division-by-zero would either error the whole query or (worse,
    // depending on pg version) return Infinity / NaN. The property holds
    // vacuously when no row has idx_scans=0, but the fixture's lightly-used
    // tables typically do.
    it("reports ratio=null when idx_scans=0 (no division by zero)", async () => {
      const res = (await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 0, limit: 100 })) as {
        ok: boolean;
        data?: {
          rows: { table: string; idx_scans: string; ratio: number | null }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(res.ok, true);
      for (const row of res.data?.rows ?? []) {
        if (row.idx_scans === "0") {
          assert.equal(row.ratio, null, `${row.table} has idx_scans=0 but ratio=${row.ratio}; CASE guard regression`);
        }
      }
    });

    // Exercises the no-schema branch of the conditional WHERE clause. A
    // regression that swaps the two branches would silently leak cross-
    // schema rows when the user did scope to a schema, or scope when they
    // didn't. The negative is just as load-bearing as the positive.
    it("with no schema arg spans all user schemas and excludes pg_*/information_schema", async () => {
      const res = (await seqScanTables.handler({ minSize: 0, limit: 100 })) as {
        ok: boolean;
        data?: {
          rows: { schema: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data?.rows));
      for (const row of res.data?.rows ?? []) {
        assert.ok(!row.schema.startsWith("pg_"), `pg_* schema leaked: ${row.schema}`);
        assert.notEqual(row.schema, "information_schema", "information_schema leaked");
      }
      // Fixture schema must appear -- proves the "all user schemas" path
      // isn't accidentally restrictive.
      assert.ok(
        (res.data?.rows ?? []).some((r) => r.schema === FIXTURE_SCHEMA),
        `expected ${FIXTURE_SCHEMA} in unfiltered result, got ${JSON.stringify(
          (res.data?.rows ?? []).map((r) => r.schema),
        )}`,
      );
    });

    // The counters this tool ranks on are cumulative since the last stats
    // reset, so the reset point ships in the envelope alongside the rows.
    // Nothing else in the suite pins it. stats_reset is legitimately null on a
    // cluster that has never had its counters reset, so the assertion is on
    // the key + type, not on a value -- see assertStatsWindow above.
    it("returns the stats-reset window alongside the rows", async () => {
      const res = (await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 0, limit: 20 })) as {
        ok: boolean;
        data?: {
          rows: { table: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
          _warnings?: string[];
        };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.ok(Array.isArray(res.data?.rows), `rows must be an array, got ${JSON.stringify(res.data?.rows)}`);
      assertStatsWindow(res.data, "pg_seq_scan_tables");
    });

    // PG16 added pg_stat_user_tables.last_seq_scan / last_idx_scan. Below 16
    // the handler must not name those columns at all (a 42703 would fail the
    // whole tool), so the keys are ABSENT rather than null -- absence is the
    // load-bearing half of the assertion. Probe-then-gate shape follows the
    // pgstattuple check in pg_table_bloat below.
    it("carries last_seq_scan / last_idx_scan on PG16+ and omits the keys below 16", async () => {
      const version = await probeServerVersionNum();
      if (version === 0) return; // version undeterminable -- nothing to gate on

      const res = (await seqScanTables.handler({ schema: FIXTURE_SCHEMA, minSize: 0, limit: 20 })) as {
        ok: boolean;
        data?: {
          rows: { table: string; last_seq_scan?: string | null; last_idx_scan?: string | null }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const rows = res.data?.rows ?? [];
      // minSize=0 over the fixture schema normally returns rows; if this
      // cluster somehow has none, there is nothing to inspect.
      if (rows.length === 0) return;

      for (const row of rows) {
        const keys = Object.keys(row).join(", ");
        if (version >= PG16) {
          assert.ok("last_seq_scan" in row, `${row.table}: last_seq_scan must be present on PG16+, got keys: ${keys}`);
          assert.ok("last_idx_scan" in row, `${row.table}: last_idx_scan must be present on PG16+, got keys: ${keys}`);
          // null is the legitimate "no such scan since the reset" value; a
          // non-null value is the ::text cast of a timestamptz.
          if (row.last_seq_scan !== null) assert.equal(typeof row.last_seq_scan, "string");
          if (row.last_idx_scan !== null) assert.equal(typeof row.last_idx_scan, "string");
        } else {
          assert.ok(
            !("last_seq_scan" in row),
            `${row.table}: last_seq_scan must be absent below PG16 (server_version_num=${version}), got keys: ${keys}`,
          );
          assert.ok(
            !("last_idx_scan" in row),
            `${row.table}: last_idx_scan must be absent below PG16 (server_version_num=${version}), got keys: ${keys}`,
          );
        }
      }
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

    // Threshold-filter regression guard. Other tests in the suite can mutate
    // tuple counts as a side effect, so an absolute threshold isn't safe to
    // hard-code. Instead, prove the relationship: (a) every row in the
    // filtered result is at or above the threshold, and (b) every baseline
    // row below the threshold is absent from the filtered result. A
    // regression that drops the `>= $1` predicate breaks both properties.
    //
    // pg_stat_user_tables.n_live_tup / n_dead_tup are populated by
    // ANALYZE/VACUUM, not raw INSERT, so without ANALYZE the fixture tables
    // sit at (0, 0) and the handler's `(n_live_tup + n_dead_tup) > 0` filter
    // excludes them all -- producing an empty baseline that defeats the test.
    // Coverage note: the fixture seeds NO dead tuples (no UPDATE/DELETE churn
    // before ANALYZE), so every baseline row sits at dead_ratio=0 -- all below
    // the 0.5 threshold. Property A therefore iterates an empty filtered set,
    // and only Property B (the exclusion direction) does real work. The
    // positive-survival branch (a row that PASSES a non-zero threshold) is
    // structurally unreachable here; to cover it, churn rows then ANALYZE so a
    // table lands between 0 and 0.5.
    it("minDeadRatio threshold actually filters rows below it (relative)", async () => {
      const analyzeUsers = await runInternal(`ANALYZE ${FIXTURE_SCHEMA}.users`);
      const analyzePosts = await runInternal(`ANALYZE ${FIXTURE_SCHEMA}.posts`);
      assert.equal(analyzeUsers.ok, true, `ANALYZE users failed: ${analyzeUsers.error}`);
      assert.equal(analyzePosts.ok, true, `ANALYZE posts failed: ${analyzePosts.error}`);

      const baseline = (await tableBloat.handler({ schema: FIXTURE_SCHEMA, minDeadRatio: 0, limit: 500 })) as {
        ok: boolean;
        data?: { table: string; dead_ratio: number }[];
      };
      assert.equal(baseline.ok, true);
      assert.ok((baseline.data ?? []).length > 0, "expected at least one baseline row after ANALYZE");

      const threshold = 0.5;
      const filtered = (await tableBloat.handler({ schema: FIXTURE_SCHEMA, minDeadRatio: threshold, limit: 500 })) as {
        ok: boolean;
        data?: { table: string; dead_ratio: number }[];
      };
      assert.equal(filtered.ok, true);
      // Property A: every filtered row passes the threshold.
      for (const r of filtered.data ?? []) {
        assert.ok(r.dead_ratio >= threshold, `${r.table} ratio=${r.dead_ratio} should be >= ${threshold}`);
      }
      // Property B: every baseline row below the threshold is filtered out.
      for (const b of (baseline.data ?? []).filter((r) => r.dead_ratio < threshold)) {
        assert.ok(
          !(filtered.data ?? []).some((f) => f.table === b.table),
          `${b.table} (ratio=${b.dead_ratio}) should be absent at threshold=${threshold}`,
        );
      }
    });

    // Schema-filter branch (with schema arg). The other tests run without a
    // schema; this one proves the `AND schemaname = $3` predicate fires.
    // A regression that swaps the branches would leak cross-schema rows.
    it("filters by schema when provided (no cross-schema leakage)", async () => {
      const res = (await tableBloat.handler({ schema: FIXTURE_SCHEMA, minDeadRatio: 0, limit: 500 })) as {
        ok: boolean;
        data?: { schema: string }[];
      };
      assert.equal(res.ok, true);
      for (const row of res.data ?? []) {
        assert.equal(row.schema, FIXTURE_SCHEMA, `expected only ${FIXTURE_SCHEMA}, got ${row.schema}`);
      }
    });

    // pgstattuple methods. Gated on extension availability; falls back to the
    // "not installed" error path when pgstattuple is absent in this environment.
    for (const method of ["approx", "exact"] as const) {
      it(`method='${method}': returns same shape as estimate or a clear not-installed error`, async () => {
        // First confirm whether pgstattuple is installed.
        const extCheck = await runInternal<{ installed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgstattuple') AS installed`,
        );
        const installed = extCheck.ok && extCheck.data?.[0]?.installed === true;

        const res = (await tableBloat.handler({
          schema: FIXTURE_SCHEMA,
          minDeadRatio: 0,
          limit: 50,
          method,
        })) as {
          ok: boolean;
          data?: { schema: string; table: string; live_tuples: string; dead_tuples: string; dead_ratio: number }[];
          error?: string;
        };

        if (!installed) {
          assert.equal(res.ok, false);
          assert.match(res.error ?? "", /pgstattuple/);
          return;
        }

        assert.equal(res.ok, true, `method=${method} failed: ${res.error}`);
        assert.ok(Array.isArray(res.data));
        // All rows must belong to the fixture schema.
        for (const row of res.data ?? []) {
          assert.equal(row.schema, FIXTURE_SCHEMA);
          assert.equal(typeof row.dead_ratio, "number");
          // live_tuples and dead_tuples are text (bigint-safe serialization).
          assert.equal(typeof row.live_tuples, "string");
          assert.equal(typeof row.dead_tuples, "string");
        }
      });
    }

    it("method='estimate' succeeds regardless of pgstattuple extension state", async () => {
      // estimate path never touches pgstattuple; calling it with method='estimate'
      // must always succeed regardless of extension state.
      const res = (await tableBloat.handler({
        schema: FIXTURE_SCHEMA,
        minDeadRatio: 0,
        limit: 5,
        method: "estimate",
      })) as { ok: boolean; error?: string };
      assert.equal(res.ok, true, `estimate path failed unexpectedly: ${res.error}`);
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

      // Foreign tables are excluded from tables_without_primary_key because
      // PostgreSQL forbids declaring PKs on foreign tables entirely.
      if (fdwFixtureAvailable()) {
        assert.ok(
          !noPk.some((r) => r.schema === FIXTURE_SCHEMA && r.table === "remote_users"),
          `remote_users (foreign table) must not appear in tables_without_primary_key, got ${JSON.stringify(noPk)}`,
        );
      }
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

    // The load-bearing assertion for everything else in this describe.
    // pg_advisor swallows a failed sub-query into `_warnings` and still returns
    // ok: true with that category empty, so an invalid GROUP BY, a bad cast, or
    // a column that does not exist on this major is indistinguishable from
    // "nothing to report" -- every other case here passes just as happily
    // against a category that never ran. Nothing in this file looked at the key
    // before, which is how a whole category could ship green while returning []
    // against a real server.
    it("returns no _warnings as the fixture superuser (a swallowed sub-query error lands here)", async () => {
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.5,
        wraparoundThreshold: 0.5,
        rlsSchemas: ["public"],
        limit: 100,
      })) as AdvisorResult;
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.deepEqual(
        res.data?._warnings ?? [],
        [],
        `every sub-query must succeed for the fixture superuser; got ${JSON.stringify(res.data?._warnings)}`,
      );
    });

    // wraparound_risk's documented envelope. Both divisors collapse to null and
    // both lists to [] when their sub-query fails, so a null divisor here is the
    // same failure the _warnings case above catches, seen from the caller's
    // side: an empty `databases` with no scale to interpret it against.
    it("wraparound_risk reports both GUC divisors as positive integers and both lists as arrays", async () => {
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.99,
        wraparoundThreshold: 0.5,
        rlsSchemas: ["public"],
        limit: 100,
      })) as AdvisorResult;
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const wrap = res.data?.wraparound_risk;
      assert.ok(wrap, `expected a wraparound_risk envelope, got ${JSON.stringify(res.data)}`);
      for (const key of ["autovacuum_freeze_max_age", "autovacuum_multixact_freeze_max_age"] as const) {
        const value = wrap[key];
        assert.ok(
          typeof value === "number" && Number.isInteger(value) && value > 0,
          `${key} must be a positive integer divisor, got ${JSON.stringify(value)}`,
        );
      }
      assert.ok(Array.isArray(wrap.databases), `databases must be an array, got ${JSON.stringify(wrap.databases)}`);
      assert.ok(Array.isArray(wrap.tables), `tables must be an array, got ${JSON.stringify(wrap.tables)}`);
    });

    // First execution of the wraparound LATERAL against a live server. The unit
    // tests stub the client and assert SQL text, so the triggered_by CASE has
    // only ever been read, never evaluated -- a wrong arm order or a bad
    // mxid_age argument ships green there. At the 0.5 default a healthy fixture
    // cluster returns nothing, hence the threshold derived from the live
    // control-table ratio (see probeControlXidRatio).
    it("returns real rows at a low threshold, each with a triggered_by consistent with its own ratios", async () => {
      const controlRatio = await probeControlXidRatio();
      if (controlRatio === 0) return; // no live ratio to derive a threshold from -- nothing to gate on

      const threshold = controlRatio / 2;
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.99,
        wraparoundThreshold: threshold,
        rlsSchemas: ["public"],
        limit: 500,
      })) as AdvisorResult;
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.deepEqual(
        res.data?._warnings ?? [],
        [],
        `a threshold of ${threshold} must not break a sub-query; got ${JSON.stringify(res.data?._warnings)}`,
      );

      const tables = res.data?.wraparound_risk.tables ?? [];
      const databases = res.data?.wraparound_risk.databases ?? [];
      // Both lists are non-empty by construction at half the control table's own
      // ratio: the control clears it, and datfrozenxid is the MINIMUM
      // relfrozenxid in the database, so age(datfrozenxid) is at least the
      // control's age and the database ratio at least as large. An empty list
      // here means the sub-query returned nothing, not that the cluster is
      // healthy.
      assert.ok(tables.length > 0, `expected wraparound tables at threshold=${threshold}, got none`);
      assert.ok(databases.length > 0, `expected wraparound databases at threshold=${threshold}, got none`);

      for (const row of tables) {
        assertTriggeredByConsistent(row, threshold, `tables/${row.schema}.${row.table}`);
      }
      for (const row of databases) {
        assertTriggeredByConsistent(row, threshold, `databases/${row.database}`);
      }
    });

    // The per-table storage-parameter branch of the freeze_max_age COALESCE.
    // Only the GUC fallback was provable before, and the untested branch fails
    // in the dangerous direction: a table with a LOWERED override reads as safe
    // -- its age measured against 200000000 instead of 100000 -- while
    // autovacuum is already force-freezing it.
    it("resolves the per-table freeze-max-age override and falls back to the GUC on the control table", async () => {
      const controlRatio = await probeControlXidRatio();
      if (controlRatio === 0) return; // no live ratio to derive a threshold from -- nothing to gate on

      const threshold = controlRatio / 2;
      const limit = 500;
      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.99,
        wraparoundThreshold: threshold,
        rlsSchemas: ["public"],
        limit,
      })) as AdvisorResult;
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const wrap = res.data?.wraparound_risk;
      assert.ok(wrap, `expected a wraparound_risk envelope, got ${JSON.stringify(res.data)}`);

      const listed = wrap.tables.map((r) => `${r.schema}.${r.table}`);
      const override = wrap.tables.find(
        (r) => r.schema === FIXTURE_SCHEMA && r.table === FIXTURE_WRAPAROUND_OVERRIDE_TABLE,
      );
      // Safe to require: the override's ratio is 2000x the control's, so it
      // sorts near the top of the GREATEST(...) DESC ordering and cannot be cut
      // by the LIMIT.
      assert.ok(
        override,
        `expected ${FIXTURE_WRAPAROUND_OVERRIDE_TABLE} at threshold=${threshold}, got ${JSON.stringify(listed)}`,
      );
      assert.equal(
        override.freeze_max_age,
        FIXTURE_WRAPAROUND_FREEZE_MAX_AGE,
        `the reloption must win over the GUC, got ${override.freeze_max_age}`,
      );
      assert.equal(
        override.multixact_freeze_max_age,
        FIXTURE_WRAPAROUND_MULTIXACT_FREEZE_MAX_AGE,
        `the multixact reloption must win over the GUC, got ${override.multixact_freeze_max_age}`,
      );
      // The reported field could be right while the ratio was still divided by
      // the GUC -- the two come from different expressions. Recomputing the
      // ratio from the row's own xid_age pins which divisor the LATERAL used.
      assert.ok(
        override.pct_of_freeze_max_age !== null &&
          Math.abs(override.pct_of_freeze_max_age - override.xid_age / FIXTURE_WRAPAROUND_FREEZE_MAX_AGE) <=
            WRAPAROUND_PCT_SLACK,
        `pct_of_freeze_max_age=${override.pct_of_freeze_max_age} must be xid_age ${override.xid_age} over the ` +
          `reloption ${FIXTURE_WRAPAROUND_FREEZE_MAX_AGE}, not over the GUC`,
      );

      const control = wrap.tables.find(
        (r) => r.schema === FIXTURE_SCHEMA && r.table === FIXTURE_WRAPAROUND_CONTROL_TABLE,
      );
      // The control shares the GUC divisor with every catalog relation, so it
      // sits at the bottom of the ordering: on a cluster carrying more frozen
      // relations than `limit` it legitimately falls off the end. That is the
      // LIMIT working, not a broken COALESCE -- but an untruncated result that
      // is missing it is a real failure.
      if (!control) {
        assert.ok(
          wrap.tables.length >= limit,
          `${FIXTURE_WRAPAROUND_CONTROL_TABLE} missing from an untruncated result of ${wrap.tables.length} rows`,
        );
        return;
      }
      assert.equal(
        control.freeze_max_age,
        wrap.autovacuum_freeze_max_age,
        `the control table has no reloption and must fall back to the GUC, got ${control.freeze_max_age}`,
      );
      assert.equal(
        control.multixact_freeze_max_age,
        wrap.autovacuum_multixact_freeze_max_age,
        `the control table must fall back to the multixact GUC, got ${control.multixact_freeze_max_age}`,
      );
      const guc = wrap.autovacuum_freeze_max_age;
      assert.ok(typeof guc === "number" && guc > 0, `expected a usable GUC divisor, got ${JSON.stringify(guc)}`);
      assert.ok(
        control.pct_of_freeze_max_age !== null &&
          Math.abs(control.pct_of_freeze_max_age - control.xid_age / guc) <= WRAPAROUND_PCT_SLACK,
        `pct_of_freeze_max_age=${control.pct_of_freeze_max_age} must be xid_age ${control.xid_age} over the GUC ${guc}`,
      );
      // Both tables were created back to back, so their ages match to within a
      // few XIDs and the divisor is the only thing separating the two ratios.
      assert.notEqual(
        override.freeze_max_age,
        control.freeze_max_age,
        `override and control resolved the same freeze_max_age (${control.freeze_max_age}); the reloption branch ` +
          `is not firing`,
      );
    });

    // The PG18 relallfrozen branch is otherwise proven only by a string match on
    // the generated SQL. A wrong column name there is a 42703 that takes the
    // ENTIRE tables sub-query down -- on the newest major only, and silently:
    // the category comes back [] with the failure parked in _warnings. The
    // below-18 half is equally load-bearing, since naming the column there is
    // what breaks first.
    it("carries the relallfrozen freeze-coverage keys on PG18+ and omits them below 18", async () => {
      const version = await probeServerVersionNum();
      if (version === 0) return; // version undeterminable -- nothing to gate on
      const controlRatio = await probeControlXidRatio();
      if (controlRatio === 0) return; // no live ratio to derive a threshold from -- nothing to gate on

      const res = (await advisor.handler({
        seqExhaustionThreshold: 0.99,
        wraparoundThreshold: controlRatio / 2,
        rlsSchemas: ["public"],
        limit: 500,
      })) as AdvisorResult;
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const tables = res.data?.wraparound_risk.tables ?? [];
      if (tables.length === 0) return; // nothing to inspect

      for (const row of tables) {
        const label = `${row.schema}.${row.table}`;
        const keys = Object.keys(row).join(", ");
        if (version >= PG18) {
          assert.ok("pages" in row, `${label}: pages must be present on PG18+, got keys: ${keys}`);
          assert.ok(
            "all_frozen_pages" in row,
            `${label}: all_frozen_pages must be present on PG18+, got keys: ${keys}`,
          );
          assert.ok(
            "frozen_page_fraction" in row,
            `${label}: frozen_page_fraction must be present on PG18+, got keys: ${keys}`,
          );
          assert.equal(
            typeof row.pages,
            "number",
            `${label}: pages must be a number, got ${JSON.stringify(row.pages)}`,
          );
          assert.equal(
            typeof row.all_frozen_pages,
            "number",
            `${label}: all_frozen_pages must be a number, got ${JSON.stringify(row.all_frozen_pages)}`,
          );
          // null is the NULLIF(relpages, 0) guard firing: a zero-page relation
          // has no coverage to report, which is not the same claim as 0% frozen.
          if (row.frozen_page_fraction !== null && row.frozen_page_fraction !== undefined) {
            assert.ok(
              Number.isFinite(row.frozen_page_fraction) &&
                row.frozen_page_fraction >= 0 &&
                row.frozen_page_fraction <= 1,
              `${label}: frozen_page_fraction must be a fraction in [0,1], got ${row.frozen_page_fraction}`,
            );
          }
        } else {
          const below = `must be absent below PG18 (server_version_num=${version}), got keys: ${keys}`;
          assert.ok(!("pages" in row), `${label}: pages ${below}`);
          assert.ok(!("all_frozen_pages" in row), `${label}: all_frozen_pages ${below}`);
          assert.ok(!("frozen_page_fraction" in row), `${label}: frozen_page_fraction ${below}`);
        }
      }
    });
  });

  describe("pg_replication_status", () => {
    // pg_health, pg_describe_table, and pg_advisor share the same `_warnings`
    // partial-failure pattern but their sub-queries all hit catalog views
    // readable by PUBLIC (pg_class, pg_namespace, pg_stat_user_tables,
    // information_schema.*). Engineering a realistic partial failure for
    // them would require revoking grants from PUBLIC, which would break
    // the rest of the suite. The success-case shape (no `_warnings` key
    // present) is already pinned in each of their own tests, and a
    // construction-side regression would corrupt the success case too --
    // so direct partial-failure coverage is limited to pg_replication_status
    // here, where pg_current_wal_lsn() and pg_replication_slots are
    // genuinely permission-gated and a non-pg_monitor role realistically
    // hits them in managed-DB deployments.

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

    // Populated-`_warnings` path. The handler's three sub-queries (slots,
    // replicas, wal_position) only one of which has a privilege gate that
    // bites on a standalone cluster: on an instance with no slots / no
    // replicas, pg_replication_slots and pg_stat_replication return empty
    // rows even for non-pg_monitor roles. To force a real permission-
    // denied we REVOKE EXECUTE on pg_current_wal_lsn() from PUBLIC for
    // the duration of the test, then swap to a fixture role that lacks
    // any direct grant.
    //
    // REVOKE / GRANT live in before/after hooks rather than inline so the
    // re-grant runs even when the test body throws an assertion or an
    // earlier inline shutdown() fails -- node:test runs after() whenever
    // the matching before() ran, regardless of test outcome. The previous
    // inline try/catch left the cluster's pg_current_wal_lsn() ungrantable
    // to PUBLIC if cleanup itself raised, and a future second `it()` in
    // the block would have to remember to repeat the dance. No defense
    // here against SIGKILL of the test process -- that needs out-of-band
    // cleanup we don't have.
    describe("_warnings under restricted role", {
      skip: destructiveTestsEnabled() ? false : "set POSTGRES_MCP_DESTRUCTIVE_TESTS=1 (disposable cluster only)",
    }, () => {
      // Resolve once at describe-load time so the after() hook can rebuild
      // the superuser pool even if the test body throws mid-mutation.
      const originalUrl = process.env.DATABASE_URL!;

      before(async () => {
        // Yank PUBLIC EXECUTE from the WAL function so a plain LOGIN role
        // gets 42501. Superuser is unaffected.
        const revoke = await runInternal("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_current_wal_lsn() FROM PUBLIC");
        if (!revoke.ok) throw new Error(`REVOKE setup failed: ${revoke.error}`);
      });

      after(async () => {
        // Restore the superuser URL + pool first so the GRANT can land as
        // the original role. A failure here means subsequent test files in
        // the same cluster will fail on walRes, so surface it.
        process.env.DATABASE_URL = originalUrl;
        await shutdown();
        const grant = await runInternal("GRANT EXECUTE ON FUNCTION pg_catalog.pg_current_wal_lsn() TO PUBLIC");
        if (!grant.ok) {
          throw new Error(`Failed to restore PUBLIC EXECUTE on pg_current_wal_lsn(): ${grant.error}`);
        }
      });

      it("populates _warnings when the role lacks EXECUTE on pg_current_wal_lsn()", async () => {
        // Swap to the limited role and rebuild the pool so the handler's
        // sub-queries actually run as that role.
        const limited = new URL(originalUrl);
        limited.username = FIXTURE_LIMITED_ROLE;
        limited.password = FIXTURE_LIMITED_PASSWORD;
        process.env.DATABASE_URL = limited.toString();
        await shutdown();

        const res = (await replicationStatus.handler()) as {
          ok: boolean;
          data?: {
            is_replica: boolean | null;
            wal_position: string | null;
            slots: unknown[];
            replicas: unknown[];
            _warnings?: string[];
          };
          error?: string;
        };
        assert.equal(res.ok, true, `handler must return partial-failure shape, not a hard error; got ${res.error}`);
        const warnings = res.data?._warnings ?? [];
        assert.ok(
          warnings.length > 0,
          `expected at least one warning under restricted role, got ${JSON.stringify(res.data)}`,
        );
        // walRes failure: is_replica and wal_position MUST go null. `false`
        // here would falsely tell the caller "this is a primary" when in
        // fact we couldn't determine the role at all.
        assert.equal(res.data?.is_replica, null, "is_replica must be null, not false, when walRes fails");
        assert.equal(res.data?.wal_position, null, "wal_position must be null when walRes fails");
        // The wal_position warning specifically should reference permission
        // denied or SQLSTATE 42501.
        assert.ok(
          warnings.some((w) => /wal_position fetch failed/.test(w) && /permission denied|42501/i.test(w)),
          `expected a wal_position permission-denied warning, got ${JSON.stringify(warnings)}`,
        );
        // Enforce the comment's premise: ONLY the wal_position sub-query is
        // privilege-gated on a standalone cluster, so slots and replicas must
        // stay readable (they return empty rows, not warnings). Pin exactly one
        // warning, and that slots/replicas came back as real arrays rather than
        // erroring -- a regression that broadened the failure to those
        // sub-queries would add warnings and/or drop these to non-arrays.
        assert.equal(
          warnings.length,
          1,
          `only the wal_position sub-query is privilege-gated; expected exactly one warning, got ${JSON.stringify(warnings)}`,
        );
        assert.ok(
          Array.isArray(res.data?.slots),
          `slots must stay readable under the restricted role, got ${JSON.stringify(res.data?.slots)}`,
        );
        assert.ok(
          Array.isArray(res.data?.replicas),
          `replicas must stay readable under the restricted role, got ${JSON.stringify(res.data?.replicas)}`,
        );
      });
    });
  });

  describe("pg_unused_indexes", () => {
    it("returns an array", async () => {
      const res = (await unusedIndexes.handler({ schema: FIXTURE_SCHEMA, maxScans: 1000, limit: 50 })) as {
        ok: boolean;
        data?: {
          rows: { index: string; scans: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
          _warnings?: string[];
        };
      };
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data?.rows));
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
        data?: {
          rows: { table: string; index: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(res.ok, true);
      const indexes = (res.data?.rows ?? []).map((r) => r.index);
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

    // Exercises the no-schema branch of the conditional WHERE clause -- the
    // other tests in this describe both pass schema=FIXTURE_SCHEMA, so the
    // "all user schemas" path was previously unverified. A regression that
    // swaps the branches would silently scope/unscope the result.
    it("with no schema arg spans all user schemas and excludes pg_*/information_schema", async () => {
      const res = (await unusedIndexes.handler({ maxScans: 1_000_000, limit: 200 })) as {
        ok: boolean;
        data?: {
          rows: { schema: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data?.rows));
      for (const row of res.data?.rows ?? []) {
        assert.ok(!row.schema.startsWith("pg_"), `pg_* schema leaked: ${row.schema}`);
        assert.notEqual(row.schema, "information_schema", "information_schema leaked");
      }
    });

    // Locks `s.idx_scan <= $1`. Existing positive tests pass
    // maxScans=1_000_000 (matches everything) so a regression that drops the
    // predicate has no signal. At maxScans=0 the result MUST contain only
    // zero-scan indexes; any non-zero leakage means the predicate is gone.
    // Coverage note: exercises only the exclusion direction -- every returned
    // row must have scans=0. In a fresh cluster the fixture's indexes are all
    // unscanned, so there is no surviving-at-a-nonzero-maxScans row to check;
    // the inclusion side is not pinned here.
    it("respects the maxScans predicate (maxScans=0 excludes any non-zero-scan index)", async () => {
      const zero = (await unusedIndexes.handler({ schema: FIXTURE_SCHEMA, maxScans: 0, limit: 500 })) as {
        ok: boolean;
        data?: {
          rows: { index: string; scans: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
      };
      assert.equal(zero.ok, true);
      for (const r of zero.data?.rows ?? []) {
        assert.equal(
          r.scans,
          "0",
          `${r.index} reports scans=${r.scans} at maxScans=0 -- s.idx_scan <= $1 predicate may be broken`,
        );
      }
    });

    // The stats-reset window is what keeps a zero-scan row from reading as
    // "safe to drop": every `scans` value here only counts since that point.
    // The probe deliberately runs even when the row list is empty, so this
    // asserts the envelope on a query that can legitimately return no rows.
    it("returns the stats-reset window alongside the rows", async () => {
      // limit 200 is this tool's inputSchema max; direct handler calls bypass
      // Zod, so staying inside it keeps the test on a shape an MCP caller
      // could actually send.
      const res = (await unusedIndexes.handler({ schema: FIXTURE_SCHEMA, maxScans: 0, limit: 200 })) as {
        ok: boolean;
        data?: {
          rows: { index: string }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
          _warnings?: string[];
        };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      assert.ok(Array.isArray(res.data?.rows), `rows must be an array, got ${JSON.stringify(res.data?.rows)}`);
      assertStatsWindow(res.data, "pg_unused_indexes");
    });

    // PG16 added pg_stat_user_indexes.last_idx_scan; below 16 the handler must
    // not name the column, so the key is ABSENT rather than null. Mirrors the
    // pg_seq_scan_tables gate above.
    it("carries last_idx_scan on PG16+ and omits the key below 16", async () => {
      const version = await probeServerVersionNum();
      if (version === 0) return; // version undeterminable -- nothing to gate on

      const res = (await unusedIndexes.handler({ schema: FIXTURE_SCHEMA, maxScans: 1_000_000, limit: 200 })) as {
        ok: boolean;
        data?: {
          rows: { index: string; last_idx_scan?: string | null }[];
          stats_reset: string | null;
          stats_reset_age_seconds: number | null;
        };
        error?: string;
      };
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const rows = res.data?.rows ?? [];
      // The fixture's non-unique, non-PK indexes normally land here at a
      // 1,000,000 scan ceiling; an empty list leaves nothing to inspect.
      if (rows.length === 0) return;

      for (const row of rows) {
        const keys = Object.keys(row).join(", ");
        if (version >= PG16) {
          assert.ok("last_idx_scan" in row, `${row.index}: last_idx_scan must be present on PG16+, got keys: ${keys}`);
          // null = never scanned since the reset, which is the common case for
          // an unused index; non-null is the ::text cast of a timestamptz.
          if (row.last_idx_scan !== null) assert.equal(typeof row.last_idx_scan, "string");
        } else {
          assert.ok(
            !("last_idx_scan" in row),
            `${row.index}: last_idx_scan must be absent below PG16 (server_version_num=${version}), got keys: ${keys}`,
          );
        }
      }
    });
  });

  describe("pg_kill", () => {
    // Poll pg_stat_activity until the target backend is actively running its
    // pg_sleep, instead of a fixed warmup sleep. A hardcoded delay is too short
    // on a slow / loaded CI host (the sleep hasn't started, so the cancel fires
    // against an idle backend and pg_cancel_backend returns true with nothing
    // in flight) and needlessly long on a fast one. Mirrors the pg_blocking_pids
    // poll the lock tests use (~77-92) and the file's note there about
    // hardcoded sleeps. Bounded by a 5s deadline; proceeds anyway on timeout so
    // a missed activation surfaces as the downstream assertion rather than a
    // hang.
    async function waitForActiveSleep(pid: number): Promise<void> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const probe = (await runInternal<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE pid = $1 AND state = 'active' AND query LIKE '%pg_sleep%'
           ) AS present`,
          [pid],
        )) as { ok: boolean; data?: { present: boolean }[] };
        if (probe.ok && probe.data?.[0]?.present === true) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Nonexistent-PID path: the tool wraps the postgres function's boolean
    // return in a `note` that explains why a `false` came back. v0.6.13
    // captures pg's NOTICE channel so the note is specific ("not a
    // PostgreSQL server process") rather than the generic three-way list.
    // We exercise with PID 1 -- guaranteed not to be a postgres backend.
    it("returns signaled=false with a NOTICE-derived note for a PID that is not a postgres backend", async () => {
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
        // postgres NOTICE for a non-backend PID: "PID 1 is not a
        // PostgreSQL backend process" (PG13+; older versions sometimes
        // said "server process"). Fall back to the generic note if the
        // running postgres doesn't emit one at all.
        assert.match(
          res.data?.note ?? "",
          /not a PostgreSQL (backend|server) process|may not exist|lacks permission/i,
          `expected a notice-derived or fallback note, got ${JSON.stringify(res.data?.note)}`,
        );
        // The PID must appear somewhere in the note so the caller can
        // correlate even if multiple pg_kill calls are in flight.
        assert.match(res.data?.note ?? "", /\b1\b/, `note must reference PID 1, got ${JSON.stringify(res.data?.note)}`);
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

        // Poll pg_stat_activity until the sleep is actually executing before we
        // cancel it -- otherwise we race the start and pg_cancel_backend returns
        // true with no in-flight statement. Mirrors the pg_blocking_pids poll
        // in the lock tests above and the comment there about a hardcoded sleep
        // being too short on a slow CI host.
        await waitForActiveSleep(targetPid);

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
        // Same poll-not-sleep rationale as the cancel variant above.
        await waitForActiveSleep(targetPid);

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
