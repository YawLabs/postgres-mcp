import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getConnectionTimeoutMs, getMaxRows, getPoolMax, getSslConfig, isWritesAllowed } from "./api.js";

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
