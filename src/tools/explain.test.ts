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
    assert.match(result.error ?? "", /double-quote|pre-quoting/i);
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
});
