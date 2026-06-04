import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import {
  getConnectionTimeoutMs,
  getMaxRows,
  getPoolMax,
  getSslConfig,
  getStatementTimeoutMs,
  isWritesAllowed,
  safeResolveTypeNames,
  shutdown,
} from "./api.js";

describe("isWritesAllowed", () => {
  const original = process.env.ALLOW_WRITES;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = original;
  });

  it("defaults to false when unset", () => {
    delete process.env.ALLOW_WRITES;
    assert.equal(isWritesAllowed(), false);
  });

  it("is true for '1'", () => {
    process.env.ALLOW_WRITES = "1";
    assert.equal(isWritesAllowed(), true);
  });

  it("is true for 'true'", () => {
    process.env.ALLOW_WRITES = "true";
    assert.equal(isWritesAllowed(), true);
  });

  it("is false for other truthy-looking strings (strict opt-in)", () => {
    for (const v of ["yes", "y", "on", "TRUE", "True", "0", "false", ""]) {
      process.env.ALLOW_WRITES = v;
      assert.equal(isWritesAllowed(), false, `ALLOW_WRITES=${JSON.stringify(v)} should be false`);
    }
  });
});

describe("getMaxRows", () => {
  const original = process.env.POSTGRES_MAX_ROWS;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
    else process.env.POSTGRES_MAX_ROWS = original;
  });

  it("defaults to 1000", () => {
    delete process.env.POSTGRES_MAX_ROWS;
    assert.equal(getMaxRows(), 1000);
  });

  it("accepts positive integers", () => {
    process.env.POSTGRES_MAX_ROWS = "50";
    assert.equal(getMaxRows(), 50);
  });

  it("floors fractional values", () => {
    process.env.POSTGRES_MAX_ROWS = "99.9";
    assert.equal(getMaxRows(), 99);
  });

  it("falls back to 1000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_MAX_ROWS = v;
      assert.equal(getMaxRows(), 1000, `POSTGRES_MAX_ROWS=${JSON.stringify(v)} should default`);
    }
  });
});

describe("getPoolMax", () => {
  const original = process.env.POSTGRES_POOL_MAX;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_POOL_MAX;
    else process.env.POSTGRES_POOL_MAX = original;
  });

  it("defaults to 5", () => {
    delete process.env.POSTGRES_POOL_MAX;
    assert.equal(getPoolMax(), 5);
  });

  it("accepts positive integers", () => {
    process.env.POSTGRES_POOL_MAX = "1";
    assert.equal(getPoolMax(), 1);
  });

  it("floors fractional values", () => {
    process.env.POSTGRES_POOL_MAX = "3.7";
    assert.equal(getPoolMax(), 3);
  });

  it("falls back to 5 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_POOL_MAX = v;
      assert.equal(getPoolMax(), 5, `POSTGRES_POOL_MAX=${JSON.stringify(v)} should default`);
    }
  });
});

describe("getConnectionTimeoutMs", () => {
  const original = process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    else process.env.POSTGRES_CONNECTION_TIMEOUT_MS = original;
  });

  it("defaults to 10000", () => {
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    assert.equal(getConnectionTimeoutMs(), 10_000);
  });

  it("accepts positive numbers", () => {
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "2500";
    assert.equal(getConnectionTimeoutMs(), 2500);
  });

  // Unlike getMaxRows / getPoolMax (which floor fractional values because row
  // counts and pool sizes must be integers), getConnectionTimeoutMs preserves
  // fractional input -- pg's connectionTimeoutMillis takes a float. Pinning
  // the design difference so a future "consistency" pass doesn't quietly
  // wrap this in Math.floor and shave sub-ms off configured timeouts.
  it("preserves fractional values (timeouts can be sub-ms)", () => {
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "2500.5";
    assert.equal(getConnectionTimeoutMs(), 2500.5);
  });

  it("falls back to 10000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_CONNECTION_TIMEOUT_MS = v;
      assert.equal(
        getConnectionTimeoutMs(),
        10_000,
        `POSTGRES_CONNECTION_TIMEOUT_MS=${JSON.stringify(v)} should default`,
      );
    }
  });
});

describe("getStatementTimeoutMs", () => {
  const original = process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
    else process.env.POSTGRES_STATEMENT_TIMEOUT_MS = original;
  });

  it("defaults to 30000", () => {
    delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
    assert.equal(getStatementTimeoutMs(), 30_000);
  });

  it("accepts positive numbers", () => {
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "5000";
    assert.equal(getStatementTimeoutMs(), 5000);
  });

  it("falls back to 30000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_STATEMENT_TIMEOUT_MS = v;
      assert.equal(
        getStatementTimeoutMs(),
        30_000,
        `POSTGRES_STATEMENT_TIMEOUT_MS=${JSON.stringify(v)} should default`,
      );
    }
  });
});

describe("getSslConfig", () => {
  const original = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    else process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = original;
  });

  it("returns undefined when unset (let pg driver handle URL)", () => {
    delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    assert.equal(getSslConfig(), undefined);
  });

  it("returns rejectUnauthorized=false for 'false'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "false";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: false });
  });

  it("returns rejectUnauthorized=false for '0'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "0";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: false });
  });

  it("returns rejectUnauthorized=true for 'true'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "true";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: true });
  });

  it("returns rejectUnauthorized=true for '1'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "1";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: true });
  });

  it("returns undefined for unrecognized values (defers to pg driver)", () => {
    // Stub console.error so the warning written by the unrecognized-value
    // path doesn't fill the test output. The warning itself is asserted in
    // the dedicated describe below.
    const originalErr = console.error;
    console.error = () => {};
    try {
      for (const v of ["yes", "no", "TRUE", "False", "", "maybe"]) {
        process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = v;
        assert.equal(
          getSslConfig(),
          undefined,
          `POSTGRES_SSL_REJECT_UNAUTHORIZED=${JSON.stringify(v)} should return undefined`,
        );
      }
    } finally {
      console.error = originalErr;
    }
  });
});

describe("getSslConfig stderr warning on unrecognized values", () => {
  const original = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
  const originalErr = console.error;
  let stderrCalls: string[] = [];

  beforeEach(() => {
    stderrCalls = [];
    console.error = (msg?: unknown) => {
      stderrCalls.push(String(msg));
    };
  });
  afterEach(() => {
    console.error = originalErr;
    if (original === undefined) delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    else process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = original;
  });

  it("warns once on an unrecognized value (typo, e.g. 'Flase')", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "Flase";
    getSslConfig();
    assert.equal(stderrCalls.length, 1, `expected one stderr line, got ${JSON.stringify(stderrCalls)}`);
    assert.match(stderrCalls[0]!, /POSTGRES_SSL_REJECT_UNAUTHORIZED/);
    assert.match(stderrCalls[0]!, /not recognized/i);
    // Echoes the offending value so the user can find the typo quickly.
    assert.match(stderrCalls[0]!, /Flase/);
  });

  it("warns on an empty string (assignment without value is still a misconfiguration)", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "";
    getSslConfig();
    assert.equal(stderrCalls.length, 1);
    assert.match(stderrCalls[0]!, /not recognized/i);
  });

  it("does NOT warn for the recognized values 'true', 'false', '0', '1'", () => {
    for (const v of ["true", "false", "0", "1"]) {
      stderrCalls = [];
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = v;
      getSslConfig();
      assert.equal(stderrCalls.length, 0, `unexpected warning for recognized value ${JSON.stringify(v)}`);
    }
  });

  it("does NOT warn when the env var is unset", () => {
    delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    getSslConfig();
    assert.equal(stderrCalls.length, 0);
  });
});

// safeResolveTypeNames is the wrapper around resolveTypeNames whose entire
// reason for existing is: a pg_type lookup failure must not lose the user's
// successful query rows. Engineering that failure against a real DB
// requires a permission-restricted role; a stub client whose .query rejects
// is the cleaner path here, and is the only place we cross the "no mocks"
// boundary in the codebase. The helper is exported from api.ts solely for
// this test.
describe("safeResolveTypeNames fallback on pg_type failure", () => {
  it("returns {} without throwing when the bootstrap pg_type query rejects", async () => {
    // Reset typeNameCache (held inside api.ts as module-scoped state) so
    // the bootstrap branch is forced. Otherwise a prior test in this
    // process may have populated the cache and resolveTypeNames would
    // short-circuit out before reaching the throwing query.
    await shutdown();

    const stubClient = {
      query: () => Promise.reject(new Error("simulated pg_type failure")),
    } as unknown as pg.PoolClient;

    const originalErr = console.error;
    const stderrCalls: string[] = [];
    console.error = (msg?: unknown) => {
      stderrCalls.push(String(msg));
    };
    try {
      // dataTypeID=23 is the int4 oid; the value doesn't matter for this
      // test, only that the field list is non-empty so the wrapper actually
      // attempts a lookup instead of short-circuiting on the empty-input
      // fast path.
      const result = await safeResolveTypeNames(stubClient, [{ dataTypeID: 23 }]);
      assert.deepEqual(result, {}, "wrapper must swallow the error and return an empty map");
      assert.ok(stderrCalls.length > 0, "expected a stderr warning on lookup failure");
      assert.match(stderrCalls[0]!, /type-name resolution failed/i);
      assert.match(stderrCalls[0]!, /simulated pg_type failure/);
    } finally {
      console.error = originalErr;
    }
  });

  it("returns {} (no work, no throw) when called with an empty field list", async () => {
    // No client interaction expected -- helper must short-circuit. Stub
    // throws if anyone touches it, which would surface as a rejection.
    const stubClient = {
      query: () => {
        throw new Error("safeResolveTypeNames should not have called .query on empty input");
      },
    } as unknown as pg.PoolClient;
    const result = await safeResolveTypeNames(stubClient, []);
    assert.deepEqual(result, {});
  });
});
