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
