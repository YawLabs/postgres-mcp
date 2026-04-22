import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
