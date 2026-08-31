// SERIALIZATION: see the note at the top of query.integration.test.ts. These
// files share process-global singletons (the pg pool, typeNameCache, env) and
// MUST run one at a time.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getServerVersionNum, PG16, runInternal } from "../api.js";
import { indexAdvisorTools } from "../tools/index-advisor.js";
import { FIXTURE_SCHEMA, hypopgAvailable, integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const pgIndexAdvisor = indexAdvisorTools[0];

describe("integration: pg_index_advisor", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  // The sibling regression tests for pg_query / pg_readonly / pg_explain live in
  // query.integration.test.ts. pg_index_advisor had NO integration file at all,
  // which is how it shipped as the one tool that sent caller SQL to the server
  // without the extended-protocol guard the others get from api.ts:runReadOnly.
  //
  // Why the guard is not simply "use the extended protocol everywhere": that
  // protocol requires the bind parameter COUNT to match the statement's
  // placeholders, and this tool's whole purpose is planning normalized
  // pg_stat_statements text whose `$n` are deliberately unbound (GENERIC_PLAN).
  // So the extended protocol is used once per statement purely as a
  // single-statement validator. Both halves need pinning: the payload must be
  // rejected, AND a legitimate parameterized statement must still plan.
  describe("stacked-query injection", () => {
    it("rejects a stacked payload in `statements` instead of executing it", async () => {
      // Same in-body guard as the two tests below. pg_index_advisor probes for
      // HypoPG BEFORE it builds the workload (index-advisor.ts), so on a cluster
      // where `CREATE EXTENSION hypopg` failed -- exactly the case fixtures.ts
      // now tracks, and the one its own comment anticipates for a PG major PGDG
      // has not packaged yet -- res.error is the extension-missing message. The
      // assertion below would then go red reporting what looks like a failed
      // injection defense, on a run where the payload never reached the server.
      if (!hypopgAvailable()) return;

      const canary = `${FIXTURE_SCHEMA}.advisor_injection_canary`;
      const created = await runInternal(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);
      assert.equal(created.ok, true, "canary table must exist for the test to mean anything");

      // The Datadog payload shape: end the read-only transaction mid-string,
      // then run something destructive in the autocommit that follows.
      const payload = `SELECT 1; COMMIT; DROP TABLE ${canary};`;
      const res = (await pgIndexAdvisor.handler({ statements: [payload] })) as {
        ok: boolean;
        error?: string;
        data?: { _warnings?: string[] };
      };

      // Either shape is an acceptable rejection: the statement is refused
      // outright (no plannable workload left), or it is dropped with a warning.
      // What is NOT acceptable is the DROP having run.
      if (res.ok) {
        const warnings = res.data?._warnings ?? [];
        assert.ok(
          warnings.some((w) => /multiple commands|could not plan/i.test(w)),
          `expected a rejection warning, got ${JSON.stringify(warnings)}`,
        );
      } else {
        assert.match(res.error ?? "", /multiple commands|could not plan|nothing to index/i);
      }

      const survived = await runInternal<{ c: string }>(
        `SELECT count(*)::text AS c FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [FIXTURE_SCHEMA, "advisor_injection_canary"],
      );
      assert.equal(survived.ok, true);
      assert.equal(
        survived.data?.[0]?.c,
        "1",
        "the canary table must survive -- a stacked DROP escaped the READ ONLY transaction",
      );

      await runInternal(`DROP TABLE IF EXISTS ${canary}`);
    });

    it("still plans an ordinary statement", async () => {
      // Checked in the BODY, not as a `skip` option: an option object is
      // evaluated when `it()` registers the test, which is during the describe
      // callback -- before `before(setupFixtures)` has run and set the flag. As
      // a skip option this read false every time and the test silently never
      // ran. Same in-body pattern the fdwFixtureAvailable() call sites use.
      if (!hypopgAvailable()) return;

      // The guard runs the EXPLAIN itself on the extended protocol when the
      // statement has no placeholders, so this is the path that must not have
      // been broken by adding the rejection.
      const res = (await pgIndexAdvisor.handler({
        statements: [`SELECT * FROM ${FIXTURE_SCHEMA}.users WHERE email = 'nobody@example.com'`],
        max_explains: 20,
      })) as { ok: boolean; error?: string; data?: { statements?: { planned: boolean }[] } };

      assert.equal(res.ok, true, `an ordinary statement must still plan, got: ${res.error}`);
      assert.equal(res.data?.statements?.[0]?.planned, true);
    });

    it("still plans a legitimate parameterized statement", async () => {
      if (!hypopgAvailable()) return;
      // GENERIC_PLAN is PostgreSQL 16+, and below it the advisor deliberately
      // skips a parameterized statement with its own warning -- a pre-existing
      // behaviour this guard does not change. Asserting the planned path there
      // would be asserting the wrong thing, so the version decides which
      // outcome is correct.
      if ((await getServerVersionNum()) < PG16) return;

      // A single statement carrying `$1` FAILS the extended-protocol bind
      // (08P01), and that failure is precisely what proves it is one command.
      // It has to end up planned, not rejected alongside the stacked payload
      // above -- otherwise the fix would have cost the tool the normalized
      // pg_stat_statements workload it exists to analyze.
      const res = (await pgIndexAdvisor.handler({
        statements: [`SELECT * FROM ${FIXTURE_SCHEMA}.users WHERE email = $1`],
        max_explains: 20,
      })) as { ok: boolean; error?: string; data?: { statements?: { planned: boolean }[] } };

      assert.equal(res.ok, true, `parameterized statement must still plan, got: ${res.error}`);
      assert.equal(
        res.data?.statements?.[0]?.planned,
        true,
        "a single parameterized statement must survive the stacked-query guard",
      );
    });

    it("rejects a stacked payload that also carries a placeholder", async () => {
      if (!hypopgAvailable()) return;

      // The most load-bearing shape in this file, because it is the one a real
      // attack takes on the pg_stat_statements path: that text is always
      // `$n`-normalized, so a payload harvested from it arrives carrying BOTH
      // placeholders AND the stacked commands.
      //
      // The guard's whole premise is that PARSE precedes BIND. Postgres refuses
      // to parse a multi-command string (42601), and the bind-count mismatch
      // (08P01) is only reachable once parse has already succeeded. That
      // ordering is load-bearing rather than incidental: 08P01 is the branch
      // that CLEARS a statement as "one command whose `$n` are simply unbound"
      // and hands it on to the simple protocol, which executes every command in
      // the string. Invert the two and this payload is cleared, not rejected.
      const canary = `${FIXTURE_SCHEMA}.advisor_injection_canary_param`;
      const created = await runInternal(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);
      assert.equal(created.ok, true, "canary table must exist for the test to mean anything");

      try {
        const payload = `SELECT $1; COMMIT; DROP TABLE ${canary};`;
        const res = (await pgIndexAdvisor.handler({ statements: [payload] })) as {
          ok: boolean;
          error?: string;
          data?: { _warnings?: string[] };
        };

        // Same two acceptable rejection shapes as the test above: the reason
        // lands in `error` when nothing plannable survived and in `_warnings`
        // when something did. Reading both is what lets this test pin the
        // SQLSTATE rather than which of the two envelopes carried it.
        const reported = res.ok ? (res.data?._warnings ?? []).join(" | ") : (res.error ?? "");
        assert.match(reported, /multiple commands|could not plan|nothing to index/i);

        // Below PostgreSQL 16 the payload never reaches the server at all: a
        // `$n` statement is skipped for want of GENERIC_PLAN before the guard
        // runs. That is still a rejection -- the canary check below covers it --
        // but it is no evidence about parse-vs-bind, so the SQLSTATE assertion
        // only applies where the guard actually issued its probe.
        if ((await getServerVersionNum()) >= PG16) {
          assert.match(reported, /\(code: 42601\)/, `expected the multi-command parse error, got: ${reported}`);
          assert.ok(
            !/08P01/.test(reported),
            "the payload reached the bind-count branch, which CLEARS a statement as a single command -- " +
              `parse no longer precedes bind, so the guard now passes stacked SQL through: ${reported}`,
          );
        }

        const survived = await runInternal<{ c: string }>(
          `SELECT count(*)::text AS c FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [FIXTURE_SCHEMA, "advisor_injection_canary_param"],
        );
        assert.equal(survived.ok, true);
        assert.equal(
          survived.data?.[0]?.c,
          "1",
          "the canary table must survive -- a stacked DROP escaped the READ ONLY transaction",
        );
      } finally {
        // In a `finally` so a red assertion above cannot leave the canary behind
        // for the next run of this file to find already created.
        await runInternal(`DROP TABLE IF EXISTS ${canary}`);
      }
    });
  });

  describe("mixed workloads", () => {
    it("reports every statement against its own SQL when only some are rejected", async () => {
      if (!hypopgAvailable()) return;

      // `baselineCosts`, `rawPlans`, `needsGenericPlan` and `workload` are four
      // PARALLEL arrays, appended across five different `continue` paths in the
      // handler's baseline loop. An all-pass or an all-fail workload makes every
      // entry identical, so an off-by-one in any one of those paths is invisible
      // -- and both halves of the coverage above are exactly that shape. Only a
      // workload that MIXES the two can catch a rejected statement's null
      // baseline being attributed to the NEXT statement's SQL.
      const canary = `${FIXTURE_SCHEMA}.advisor_mixed_canary`;
      const created = await runInternal(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);
      assert.equal(created.ok, true, "canary table must exist for the test to mean anything");

      // Deliberately different relations, so the report rows cannot line up by
      // accident: if they slipped by one, the `sql` assertions below go red even
      // when every `planned` flag happens to look right.
      const first = `SELECT * FROM ${FIXTURE_SCHEMA}.users WHERE email = 'nobody@example.com'`;
      const rejected = `SELECT $1; COMMIT; DROP TABLE ${canary};`;
      const last = `SELECT * FROM ${FIXTURE_SCHEMA}.posts WHERE user_id = 42`;

      try {
        const res = (await pgIndexAdvisor.handler({
          statements: [first, rejected, last],
          max_explains: 20,
        })) as {
          ok: boolean;
          error?: string;
          data?: {
            statements?: { sql: string; baseline_cost: number | null; planned: boolean }[];
            baseline_workload_cost?: number;
          };
        };

        // One bad statement must not fail the whole call: the savepoint around
        // every EXPLAIN exists precisely so the rest of the workload reports.
        assert.equal(res.ok, true, `a partly-rejected workload must still report, got: ${res.error}`);
        const statements = res.data?.statements ?? [];
        assert.equal(statements.length, 3, "one report row per INPUT statement, rejected ones included");

        // `preview` only collapses whitespace and truncates at 300 characters,
        // so a short single-line statement round-trips verbatim -- which makes
        // these an exact check that report row i describes input i.
        assert.equal(statements[0]?.sql, first);
        assert.equal(statements[1]?.sql, rejected);
        assert.equal(statements[2]?.sql, last);

        assert.equal(statements[1]?.planned, false, "the stacked payload must be reported as unplanned");
        assert.equal(statements[1]?.baseline_cost, null, "an unplanned statement has no baseline, not a zero one");

        assert.equal(statements[0]?.planned, true, "a good statement BEFORE the rejected one must still plan");
        assert.equal(statements[2]?.planned, true, "a good statement AFTER the rejected one must still plan");
        assert.ok(
          typeof statements[2]?.baseline_cost === "number",
          "the last statement inherited the rejected one's null baseline -- the per-statement arrays slipped",
        );

        // The rejected entry is weighted 0, so it contributes NOTHING to the
        // total rather than contributing a 0 cost that would read as a free win.
        const plannedTotal = (statements[0]?.baseline_cost ?? 0) + (statements[2]?.baseline_cost ?? 0);
        // Each per-statement cost is rounded on its own and the total is rounded
        // once from the raw values, so the two can legitimately disagree in the
        // last cent. A wider gap than that means the rejected statement counted.
        assert.ok(
          Math.abs((res.data?.baseline_workload_cost ?? 0) - plannedTotal) <= 0.02,
          `baseline_workload_cost ${res.data?.baseline_workload_cost} is not the sum of the two planned ` +
            `statements (${plannedTotal}), so the rejected statement contributed to the total`,
        );

        const survived = await runInternal<{ c: string }>(
          `SELECT count(*)::text AS c FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2`,
          [FIXTURE_SCHEMA, "advisor_mixed_canary"],
        );
        assert.equal(survived.ok, true);
        assert.equal(
          survived.data?.[0]?.c,
          "1",
          "the canary table must survive -- a stacked DROP escaped the READ ONLY transaction",
        );
      } finally {
        await runInternal(`DROP TABLE IF EXISTS ${canary}`);
      }
    });
  });

  describe("HypoPG recommendations", () => {
    it("recommends an index on the column the workload filters, and sizes it", async () => {
      if (!hypopgAvailable()) return;

      // The one path with no real-database coverage until now. The unit tests
      // model HypoPG as a COUNTER -- any live hypothetical index makes plans
      // cheaper, and neither the index's shape nor its target relation is
      // consulted -- so a recommendation costed against the WRONG index, an oid
      // that no longer sizes, and an accepted index that silently failed to
      // persist all look exactly like a correct run there.
      //
      // The shared fixture cannot serve this: `users` and `posts` hold three
      // rows each, where a sequential scan already wins and HypoPG correctly
      // recommends nothing. A table big enough that an index genuinely pays is
      // the only way to reach the accept-and-size path at all.
      const table = "advisor_hypopg_probe";
      const qualified = `${FIXTURE_SCHEMA}.${table}`;
      const filterColumn = "lookup_key";

      const setup = [
        `CREATE TABLE ${qualified} (
           id BIGSERIAL PRIMARY KEY,
           ${filterColumn} INTEGER NOT NULL,
           payload TEXT NOT NULL
         )`,
        `INSERT INTO ${qualified} (${filterColumn}, payload)
           SELECT g, repeat('x', 40) FROM generate_series(1, 50000) g`,
        // Without stats the planner works from its defaults, and the cost delta
        // this test reads would be an artifact of those defaults rather than a
        // measurement of the candidate.
        `ANALYZE ${qualified}`,
      ];

      try {
        for (const sql of setup) {
          const res = await runInternal(sql);
          assert.equal(res.ok, true, `probe-table setup failed: ${(res as { error?: string }).error}`);
        }

        // `payload` is in the SELECT list and NEVER in a predicate, so it must
        // not reach the candidate: the planner reports it under `Output`, which
        // this tool deliberately does not harvest.
        const res = (await pgIndexAdvisor.handler({
          statements: [`SELECT payload FROM ${qualified} WHERE ${filterColumn} = 12345`],
          max_explains: 20,
        })) as {
          ok: boolean;
          error?: string;
          data?: {
            recommendations?: { table: string; columns: string[]; estimated_size_bytes: string | null }[];
          };
        };

        assert.equal(res.ok, true, `the advisor must run against a real HypoPG, got: ${res.error}`);
        const recommendations = res.data?.recommendations ?? [];
        assert.ok(
          recommendations.length >= 1,
          "no index was recommended for a 50k-row sequential scan with a selective equality predicate -- " +
            "either HypoPG is not costing candidates at all, or nothing survived `min_improvement`",
        );

        const top = recommendations[0];
        assert.equal(top?.table, qualified, "the recommendation names the wrong relation");
        assert.deepEqual(
          top?.columns,
          [filterColumn],
          "the recommendation must key on the column the workload filters on, and on nothing else",
        );

        // The specific thing this pins: `onAccept` recreates the winning index so
        // later rounds cost on top of it, and the sizing pass at the end reuses
        // THAT oid rather than creating a second copy. A null here means the oid
        // it kept is no longer a sizeable relation by the time the search
        // finished -- which no stubbed-HypoPG unit test can observe.
        assert.ok(
          typeof top?.estimated_size_bytes === "string" && /^\d+$/.test(top.estimated_size_bytes),
          `estimated_size_bytes must be a decimal bigint string, got ${JSON.stringify(top?.estimated_size_bytes)}`,
        );
        assert.ok(Number(top?.estimated_size_bytes) > 0, "a hypothetical btree over 50k rows cannot be 0 bytes");
      } finally {
        // In a `finally` so a red assertion cannot leave a 50k-row table in the
        // fixture schema for every later test in the run to trip over.
        await runInternal(`DROP TABLE IF EXISTS ${qualified}`);
      }
    });
  });
});
