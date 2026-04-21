import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getMaxRows, isWritesAllowed } from "./api.js";

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
