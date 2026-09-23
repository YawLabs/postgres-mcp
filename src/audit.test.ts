import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import {
  getServerVersionNum,
  runReadOnly,
  runReadWrite,
  runReadWriteRollback,
  shutdown,
  withSharedClient,
} from "./api.js";
import {
  auditQuery,
  getAuditConfig,
  initAudit,
  isAuditEnabled,
  resetAuditForTests,
  runWithAuditTool,
  setAuditSinkForTests,
} from "./audit.js";
import { wrapToolHandler } from "./mcp-wrapper.js";
import { explainTools } from "./tools/explain.js";
import { queryTools } from "./tools/query.js";

const AUDIT_ENV = ["POSTGRES_AUDIT_LOG", "POSTGRES_AUDIT_LOG_FILE", "POSTGRES_AUDIT_REDACT"] as const;

let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const name of AUDIT_ENV) {
    envSnapshot[name] = process.env[name];
    delete process.env[name];
  }
  // Every test starts from the shipped posture: nothing configured, nothing
  // logged. A test that leaked an open sink into the next one would make the
  // off-by-default assertions pass for the wrong reason.
  resetAuditForTests();
});

afterEach(() => {
  resetAuditForTests();
  for (const name of AUDIT_ENV) {
    const original = envSnapshot[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

/** Turns auditing on with the given env and captures the emitted lines. */
function captureAudit(env: Record<string, string> = { POSTGRES_AUDIT_LOG: "1" }): string[] {
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  initAudit();
  const lines: string[] = [];
  setAuditSinkForTests((line) => {
    lines.push(line);
  });
  return lines;
}

function parseOnly(lines: string[]): Record<string, unknown> {
  assert.equal(lines.length, 1, `expected exactly one audit line, got ${JSON.stringify(lines)}`);
  const line = lines[0]!;
  assert.ok(
    line.endsWith("\n"),
    "each record must be a complete JSON line so a tail-reader never splices two together",
  );
  return JSON.parse(line) as Record<string, unknown>;
}

describe("audit is off by default", () => {
  it("reports disabled with no POSTGRES_AUDIT_* env set", () => {
    assert.equal(getAuditConfig().enabled, false);
    initAudit();
    assert.equal(isAuditEnabled(), false);
  });

  it("writes nothing to stderr for a query when unconfigured", async () => {
    initAudit();
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await auditQuery(
        { source: "user", sql: "SELECT 1", paramCount: 0 },
        () => Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 }),
        (r) => r.rowCount,
      );
      assert.deepEqual(result, { rows: [{ n: 1 }], rowCount: 1 }, "the wrapper must be transparent when disabled");
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.deepEqual(writes, [], "silence is the default posture -- an unconfigured server must log no SQL at all");
  });

  it("stays off for the explicit off values", () => {
    for (const value of ["0", "false", "off", "OFF"]) {
      process.env.POSTGRES_AUDIT_LOG = value;
      assert.equal(getAuditConfig().enabled, false, `POSTGRES_AUDIT_LOG=${value} should be off`);
    }
  });

  it("turns on for 1 / true / stderr", () => {
    for (const value of ["1", "true", "stderr", "TRUE", " stderr "]) {
      process.env.POSTGRES_AUDIT_LOG = value;
      const config = getAuditConfig();
      assert.equal(config.enabled, true, `POSTGRES_AUDIT_LOG=${value} should be on`);
      assert.equal(config.file, null, "no file configured means the stderr sink");
    }
  });

  it("turns on when only POSTGRES_AUDIT_LOG_FILE is set", () => {
    process.env.POSTGRES_AUDIT_LOG_FILE = "/var/log/pgmcp-audit.log";
    const config = getAuditConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.file, "/var/log/pgmcp-audit.log");
  });
});

/** Sets the var, or deletes it for `undefined` -- the absent case, not an empty one. */
function setEnv(name: (typeof AUDIT_ENV)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The message getAuditConfig() refuses the current env with; fails the test when it does not refuse. */
function refusal(label: string): string {
  try {
    getAuditConfig();
  } catch (err) {
    assert.ok(err instanceof Error, label);
    return err.message;
  }
  assert.fail(`${label}: expected getAuditConfig() to refuse this config`);
}

describe("audit config rejects ambiguity loudly", () => {
  it("throws on an unrecognized POSTGRES_AUDIT_LOG value", () => {
    process.env.POSTGRES_AUDIT_LOG = "yes";
    assert.throws(() => getAuditConfig(), /POSTGRES_AUDIT_LOG="yes" is not a recognized value/);
  });

  it("throws on an unrecognized POSTGRES_AUDIT_REDACT value", () => {
    // The dangerous direction: a typo here would otherwise write full SQL to
    // disk for an operator who asked for hashes.
    process.env.POSTGRES_AUDIT_LOG = "1";
    process.env.POSTGRES_AUDIT_REDACT = "hash";
    assert.throws(() => getAuditConfig(), /POSTGRES_AUDIT_REDACT="hash" is not a recognized value/);
  });

  it("names unredacted SQL, not a silently-off trail, as the risk of a bad POSTGRES_AUDIT_REDACT", () => {
    // Reading REDACT as off never empties the trail -- it fills it with SQL. And
    // the refusal fires with auditing off too, so the risk it names must hold then.
    for (const log of ["1", undefined]) {
      setEnv("POSTGRES_AUDIT_LOG", log);
      process.env.POSTGRES_AUDIT_REDACT = "hash";
      const label = `POSTGRES_AUDIT_LOG=${log}`;
      const message = refusal(label);
      assert.match(message, /unredacted SQL whenever auditing is on/, label);
      assert.doesNotMatch(message, /silently off/, label);
    }
  });

  // An env entry whose variable did not expand where the MCP client runs
  // reaches the server as present and empty. POSTGRES_AUDIT_LOG_FILE refuses
  // that below; reading it as unset on the two flags would leave the trail off,
  // or -- on POSTGRES_AUDIT_REDACT -- log full SQL for an operator who asked
  // for hashes.
  it("throws when POSTGRES_AUDIT_LOG is set but empty or whitespace-only", () => {
    // With a file configured too, empty-as-unset turned auditing on through the
    // file -- still a guess about what the empty value was meant to say.
    for (const file of [undefined, "/tmp/pgmcp-audit.log"]) {
      setEnv("POSTGRES_AUDIT_LOG_FILE", file);
      for (const value of ["", "   ", "\t"]) {
        process.env.POSTGRES_AUDIT_LOG = value;
        const label = `POSTGRES_AUDIT_LOG=${JSON.stringify(value)}, POSTGRES_AUDIT_LOG_FILE=${file}`;
        const message = refusal(label);
        assert.match(message, /POSTGRES_AUDIT_LOG is set but empty/, label);
        assert.match(message, /unexpanded variable/, label);
        assert.match(message, /Remove the variable, or set it to 1/, label);
      }
    }
  });

  it("throws when POSTGRES_AUDIT_REDACT is set but empty or whitespace-only, with auditing on", () => {
    process.env.POSTGRES_AUDIT_LOG = "1";
    for (const value of ["", "   ", "\t"]) {
      process.env.POSTGRES_AUDIT_REDACT = value;
      const label = `POSTGRES_AUDIT_REDACT=${JSON.stringify(value)}`;
      const message = refusal(label);
      assert.match(message, /POSTGRES_AUDIT_REDACT is set but empty/, label);
      assert.match(message, /unexpanded variable/, label);
      assert.match(message, /unredacted SQL/, label);
      assert.match(message, /Remove the variable/, label);
    }
  });

  it("throws when POSTGRES_AUDIT_REDACT is set but empty or whitespace-only, with auditing off", () => {
    // Same rule as an unrecognized value: refused while nothing is logged, so the
    // mistake surfaces now rather than on the day someone turns auditing on.
    for (const log of [undefined, "0"]) {
      setEnv("POSTGRES_AUDIT_LOG", log);
      for (const value of ["", "   "]) {
        process.env.POSTGRES_AUDIT_REDACT = value;
        const label = `POSTGRES_AUDIT_LOG=${log}, POSTGRES_AUDIT_REDACT=${JSON.stringify(value)}`;
        const message = refusal(label);
        assert.match(message, /POSTGRES_AUDIT_REDACT is set but empty/, label);
        assert.match(message, /unredacted SQL whenever auditing is on/, label);
      }
    }
  });

  it("throws when POSTGRES_AUDIT_LOG_FILE is set but empty", () => {
    process.env.POSTGRES_AUDIT_LOG_FILE = "";
    assert.throws(() => getAuditConfig(), /POSTGRES_AUDIT_LOG_FILE is set but empty/);
  });

  it("throws when a file is configured while the log is explicitly off", () => {
    process.env.POSTGRES_AUDIT_LOG = "off";
    process.env.POSTGRES_AUDIT_LOG_FILE = "/tmp/pgmcp-audit.log";
    assert.throws(() => getAuditConfig(), /Refusing to guess which one you meant/);
  });
});

describe("audit record shape", () => {
  it("emits one JSON line per statement with the documented fields", async () => {
    const lines = captureAudit();
    await auditQuery(
      { source: "user", sql: "SELECT * FROM users WHERE id = $1", paramCount: 1 },
      () => Promise.resolve({ rows: [{ id: 7 }], rowCount: 1 }),
      (r) => r.rowCount,
    );
    const entry = parseOnly(lines);
    assert.equal(entry.source, "user");
    assert.equal(entry.sql, "SELECT * FROM users WHERE id = $1");
    assert.equal(entry.params, 1);
    assert.equal(entry.rows, 1);
    assert.equal(entry.ok, true);
    assert.equal(entry.sqlstate, undefined, "SQLSTATE belongs only on the failure path");
    assert.equal(typeof entry.ms, "number");
    assert.ok((entry.ms as number) >= 0, `duration must never be negative, got ${entry.ms}`);
    assert.equal(typeof entry.ts, "string");
    assert.equal(new Date(entry.ts as string).toISOString(), entry.ts, "ts must be a round-trippable ISO timestamp");
  });

  it("keeps internal catalog SQL distinguishable from agent SQL", async () => {
    const lines = captureAudit();
    await auditQuery(
      { source: "internal", sql: "SELECT oid, typname FROM pg_catalog.pg_type", paramCount: 0 },
      () => Promise.resolve({ rows: [], rowCount: 0 }),
      (r) => r.rowCount,
    );
    assert.equal(parseOnly(lines).source, "internal");
  });

  it("records the tool name when the caller established one", async () => {
    const lines = captureAudit();
    await runWithAuditTool("pg_query", () =>
      auditQuery(
        { source: "user", sql: "SELECT 1", paramCount: 0 },
        () => Promise.resolve({ rows: [], rowCount: 0 }),
        (r) => r.rowCount,
      ),
    );
    assert.equal(parseOnly(lines).tool, "pg_query");
  });

  // The test above proves the MECHANISM works when something calls it. This one
  // proves the production path actually does: runWithAuditTool and the
  // AsyncLocalStorage behind it shipped with no caller outside this file, so
  // every real audit line came out missing the one field that says which tool
  // issued the statement. Asserting through wrapToolHandler -- the exact
  // function index.ts registers -- is what keeps the wiring from being dropped
  // again, since a unit test of audit.ts alone cannot observe its absence.
  it("tags lines through wrapToolHandler, the wiring index.ts actually uses", async () => {
    const lines = captureAudit();
    const wrapped = wrapToolHandler(
      () =>
        auditQuery(
          { source: "user", sql: "SELECT 1", paramCount: 0 },
          () => Promise.resolve({ rows: [], rowCount: 0 }),
          (r) => r.rowCount,
        ).then(() => ({ ok: true })),
      "pg_describe_table",
    );
    await wrapped({});
    assert.equal(parseOnly(lines).tool, "pg_describe_table");
  });

  it("omits the tool field entirely when no tool context is active", async () => {
    const lines = captureAudit();
    await auditQuery(
      { source: "internal", sql: "SELECT 1", paramCount: 0 },
      () => Promise.resolve({ rows: [], rowCount: 0 }),
      (r) => r.rowCount,
    );
    assert.equal("tool" in parseOnly(lines), false, "an absent tool must not show up as null/empty");
  });

  it("records ok:false with the SQLSTATE and rethrows the original error", async () => {
    const lines = captureAudit();
    const pgError = Object.assign(new Error("duplicate key violates unique constraint; Key (email)=(a@b.com)"), {
      code: "23505",
    });
    await assert.rejects(
      () =>
        auditQuery(
          { source: "user", sql: "INSERT INTO users (email) VALUES ($1)", paramCount: 1 },
          () => Promise.reject(pgError),
          () => 0,
        ),
      (err: unknown) => err === pgError,
    );
    const raw = lines[0]!;
    const entry = parseOnly(lines);
    assert.equal(entry.ok, false);
    assert.equal(entry.sqlstate, "23505");
    assert.equal(entry.rows, null, "rows stays present as null so consumers can project a fixed schema");
    // postgres quotes the offending value back in the message; logging it would
    // put the PII the parameter rule keeps out back into the trail.
    assert.equal(raw.includes("a@b.com"), false, "the pg error message must not be logged");
    assert.equal("error" in entry, false);
  });

  it("writes to stderr when no file is configured", async () => {
    process.env.POSTGRES_AUDIT_LOG = "stderr";
    initAudit();
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await auditQuery(
        { source: "user", sql: "SELECT 1", paramCount: 0 },
        () => Promise.resolve({ rows: [], rowCount: 0 }),
        (r) => r.rowCount,
      );
    } finally {
      process.stderr.write = originalWrite;
    }
    // stdout is the MCP protocol channel -- an audit line there would corrupt
    // the JSON-RPC framing and kill the session, so stderr is the only safe
    // default destination.
    assert.equal(parseOnly(writes).sql, "SELECT 1");
  });
});

describe("audit never records parameter values", () => {
  it("logs the count only, even though the caller holds the values", async () => {
    const lines = captureAudit();
    // The shape api.ts builds: paramCount: params.length, values left behind.
    const params = ["hunter2", "jeff@rad.fyi"];
    await auditQuery(
      { source: "user", sql: "SELECT * FROM users WHERE pw = $1 AND email = $2", paramCount: params.length },
      () => Promise.resolve({ rows: [], rowCount: 0 }),
      (r) => r.rowCount,
    );
    const raw = lines[0]!;
    for (const value of params) {
      assert.equal(raw.includes(value), false, `bound value ${JSON.stringify(value)} leaked into the audit line`);
    }
    const entry = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(entry.params, 2);
    assert.equal(
      entry.sql,
      "SELECT * FROM users WHERE pw = $1 AND email = $2",
      "placeholders stay, values never arrive",
    );
  });
});

describe("audit redaction (hash-only mode)", () => {
  const sql = "SELECT ssn FROM people WHERE email = 'jeff@rad.fyi'";

  it("logs the first keyword and a sha256 instead of the statement text", async () => {
    const lines = captureAudit({ POSTGRES_AUDIT_LOG: "1", POSTGRES_AUDIT_REDACT: "1" });
    await auditQuery(
      { source: "user", sql, paramCount: 0 },
      () => Promise.resolve({ rows: [], rowCount: 0 }),
      (r) => r.rowCount,
    );
    const raw = lines[0]!;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    assert.equal("sql" in entry, false, "redacted mode must not carry the statement text under any key");
    assert.equal(entry.sqlKeyword, "SELECT");
    assert.equal(entry.sqlSha256, createHash("sha256").update(sql).digest("hex"));
    // The inline literal is the whole reason this mode exists.
    assert.equal(raw.includes("jeff@rad.fyi"), false);
    assert.equal(raw.includes("ssn"), false);
  });

  it("hashes identical statements identically so operators can still correlate", async () => {
    const lines = captureAudit({ POSTGRES_AUDIT_LOG: "1", POSTGRES_AUDIT_REDACT: "true" });
    for (let i = 0; i < 2; i++) {
      await auditQuery(
        { source: "user", sql, paramCount: 0 },
        () => Promise.resolve({ rows: [], rowCount: 0 }),
        (r) => r.rowCount,
      );
    }
    const [first, second] = lines.map((l) => JSON.parse(l) as { sqlSha256: string });
    assert.equal(first!.sqlSha256, second!.sqlSha256);
  });

  it("reports UNKNOWN rather than a value-bearing prefix for a statement that does not start with a word", async () => {
    const lines = captureAudit({ POSTGRES_AUDIT_LOG: "1", POSTGRES_AUDIT_REDACT: "1" });
    await auditQuery(
      { source: "user", sql: "/* ticket=SECRET-42 */ SELECT 1", paramCount: 0 },
      () => Promise.resolve({ rows: [], rowCount: 0 }),
      (r) => r.rowCount,
    );
    const raw = lines[0]!;
    assert.equal((JSON.parse(raw) as { sqlKeyword: string }).sqlKeyword, "UNKNOWN");
    assert.equal(raw.includes("SECRET-42"), false, "the keyword field must not become a leak channel");
  });
});

describe("a failing audit sink degrades the log, never the query", () => {
  it("returns the query result when the sink throws", async () => {
    captureAudit();
    setAuditSinkForTests(() => {
      throw new Error("sink exploded");
    });
    const originalErr = console.error;
    const warnings: string[] = [];
    console.error = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const result = await auditQuery(
        { source: "user", sql: "SELECT 1", paramCount: 0 },
        () => Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 }),
        (r) => r.rowCount,
      );
      assert.deepEqual(result, { rows: [{ n: 1 }], rowCount: 1 });
      // Second statement: the warning is suppressed so a permanently broken
      // sink cannot flood stderr, but the query still succeeds.
      await auditQuery(
        { source: "user", sql: "SELECT 2", paramCount: 0 },
        () => Promise.resolve({ rows: [], rowCount: 0 }),
        (r) => r.rowCount,
      );
    } finally {
      console.error = originalErr;
    }
    assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0]!, /audit log write failed/);
    assert.match(warnings[0]!, /sink exploded/);
  });

  it("still surfaces the query's own error when the sink throws on the failure path", async () => {
    captureAudit();
    setAuditSinkForTests(() => {
      throw new Error("sink exploded");
    });
    const originalErr = console.error;
    console.error = () => {};
    const queryError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    try {
      await assert.rejects(
        () =>
          auditQuery(
            { source: "user", sql: "SELECT * FROM nope", paramCount: 0 },
            () => Promise.reject(queryError),
            () => 0,
          ),
        (err: unknown) => err === queryError,
      );
    } finally {
      console.error = originalErr;
    }
  });

  it("does not let a throwing row-count accessor lose the statement", async () => {
    const lines = captureAudit();
    const result = await auditQuery(
      { source: "user", sql: "SELECT 1", paramCount: 0 },
      () => Promise.resolve({ rows: [] }),
      () => {
        throw new Error("unexpected result shape");
      },
    );
    assert.deepEqual(result, { rows: [] }, "the accessor's failure must not reach the caller");
    assert.equal(parseOnly(lines).rows, null, "the line is still written, just without a count");
  });
});

describe("audit file sink", () => {
  it("appends JSON lines to the configured path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgmcp-audit-"));
    const file = join(dir, "audit.log");
    try {
      process.env.POSTGRES_AUDIT_LOG_FILE = file;
      initAudit();
      await auditQuery(
        { source: "user", sql: "SELECT 1", paramCount: 0 },
        () => Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 }),
        (r) => r.rowCount,
      );
      await auditQuery(
        { source: "internal", sql: "SELECT 2", paramCount: 0 },
        () => Promise.resolve({ rows: [], rowCount: 0 }),
        (r) => r.rowCount,
      );
      const written = readFileSync(file, "utf-8").trimEnd().split("\n");
      assert.equal(written.length, 2);
      assert.equal((JSON.parse(written[0]!) as { sql: string }).sql, "SELECT 1");
      assert.equal((JSON.parse(written[1]!) as { source: string }).source, "internal");
    } finally {
      // Close the descriptor before removing the directory -- Windows refuses
      // to unlink a file that still has an open handle.
      resetAuditForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws at startup when the file cannot be opened", () => {
    const missing = join(tmpdir(), `pgmcp-audit-missing-${process.pid}`, "audit.log");
    process.env.POSTGRES_AUDIT_LOG_FILE = missing;
    // Loud beats silent: a server that started anyway would leave the operator
    // believing a trail exists.
    assert.throws(() => initAudit(), /could not be opened for append/);
    assert.equal(isAuditEnabled(), false);
  });
});

describe("initAudit is idempotent", () => {
  it("ignores a second call so importers of api.ts cannot reopen the sink", async () => {
    const lines = captureAudit();
    process.env.POSTGRES_AUDIT_REDACT = "1";
    initAudit();
    await auditQuery(
      { source: "user", sql: "SELECT 1", paramCount: 0 },
      () => Promise.resolve({ rows: [], rowCount: 0 }),
      (r) => r.rowCount,
    );
    const entry = parseOnly(lines);
    assert.equal(entry.sql, "SELECT 1", "the second init must not have swapped in the redacted mode");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A statement that never ran still gets its line (#42).
//
// The three user-SQL runners used to check the connection out, BEGIN, and run
// any hooks BEFORE the audited step, so a refused connection, a BEGIN the
// server refused, or a hook setup that threw skipped auditQuery entirely.
// Against a pool that refused connections, every tool that starts with a
// catalog query wrote its ok:false line and pg_query / pg_readonly / pg_explain
// -- the tools the trail exists for -- wrote nothing. The checkout and the
// transaction setup now sit inside the statement's audited span.
//
// These cases drive the REAL runners against `pg.Pool.prototype.connect`
// stubs, the same boundary mcp-wrapper.test.ts and admin.test.ts stub: no
// network, no live server. Move the checkout back out of the span in api.ts
// and every "one line" assertion below goes red on the count.
// ─────────────────────────────────────────────────────────────────────────

/** A failure shaped the way pg reports one: a `code` when the server (or Node) supplied one. */
function pgError(message: string, code?: string): Error {
  return code === undefined ? new Error(message) : Object.assign(new Error(message), { code });
}

/**
 * A checked-out client that answers every statement with an empty result,
 * except the ones `refuse` names. It records what was sent, so a test can
 * prove the agent's SQL never went out.
 */
function makeFakeClient(refuse: (sql: string) => Error | undefined = () => undefined) {
  const statements: string[] = [];
  // The argument of each client.release() call. The runners' release paths
  // were restructured around the audited span, so each case below checks the
  // checkout went back exactly once, and with no discard reason -- an Error
  // here would make pg-pool destroy the connection.
  const releases: unknown[] = [];
  return {
    statements,
    releases,
    async query(config: unknown) {
      const sql = typeof config === "string" ? config : ((config as { text?: string }).text ?? "");
      statements.push(sql);
      const err = refuse(sql);
      if (err) throw err;
      // `fields: []` keeps safeResolveTypeNames from asking for pg_type.
      return { rows: [], fields: [], command: "", rowCount: 0 };
    },
    release(discard?: unknown) {
      releases.push(discard);
    },
    // acquireClient() attaches an 'error' listener for the checked-out
    // lifetime through `on` and removes it here.
    on() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
}

describe("a statement that never ran still gets its audit line (#42)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalAllowWrites = process.env.ALLOW_WRITES;
  const originalDbUrl = process.env.DATABASE_URL;
  let lines: string[] = [];
  const sql = "SELECT * FROM orders WHERE customer = $1";
  // Seven digits on purpose: no `ts` or `ms` value can contain the run by
  // accident, so its absence from the raw line says something about the
  // parameter and not about luck.
  const params = ["cust-4191234"];
  const refused = () => pgError("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED");

  /** `pool.connect()` rejects with `err`; nothing is ever checked out. */
  function refuseConnections(err: Error): void {
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.reject(err);
    } as typeof pg.Pool.prototype.connect;
  }

  /** `pool.connect()` hands out `client`. */
  function connectTo(client: ReturnType<typeof makeFakeClient>): void {
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  function onlyLine(): { raw: string; entry: Record<string, unknown> } {
    assert.equal(lines.length, 1, `expected exactly one audit line, got ${JSON.stringify(lines)}`);
    const raw = lines[0]!;
    return { raw, entry: JSON.parse(raw) as Record<string, unknown> };
  }

  beforeEach(async () => {
    // Rebuild the pool against the stub. A DATABASE_URL must be present or
    // getPool() throws on construction, before connect() is ever reached --
    // a different failure path (covered by index.test.ts) than the one here.
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    process.env.ALLOW_WRITES = "1";
    lines = captureAudit();
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalAllowWrites === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = originalAllowWrites;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  const runners = [
    { name: "runReadOnly", begin: "BEGIN READ ONLY", run: () => runReadOnly(sql, params) },
    { name: "runReadWrite", begin: "BEGIN", run: () => runReadWrite(sql, params) },
    { name: "runReadWriteRollback", begin: "BEGIN", run: () => runReadWriteRollback(sql, params) },
  ] as const;

  for (const { name, run } of runners) {
    it(`${name}: a refused connection writes the statement's ok:false line and returns the error`, async () => {
      refuseConnections(refused());
      const res = await run();
      assert.equal(res.ok, false, "a refused connection is the call's failure, returned like any other");
      assert.match(res.error ?? "", /ECONNREFUSED/);

      const { raw, entry } = onlyLine();
      assert.equal(entry.source, "user");
      assert.equal(entry.sql, sql);
      assert.equal(entry.params, 1, "the count, never the values");
      assert.equal(raw.includes("cust-4191234"), false, `a parameter value reached the audit line: ${raw}`);
      assert.equal(entry.ok, false);
      assert.equal(entry.rows, null);
      assert.equal(entry.sqlstate, "ECONNREFUSED", "the Node code stands in for the SQLSTATE a server never sent");
    });
  }

  for (const { name, begin, run } of runners) {
    it(`${name}: a BEGIN the server refuses writes the line with its SQLSTATE, and the statement is never sent`, async () => {
      const client = makeFakeClient((s) =>
        s === begin ? pgError("terminating connection due to administrator command", "57P01") : undefined,
      );
      connectTo(client);
      const res = await run();
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /57P01/);

      const { entry } = onlyLine();
      assert.equal(entry.source, "user");
      assert.equal(entry.sql, sql);
      assert.equal(entry.ok, false);
      assert.equal(entry.sqlstate, "57P01");
      assert.equal(client.statements[0], begin, "sanity: the transaction was opened first");
      assert.ok(
        client.statements.every((s) => !s.includes(sql)),
        `the agent's SQL went out after a failed BEGIN: ${JSON.stringify(client.statements)}`,
      );
      assert.deepEqual(client.releases, [undefined], "the checkout goes back to the pool once, and is kept");
    });
  }

  it("a connect timeout, which carries no code, writes the line without a sqlstate", async () => {
    refuseConnections(pgError("timeout exceeded when trying to connect"));
    const res = await runReadOnly(sql, params);
    assert.equal(res.ok, false);
    const { entry } = onlyLine();
    assert.equal(entry.ok, false);
    assert.equal("sqlstate" in entry, false, "no code was supplied, so none may be invented");
  });

  it("a missing DATABASE_URL writes the line with no sqlstate, and the error names the variable", async () => {
    // getPool() throws before the pool exists, from inside the audited span.
    // index.test.ts pins the same for the catalog tools over the wire; this is
    // the agent-SQL path, in process.
    delete process.env.DATABASE_URL;
    await shutdown();
    const res = await runReadOnly(sql, params);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /DATABASE_URL is not set/);
    const { entry } = onlyLine();
    assert.equal(entry.source, "user");
    assert.equal(entry.sql, sql);
    assert.equal(entry.ok, false);
    assert.equal("sqlstate" in entry, false);
  });

  it("a hook setup that throws writes the line for the statement it was preparing", async () => {
    // pg_explain's hypothetical_indexes: setup creates the indexes inside the
    // transaction, before the EXPLAIN. When it throws, the EXPLAIN never runs
    // -- and used to leave no trace of having been asked for.
    const client = makeFakeClient();
    connectTo(client);
    let teardownRan = false;
    const explainSql = "EXPLAIN SELECT * FROM orders";
    const res = await runReadOnly(explainSql, [], {
      setup: async () => {
        throw pgError('relation "orders" does not exist', "42P01");
      },
      teardown: async () => {
        teardownRan = true;
      },
      sessionStateCreated: () => false,
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /42P01/);

    const { entry } = onlyLine();
    assert.equal(entry.source, "user");
    assert.equal(entry.sql, explainSql);
    assert.equal(entry.params, 0);
    assert.equal(entry.ok, false);
    assert.equal(entry.sqlstate, "42P01", "the setup failure's code, on the line of the statement it stopped");
    // What went out: the transaction and the hook savepoint, then the
    // rollback -- never the EXPLAIN, and never a teardown for state that was
    // not created.
    assert.deepEqual(client.statements, ["BEGIN READ ONLY", "SAVEPOINT __pgmcp_hooks", "ROLLBACK"]);
    assert.equal(teardownRan, false);
    assert.deepEqual(client.releases, [undefined], "released once, kept: a clean rollback leaves nothing behind");
  });

  it("is one line, not two, when the statement itself is what fails", async () => {
    // The span around the checkout must not add a line to the one the
    // statement's own failure already wrote.
    const client = makeFakeClient((s) =>
      s.startsWith("DECLARE") ? pgError('relation "orders" does not exist', "42P01") : undefined,
    );
    connectTo(client);
    const res = await runReadOnly(sql, params);
    assert.equal(res.ok, false);
    const { entry } = onlyLine();
    assert.equal(entry.ok, false);
    assert.equal(entry.sqlstate, "42P01");
    assert.ok(
      client.statements.some((s) => s.includes(sql)),
      "sanity: this time the statement was sent",
    );
    assert.deepEqual(client.releases, [undefined]);
  });

  it("is one ok:true line when everything works", async () => {
    const client = makeFakeClient();
    connectTo(client);
    const res = await runReadOnly(sql, params);
    assert.equal(res.ok, true, res.error);
    const { entry } = onlyLine();
    assert.equal(entry.ok, true);
    assert.equal(entry.rows, 0);
    assert.equal(entry.sql, sql);
    assert.deepEqual(client.releases, [undefined]);
  });

  it("runReadWrite: one ok:true line, and the checkout is released once after COMMIT", async () => {
    const client = makeFakeClient();
    connectTo(client);
    const res = await runReadWrite(sql, params);
    assert.equal(res.ok, true, res.error);
    const { entry } = onlyLine();
    assert.equal(entry.ok, true);
    assert.equal(client.statements[0], "BEGIN");
    assert.equal(client.statements.at(-1), "COMMIT");
    assert.deepEqual(client.releases, [undefined]);
  });

  for (const toolName of ["pg_readonly", "pg_query"] as const) {
    it(`${toolName}: the line carries the tool when driven through the MCP wrapper`, async () => {
      // pg_readonly runs through runReadOnly and pg_query, with ALLOW_WRITES
      // set, through runReadWrite: both runners, under the names index.ts
      // registers.
      refuseConnections(refused());
      const tool = queryTools.find((t) => t.name === toolName)!;
      const wrapped = wrapToolHandler(tool.handler as (input: unknown) => Promise<unknown>, tool.name);
      const res = await wrapped({ sql, params });
      assert.equal(res.isError, true);
      assert.match(res.content[0]!.text, /ECONNREFUSED/);

      const { entry } = onlyLine();
      assert.equal(entry.tool, toolName);
      assert.equal(entry.source, "user");
      assert.equal(entry.sql, sql);
      assert.equal(entry.ok, false);
    });
  }

  it("under POSTGRES_AUDIT_REDACT the never-sent statement is still only a keyword and a hash", async () => {
    resetAuditForTests();
    lines = captureAudit({ POSTGRES_AUDIT_LOG: "1", POSTGRES_AUDIT_REDACT: "1" });
    refuseConnections(refused());
    await runReadOnly(sql, params);
    const { raw, entry } = onlyLine();
    assert.equal("sql" in entry, false, "redaction must drop the statement text on this path too");
    assert.equal(entry.sqlKeyword, "SELECT");
    assert.equal(entry.sqlSha256, createHash("sha256").update(sql).digest("hex"));
    assert.equal(raw.includes("orders"), false);
    assert.equal(entry.sqlstate, "ECONNREFUSED");
  });

  it("withSharedClient writes nothing for a refused connection, by design", async () => {
    // Deliberate, and documented at withSharedClient in api.ts: the
    // connection is checked out before the callback composes a statement,
    // so there is no truthful `sql` to put on a line. Pinned so that a change
    // is a decision and not a side effect.
    refuseConnections(refused());
    await assert.rejects(
      withSharedClient(async (run) => run("SELECT 1")),
      /ECONNREFUSED/,
    );
    assert.deepEqual(lines, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The server-version probe is an internal line (#42, found in review).
//
// pg_explain with a version-floored option, and the tools that probe before
// checking out their shared connection (pg_describe_table, pg_advisor,
// pg_table_bloat, pg_seq_scan_tables, pg_unused_indexes, pg_io_stats,
// pg_index_advisor), run getServerVersionNum() before anything else reaches
// the database, and it swallows every failure into the 0 sentinel. Unaudited,
// a refused connection under any of them wrote no line: the fix above moved
// the checkout into the agent statement's span, and this path never reached
// that span. The probe's own query is now audited like runInternal's.
// ─────────────────────────────────────────────────────────────────────────
describe("the server-version probe writes an internal line (#42)", () => {
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let lines: string[] = [];
  const probeSql = "SELECT current_setting('server_version_num') AS v";

  /** The pool answers the probe with `version`, or rejects with `err`. */
  function probeAnswers(version: string | undefined, err?: Error): void {
    pg.Pool.prototype.query = function queryStub(this: pg.Pool) {
      if (err) return Promise.reject(err);
      return Promise.resolve({ rows: [{ v: version }], fields: [], command: "SELECT", rowCount: 1 });
    } as unknown as typeof pg.Pool.prototype.query;
  }

  beforeEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    lines = captureAudit();
  });

  afterEach(async () => {
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("logs a successful probe once per process: the second call is served from the cache", async () => {
    probeAnswers("170000");
    assert.equal(await getServerVersionNum(), 170_000);
    assert.equal(await getServerVersionNum(), 170_000);
    assert.equal(lines.length, 1, `expected one line for two calls, got ${JSON.stringify(lines)}`);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.source, "internal");
    assert.equal(entry.sql, probeSql);
    assert.equal(entry.params, 0);
    assert.equal(entry.ok, true);
    assert.equal(entry.rows, 1);
  });

  it("logs a failed probe on every call, with the code, and still returns the 0 sentinel", async () => {
    probeAnswers(undefined, pgError("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED"));
    assert.equal(await getServerVersionNum(), 0, "the probe's contract: never throw, report 0");
    assert.equal(await getServerVersionNum(), 0);
    assert.equal(lines.length, 2, "a failure is not cached, so each call probes and each probe is logged");
    for (const raw of lines) {
      const entry = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(entry.source, "internal");
      assert.equal(entry.sql, probeSql);
      assert.equal(entry.ok, false);
      assert.equal(entry.rows, null);
      assert.equal(entry.sqlstate, "ECONNREFUSED");
    }
  });

  it("logs a probe that cannot start because DATABASE_URL is unset, with no sqlstate", async () => {
    delete process.env.DATABASE_URL;
    await shutdown();
    assert.equal(await getServerVersionNum(), 0);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.ok, false);
    assert.equal("sqlstate" in entry, false);
  });

  it("pg_explain with a version-floored option on a refused connection: the probe's line, under the tool", async () => {
    // The case review found: the gate answered "the server version could not
    // be determined" from the 0 sentinel and returned before any audited
    // span, so the call left no trace. Now the probe's own ok:false line
    // records it, tagged pg_explain; the EXPLAIN text itself is not on it,
    // because the statement is composed only after the gate.
    probeAnswers(undefined, pgError("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED"));
    const pgExplain = explainTools.find((t) => t.name === "pg_explain")!;
    const wrapped = wrapToolHandler(pgExplain.handler as (input: unknown) => Promise<unknown>, pgExplain.name);
    const res = await wrapped({ sql: "SELECT * FROM orders", settings: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /could not be determined/);
    assert.equal(lines.length, 1, `expected the probe's line, got ${JSON.stringify(lines)}`);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.tool, "pg_explain");
    assert.equal(entry.source, "internal");
    assert.equal(entry.sql, probeSql);
    assert.equal(entry.ok, false);
    assert.equal(entry.sqlstate, "ECONNREFUSED");
  });
});
