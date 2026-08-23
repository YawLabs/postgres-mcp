import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import { adminTools } from "./admin.js";

const pgKill = adminTools.find((t) => t.name === "pg_kill")!;

describe("pg_kill ALLOW_WRITES gate", () => {
  const original = process.env.ALLOW_WRITES;
  afterEach(async () => {
    if (original === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = original;
    // Rebuild the pool singleton between tests so a stubbed connect from the
    // note-construction suite below can't leak into other suites in the same
    // runner process.
    await shutdown();
  });

  it("refuses when ALLOW_WRITES is unset", async () => {
    delete process.env.ALLOW_WRITES;
    const res = (await pgKill.handler({ pid: 1, mode: "cancel" })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /ALLOW_WRITES/);
  });

  it("refuses when ALLOW_WRITES is '0' (strict opt-in)", async () => {
    process.env.ALLOW_WRITES = "0";
    const res = (await pgKill.handler({ pid: 1, mode: "terminate" })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /ALLOW_WRITES/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pg_kill note construction WITHOUT a live DB.
//
// Follows the GAP-2 pattern in src/mcp-wrapper.test.ts: set DATABASE_URL so
// getPool() construction succeeds, then stub `pg.Pool.prototype.connect` to
// resolve a fake client (a `query` method + notice on/off no-ops + release).
// This exercises the real handler's note-construction branch -- the signaled
// boolean and the captured-NOTICE path -- with no network and no postgres.
// ─────────────────────────────────────────────────────────────────────────

type NoticeListener = (n: { message?: string }) => void;

interface FakeClientOptions {
  rows: { signaled: boolean }[];
  // Notice messages to emit synchronously during the query call, simulating
  // postgres firing a NOTICE while pg_cancel_backend / pg_terminate_backend run.
  emitNotices?: string[];
}

function makeFakeClient(opts: FakeClientOptions) {
  const noticeListeners = new Set<NoticeListener>();
  return {
    on(event: string, fn: NoticeListener) {
      if (event === "notice") noticeListeners.add(fn);
      return this;
    },
    off(event: string, fn: NoticeListener) {
      if (event === "notice") noticeListeners.delete(fn);
      return this;
    },
    async query(_sql: string, _params: unknown[]) {
      // Fire any configured NOTICEs to every registered listener before the
      // result resolves, the same ordering the real pg client uses.
      for (const message of opts.emitNotices ?? []) {
        for (const fn of noticeListeners) fn({ message });
      }
      return { rows: opts.rows };
    },
    release() {
      /* no-op */
    },
  };
}

describe("pg_kill note construction (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalAllowWrites = process.env.ALLOW_WRITES;
  const originalDbUrl = process.env.DATABASE_URL;
  let fakeClient: ReturnType<typeof makeFakeClient>;

  function installStub(opts: FakeClientOptions) {
    fakeClient = makeFakeClient(opts);
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(fakeClient);
    } as typeof pg.Pool.prototype.connect;
  }

  beforeEach(async () => {
    // Rebuild the pool against our stub. DATABASE_URL must be set or getPool()
    // throws on construction before connect() is reached.
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    process.env.ALLOW_WRITES = "1";
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("signaled=true: data.signaled is true and the note names SIGINT (cancel)", async () => {
    installStub({ rows: [{ signaled: true }] });
    const res = (await pgKill.handler({ pid: 4242, mode: "cancel" })) as {
      ok: boolean;
      data: { signaled: boolean; note: string };
    };
    assert.equal(res.ok, true);
    assert.equal(res.data.signaled, true);
    assert.match(res.data.note, /SIGINT/);
  });

  it("signaled=true: terminate names SIGTERM", async () => {
    installStub({ rows: [{ signaled: true }] });
    const res = (await pgKill.handler({ pid: 4242, mode: "terminate" })) as {
      ok: boolean;
      data: { signaled: boolean; note: string };
    };
    assert.equal(res.ok, true);
    assert.equal(res.data.signaled, true);
    assert.match(res.data.note, /SIGTERM/);
  });

  it("signaled=false with an emitted notice: the note includes the notice text", async () => {
    const noticeText = "PID 9999 is not a PostgreSQL server process";
    installStub({ rows: [{ signaled: false }], emitNotices: [noticeText] });
    const res = (await pgKill.handler({ pid: 9999, mode: "cancel" })) as {
      ok: boolean;
      data: { signaled: boolean; note: string };
    };
    assert.equal(res.ok, true);
    assert.equal(res.data.signaled, false);
    assert.match(res.data.note, new RegExp(noticeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pg_advisor wraparound_risk WITHOUT a live DB.
//
// Same stubbed-connect pattern as the pg_kill suite above, with one addition:
// getServerVersionNum() probes through the POOL, not through the shared
// client, so pg.Pool.prototype.query has to be stubbed too. Leaving it alone
// would send the version probe at the real DATABASE_URL host and hang the
// suite on a connect timeout.
// ─────────────────────────────────────────────────────────────────────────

const pgAdvisor = adminTools.find((t) => t.name === "pg_advisor")!;

/**
 * Which fanout sub-query a given SQL string is. Ordered most-specific first:
 * the wraparound tables/databases queries also mention
 * `autovacuum_freeze_max_age`, so the bare-GUC check has to come last or it
 * would swallow them.
 */
type AdvisorCategory = "wrapTables" | "wrapDatabases" | "sequences" | "noPk" | "rls" | "wrapGuc" | "unknown";

function categorize(sql: string): AdvisorCategory {
  if (sql.includes("relfrozenxid")) return "wrapTables";
  if (sql.includes("datfrozenxid")) return "wrapDatabases";
  if (sql.includes("pg_sequences")) return "sequences";
  if (sql.includes("indisprimary")) return "noPk";
  if (sql.includes("relrowsecurity")) return "rls";
  if (sql.includes("autovacuum_freeze_max_age")) return "wrapGuc";
  return "unknown";
}

function rowsFor(sql: string): Record<string, unknown>[] {
  switch (categorize(sql)) {
    case "wrapTables":
      return [
        {
          schema: "pg_toast",
          table: "pg_toast_16385",
          relkind: "t",
          xid_age: 150_000_000,
          freeze_max_age: 200_000_000,
          pct_of_freeze_max_age: 0.75,
          // Over the threshold on BOTH counters, so triggered_by is 'both'.
          mxid_age: 300_000_000,
          multixact_freeze_max_age: 400_000_000,
          pct_of_multixact_freeze_max_age: 0.75,
          triggered_by: "both",
          // Mirror the server: the freeze-coverage columns come back only
          // when the handler actually named relallfrozen (the PG18+ gate).
          ...(sql.includes("relallfrozen") ? { pages: 10, all_frozen_pages: 4, frozen_page_fraction: 0.4 } : {}),
        },
      ];
    case "wrapDatabases":
      // Deliberately the gap this coverage exists for: a healthy 6%
      // age(datfrozenxid) alongside a 95% multixact age. Under the old
      // xid-only filter this database was reported clean.
      return [
        {
          database: "postgres",
          xid_age: 12_000_000,
          mxid_age: 380_000_000,
          pct_of_freeze_max_age: 0.06,
          pct_of_multixact_freeze_max_age: 0.95,
          triggered_by: "multixact",
        },
      ];
    case "wrapGuc":
      return [{ autovacuum_freeze_max_age: 200_000_000, autovacuum_multixact_freeze_max_age: 400_000_000 }];
    case "sequences":
      return [{ schema: "public", sequence: "users_id_seq", last_value: "900", max_value: "1000", pct_used: 0.9 }];
    case "noPk":
      return [{ schema: "public", table: "events" }];
    case "rls":
      return [{ schema: "public", table: "events" }];
    default:
      return [];
  }
}

interface AdvisorResponse {
  ok: boolean;
  data: {
    sequence_exhaustion: Record<string, unknown>[];
    wraparound_risk: {
      autovacuum_freeze_max_age: number | null;
      autovacuum_multixact_freeze_max_age: number | null;
      databases: Record<string, unknown>[];
      tables: Record<string, unknown>[];
    };
    tables_without_primary_key: Record<string, unknown>[];
    public_tables_without_rls: Record<string, unknown>[];
    _warnings?: string[];
  };
}

describe("pg_advisor wraparound_risk (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let seen: { sql: string; params: unknown[] }[] = [];

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   * @param failing categories whose sub-query throws, standing in for the
   *   permission-gated catalogs on managed providers.
   */
  function installStub(versionNum: number | null, failing: AdvisorCategory[] = []) {
    seen = [];
    pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
      if (versionNum === null) return Promise.reject(new Error("version probe unavailable"));
      const text = typeof sql === "string" ? sql : "";
      return Promise.resolve({ rows: text.includes("server_version_num") ? [{ v: String(versionNum) }] : [] });
    } as unknown as typeof pg.Pool.prototype.query;

    const client = {
      async query(sql: string, params: unknown[] = []) {
        seen.push({ sql, params });
        if (failing.includes(categorize(sql))) throw new Error("permission denied");
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

  function sqlFor(category: AdvisorCategory): string {
    return seen.find((q) => categorize(q.sql) === category)?.sql ?? "";
  }

  beforeEach(async () => {
    // shutdown() also clears the cached server_version_num, so each test's
    // stubbed version is actually probed instead of reusing the previous
    // test's value.
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

  it("PG18: names relallfrozen and returns the freeze-coverage keys", async () => {
    installStub(180_000);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.ok, true);
    assert.match(sqlFor("wrapTables"), /relallfrozen/);
    const row = res.data.wraparound_risk.tables[0] ?? {};
    assert.equal(row.all_frozen_pages, 4);
    assert.equal(row.frozen_page_fraction, 0.4);
  });

  it("PG15: relallfrozen is never named, and the coverage keys are absent (not null)", async () => {
    installStub(150_000);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    const sql = sqlFor("wrapTables");
    assert.ok(sql.length > 0, "the wraparound tables sub-query should still run on PG15");
    assert.doesNotMatch(sql, /relallfrozen/);
    const row = res.data.wraparound_risk.tables[0] ?? {};
    // Absent, not null: `frozen_page_fraction: null` would read as "nothing
    // is frozen" rather than "this server cannot report coverage".
    assert.equal("frozen_page_fraction" in row, false);
    // The age numbers that DO exist on PG15 still come back.
    assert.equal(row.xid_age, 150_000_000);
  });

  it("version probe failure falls through to the pre-PG18 shape", async () => {
    installStub(null);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.ok, true);
    assert.doesNotMatch(sqlFor("wrapTables"), /relallfrozen/);
    assert.equal(res.data.wraparound_risk.tables.length, 1);
  });

  it("a failed wraparound sub-query warns without short-circuiting the rest", async () => {
    installStub(180_000, ["wrapTables"]);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.ok, true);
    assert.match((res.data._warnings ?? []).join("\n"), /wraparound_risk\.tables fetch failed/);
    assert.deepEqual(res.data.wraparound_risk.tables, []);
    // Everything else still returns -- partial failure is the expected path on
    // permission-gated managed providers, not a reason to lose the answer.
    assert.equal(res.data.wraparound_risk.databases.length, 1);
    assert.equal(res.data.wraparound_risk.autovacuum_freeze_max_age, 200_000_000);
    assert.equal(res.data.sequence_exhaustion.length, 1);
    assert.equal(res.data.tables_without_primary_key.length, 1);
    assert.equal(res.data.public_tables_without_rls.length, 1);
  });

  it("surfaces autovacuum_freeze_max_age even when every category around it fails", async () => {
    installStub(150_000, ["wrapTables", "wrapDatabases", "sequences", "noPk", "rls"]);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.ok, true);
    assert.equal(res.data.wraparound_risk.autovacuum_freeze_max_age, 200_000_000);
    assert.equal((res.data._warnings ?? []).length, 5);
  });

  it("a failed GUC read leaves autovacuum_freeze_max_age null rather than absent", async () => {
    installStub(150_000, ["wrapGuc"]);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal("autovacuum_freeze_max_age" in res.data.wraparound_risk, true);
    assert.equal(res.data.wraparound_risk.autovacuum_freeze_max_age, null);
    assert.match((res.data._warnings ?? []).join("\n"), /autovacuum_freeze_max_age fetch failed/);
  });

  it("re-applies the Zod defaults for direct callers that pass no input", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    // Direct (non-MCP) callers bypass Zod, so an un-defaulted
    // wraparoundThreshold would bind undefined into `>= $1` and error.
    for (const category of ["wrapTables", "wrapDatabases"] as const) {
      const q = seen.find((s) => categorize(s.sql) === category);
      assert.deepEqual(q?.params, [0.5, 50], `${category} should bind the re-applied defaults`);
    }
  });

  it("passes an explicit wraparoundThreshold through to both wraparound queries", async () => {
    installStub(180_000);
    await pgAdvisor.handler({ wraparoundThreshold: 0.9, limit: 5 });
    for (const category of ["wrapTables", "wrapDatabases"] as const) {
      const q = seen.find((s) => categorize(s.sql) === category);
      assert.deepEqual(q?.params, [0.9, 5], `${category} should bind the caller's threshold`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // Multixact coverage. A cluster can hit autovacuum_multixact_freeze_max_age
  // with a perfectly healthy relfrozenxid -- multixacts are consumed by
  // row-level locking (SELECT ... FOR SHARE/UPDATE, FK checks), not by
  // transaction volume -- so an xid-only advisor reports a lock-heavy cluster
  // as clean right up to the multixact shutdown.
  // ───────────────────────────────────────────────────────────────────────

  it("measures multixact age in the SAME sub-queries, adding no round trip", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    assert.match(sqlFor("wrapTables"), /mxid_age\(c\.relminmxid\)/);
    assert.match(sqlFor("wrapDatabases"), /mxid_age\(d\.datminmxid\)/);
    // Six sub-queries, same as before the multixact columns existed: the
    // multixact numbers ride along in the existing scans rather than costing
    // the caller a seventh connection-bound query.
    assert.equal(seen.length, 6);
  });

  it("PG15: the multixact columns are NOT version-gated the way relallfrozen is", async () => {
    // mxid_age(), relminmxid, datminmxid and the GUC all predate PG15, so
    // unlike relallfrozen they must be named unconditionally -- gating them
    // would silently drop multixact coverage on every supported server.
    installStub(150_000);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.ok, true);
    assert.doesNotMatch(sqlFor("wrapTables"), /relallfrozen/);
    assert.match(sqlFor("wrapTables"), /relminmxid/);
    assert.match(sqlFor("wrapDatabases"), /datminmxid/);
  });

  it("exposes autovacuum_multixact_freeze_max_age as the second divisor", async () => {
    installStub(150_000);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.data.wraparound_risk.autovacuum_multixact_freeze_max_age, 400_000_000);
    // Both divisors come from one row, so one query failure loses both.
    assert.equal(res.data.wraparound_risk.autovacuum_freeze_max_age, 200_000_000);
  });

  it("a failed GUC read leaves autovacuum_multixact_freeze_max_age null rather than absent", async () => {
    installStub(150_000, ["wrapGuc"]);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    // Absent would serialize away and read as "no multixact pressure" instead
    // of "the divisor was never readable".
    assert.equal("autovacuum_multixact_freeze_max_age" in res.data.wraparound_risk, true);
    assert.equal(res.data.wraparound_risk.autovacuum_multixact_freeze_max_age, null);
  });

  it("resolves the per-table multixact override before falling back to the GUC", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    const sql = sqlFor("wrapTables");
    // Same pg_options_to_table LATERAL pattern the xid path uses: a table with
    // a LOWERED autovacuum_multixact_freeze_max_age is already being
    // force-vacuumed while it still reads as safe against the cluster default.
    assert.match(sql, /option_name = 'autovacuum_multixact_freeze_max_age'/);
    assert.match(sql, /current_setting\('autovacuum_multixact_freeze_max_age'\)/);
  });

  it("guards InvalidMultiXactId without dropping the row from the xid check", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    const sql = sqlFor("wrapTables");
    // relminmxid is catalog-typed `xid` despite holding a MultiXactId, so the
    // guard mirrors the relfrozenxid one -- but as a CASE yielding NULL, not
    // as another AND. An AND would drop relations that never recorded a
    // multixact even when their relfrozenxid is the dangerous one.
    assert.match(sql, /CASE WHEN c\.relminmxid <> '0'::xid THEN mxid_age\(c\.relminmxid\) END/);
    assert.doesNotMatch(sql, /AND c\.relminmxid <> '0'::xid/);
    assert.match(sqlFor("wrapDatabases"), /CASE WHEN d\.datminmxid <> '0'::xid THEN mxid_age\(d\.datminmxid\) END/);
  });

  it("flags on EITHER counter and orders by the greater ratio", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    for (const category of ["wrapTables", "wrapDatabases"] as const) {
      const sql = sqlFor(category);
      // OR, not AND: a row must not be dropped just because only one of the
      // two counters is dangerous.
      assert.match(sql, /r\.xid_ratio >= \$1 OR r\.mxid_ratio >= \$1/, `${category} should filter on either ratio`);
      // With an OR filter, ordering by xid age alone would sort a
      // multixact-critical row below the LIMIT cut and hide it entirely.
      assert.match(sql, /ORDER BY GREATEST\(r\.xid_ratio, r\.mxid_ratio\) DESC/, `${category} should rank on both`);
    }
  });

  it("reuses wraparoundThreshold for both ratios instead of binding a second parameter", async () => {
    installStub(180_000);
    await pgAdvisor.handler({ wraparoundThreshold: 0.8, limit: 25 });
    for (const category of ["wrapTables", "wrapDatabases"] as const) {
      const q = seen.find((s) => categorize(s.sql) === category);
      assert.deepEqual(q?.params, [0.8, 25], `${category} should still bind exactly two params`);
      assert.doesNotMatch(q?.sql ?? "", /\$3/, `${category} should not add a multixact-only threshold`);
    }
  });

  it("triggered_by tells the operator which counter to chase", async () => {
    installStub(180_000);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    // The database row is the gap case: 6% of the xid budget, 95% of the
    // multixact budget. Reported, and labelled so the operator looks at the
    // row-locking workload rather than at freezing.
    const db = res.data.wraparound_risk.databases[0] ?? {};
    assert.equal(db.triggered_by, "multixact");
    assert.equal(db.mxid_age, 380_000_000);
    assert.equal(db.pct_of_multixact_freeze_max_age, 0.95);
    // The table row is over on both counters, so neither remediation is
    // optional and the label says so.
    const table = res.data.wraparound_risk.tables[0] ?? {};
    assert.equal(table.triggered_by, "both");
    assert.equal(table.mxid_age, 300_000_000);
    assert.equal(table.multixact_freeze_max_age, 400_000_000);
  });

  it("falls through to 'xid' when the multixact ratio is NULL", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    for (const category of ["wrapTables", "wrapDatabases"] as const) {
      // triggered_by is computed server-side, so the guarantee lives in the
      // CASE arm order: a row whose minmxid was InvalidMultiXactId has a NULL
      // mxid_ratio, `NULL >= $1` is NULL (never true), and both multixact arms
      // are skipped. The bare ELSE -- not a third `WHEN r.xid_ratio >= $1` --
      // is what keeps that row labelled rather than NULL.
      assert.match(
        sqlFor(category),
        /WHEN r\.mxid_ratio >= \$1 THEN 'multixact'\s+ELSE 'xid'/,
        `${category} should label an unevaluable multixact row as xid-triggered`,
      );
    }
  });
});
