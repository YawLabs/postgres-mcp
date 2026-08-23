import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  auditQuery,
  getAuditConfig,
  initAudit,
  isAuditEnabled,
  resetAuditForTests,
  runWithAuditTool,
  setAuditSinkForTests,
} from "./audit.js";

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
