/**
 * Security limits around user SQL, against a fake client so they run without a
 * database. security.integration.test.ts covers the same ground on a real one.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import {
  DEFAULT_MAX_RESULT_BYTES,
  getMaxResultBytes,
  getQueryDeadlineMs,
  runReadOnly,
  runReadWrite,
  runReadWriteRollback,
  shutdown,
} from "./api.js";
import { initAudit, resetAuditForTests, setAuditSinkForTests } from "./audit.js";
import { explainTools } from "./tools/explain.js";

const pgExplain = explainTools[0];
const BACKEND_PID = 4242;
const AUDIT_ENV_KEYS = ["POSTGRES_AUDIT_LOG", "POSTGRES_AUDIT_LOG_FILE", "POSTGRES_AUDIT_REDACT"] as const;
const ENV_KEYS = [
  "DATABASE_URL",
  "ALLOW_WRITES",
  "POSTGRES_MAX_RESULT_BYTES",
  "POSTGRES_QUERY_DEADLINE_MS",
  "POSTGRES_STATEMENT_TIMEOUT_MS",
] as const;

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

type Respond = (sql: string, socket: FakeSocket) => unknown;

function makeClient(respond: Respond = () => undefined) {
  const socket = new FakeSocket();
  const statements: string[] = [];
  const releases: unknown[] = [];
  return {
    socket,
    statements,
    releases,
    connection: { stream: socket },
    async query(config: unknown) {
      const sql = typeof config === "string" ? config : ((config as { text?: string }).text ?? "");
      statements.push(sql);
      const answer = await respond(sql, socket);
      if (answer !== undefined) return answer;
      if (sql.startsWith("SELECT pg_backend_pid")) return { rows: [{ pid: BACKEND_PID }], fields: [], rowCount: 1 };
      return { rows: [], fields: [], command: "", rowCount: 0 };
    },
    release(err?: unknown) {
      releases.push(err);
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
}

const hang = (): Promise<never> => new Promise(() => {});

describe("user SQL limits (fake client)", () => {
  const savedEnv = new Map<string, string | undefined>();
  const originalConnect = pg.Pool.prototype.connect;
  const originalClient = {
    connect: pg.Client.prototype.connect,
    query: pg.Client.prototype.query,
    end: pg.Client.prototype.end,
  };
  const originalError = console.error;
  let connects = 0;

  function use(client: ReturnType<typeof makeClient>): void {
    pg.Pool.prototype.connect = function connectStub() {
      connects++;
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    connects = 0;
    console.error = () => {};
    await shutdown();
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    Object.assign(pg.Client.prototype, originalClient);
    console.error = originalError;
    await shutdown();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("read-only statement policy", () => {
    it("refuses a blocked statement before taking a connection", async () => {
      use(makeClient());
      for (const sql of [
        "DO $$ BEGIN NULL; END $$",
        "/* c */ SET ROLE postgres",
        "SELECT dblink_exec('a', 'b')",
        // Three spellings PostgreSQL runs as a call (measured on PG18) that a
        // name-then-parenthesis scan misses: a UESCAPE clause between the two,
        // attribute notation, and a call behind a continued E-string.
        `SELECT U&"dblink!005fexec" UESCAPE '!'('a', 'b')`,
        `SELECT U&"pg_terminate_backend" UESCAPE '!' (123)`,
        "SELECT ('/etc/passwd'::text).pg_read_file",
        'SELECT (123) . "pg_cancel_backend"',
        "SELECT E'a'\n'\\'' || set_config('role', 'x', false) || '...'",
      ]) {
        const res = await runReadOnly(sql);
        assert.equal(res.ok, false, sql);
        assert.match(res.error ?? "", /Blocked in read-only mode/);
        assert.doesNotMatch(res.error ?? "", /\(code:/, "the message is complete without a code suffix");
      }
      assert.equal(connects, 0);
    });

    it("leaves an audit line for a refused statement", async () => {
      // The refusal is raised inside the audited span on purpose: hoisting the
      // guard above it would drop refused agent SQL from the trail.
      const savedAuditEnv = AUDIT_ENV_KEYS.map((key) => [key, process.env[key]] as const);
      for (const key of AUDIT_ENV_KEYS) delete process.env[key];
      process.env.POSTGRES_AUDIT_LOG = "1";
      resetAuditForTests();
      const lines: string[] = [];
      try {
        initAudit();
        setAuditSinkForTests((line) => {
          lines.push(line);
        });
        use(makeClient());
        assert.equal((await runReadOnly("SET ROLE postgres")).ok, false);
      } finally {
        for (const [key, value] of savedAuditEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        resetAuditForTests();
      }
      assert.equal(lines.length, 1, JSON.stringify(lines));
      const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
      assert.equal(record.ok, false);
      assert.equal(record.sqlstate, "PGMCP_BLOCKED");
      assert.equal(record.source, "user");
      assert.equal(connects, 0);
    });

    it("does not apply to the write paths", async () => {
      process.env.ALLOW_WRITES = "1";
      const client = makeClient();
      use(client);
      assert.equal((await runReadWrite("SET search_path = app")).ok, true);
      assert.ok(client.statements.some((s) => s.includes("SET search_path = app")));
      assert.equal((await runReadWriteRollback("EXPLAIN (ANALYZE) DELETE FROM t")).ok, true);
    });
  });

  describe("pg_explain never executes unless asked", () => {
    for (const sql of ["ANALYZE SELECT 1", "analyse SELECT 1", "/* c */ ANALYZE SELECT 1", "(ANALYZE) SELECT 1"]) {
      it(`refuses ${JSON.stringify(sql)}`, async () => {
        use(makeClient());
        const res = (await pgExplain.handler({ sql })) as { ok: boolean; error?: string };
        assert.equal(res.ok, false);
        assert.match(res.error ?? "", /analyze: true/);
        assert.equal(connects, 0);
      });
    }

    it("refuses VERBOSE, and an EXPLAIN hidden behind a comment", async () => {
      use(makeClient());
      const verbose = (await pgExplain.handler({ sql: "VERBOSE SELECT 1" })) as { error?: string };
      assert.match(verbose.error ?? "", /verbose: true/);
      const hidden = (await pgExplain.handler({ sql: "/* c */ EXPLAIN SELECT 1" })) as { error?: string };
      assert.match(hidden.error ?? "", /not an EXPLAIN statement/);
    });

    it("always sends an option list, so nothing after EXPLAIN can read as an option", async () => {
      const client = makeClient((sql) =>
        sql.startsWith("FETCH") ? { rows: [{ "QUERY PLAN": "Result" }], fields: [], rowCount: 1 } : undefined,
      );
      use(client);
      const res = (await pgExplain.handler({ sql: "SELECT 1" })) as { ok: boolean };
      assert.equal(res.ok, true);
      assert.ok(client.statements.some((s) => s.endsWith("EXPLAIN (COSTS ON) SELECT 1")));
    });

    it("the filler option is COSTS ON, never an analyze key (hypopg bails on any analyze option)", async () => {
      // The security fix needs SOME option list so caller text cannot read as
      // an EXPLAIN option. The first choice, `(ANALYZE FALSE)`, silently broke
      // hypothetical_indexes: hypopg's hypo_is_simple_explain() returns false
      // on ANY `analyze` key regardless of value, so it never injected the
      // index and the plan never flipped. This pins the fix: the filler must
      // carry no analyze key. COSTS ON is hypopg-safe (measured: it injects)
      // and still 42601 after a would-be execution attempt (measured).
      const client = makeClient((sql) =>
        sql.startsWith("FETCH") ? { rows: [{ "QUERY PLAN": "Result" }], fields: [], rowCount: 1 } : undefined,
      );
      use(client);
      await pgExplain.handler({ sql: "SELECT 1" });
      // The statement may ride inside the row-cap cursor's DECLARE wrapper, so
      // find the EXPLAIN anywhere in the sent text and read its option list.
      const sent = client.statements.find((s) => s.includes("EXPLAIN ("));
      assert.ok(sent, `no EXPLAIN sent: ${JSON.stringify(client.statements)}`);
      const optionList = /EXPLAIN \(([^)]*)\)/.exec(sent)?.[1];
      assert.equal(optionList, "COSTS ON", `filler must be EXPLAIN (COSTS ON), got: ${sent}`);
      assert.doesNotMatch(optionList ?? "", /ANALYZE/i, `option list must carry no analyze key: ${sent}`);
    });
  });

  describe("session reset", () => {
    it("runs DISCARD ALL after the ROLLBACK of a read-only call", async () => {
      const client = makeClient();
      use(client);
      assert.equal((await runReadOnly("SELECT 1")).ok, true);
      assert.deepEqual(client.statements.slice(-2), ["ROLLBACK", "DISCARD ALL"]);
      assert.deepEqual(client.releases, [undefined]);
    });

    it("runs it after a failed statement too", async () => {
      const client = makeClient((sql) => {
        if (sql.startsWith("DECLARE")) throw Object.assign(new Error("no such table"), { code: "42P01" });
        return undefined;
      });
      use(client);
      assert.equal((await runReadOnly("SELECT * FROM nope")).ok, false);
      assert.deepEqual(client.statements.slice(-2), ["ROLLBACK", "DISCARD ALL"]);
    });

    it("runs it after a COMMIT, so a committed SET ROLE cannot reach the next call", async () => {
      process.env.ALLOW_WRITES = "1";
      const client = makeClient();
      use(client);
      assert.equal((await runReadWrite("SET ROLE app")).ok, true);
      assert.deepEqual(client.statements.slice(-2), ["COMMIT", "DISCARD ALL"]);
    });

    it("destroys the connection when the reset fails, keeping the call's result", async () => {
      for (const run of [() => runReadOnly("SELECT 1"), () => runReadWrite("SELECT 1")]) {
        process.env.ALLOW_WRITES = "1";
        const client = makeClient((sql) => {
          if (sql === "DISCARD ALL") throw new Error("reset refused");
          return undefined;
        });
        use(client);
        assert.equal((await run()).ok, true);
        assert.equal(client.releases.length, 1);
        assert.match(String(client.releases[0]), /reset/);
      }
    });
  });

  describe("result byte limit", () => {
    const big = Buffer.alloc(2048);

    it("stops a cursor result still arriving, without waiting for the driver", async () => {
      process.env.POSTGRES_MAX_RESULT_BYTES = "1024";
      const client = makeClient((sql, socket) => {
        if (!sql.startsWith("FETCH")) return undefined;
        socket.emit("data", big);
        return hang();
      });
      use(client);
      const res = await runReadOnly("SELECT repeat('x', 100000000)");
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /POSTGRES_MAX_RESULT_BYTES \(1024 bytes\)/);
      assert.equal(client.socket.destroyed, true);
      assert.equal(client.releases.length, 1);
      assert.ok(client.releases[0] instanceof Error, "the connection must not return to the pool");
      assert.ok(!client.statements.includes("ROLLBACK"), "nothing may be sent on a closed connection");
    });

    it("also bounds the direct path a statement falls back to", async () => {
      process.env.POSTGRES_MAX_RESULT_BYTES = "1024";
      const client = makeClient((sql, socket) => {
        if (sql.startsWith("DECLARE")) throw Object.assign(new Error("syntax"), { code: "42601" });
        if (!sql.startsWith("SHOW")) return undefined;
        socket.emit("data", big);
        return hang();
      });
      use(client);
      const res = await runReadOnly("SHOW ALL");
      assert.match(res.error ?? "", /POSTGRES_MAX_RESULT_BYTES/);
    });

    it("bounds a write's RETURNING and does not commit it", async () => {
      process.env.ALLOW_WRITES = "1";
      process.env.POSTGRES_MAX_RESULT_BYTES = "1024";
      const client = makeClient((sql, socket) => {
        if (sql.startsWith("DECLARE")) throw Object.assign(new Error("syntax"), { code: "42601" });
        if (!sql.startsWith("INSERT")) return undefined;
        socket.emit("data", big);
        return hang();
      });
      use(client);
      const res = await runReadWrite("INSERT INTO t SELECT 1 RETURNING *");
      assert.match(res.error ?? "", /rolled back/);
      assert.ok(!client.statements.includes("COMMIT"));
      assert.ok(client.releases[0] instanceof Error);
    });

    it("leaves a result under the limit alone and removes its listener", async () => {
      process.env.POSTGRES_MAX_RESULT_BYTES = "4096";
      const client = makeClient((sql, socket) => {
        if (sql.startsWith("FETCH")) socket.emit("data", big);
        return undefined;
      });
      use(client);
      assert.equal((await runReadOnly("SELECT 1")).ok, true);
      assert.equal(client.socket.destroyed, false);
      assert.equal(client.socket.listenerCount("data"), 0);
      assert.deepEqual(client.releases, [undefined]);
    });
  });

  describe("client-side deadline", () => {
    function stubTerminator(behaviour: { connect?: () => Promise<void>; terminated?: boolean }) {
      const calls: { sql: string; params: unknown[] }[] = [];
      pg.Client.prototype.connect = (() =>
        behaviour.connect ? behaviour.connect() : Promise.resolve()) as unknown as typeof pg.Client.prototype.connect;
      pg.Client.prototype.query = ((sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [{ terminated: behaviour.terminated ?? true }], rowCount: 1 });
      }) as unknown as typeof pg.Client.prototype.query;
      pg.Client.prototype.end = (() => Promise.resolve()) as typeof pg.Client.prototype.end;
      return calls;
    }

    const stuck = () => makeClient((sql) => (sql.startsWith("DECLARE") ? hang() : undefined));

    it("terminates the backend the transaction reported and closes the connection", async () => {
      process.env.POSTGRES_QUERY_DEADLINE_MS = "20";
      const calls = stubTerminator({});
      const client = stuck();
      use(client);
      const res = await runReadOnly("SELECT stubborn()");
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /20 ms client-side deadline/);
      assert.match(res.error ?? "", /backend 4242 was terminated/);
      assert.deepEqual(calls, [{ sql: "SELECT pg_terminate_backend($1) AS terminated", params: [BACKEND_PID] }]);
      assert.equal(client.socket.destroyed, true);
      assert.ok(client.releases[0] instanceof Error);
    });

    it("says so when the backend could not be terminated", async () => {
      process.env.POSTGRES_QUERY_DEADLINE_MS = "20";
      stubTerminator({ connect: () => Promise.reject(new Error("too many connections")) });
      const client = stuck();
      use(client);
      const res = await runReadOnly("SELECT stubborn()");
      assert.match(res.error ?? "", /backend 4242 could NOT be terminated/);
      assert.equal(client.socket.destroyed, true);
    });

    it("still returns when even BEGIN hangs, with no backend to name", async () => {
      process.env.POSTGRES_QUERY_DEADLINE_MS = "20";
      const calls = stubTerminator({});
      const client = makeClient((sql) => (sql.startsWith("BEGIN") ? hang() : undefined));
      use(client);
      const res = await runReadOnly("SELECT 1");
      assert.match(res.error ?? "", /could not be identified/);
      assert.deepEqual(calls, []);
    });

    it("applies to the write path", async () => {
      process.env.ALLOW_WRITES = "1";
      process.env.POSTGRES_QUERY_DEADLINE_MS = "20";
      stubTerminator({});
      const client = stuck();
      use(client);
      const res = await runReadWrite("UPDATE t SET a = stubborn()");
      assert.match(res.error ?? "", /deadline/);
      assert.ok(!client.statements.includes("COMMIT"));
    });

    it("does not fire after the call has finished", async () => {
      process.env.POSTGRES_QUERY_DEADLINE_MS = "10";
      const calls = stubTerminator({});
      const client = makeClient();
      use(client);
      assert.equal((await runReadOnly("SELECT 1")).ok, true);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(calls, []);
      assert.equal(client.socket.destroyed, false);
    });

    it("closes the socket without waiting on the terminate, but holds the checkout until it finishes", async () => {
      process.env.POSTGRES_QUERY_DEADLINE_MS = "20";
      let openTerminateConnect: (() => void) | undefined;
      const calls = stubTerminator({
        connect: () =>
          new Promise<void>((resolve) => {
            openTerminateConnect = resolve;
          }),
      });
      const client = stuck();
      use(client);
      let settled = false;
      const res = runReadOnly("SELECT stubborn()").then((r) => {
        settled = true;
        return r;
      });
      // The deadline fires ~20 ms in; the out-of-band terminate's connect then
      // hangs. The abort must not wait on it...
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(client.socket.destroyed, true, "the socket is closed without waiting for the terminate");
      // ...but nothing may be released while that terminate is in flight:
      // a released backend is back in the pool, and pg_terminate_backend then
      // lands on whatever concurrent call borrowed it.
      assert.equal(settled, false, "the caller waits for the outcome report before finishing");
      assert.deepEqual(client.releases, [], "the checkout must stay held until the terminate round trip ends");
      assert.deepEqual(calls, [], "no terminate has been sent while its connect is pending");
      openTerminateConnect?.();
      const done = await res;
      assert.match(done.error ?? "", /20 ms client-side deadline/);
      assert.match(done.error ?? "", /backend 4242 was terminated/);
      assert.deepEqual(calls, [{ sql: "SELECT pg_terminate_backend($1) AS terminated", params: [BACKEND_PID] }]);
      assert.equal(client.releases.length, 1, "released exactly once, after the outcome was reported");
    });
  });

  describe("limit configuration", () => {
    it("defaults, and reads valid values", () => {
      assert.equal(getMaxResultBytes(), DEFAULT_MAX_RESULT_BYTES);
      assert.equal(getQueryDeadlineMs(), 35_000);
      process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "1000";
      assert.equal(getQueryDeadlineMs(), 6_000, "tracks the statement timeout");
      process.env.POSTGRES_MAX_RESULT_BYTES = "2048";
      process.env.POSTGRES_QUERY_DEADLINE_MS = "900";
      assert.equal(getMaxResultBytes(), 2048);
      assert.equal(getQueryDeadlineMs(), 900);
    });

    it("keeps the default for an unusable value and says so", () => {
      const logged: string[] = [];
      console.error = (msg?: unknown) => {
        logged.push(String(msg));
      };
      for (const bad of ["lots", "0", "-1", "", "1e10"]) {
        process.env.POSTGRES_MAX_RESULT_BYTES = bad;
        assert.equal(getMaxResultBytes(), DEFAULT_MAX_RESULT_BYTES, JSON.stringify(bad));
      }
      assert.ok(logged.some((l) => /POSTGRES_MAX_RESULT_BYTES="lots" is not a positive integer/.test(l)));
      assert.ok(
        logged.some((l) => /POSTGRES_MAX_RESULT_BYTES="1e10" is not a positive integer/.test(l)),
        "a value over 2^31-1 must warn: the byte limit shares the deadline's ceiling",
      );
    });

    it("falls back when the deadline would overflow setTimeout", () => {
      const logged: string[] = [];
      console.error = (msg?: unknown) => {
        logged.push(String(msg));
      };
      process.env.POSTGRES_QUERY_DEADLINE_MS = "9999999999";
      assert.equal(getQueryDeadlineMs(), 35_000);
      assert.ok(logged.some((l) => /POSTGRES_QUERY_DEADLINE_MS="9999999999" is not a positive integer/.test(l)));
    });
  });
});
