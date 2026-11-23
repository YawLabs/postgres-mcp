import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { shutdown } from "../api.js";
import { initAudit, resetAuditForTests, setAuditSinkForTests } from "../audit.js";
import { wrapToolHandler } from "../mcp-wrapper.js";
import { stubClient, stubConnect, stubPoolQuery, useStubbedPool } from "../test-helpers/pool-stub.js";
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

/** Hands every checkout the same makeFakeClient(opts) and returns it, so a test can read its calls. */
function installKillStub(opts: FakeClientOptions): ReturnType<typeof makeFakeClient> {
  const client = makeFakeClient(opts);
  stubConnect(() => client);
  return client;
}

describe("pg_kill note construction (stubbed connect, no live DB)", () => {
  const originalAllowWrites = process.env.ALLOW_WRITES;

  function installStub(opts: FakeClientOptions) {
    installKillStub(opts);
  }

  // Rebuilds the pool against the stub. DATABASE_URL must be set or getPool()
  // throws on construction before connect() is reached.
  useStubbedPool();

  beforeEach(() => {
    process.env.ALLOW_WRITES = "1";
  });

  afterEach(() => {
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
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
// line goes red on the line count (the seven that call onlyLine()). Two hold either way, by
// design: the ALLOW_WRITES one asserts NO line, and the README one checks what
// is SENT, not what is logged.
// ─────────────────────────────────────────────────────────────────────────

const AUDIT_ENV = ["POSTGRES_AUDIT_LOG", "POSTGRES_AUDIT_LOG_FILE", "POSTGRES_AUDIT_REDACT"] as const;

describe("pg_kill audit line (stubbed connect, no live DB)", () => {
  const originalAllowWrites = process.env.ALLOW_WRITES;
  let auditEnvSnapshot: Record<string, string | undefined> = {};
  let fakeClient: ReturnType<typeof makeFakeClient>;
  let lines: string[];

  // Seven digits on purpose: no `ts` or `ms` value can contain the run by
  // accident, so its absence from the raw line is a real statement about the
  // pid and not luck.
  const PID = 4191234;

  const killViaWrapper = wrapToolHandler(pgKill.handler as (input: unknown) => Promise<unknown>, pgKill.name);

  function installStub(opts: FakeClientOptions) {
    fakeClient = installKillStub(opts);
  }

  function onlyLine(): { raw: string; entry: Record<string, unknown> } {
    assert.equal(lines.length, 1, `expected exactly one audit line per signal call, got ${JSON.stringify(lines)}`);
    const raw = lines[0]!;
    return { raw, entry: JSON.parse(raw) as Record<string, unknown> };
  }

  useStubbedPool();

  beforeEach(() => {
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

  afterEach(() => {
    resetAuditForTests();
    for (const name of AUDIT_ENV) {
      const original = auditEnvSnapshot[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
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

  it("a refused connection still writes the signal statement's ok:false line (#42)", async () => {
    // The checkout sits inside the audited call, so a pool that refuses a
    // connection leaves the line for the statement that never went out. With
    // the checkout before the audit, this call wrote nothing.
    stubConnect(() =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })),
    );
    const res = await killViaWrapper({ pid: PID, mode: "terminate" });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /ECONNREFUSED/);

    const { raw, entry } = onlyLine();
    assert.equal(entry.tool, "pg_kill");
    assert.equal(entry.source, "internal");
    assert.equal(entry.sql, "SELECT pg_terminate_backend($1) AS signaled");
    assert.equal(entry.params, 1);
    assert.equal(raw.includes(String(PID)), false, `the pid value reached the audit line: ${raw}`);
    assert.equal(entry.ok, false);
    assert.equal(entry.rows, null);
    assert.equal(entry.sqlstate, "ECONNREFUSED");
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

  // The README quotes both statement texts verbatim. Under
  // POSTGRES_AUDIT_REDACT the two modes log the same sqlKeyword (SELECT) and
  // differ only in sqlSha256, so those texts are what an operator hashes to
  // tell a cancel line from a terminate line -- one character of drift and the
  // hash they compute matches nothing. The text is taken from what the handler
  // SENDS, not from a literal here, so a change to the statement in admin.ts
  // fails this until the README follows.
  it("README quotes the exact statement text of both modes", async () => {
    // Runs from dist/tools/, two levels below the repo root.
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    for (const mode of ["cancel", "terminate"] as const) {
      installStub({ rows: [{ signaled: true }] });
      await killViaWrapper({ pid: PID, mode });
      const sent = fakeClient.calls[0]!.sql;
      assert.ok(readme.includes(`\`${sent}\``), `README.md does not quote pg_kill's ${mode} statement: ${sent}`);
    }
  });

  // The README says a redacted pg_kill line reads sqlKeyword SELECT in both
  // modes. resetAuditForTests() + a fresh initAudit() is what makes
  // POSTGRES_AUDIT_REDACT take effect here; the suite's beforeEach cleared it.
  it("under POSTGRES_AUDIT_REDACT both modes log SELECT and differ only in the hash", async () => {
    resetAuditForTests();
    process.env.POSTGRES_AUDIT_REDACT = "1";
    initAudit();
    setAuditSinkForTests((line) => {
      lines.push(line);
    });

    const hashes: string[] = [];
    for (const mode of ["cancel", "terminate"] as const) {
      lines.length = 0;
      installStub({ rows: [{ signaled: true }] });
      await killViaWrapper({ pid: PID, mode });
      const { entry } = onlyLine();
      assert.equal("sql" in entry, false, "redaction must drop the statement text");
      assert.equal(entry.sqlKeyword, "SELECT");
      assert.equal(entry.sqlSha256, createHash("sha256").update(fakeClient.calls[0]!.sql).digest("hex"));
      hashes.push(entry.sqlSha256 as string);
    }
    assert.notEqual(hashes[0], hashes[1], "cancel and terminate must stay distinguishable under redaction");
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
// pg_kill's checkout carries an 'error' listener (#57).
//
// pg-pool removes its idle 'error' listener while a client is checked out, and
// node-pg emits 'error' on the client when its socket dies -- from a socket
// callback, outside the handler's stack. With no listener that emit is an
// uncaught exception. 0.13.2 fixed it for every checkout that went through
// acquireClient(); pg_kill called getPool().connect() itself and was missed.
// Measured: a connection dropped while pg_kill's query was in flight ended the
// process 7 of 7, where the same drop under pg_readonly kept serving.
//
// A real EventEmitter stands in for the client (as in mcp-wrapper.test.ts)
// because the makeFakeClient above cannot see this: its `on` ignores every
// event but `notice`. The assertions are on the LISTENER, not on the tool
// result: an emit made inside `query` would throw into pg_kill's own catch and
// come back as the same { ok: false } with or without the fix.
// ─────────────────────────────────────────────────────────────────────────
describe("pg_kill's checkout carries an 'error' listener (stubbed connect, no live DB)", () => {
  class EmitterClient extends EventEmitter {
    errorListenersDuringQuery = -1;
    releases = 0;
    dieMidQuery = false;
    async query(_sql: string, _params: unknown[]) {
      this.errorListenersDuringQuery = this.listenerCount("error");
      if (this.dieMidQuery) {
        const dead = new Error("Connection terminated unexpectedly");
        // What node-pg does: fail the query in flight, then emit on the client
        // from the socket callback -- NOT from inside this call's stack.
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            this.emit("error", dead);
            resolve();
          });
        });
        throw dead;
      }
      return { rows: [{ signaled: true }], rowCount: 1 };
    }
    release() {
      this.releases += 1;
    }
  }

  const originalAllowWrites = process.env.ALLOW_WRITES;
  const originalError = console.error;
  let client: EmitterClient;
  let logged: string[];

  useStubbedPool();

  beforeEach(() => {
    process.env.ALLOW_WRITES = "1";
    client = new EmitterClient();
    logged = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    stubConnect(() => client);
  });

  afterEach(() => {
    console.error = originalError;
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
  });

  it("attached while the signal runs, removed after release, and the NOTICE listener with it", async () => {
    assert.equal(client.listenerCount("error"), 0);
    const res = (await pgKill.handler({ pid: 4242, mode: "cancel" })) as { ok: boolean };
    assert.equal(res.ok, true);
    assert.equal(client.errorListenersDuringQuery, 1, "no 'error' listener while pg_kill had the client checked out");
    assert.equal(client.listenerCount("error"), 0, "the 'error' listener outlived the checkout");
    assert.equal(client.listenerCount("notice"), 0, "the 'notice' listener outlived the checkout");
    assert.equal(client.releases, 1);
  });

  it("a socket death mid-signal is logged and returned as an error, not thrown out of the process", async () => {
    client.dieMidQuery = true;
    const res = (await pgKill.handler({ pid: 4242, mode: "terminate" })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Connection terminated unexpectedly/);
    assert.deepEqual(logged, [
      "[postgres-mcp] connection error on a checked-out client: Connection terminated unexpectedly",
    ]);
    assert.equal(client.releases, 1, "the dead client must still be handed back so the pool can drop it");
    assert.equal(client.listenerCount("error"), 0);
  });
});

// The structural half of #57: acquireClient() is the only place a client may be
// checked out, because it is the only place the 'error' listener is attached.
// pg_kill was the one raw checkout, found by grep after the fact; this makes the
// next one fail here instead. It matches ANY `.connect(` call, not the literal
// `getPool().connect(`: a checkout through an aliased pool (`const p =
// getPool(); p.connect()`) or with `.connect(` wrapped onto the next line has
// no listener either, and a literal match would not see it. Comment lines are
// skipped -- several explain the rule by naming the call.
//
// Runs from dist/tools/, two levels below the repo root.
describe("getPool().connect() appears only inside acquireClient", () => {
  it("no non-test source file checks a client out of the pool on its own", () => {
    const srcRoot = new URL("../../src/", import.meta.url);
    const offenders: string[] = [];
    const inApi: string[] = [];
    for (const entry of readdirSync(srcRoot, { recursive: true, encoding: "utf8" })) {
      const rel = entry.replaceAll("\\", "/");
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.startsWith("integration/")) continue;
      const lines = readFileSync(new URL(rel, srcRoot), "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        if (!/\.connect\s*\(/.test(code)) return;
        if (rel === "api.ts") inApi.push(code);
        else offenders.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [], "a raw pool checkout has no 'error' listener -- go through acquireClient()");
    // api.ts holds exactly two: acquireClient's pool checkout, and
    // terminateBackend's standalone pg.Client, which attaches its own 'error'
    // listener before connecting.
    assert.equal(inApi.length, 2, `expected acquireClient + terminateBackend in api.ts, got ${JSON.stringify(inApi)}`);
    assert.ok(
      inApi.some((c) => /\bgetPool\(\)\s*\.connect\(/.test(c)),
      "acquireClient's getPool().connect() not found; the scan may be broken",
    );
  });
});

// pg_kill's agent-facing contract (#56). The description is what an agent plans
// from, and it promised a shape the tool never returns: a permission denial as
// `signaled: false` plus a NOTICE. Postgres raises 42501 for that, on every
// version this server supports.
describe("pg_kill says what a permission denial and a `false` really are", () => {
  it("the description names 42501 as an error and no longer quotes the ERROR text as a NOTICE", () => {
    assert.match(pgKill.description, /42501/);
    assert.doesNotMatch(pgKill.description, /must be a member/);
    assert.doesNotMatch(pgKill.description, /three-way/);
    // `true` is "sent", not "stopped": measured -- a session idle in a
    // transaction ignored the cancel on 15, 17 and 18.
    assert.match(pgKill.description, /SENT/);
  });
});

describe("pg_kill fallback note (stubbed connect, no live DB)", () => {
  const originalAllowWrites = process.env.ALLOW_WRITES;

  useStubbedPool();

  beforeEach(() => {
    process.env.ALLOW_WRITES = "1";
  });

  afterEach(() => {
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
  });

  it("a `false` with no warning captured does not send the agent looking for a grant", async () => {
    installKillStub({ rows: [{ signaled: false }] });
    const res = (await pgKill.handler({ pid: 9999, mode: "cancel" })) as { ok: boolean; data: { note: string } };
    assert.equal(res.ok, true);
    assert.match(res.data.note, /found no backend with PID 9999/);
    // Missing permission can never be why postgres answered `false`.
    assert.doesNotMatch(res.data.note, /permission/i);
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
  let seen: { sql: string; params: unknown[] }[] = [];

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   * @param failing categories whose sub-query throws, standing in for the
   *   permission-gated catalogs on managed providers.
   */
  function installStub(versionNum: number | null, failing: AdvisorCategory[] = []) {
    seen = [];
    stubPoolQuery(async (text) => {
      if (versionNum === null) throw new Error("version probe unavailable");
      return { rows: text.includes("server_version_num") ? [{ v: String(versionNum) }] : [] };
    });

    const client = stubClient(async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      if (failing.includes(categorize(sql))) throw new Error("permission denied");
      return { rows: rowsFor(sql) };
    });
    stubConnect(() => client);
  }

  function sqlFor(category: AdvisorCategory): string {
    return seen.find((q) => categorize(q.sql) === category)?.sql ?? "";
  }

  // The shutdown() on the way in also clears the cached server_version_num, so
  // each test's stubbed version is actually probed instead of reusing the
  // previous test's value.
  useStubbedPool();

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

  it("resolves the per-table multixact override alongside the GUC", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    const sql = sqlFor("wrapTables");
    // Same pg_options_to_table LATERAL pattern the xid path uses: a table with
    // a LOWERED autovacuum_multixact_freeze_max_age is already being
    // force-vacuumed while it still reads as safe against the cluster default.
    assert.match(sql, /option_name = 'autovacuum_multixact_freeze_max_age'/);
    assert.match(sql, /current_setting\('autovacuum_multixact_freeze_max_age'\)/);
  });

  it("takes the LOWER of the per-table override and the GUC for both divisors", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    const sql = sqlFor("wrapTables");
    // autovacuum computes Min(reloption, GUC): a per-table value RAISED above
    // the cluster setting is ignored. COALESCE(reloption, GUC) let a table set
    // to 2 billion divide its age by a limit autovacuum never uses, so at 95%
    // of the real limit it reported 9.5% and fell below the threshold. LEAST
    // skips a NULL (no reloption), which is the GUC fallback.
    for (const guc of ["autovacuum_freeze_max_age", "autovacuum_multixact_freeze_max_age"]) {
      assert.match(
        sql,
        new RegExp(
          `LEAST\\(\\s*\\(SELECT o\\.option_value::int\\s+FROM pg_catalog\\.pg_options_to_table\\(c\\.reloptions\\) o\\s+` +
            `WHERE o\\.option_name = '${guc}'\\),\\s*current_setting\\('${guc}'\\)::int\\s*\\)`,
        ),
        `${guc} should be capped at the GUC`,
      );
    }
    assert.doesNotMatch(sql, /COALESCE\(/, "a bare COALESCE lets a raised override win");
  });

  it("the description and the field text no longer say a per-table override wins over the GUC", () => {
    assert.doesNotMatch(pgAdvisor.description, /storage parameter wins/);
    assert.match(pgAdvisor.description, /the LOWER of the\s+per-table/);
    const described = JSON.stringify(z.toJSONSchema(pgAdvisor.outputSchema, { io: "output" }));
    assert.doesNotMatch(described, /wins over the cluster GUC/);
  });

  it("tables_without_primary_key skips partitions; public_tables_without_rls does not", async () => {
    installStub(180_000);
    await pgAdvisor.handler({});
    // One PK-less partitioned parent used to bring every partition with it,
    // enough to fill `limit` alone and cut off every later table.
    assert.match(sqlFor("noPk"), /AND NOT c\.relispartition/);
    // RLS is per relation and is not inherited: a partition without it can be
    // queried directly around the parent's policies, so it stays a finding.
    assert.doesNotMatch(sqlFor("rls"), /relispartition/);
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
// pg_advisor sequence_exhaustion WITHOUT a live DB.
//
// Same stubbed pool/connect pattern as the wraparound suite above, but the
// sequence rows are per-test: the statement returns its findings plus one
// trailing `row_kind = 'skipped'` row carrying the count of sequences the
// role cannot read, and that row is what these tests vary. Matching on
// `pg_sequences` mirrors categorize() above.
// ─────────────────────────────────────────────────────────────────────────

describe("pg_advisor sequence_exhaustion (stubbed connect, no live DB)", () => {
  let seen: string[] = [];

  const finding = {
    row_kind: "finding",
    schema: "public",
    sequence: "legacy_id_seq",
    last_value: "1900000000",
    max_value: "9223372036854775807",
    increment_by: "1",
    limit_value: "2147483647",
    limited_by: "column",
    owned_by: "public.legacy.id",
    owned_by_type: "integer",
    pct_used: 0.8848,
    skipped_unreadable: null,
  };
  const skippedRow = (n: number) => ({
    row_kind: "skipped",
    schema: null,
    sequence: null,
    last_value: null,
    max_value: null,
    increment_by: null,
    limit_value: null,
    limited_by: null,
    owned_by: null,
    owned_by_type: null,
    pct_used: null,
    skipped_unreadable: n,
  });

  function installStub(sequenceRows: Record<string, unknown>[] | "fail") {
    seen = [];
    stubPoolQuery(async (text) => ({ rows: text.includes("server_version_num") ? [{ v: "180000" }] : [] }));
    const client = stubClient(async (sql: string) => {
      seen.push(sql);
      if (!sql.includes("pg_sequences")) return { rows: [] };
      if (sequenceRows === "fail") throw new Error("permission denied for view pg_sequences");
      return { rows: sequenceRows };
    });
    stubConnect(() => client);
  }

  const sequenceSql = () => seen.find((s) => s.includes("pg_sequences")) ?? "";

  useStubbedPool();

  it("warns with the count of unreadable sequences even when nothing is flagged", async () => {
    installStub([skippedRow(3)]);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.ok, true);
    // The case the warning exists for: an empty list that would otherwise
    // read as "every sequence is healthy" to a table-scoped role.
    assert.deepEqual(res.data.sequence_exhaustion, []);
    const warning = (res.data._warnings ?? []).find((w) => w.startsWith("sequence_exhaustion skipped"));
    assert.ok(warning, `expected a skipped-sequence warning, got ${JSON.stringify(res.data._warnings)}`);
    assert.match(warning, /skipped 3 sequence\(s\)/);
    assert.match(warning, /SELECT or USAGE/);
  });

  it("emits no skipped warning at 0, and the summary row never leaks into the findings", async () => {
    installStub([finding, skippedRow(0)]);
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    assert.equal(res.data._warnings, undefined);
    assert.equal(res.data.sequence_exhaustion.length, 1);
    const row = res.data.sequence_exhaustion[0] ?? {};
    assert.equal(row.sequence, "legacy_id_seq");
    assert.equal(row.limited_by, "column");
    assert.equal("row_kind" in row, false);
    assert.equal("skipped_unreadable" in row, false);
  });

  it("the count rides in the same statement, so the fanout stays at six queries", async () => {
    installStub([skippedRow(2)]);
    await pgAdvisor.handler({});
    assert.equal(seen.length, 6);
    const sql = sequenceSql();
    assert.match(sql, /has_sequence_privilege\(c\.oid, 'SELECT,USAGE'\)/);
    // UNION ALL, not a filtered join: the summary row must exist when no
    // finding does.
    assert.match(sql, /UNION ALL\s+SELECT 'skipped'/);
  });

  it("a failed sequence fetch warns once and does not invent a skipped count", async () => {
    installStub("fail");
    const res = (await pgAdvisor.handler({})) as AdvisorResponse;
    const warnings = res.data._warnings ?? [];
    assert.equal(warnings.filter((w) => w.startsWith("sequence_exhaustion")).length, 1);
    assert.match(warnings.join("\n"), /sequence_exhaustion fetch failed/);
    assert.deepEqual(res.data.sequence_exhaustion, []);
  });

  it("measures a descending sequence against min_value instead of dropping it", async () => {
    installStub([skippedRow(0)]);
    await pgAdvisor.handler({});
    const sql = sequenceSql();
    // The old `max_value > 0` filter excluded every default descending
    // sequence (max_value -1).
    assert.doesNotMatch(sql, /max_value > 0/);
    assert.match(sql, /CASE WHEN s\.increment_by > 0[\s\S]*ELSE GREATEST\(s\.min_value,/);
    assert.match(sql, /sign\(limit_value\) = sign\(increment_by\)/);
  });

  it("narrows the bound to the owning column's type through pg_depend", async () => {
    installStub([skippedRow(0)]);
    await pgAdvisor.handler({});
    const sql = sequenceSql();
    assert.match(sql, /pg_catalog\.pg_depend d/);
    assert.match(sql, /d\.deptype IN \('a', 'i'\)/);
    assert.match(
      sql,
      /LEAST\(s\.max_value,\s+CASE o\.typ WHEN 'int2'::regtype THEN 32767 WHEN 'int4'::regtype THEN 2147483647 END\)/,
    );
    assert.match(sql, /'int4'::regtype THEN -2147483648/);
    // A bigint sequence past its smallint column reads as a ratio in the
    // hundreds of thousands; numeric(6, 4) would overflow and fail the category.
    assert.doesNotMatch(sql, /numeric\(6, 4\)/);
    assert.match(sql, /round\(last_value::numeric \/ NULLIF\(limit_value, 0\)::numeric, 4\)::float8 AS pct_used/);
  });

  it("guards both divisions with NULLIF, since a bound of 0 is reachable", async () => {
    installStub([skippedRow(0)]);
    await pgAdvisor.handler({});
    const sql = sequenceSql();
    // MINVALUE 0 on a countdown (or MAXVALUE 0 ascending) gives limit_value 0,
    // and the sign() conjunct is not guaranteed to run first: one such
    // sequence raised division by zero and emptied the whole category.
    assert.doesNotMatch(sql, /\/ limit_value::numeric/);
    assert.equal(sql.match(/\/ NULLIF\(limit_value, 0\)::numeric/g)?.length, 2);
    assert.match(sql, /AND \(last_value::numeric \/ NULLIF\(limit_value, 0\)::numeric\) >= \$1/);
  });

  it("the declared outputSchema accepts both the new row shape and a sequence no column owns", () => {
    const schema = (pgAdvisor as unknown as { outputSchema: z.ZodTypeAny }).outputSchema;
    const { row_kind: _k, skipped_unreadable: _s, ...owned } = finding;
    const unowned = {
      ...owned,
      sequence: "countdown_seq",
      last_value: "-900",
      max_value: "-1",
      increment_by: "-1",
      limit_value: "-1000",
      limited_by: "sequence",
      owned_by: null,
      owned_by_type: null,
      pct_used: 0.9,
    };
    const parsed = schema.safeParse({
      sequence_exhaustion: [
        owned,
        unowned,
        { schema: "public", sequence: "s", last_value: "9", max_value: "10", pct_used: 0.9 },
      ],
      wraparound_risk: {
        autovacuum_freeze_max_age: null,
        autovacuum_multixact_freeze_max_age: null,
        databases: [],
        tables: [],
      },
      tables_without_primary_key: [],
      public_tables_without_rls: [],
    });
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    // Declared, not merely tolerated: an undeclared key is stripped on parse,
    // so these would vanish from structuredContent if the schema lost them.
    const rows = (parsed.data as { sequence_exhaustion: Record<string, unknown>[] }).sequence_exhaustion;
    assert.equal(rows[0]?.limit_value, "2147483647");
    assert.equal(rows[0]?.limited_by, "column");
    assert.equal(rows[0]?.owned_by, "public.legacy.id");
    assert.equal(rows[1]?.owned_by, null);
    assert.equal(rows[1]?.increment_by, "-1");
  });

  it("the description names limit_value and the unreadable-sequence warning", () => {
    assert.match(pgAdvisor.description, /`seqExhaustionThreshold` of `limit_value`/);
    assert.match(pgAdvisor.description, /`min_value` when\s+descending/);
    assert.match(pgAdvisor.description, /counted in `_warnings`/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pg_replication_status against a role without pg_read_all_stats, WITHOUT a
// live DB (and without a replica, which no test cluster here has).
//
// pg_stat_replication hides every walsender column but the pid from a role
// that neither owns the walsender nor holds pg_read_all_stats, so `state` and
// `sync_state` arrive as SQL NULL. The MCP SDK validates structuredContent
// against outputSchema and fails the whole call on a mismatch (see
// output.ts), so the assertion that matters is the schema parse: declared
// non-null, one redacted row cost the caller the slots and the WAL position
// too.
// ─────────────────────────────────────────────────────────────────────────

const pgReplicationStatus = adminTools.find((t) => t.name === "pg_replication_status")!;

describe("pg_replication_status with a redacted replica row (stubbed connect, no live DB)", () => {
  function installStub(replicas: Record<string, unknown>[]) {
    const client = stubClient(async (sql: string) => {
      if (sql.includes("pg_stat_replication")) return { rows: replicas };
      if (sql.includes("pg_replication_slots")) return { rows: [] };
      return { rows: [{ is_in_recovery: false, wal_position: "0/16B3748" }] };
    });
    stubConnect(() => client);
  }

  useStubbedPool();

  // What the view returns to such a role: application_name comes from
  // pg_stat_activity's side and stays visible, the rest is NULL.
  const REDACTED = {
    application_name: "walreceiver",
    client_addr: null,
    state: null,
    sync_state: null,
    write_lag_seconds: null,
    flush_lag_seconds: null,
    replay_lag_seconds: null,
  };
  const VISIBLE = { ...REDACTED, state: "streaming", sync_state: "async", write_lag_seconds: 0.01 };

  it("a row with NULL state / sync_state passes the declared outputSchema", async () => {
    installStub([REDACTED]);
    const res = (await pgReplicationStatus.handler()) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(res.ok, true);
    const parsed = pgReplicationStatus.outputSchema.safeParse(res.data);
    assert.equal(parsed.success, true, `outputSchema rejected the response: ${JSON.stringify(parsed.error?.issues)}`);
    // The readable parts survive alongside the redacted row.
    assert.equal(res.data.wal_position, "0/16B3748");
    assert.deepEqual(res.data.replicas, [REDACTED]);
  });

  it("says why the row is null instead of leaving it to read as 'nothing to report'", async () => {
    installStub([REDACTED, VISIBLE]);
    const res = (await pgReplicationStatus.handler()) as { ok: boolean; data: { _warnings?: string[] } };
    assert.equal(res.data._warnings?.length, 1);
    assert.match(res.data._warnings?.[0] ?? "", /^1 replica row\(s\) have null state .* lacks pg_read_all_stats$/);
  });

  it("emits no warning when every replica row is readable", async () => {
    installStub([VISIBLE]);
    const res = (await pgReplicationStatus.handler()) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(pgReplicationStatus.outputSchema.safeParse(res.data).success, true);
    assert.equal("_warnings" in res.data, false);
  });
});

// pg_table_privileges reads information_schema.table_privileges, which shows a
// grant only to a role that IS the grantor or grantee (or for PUBLIC).
// pg_read_all_data grants SELECT on tables and membership in nothing else, so
// the description's old advice produced the same partial list while telling
// the caller it was complete -- in a tool meant for access audits.
describe("pg_table_privileges visibility caveat", () => {
  it("the description does not offer pg_read_all_data as a way to a complete picture", () => {
    const { description } = adminTools.find((t) => t.name === "pg_table_privileges")!;
    assert.doesNotMatch(description, /superuser or a member of\s+`pg_read_all_data`/);
    assert.match(description, /run as a superuser/);
    assert.match(description, /`pg_read_all_data` does NOT widen this view/);
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
  let seen: string[] = [];

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   */
  function installStub(versionNum: number | null) {
    seen = [];
    stubPoolQuery(async (text) => {
      seen.push(text);
      if (categorizeBloat(text) === "version") {
        if (versionNum === null) throw new Error("version probe unavailable");
        return { rows: [{ v: String(versionNum) }] };
      }
      return { rows: bloatRowsFor(text) };
    });
  }

  function sqlFor(category: BloatCategory): string {
    return seen.find((sql) => categorizeBloat(sql) === category) ?? "";
  }

  // The shutdown() on the way in clears the cached server_version_num, so each
  // case's stubbed version is actually probed instead of reusing the previous
  // case's.
  useStubbedPool();

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

  it("both query shapes guard the filter's division with NULLIF", async () => {
    // The `> 0` qual beside it is not a guarantee: postgres does not promise
    // to evaluate AND-ed quals in written order.
    installStub(180_000);
    await pgTableBloat.handler({});
    assert.match(sqlFor("estimate"), /n_dead_tup::float8 \/ NULLIF\(n_live_tup \+ n_dead_tup, 0\)\) >= \$1/);
    installStub(180_000);
    await pgTableBloat.handler({ method: "exact" });
    assert.match(sqlFor("pgstattuple"), /NULLIF\(p\.tuple_count \+ p\.dead_tuple_count, 0\)\) >= \$1/);
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
