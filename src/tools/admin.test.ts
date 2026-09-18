import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import { initAudit, resetAuditForTests, setAuditSinkForTests } from "../audit.js";
import { wrapToolHandler } from "../mcp-wrapper.js";
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
  // Reject the query with this instead of resolving `rows`, for the path where
  // postgres RAISES (as opposed to returning signaled=false).
  rejectWith?: Error;
}

function makeFakeClient(opts: FakeClientOptions) {
  const noticeListeners = new Set<NoticeListener>();
  // Every statement the handler sent, so a test can assert the pid still went
  // out as a bound parameter and not interpolated into the text.
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    on(event: string, fn: NoticeListener) {
      if (event === "notice") noticeListeners.add(fn);
      return this;
    },
    off(event: string, fn: NoticeListener) {
      if (event === "notice") noticeListeners.delete(fn);
      return this;
    },
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      // Fire any configured NOTICEs to every registered listener before the
      // result resolves, the same ordering the real pg client uses.
      for (const message of opts.emitNotices ?? []) {
        for (const fn of noticeListeners) fn({ message });
      }
      if (opts.rejectWith) throw opts.rejectWith;
      return { rows: opts.rows };
    },
    release() {
      /* no-op */
    },
    // acquireClient() attaches an 'error' listener for the checked-out lifetime
    // through `on` above (any non-notice event is ignored) and removes it here.
    removeListener() {
      return this;
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
    } as unknown as typeof pg.Pool.prototype.connect;
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
// pg_kill audit line (#39).
//
// pg_kill cannot go through runInternal / withSharedClient -- it needs the raw
// client for the NOTICE listener -- so it queried that client directly and the
// statement never reached auditQuery. Cancelling or terminating ANOTHER session
// was the one action the trail could not show.
//
// Driven through wrapToolHandler with `pgKill.name`, the exact pairing
// index.ts registers, because the `tool` field only exists if the handler's
// statement runs inside that wrapper's async context: asserting on the bare
// handler would prove a line is written and say nothing about attribution.
// Delete the auditQuery wrapper in admin.ts and every test here that expects a
// line goes red on the line count (checked: five fail; the ALLOW_WRITES one
// asserts NO line and holds either way).
// ─────────────────────────────────────────────────────────────────────────

const AUDIT_ENV = ["POSTGRES_AUDIT_LOG", "POSTGRES_AUDIT_LOG_FILE", "POSTGRES_AUDIT_REDACT"] as const;

describe("pg_kill audit line (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalAllowWrites = process.env.ALLOW_WRITES;
  const originalDbUrl = process.env.DATABASE_URL;
  let auditEnvSnapshot: Record<string, string | undefined> = {};
  let fakeClient: ReturnType<typeof makeFakeClient>;
  let lines: string[];

  // Seven digits on purpose: no `ts` or `ms` value can contain the run by
  // accident, so its absence from the raw line is a real statement about the
  // pid and not luck.
  const PID = 4191234;

  const killViaWrapper = wrapToolHandler(pgKill.handler as (input: unknown) => Promise<unknown>, pgKill.name);

  function installStub(opts: FakeClientOptions) {
    fakeClient = makeFakeClient(opts);
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(fakeClient);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  function onlyLine(): { raw: string; entry: Record<string, unknown> } {
    assert.equal(lines.length, 1, `expected exactly one audit line per signal call, got ${JSON.stringify(lines)}`);
    const raw = lines[0]!;
    return { raw, entry: JSON.parse(raw) as Record<string, unknown> };
  }

  beforeEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    process.env.ALLOW_WRITES = "1";
    // Cleared first, then set. The capture sink installed below replaces
    // whatever initAudit() opens, so an ambient POSTGRES_AUDIT_LOG_FILE cannot
    // take the lines -- but initAudit() would still open (and create) that
    // file, or throw in this hook on an unopenable path. The one that fails
    // assertions is an ambient POSTGRES_AUDIT_REDACT=1: it swaps `sql` for
    // sqlKeyword/sqlSha256, and the `entry.sql` checks go red for a reason
    // that has nothing to do with pg_kill.
    auditEnvSnapshot = {};
    for (const name of AUDIT_ENV) {
      auditEnvSnapshot[name] = process.env[name];
      delete process.env[name];
    }
    // api.ts ran initAudit() at import with auditing off; reset so this env is
    // the one that gets read.
    resetAuditForTests();
    process.env.POSTGRES_AUDIT_LOG = "1";
    initAudit();
    lines = [];
    setAuditSinkForTests((line) => {
      lines.push(line);
    });
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    resetAuditForTests();
    for (const name of AUDIT_ENV) {
      const original = auditEnvSnapshot[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("writes exactly one line per signal call, attributed to pg_kill", async () => {
    installStub({ rows: [{ signaled: true }] });
    const res = await killViaWrapper({ pid: PID, mode: "cancel" });
    assert.notEqual(res.isError, true, `pg_kill itself failed: ${JSON.stringify(res)}`);

    const { entry } = onlyLine();
    assert.equal(entry.tool, "pg_kill");
    assert.equal(entry.sql, "SELECT pg_cancel_backend($1) AS signaled");
    assert.equal(entry.ok, true);
    assert.equal(entry.rows, 1);
    // "internal": the server composes this statement and the agent supplies
    // only a bound value. See the comment at the auditQuery call in admin.ts.
    assert.equal(entry.source, "internal");
  });

  it("logs the parameter COUNT and never the pid value", async () => {
    installStub({ rows: [{ signaled: true }] });
    await killViaWrapper({ pid: PID, mode: "cancel" });

    const { raw, entry } = onlyLine();
    assert.equal(entry.params, 1);
    assert.equal(raw.includes(String(PID)), false, `the pid value reached the audit line: ${raw}`);
    // The audit wrap must not have changed what is SENT: still one statement,
    // with the pid bound rather than interpolated into the text.
    assert.deepEqual(fakeClient.calls, [{ sql: "SELECT pg_cancel_backend($1) AS signaled", params: [PID] }]);
  });

  it("names pg_terminate_backend on a terminate, so the two modes read differently in the trail", async () => {
    installStub({ rows: [{ signaled: true }] });
    await killViaWrapper({ pid: PID, mode: "terminate" });
    assert.equal(onlyLine().entry.sql, "SELECT pg_terminate_backend($1) AS signaled");
  });

  it("still captures the NOTICE with auditing on, and signaled=false is an ok:true line", async () => {
    const noticeText = "PID 4191234 is not a PostgreSQL backend process";
    installStub({ rows: [{ signaled: false }], emitNotices: [noticeText] });
    const res = await killViaWrapper({ pid: PID, mode: "cancel" });

    const data = res.structuredContent as { signaled: boolean; note: string };
    assert.equal(data.signaled, false);
    assert.ok(data.note.includes(noticeText), `the NOTICE was lost from the note: ${data.note}`);

    // postgres answered `false` rather than raising, so the STATEMENT ran. The
    // line says that and no more -- and the NOTICE text, which quotes the pid,
    // stays out of it like every other server message.
    const { raw, entry } = onlyLine();
    assert.equal(entry.ok, true);
    assert.equal("sqlstate" in entry, false);
    assert.equal(raw.includes("PostgreSQL backend process"), false, `NOTICE text reached the audit line: ${raw}`);
  });

  it("records ok:false with the SQLSTATE when postgres raises, and still returns the error", async () => {
    const message = "permission denied to terminate process 4191234";
    installStub({ rows: [], rejectWith: Object.assign(new Error(message), { code: "42501" }) });
    const res = await killViaWrapper({ pid: PID, mode: "terminate" });

    assert.equal(res.isError, true);
    assert.ok(res.content[0]!.text.includes("permission denied"), `error text was lost: ${res.content[0]!.text}`);

    const { raw, entry } = onlyLine();
    assert.equal(entry.tool, "pg_kill");
    assert.equal(entry.ok, false);
    assert.equal(entry.sqlstate, "42501");
    assert.equal(entry.rows, null);
    assert.equal(raw.includes("permission denied"), false, `the error message reached the audit line: ${raw}`);
  });

  it("writes no line when the ALLOW_WRITES gate refuses, because no statement is sent", async () => {
    process.env.ALLOW_WRITES = "0";
    installStub({ rows: [{ signaled: true }] });
    const res = await killViaWrapper({ pid: PID, mode: "cancel" });
    assert.equal(res.isError, true);
    assert.deepEqual(lines, []);
    assert.deepEqual(fakeClient.calls, []);
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
      // acquireClient() attaches an 'error' listener for the checked-out lifetime.
      on() {
        return this;
      },
      removeListener() {
        return this;
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
// ─────────────────────────────────────────────────────────────────────────
// pg_table_bloat PG19 stats_reset gate WITHOUT a live DB.
//
// Unlike the two suites above, this tool runs through runInternal
// (pool.query) rather than withSharedClient, so the POOL query stub is the
// only seam -- there is no connect() to intercept. getServerVersionNum()
// probes through that same seam, so one dispatcher serves both.
// ─────────────────────────────────────────────────────────────────────────

const pgTableBloat = adminTools.find((t) => t.name === "pg_table_bloat")!;

type BloatCategory = "version" | "extension" | "pgstattuple" | "estimate" | "unknown";

function categorizeBloat(sql: string): BloatCategory {
  if (sql.includes("server_version_num")) return "version";
  // Ordered before the pgstattuple query: the extension probe also mentions
  // pgstattuple, as a value rather than as a function call.
  if (sql.includes("pg_catalog.pg_extension")) return "extension";
  if (sql.includes("CROSS JOIN LATERAL")) return "pgstattuple";
  if (sql.includes("pg_catalog.pg_stat_user_tables")) return "estimate";
  return "unknown";
}

const STUB_STATS_RESET = "2026-08-01 00:00:00+00";

function bloatRowsFor(sql: string): Record<string, unknown>[] {
  switch (categorizeBloat(sql)) {
    case "extension":
      return [{ installed: true }];
    case "pgstattuple":
    case "estimate":
      return [
        {
          schema: "public",
          table: "events",
          live_tuples: "1000",
          dead_tuples: "500",
          dead_ratio: 0.333,
          size_pretty: "8192 bytes",
          size_bytes: "8192",
          last_vacuum: null,
          last_autovacuum: null,
          last_analyze: null,
          // Mirror the server: the column comes back only when the handler
          // actually named it, which is the whole point of the version gate.
          ...(sql.includes("stats_reset") ? { stats_reset: STUB_STATS_RESET } : {}),
        },
      ];
    default:
      return [];
  }
}

describe("pg_table_bloat stats_reset gate (stubbed pool, no live DB)", () => {
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let seen: string[] = [];

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   */
  function installStub(versionNum: number | null) {
    seen = [];
    pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
      const text = typeof sql === "string" ? sql : "";
      seen.push(text);
      if (categorizeBloat(text) === "version") {
        return versionNum === null
          ? Promise.reject(new Error("version probe unavailable"))
          : Promise.resolve({ rows: [{ v: String(versionNum) }] });
      }
      return Promise.resolve({ rows: bloatRowsFor(text) });
    } as unknown as typeof pg.Pool.prototype.query;
  }

  function sqlFor(category: BloatCategory): string {
    return seen.find((sql) => categorizeBloat(sql) === category) ?? "";
  }

  beforeEach(async () => {
    // shutdown() clears the cached server_version_num, so each case's stubbed
    // version is actually probed instead of reusing the previous case's.
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  });

  afterEach(async () => {
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("PG19: names stats_reset and returns it on the row", async () => {
    installStub(190_000);
    const res = (await pgTableBloat.handler({})) as { ok: boolean; data?: Record<string, unknown>[] };
    assert.equal(res.ok, true);
    assert.ok(sqlFor("estimate").includes("stats_reset::text AS stats_reset"), "PG19 should name stats_reset");
    assert.equal(res.data?.[0]?.stats_reset, STUB_STATS_RESET);
  });

  it("PG18: stats_reset is never named, and the key is absent (not null)", async () => {
    installStub(180_000);
    const res = (await pgTableBloat.handler({})) as { ok: boolean; data?: Record<string, unknown>[] };
    const sql = sqlFor("estimate");
    assert.ok(sql.length > 0, "the bloat query should still run on PG18");
    // Naming a column the server lacks is a 42703 that fails the whole tool,
    // so the gate has to keep the identifier out of the statement entirely --
    // not merely ignore the value that comes back.
    assert.equal(sql.includes("stats_reset"), false);
    const rows = res.data ?? [];
    assert.equal(rows.length, 1);
    // Absent, not null. On a PG18 server `stats_reset: null` would read as
    // "these counters have never been reset" -- a real and reassuring fact --
    // rather than "this server cannot report it".
    assert.equal("stats_reset" in rows[0], false);
    // The columns that DO exist on PG18 still come back.
    assert.equal(rows[0].dead_tuples, "500");
  });

  it("version probe failure falls through to the pre-PG19 shape", async () => {
    installStub(null);
    const res = (await pgTableBloat.handler({})) as { ok: boolean; data?: Record<string, unknown>[] };
    // The "assume oldest" 0 must degrade the answer, never break it: a failed
    // probe that guessed PG19 would lose the entire bloat report to a 42703.
    assert.equal(res.ok, true);
    assert.equal(sqlFor("estimate").includes("stats_reset"), false);
    assert.equal(res.data?.length, 1);
  });

  it("the pgstattuple methods return the same row shape as estimate on the same server", async () => {
    for (const method of ["approx", "exact"] as const) {
      installStub(190_000);
      const res = (await pgTableBloat.handler({ method })) as { ok: boolean; data?: Record<string, unknown>[] };
      assert.equal(res.ok, true, `method=${method} should succeed`);
      // Alias-qualified because this query joins pg_stat_user_tables as `s`.
      // Getting the qualifier wrong is a 42P01/42703 rather than a silent
      // miss, but an un-gated method would be worse: a caller comparing an
      // estimate run against an exact one would watch the key appear and
      // disappear with the method rather than with the server version.
      assert.ok(
        sqlFor("pgstattuple").includes("s.stats_reset::text AS stats_reset"),
        `method=${method} should name the aliased stats_reset`,
      );
      assert.equal(res.data?.[0]?.stats_reset, STUB_STATS_RESET);
    }
  });
});
