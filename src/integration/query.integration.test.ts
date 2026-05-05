import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runInternal } from "../api.js";
import { explainTools } from "../tools/explain.js";
import { healthTools } from "../tools/health.js";
import { queryTools } from "../tools/query.js";
import { statsTools } from "../tools/stats.js";
import { FIXTURE_SCHEMA, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const pgQuery = queryTools[0];
const pgExplain = explainTools[0];
const pgHealth = healthTools[0];
const pgTopQueries = statsTools[0];

// One setup/teardown for the whole file — every describe below shares the
// same fixture schema, so running DROP/CREATE per-describe is wasted work.
describe("integration: query / explain / health / top_queries", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  describe("pg_query (read-only default)", () => {
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

    it("attaches dataTypeName alongside dataTypeID for each field", async () => {
      const res = (await pgQuery.handler({
        sql: `SELECT id, email, metadata FROM ${FIXTURE_SCHEMA}.users LIMIT 1`,
      })) as {
        ok: boolean;
        data?: { fields: { name: string; dataTypeID: number; dataTypeName?: string }[] };
      };
      assert.equal(res.ok, true);
      const fields = res.data?.fields ?? [];
      const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
      assert.equal(byName.id?.dataTypeName, "int4");
      assert.equal(byName.email?.dataTypeName, "text");
      assert.equal(byName.metadata?.dataTypeName, "jsonb");
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

    it("non-cursorable DDL falls back to direct exec from the DECLARE-failure path", async () => {
      // DECLARE rejects DDL (feature_not_supported, 0A000) and DML-without-
      // RETURNING (parse error, 42601). The runUserQueryBounded catch must
      // distinguish these "DECLARE failed" cases (safe to re-run) from a
      // FETCH-time failure (re-running could double-execute side effects).
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const create = (await pgQuery.handler({
          sql: `CREATE TABLE ${FIXTURE_SCHEMA}.cursor_fallback_canary (id INT)`,
        })) as { ok: boolean; error?: string };
        assert.equal(create.ok, true, `expected DDL to succeed via fallback, got error: ${create.error}`);
        // Tidy up so re-runs of the matrix stay green.
        await pgQuery.handler({ sql: `DROP TABLE ${FIXTURE_SCHEMA}.cursor_fallback_canary` });

        // DML without RETURNING -- DECLARE fails with 42601, fallback runs
        // the INSERT directly. Two-row count survives the round-trip.
        const insert = (await pgQuery.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.posts (user_id, title) VALUES (1, 'fallback-canary')`,
        })) as { ok: boolean; data?: { rowCount: number | null } };
        assert.equal(insert.ok, true);
        assert.equal(insert.data?.rowCount, 1);
        await pgQuery.handler({
          sql: `DELETE FROM ${FIXTURE_SCHEMA}.posts WHERE title = 'fallback-canary'`,
        });
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });

    it("a bad reference in user SQL surfaces postgres's error message", async () => {
      // A reference to a non-existent table fails DECLARE with SQLSTATE 42P01.
      // The fallback re-runs the SELECT directly, which surfaces the same
      // 42P01 -- safe because DECLARE never executed the user SQL.
      const res = (await pgQuery.handler({
        sql: `SELECT * FROM ${FIXTURE_SCHEMA}.does_not_exist_at_all`,
      })) as { ok: boolean; error?: string };
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /does_not_exist_at_all|42P01|relation/i);
    });

    it("rejects $1 reference when no params array is passed", async () => {
      const res = (await pgQuery.handler({
        sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users WHERE id = $1`,
      })) as { ok: boolean; error?: string };
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /\$1|parameter/i);
    });

    it("bounds fetch via cursor: a SELECT generating 1M rows returns only MAX_ROWS+truncated quickly", async () => {
      // Without the cursor wrap, generate_series(1, 1_000_000) materializes
      // a million rows in node-pg before the slice. With the wrap, postgres
      // FETCHes only MAX_ROWS+1 rows. We can't easily measure peak memory in
      // a test, but a 1M-row generate_series running in <1s is the canary --
      // a non-bounded fetch on a developer laptop tops 5s and several
      // hundred MB resident.
      const original = process.env.POSTGRES_MAX_ROWS;
      process.env.POSTGRES_MAX_ROWS = "10";
      const start = Date.now();
      try {
        const res = (await pgQuery.handler({
          sql: "SELECT generate_series(1, 1000000) AS i",
        })) as { ok: boolean; data?: { rows: { i: number }[]; truncated?: boolean } };
        const elapsedMs = Date.now() - start;
        assert.equal(res.ok, true);
        assert.equal(res.data?.rows.length, 10);
        assert.equal(res.data?.truncated, true);
        assert.ok(elapsedMs < 2000, `expected <2s with bounded fetch, took ${elapsedMs}ms`);
      } finally {
        if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
        else process.env.POSTGRES_MAX_ROWS = original;
      }
    });

    it("does not flag truncated when result count equals POSTGRES_MAX_ROWS", async () => {
      const original = process.env.POSTGRES_MAX_ROWS;
      // Fixture has exactly 3 users -- request a max of 3 to hit the boundary.
      process.env.POSTGRES_MAX_ROWS = "3";
      try {
        const res = (await pgQuery.handler({
          sql: `SELECT id FROM ${FIXTURE_SCHEMA}.users ORDER BY id`,
        })) as { ok: boolean; data?: { rows: unknown[]; truncated?: boolean } };
        assert.equal(res.ok, true);
        assert.equal(res.data?.rows.length, 3);
        assert.notStrictEqual(res.data?.truncated, true, "truncated must be falsy at the boundary, not true");
      } finally {
        if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
        else process.env.POSTGRES_MAX_ROWS = original;
      }
    });

    // Regression test for the stacked-query SQL injection reported by Datadog
    // Security Labs against @modelcontextprotocol/server-postgres v0.6.2:
    // https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/
    // The attack ends the READ ONLY transaction early with `COMMIT;` then runs
    // a destructive statement. Our defense is that pg_query always calls
    // client.query(sql, params) with a values array, which forces the extended
    // query protocol — and the extended protocol rejects multi-statement SQL.
    it("rejects stacked-query injection that defeated the reference server", async () => {
      const payload = `SELECT 1; COMMIT; DROP SCHEMA ${FIXTURE_SCHEMA} CASCADE;`;
      const res = (await pgQuery.handler({ sql: payload })) as { ok: boolean; error?: string };

      assert.equal(res.ok, false, "stacked-query payload must be rejected");
      assert.match(
        res.error ?? "",
        /cannot insert multiple commands|multiple commands|42601/i,
        "expected extended-protocol multi-statement rejection",
      );

      // Belt-and-suspenders: even if the rejection message ever changes, the
      // schema must still exist — no DROP landed.
      const check = (await pgQuery.handler({
        sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.users`,
      })) as { ok: boolean; data?: { rows: { c: number }[] } };
      assert.equal(check.ok, true, "fixture schema must survive the injection attempt");
      assert.ok((check.data?.rows[0]?.c ?? 0) > 0);
    });

    // Same defense, verified with ALLOW_WRITES=1 on — the extended-protocol
    // guard is upstream of the READ ONLY wrapper, so it must still block even
    // when the READ ONLY guard is lifted.
    it("rejects stacked-query injection even when ALLOW_WRITES=1", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const payload = `SELECT 1; DROP SCHEMA ${FIXTURE_SCHEMA} CASCADE;`;
        const res = (await pgQuery.handler({ sql: payload })) as { ok: boolean; error?: string };
        assert.equal(res.ok, false);
        assert.match(res.error ?? "", /cannot insert multiple commands|multiple commands|42601/i);

        const check = (await pgQuery.handler({
          sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.users`,
        })) as { ok: boolean; data?: { rows: { c: number }[] } };
        assert.equal(check.ok, true);
        assert.ok((check.data?.rows[0]?.c ?? 0) > 0);
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });
  });

  describe("pg_explain", () => {
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

    it("hypothetical_indexes returns a friendly error when HypoPG is not installed", async () => {
      const check = (await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg') AS installed`,
      )) as { ok: boolean; data?: { installed: boolean }[] };
      const installed = check.ok && check.data?.[0]?.installed === true;
      if (installed) return; // positive-path test below covers this case

      const res = (await pgExplain.handler({
        sql: `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE user_id = 1`,
        analyze: false,
        format: "text",
        hypothetical_indexes: [{ table: `${FIXTURE_SCHEMA}.posts`, columns: ["title"], using: "btree" }],
      })) as { ok: boolean; error?: string };
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /HypoPG|CREATE EXTENSION hypopg/i);
    });

    it("hypothetical_indexes flips a seq scan to an index scan when HypoPG is installed", async () => {
      const check = (await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg') AS installed`,
      )) as { ok: boolean; data?: { installed: boolean }[] };
      const installed = check.ok && check.data?.[0]?.installed === true;
      if (!installed) return; // negative-path test above covers this case

      // Baseline: explain without a hypothetical index over `body` (no real
      // index exists for this column in the fixture).
      const baseline = (await pgExplain.handler({
        sql: `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE body = 'world'`,
        analyze: false,
        format: "text",
      })) as { ok: boolean; data?: { plan: string } };
      assert.equal(baseline.ok, true);
      assert.match(baseline.data?.plan ?? "", /Seq Scan/i, "expected a Seq Scan with no real index on body");

      // With a hypothetical index on `body`, the planner should prefer it.
      // HypoPG-suggested scans show up as "Index Scan using <index_btree_...>".
      const withHypo = (await pgExplain.handler({
        sql: `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE body = 'world'`,
        analyze: false,
        format: "text",
        hypothetical_indexes: [{ table: `${FIXTURE_SCHEMA}.posts`, columns: ["body"], using: "btree" }],
      })) as { ok: boolean; data?: { plan: string } };
      assert.equal(withHypo.ok, true);
      assert.match(withHypo.data?.plan ?? "", /Index|Bitmap/i, "expected an index/bitmap scan with hypothetical index");
    });

    it("EXPLAIN ANALYZE on a SELECT works in read-only mode (no ALLOW_WRITES)", async () => {
      const original = process.env.ALLOW_WRITES;
      delete process.env.ALLOW_WRITES;
      try {
        const res = (await pgExplain.handler({
          sql: `SELECT count(*) FROM ${FIXTURE_SCHEMA}.users`,
          analyze: true,
          format: "text",
        })) as { ok: boolean; data?: { plan: string }; error?: string };
        assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
        assert.match(res.data?.plan ?? "", /actual time=/i, "expected ANALYZE timing in plan");
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });

    it("EXPLAIN ANALYZE on an INSERT errors with the read-only hint when ALLOW_WRITES is off", async () => {
      const original = process.env.ALLOW_WRITES;
      delete process.env.ALLOW_WRITES;
      try {
        const res = (await pgExplain.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.users (email) VALUES ('blocked-explain@example.com')`,
          analyze: true,
          format: "text",
        })) as { ok: boolean; error?: string };
        assert.equal(res.ok, false, "EXPLAIN ANALYZE INSERT must fail without ALLOW_WRITES");
        assert.match(res.error ?? "", /read-only|ALLOW_WRITES/i);
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });

    it("EXPLAIN ANALYZE of a write statement does not persist (regression: rollback, not commit)", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const before = (await pgQuery.handler({
          sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.users`,
        })) as { ok: boolean; data?: { rows: { c: number }[] } };
        assert.equal(before.ok, true);
        const beforeCount = before.data?.rows[0]?.c;

        const res = (await pgExplain.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.users (email) VALUES ('analyze-should-rollback@example.com')`,
          analyze: true,
          format: "text",
        })) as { ok: boolean; data?: { plan: string }; error?: string };
        assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
        assert.match(res.data?.plan ?? "", /Insert/i);

        const after = (await pgQuery.handler({
          sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.users`,
        })) as { ok: boolean; data?: { rows: { c: number }[] } };
        assert.equal(after.ok, true);
        assert.equal(after.data?.rows[0]?.c, beforeCount, "EXPLAIN ANALYZE of INSERT must not persist the write");
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });
  });

  describe("pg_health", () => {
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

  describe("pg_top_queries", () => {
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
});
