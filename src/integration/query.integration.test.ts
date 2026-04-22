import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { explainTools } from "../tools/explain.js";
import { healthTools } from "../tools/health.js";
import { queryTools } from "../tools/query.js";
import { statsTools } from "../tools/stats.js";
import { FIXTURE_SCHEMA, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const pgQuery = queryTools[0];
const pgExplain = explainTools[0];
const pgHealth = healthTools[0];
const pgTopQueries = statsTools[0];

describe("pg_query (integration, read-only default)", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  it("runs a SELECT and returns rows", async () => {
    const res = (await pgQuery.handler({
      sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users ORDER BY email`,
    })) as { ok: boolean; data?: { rows: { email: string }[]; rowCount: number | null } };
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.data?.rows.map((r) => r.email),
      ["a@example.com", "b@example.com", "c@example.com"],
    );
  });

  it("supports parameterized queries", async () => {
    const res = (await pgQuery.handler({
      sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users WHERE id = $1`,
      params: [1],
    })) as { ok: boolean; data?: { rows: { email: string }[] } };
    assert.equal(res.ok, true);
    assert.equal(res.data?.rows.length, 1);
    assert.equal(res.data?.rows[0].email, "a@example.com");
  });

  it("supports array params via ANY()", async () => {
    const res = (await pgQuery.handler({
      sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users WHERE id = ANY($1) ORDER BY id`,
      params: [[1, 2]],
    })) as { ok: boolean; data?: { rows: { email: string }[] } };
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.data?.rows.map((r) => r.email),
      ["a@example.com", "b@example.com"],
    );
  });

  it("supports object params against jsonb columns", async () => {
    const res = (await pgQuery.handler({
      sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users WHERE metadata @> $1::jsonb`,
      params: [{ role: "admin" }],
    })) as { ok: boolean; data?: { rows: { email: string }[] } };
    assert.equal(res.ok, true);
    assert.equal(res.data?.rows.length, 1);
    assert.equal(res.data?.rows[0].email, "a@example.com");
  });

  it("blocks writes with SQLSTATE 25006 and surfaces the ALLOW_WRITES hint", async () => {
    const res = (await pgQuery.handler({
      sql: `INSERT INTO ${FIXTURE_SCHEMA}.users (email) VALUES ('blocked@example.com')`,
    })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /read-only|ALLOW_WRITES/i);
  });

  it("truncates result sets above POSTGRES_MAX_ROWS with a flag", async () => {
    const original = process.env.POSTGRES_MAX_ROWS;
    process.env.POSTGRES_MAX_ROWS = "2";
    try {
      const res = (await pgQuery.handler({
        sql: `SELECT id FROM ${FIXTURE_SCHEMA}.users ORDER BY id`,
      })) as { ok: boolean; data?: { rows: unknown[]; truncated?: boolean } };
      assert.equal(res.ok, true);
      assert.equal(res.data?.rows.length, 2);
      assert.equal(res.data?.truncated, true);
    } finally {
      if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
      else process.env.POSTGRES_MAX_ROWS = original;
    }
  });

  it("surfaces real postgres error codes (42601 syntax error)", async () => {
    const res = (await pgQuery.handler({ sql: "SELEC 1" })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /syntax|42601/i);
  });
});

describe("pg_explain (integration)", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  it("returns a text plan by default", async () => {
    const res = (await pgExplain.handler({
      sql: `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE user_id = $1`,
      analyze: false,
      format: "text",
      params: [1],
    })) as { ok: boolean; data?: { plan: string } };
    assert.equal(res.ok, true);
    assert.match(res.data?.plan ?? "", /Scan/i);
  });

  it("returns a JSON plan when format=json", async () => {
    const res = (await pgExplain.handler({
      sql: `SELECT 1`,
      analyze: false,
      format: "json",
    })) as { ok: boolean; data?: { plan: unknown } };
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.data?.plan));
  });

  it("rejects pre-wrapped EXPLAIN SQL with a clear error (bug fix regression test)", async () => {
    const res = (await pgExplain.handler({
      sql: "EXPLAIN SELECT 1",
      analyze: false,
      format: "text",
    })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /EXPLAIN/);
  });
});

describe("pg_health (integration)", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  it("returns connected=true with a version string and database info", async () => {
    const res = (await pgHealth.handler({ activeQueryLimit: 10 })) as {
      ok: boolean;
      data?: {
        connected: boolean;
        version: string;
        database: { database: string; size_pretty: string };
        connections: { total: string };
        active_queries: unknown[];
        table_count: string;
      };
    };
    assert.equal(res.ok, true);
    assert.equal(res.data?.connected, true);
    assert.match(res.data?.version ?? "", /PostgreSQL/);
    assert.ok(res.data?.database.database);
    assert.ok(Array.isArray(res.data?.active_queries));
  });

  it("respects activeQueryLimit", async () => {
    const res = (await pgHealth.handler({ activeQueryLimit: 1 })) as {
      ok: boolean;
      data?: { active_queries: unknown[] };
    };
    assert.equal(res.ok, true);
    // May be 0 if no concurrent activity; must be <= 1.
    assert.ok((res.data?.active_queries ?? []).length <= 1);
  });
});

describe("pg_top_queries (integration)", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  it("returns rows from pg_stat_statements when installed", async () => {
    // The CI environment preloads pg_stat_statements; locally this may be absent,
    // in which case we accept the "not installed" error as valid behavior too.
    const res = (await pgTopQueries.handler({ orderBy: "total_time", limit: 5 })) as {
      ok: boolean;
      data?: { query: string; calls: string }[];
      error?: string;
    };
    if (!res.ok) {
      assert.match(res.error ?? "", /pg_stat_statements/);
      return;
    }
    assert.ok(Array.isArray(res.data));
    // The fixture setup ran a handful of queries — there should be at least one row.
    assert.ok((res.data ?? []).length > 0);
    assert.ok(res.data?.[0].query);
  });

  it("supports all three orderBy values without error", async () => {
    for (const orderBy of ["total_time", "mean_time", "calls"] as const) {
      const res = (await pgTopQueries.handler({ orderBy, limit: 3 })) as {
        ok: boolean;
        error?: string;
      };
      // Either installed-and-ok, or extension missing — both acceptable.
      if (!res.ok) {
        assert.match(res.error ?? "", /pg_stat_statements/);
      }
    }
  });
});
