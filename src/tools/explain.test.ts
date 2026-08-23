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
): Promise<T> {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;

  const statements: StubStatement[] = [];
  const session: StubSession = {
    statements,
    connects: 0,
    explainSql() {
      return statements.find((s) => s.sql.startsWith(DECLARE_PREFIX))?.sql.slice(DECLARE_PREFIX.length) ?? "";
    },
    hypoCreateSql() {
      const call = statements.find((s) => s.sql.includes("hypopg_create_index"));
      return typeof call?.params[0] === "string" ? call.params[0] : "";
    },
  };

  const client = {
    async query(config: unknown, params: unknown[] = []) {
      const sql = typeof config === "string" ? config : ((config as { text?: string }).text ?? "");
      const values = typeof config === "string" ? params : ((config as { values?: unknown[] }).values ?? params);
      statements.push({ sql, params: values });

      const fetch = /^FETCH (\d+) FROM/.exec(sql);
      if (fetch) {
        // Hand back at most the requested count, exactly as the cursor would.
        // Returning the whole fixture regardless would make `truncated` fire on
        // a row count no real server could produce, so the truncation-notice
        // test below would prove nothing about the real FETCH maxRows+1 path.
        const limit = Number(fetch[1]);
        const rows = planRows.slice(0, limit).map((line) => ({ "QUERY PLAN": line }));
        return { rows, fields: [], command: "FETCH", rowCount: rows.length };
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
    release() {
      /* no-op */
    },
  };

  await shutdown();
  process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
    const text = typeof sql === "string" ? sql : "";
    if (text.includes("server_version_num")) return Promise.resolve({ rows: [{ v: String(versionNum) }] });
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
