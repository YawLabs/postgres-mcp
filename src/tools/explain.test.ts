import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import { explainTools } from "./explain.js";

const [pgExplain] = explainTools;

describe("pg_explain EXPLAIN-prefix guard", () => {
  it("rejects sql starting with 'EXPLAIN'", async () => {
    const result = (await pgExplain.handler({
      sql: "EXPLAIN SELECT 1",
      analyze: false,
      format: "text",
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /should be the query to explain, not an EXPLAIN statement/);
  });

  it("rejects sql starting with 'explain analyze' (case-insensitive)", async () => {
    const result = (await pgExplain.handler({
      sql: "explain analyze select 1",
      analyze: false,
      format: "text",
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /should be the query to explain/);
  });

  it("rejects sql with leading whitespace before EXPLAIN", async () => {
    const result = (await pgExplain.handler({
      sql: "   EXPLAIN SELECT 1",
      analyze: false,
      format: "text",
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
  });
});

describe("pg_explain hypothetical_indexes identifier validation", () => {
  // Validation runs as a pre-flight before the handler touches the DB, so
  // these tests don't need a live postgres -- they ride on the fast unit path.

  it("rejects pre-quoted table names with a clear error", async () => {
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: 'has"quote', columns: ["x"], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /double-quote|pre-quoting/i);
  });

  it("rejects pre-quoted schema-qualified table names", async () => {
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: 'public."odd.name"', columns: ["x"], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    // The raw-string double-quote check runs before the dot-split, so a
    // pre-quoted name with an embedded dot gets the actionable "remove the
    // quotes" message, not the over-qualified one.
    assert.match(result.error ?? "", /double-quote|pre-quoting/i);
  });

  it("rejects an over-qualified (3+ part) table name", async () => {
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: "a.b.c", columns: ["x"], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /over-qualified/i);
  });

  it("rejects pre-quoted column names with a clear error", async () => {
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: "users", columns: ['has"quote'], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /double-quote|pre-quoting/i);
  });

  // Byte-length guard on per-piece schema/table identifiers. The Zod schema
  // caps `table` at 127 chars (room for `schema.table`), but each piece after
  // the split must still satisfy NAMEDATALEN-1 = 63 BYTES -- a 32-char
  // multi-byte name is 64 UTF-8 bytes and would silently truncate inside pg.
  it("rejects a table piece that exceeds 63 bytes via multi-byte chars", async () => {
    const overflow = "é".repeat(32); // 32 chars / 64 bytes
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: overflow, columns: ["x"], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /NAMEDATALEN|63-byte/i);
  });

  it("rejects a schema-qualified form where the schema piece is multi-byte overflow", async () => {
    const overflow = "é".repeat(32);
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: `${overflow}.users`, columns: ["x"], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /NAMEDATALEN|63-byte/i);
  });

  it("rejects a column name that exceeds 63 bytes (caught by validateHypoIndex)", async () => {
    const overflow = "é".repeat(32);
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: false,
      format: "text",
      hypothetical_indexes: [{ table: "users", columns: [overflow], using: "btree" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    // On the direct-call path the handler never reaches Zod -- this 63-byte
    // error comes from validateHypoIndex's per-column byte check in explain.ts.
    assert.match(result.error ?? "", /NAMEDATALEN|63-byte|exceeds/i);
  });

  it("rejects an unsupported `using` value on the direct-call path", async () => {
    // `using` is the second value in explain.ts whose VALUE reaches raw SQL --
    // it is interpolated into the CREATE INDEX text handed to
    // hypopg_create_index. `serialize` gets a membership re-check for exactly
    // this reason, but `using` used to get only buildHypopgHooks' `?? "btree"`,
    // which re-applies the DEFAULT and does nothing to an explicitly supplied
    // value. A direct caller (unit test, library consumer) bypasses the Zod
    // enum, so the garbage landed inside the statement.
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      hypothetical_indexes: [{ table: "users", columns: ["x"], using: "btree) /* injected" }],
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Unsupported `using` value/);
    // The legal methods have to be named. An agent told only "unsupported"
    // retries with another guess instead of picking from the list.
    assert.match(result.error ?? "", /btree, hash, gin, gist, brin, spgist/);
  });

  it("does not reject a legal non-default access method", async () => {
    // Over-narrowing is the usual failure mode of a membership guard: `gin` is
    // a legitimate hypopg access method and must survive the check. Reaching
    // the HypoPG-installed probe is the observable proof the pre-flight passed
    // -- that probe is the very next thing the handler does.
    await withStubbedServer(170_000, async (session) => {
      const result = (await pgExplain.handler({
        sql: "SELECT 1",
        hypothetical_indexes: [{ table: "docs", columns: ["body"], using: "gin" }],
      })) as { ok: boolean; error?: string };
      assert.equal(result.ok, true, result.error);
      assert.equal(session.hypoCreateSql(), 'CREATE INDEX ON "docs" USING gin ("body")');
    });
  });
});

describe("pg_explain planner option dependencies", () => {
  // These all short-circuit before the handler opens a connection, so they
  // ride the same fast unit path as the guards above -- no live postgres.

  it("rejects `wal` without analyze", async () => {
    const result = (await pgExplain.handler({ sql: "SELECT 1", wal: true })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /`wal`/);
    assert.match(result.error ?? "", /analyze: true/);
  });

  it("does NOT reject `memory` without analyze (MEMORY reports planning-phase memory)", async () => {
    // postgres accepts `EXPLAIN (MEMORY)` standalone: it measures the PLANNER,
    // which runs whether or not the statement executes. Rejecting it here
    // would make this tool stricter than the server.
    //
    // Two defects in the original version of this test, both fixed by the stub:
    // (1) `doesNotMatch(result.error ?? "", ...)` is satisfied by an EMPTY
    // string, so it stayed green no matter what the handler did -- including
    // rejecting with a different message, or the guard being deleted outright.
    // (2) It was the one case in this file that ran neither withoutDatabaseUrl
    // nor shutdown(), so it inherited whatever server_version_num a previously
    // executed test had cached and its outcome depended on test order.
    await withStubbedServer(170_000, async (session) => {
      const result = (await pgExplain.handler({ sql: "SELECT 1", memory: true })) as {
        ok: boolean;
        error?: string;
      };
      assert.doesNotMatch(result.error ?? "", /only apply with `analyze: true`/);
      assert.equal(result.ok, true, result.error);
      // MEMORY standing alone, with no ANALYZE alongside it, is the whole
      // claim -- pin the statement rather than the absence of one message.
      assert.equal(session.explainSql(), "EXPLAIN (MEMORY) SELECT 1");
    });
  });

  it("rejects `serialize` without analyze", async () => {
    const result = (await pgExplain.handler({ sql: "SELECT 1", serialize: "text" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /`serialize`/);
  });

  it("rejects `timing: false` without analyze (TIMING is an ANALYZE-only option)", async () => {
    const result = (await pgExplain.handler({ sql: "SELECT 1", timing: false })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /`timing`/);
  });

  it("names every offending option in one error rather than one per round trip", async () => {
    const result = (await pgExplain.handler({ sql: "SELECT 1", wal: true, serialize: "text" })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /`wal`/);
    assert.match(result.error ?? "", /`serialize`/);
  });

  it("allows `costs: false` without analyze (COSTS is not ANALYZE-only)", async () => {
    // Not rejected by the dependency guard and not version-gated, so the
    // handler runs on to the connection -- which is the observable proof it
    // passed validation. See withoutDatabaseUrl below for the mechanism.
    await withoutDatabaseUrl(() =>
      assert.rejects(() => pgExplain.handler({ sql: "SELECT 1", costs: false }), /DATABASE_URL is not set/),
    );
  });

  it("rejects generic_plan combined with analyze", async () => {
    const result = (await pgExplain.handler({ sql: "SELECT $1::int", analyze: true, generic_plan: true })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /cannot be combined/i);
  });

  it("rejects generic_plan combined with params", async () => {
    // GENERIC_PLAN's whole point is planning with the placeholders UNBOUND;
    // handing it values contradicts the request.
    const result = (await pgExplain.handler({ sql: "SELECT $1::int", generic_plan: true, params: [1] })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /without parameter values/i);
  });

  it("rejects an unsupported `serialize` value on the direct-call path", async () => {
    // Direct callers bypass the Zod enum, and `serialize` is the one option
    // whose value is interpolated into the EXPLAIN option list -- so the
    // handler re-checks membership itself.
    const result = (await pgExplain.handler({
      sql: "SELECT 1",
      analyze: true,
      serialize: "text) /* injected",
    })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Unsupported `serialize` value/);
  });
});

/**
 * Runs `fn` with DATABASE_URL cleared.
 *
 * The version gate calls getServerVersionNum(), which probes the live server.
 * With no DATABASE_URL, getPool() throws, getServerVersionNum swallows it and
 * returns its documented 0 ("unknown -- assume oldest") sentinel. That gives
 * these tests a deterministic "server too old" without a mock or a live
 * postgres. The value is saved and restored so nothing sharing the process
 * inherits a cleared env.
 */
async function withoutDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  // Clearing the env var is NOT enough on its own. Both caches this relies on
  // are module-scoped in api.ts and survive it: `getPool()` memoizes the pool,
  // and `getServerVersionNum()` short-circuits on a cached `serverVersionNum`.
  // If either was already populated -- by an earlier test in this file, or
  // simply because the developer running the suite has DATABASE_URL exported
  // -- the probe never re-runs, never throws, and never returns its 0
  // sentinel, so the six version-gate cases below silently assert the wrong
  // thing. That made the whole file pass on a machine with DATABASE_URL unset
  // and fail with four errors on one that has it set.
  //
  // `shutdown()` resets the pool, `serverVersionNum`, and `typeNameCache`
  // together, so it is the one call that actually restores the precondition.
  // Run it on the way OUT too: otherwise the 0 this block cached would leak
  // into whatever runs next.
  await shutdown();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    await shutdown();
  }
}

describe("pg_explain server-version gating", () => {
  const cases: { name: string; input: Record<string, unknown>; version: RegExp }[] = [
    { name: "settings", input: { settings: true }, version: /PostgreSQL 12\+/ },
    { name: "wal", input: { analyze: true, wal: true }, version: /PostgreSQL 13\+/ },
    { name: "generic_plan", input: { generic_plan: true }, version: /PostgreSQL 16\+/ },
    { name: "memory", input: { analyze: true, memory: true }, version: /PostgreSQL 17\+/ },
    { name: "serialize", input: { analyze: true, serialize: "binary" }, version: /PostgreSQL 17\+/ },
    // BUFFERS is ancient, but only PG13+ takes it without ANALYZE.
    // Label must match the handler's `gated` entry verbatim -- the assertion
    // below greps the error text for it. Deliberately backtick-free: the error
    // formatter adds its own pair, and an inner one renders nested.
    { name: "buffers without analyze", input: { buffers: true }, version: /PostgreSQL 13\+/ },
  ];

  for (const c of cases) {
    it(`rejects \`${c.name}\` when the server version is unknown, naming the required version`, async () => {
      const result = (await withoutDatabaseUrl(() => pgExplain.handler({ sql: "SELECT 1", ...c.input }))) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", c.version);
      assert.ok((result.error ?? "").includes(c.name), `error should name the option: ${result.error}`);
    });
  }

  it("reports that the version could not be determined rather than inventing one", async () => {
    const result = (await withoutDatabaseUrl(() => pgExplain.handler({ sql: "SELECT 1", generic_plan: true }))) as {
      ok: boolean;
      error?: string;
    };
    assert.match(result.error ?? "", /could not be determined/i);
  });

  it("names every unsupported option at once", async () => {
    const result = (await withoutDatabaseUrl(() =>
      pgExplain.handler({ sql: "SELECT 1", analyze: true, wal: true, memory: true }),
    )) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /`wal` requires PostgreSQL 13\+/);
    assert.match(result.error ?? "", /`memory` requires PostgreSQL 17\+/);
  });

  it("does NOT gate the pre-existing options when the version probe fails", async () => {
    // A probe of 0 must not block analyze/format/params -- those work on every
    // supported server. Reaching the connection attempt is the proof: the
    // handler got past validation and tried to run the EXPLAIN.
    await withoutDatabaseUrl(() =>
      assert.rejects(
        () => pgExplain.handler({ sql: "SELECT 1", analyze: true, format: "json" }),
        /DATABASE_URL is not set/,
      ),
    );
  });

  it("does NOT gate the analyze-implied BUFFERS default", async () => {
    // `buffers` defaults to true under analyze, and BUFFERS *with* ANALYZE has
    // no version floor -- so the new default can never trip the PG13 gate,
    // which only covers BUFFERS without ANALYZE.
    await withoutDatabaseUrl(() =>
      assert.rejects(() => pgExplain.handler({ sql: "SELECT 1", analyze: true }), /DATABASE_URL is not set/),
    );
  });

  it("does NOT gate a plain EXPLAIN with buffers omitted", async () => {
    await withoutDatabaseUrl(() =>
      assert.rejects(() => pgExplain.handler({ sql: "SELECT 1" }), /DATABASE_URL is not set/),
    );
  });
});

/** One statement the fake client saw, with the values bound to it. */
interface StubStatement {
  sql: string;
  params: unknown[];
}

interface StubSession {
  /** Every statement the fake client saw, in order. */
  statements: StubStatement[];
  /** Times the pool handed out a client. 0 proves a guard fired pre-connect. */
  connects: number;
  /** The EXPLAIN the handler built, or "" if it never reached the client. */
  explainSql(): string;
  /** The CREATE INDEX text handed to hypopg_create_index, or "". */
  hypoCreateSql(): string;
  /** The argument of each client.release() call; an Error there makes pg-pool destroy the client. */
  releases: unknown[];
  /** SQL sent through the pool itself rather than the checked-out client. */
  poolQueries: string[];
}

interface StubBehavior {
  /** Statements the fake server rejects, with a statement timeout. */
  failWhen?: (sql: string) => boolean;
  /**
   * The statement during which the socket dies: it and every later one fail
   * with a plain connection error -- no SQLSTATE, the way node-pg reports it.
   */
  dieWhen?: (sql: string) => boolean;
  /**
   * Statements the fake server refuses with the SQLSTATE returned, when it is
   * not a plain timeout: 42883 for a function this role cannot see, 42501 for
   * one it may not run, and so on. Checked before `failWhen`.
   */
  refuseWith?: (sql: string) => string | undefined;
  /**
   * Report a real column type on the FETCH so type-name resolution has an oid
   * to look up, and answer the pg_type read. Off by default: an empty field
   * list short-circuits the lookup, which keeps every other test's statement
   * trace free of it.
   */
  typedFields?: boolean;
  /**
   * The `code` the socket death carries. node-pg hands a socket error to the
   * query in flight as the raw Node error (ECONNRESET, EPIPE); a clean close
   * carries none. Only read when `dieWhen` fires.
   */
  dieWithCode?: string;
}

// runUserQueryBounded wraps the user statement in this, so the EXPLAIN the
// handler built is recoverable from the fake client by stripping the prefix.
const DECLARE_PREFIX = "DECLARE __pgmcp_cur NO SCROLL CURSOR FOR ";

/**
 * Runs `fn` against a fake postgres that reports `versionNum` and echoes
 * `planRows` back as the plan.
 *
 * Why this exists rather than another withoutDatabaseUrl case: that helper
 * only ever produces getServerVersionNum's 0 "unknown" sentinel, so every
 * version-gate test written on top of it asserts on the error STRING and none
 * of them exercises the NUMBER the `serverVersion < g.min` comparison uses.
 * Raising the generic_plan gate from PG16 to PG17 left the entire suite green
 * -- the gates could be inverted in production with a clean run. A stubbed
 * probe is the only way to pin a floor from the ACCEPTING side.
 *
 * Same mechanism as the pg_io_stats and pg_advisor suites: stub
 * `pg.Pool.prototype.query` (getServerVersionNum and runInternal both go
 * through the pool, not the shared client) AND `pg.Pool.prototype.connect`.
 * Leaving either alone sends real traffic at the fake host and hangs the suite
 * on a connect timeout.
 *
 * shutdown() runs on the way IN and on the way OUT because api.ts caches both
 * the pool and `serverVersionNum` at module scope. Without the reset, the
 * first case's version leaks into every later one and the boundary pairs below
 * become order-dependent -- a PG16 case would "pass" against a stub configured
 * for PG12.
 */
async function withStubbedServer<T>(
  versionNum: number,
  fn: (session: StubSession) => Promise<T>,
  planRows: string[] = ["Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)"],
  behavior: StubBehavior = {},
): Promise<T> {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;

  const statements: StubStatement[] = [];
  const releases: unknown[] = [];
  let dead = false;
  // The one piece of transaction state the teardown's correctness depends on:
  // a statement that fails inside a transaction aborts it, and Postgres then
  // refuses everything but ROLLBACK / ROLLBACK TO with 25P02. Measured on
  // PG15 and PG18; the advisor's stub models the same.
  let inTransaction = false;
  let aborted = false;
  const poolQueries: string[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  const session: StubSession = {
    statements,
    releases,
    poolQueries,
    connects: 0,
    explainSql() {
      return statements.find((s) => s.sql.startsWith(DECLARE_PREFIX))?.sql.slice(DECLARE_PREFIX.length) ?? "";
    },
    hypoCreateSql() {
      const call = statements.find((s) => s.sql.includes("hypopg_create_index"));
      return typeof call?.params[0] === "string" ? call.params[0] : "";
    },
  };

  const refuse = (sql: string): void => {
    const code = behavior.refuseWith?.(sql);
    if (code !== undefined) {
      const message =
        code === "42883"
          ? "function hypopg_reset() does not exist"
          : code === "42501"
            ? "permission denied for function"
            : `refused with ${code}`;
      throw Object.assign(new Error(message), { code });
    }
    if (behavior.failWhen?.(sql)) {
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    }
  };

  const respond = (sql: string) => {
    if (dead) throw new Error("Client has encountered a connection error and is not queryable");
    if (behavior.dieWhen?.(sql)) {
      dead = true;
      if (behavior.dieWithCode) {
        throw Object.assign(new Error(`read ${behavior.dieWithCode}`), { code: behavior.dieWithCode });
      }
      throw new Error("Connection terminated unexpectedly");
    }
    // ROLLBACK and ROLLBACK TO are the only statements an aborted transaction
    // accepts; BEGIN is refused like everything else.
    if (sql === "ROLLBACK") {
      refuse(sql);
      inTransaction = false;
      aborted = false;
      return { rows: [], fields: [], command: "ROLLBACK", rowCount: 0 };
    }
    if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
      refuse(sql);
      aborted = false;
      return { rows: [], fields: [], command: "ROLLBACK", rowCount: 0 };
    }
    if (aborted) {
      throw Object.assign(
        new Error("current transaction is aborted, commands ignored until end of transaction block"),
        { code: "25P02" },
      );
    }
    if (sql.startsWith("BEGIN")) {
      inTransaction = true;
      return { rows: [], fields: [], command: "BEGIN", rowCount: 0 };
    }
    refuse(sql);
    if (sql.includes("pg_terminate_backend(pg_backend_pid())")) {
      // What the server does with it, measured on PG15 and PG18: answers the
      // statement with 57P01 and closes the socket -- in or out of a
      // transaction; it is an ordinary function call. node-pg then emits
      // 'error' on the client when the socket closes.
      dead = true;
      queueMicrotask(() => {
        for (const l of errorListeners) l(new Error("Connection terminated unexpectedly"));
      });
      throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    }
    return undefined;
  };

  const client = {
    async query(config: unknown, params: unknown[] = []) {
      const sql = typeof config === "string" ? config : ((config as { text?: string }).text ?? "");
      const values = typeof config === "string" ? params : ((config as { values?: unknown[] }).values ?? params);
      statements.push({ sql, params: values });
      try {
        const handled = respond(sql);
        if (handled) return handled;
      } catch (err) {
        if (inTransaction && !dead) aborted = true;
        throw err;
      }

      const fetch = /^FETCH (\d+) FROM/.exec(sql);
      if (fetch) {
        // Hand back at most the requested count, exactly as the cursor would.
        // Returning the whole fixture regardless would make `truncated` fire on
        // a row count no real server could produce, so the truncation-notice
        // test below would prove nothing about the real FETCH maxRows+1 path.
        const limit = Number(fetch[1]);
        const rows = planRows.slice(0, limit).map((line) => ({ "QUERY PLAN": line }));
        const fields = behavior.typedFields ? [{ name: "QUERY PLAN", dataTypeID: 25 }] : [];
        return { rows, fields, command: "FETCH", rowCount: rows.length };
      }
      if (sql.includes("FROM pg_catalog.pg_type")) {
        return { rows: [{ oid: 25, typname: "text" }], fields: [], command: "SELECT", rowCount: 1 };
      }
      if (sql.includes("hypopg_create_index")) {
        // A null/absent indexname makes buildHypopgHooks' setup throw, which
        // would surface as an opaque failure in the `using` cases.
        return { rows: [{ indexname: "<1234>hypo_idx" }], fields: [], command: "SELECT", rowCount: 1 };
      }
      // `fields: []` matters: safeResolveTypeNames short-circuits on an empty
      // oid list, so the stub never has to fake pg_catalog.pg_type.
      return { rows: [], fields: [], command: "", rowCount: 0 };
    },
    release(err?: unknown) {
      releases.push(err);
    },
    // acquireClient() attaches an 'error' listener for the checked-out lifetime.
    on(event: string, fn: (err: Error) => void) {
      if (event === "error") errorListeners.push(fn);
      return this;
    },
    removeListener(event: string, fn: (err: Error) => void) {
      if (event === "error") errorListeners.splice(errorListeners.indexOf(fn), 1);
      return this;
    },
  };

  await shutdown();
  process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
    const text = typeof sql === "string" ? sql : "";
    poolQueries.push(text);
    if (text.includes("server_version_num")) return Promise.resolve({ rows: [{ v: String(versionNum) }] });
    if (text.includes("FROM pg_catalog.pg_type")) {
      return Promise.resolve({ rows: [{ oid: 25, typname: "text" }], fields: [], command: "SELECT", rowCount: 1 });
    }
    // The HypoPG presence probe runs through runInternal -> pool.query. Report
    // it installed so the `using` cases reach the CREATE INDEX text.
    if (text.includes("hypopg")) return Promise.resolve({ rows: [{ installed: true }] });
    return Promise.resolve({ rows: [] });
  } as unknown as typeof pg.Pool.prototype.query;
  pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
    session.connects += 1;
    return Promise.resolve(client);
  } as unknown as typeof pg.Pool.prototype.connect;

  try {
    return await fn(session);
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  }
}

describe("pg_explain server-version gate boundaries (stubbed probe)", () => {
  // Floors are spelled out as literals rather than imported from api.ts on
  // purpose. Importing PG16/PG17 would make the test move in lockstep with the
  // constants, so redefining `PG16 = 170_000` would keep the suite green while
  // silently raising every gate that references it. These numbers are the
  // contract the tool's own description promises callers.
  const cases: {
    /** Must match the handler's `gated` label verbatim -- asserted on below. */
    option: string;
    min: number;
    input: Record<string, unknown>;
    /** The exact statement the handler must emit once the gate is cleared. */
    accepted: string;
    since: RegExp;
  }[] = [
    {
      option: "settings",
      min: 120_000,
      input: { settings: true },
      accepted: "EXPLAIN (SETTINGS) SELECT 1",
      since: /PostgreSQL 12\+/,
    },
    {
      option: "wal",
      min: 130_000,
      input: { analyze: true, wal: true },
      accepted: "EXPLAIN (ANALYZE, BUFFERS, WAL) SELECT 1",
      since: /PostgreSQL 13\+/,
    },
    {
      // BUFFERS itself is ancient; only PG13+ takes it without ANALYZE.
      option: "buffers without analyze",
      min: 130_000,
      input: { buffers: true },
      accepted: "EXPLAIN (BUFFERS) SELECT 1",
      since: /PostgreSQL 13\+/,
    },
    {
      option: "generic_plan",
      min: 160_000,
      input: { generic_plan: true },
      accepted: "EXPLAIN (GENERIC_PLAN) SELECT 1",
      since: /PostgreSQL 16\+/,
    },
    {
      option: "memory",
      min: 170_000,
      input: { memory: true },
      accepted: "EXPLAIN (MEMORY) SELECT 1",
      since: /PostgreSQL 17\+/,
    },
    {
      option: "serialize",
      min: 170_000,
      input: { analyze: true, serialize: "binary" },
      accepted: "EXPLAIN (ANALYZE, BUFFERS, SERIALIZE BINARY) SELECT 1",
      since: /PostgreSQL 17\+/,
    },
  ];

  for (const c of cases) {
    it(`accepts \`${c.option}\` at exactly server_version_num=${c.min}`, async () => {
      // The ACCEPTING side is the half no pre-existing test covered, and the
      // half that catches a gate raised too high (generic_plan's PG16 floor
      // mutated to PG17). Asserting the emitted SQL rather than `ok` alone
      // additionally catches a gate that lets the call through but drops the
      // option on the floor.
      await withStubbedServer(c.min, async (session) => {
        const result = (await pgExplain.handler({ sql: "SELECT 1", ...c.input })) as { ok: boolean; error?: string };
        assert.equal(result.ok, true, `expected the gate to pass at ${c.min}: ${result.error}`);
        assert.equal(session.explainSql(), c.accepted);
      });
    });

    it(`rejects \`${c.option}\` at exactly server_version_num=${c.min - 1}`, async () => {
      // One below the floor, not one major below: a `<=` typo in the
      // `serverVersion < g.min` comparison only shows up at the exact
      // boundary, and 150_000 would sail past it.
      await withStubbedServer(c.min - 1, async (session) => {
        const result = (await pgExplain.handler({ sql: "SELECT 1", ...c.input })) as { ok: boolean; error?: string };
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", c.since);
        assert.ok((result.error ?? "").includes(c.option), `error should name the option: ${result.error}`);
        // The DETECTED-version branch has to be the one that ran. Its message
        // differs from the 0-sentinel branch's ("could not be determined"), and
        // only this one proves a real number was compared -- which is precisely
        // what the withoutDatabaseUrl cases above cannot show.
        assert.match(result.error ?? "", /this server reports PostgreSQL/);
        // Rejecting BEFORE the connection is the point: an older server answers
        // `unrecognized EXPLAIN option`, which reads like a caller typo.
        assert.equal(session.connects, 0);
      });
    });
  }

  it("clears every gate at once on a server new enough for all of them", async () => {
    // The gates are collected into one list and filtered together; a per-option
    // pass says nothing about the combined path.
    await withStubbedServer(170_000, async (session) => {
      const result = (await pgExplain.handler({
        sql: "SELECT 1",
        analyze: true,
        settings: true,
        wal: true,
        memory: true,
        serialize: "text",
      })) as { ok: boolean; error?: string };
      assert.equal(result.ok, true, result.error);
      assert.equal(session.explainSql(), "EXPLAIN (ANALYZE, BUFFERS, SETTINGS, WAL, MEMORY, SERIALIZE TEXT) SELECT 1");
    });
  });

  it("reports every unsupported option, not just the first one below the floor", async () => {
    // PG13: `wal` clears, `memory` and `serialize` do not. A caller told only
    // about `memory` fixes it, re-runs, and gets told about `serialize`.
    await withStubbedServer(130_000, async () => {
      const result = (await pgExplain.handler({
        sql: "SELECT 1",
        analyze: true,
        wal: true,
        memory: true,
        serialize: "text",
      })) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /`memory` requires PostgreSQL 17\+/);
      assert.match(result.error ?? "", /`serialize` requires PostgreSQL 17\+/);
      // `wal`'s floor is met here, so naming it would send the caller to drop a
      // perfectly good option.
      assert.doesNotMatch(result.error ?? "", /`wal` requires/);
      assert.match(result.error ?? "", /this server reports PostgreSQL 13/);
    });
  });

  it("skips the version probe entirely when no gated option was requested", async () => {
    // getServerVersionNum returns the 0 sentinel on a server we cannot probe,
    // so consulting it unconditionally would gate analyze/format/params on
    // something that has no version floor at all. PG12 is below every floor in
    // the table above, so a probe that ran here would reject.
    await withStubbedServer(120_000, async (session) => {
      const result = (await pgExplain.handler({ sql: "SELECT 1", analyze: true, format: "json" })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, true, result.error);
      assert.equal(session.explainSql(), "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1");
    });
  });
});

describe("pg_explain text-plan truncation notice", () => {
  // A text plan arrives one row per line, so a plan longer than
  // POSTGRES_MAX_ROWS is chopped mid-output by the cursor FETCH. Handing those
  // lines back unmarked gives the caller a plan that LOOKS complete -- the node
  // they are hunting may be in the part that was dropped. The notice is the
  // only signal. query.integration.test.ts forces the same truncation against a
  // live server for pg_query; this covers pg_explain's own branch, which had
  // no coverage at all.

  /** Runs `fn` with POSTGRES_MAX_ROWS pinned, restoring whatever was there. */
  async function withMaxRows(value: string, fn: () => Promise<void>): Promise<void> {
    const original = process.env.POSTGRES_MAX_ROWS;
    process.env.POSTGRES_MAX_ROWS = value;
    try {
      await fn();
    } finally {
      if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
      else process.env.POSTGRES_MAX_ROWS = original;
    }
  }

  it("appends the notice when the plan overflows POSTGRES_MAX_ROWS", async () => {
    await withMaxRows("2", async () => {
      await withStubbedServer(170_000, async () => {
        const result = (await pgExplain.handler({ sql: "SELECT 1" })) as { ok: boolean; data?: { plan: string } };
        assert.equal(result.ok, true);
        const lines = (result.data?.plan ?? "").split("\n");
        // 2 plan lines (the POSTGRES_MAX_ROWS slice) + the notice.
        assert.deepEqual(lines.slice(0, 2), ["line-1", "line-2"]);
        // The count is the number of lines RETURNED, not the number the
        // server produced -- it is what the caller sizes the
        // POSTGRES_MAX_ROWS bump against, so reporting the pre-slice length
        // here would be actively misleading.
        assert.equal(lines[2], "... [plan truncated at 2 lines; raise POSTGRES_MAX_ROWS to see the full plan]");
        assert.equal(lines.length, 3);
      }, ["line-1", "line-2", "line-3", "line-4"]);
    });
  });

  it("omits the notice when the plan fits", async () => {
    // The negative half: without it, a notice appended unconditionally would
    // pass the test above while corrupting every normal plan.
    await withMaxRows("2", async () => {
      await withStubbedServer(170_000, async () => {
        const result = (await pgExplain.handler({ sql: "SELECT 1" })) as { ok: boolean; data?: { plan: string } };
        assert.equal(result.ok, true);
        assert.equal(result.data?.plan, "line-1\nline-2");
      }, ["line-1", "line-2"]);
    });
  });

  it("never appends the notice on the json path", async () => {
    // FORMAT JSON returns the whole plan in ONE row, so it cannot trip the row
    // cap -- and the notice is a plain string that would corrupt the JSON
    // payload if the text branch's logic were ever hoisted above the format
    // check.
    await withMaxRows("2", async () => {
      await withStubbedServer(170_000, async () => {
        const result = (await pgExplain.handler({ sql: "SELECT 1", format: "json" })) as {
          ok: boolean;
          data?: { plan: unknown };
        };
        assert.equal(result.ok, true);
        assert.equal(result.data?.plan, "line-1");
      }, ["line-1", "line-2", "line-3", "line-4"]);
    });
  });
});

describe("pg_explain HypoPG teardown order (stubbed)", () => {
  // Statement indexes of the three teardown steps, or -1 when a step was not
  // sent. `ROLLBACK` is matched exactly: `ROLLBACK TO SAVEPOINT` contains it.
  function teardownOrder(session: StubSession) {
    const sqls = session.statements.map((s) => s.sql);
    return {
      hookSavepoint: sqls.indexOf("SAVEPOINT __pgmcp_hooks"),
      restore: sqls.indexOf("ROLLBACK TO SAVEPOINT __pgmcp_hooks"),
      reset: sqls.findIndex((s) => s.includes("hypopg_reset")),
      rollback: sqls.indexOf("ROLLBACK"),
      last: sqls.length - 1,
    };
  }
  const withIndexes = {
    sql: "SELECT * FROM t WHERE a = 1",
    format: "text",
    hypothetical_indexes: [{ table: "t", columns: ["a"] }],
  };

  it("resets inside the transaction: after ROLLBACK TO the hook savepoint, before the final ROLLBACK", async () => {
    // HypoPG indexes are session-scoped. Behind a transaction-mode pooler the
    // backend is pinned to this connection only until the transaction ends, so
    // a reset sent after the ROLLBACK can reach a different backend than the
    // one holding the indexes, and report success.
    await withStubbedServer(180_000, async (session) => {
      const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
      assert.equal(result.ok, true);
      const o = teardownOrder(session);
      assert.ok(o.hookSavepoint >= 0, "no hook savepoint was taken");
      assert.ok(o.restore > o.hookSavepoint, "no ROLLBACK TO the hook savepoint");
      assert.ok(o.reset > o.restore, "the reset ran before the ROLLBACK TO");
      assert.ok(o.rollback > o.reset, "the reset ran after the ROLLBACK, outside the transaction");
      assert.equal(o.rollback, o.last, "something was sent after the ROLLBACK");
      assert.deepEqual(session.releases, [undefined]);
    });
  });

  it("keeps that order when the user's statement fails and the transaction is aborted", async () => {
    // What a real server does for pg_explain: EXPLAIN cannot be a cursor, so
    // the DECLARE is refused with 42601 (measured on 15/17/18), the row-cap
    // code falls back, and the direct EXPLAIN is what times out. The
    // transaction is aborted when the teardown runs; the ROLLBACK TO is what
    // lets the reset through.
    //
    // The DECLARE must be refused with a "cannot be a cursor" code here, not
    // failed with the timeout: a 57014 at DECLARE is surfaced at once and the
    // direct EXPLAIN would never be sent, leaving this test off the path it
    // is named for.
    await withStubbedServer(
      180_000,
      async (session) => {
        const result = (await pgExplain.handler(withIndexes)) as { ok: boolean; error?: string };
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /statement timeout/);
        assert.ok(
          session.statements.some((s) => s.sql.startsWith("EXPLAIN")),
          "the direct EXPLAIN was never sent -- the fallback did not run",
        );
        const o = teardownOrder(session);
        assert.ok(o.restore >= 0 && o.reset > o.restore && o.rollback > o.reset);
        assert.deepEqual(session.releases, [undefined]);
      },
      undefined,
      {
        refuseWith: (sql) => (sql.startsWith("DECLARE") ? "42601" : undefined),
        failWhen: (sql) => sql.startsWith("EXPLAIN"),
      },
    );
  });

  it("retries a reset a live server refused, and keeps the connection when the retry succeeds", async () => {
    // A cancel or timeout landing on hypopg_reset() aborted the transaction.
    // The hook savepoint survives the first ROLLBACK TO, so a second one
    // clears the abort and the reset can be tried again, still pinned to the
    // backend that holds the indexes. A retry that succeeds leaves nothing
    // behind, so the connection goes back to the pool.
    let resets = 0;
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
          assert.equal(result.ok, true, "a cleanup failure replaced the call's own result");
          const sqls = session.statements.map((s) => s.sql);
          assert.equal(sqls.filter((s) => s === "ROLLBACK TO SAVEPOINT __pgmcp_hooks").length, 2);
          assert.equal(sqls.filter((s) => s.includes("hypopg_reset")).length, 2);
          assert.equal(
            sqls.filter((s) => s.includes("pg_terminate_backend")).length,
            0,
            "a backend was terminated over a transient",
          );
          assert.equal(sqls.indexOf("ROLLBACK"), sqls.length - 1);
          assert.deepEqual(session.releases, [undefined], "a clean connection was discarded");
          // The line names what failed the first time, or an operator cannot
          // tell a cancel from a permission problem that happened to pass.
          assert.ok(
            logged.some((l) =>
              /teardown failed \(teardown failed: .*statement timeout\) and succeeded on retry; the connection is kept/.test(
                l,
              ),
            ),
            JSON.stringify(logged),
          );
        },
        undefined,
        { failWhen: (sql) => sql.includes("hypopg_reset") && ++resets === 1 },
      );
    } finally {
      console.error = originalError;
    }
  });

  it("terminates its own backend when the reset fails twice on a live server, then discards", async () => {
    // Discarding the connection alone ends at a transaction-mode pooler; the
    // backend would keep the hypothetical indexes for its next client. Ending
    // the backend from inside the transaction is pinned to the right one and
    // needs no privilege (measured as a non-superuser on PG15 and PG18).
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
          assert.equal(result.ok, true, "a cleanup failure replaced the call's own result");
          const sqls = session.statements.map((s) => s.sql);
          const terminate = sqls.findIndex((s) => s.includes("pg_terminate_backend(pg_backend_pid())"));
          const lastReset = sqls.map((s) => s.includes("hypopg_reset")).lastIndexOf(true);
          assert.ok(terminate >= 0, "the backend was not terminated");
          assert.ok(terminate > lastReset, "terminated before the retry");
          assert.equal(sqls.filter((s) => s.includes("hypopg_reset")).length, 2, "the reset was not retried first");
          // The retry's failure aborted the transaction again; the terminate
          // is refused unless a ROLLBACK TO clears that first. The stub models
          // the refusal, so a terminate that reached the server is the proof.
          assert.equal(
            sqls[terminate - 1],
            "ROLLBACK TO SAVEPOINT __pgmcp_hooks",
            "no ROLLBACK TO before the terminate",
          );
          assert.ok(
            session.statements.filter((s) => s.sql === "ROLLBACK TO SAVEPOINT __pgmcp_hooks").length === 3,
            "expected: before teardown, before the retry, before the terminate",
          );
          // Inside the transaction: nothing ends it before the terminate, and
          // nothing is sent to a backend that is gone.
          assert.equal(sqls.indexOf("ROLLBACK"), -1);
          assert.equal(terminate, sqls.length - 1);
          const released = session.releases[0];
          assert.ok(released instanceof Error, "a connection whose backend was ended was pooled");
          assert.match(
            released.message,
            /^teardown failed twice, backend terminated: teardown failed: .*statement timeout/,
          );
          assert.ok(
            logged.some((l) => /terminated own backend after a cleanup that failed twice/.test(l)),
            JSON.stringify(logged),
          );
          // 57P01 is the server's answer to the terminate, not a failure.
          assert.ok(!logged.some((l) => /terminate own backend failed|NOT terminated/.test(l)), JSON.stringify(logged));
          // The socket closing afterwards was asked for; it is logged as that.
          await new Promise((r) => setImmediate(r));
          assert.ok(
            logged.some((l) => /connection closed after this process terminated its own backend/.test(l)),
            JSON.stringify(logged),
          );
          assert.ok(!logged.some((l) => /connection error on a checked-out client/.test(l)), JSON.stringify(logged));
        },
        undefined,
        { failWhen: (sql) => sql.includes("hypopg_reset") },
      );
    } finally {
      console.error = originalError;
    }
  });

  it("neither retries nor terminates when the reset failed because the socket died", async () => {
    // No SQLSTATE means no server answered. There is no backend left to
    // clean or to end; the connection is discarded and that is all.
    await withStubbedServer(
      180_000,
      async (session) => {
        const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
        assert.equal(result.ok, true);
        const sqls = session.statements.map((s) => s.sql);
        assert.equal(sqls.filter((s) => s.includes("hypopg_reset")).length, 1, "a dead socket was retried");
        assert.equal(
          sqls.filter((s) => s === "ROLLBACK TO SAVEPOINT __pgmcp_hooks").length,
          1,
          "a retry's ROLLBACK TO was sent into a dead socket",
        );
        assert.equal(
          sqls.filter((s) => s.includes("pg_terminate_backend")).length,
          0,
          "a dead socket was 'terminated'",
        );
        assert.ok(session.releases[0] instanceof Error);
      },
      undefined,
      { dieWhen: (sql) => sql.includes("hypopg_reset") },
    );
  });

  it("does not claim to have terminated a backend when the socket died during the retry", async () => {
    // A live server refused the first reset; the socket dies during the
    // retry. There is no backend left to end, and saying otherwise on stderr
    // would send an operator looking for a termination that never happened.
    let resets = 0;
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
          assert.equal(result.ok, true);
          const sqls = session.statements.map((s) => s.sql);
          assert.equal(sqls.filter((s) => s.includes("hypopg_reset")).length, 2, "the retry was not attempted");
          assert.equal(
            sqls.filter((s) => s.includes("pg_terminate_backend")).length,
            0,
            "a dead socket was 'terminated'",
          );
          assert.ok(
            !logged.some((l) => /terminated own backend|backend NOT terminated/.test(l)),
            JSON.stringify(logged),
          );
          const released = session.releases[0];
          assert.ok(released instanceof Error);
          assert.doesNotMatch(released.message, /terminat/);
        },
        undefined,
        {
          failWhen: (sql) => sql.includes("hypopg_reset") && ++resets === 1,
          dieWhen: (sql) => sql.includes("hypopg_reset") && resets === 1 && ++resets === 2,
        },
      );
    } finally {
      console.error = originalError;
    }
  });

  it("takes no hook savepoint when there are no hooks, so the plain path pays no extra round trip", async () => {
    await withStubbedServer(180_000, async (session) => {
      const result = (await pgExplain.handler({ sql: "SELECT 1", format: "text" })) as { ok: boolean };
      assert.equal(result.ok, true);
      const o = teardownOrder(session);
      assert.equal(o.hookSavepoint, -1);
      assert.equal(o.restore, -1);
      assert.equal(o.reset, -1);
      assert.equal(o.rollback, o.last);
    });
  });

  it("resolves type names AFTER the transaction has ended, so the pg_type read holds no user locks", async () => {
    // On a cold cache the lookup is a catalog round trip. Before the teardown
    // rework it ran after the ROLLBACK; a rework that pulled ROLLBACK into
    // `finally` briefly moved it inside the still-open transaction, where an
    // EXPLAIN ANALYZE of DML would hold its row locks across it. Pinned for
    // both the plain path and the hooks path.
    for (const input of [{ sql: "SELECT 1", format: "text" }, withIndexes]) {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(input)) as { ok: boolean };
          assert.equal(result.ok, true);
          const sqls = session.statements.map((s) => s.sql);
          const typeRead = sqls.findIndex((s) => s.includes("FROM pg_catalog.pg_type"));
          const rollback = sqls.indexOf("ROLLBACK");
          assert.ok(typeRead >= 0, "precondition: a pg_type read happened (typedFields)");
          assert.ok(typeRead > rollback, `pg_type read at #${typeRead} ran before ROLLBACK at #${rollback}`);
          assert.deepEqual(session.releases, [undefined]);
        },
        undefined,
        { typedFields: true },
      );
    }
  });

  it("says the backend was NOT terminated when the transaction could not be cleared to send the terminate", async () => {
    // Every ROLLBACK TO the hook savepoint is refused, including the one that
    // has to clear the abort before the terminate. A terminate sent into the
    // still-aborted transaction would only be refused with 25P02, so it is not
    // sent at all -- and the discard reason and stderr say what actually
    // happened instead of claiming a termination. Each failure is logged, not
    // only the first.
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
          assert.equal(result.ok, true);
          const sqls = session.statements.map((s) => s.sql);
          assert.equal(
            sqls.filter((s) => s.includes("pg_terminate_backend")).length,
            0,
            "a terminate was sent into an aborted transaction",
          );
          const released = session.releases[0];
          assert.ok(released instanceof Error);
          assert.match(released.message, /^teardown failed twice and the backend could not be terminated/);
          assert.doesNotMatch(released.message, /backend terminated/);
          assert.ok(
            logged.some((l) => /own backend NOT terminated -- the transaction could not be cleared first/.test(l)),
            JSON.stringify(logged),
          );
          assert.ok(!logged.some((l) => /terminated own backend after/.test(l)), JSON.stringify(logged));
          assert.ok(
            logged.some((l) =>
              /\[postgres-mcp\] hook savepoint rollback \(retry\) failed: .*statement timeout/.test(l),
            ),
            `the retry's failure never reached stderr: ${JSON.stringify(logged)}`,
          );
        },
        undefined,
        { failWhen: (sql) => sql === "ROLLBACK TO SAVEPOINT __pgmcp_hooks" },
      );
    } finally {
      console.error = originalError;
    }
  });

  it("says the backend was NOT terminated when the server refuses the terminate itself", async () => {
    // 42501: the session's current role may not signal the backend's role (a
    // SET ROLE to a role without membership in the login role). 57P01 is the
    // only answer that means the backend is gone.
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
          assert.equal(result.ok, true);
          const sqls = session.statements.map((s) => s.sql);
          assert.equal(sqls.filter((s) => s.includes("pg_terminate_backend")).length, 1);
          // Still in a live transaction on a live backend: end it.
          assert.equal(sqls.at(-1), "ROLLBACK", "the transaction was left open after a refused terminate");
          const released = session.releases[0];
          assert.ok(released instanceof Error);
          assert.match(released.message, /could not be terminated \(permission denied/);
          assert.ok(
            logged.some((l) => /own backend NOT terminated -- permission denied/.test(l)),
            JSON.stringify(logged),
          );
        },
        undefined,
        {
          failWhen: (sql) => sql.includes("hypopg_reset"),
          refuseWith: (sql) => (sql.includes("pg_terminate_backend") ? "42501" : undefined),
        },
      );
    } finally {
      console.error = originalError;
    }
  });

  it("does not escalate when HypoPG is present but not callable: nothing was created, so nothing can leak", async () => {
    // pg_extension lists HypoPG, so the pre-flight passes, but this role cannot
    // see its functions (schema off the search_path): the first create fails
    // with 42883 and no index exists. The teardown is skipped outright -- a
    // reset would fail the same way, and treating that as a leak would
    // terminate a clean backend on every call.
    await withStubbedServer(
      180_000,
      async (session) => {
        const result = (await pgExplain.handler(withIndexes)) as { ok: boolean; error?: string };
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /does not exist/);
        const sqls = session.statements.map((s) => s.sql);
        assert.equal(
          sqls.filter((s) => s.includes("hypopg_reset")).length,
          0,
          "a reset was sent with nothing to reset",
        );
        assert.equal(
          sqls.filter((s) => s.includes("pg_terminate_backend")).length,
          0,
          "a clean backend was terminated",
        );
        assert.equal(sqls.at(-1), "ROLLBACK");
        assert.deepEqual(session.releases, [undefined], "a clean connection was discarded");
      },
      undefined,
      { refuseWith: (sql) => (/hypopg_(create_index|reset)/.test(sql) ? "42883" : undefined) },
    );
  });

  it("treats a socket error that carries an errno code as a dead connection, not a server answer", async () => {
    // node-pg hands a socket failure to the query in flight as the raw Node
    // error, and its `code` is a string too (ECONNRESET). That is not a
    // SQLSTATE, and nothing answered: no terminate, and no claim of one.
    let resets = 0;
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withStubbedServer(
        180_000,
        async (session) => {
          const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
          assert.equal(result.ok, true);
          const sqls = session.statements.map((s) => s.sql);
          assert.equal(
            sqls.filter((s) => s.includes("pg_terminate_backend")).length,
            0,
            "a dead socket was 'terminated'",
          );
          assert.ok(
            !logged.some((l) => /terminated own backend|backend NOT terminated/.test(l)),
            JSON.stringify(logged),
          );
          const released = session.releases[0];
          assert.ok(released instanceof Error);
          assert.doesNotMatch(released.message, /terminat/);
        },
        undefined,
        {
          failWhen: (sql) => sql.includes("hypopg_reset") && ++resets === 1,
          dieWhen: (sql) => sql === "ROLLBACK TO SAVEPOINT __pgmcp_hooks" && resets === 1,
          dieWithCode: "ECONNRESET",
        },
      );
    } finally {
      console.error = originalError;
    }
  });

  it("resolves type names through the pool after its own backend was terminated", async () => {
    // The checkout's connection is gone; a catalog read queued on it would
    // only fail and lose the column type names. Any pooled connection can
    // answer it instead.
    await withStubbedServer(
      180_000,
      async (session) => {
        const result = (await pgExplain.handler(withIndexes)) as { ok: boolean };
        assert.equal(result.ok, true);
        const sqls = session.statements.map((s) => s.sql);
        const terminate = sqls.findIndex((s) => s.includes("pg_terminate_backend"));
        assert.ok(terminate >= 0, "precondition: the backend was terminated");
        assert.equal(
          terminate,
          sqls.length - 1,
          `sent on the dead checkout after the terminate: ${sqls.slice(terminate + 1).join(" | ")}`,
        );
        assert.ok(
          session.poolQueries.some((q) => q.includes("FROM pg_catalog.pg_type")),
          "the type read did not go through the pool",
        );
      },
      undefined,
      { failWhen: (sql) => sql.includes("hypopg_reset"), typedFields: true },
    );
  });

  it("does not run teardown when the hook savepoint itself was refused: nothing was set up", async () => {
    // A cancel landing on SAVEPOINT __pgmcp_hooks aborts the transaction
    // before setup ran. Sending hypopg_reset() into it would only be refused
    // with 25P02 and discard a clean connection over its own noise.
    await withStubbedServer(
      180_000,
      async (session) => {
        const result = (await pgExplain.handler(withIndexes)) as { ok: boolean; error?: string };
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /statement timeout/);
        const sqls = session.statements.map((s) => s.sql);
        assert.equal(sqls.filter((s) => s.includes("hypopg_reset")).length, 0, "teardown ran with nothing to undo");
        assert.equal(sqls.filter((s) => s.startsWith("ROLLBACK TO")).length, 0);
        assert.equal(sqls.indexOf("ROLLBACK"), sqls.length - 1);
        assert.deepEqual(session.releases, [undefined], "a clean connection was discarded");
      },
      undefined,
      { failWhen: (sql) => sql === "SAVEPOINT __pgmcp_hooks" },
    );
  });
});
