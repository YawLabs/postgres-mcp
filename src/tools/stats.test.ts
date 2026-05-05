import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareVersions } from "./stats.js";

describe("compareVersions", () => {
  it("equal versions return 0", () => {
    assert.equal(compareVersions("1.8", "1.8"), 0);
    assert.equal(compareVersions("1.8.0", "1.8.0"), 0);
  });

  it("missing trailing segments compare as 0 (1.8 == 1.8.0)", () => {
    assert.equal(compareVersions("1.8", "1.8.0"), 0);
    assert.equal(compareVersions("1.8.0", "1.8"), 0);
  });

  it("a < b returns negative", () => {
    assert.ok(compareVersions("1.7", "1.8") < 0);
    assert.ok(compareVersions("1.8", "1.10") < 0, "numeric, not lexical: 1.8 < 1.10");
    assert.ok(compareVersions("1.7.99", "1.8") < 0, "patch-level vs minor bump");
    assert.ok(compareVersions("1.8", "1.8.1") < 0, "extra patch beats no patch");
  });

  it("a > b returns positive", () => {
    assert.ok(compareVersions("1.8", "1.7") > 0);
    assert.ok(compareVersions("1.10", "1.8") > 0);
    assert.ok(compareVersions("2.0", "1.99") > 0);
  });

  it("trailing pre-release tag (1.10-beta) parses leading digits per segment", () => {
    // 1.10-beta should be treated like 1.10 for the column-rename detection.
    assert.equal(compareVersions("1.10-beta", "1.10"), 0);
    assert.ok(compareVersions("1.10-beta", "1.8") > 0);
    assert.ok(compareVersions("1.10-beta", "1.11") < 0);
  });

  it("trailing alphanumeric tag (1.8rc1) parses to 1.8", () => {
    assert.equal(compareVersions("1.8rc1", "1.8"), 0);
    assert.ok(compareVersions("1.8rc1", "1.7") > 0);
  });

  it("non-numeric segment falls back to 0 rather than NaN", () => {
    // Defensive: an extversion of `dev` or `unknown` shouldn't crash the
    // comparator; treat as 0 so we err on the "old" side and use the
    // pre-1.8 column names.
    assert.ok(compareVersions("dev", "1.8") < 0);
    assert.equal(compareVersions("dev", "0"), 0);
  });

  it("the 1.8 boundary used by pg_top_queries works correctly", () => {
    // This is the actual production check in stats.ts.
    assert.ok(compareVersions("1.7", "1.8") < 0, "1.7 uses pre-rename columns");
    assert.ok(compareVersions("1.8", "1.8") >= 0, "1.8 uses _exec_ columns");
    assert.ok(compareVersions("1.9", "1.8") >= 0, "1.9 uses _exec_ columns");
    assert.ok(compareVersions("1.10", "1.8") >= 0, "1.10 uses _exec_ columns (numeric, not lexical)");
  });
});
