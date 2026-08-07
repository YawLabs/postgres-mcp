// SERIALIZATION: these integration files MUST run serialized in one process
// (--test-concurrency=1 via scripts/run-tests.mjs). The pg pool, typeNameCache,
// and process.env are process-global singletons; running these files (or their
// tests) concurrently would let one test's pool swap / env mutation / cache
// reset race another's in-flight query. Do not parallelize without first
// removing those shared singletons.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runInternal, shutdown } from "../api.js";
import { explainTools } from "../tools/explain.js";
import { healthTools } from "../tools/health.js";
import { queryTools } from "../tools/query.js";
import { statsTools } from "../tools/stats.js";
import {
  dropOtherDatabase,
  FIXTURE_OTHER_DB,
  FIXTURE_OTHER_DB_MARKER,
  FIXTURE_SCHEMA,
  integrationEnabled,
  runMarkerQueryInOtherDatabase,
  setupFixtures,
  teardownFixtures,
} from "./fixtures.js";

const pgReadonly = queryTools.find((t) => t.name === "pg_readonly");
const pgQuery = queryTools.find((t) => t.name === "pg_query");
if (!pgReadonly || !pgQuery) throw new Error("pg_readonly and pg_query must be defined");
const pgExplain = explainTools[0];
const pgHealth = healthTools[0];
const pgTopQueries = statsTools[0];

// One setup/teardown for the whole file - every describe below shares the
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

    // typeNameCache miss-fill regression. The cache is process-global and
    // populated on the first user query via a bootstrap of pg_type. A type
    // CREATEd AFTER the bootstrap won't be in the cache, so the next query
    // that returns a column of that type must trigger the miss-fill path
    // (WHERE oid = ANY($1) -> add to cache -> render dataTypeName).
    //
    // We reset the cache explicitly via shutdown() so the path runs the
    // same way regardless of where this test lands in the file order.
    it("resolves dataTypeName for a CREATE TYPE issued mid-session (miss-fill path)", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        // Clear the cache + pool so the bootstrap re-runs and captures only
        // the types existing at this moment.
        await shutdown();

        // Bootstrap the cache with the existing types via any user query.
        const warmup = (await pgQuery.handler({
          sql: `SELECT id FROM ${FIXTURE_SCHEMA}.users ORDER BY id LIMIT 1`,
        })) as { ok: boolean };
        assert.equal(warmup.ok, true, "cache-bootstrap query should succeed");

        // CREATE TYPE introduces a new oid that the bootstrap above could
        // not have seen. Use a name unique to this test so reruns stay
        // green.
        const createType = (await pgQuery.handler({
          sql: `CREATE TYPE ${FIXTURE_SCHEMA}.color_kind AS ENUM ('red', 'green', 'blue')`,
        })) as { ok: boolean; error?: string };
        assert.equal(createType.ok, true, `CREATE TYPE failed: ${createType.error}`);

        try {
          // SELECT a value of the new type. The miss-fill branch in
          // resolveTypeNames must populate dataTypeName="color_kind".
          const res = (await pgQuery.handler({
            sql: `SELECT 'red'::${FIXTURE_SCHEMA}.color_kind AS tag`,
          })) as {
            ok: boolean;
            data?: {
              fields: { name: string; dataTypeID: number; dataTypeName?: string }[];
              rows: Record<string, unknown>[];
            };
            error?: string;
          };
          assert.equal(res.ok, true, `SELECT custom enum failed: ${res.error}`);
          assert.equal(res.data?.rows[0]?.tag, "red");
          const tagField = res.data?.fields.find((f) => f.name === "tag");
          assert.ok(tagField, "expected `tag` field in response");
          assert.equal(
            tagField.dataTypeName,
            "color_kind",
            `miss-fill must resolve newly-created enum oid; got ${JSON.stringify(tagField)}`,
          );
        } finally {
          await pgQuery.handler({ sql: `DROP TYPE ${FIXTURE_SCHEMA}.color_kind` });
        }
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
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

    // The OTHER half of the runUserQueryBounded catch. The DDL test above
    // covers "DECLARE failed, user SQL never ran, safe to re-exec". This
    // covers "DECLARE succeeded, FETCH failed" -- where the user SQL HAS
    // already executed and re-running it would double-execute side effects.
    //
    // Engineered with statement_timeout: DECLARE only plans, so it returns
    // instantly; the FETCH is what executes pg_sleep and trips the timeout.
    // The detector is a sequence -- nextval is non-transactional, so its
    // value survives the rollback and counts how many times the statement
    // actually ran. A regression that fell through to the direct-exec path
    // would advance it twice.
    it("a FETCH-time failure does not re-execute the statement", async () => {
      const originalWrites = process.env.ALLOW_WRITES;
      const originalTimeout = process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
      process.env.ALLOW_WRITES = "1";
      try {
        const mk = await runInternal(`CREATE SEQUENCE ${FIXTURE_SCHEMA}.fetch_probe_seq`);
        assert.equal(mk.ok, true, `sequence setup failed: ${mk.error}`);

        // Rebuild the pool with a short statement_timeout (it is snapshotted
        // at pool construction, so shutdown() first).
        process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "500";
        await shutdown();

        const before = (await runInternal<{ v: string }>(
          `SELECT last_value::text AS v FROM ${FIXTURE_SCHEMA}.fetch_probe_seq`,
        )) as { ok: boolean; data?: { v: string }[] };
        const beforeVal = Number(before.data?.[0]?.v ?? "0");

        // Cursorable (a plain SELECT), so DECLARE succeeds and FETCH executes.
        const res = (await pgQuery.handler({
          sql: `SELECT nextval('${FIXTURE_SCHEMA}.fetch_probe_seq') AS n, pg_sleep(5) AS s`,
        })) as { ok: boolean; error?: string };
        assert.equal(res.ok, false, "expected the FETCH to trip statement_timeout");
        assert.match(res.error ?? "", /timeout|canceling statement/i);

        // Rebuild again so the read below isn't itself capped at 500ms.
        if (originalTimeout === undefined) delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
        else process.env.POSTGRES_STATEMENT_TIMEOUT_MS = originalTimeout;
        await shutdown();

        const after = (await runInternal<{ v: string }>(
          `SELECT last_value::text AS v FROM ${FIXTURE_SCHEMA}.fetch_probe_seq`,
        )) as { ok: boolean; data?: { v: string }[] };
        const delta = Number(after.data?.[0]?.v ?? "0") - beforeVal;

        // <= 1 rather than === 1: whether nextval evaluates before pg_sleep in
        // the target list is not guaranteed, so 0 is a legal outcome. The
        // property under test is that it never runs TWICE.
        assert.ok(
          delta <= 1,
          `statement executed more than once after a FETCH-time failure (sequence advanced by ${delta})`,
        );

        await runInternal(`DROP SEQUENCE IF EXISTS ${FIXTURE_SCHEMA}.fetch_probe_seq`);
      } finally {
        if (originalWrites === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = originalWrites;
        if (originalTimeout === undefined) delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
        else process.env.POSTGRES_STATEMENT_TIMEOUT_MS = originalTimeout;
        await shutdown();
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

    // Not tool-level arity validation: the handler defaults params to [] when
    // omitted (query.ts:62, `runReadOnly(sql, params ?? [])`), so postgres
    // receives a $1 placeholder with an empty values array and raises the
    // bind-time error itself. This pins that postgres's error is surfaced
    // verbatim rather than being swallowed or rewritten by the handler.
    it("surfaces postgres bind error when $1 has no matching parameter", async () => {
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
        // Correctness proof: rows.length===10 (MAX_ROWS) + truncated===true is
        // what proves the cursor bounded the FETCH -- a non-bounded fetch would
        // materialize all 1M rows in node-pg before the slice. The timing below
        // is NOT a correctness check; it's only a loose memory-bound canary
        // (an unbounded fetch of 1M rows is slow AND heap-heavy). Kept generous
        // (10s) so a slow / loaded CI host doesn't flake -- the row-count and
        // truncated assertions above already carry the real signal.
        assert.equal(res.data?.rows.length, 10);
        assert.equal(res.data?.truncated, true);
        assert.ok(
          elapsedMs < 10000,
          `expected bounded fetch to stay well under a full-materialization wall time, took ${elapsedMs}ms`,
        );
      } finally {
        if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
        else process.env.POSTGRES_MAX_ROWS = original;
      }
    });

    // rowCount must never disagree with rows.length. The cursor path FETCHes
    // MAX_ROWS + 1 to detect truncation, and the driver's rowCount reflects
    // that extra probe row -- returning it verbatim reported 3 alongside 2
    // rows, so a caller paginating on rowCount would loop past the end.
    it("reports rowCount matching rows.length when truncated", async () => {
      const original = process.env.POSTGRES_MAX_ROWS;
      process.env.POSTGRES_MAX_ROWS = "2";
      try {
        const res = (await pgQuery.handler({
          sql: `SELECT id FROM ${FIXTURE_SCHEMA}.users ORDER BY id`,
        })) as { ok: boolean; data?: { rows: unknown[]; rowCount: number | null; truncated?: boolean } };
        assert.equal(res.ok, true);
        assert.equal(res.data?.truncated, true, "sanity: 3 fixture users vs MAX_ROWS=2 must truncate");
        assert.equal(res.data?.rows.length, 2);
        assert.equal(
          res.data?.rowCount,
          2,
          `rowCount must equal the number of rows actually returned, got ${res.data?.rowCount}`,
        );
      } finally {
        if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
        else process.env.POSTGRES_MAX_ROWS = original;
      }
    });

    // The counterpart to the test above, and the reason the rowCount rewrite
    // is gated on the cursor path. `INSERT ... RETURNING` is NOT cursorable
    // (DECLARE rejects it with 42601), so it runs on the direct-exec path
    // where rowCount is the AFFECTED-row count -- independent of how many rows
    // came back. Collapsing it to rows.length told the caller 3 rows were
    // written when 10 were committed.
    it("keeps the affected-row count on a truncated INSERT ... RETURNING", async () => {
      const originalWrites = process.env.ALLOW_WRITES;
      const originalMax = process.env.POSTGRES_MAX_ROWS;
      process.env.ALLOW_WRITES = "1";
      process.env.POSTGRES_MAX_ROWS = "3";
      try {
        const create = (await pgQuery.handler({
          sql: `CREATE TABLE ${FIXTURE_SCHEMA}.rowcount_canary (id INT)`,
        })) as { ok: boolean; error?: string };
        assert.equal(create.ok, true, `expected DDL to succeed: ${create.error}`);

        const res = (await pgQuery.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.rowcount_canary SELECT generate_series(1, 10) RETURNING id`,
        })) as { ok: boolean; data?: { rows: unknown[]; rowCount: number | null; truncated?: boolean } };
        assert.equal(res.ok, true);
        assert.equal(res.data?.truncated, true, "sanity: 10 returned rows vs MAX_ROWS=3 must truncate");
        assert.equal(res.data?.rows.length, 3, "returned rows are still capped at MAX_ROWS");
        assert.equal(
          res.data?.rowCount,
          10,
          `rowCount must stay the affected-row count on the direct-exec path, got ${res.data?.rowCount}`,
        );

        // And the write really did land in full -- rowCount is not optimistic.
        const committed = (await pgQuery.handler({
          sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.rowcount_canary`,
        })) as { ok: boolean; data?: { rows: { c: number }[] } };
        assert.equal(committed.data?.rows[0]?.c, 10);

        await pgQuery.handler({ sql: `DROP TABLE ${FIXTURE_SCHEMA}.rowcount_canary` });
      } finally {
        if (originalWrites === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = originalWrites;
        if (originalMax === undefined) delete process.env.POSTGRES_MAX_ROWS;
        else process.env.POSTGRES_MAX_ROWS = originalMax;
      }
    });

    // `command` is the postgres command tag. On the cursor path it describes
    // the FETCH, not the user's statement, so every SELECT came back as
    // command="FETCH". There is no way to recover the inner tag through a
    // cursor, so the field is omitted rather than reported wrong -- but it is
    // still present (and correct) on the direct-exec fallback path.
    it("omits `command` on the cursor path rather than reporting FETCH", async () => {
      const res = (await pgQuery.handler({
        sql: `SELECT id FROM ${FIXTURE_SCHEMA}.users ORDER BY id`,
      })) as { ok: boolean; data?: { command?: string; rows: unknown[] } };
      assert.equal(res.ok, true);
      assert.notEqual(res.data?.command, "FETCH", "the FETCH tag must never be surfaced as the user's command");
      assert.equal(res.data?.command, undefined, "cursor path must omit `command` entirely");
    });

    it("still reports the real command tag on the direct-exec fallback path", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        // DDL is non-cursorable: DECLARE fails, the fallback runs it directly,
        // and there the driver's tag describes the user's statement.
        // node-pg reports only the FIRST word of the postgres command tag
        // ("CREATE TABLE" -> "CREATE", "INSERT 0 1" -> "INSERT"), so assert the
        // driver's actual shape rather than the raw tag.
        const create = (await pgQuery.handler({
          sql: `CREATE TABLE ${FIXTURE_SCHEMA}.command_tag_canary (id INT)`,
        })) as { ok: boolean; data?: { command?: string }; error?: string };
        assert.equal(create.ok, true, `expected DDL to succeed: ${create.error}`);
        assert.equal(create.data?.command, "CREATE");

        const insert = (await pgQuery.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.command_tag_canary (id) VALUES (1)`,
        })) as { ok: boolean; data?: { command?: string; rowCount: number | null } };
        assert.equal(insert.ok, true);
        assert.equal(insert.data?.command, "INSERT");
        assert.equal(insert.data?.rowCount, 1, "affected-row count must survive on the direct-exec path");

        await pgQuery.handler({ sql: `DROP TABLE ${FIXTURE_SCHEMA}.command_tag_canary` });
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
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
    // query protocol - and the extended protocol rejects multi-statement SQL.
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
      // schema must still exist - no DROP landed.
      const check = (await pgQuery.handler({
        sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.users`,
      })) as { ok: boolean; data?: { rows: { c: number }[] } };
      assert.equal(check.ok, true, "fixture schema must survive the injection attempt");
      assert.ok((check.data?.rows[0]?.c ?? 0) > 0);
    });

    // Same defense, verified with ALLOW_WRITES=1 on - the extended-protocol
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

  describe("pg_readonly (unconditional read-only)", () => {
    it("runs a SELECT and returns rows", async () => {
      const res = (await pgReadonly.handler({
        sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users ORDER BY email`,
      })) as { ok: boolean; data?: { rows: { email: string }[] } };
      assert.equal(res.ok, true);
      assert.deepEqual(
        res.data?.rows.map((r) => r.email),
        ["a@example.com", "b@example.com", "c@example.com"],
      );
    });

    it("supports parameterized queries", async () => {
      const res = (await pgReadonly.handler({
        sql: `SELECT email FROM ${FIXTURE_SCHEMA}.users WHERE id = $1`,
        params: [1],
      })) as { ok: boolean; data?: { rows: { email: string }[] } };
      assert.equal(res.ok, true);
      assert.equal(res.data?.rows.length, 1);
      assert.equal(res.data?.rows[0].email, "a@example.com");
    });

    // The load-bearing assertion: pg_readonly stays read-only regardless of
    // ALLOW_WRITES. This is the whole reason the tool exists -- hosts can
    // auto-allow it knowing no server-side env knob can turn it destructive.
    it("blocks writes even when ALLOW_WRITES=1 is set", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const res = (await pgReadonly.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.users (email) VALUES ('readonly-bypass@example.com')`,
        })) as { ok: boolean; error?: string };
        assert.equal(res.ok, false, "pg_readonly must reject writes regardless of ALLOW_WRITES");
        assert.match(res.error ?? "", /read-only|25006/i);
      } finally {
        if (original === undefined) delete process.env.ALLOW_WRITES;
        else process.env.ALLOW_WRITES = original;
      }
    });

    it("rejects stacked-query injection even with ALLOW_WRITES=1", async () => {
      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const payload = `SELECT 1; DROP SCHEMA ${FIXTURE_SCHEMA} CASCADE;`;
        const res = (await pgReadonly.handler({ sql: payload })) as { ok: boolean; error?: string };
        assert.equal(res.ok, false);
        assert.match(res.error ?? "", /cannot insert multiple commands|multiple commands|42601/i);

        const check = (await pgReadonly.handler({
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

    it("hypothetical_indexes defaults using=btree when the field is omitted", async () => {
      // Regression test: a unit-test-style direct handler call bypasses the
      // MCP framework's Zod parse, so `using` arrives as undefined. The
      // defensive default in buildHypopgHooks must turn that back into "btree"
      // -- otherwise the generated SQL is `USING undefined` and hypopg returns
      // a confusing syntax error.
      const check = (await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg') AS installed`,
      )) as { ok: boolean; data?: { installed: boolean }[] };
      const installed = check.ok && check.data?.[0]?.installed === true;
      if (!installed) return; // negative-path test already covers the absent case

      const res = (await pgExplain.handler({
        sql: `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE body = 'world'`,
        analyze: false,
        format: "text",
        hypothetical_indexes: [{ table: `${FIXTURE_SCHEMA}.posts`, columns: ["body"] }],
      })) as { ok: boolean; data?: { plan: string }; error?: string };
      assert.equal(res.ok, true, `expected ok with omitted using, got error: ${res.error}`);
      assert.match(res.data?.plan ?? "", /Index|Bitmap/i);
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

    // buildHypopgHooks uses a for-loop over the indexes array, so N>1 works,
    // but every other hypothetical_indexes test passes exactly one entry. A
    // regression that swaps the loop for `indexes[0]` would silently ignore
    // every entry past the first.
    it("supports multiple hypothetical_indexes in a single call", async () => {
      const check = (await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg') AS installed`,
      )) as { ok: boolean; data?: { installed: boolean }[] };
      const installed = check.ok && check.data?.[0]?.installed === true;
      if (!installed) return;

      const res = (await pgExplain.handler({
        sql: `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE body = 'world' AND title = 'hello'`,
        analyze: false,
        format: "text",
        hypothetical_indexes: [
          { table: `${FIXTURE_SCHEMA}.posts`, columns: ["body"], using: "btree" },
          { table: `${FIXTURE_SCHEMA}.posts`, columns: ["title"], using: "btree" },
        ],
      })) as { ok: boolean; data?: { plan: string }; error?: string };
      assert.equal(res.ok, true, `expected ok with two hypothetical indexes, got error: ${res.error}`);
      // At least one of the hypotheticals must show up in the plan; on a
      // multi-column predicate the planner picks the more selective one.
      assert.match(
        res.data?.plan ?? "",
        /Index|Bitmap/i,
        "expected an Index/Bitmap scan from at least one hypothetical index",
      );
    });

    // analyze=true + ALLOW_WRITES=1 + hypothetical_indexes routes through
    // runReadWriteRollback instead of runReadOnly. The hooks (setup +
    // teardown) must still install + reset the HypoPG indexes inside the
    // write-path transaction. A regression in the hooks plumbing specific
    // to the write path wouldn't be caught by any other test in the suite.
    it("hypothetical_indexes work on an EXPLAIN ANALYZE write (writes path, not read-only path)", async () => {
      const check = (await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg') AS installed`,
      )) as { ok: boolean; data?: { installed: boolean }[] };
      const installed = check.ok && check.data?.[0]?.installed === true;
      if (!installed) return;

      const original = process.env.ALLOW_WRITES;
      process.env.ALLOW_WRITES = "1";
      try {
        const before = (await pgQuery.handler({
          sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.posts`,
        })) as { ok: boolean; data?: { rows: { c: number }[] } };
        assert.equal(before.ok, true);
        const beforeCount = before.data?.rows[0]?.c;

        const res = (await pgExplain.handler({
          sql: `INSERT INTO ${FIXTURE_SCHEMA}.posts (user_id, title, body) VALUES (1, 'hypo-rw-canary', 'x')`,
          analyze: true,
          format: "text",
          hypothetical_indexes: [{ table: `${FIXTURE_SCHEMA}.posts`, columns: ["body"], using: "btree" }],
        })) as { ok: boolean; data?: { plan: string }; error?: string };
        assert.equal(res.ok, true, `expected ok on analyze+writes+hypo, got error: ${res.error}`);
        assert.match(res.data?.plan ?? "", /Insert/i);

        // Hooks teardown (hypopg_reset) ran AND the rollback path persisted
        // nothing: same row count.
        const after = (await pgQuery.handler({
          sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.posts`,
        })) as { ok: boolean; data?: { rows: { c: number }[] } };
        assert.equal(after.ok, true);
        assert.equal(
          after.data?.rows[0]?.c,
          beforeCount,
          "INSERT under EXPLAIN ANALYZE must roll back even with hypothetical_indexes hooks",
        );
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
      // scripts/wsl-pg-setup.sh adds pg_stat_statements to
      // shared_preload_libraries so the matrix exercises the real path; on a
      // cluster without it we accept the "not installed" error as valid.
      // NOTE: when the extension is absent, EVERY test in this describe takes
      // that early return and proves nothing about the tool's SQL -- if you are
      // relying on this suite for pg_top_queries coverage, confirm the
      // extension is actually present first.
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
      // The fixture setup ran a handful of queries - there should be at least one row.
      assert.ok((res.data ?? []).length > 0);
      assert.ok(res.data?.[0].query);
    });

    it("supports all three orderBy values without error", async () => {
      for (const orderBy of ["total_time", "mean_time", "calls"] as const) {
        const res = (await pgTopQueries.handler({ orderBy, limit: 3 })) as {
          ok: boolean;
          error?: string;
        };
        // Either installed-and-ok, or extension missing - both acceptable.
        if (!res.ok) {
          assert.match(res.error ?? "", /pg_stat_statements/);
        }
      }
    });

    it("includes io_read_time_ms / io_write_time_ms when pg_stat_statements >= 1.10", async () => {
      const res = (await pgTopQueries.handler({ orderBy: "total_time", limit: 5 })) as {
        ok: boolean;
        data?: { query: string; io_read_time_ms?: number | null; io_write_time_ms?: number | null }[];
        error?: string;
      };
      if (!res.ok) {
        // pg_stat_statements not installed -- acceptable, skip the column check.
        assert.match(res.error ?? "", /pg_stat_statements/);
        return;
      }
      // Check the installed version. If < 1.10 the columns are absent (not a bug).
      // If >= 1.10, every row must have the keys present (null is fine -- means
      // track_io_timing=off or the query did no measurable IO; absent means the
      // column was not added to the SELECT).
      // Handler uses blk_read_time / blk_write_time for 1.10 (PG 15) and
      // shared_blk_read_time / shared_blk_write_time for >= 1.11 (PG 17);
      // both are exposed under the same io_*_time_ms output names.
      const versionRes = await runInternal<{ version: string }>(
        `SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'`,
      );
      if (!versionRes.ok || !versionRes.data?.length) return;
      const { compareVersions } = await import("../tools/stats.js");
      const hasIoTiming = compareVersions(versionRes.data[0].version, "1.10") >= 0;
      if (!hasIoTiming) return; // old extension -- no columns expected, test passes

      for (const row of res.data ?? []) {
        assert.ok(
          "io_read_time_ms" in row,
          `io_read_time_ms must be present on pg_stat_statements >= 1.10, got keys: ${Object.keys(row).join(", ")}`,
        );
        assert.ok(
          "io_write_time_ms" in row,
          `io_write_time_ms must be present on pg_stat_statements >= 1.10, got keys: ${Object.keys(row).join(", ")}`,
        );
        // Values are either null (timing off / no IO) or a non-negative number.
        if (row.io_read_time_ms !== null) assert.equal(typeof row.io_read_time_ms, "number");
        if (row.io_write_time_ms !== null) assert.equal(typeof row.io_write_time_ms, "number");
      }
    });

    // The `dbid` filter is the whole reason pg_top_queries doesn't leak query
    // text across a shared cluster. pg_stat_statements is cluster-wide, so a
    // query executed against a DIFFERENT database in the same cluster lands in
    // the same view under a different dbid -- and must not come back here.
    // Dropping the WHERE clause restores the leak silently; nothing else in
    // the suite would notice.
    it("excludes queries from other databases in the same cluster (dbid scoping)", async () => {
      const staged = await runMarkerQueryInOtherDatabase();
      if (!staged) return; // no pg_stat_statements or no CREATEDB -- nothing to assert

      try {
        // Ask for a large limit so the marker isn't merely ranked off the end.
        const res = (await pgTopQueries.handler({ orderBy: "calls", limit: 100 })) as {
          ok: boolean;
          data?: { query: string }[];
          error?: string;
        };
        if (!res.ok) {
          assert.match(res.error ?? "", /pg_stat_statements/);
          return;
        }
        const leaked = (res.data ?? []).filter((r) => r.query.includes(FIXTURE_OTHER_DB_MARKER));
        assert.deepEqual(
          leaked,
          [],
          `query text from ${FIXTURE_OTHER_DB} leaked into pg_top_queries: ${JSON.stringify(leaked)}`,
        );

        // Positive control: the marker really IS in the cluster-wide view, so
        // the assertion above is proving the filter works rather than passing
        // because pg_stat_statements never recorded anything.
        const clusterWide = (await runInternal<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_statements WHERE query LIKE $1`,
          [`%${FIXTURE_OTHER_DB_MARKER}%`],
        )) as { ok: boolean; data?: { n: string }[] };
        if (clusterWide.ok) {
          assert.notEqual(
            clusterWide.data?.[0]?.n,
            "0",
            "positive control failed: the marker query was never recorded cluster-wide, so the dbid assertion is vacuous",
          );
        }
      } finally {
        await dropOtherDatabase();
      }
    });

    // Note: an integration test for the orderBy=calls numeric-vs-lexical
    // sort (alias-shadowing trap called out in stats.ts:60-67) was attempted
    // across 0.6.7-0.6.9 and could not be made environment-independent.
    // pg_stat_statements in PG17/18 fingerprints `SELECT 1 AS x_a` and
    // `SELECT 2 AS x_b` to the SAME query id (column aliases drop out of the
    // jumble even though they're preserved in the displayed query text), so
    // staging two markers with different aliases produces one merged entry
    // and the ordering assertion has nothing to compare against. Local WSL
    // clusters happen to differentiate; CI does not. The trap remains a
    // regression vector but the SQL pattern is well-commented at the call
    // site and a regression would require actively removing the
    // `pg_stat_statements.` qualifier.
  });
});
