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
    // The embedded `.` inside the quoted segment splits this into 3 pieces, so
    // the over-qualified guard fires first; the double-quote guard would catch
    // it otherwise. Either rejection is correct -- accept both forms.
    assert.match(result.error ?? "", /double-quote|pre-quoting|over-qualified/i);
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
});
