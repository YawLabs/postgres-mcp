import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { formatPgError, shutdown, TERMINATE_OWN_BACKEND_SQL } from "../api.js";
import {
  applySkipScanGate,
  assertSingleStatement,
  buildCandidates,
  classifyRole,
  extractIdentifiers,
  greedySearch,
  harvestPlanPredicates,
  type IndexCandidate,
  indexAdvisorTools,
  normalizeDistinct,
  type PredicateRole,
  planTotalCost,
  type RelationPredicates,
  renderCreateIndex,
} from "./index-advisor.js";

const [pgIndexAdvisor] = indexAdvisorTools;

/** Shorthand for a harvested relation, so the candidate tests stay readable. */
function predicates(
  schema: string,
  table: string,
  columns: Record<string, PredicateRole[]>,
): Map<string, RelationPredicates> {
  const map = new Map<string, Set<PredicateRole>>();
  for (const [column, roles] of Object.entries(columns)) map.set(column, new Set(roles));
  return new Map([[`${schema}.${table}`, { schema, table, columns: map }]]);
}

function candidate(table: string, columns: string[], overrides: Partial<IndexCandidate> = {}): IndexCandidate {
  return {
    schema: "public",
    table,
    columns,
    leadingConstrained: true,
    statements: [0],
    seqScans: 0,
    ...overrides,
  };
}

describe("extractIdentifiers", () => {
  it("pulls bare identifiers out of a planner condition", () => {
    const tokens = extractIdentifiers("(status = 'active'::text)");
    assert.ok(tokens.includes("status"));
  });

  it("pulls quoted identifiers out whole rather than in fragments", () => {
    const tokens = extractIdentifiers('("odd name" = 3)');
    assert.ok(tokens.includes("odd name"), `expected the quoted name intact, got ${JSON.stringify(tokens)}`);
    // The bare pass runs over a copy with quoted runs blanked out, so the
    // fragments of a quoted name must NOT also appear -- otherwise a name like
    // "odd name" would additionally propose columns `odd` and `name`.
    assert.ok(!tokens.includes("odd"));
    assert.ok(!tokens.includes("name"));
  });

  it("un-doubles an embedded quote", () => {
    assert.ok(extractIdentifiers('("weird""col" = 1)').includes('weird"col'));
  });

  it("over-collects non-column tokens, which the catalog check is expected to drop", () => {
    // This is the documented contract, not an accident: the tokenizer is loose
    // and pg_attribute is what makes it safe. A test asserting it collects ONLY
    // columns would be asserting a parser this tool deliberately does not have.
    const tokens = extractIdentifiers("(status = 'active'::text)");
    assert.ok(tokens.includes("text"));
  });
});

describe("classifyRole", () => {
  it("reads an equality predicate as equality", () => {
    assert.equal(classifyRole("status", "(status = 'active'::text)"), "equality");
  });

  it("reads an inequality as a range in either operand order", () => {
    assert.equal(classifyRole("created_at", "(created_at > '2024-01-01'::date)"), "range");
    assert.equal(classifyRole("created_at", "('2024-01-01'::date < created_at)"), "range");
  });

  it("does NOT treat <> as a range: a btree cannot bound a scan with it", () => {
    assert.equal(classifyRole("status", "(status <> 'active'::text)"), "equality");
  });

  it("falls back to equality when no operator sits beside the column", () => {
    assert.equal(classifyRole("email", "(lower(email) = 'x'::text)"), "equality");
  });

  it("is not confused by a column name that is a substring of another", () => {
    // `id` must not match inside `user_id`; the \b guards are what prevent a
    // candidate on the wrong column.
    assert.equal(classifyRole("id", "(user_id > 5)"), "equality");
  });
});

describe("normalizeDistinct", () => {
  it("treats a negative n_distinct as an already-normalized fraction", () => {
    assert.equal(normalizeDistinct(-1, 1000), 1);
    assert.equal(normalizeDistinct(-0.5, 1000), 0.5);
  });

  it("divides a positive n_distinct by the row count", () => {
    assert.equal(normalizeDistinct(500, 1000), 0.5);
  });

  it("returns 0 (sorts LAST) for a never-analyzed column rather than guessing", () => {
    assert.equal(normalizeDistinct(null, 1000), 0);
    assert.equal(normalizeDistinct(0, 1000), 0);
    // Positive n_distinct with no usable reltuples cannot be normalized, so it
    // must not be allowed to win a leading key position.
    assert.equal(normalizeDistinct(500, 0), 0);
  });
});

describe("harvestPlanPredicates", () => {
  const knownColumns = new Map<string, Set<string>>([
    ["public.users", new Set(["id", "status", "created_at", "email"])],
    ["public.orders", new Set(["id", "user_id", "total"])],
  ]);

  it("attributes a scan-node Filter to that node's relation", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "users",
          Schema: "public",
          "Total Cost": 100,
          Filter: "(status = 'active'::text)",
        },
      },
    ];
    const harvest = harvestPlanPredicates(plan, knownColumns);
    const users = harvest.get("public.users");
    assert.ok(users, "expected public.users in the harvest");
    assert.deepEqual([...(users.columns.get("status") ?? [])], ["equality"]);
    // `text` is a token in the condition but not a column of users, so the
    // catalog intersection must have dropped it.
    assert.equal(users.columns.has("text"), false);
  });

  it("ignores a relation the catalog lookup does not know", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "audit_log",
          Schema: "public",
          "Total Cost": 100,
          Filter: "(status = 'x'::text)",
        },
      },
    ];
    assert.equal(harvestPlanPredicates(plan, knownColumns).size, 0);
  });

  it("skips a node with no Schema rather than guessing 'public'", () => {
    const plan = [
      {
        Plan: { "Node Type": "Seq Scan", "Relation Name": "users", "Total Cost": 100, Filter: "(status = 'x')" },
      },
    ];
    assert.equal(harvestPlanPredicates(plan, knownColumns).size, 0);
  });

  it("attributes a join condition to the relations beneath the join node", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Hash Join",
          "Total Cost": 500,
          "Hash Cond": "(orders.user_id = users.id)",
          Plans: [
            { "Node Type": "Seq Scan", "Relation Name": "orders", Schema: "public", "Total Cost": 200 },
            { "Node Type": "Seq Scan", "Relation Name": "users", Schema: "public", "Total Cost": 100 },
          ],
        },
      },
    ];
    const harvest = harvestPlanPredicates(plan, knownColumns);
    assert.ok(harvest.get("public.orders")?.columns.has("user_id"));
    assert.ok(harvest.get("public.users")?.columns.has("id"));
  });

  it("marks a Sort Key column as 'sort', never as an equality column", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Sort",
          "Total Cost": 300,
          "Sort Key": ["users.created_at DESC"],
          Plans: [{ "Node Type": "Seq Scan", "Relation Name": "users", Schema: "public", "Total Cost": 100 }],
        },
      },
    ];
    const harvest = harvestPlanPredicates(plan, knownColumns);
    assert.deepEqual([...(harvest.get("public.users")?.columns.get("created_at") ?? [])], ["sort"]);
  });

  it("does not throw on a malformed plan", () => {
    assert.equal(harvestPlanPredicates("not a plan", knownColumns).size, 0);
    assert.equal(harvestPlanPredicates([], knownColumns).size, 0);
    assert.equal(harvestPlanPredicates(null, knownColumns).size, 0);
  });
});

describe("planTotalCost", () => {
  it("reads Total Cost off the root node", () => {
    assert.equal(planTotalCost([{ Plan: { "Total Cost": 42.5 } }]), 42.5);
  });

  it("returns null rather than 0 for a malformed plan", () => {
    // A 0 baseline would make every candidate look like it made things worse,
    // so "unknown" has to be distinguishable from "free".
    assert.equal(planTotalCost([{ Plan: {} }]), null);
    assert.equal(planTotalCost("nonsense"), null);
    assert.equal(planTotalCost([]), null);
  });
});

describe("buildCandidates", () => {
  const stats = new Map([
    [
      "public.users",
      new Map([
        ["email", { distinctRatio: 1 }],
        ["status", { distinctRatio: 0.01 }],
        ["created_at", { distinctRatio: 0.9 }],
      ]),
    ],
  ]);

  it("generates every prefix of the ordered key, narrowest first", () => {
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { status: ["equality"], created_at: ["range"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    assert.deepEqual(
      candidates.map((c) => c.columns),
      [["status"], ["status", "created_at"]],
    );
  });

  it("puts equality columns ahead of range columns regardless of selectivity", () => {
    // created_at is far more selective (0.9 vs 0.01) but it is a RANGE
    // predicate: leading with it would leave the equality column unsearchable.
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { created_at: ["range"], status: ["equality"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    assert.deepEqual(candidates.at(-1)?.columns, ["status", "created_at"]);
  });

  it("orders equality columns by selectivity, most distinct first", () => {
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { status: ["equality"], email: ["equality"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    assert.deepEqual(candidates.at(-1)?.columns, ["email", "status"]);
  });

  it("keeps at most one range column: a btree cannot search past its first inequality", () => {
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { status: ["equality"], created_at: ["range"], email: ["range"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 4,
    });
    const widest = candidates.at(-1)?.columns ?? [];
    assert.equal(widest.length, 2, `expected one equality + one range, got ${JSON.stringify(widest)}`);
    assert.deepEqual(widest, ["status", "email"]);
  });

  it("places sort columns after the filtered prefix", () => {
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { status: ["equality"], created_at: ["sort"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    assert.deepEqual(candidates.at(-1)?.columns, ["status", "created_at"]);
  });

  it("honors maxIndexColumns", () => {
    const candidates = buildCandidates({
      perStatement: [
        predicates("public", "users", { email: ["equality"], status: ["equality"], created_at: ["sort"] }),
      ],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 2,
    });
    for (const c of candidates) assert.ok(c.columns.length <= 2);
  });

  it("unions a relation's columns across statements instead of proposing one index per statement", () => {
    const candidates = buildCandidates({
      perStatement: [
        predicates("public", "users", { status: ["equality"] }),
        predicates("public", "users", { created_at: ["sort"] }),
      ],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    const widest = candidates.at(-1);
    assert.deepEqual(widest?.columns, ["status", "created_at"]);
    // Both statements touched the relation, so both must be re-costed for it.
    assert.deepEqual(widest?.statements, [0, 1]);
  });

  it("drops a candidate an existing index already covers as a prefix", () => {
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { status: ["equality"], created_at: ["range"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(["public users status"]),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    assert.deepEqual(
      candidates.map((c) => c.columns),
      [["status", "created_at"]],
    );
  });

  it("flags a candidate whose leading column is only ever a sort key", () => {
    const candidates = buildCandidates({
      perStatement: [predicates("public", "users", { created_at: ["sort"], status: ["sort"] })],
      columnStats: stats,
      existingIndexPrefixes: new Set(),
      seqScans: new Map(),
      maxIndexColumns: 3,
    });
    for (const c of candidates) assert.equal(c.leadingConstrained, false);
  });

  it("ranks the most sequentially-scanned table first, so a tight cap keeps what matters", () => {
    const hot = predicates("public", "hot", { a: ["equality"] });
    const cold = predicates("public", "cold", { a: ["equality"] });
    const candidates = buildCandidates({
      perStatement: [new Map([...hot, ...cold])],
      columnStats: new Map(),
      existingIndexPrefixes: new Set(),
      seqScans: new Map([
        ["public.hot", 9000],
        ["public.cold", 1],
      ]),
      maxIndexColumns: 3,
    });
    assert.equal(candidates[0]?.table, "hot");
  });
});

describe("applySkipScanGate (PostgreSQL 18 skip scan)", () => {
  const unconstrainedLead = candidate("users", ["status", "created_at"], { leadingConstrained: false });
  const constrainedLead = candidate("users", ["status", "created_at"], { leadingConstrained: true });
  const singleColumn = candidate("users", ["status"], { leadingConstrained: false });

  it("PRUNES an unconstrained leading column below PG18, where the index is unusable", () => {
    const { kept, pruned } = applySkipScanGate([unconstrainedLead, constrainedLead], 170_000);
    assert.deepEqual(
      kept.map((c) => c.leadingConstrained),
      [true],
    );
    assert.equal(pruned.length, 1);
  });

  it("KEEPS an unconstrained leading column on PG18+, where skip scan makes it usable", () => {
    // The load-bearing assertion of this file. PG18 added B-tree skip scan, so
    // the classic "leading column never filtered = useless index" rule is wrong
    // there, and applying it would silently discard a correct recommendation.
    const { kept, pruned } = applySkipScanGate([unconstrainedLead, constrainedLead], 180_000);
    assert.equal(kept.length, 2);
    assert.equal(pruned.length, 0);
  });

  it("never prunes a single-column candidate, whose leading column is its only column", () => {
    const { kept, pruned } = applySkipScanGate([singleColumn], 170_000);
    assert.equal(kept.length, 1);
    assert.equal(pruned.length, 0);
  });

  it("treats an unknown server version (0) as pre-PG18 rather than assuming skip scan", () => {
    // getServerVersionNum returns 0 when it cannot read the version. Assuming
    // skip scan there would spend the whole budget on candidates an old server
    // can never use.
    const { pruned } = applySkipScanGate([unconstrainedLead], 0);
    assert.equal(pruned.length, 1);
  });

  it("gates exactly at 180000, not one version early or late", () => {
    assert.equal(applySkipScanGate([unconstrainedLead], 179_999).pruned.length, 1);
    assert.equal(applySkipScanGate([unconstrainedLead], 180_000).pruned.length, 0);
  });
});

describe("renderCreateIndex", () => {
  it("quotes the schema, table, and every column independently", () => {
    const sql = renderCreateIndex(candidate("users", ["status", "created_at"]), false);
    assert.match(sql, /ON "public"\."users" USING btree \("status", "created_at"\)/);
  });

  it("emits the CONCURRENTLY form on request", () => {
    assert.match(renderCreateIndex(candidate("users", ["status"]), true), /CREATE INDEX CONCURRENTLY /);
    assert.doesNotMatch(renderCreateIndex(candidate("users", ["status"]), false), /CONCURRENTLY/);
  });

  it("keeps the generated index name inside PostgreSQL's 63-byte limit", () => {
    const long = renderCreateIndex(candidate("t".repeat(60), ["c".repeat(60)]), false);
    const name = /CREATE INDEX "([^"]+)"/.exec(long)?.[1] ?? "";
    assert.ok(Buffer.byteLength(name, "utf8") <= 63, `name was ${Buffer.byteLength(name, "utf8")} bytes`);
  });

  it("does not split a multi-byte character when truncating the name", () => {
    const sql = renderCreateIndex(candidate("é".repeat(40), ["x"]), false);
    const name = /CREATE INDEX "([^"]+)"/.exec(sql)?.[1] ?? "";
    assert.ok(Buffer.byteLength(name, "utf8") <= 63);
    assert.ok(!name.includes("�"), "truncation produced a replacement character");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The stacked-query guard.
//
// These tests exist because the ONLY other coverage of this function is an
// integration test gated behind POSTGRES_MCP_INTEGRATION=1, which the default
// `npm test` does not set. That was demonstrated by mutation: deleting the
// `{ extended: true }` argument from the probe -- which fully restores the
// stacked-query vulnerability, confirmed by a live canary table being DROPped --
// left the entire suite green. The `extended: true` assertion below is the one
// that kills that mutant, so do not relax it.
//
// The postgres error fixtures are built by calling the REAL formatPgError
// rather than hand-writing its output. BIND_COUNT_MISMATCH matches on the
// `(code: 08P01)` fragment that function renders, so going through it keeps the
// guard's regex coupled to the real renderer: if formatPgError ever stops
// emitting that fragment, case (b) fails here instead of the guard silently
// starting to reject every parameterized statement in production.
// ─────────────────────────────────────────────────────────────────────────
describe("assertSingleStatement: the stacked-query guard", () => {
  /** A pg-shaped error: an Error carrying a SQLSTATE on `code`. */
  function pgError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
  }

  /**
   * Minimal SharedRunner stand-in. Savepoint traffic always succeeds; the one
   * non-savepoint statement (the probe) returns whatever the test supplies.
   */
  function fakeRunner(probeResult: unknown) {
    const calls: { sql: string; params?: unknown[]; options?: { extended?: boolean } }[] = [];
    const run = (async (sql: string, params?: unknown[], options?: { extended?: boolean }) => {
      calls.push({ sql, params, options });
      if (/^\s*(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)\b/i.test(sql)) {
        return { ok: true, data: [] };
      }
      return probeResult;
    }) as unknown as Parameters<typeof assertSingleStatement>[0];
    const probes = () => calls.filter((c) => !/^\s*(SAVEPOINT|ROLLBACK|RELEASE)\b/i.test(c.sql));
    return { run, calls, probes };
  }

  it("sends the probe on the EXTENDED protocol -- the whole guard", async () => {
    // Without this argument pg picks the protocol from the values array, an
    // empty array selects the SIMPLE protocol, and the simple protocol executes
    // every command in a multi-statement string.
    const { run, probes } = fakeRunner({
      ok: true,
      data: [{ "QUERY PLAN": [{ Plan: { "Total Cost": 917.54 } }] }],
    });
    await assertSingleStatement(run, "EXPLAIN (FORMAT JSON, VERBOSE) SELECT 1");
    assert.equal(probes().length, 1, "expected exactly one probe statement");
    assert.equal(
      probes()[0]?.options?.extended,
      true,
      "the probe MUST go out on the extended protocol -- this is the stacked-query defense",
    );
  });

  it("(a) reuses the plan when the statement has no placeholders", async () => {
    const { run, probes } = fakeRunner({
      ok: true,
      data: [{ "QUERY PLAN": [{ Plan: { "Total Cost": 917.54 } }] }],
    });
    const out = await assertSingleStatement(run, "EXPLAIN (FORMAT JSON, VERBOSE) SELECT 1");
    assert.equal(out.ok, true);
    assert.equal(out.cost, 917.54, "a successful probe IS a complete EXPLAIN; its plan must be reused");
    assert.equal(probes().length, 1, "reusing the plan means no second round trip");
  });

  it("(b) treats an 08P01 bind-count mismatch as proof of a single statement", async () => {
    // BIND happens after PARSE, so reaching a bind error proves the string
    // parsed as ONE command -- it just carries unbound $n placeholders.
    const { run } = fakeRunner({
      ok: false,
      error: formatPgError(
        pgError('bind message supplies 0 parameters, but prepared statement "" requires 1', "08P01"),
      ),
    });
    const out = await assertSingleStatement(run, "EXPLAIN (FORMAT JSON, VERBOSE, GENERIC_PLAN) SELECT $1");
    assert.equal(out.ok, true, "a parameterized statement must be cleared, not rejected");
    assert.equal(out.cost, undefined, "nothing was planned, so the caller has to run the real EXPLAIN");
  });

  it("(c) rejects a 42601 multi-command string", async () => {
    const { run } = fakeRunner({
      ok: false,
      error: formatPgError(pgError("cannot insert multiple commands into a prepared statement", "42601")),
    });
    const out = await assertSingleStatement(run, "EXPLAIN (FORMAT JSON) SELECT 1; DROP TABLE users;");
    assert.equal(out.ok, false, "a stacked payload must be rejected");
    assert.match(out.error ?? "", /multiple commands/);
  });

  it("rejects any other error rather than assuming it is safe", async () => {
    // The guard is allow-list shaped: only 08P01 clears a statement it could
    // not plan. Anything else -- a syntax error, a permission denial, a
    // SQLSTATE this code has never seen -- must not fall through to the simple
    // protocol.
    for (const [message, code] of [
      ["syntax error at or near \\", "42601"],
      ["permission denied for table users", "42501"],
      ["some future error", "XX999"],
    ] as const) {
      const { run } = fakeRunner({ ok: false, error: formatPgError(pgError(message, code)) });
      const out = await assertSingleStatement(run, "EXPLAIN (FORMAT JSON) SELECT 1");
      assert.equal(out.ok, false, `SQLSTATE ${code} must not clear the guard`);
    }
  });

  it("releases the savepoint on both the success and the failure path", async () => {
    // ROLLBACK TO clears the aborted state but LEAVES the savepoint, so a
    // missing RELEASE leaks one per failed statement for the life of the txn.
    const ok = fakeRunner({ ok: true, data: [{ "QUERY PLAN": [{ Plan: { "Total Cost": 1 } }] }] });
    await assertSingleStatement(ok.run, "EXPLAIN (FORMAT JSON) SELECT 1");
    assert.equal(ok.calls.filter((c) => /^RELEASE SAVEPOINT/i.test(c.sql)).length, 1);

    const bad = fakeRunner({ ok: false, error: formatPgError(pgError("nope", "42601")) });
    await assertSingleStatement(bad.run, "EXPLAIN (FORMAT JSON) SELECT 1; SELECT 2;");
    assert.equal(bad.calls.filter((c) => /^ROLLBACK TO SAVEPOINT/i.test(c.sql)).length, 1);
    assert.equal(bad.calls.filter((c) => /^RELEASE SAVEPOINT/i.test(c.sql)).length, 1);
  });
});

describe("greedySearch bounded search", () => {
  /** Every candidate cuts the cost of each statement it touches by 90%. */
  const alwaysHelps = async (c: IndexCandidate, indices: number[]): Promise<Map<number, number>> => {
    const out = new Map<number, number>();
    for (const i of indices) out.set(i, 10);
    void c;
    return out;
  };

  it("never spends more EXPLAINs than the budget allows", async () => {
    let calls = 0;
    const candidates = Array.from({ length: 20 }, (_, i) => candidate(`t${i}`, ["a"], { statements: [0] }));
    const result = await greedySearch({
      candidates,
      currentCosts: [1000],
      weights: [1],
      explainBudget: 5,
      minImprovement: 0.1,
      maxRecommendations: 20,
      evaluate: async (c, indices) => {
        calls += indices.length;
        return alwaysHelps(c, indices);
      },
    });
    assert.ok(result.explainsUsed <= 5, `spent ${result.explainsUsed} of a 5 budget`);
    assert.equal(calls, result.explainsUsed, "the reported spend must match what evaluate actually cost");
    assert.equal(result.budgetExhausted, true);
  });

  it("counts one EXPLAIN per statement a candidate touches, not one per candidate", async () => {
    const result = await greedySearch({
      candidates: [candidate("t", ["a"], { statements: [0, 1, 2] })],
      currentCosts: [1000, 1000, 1000],
      weights: [1, 1, 1],
      explainBudget: 10,
      minImprovement: 0.1,
      maxRecommendations: 5,
      evaluate: alwaysHelps,
    });
    assert.equal(result.explainsUsed, 3);
  });

  it("refuses to start a candidate that would overshoot the cap", async () => {
    // A budget of 2 cannot afford a 3-statement candidate at all, so the search
    // must decline it rather than run it and report the overshoot afterwards.
    let called = false;
    const result = await greedySearch({
      candidates: [candidate("t", ["a"], { statements: [0, 1, 2] })],
      currentCosts: [1000, 1000, 1000],
      weights: [1, 1, 1],
      explainBudget: 2,
      minImprovement: 0.1,
      maxRecommendations: 5,
      evaluate: async (c, i) => {
        called = true;
        return alwaysHelps(c, i);
      },
    });
    assert.equal(called, false);
    assert.equal(result.explainsUsed, 0);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.accepted.length, 0);
  });

  it("honors maxRecommendations even when more candidates would still help", async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => candidate(`t${i}`, ["a"], { statements: [i] }));
    const result = await greedySearch({
      candidates,
      currentCosts: Array(6).fill(1000),
      weights: Array(6).fill(1),
      explainBudget: 100,
      minImprovement: 0.01,
      maxRecommendations: 2,
      evaluate: alwaysHelps,
    });
    assert.equal(result.accepted.length, 2);
    assert.equal(result.budgetExhausted, false);
  });

  it("rejects a candidate below minImprovement and stops", async () => {
    const result = await greedySearch({
      candidates: [candidate("t", ["a"], { statements: [0] })],
      currentCosts: [1000],
      weights: [1],
      explainBudget: 100,
      minImprovement: 0.5,
      // A 1% saving: real, but not worth an index.
      maxRecommendations: 5,
      evaluate: async () => new Map([[0, 990]]),
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.budgetExhausted, false);
  });

  it("measures each round on top of what earlier picks already fixed", async () => {
    // Both candidates fix statement 0. Once the first is accepted, the second
    // has nothing left to save and must be rejected -- which only happens if the
    // search re-measures against the UPDATED cost rather than the baseline.
    const seen: number[][] = [];
    const result = await greedySearch({
      candidates: [candidate("a", ["x"], { statements: [0] }), candidate("b", ["y"], { statements: [0] })],
      currentCosts: [1000],
      weights: [1],
      explainBudget: 100,
      minImprovement: 0.5,
      maxRecommendations: 5,
      evaluate: async (_c, indices) => {
        seen.push(indices);
        return new Map([[0, 10]]);
      },
    });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0]?.costBefore, 1000);
    assert.equal(result.accepted[0]?.costAfter, 10);
    // Round 1 evaluated both; round 2 evaluated the survivor and rejected it.
    assert.equal(seen.length, 3);
  });

  // The greedy contract is that each accepted index STAYS IN PLACE while the
  // rest are re-costed on top of it. `evaluate` measures one candidate and undoes
  // it, so without an onAccept hook to persist the winner nothing survives the
  // round boundary and the loop silently degrades into an independent
  // per-candidate ranking -- two candidates fixing the same statement each get
  // full credit for it. These pin the hook itself, which is the part a
  // database-free test can observe.
  it("persists each accepted candidate before the next round", async () => {
    const persisted: string[] = [];
    const result = await greedySearch({
      candidates: [candidate("a", ["x"], { statements: [0] }), candidate("b", ["y"], { statements: [1] })],
      currentCosts: [1000, 1000],
      weights: [1, 1],
      explainBudget: 100,
      minImprovement: 0.1,
      maxRecommendations: 2,
      evaluate: async (_c, indices) => new Map(indices.map((i) => [i, 10])),
      onAccept: async (c) => {
        persisted.push(c.table);
      },
    });
    assert.equal(result.accepted.length, 2);
    assert.deepEqual(
      persisted,
      result.accepted.map((a) => a.candidate.table),
      "every accepted candidate must be persisted, in acceptance order",
    );
  });

  // The sibling test above pins the SET and the ORDER of the persisted
  // candidates, which a version that batches every onAccept AFTER the loop
  // satisfies just as well. What that version loses is the INTERLEAVING, and
  // the interleaving is the whole point: the persist has to land between round
  // N and round N+1 or round N+1 measures against the bare baseline again.
  it("runs onAccept BETWEEN rounds, not batched after the search", async () => {
    // One shared ordered log, written by both callbacks, so the assertion can
    // see the two interleave rather than only that both happened.
    const trace: string[] = [];
    const result = await greedySearch({
      candidates: [candidate("a", ["x"], { statements: [0] }), candidate("b", ["y"], { statements: [1] })],
      currentCosts: [1000, 1000],
      weights: [1, 1],
      explainBudget: 100,
      minImprovement: 0.1,
      maxRecommendations: 2,
      evaluate: async (c, indices) => {
        trace.push(`evaluate:${c.table}`);
        return new Map(indices.map((i) => [i, 10]));
      },
      onAccept: async (c) => {
        trace.push(`accept:${c.table}`);
      },
    });
    assert.equal(result.accepted.length, 2);
    // Round 1 costs both candidates and accepts `a`; `a` is then persisted; only
    // then does round 2 re-cost the survivor on top of it. Hoisting the persists
    // out of the loop yields evaluate,evaluate,evaluate,accept,accept -- same
    // accepted set, same acceptance order, wrong search.
    assert.deepEqual(trace, ["evaluate:a", "evaluate:b", "accept:a", "evaluate:b", "accept:b"]);
    // Restated as the property itself, so a future change to the round shape
    // still fails here for the right reason instead of on the literal above.
    assert.ok(
      trace.indexOf("accept:a") < trace.lastIndexOf("evaluate:b"),
      `no evaluate ran after an accept, so every persist trailed the search: ${trace.join(" -> ")}`,
    );
  });

  it("never lets a statement's cost move back up", async () => {
    // An index cannot make the planner choose a worse plan than it already had,
    // so a higher reading is estimate wobble. Storing it would let the running
    // total climb above an earlier round's and make the search non-monotonic.
    const result = await greedySearch({
      candidates: [candidate("a", ["x"], { statements: [0, 1] })],
      currentCosts: [1000, 1000],
      weights: [1, 1],
      explainBudget: 100,
      minImprovement: 0.1,
      maxRecommendations: 1,
      // Statement 0 improves sharply; statement 1 comes back WORSE.
      evaluate: async () =>
        new Map([
          [0, 10],
          [1, 5000],
        ]),
    });
    assert.equal(result.accepted.length, 1);
    const accepted = result.accepted[0];
    assert.equal(accepted?.costAfter, 1010, "the regressed statement must keep its original 1000, not take 5000");
    assert.equal(accepted?.perStatement.has(1), false, "a statement that got worse was not helped by this index");
  });

  it("refunds the budget when a candidate could not be costed at all", async () => {
    // HypoPG declines shapes it cannot model, and evaluate returns null without
    // ever issuing an EXPLAIN. Charging for that overstates explains_used and
    // can report budget_exhausted on a search that never reached its cap.
    const result = await greedySearch({
      candidates: [candidate("a", ["x"], { statements: [0, 1, 2] })],
      currentCosts: [1000, 1000, 1000],
      weights: [1, 1, 1],
      explainBudget: 10,
      minImprovement: 0.1,
      maxRecommendations: 5,
      evaluate: async () => null,
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.explainsUsed, 0, "an un-costable candidate issues no EXPLAIN, so it must cost no budget");
    assert.equal(result.budgetExhausted, false);
  });

  it("weights a statement's cost by its call count", async () => {
    const result = await greedySearch({
      candidates: [candidate("t", ["a"], { statements: [0] })],
      currentCosts: [100],
      weights: [1000],
      explainBudget: 10,
      minImprovement: 0.5,
      maxRecommendations: 5,
      evaluate: async () => new Map([[0, 10]]),
    });
    assert.equal(result.accepted[0]?.costBefore, 100_000);
    assert.equal(result.accepted[0]?.costAfter, 10_000);
  });

  it("skips a candidate that touches no statement instead of spending budget on it", async () => {
    let called = false;
    const result = await greedySearch({
      candidates: [candidate("t", ["a"], { statements: [] })],
      currentCosts: [1000],
      weights: [1],
      explainBudget: 10,
      minImprovement: 0.1,
      maxRecommendations: 5,
      evaluate: async (c, i) => {
        called = true;
        return alwaysHelps(c, i);
      },
    });
    assert.equal(called, false);
    assert.equal(result.explainsUsed, 0);
  });

  it("only reports statements whose cost actually dropped", async () => {
    const result = await greedySearch({
      candidates: [candidate("t", ["a"], { statements: [0, 1] })],
      currentCosts: [1000, 1000],
      weights: [1, 1],
      explainBudget: 10,
      minImprovement: 0.1,
      maxRecommendations: 5,
      // Statement 1 is unchanged, so listing it would overstate the reach.
      evaluate: async () =>
        new Map([
          [0, 10],
          [1, 1000],
        ]),
    });
    assert.deepEqual([...(result.accepted[0]?.perStatement.keys() ?? [])], [0]);
  });
});

// ─── Handler tests against a stubbed server ───

interface StubStatement {
  sql: string;
  params: unknown[];
  /** SQLSTATE the stub refused or failed the statement with; absent when it ran. */
  code?: string;
  /** Whether a transaction was open when the statement was sent. */
  inTransaction: boolean;
}

/** A statement-timeout failure: the connection survives it, only the statement dies. */
const TIMEOUT = { message: "canceling statement due to statement timeout", code: "57014" };

interface StubOptions {
  versionNum?: number;
  hypopgInstalled?: boolean;
  /** Total Cost the baseline EXPLAIN reports, before any hypothetical index. */
  baselineCost?: number;
  /** Total Cost reported while a hypothetical index exists. */
  indexedCost?: number;
  /** Make every EXPLAIN throw, to drive the tool down its failure path. */
  failExplain?: boolean;
  /** Make only the EXPLAINs whose statement contains this text throw. */
  failExplainContaining?: string;
  /** Make BEGIN throw, as a connection already in an aborted transaction would. */
  failBegin?: boolean;
  /** Make the teardown savepoint (taken right after BEGIN) time out. */
  failTeardownSavepoint?: boolean;
  /**
   * Make the N-th `SAVEPOINT __pgmcp_advisor_sp` (1-based) time out. A cancel
   * landing on the savepoint statement itself, rather than on the statement it
   * protects, aborts the transaction with nothing to roll back to.
   */
  failInnerSavepointAt?: number;
  /** Make the N-th `RELEASE SAVEPOINT __pgmcp_advisor_sp` (1-based) time out. */
  failInnerReleaseAt?: number;
  /** Make the N-th `ROLLBACK TO SAVEPOINT __pgmcp_advisor_sp` (1-based) time out. */
  failInnerRollbackToAt?: number;
  /**
   * Kill the connection right after the N-th successful hypopg_drop_index
   * (1-based). The death lands BETWEEN statements: the next one is the first
   * to fail.
   */
  dieAfterDrops?: number;
  /**
   * Kill the connection DURING the N-th statement (1-based) whose SQL contains
   * `containing`: that statement itself fails, the way a query in flight when
   * the backend goes away does.
   */
  dieDuring?: { containing: string; ordinal: number };
  /** The plan's Filter. The default names two columns; one column yields a single candidate. */
  planFilter?: string;
  /** Make the FIRST hypopg_create_index refuse the index, as HypoPG does for a shape it cannot model. */
  declineCreateOnce?: boolean;
  /**
   * Make the FIRST hypopg_reset fail: `missing` is 42883, what a HypoPG installed
   * off the search_path produces; `timeout` is a 57014 like any other statement.
   */
  failEntryReset?: "missing" | "timeout";
  /** Make the pg_attribute / pg_stats column read time out. */
  failColumnCatalog?: boolean;
  /** Make the existing-index catalog read time out. */
  failIndexCatalog?: boolean;
  /** Make hypopg_drop_index time out, aborting the transaction with the candidate's index live. */
  failDropIndex?: boolean;
  /** Make hypopg_relation_size time out. */
  failSizing?: boolean;
  /**
   * Make the hypopg_reset after the entry one time out: `always` fails the
   * retry too, `once` lets the retry through.
   */
  failTeardownReset?: "once" | "always";
  /** Make the plain ROLLBACK time out, leaving the transaction open. */
  failTeardownRollback?: boolean;
  /**
   * Which `ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown` statements time out,
   * by 1-based ordinal. A refusal here leaves the transaction aborted with the
   * hypothetical indexes still in place, exactly like a refused reset.
   */
  failTeardownRollbackToAt?: number[];
  /** Refuse `pg_terminate_backend(pg_backend_pid())` with 42501, as a role that may not signal the backend would. */
  refuseTerminate?: boolean;
  /** Columns pg_attribute reports for public.users. */
  columns?: string[];
}

interface StubSession {
  statements: StubStatement[];
  /** SQL texts seen, for order-sensitive assertions. */
  texts(): string[];
  /** Statements containing `fragment` that the server RAN. A refused statement (25P02 and friends) does not count. */
  count(fragment: string): number;
  /** Statements containing `fragment` that were sent, whether or not the server ran them. */
  sent(fragment: string): number;
  /** Hypothetical indexes still alive on the session -- what the next borrower inherits. */
  liveHypoIndexes(): number;
  /** Savepoints still standing; anything above 0 at the end of a call is a leak. */
  savepointDepth(): number;
  /**
   * The most savepoints standing at once. The advisor takes one for the
   * teardown and one around each isolated statement, so anything above 2 means
   * a per-statement savepoint outlived its statement.
   */
  maxSavepointDepth(): number;
  /**
   * Statement failures with no per-statement savepoint standing above the
   * teardown one. Each of these aborted the WHOLE transaction rather than one
   * isolated statement.
   */
  unisolatedFailures(): number;
  inTransaction(): boolean;
  /** The argument of each client.release() call; an Error there makes pg-pool destroy the client. */
  releases: unknown[];
  /** Everything the server wrote to stderr via console.error during the call. */
  stderr: string[];
}

/**
 * Runs `fn` against a fake postgres.
 *
 * Both `pg.Pool.prototype.query` (getServerVersionNum and runInternal) and
 * `pg.Pool.prototype.connect` (withSharedClient) are stubbed. Leaving either
 * alone sends real traffic at the fake host and hangs the suite on a connect
 * timeout -- the same mechanism the pg_explain suite uses.
 *
 * shutdown() runs on the way IN and OUT because api.ts caches the pool and
 * `serverVersionNum` at module scope; without the reset one case's version
 * leaks into the next and the version-gated cases become order-dependent.
 */
async function withStubbedServer<T>(options: StubOptions, fn: (session: StubSession) => Promise<T>): Promise<T> {
  const {
    versionNum = 180_000,
    hypopgInstalled = true,
    baselineCost = 1000,
    indexedCost = 10,
    failExplain = false,
    failExplainContaining,
    failBegin = false,
    failTeardownSavepoint = false,
    failInnerSavepointAt,
    failInnerReleaseAt,
    failInnerRollbackToAt,
    dieAfterDrops,
    dieDuring,
    planFilter = "((status = 'active'::text) AND (created_at > '2024-01-01'::date))",
    declineCreateOnce = false,
    failEntryReset,
    failColumnCatalog = false,
    failIndexCatalog = false,
    failDropIndex = false,
    failSizing = false,
    failTeardownReset,
    failTeardownRollback = false,
    failTeardownRollbackToAt = [],
    refuseTerminate = false,
    columns = ["id", "status", "created_at"],
  } = options;

  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;

  const statements: StubStatement[] = [];
  const releases: unknown[] = [];
  const stderr: string[] = [];
  const session: StubSession = {
    stderr,
    statements,
    texts: () => statements.map((s) => s.sql),
    count: (fragment) => statements.filter((s) => s.code === undefined && s.sql.includes(fragment)).length,
    sent: (fragment) => statements.filter((s) => s.sql.includes(fragment)).length,
    liveHypoIndexes: () => liveHypoIndexes,
    savepointDepth: () => savepoints.length,
    maxSavepointDepth: () => maxSavepointDepth,
    unisolatedFailures: () => unisolatedFailures,
    inTransaction: () => inTransaction,
    releases,
  };
  let maxSavepointDepth = 0;
  let unisolatedFailures = 0;

  // Hypothetical indexes are session state in the real server too, so the stub
  // models them as a counter rather than a boolean: the advisor creates and
  // drops them around each candidate, and a plan must only get cheaper while at
  // least one is live. Like the real server, ROLLBACK leaves them alone.
  let liveHypoIndexes = 0;
  let resetCalls = 0;

  // Transaction state, modelled because the teardown's correctness depends on
  // it. A statement that fails inside a transaction ABORTS it, and from then on
  // Postgres refuses everything except ROLLBACK / ROLLBACK TO SAVEPOINT with
  // SQLSTATE 25P02. Savepoints are a named stack: ROLLBACK TO keeps the named
  // one and drops everything above it, RELEASE drops it and everything above
  // it, and a name that is not on the stack is 3B001. All of this was checked
  // against PostgreSQL 15 and 18 before it was written down here. Without it,
  // a stub accepts statements the real server would refuse, and a teardown
  // that leaks on a live database passes here.
  let inTransaction = false;
  let aborted = false;
  const savepoints: string[] = [];
  let innerSavepoints = 0;
  let innerReleases = 0;
  let innerRollbackTos = 0;
  let teardownRollbackTos = 0;
  let drops = 0;
  let creates = 0;
  let dead = false;
  const dieDuringSeen = { count: 0 };

  // A dead socket, the way node-pg presents one: the statement in flight fails
  // with "Connection terminated unexpectedly", every later one with "Client has
  // encountered a connection error and is not queryable", neither carries a
  // SQLSTATE -- and the client EMITS 'error' from the socket callback, which is
  // what an unlistened checked-out client turns into an uncaught exception.
  const killSocket = (): void => {
    dead = true;
    // node-pg emits synchronously from the socket callback and delivers the
    // query's rejection on the next tick, so the emit lands BEFORE the caller
    // sees the failure. A microtask reproduces that order, and a throw from
    // it (no listener) is an uncaught exception, as it is in production.
    queueMicrotask(() => client.emitError(new Error("Connection terminated unexpectedly")));
  };
  const deadError = (inFlight: boolean) =>
    new Error(
      inFlight
        ? "Connection terminated unexpectedly"
        : "Client has encountered a connection error and is not queryable",
    );

  const planFor = (cost: number) => [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "users",
        Schema: "public",
        Alias: "users",
        "Total Cost": cost,
        // The default names two filtered columns, so buildCandidates yields two
        // candidates, `(status)` and `(status, created_at)`. The stub prices
        // every plan the same once any hypothetical index is live, so the first
        // accepted candidate leaves the second no improvement to claim and the
        // search still recommends exactly one index -- but a second candidate
        // is what makes "the search stopped sending" observable.
        Filter: planFilter,
      },
    },
  ];

  const pgError = (message: string, code: string) => Object.assign(new Error(message), { code });
  const timeout = () => pgError(TIMEOUT.message, TIMEOUT.code);
  const abortedError = () =>
    pgError("current transaction is aborted, commands ignored until end of transaction block", "25P02");
  const noTransaction = (verb: string) => pgError(`${verb} can only be used in transaction blocks`, "25P01");
  const noSavepoint = (name: string) => pgError(`savepoint "${name}" does not exist`, "3B001");
  const ok = (command: string, rows: Record<string, unknown>[] = []) => ({
    rows,
    fields: [],
    command,
    rowCount: rows.length,
  });

  const respond = (sql: string, extended: boolean) => {
    if (dead) throw deadError(false);
    if (dieDuring && sql.includes(dieDuring.containing) && ++dieDuringSeen.count === dieDuring.ordinal) {
      killSocket();
      throw deadError(true);
    }
    if (sql.includes("pg_terminate_backend(pg_backend_pid())")) {
      // What the server does with it, measured on PG15 and PG18: answers the
      // statement with 57P01 and closes the socket. It is an ordinary function
      // call, so it runs in or out of a transaction -- which is why the tests
      // assert it is sent INSIDE one -- and is refused like anything else in
      // an aborted transaction.
      if (aborted) throw abortedError();
      if (refuseTerminate) throw pgError("permission denied to terminate process", "42501");
      killSocket();
      throw pgError("terminating connection due to administrator command", "57P01");
    }
    if (sql.startsWith("BEGIN")) {
      if (failBegin) throw abortedError();
      if (aborted) throw abortedError();
      // Inside a healthy transaction BEGIN is only a WARNING (25001).
      inTransaction = true;
      return ok("BEGIN");
    }
    if (sql === "ROLLBACK") {
      // Outside a transaction this is only a WARNING (25P01), never an error.
      if (failTeardownRollback) throw timeout();
      inTransaction = false;
      aborted = false;
      savepoints.length = 0;
      return ok("ROLLBACK");
    }
    const savepointVerb = sql.match(/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) (\S+)$/);
    if (savepointVerb) {
      const [, verb, name] = savepointVerb as [string, string, string];
      if (!inTransaction) throw noTransaction(verb);
      if (verb === "ROLLBACK TO SAVEPOINT") {
        if (name === "__pgmcp_advisor_sp" && ++innerRollbackTos === failInnerRollbackToAt) throw timeout();
        if (name === "__pgmcp_advisor_teardown" && failTeardownRollbackToAt.includes(++teardownRollbackTos)) {
          throw timeout();
        }
        const at = savepoints.lastIndexOf(name);
        if (at < 0) throw noSavepoint(name);
        savepoints.length = at + 1;
        aborted = false;
        return ok("ROLLBACK");
      }
      if (aborted) throw abortedError();
      if (verb === "SAVEPOINT") {
        if (failTeardownSavepoint && name === "__pgmcp_advisor_teardown") throw timeout();
        if (name === "__pgmcp_advisor_sp" && ++innerSavepoints === failInnerSavepointAt) throw timeout();
        savepoints.push(name);
        maxSavepointDepth = Math.max(maxSavepointDepth, savepoints.length);
        return ok("SAVEPOINT");
      }
      if (name === "__pgmcp_advisor_sp" && ++innerReleases === failInnerReleaseAt) throw timeout();
      const at = savepoints.lastIndexOf(name);
      if (at < 0) throw noSavepoint(name);
      savepoints.length = at;
      return ok("RELEASE");
    }
    if (aborted) throw abortedError();
    if (sql.startsWith("EXPLAIN")) {
      if (failExplain) throw new Error('relation "users" does not exist');
      if (failExplainContaining !== undefined && sql.includes(failExplainContaining)) {
        throw new Error('relation "users" does not exist');
      }
      // The stacked-query guard sends a placeholder statement on the extended
      // protocol with no values bound; postgres answers with a bind-count
      // mismatch, which the guard reads as "single statement, plan it with
      // GENERIC_PLAN instead". A pg_stat_statements workload is parameterized
      // by construction, so this is the shape the baseline pass usually sees.
      if (extended && /\$\d/.test(sql)) {
        throw pgError('bind message supplies 0 parameters, but prepared statement "" requires 1', "08P01");
      }
      const cost = liveHypoIndexes > 0 ? indexedCost : baselineCost;
      return ok("EXPLAIN", [{ "QUERY PLAN": planFor(cost) }]);
    }
    if (sql.includes("hypopg_create_index")) {
      if (declineCreateOnce && ++creates === 1) throw pgError("hypopg: unsupported access method", "0A000");
      liveHypoIndexes += 1;
      return ok("SELECT", [{ indexrelid: 12_345 }]);
    }
    if (sql.includes("hypopg_drop_index")) {
      if (failDropIndex) throw timeout();
      liveHypoIndexes = Math.max(0, liveHypoIndexes - 1);
      if (++drops === dieAfterDrops) killSocket();
      return ok("SELECT", [{ hypopg_drop_index: true }]);
    }
    if (sql.includes("hypopg_reset")) {
      resetCalls += 1;
      if (failEntryReset === "missing" && resetCalls === 1) {
        throw pgError("function hypopg_reset() does not exist", "42883");
      }
      if (failEntryReset === "timeout" && resetCalls === 1) throw timeout();
      if (failTeardownReset === "always" && resetCalls > 1) throw timeout();
      if (failTeardownReset === "once" && resetCalls === 2) throw timeout();
      liveHypoIndexes = 0;
      return ok("SELECT");
    }
    if (sql.includes("hypopg_relation_size")) {
      if (failSizing) throw timeout();
      return ok("SELECT", [{ bytes: "16384" }]);
    }
    // Matched before the pg_attribute branch: the index query also joins
    // pg_attribute, so a looser check would swallow it.
    if (sql.includes("FROM pg_catalog.pg_index")) {
      if (failIndexCatalog) throw timeout();
      return ok("SELECT");
    }
    if (sql.includes("LEFT JOIN pg_catalog.pg_stats")) {
      if (failColumnCatalog) throw timeout();
      const rows = columns.map((column) => ({
        schema: "public",
        table: "users",
        column,
        n_distinct: column === "status" ? -0.01 : -1,
        reltuples: 10_000,
      }));
      return { rows, fields: [], command: "SELECT", rowCount: rows.length };
    }
    // `fields: []` matters: safeResolveTypeNames short-circuits on an empty
    // oid list, so the stub never has to fake pg_catalog.pg_type.
    return { rows: [], fields: [], command: "", rowCount: 0 };
  };

  const client = {
    async query(config: unknown, params: unknown[] = []) {
      const sql = typeof config === "string" ? config : ((config as { text?: string }).text ?? "");
      const values = typeof config === "string" ? params : ((config as { values?: unknown[] }).values ?? params);
      const record: StubStatement = { sql, params: values, inTransaction };
      statements.push(record);
      const extended = typeof config !== "string" && (config as { queryMode?: string }).queryMode === "extended";
      try {
        return respond(sql, extended);
      } catch (err) {
        // A dead socket has no SQLSTATE; the stub records it as "" so the
        // statement still counts as not run.
        record.code = (err as { code?: string }).code ?? (dead ? "" : "XX000");
        // Any error inside a transaction block aborts it -- a statement that
        // fails outside one (25P01) aborts nothing. A statement refused BECAUSE
        // the transaction is already aborted is not a new failure, and nothing
        // reaches a dead server at all.
        if (inTransaction && !aborted && !dead && savepoints.length <= 1) unisolatedFailures += 1;
        if (inTransaction) aborted = true;
        throw err;
      }
    },
    release(err?: unknown) {
      releases.push(err);
    },
    // acquireClient() attaches an 'error' listener for the checked-out lifetime.
    // The real client EMITS 'error' when its socket dies, and with no listener
    // that emit throws out of the socket callback as an uncaught exception --
    // the stub does the same, so the listener is load-bearing here too.
    listeners: [] as ((err: Error) => void)[],
    on(event: string, fn: (err: Error) => void) {
      if (event === "error") this.listeners.push(fn);
      return this;
    },
    removeListener(event: string, fn: (err: Error) => void) {
      if (event === "error") this.listeners = this.listeners.filter((l) => l !== fn);
      return this;
    },
    emitError(err: Error) {
      if (this.listeners.length === 0) throw err;
      for (const l of this.listeners) l(err);
    },
  };

  await shutdown();
  process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown, params: unknown[] = []) {
    const text = typeof sql === "string" ? sql : "";
    statements.push({ sql: text, params, inTransaction: false });
    if (text.includes("server_version_num")) return Promise.resolve({ rows: [{ v: String(versionNum) }] });
    if (text.includes("extname = 'hypopg'")) return Promise.resolve({ rows: [{ installed: hypopgInstalled }] });
    if (text.includes("extname = 'pg_stat_statements'")) return Promise.resolve({ rows: [{ version: "1.10" }] });
    if (text.includes("pg_stat_user_tables")) {
      return Promise.resolve({ rows: [{ schema: "public", table: "users", seq_scan: "500" }] });
    }
    return Promise.resolve({ rows: [] });
  } as unknown as typeof pg.Pool.prototype.query;
  pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
    return Promise.resolve(client);
  } as unknown as typeof pg.Pool.prototype.connect;
  // Captured rather than printed: a discarded connection and a socket death
  // both log, and the tests assert on those lines instead of reading them in
  // the runner output.
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };

  try {
    return await fn(session);
  } finally {
    console.error = originalError;
    pg.Pool.prototype.connect = originalConnect;
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  }
}

describe("pg_index_advisor input guards", () => {
  it("rejects an explicitly empty statements array with an actionable message", async () => {
    const result = (await pgIndexAdvisor.handler({ statements: [] })) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /omit `statements`/);
  });
});

describe("pg_index_advisor HypoPG requirement", () => {
  it("fails with the same actionable install guidance pg_explain uses", async () => {
    await withStubbedServer({ hypopgInstalled: false }, async (session) => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
      })) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /HypoPG extension/);
      assert.match(result.error ?? "", /CREATE EXTENSION hypopg;/);
      // The probe must fire BEFORE a connection is taken: without HypoPG every
      // later step is wasted work ending in this same error.
      assert.equal(session.count("BEGIN READ ONLY"), 0);
    });
  });
});

const ONE_STATEMENT = ["SELECT * FROM users WHERE status = 'active'"];

/**
 * What every call must leave behind when the teardown succeeded: nothing.
 *
 * `savepointBookkeepingFailed` is for the paths where the statement that timed
 * out IS a RELEASE or ROLLBACK TO: the savepoint it should have retired stays
 * standing until the teardown rolls back over it, so the per-statement balance
 * cannot be exact there. Everything else must still hold.
 */
function assertSessionClean(session: StubSession, options: { savepointBookkeepingFailed?: boolean } = {}): void {
  assert.equal(session.liveHypoIndexes(), 0, "hypothetical indexes survived the teardown");
  assert.equal(session.savepointDepth(), 0, "a savepoint leaked");
  // The teardown savepoint plus one per isolated statement. The final ROLLBACK
  // discards a leaked savepoint too, so the depth at the END cannot see a
  // per-statement savepoint that was never released; the peak can.
  assert.ok(session.maxSavepointDepth() <= 2, `savepoints stacked ${session.maxSavepointDepth()} deep`);
  // The peak cannot see a leak from the LAST isolated statement of a call, so
  // the per-statement savepoint is also checked for balance directly: every
  // one the server took, it later released. `startsWith`, because the
  // ROLLBACK TO and RELEASE forms contain the SAVEPOINT text too.
  const ran = session.statements.filter((s) => s.code === undefined);
  const taken = ran.filter((s) => s.sql.startsWith("SAVEPOINT __pgmcp_advisor_sp")).length;
  const released = ran.filter((s) => s.sql.startsWith("RELEASE SAVEPOINT __pgmcp_advisor_sp")).length;
  if (options.savepointBookkeepingFailed) {
    assert.equal(taken - released, 1, "exactly the savepoint whose bookkeeping failed should be unreleased");
  } else {
    assert.equal(taken, released, "a per-statement savepoint was taken and never released");
  }
  assert.equal(session.inTransaction(), false, "the transaction was left open");
  // Exactly one plain ROLLBACK ran. Matched exactly: a `ROLLBACK TO SAVEPOINT`
  // contains the word too and must not satisfy this.
  assert.equal(session.statements.filter((s) => s.sql === "ROLLBACK" && s.code === undefined).length, 1);
  // A clean teardown hands the connection back for reuse. Destroying it would
  // also contain a leak, so this is what tells a fix from a cover-up.
  assert.deepEqual(session.releases, [undefined]);
}

describe("pg_index_advisor HypoPG session hygiene", () => {
  it("resets hypothetical indexes on the way in AND out of a successful call, inside the transaction", async () => {
    await withStubbedServer({}, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as { ok: boolean };
      assert.equal(result.ok, true);
      // Once on entry (a previous call's teardown may have failed) and once in
      // the finally. HypoPG indexes are SESSION-scoped, so the transaction's
      // ROLLBACK does not remove them and this connection goes back to the pool.
      assert.ok(session.count("hypopg_reset") >= 2, `saw ${session.count("hypopg_reset")} resets`);
      // The reset must be the LAST hypopg statement, or an index outlives the call.
      const hypoCalls = session.statements.filter((s) => s.sql.includes("hypopg"));
      const last = hypoCalls.at(-1);
      assert.match(last?.sql ?? "", /hypopg_reset/);
      // ... and it must run INSIDE the transaction. Behind a transaction-mode
      // pooler the backend is pinned only until the transaction ends, so a reset
      // sent after the ROLLBACK can reach a different backend than the one
      // holding the indexes, and report success.
      assert.equal(last?.inTransaction, true, "the teardown reset ran after the ROLLBACK");
      assertSessionClean(session);
    });
  });

  it("still tears down when no statement could be planned", async () => {
    // The early `return` path: a guard inside the try would skip a trailing
    // cleanup statement, which is exactly why the teardown lives in a `finally`.
    await withStubbedServer({ failExplain: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could be planned/);
      assert.ok(session.count("hypopg_reset") >= 2, "the teardown reset did not run on the failure path");
      assertSessionClean(session);
    });
  });

  it("recovers an aborted transaction before resetting, so stranded indexes are still cleared", async () => {
    // hypopg_drop_index runs outside any savepoint with the candidate's index
    // live. When it fails the transaction is aborted, and a reset sent into an
    // aborted transaction is refused with 25P02 -- measured on PG15 and PG18
    // with HypoPG. The indexes would then ride the pooled connection into the
    // next pg_explain or pg_readonly call.
    await withStubbedServer({ failDropIndex: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.equal(session.count("ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown"), 1);
      assertSessionClean(session);
    });
  });

  it("reports a search that stopped because a candidate could not be dropped, instead of a partial result", async () => {
    await withStubbedServer({ failDropIndex: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could not be dropped/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      // Once the transaction is gone, nothing more is sent into it: the very
      // next statement after the failed drop is the teardown's rollback. The
      // stub's plan yields a second candidate, so a search that kept going
      // would send its SAVEPOINT (refused, 25P02) here first.
      // Precondition, or the adjacency check below would pass vacuously: the
      // clean run creates for two candidates (each measured, one kept).
      assert.ok(session.sent("hypopg_create_index") === 1, "the failing run itself sends exactly one create");
      const failedDrop = session.statements.findIndex(
        (s) => s.sql.includes("hypopg_drop_index") && s.code !== undefined,
      );
      assert.ok(failedDrop >= 0, "precondition: a hypopg_drop_index failed");
      assert.equal(session.statements[failedDrop + 1]?.sql, "ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown");
    });
  });

  it("reports a connection that died between statements instead of a search that converged on nothing", async () => {
    // The socket dies after the first candidate is measured and dropped. Every
    // later statement fails, including each SAVEPOINT -- and a failed SAVEPOINT
    // is not a soft "skip this candidate": it means the transaction is gone.
    await withStubbedServer({ dieAfterDrops: 1 }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could no longer be used/);
      assert.match(result.error ?? "", /not queryable/);
      // Nothing can be cleaned up on a dead socket, so the connection is
      // destroyed rather than pooled, and both events reach stderr.
      assert.ok(session.releases[0] instanceof Error);
      assert.ok(session.stderr.some((l) => /connection error on a checked-out client: Connection terminated/.test(l)));
      assert.ok(session.stderr.some((l) => /discarding pooled connection/.test(l)));
    });
  });

  it("reports a connection that died DURING the only candidate's create, where no later savepoint exists", async () => {
    // The payload dies, so does the ROLLBACK TO after it, and nothing else is
    // sent before the post-search check. Only reporting the failed ROLLBACK TO
    // at the moment it happens turns this into an error; "the next SAVEPOINT
    // will report it" has no next savepoint here. Measured to return ok:true
    // with an empty list before that report existed.
    const singleCandidate = "(status = 'active'::text)";
    await withStubbedServer(
      { planFilter: singleCandidate, dieDuring: { containing: "hypopg_create_index", ordinal: 1 } },
      async (session) => {
        const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
          ok: boolean;
          error?: string;
        };
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /could no longer be used/);
        assert.match(result.error ?? "", /Connection terminated/);
        assert.ok(session.releases[0] instanceof Error);
      },
    );
  });

  it("reports a connection that died during the final round's evaluate as a lost search, not a sizing loss", async () => {
    // Two candidates: round 1 accepts (status); round 2 re-costs
    // (status, created_at) on top of it, and the socket dies during that
    // create. The search did not finish, so the accepted list is where it
    // stopped, not its answer.
    const creates = await withStubbedServer({}, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      return session.count("hypopg_create_index");
    });
    assert.ok(creates >= 3, `expected the two-candidate search to create several times, saw ${creates}`);
    await withStubbedServer({ dieDuring: { containing: "hypopg_create_index", ordinal: creates } }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
        data?: { _warnings?: string[] };
      };
      assert.equal(result.ok, false, "a truncated search was presented as converged");
      assert.match(result.error ?? "", /could no longer be used/);
      assert.ok(session.releases[0] instanceof Error);
    });
  });

  it("keeps a finished search when the connection dies during the last sizing query, and says the sizes are missing", async () => {
    await withStubbedServer({ dieDuring: { containing: "hypopg_relation_size", ordinal: 1 } }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        data?: { recommendations: { estimated_size_bytes: string | null }[]; _warnings?: string[] };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data?.recommendations.length, 1);
      assert.equal(result.data?.recommendations[0]?.estimated_size_bytes, null);
      assert.ok(result.data?._warnings?.some((w) => /lost while sizing/.test(w) && /Connection terminated/.test(w)));
      assert.ok(session.releases[0] instanceof Error);
    });
  });

  it("names a cancel that landed on a RELEASE as the cause, never the refusal of the statement after it", async () => {
    // A 57014 on the RELEASE after a successful EXPLAIN aborts the transaction.
    // Unreported, the next statement -- the unisolated drop -- is refused with
    // 25P02 and the error would blame HypoPG. Every RELEASE the call sends
    // before the sizing one is swept; the sizing one is the exception: its
    // statement already ran, so the size is kept and the loss is a warning.
    const releases = await withStubbedServer({}, async (session) => {
      const all = session.statements
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.sql === "RELEASE SAVEPOINT __pgmcp_advisor_sp");
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      const after = session.statements
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.sql === "RELEASE SAVEPOINT __pgmcp_advisor_sp");
      const last = after.at(-1);
      assert.ok(last && all.length === 0);
      assert.match(session.statements[last.i - 1]?.sql ?? "", /hypopg_relation_size/);
      return after.length;
    });
    assert.ok(releases >= 5, `expected several releases, saw ${releases}`);

    for (let at = 1; at < releases; at++) {
      await withStubbedServer({ failInnerReleaseAt: at }, async (session) => {
        const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
          ok: boolean;
          error?: string;
        };
        assert.equal(result.ok, false, `release #${at}: the call reported success after the transaction was lost`);
        assert.match(result.error ?? "", /could no longer be used/, `release #${at}`);
        assert.match(result.error ?? "", new RegExp(TIMEOUT.message), `release #${at}: the cancel is not named`);
        assert.doesNotMatch(result.error ?? "", /could not be dropped/, `release #${at}: blamed the drop`);
        assertSessionClean(session, { savepointBookkeepingFailed: true });
      });
    }

    await withStubbedServer({ failInnerReleaseAt: releases }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        data?: { recommendations: { estimated_size_bytes: string | null }[]; _warnings?: string[] };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data?.recommendations[0]?.estimated_size_bytes, "16384", "a size that was read was dropped");
      assert.ok(
        result.data?._warnings?.some((w) => /lost while sizing/.test(w) && new RegExp(TIMEOUT.message).test(w)),
      );
      assertSessionClean(session, { savepointBookkeepingFailed: true });
    });
  });

  it("names a cancel that landed on a ROLLBACK TO, and what it was recovering from", async () => {
    const failing = "SELECT * FROM users WHERE status = 'gone'";
    await withStubbedServer({ failExplainContaining: "'gone'", failInnerRollbackToAt: 1 }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: [failing, ...ONE_STATEMENT] })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could no longer be used/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assert.match(result.error ?? "", /while recovering from: relation "users" does not exist/);
      assertSessionClean(session, { savepointBookkeepingFailed: true });
    });
  });

  it("reports a loss on a parameterized statement's plan, the shape a pg_stat_statements workload has", async () => {
    // The stacked-query guard's probe answers 08P01 for a placeholder statement,
    // so the plan comes from a second, GENERIC_PLAN EXPLAIN behind its own
    // savepoint -- the second inner savepoint of the call. A cancel there must
    // be reported like any other, not read as "could not plan this statement".
    await withStubbedServer({ failInnerSavepointAt: 2 }, async (session) => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = $1"],
      })) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could no longer be used/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assert.ok(
        session.statements.some((s) => s.code === "08P01"),
        "precondition: the guard probe answered 08P01",
      );
      assertSessionClean(session);
    });
  });

  it("stops planning the baseline once the transaction is lost", async () => {
    // Three statements, the second one's guard savepoint is refused: the third
    // statement's savepoint would only be refused too.
    await withStubbedServer({ failInnerSavepointAt: 2 }, async (session) => {
      const result = (await pgIndexAdvisor.handler({
        statements: [...ONE_STATEMENT, ...ONE_STATEMENT, ...ONE_STATEMENT],
      })) as { ok: boolean };
      assert.equal(result.ok, false);
      // Exact match: `sent()` is a substring match and would count the RELEASE too.
      assert.equal(
        session.statements.filter((st) => st.sql === "SAVEPOINT __pgmcp_advisor_sp").length,
        2,
        "the third statement was still planned",
      );
    });
  });

  it("says which read failed when the column catalog read fails", async () => {
    await withStubbedServer({ failColumnCatalog: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could not read the columns of the tables the workload scans/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assertSessionClean(session);
    });
  });

  it("names a cancel that landed on the RELEASE after a failed statement was rolled back", async () => {
    // The failure path's RELEASE: the statement failed, ROLLBACK TO succeeded,
    // and the cancel lands on the RELEASE that retires the savepoint.
    const failing = "SELECT * FROM users WHERE status = 'gone'";
    await withStubbedServer({ failExplainContaining: "'gone'", failInnerReleaseAt: 1 }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: [failing, ...ONE_STATEMENT] })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could no longer be used/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assertSessionClean(session, { savepointBookkeepingFailed: true });
    });
  });

  it("says which candidates HypoPG refused to create, and why, instead of dropping them silently", async () => {
    // The first create is refused; the second candidate is created, measured
    // and accepted. Without the warning the refused candidate is
    // indistinguishable from one that did not help.
    await withStubbedServer({ declineCreateOnce: true }, async () => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        data?: { recommendations: { columns: string[] }[]; _warnings?: string[] };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data?.recommendations.length, 1);
      const warning = result.data?._warnings?.find((w) =>
        /could not be costed because hypopg_create_index refused/.test(w),
      );
      assert.ok(warning, `no refusal warning in ${JSON.stringify(result.data?._warnings)}`);
      assert.match(warning, /public\.users \(status\)/);
      assert.match(warning, /unsupported access method/);
    });
  });

  it("reports a cancel that landed on any savepoint statement before sizing as a lost transaction", async () => {
    // A cancel on the SAVEPOINT itself, rather than on the statement it
    // protects, aborts the transaction with nothing to roll back to. Every
    // isolated statement the call sends is swept, so this does not depend on
    // which ordinal happens to be onAccept's or a candidate's: for each one
    // before the sizing query, the call must end as an error -- never as a
    // converged search with an empty list or a misattributed "could not keep"
    // warning. The ordinals come from a clean run rather than from counting.
    const ordinals = await withStubbedServer({}, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      const savepoints = session.statements
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.sql === "SAVEPOINT __pgmcp_advisor_sp");
      // The last per-statement savepoint is the sizing query's -- asserted, so
      // the sweep below cannot silently drift onto a different statement.
      const last = savepoints.at(-1);
      assert.ok(last, "no per-statement savepoint was sent");
      assert.match(session.statements[last.i + 1]?.sql ?? "", /hypopg_relation_size/);
      return savepoints.length;
    });
    assert.ok(ordinals >= 5, `expected the search to take several savepoints, saw ${ordinals}`);

    for (let at = 1; at < ordinals; at++) {
      await withStubbedServer({ failInnerSavepointAt: at }, async (session) => {
        const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
          ok: boolean;
          error?: string;
        };
        assert.equal(result.ok, false, `savepoint #${at}: the call reported success after the transaction was lost`);
        assert.match(result.error ?? "", /could no longer be used/, `savepoint #${at}`);
        assert.match(result.error ?? "", new RegExp(TIMEOUT.message), `savepoint #${at}`);
        assert.equal(session.sent("hypopg_relation_size"), 0, `savepoint #${at}: the call kept going`);
        assertSessionClean(session);
      });
    }

    // The sizing savepoint is the exception: the search is complete by then, so
    // its recommendations stand and only the size is lost, with a warning.
    await withStubbedServer({ failInnerSavepointAt: ordinals }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        data?: { recommendations: { estimated_size_bytes: string | null }[]; _warnings?: string[] };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data?.recommendations.length, 1);
      assert.equal(result.data?.recommendations[0]?.estimated_size_bytes, null);
      assert.ok(
        result.data?._warnings?.some((w) => /lost while sizing/.test(w) && new RegExp(TIMEOUT.message).test(w)),
      );
      assertSessionClean(session);
    });
  });

  it("names the loss when it happens while planning the baseline, before any other read fails on it", async () => {
    // Two statements: the second one's guard savepoint is refused. Without a
    // check at the end of the baseline pass, the next unisolated catalog read
    // fails with "current transaction is aborted" and THAT is what the caller
    // would see, not the cancel that caused it.
    await withStubbedServer({ failInnerSavepointAt: 2 }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: [...ONE_STATEMENT, ...ONE_STATEMENT] })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could no longer be used/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assertSessionClean(session);
    });
  });

  it("keeps the connection when the teardown savepoint itself cannot be taken", async () => {
    // Nothing was created and there is no savepoint to roll back to: the
    // teardown must not send a ROLLBACK TO (3B001) or a reset, and a healthy
    // connection must not be discarded over a cancel that hit the SAVEPOINT.
    await withStubbedServer({ failTeardownSavepoint: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assert.equal(session.sent("ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown"), 0);
      assert.equal(session.sent("hypopg_reset"), 0);
      assertSessionClean(session);
    });
  });

  it("isolates a failed sizing query so the rest of the call and the teardown are unaffected", async () => {
    await withStubbedServer({ failSizing: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        data?: { recommendations: { estimated_size_bytes: string | null }[] };
      };
      // Sizing is best-effort, so the recommendation still comes back, unsized.
      assert.equal(result.ok, true);
      assert.equal(result.data?.recommendations.length, 1);
      assert.equal(result.data?.recommendations[0]?.estimated_size_bytes, null);
      // A null size is only an honest "unknown" if the failure did not abort
      // the transaction the remaining sizes are read in.
      assert.equal(session.unisolatedFailures(), 0, "the sizing failure aborted the whole transaction");
      assertSessionClean(session);
    });
  });

  it("isolates a failed existing-index read: the search still runs, with the warning", async () => {
    await withStubbedServer({ failIndexCatalog: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        data?: { recommendations: unknown[]; _warnings?: string[] };
      };
      assert.equal(result.ok, true);
      assert.ok(result.data?._warnings?.some((w) => /existing indexes could not be read/.test(w)));
      // Without the savepoint the failure aborts the transaction, every
      // candidate then fails to create, and the call returns ok with NO
      // recommendations and only that warning -- a silent empty search.
      assert.equal(result.data?.recommendations.length, 1);
      assert.equal(session.unisolatedFailures(), 0, "the catalog read failure aborted the whole transaction");
      assertSessionClean(session);
    });
  });

  it("returns the entry reset's own error and keeps the connection", async () => {
    // The extension probe only reads pg_extension; a HypoPG installed in a
    // schema off the search_path passes it and fails here. Nothing could have
    // been created, so the connection is clean and the teardown does not try
    // the reset again.
    await withStubbedServer({ failEntryReset: "missing" }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /hypopg_reset\(\) does not exist/);
      // 42883 with the extension present means the role cannot see it: say so.
      assert.match(result.error ?? "", /search_path/);
      assert.equal(session.sent("hypopg_reset"), 1);
      assertSessionClean(session);
    });
    // Any other failure is reported as what it is, without the install hint.
    await withStubbedServer({ failEntryReset: "timeout" }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /hypopg_reset\(\) failed before the search started/);
      assert.match(result.error ?? "", new RegExp(TIMEOUT.message));
      assert.doesNotMatch(result.error ?? "", /search_path/);
      assert.equal(session.sent("hypopg_reset"), 1);
      assertSessionClean(session);
    });
  });

  it("retries a teardown reset a live server refused, and keeps the connection when the retry succeeds", async () => {
    // The refused reset aborted the transaction; the teardown savepoint
    // survives the first ROLLBACK TO, so a second one clears the abort and the
    // reset runs again, still pinned to the backend holding the indexes.
    await withStubbedServer({ failTeardownReset: "once" }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as { ok: boolean };
      assert.equal(result.ok, true);
      assert.equal(session.count("ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown"), 2);
      assert.equal(session.sent("hypopg_reset"), 3, "entry, the refused teardown reset, and its retry");
      assert.equal(session.sent("pg_terminate_backend"), 0, "a backend was terminated over a transient");
      assert.ok(
        session.stderr.some((l) => /succeeded on retry; the connection is kept/.test(l)),
        JSON.stringify(session.stderr),
      );
      assertSessionClean(session);
    });
  });

  it("terminates its own backend when the teardown reset fails twice on a live server, then discards", async () => {
    // Discarding the connection alone ends at a transaction-mode pooler; the
    // backend would keep the hypothetical indexes for its next client. Ending
    // the backend from inside the transaction is pinned to the right one.
    await withStubbedServer({ failTeardownReset: "always" }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as { ok: boolean };
      // Cleanup never replaces the call's own result.
      assert.equal(result.ok, true);
      const terminate = session.statements.find((s) => s.sql.includes("pg_terminate_backend(pg_backend_pid())"));
      assert.ok(terminate, "the backend was not terminated");
      assert.equal(terminate.inTransaction, true, "the terminate was sent after the transaction ended");
      assert.equal(terminate.code, "57P01", "the server's answer to a terminate is 57P01, and it must not be refused");
      assert.equal(session.sent("hypopg_reset"), 3, "the reset was not retried before terminating");
      assert.equal(
        session.statements.at(-1)?.sql,
        TERMINATE_OWN_BACKEND_SQL,
        "something was sent to a backend that is gone",
      );
      assert.equal(session.statements.filter((s) => s.sql === "ROLLBACK").length, 0);
      const released = session.releases[0];
      assert.ok(released instanceof Error, "a connection whose backend was ended went back to the pool");
      assert.match(released.message, /^pg_index_advisor teardown failed twice, backend terminated: /);
      assert.match(released.message, new RegExp(TIMEOUT.message));
      // The socket closing after a termination this process asked for is
      // reported as that, not as a surprise connection error.
      assert.ok(
        session.stderr.some((l) => /connection closed after this process terminated its own backend/.test(l)),
        JSON.stringify(session.stderr),
      );
      assert.ok(
        !session.stderr.some((l) => /connection error on a checked-out client/.test(l)),
        JSON.stringify(session.stderr),
      );
    });
  });

  it("neither retries nor terminates when the teardown reset failed because the socket died", async () => {
    // No SQLSTATE means no server answered: nothing to retry against, no
    // backend to end. The connection is discarded and that is all.
    await withStubbedServer({ dieDuring: { containing: "hypopg_reset", ordinal: 2 } }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as { ok: boolean };
      assert.equal(result.ok, true);
      assert.equal(session.sent("hypopg_reset"), 2, "a dead socket was retried");
      assert.equal(
        session.sent("ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown"),
        1,
        "a retry's ROLLBACK TO was sent into a dead socket",
      );
      assert.equal(session.sent("pg_terminate_backend"), 0, "a dead socket was 'terminated'");
      assert.ok(session.releases[0] instanceof Error);
    });
  });

  it("retries when the teardown ROLLBACK TO itself is refused, instead of rolling back over live indexes", async () => {
    // A timed-out drop leaves an index live; the first ROLLBACK TO the
    // teardown savepoint is then refused by a live server. Ending the
    // transaction with a plain ROLLBACK at that point would hand the backend
    // back -- to a transaction-mode pooler, to its next client -- with the
    // index still on it. The whole cleanup pass is retried instead.
    await withStubbedServer({ failDropIndex: true, failTeardownRollbackToAt: [1] }, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      assert.equal(session.liveHypoIndexes(), 0, "a hypothetical index survived the call");
      assert.equal(session.sent("ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown"), 2);
      assert.equal(session.sent("pg_terminate_backend"), 0, "a backend was terminated over a transient");
      assert.ok(
        session.stderr.some((l) => /cleanup failed \(.*statement timeout.*\) and succeeded on retry/.test(l)),
        JSON.stringify(session.stderr),
      );
      assertSessionClean(session);
    });
  });

  it("terminates when the teardown ROLLBACK TO is refused on both passes, never rolling back over live indexes", async () => {
    await withStubbedServer({ failDropIndex: true, failTeardownRollbackToAt: [1, 2] }, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      const terminate = session.statements.find((s) => s.sql === TERMINATE_OWN_BACKEND_SQL);
      assert.ok(terminate, "the backend was not terminated");
      assert.equal(terminate.inTransaction, true);
      assert.equal(terminate.code, "57P01");
      assert.equal(
        session.statements.filter((s) => s.sql === "ROLLBACK" && s.code === undefined).length,
        0,
        "a plain ROLLBACK handed the backend back with a live index",
      );
      const released = session.releases[0];
      assert.ok(released instanceof Error);
      assert.match(released.message, /^pg_index_advisor teardown failed twice, backend terminated: /);
    });
  });

  it("says the backend was NOT terminated when the transaction could not be cleared first, and does not send it", async () => {
    // The third ROLLBACK TO -- the one that clears the retry's abort so the
    // terminate can run -- is refused too. A terminate sent now would only be
    // refused with 25P02; it is not sent, and nothing claims it happened.
    await withStubbedServer({ failTeardownReset: "always", failTeardownRollbackToAt: [3] }, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      assert.equal(session.sent("pg_terminate_backend"), 0, "a terminate was sent into an aborted transaction");
      const released = session.releases[0];
      assert.ok(released instanceof Error);
      assert.doesNotMatch(released.message, /backend terminated/);
      assert.match(
        released.message,
        /the backend could not be terminated \(the transaction could not be cleared first/,
      );
      assert.ok(
        session.stderr.some((l) => /own backend NOT terminated/.test(l)),
        JSON.stringify(session.stderr),
      );
      assert.ok(!session.stderr.some((l) => /terminated own backend after/.test(l)), JSON.stringify(session.stderr));
    });
  });

  it("does not escalate when HypoPG was never usable, even if the teardown ROLLBACK TO is refused", async () => {
    // The entry reset failed (HypoPG not callable), so no index was created
    // and none can leak. A refused ROLLBACK TO in the teardown is then just a
    // failure to discard over: no retry, no terminate.
    await withStubbedServer({ failEntryReset: "missing", failTeardownRollbackToAt: [1] }, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      assert.equal(
        session.sent("ROLLBACK TO SAVEPOINT __pgmcp_advisor_teardown"),
        1,
        "a cleanup with nothing to clean was retried",
      );
      assert.equal(session.sent("pg_terminate_backend"), 0, "a clean backend was terminated");
      const released = session.releases[0];
      assert.ok(released instanceof Error);
      assert.match(released.message, /^pg_index_advisor teardown failed, connection discarded: /);
    });
  });

  it("says the backend was NOT terminated when the server refuses the terminate, and ends the transaction", async () => {
    await withStubbedServer({ failTeardownReset: "always", refuseTerminate: true }, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      const terminate = session.statements.find((s) => s.sql === TERMINATE_OWN_BACKEND_SQL);
      assert.equal(terminate?.code, "42501", "precondition: the terminate was sent and refused");
      assert.equal(session.statements.at(-1)?.sql, "ROLLBACK", "the transaction was left open on a live backend");
      const released = session.releases[0];
      assert.ok(released instanceof Error);
      assert.match(released.message, /the backend could not be terminated \(permission denied/);
      assert.doesNotMatch(released.message, /backend terminated/);
      assert.ok(
        session.stderr.some((l) => /own backend NOT terminated -- permission denied/.test(l)),
        JSON.stringify(session.stderr),
      );
    });
  });

  it("does not claim to have terminated a backend when the socket died during the retry", async () => {
    // A live server refused the first teardown reset; the socket dies during
    // the retry. There is no backend left to end, and the discard reason must
    // not say there was.
    await withStubbedServer(
      { failTeardownReset: "once", dieDuring: { containing: "hypopg_reset", ordinal: 3 } },
      async (session) => {
        const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as { ok: boolean };
        assert.equal(result.ok, true);
        assert.equal(session.sent("hypopg_reset"), 3, "the retry was not attempted");
        assert.equal(session.sent("pg_terminate_backend"), 0, "a dead socket was 'terminated'");
        const released = session.releases[0];
        assert.ok(released instanceof Error);
        assert.doesNotMatch(released.message, /backend terminated/);
        assert.match(released.message, new RegExp(TIMEOUT.message));
      },
    );
  });

  it("destroys the connection when the teardown ROLLBACK fails, naming that failure", async () => {
    await withStubbedServer({ failTeardownRollback: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as { ok: boolean };
      assert.equal(result.ok, true);
      assert.ok(
        session.statements.some((s) => s.sql === "ROLLBACK" && s.code === TIMEOUT.code),
        "precondition: a ROLLBACK was sent and timed out",
      );
      // The reset ran before the ROLLBACK that failed, so no index is live.
      assert.equal(session.liveHypoIndexes(), 0);
      assert.equal(session.releases.length, 1);
      const released = session.releases[0];
      assert.ok(released instanceof Error, "a connection left mid-transaction went back to the pool");
      assert.match(released.message, /teardown failed/);
      assert.match(released.message, new RegExp(TIMEOUT.message));
    });
  });

  it("destroys the connection when BEGIN is refused", async () => {
    // A live connection refuses BEGIN only from a state no pooled connection
    // should be in, such as an inherited aborted transaction.
    await withStubbedServer({ failBegin: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: ONE_STATEMENT })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /transaction is aborted/);
      assert.ok(session.releases[0] instanceof Error);
    });
  });

  it("drops only the candidate under test, never resetting mid-search", async () => {
    await withStubbedServer({}, async (session) => {
      await pgIndexAdvisor.handler({ statements: ONE_STATEMENT });
      // A hypopg_reset() inside the search would wipe previously accepted
      // indexes and silently degrade the greedy search to an independent
      // per-candidate ranking, so each candidate is retired with a targeted drop.
      assert.ok(session.count("hypopg_drop_index") >= 1);
    });
  });

  it("isolates a failing statement behind a savepoint so the next statement is still planned", async () => {
    const failing = "SELECT * FROM users WHERE status = 'gone'";
    await withStubbedServer({ failExplainContaining: "'gone'" }, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: [failing, ...ONE_STATEMENT] })) as {
        ok: boolean;
        data?: { statements: { planned: boolean }[]; recommendations: unknown[] };
      };
      // Without ROLLBACK TO, the aborted transaction takes every subsequent
      // statement down with SQLSTATE 25P02, and the second statement here would
      // never be planned.
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.data?.statements.map((s) => s.planned),
        [false, true],
      );
      assert.equal(result.data?.recommendations.length, 1);
      // ROLLBACK TO leaves the savepoint in place, so the RELEASE is still
      // required or one savepoint leaks per failed statement. `count` only
      // counts statements the server RAN, so a RELEASE refused with 25P02
      // because it was sent before the ROLLBACK TO does not satisfy this.
      assert.ok(session.count("ROLLBACK TO SAVEPOINT __pgmcp_advisor_sp") >= 1);
      assert.ok(session.count("RELEASE SAVEPOINT __pgmcp_advisor_sp") >= 1);
      assert.equal(session.unisolatedFailures(), 0, "a statement failure aborted the whole transaction");
      assertSessionClean(session);
    });
  });
});

describe("pg_index_advisor end-to-end against a stubbed server", () => {
  it("recommends the index the planner actually preferred, with costs and size", async () => {
    await withStubbedServer({ baselineCost: 1000, indexedCost: 10 }, async () => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
      })) as {
        ok: boolean;
        data?: {
          recommendations: {
            table: string;
            columns: string[];
            create_statement: string;
            create_statement_concurrently: string;
            estimated_size_bytes: string | null;
            workload_cost_before: number;
            workload_cost_after: number;
            requires_skip_scan: boolean;
            helps_statements: { statement: number; cost_before: number; cost_after: number }[];
          }[];
          statements: { planned: boolean; calls: string; baseline_cost: number | null }[];
          baseline_workload_cost: number;
          final_workload_cost: number;
          skip_scan_available: boolean;
          explains_used: number;
          budget_exhausted: boolean;
        };
      };

      assert.equal(result.ok, true);
      const data = result.data;
      assert.ok(data);
      assert.equal(data.recommendations.length, 1);
      const rec = data.recommendations[0];
      assert.ok(rec);
      assert.equal(rec.table, "public.users");
      // `status` is the only column the planner reported as a filter, so it is
      // the only one the catalog intersection can promote to a candidate.
      assert.deepEqual(rec.columns, ["status"]);
      assert.match(rec.create_statement, /ON "public"\."users" USING btree \("status"\)/);
      assert.match(rec.create_statement_concurrently, /CONCURRENTLY/);
      assert.equal(rec.estimated_size_bytes, "16384");
      assert.equal(rec.workload_cost_before, 1000);
      assert.equal(rec.workload_cost_after, 10);
      assert.equal(rec.requires_skip_scan, false);
      assert.deepEqual(rec.helps_statements, [{ statement: 0, cost_before: 1000, cost_after: 10 }]);

      assert.equal(data.statements[0]?.planned, true);
      assert.equal(data.statements[0]?.baseline_cost, 1000);
      assert.equal(data.statements[0]?.calls, "1");
      assert.equal(data.baseline_workload_cost, 1000);
      assert.equal(data.final_workload_cost, 10);
      assert.equal(data.skip_scan_available, true);
      assert.equal(data.budget_exhausted, false);
    });
  });

  // The guard's own test pins that ONE probe leaves assertSingleStatement. This
  // pins the other half -- that the CALLER honors the plan it came back with.
  // assertSingleStatement returns {ok, cost, plan} for a placeholder-free
  // statement because its extended-protocol probe already WAS a complete
  // EXPLAIN; the baseline loop is supposed to `continue` on that instead of
  // running the identical EXPLAIN a second time. A regression that always falls
  // through to explainStatement is invisible from the response -- baseline
  // EXPLAINs are deliberately not charged against `max_explains`, so
  // `explains_used` does not move -- and doubles the baseline round trips
  // against the server. Only the wire traffic shows it.
  it("reuses the guard's plan and issues no second baseline EXPLAIN", async () => {
    const sql = "SELECT * FROM users WHERE status = 'active'";
    await withStubbedServer({}, async (session) => {
      const result = (await pgIndexAdvisor.handler({ statements: [sql] })) as {
        ok: boolean;
        data?: { statements: { planned: boolean; baseline_cost: number | null }[] };
      };
      assert.equal(result.ok, true);

      // The search re-EXPLAINs this same text once per candidate it costs, so
      // the count is only meaningful BEFORE the first hypothetical index exists.
      const texts = session.texts();
      const firstCreate = texts.findIndex((s) => s.includes("hypopg_create_index"));
      assert.ok(firstCreate > 0, "the search never created a hypothetical index, so there is no baseline phase");
      const baselineExplains = texts.slice(0, firstCreate).filter((s) => s.startsWith("EXPLAIN") && s.includes(sql));
      assert.equal(
        baselineExplains.length,
        1,
        `baseline issued ${baselineExplains.length} EXPLAINs for one statement: ${JSON.stringify(baselineExplains)}`,
      );

      // ...and the one that ran is the one whose cost was kept, so "one EXPLAIN"
      // means the plan was REUSED, not that the baseline was skipped.
      assert.equal(result.data?.statements[0]?.planned, true);
      assert.equal(result.data?.statements[0]?.baseline_cost, 1000);
    });
  });

  it("recommends nothing when the index does not lower the cost", async () => {
    await withStubbedServer({ baselineCost: 1000, indexedCost: 1000 }, async () => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
      })) as { ok: boolean; data?: { recommendations: unknown[]; final_workload_cost: number } };
      assert.equal(result.ok, true);
      assert.equal(result.data?.recommendations.length, 0);
      // Nothing accepted means the workload cost is unchanged, not zero.
      assert.equal(result.data?.final_workload_cost, 1000);
    });
  });

  it("reports skip_scan_available: false and prunes on a pre-PG18 server", async () => {
    await withStubbedServer({ versionNum: 170_000 }, async () => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
      })) as { ok: boolean; data?: { skip_scan_available: boolean; candidates_pruned_leading_column: number } };
      assert.equal(result.ok, true);
      assert.equal(result.data?.skip_scan_available, false);
      assert.equal(typeof result.data?.candidates_pruned_leading_column, "number");
    });
  });

  it("honors max_explains and says the search was truncated", async () => {
    await withStubbedServer({ columns: ["id", "status", "created_at"] }, async () => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
        max_explains: 1,
        max_candidates: 5,
      })) as { ok: boolean; data?: { explains_used: number; explain_budget: number } };
      assert.equal(result.ok, true);
      assert.ok((result.data?.explains_used ?? 99) <= 1);
      assert.equal(result.data?.explain_budget, 1);
    });
  });

  it("weights a pg_stat_statements workload by its call count", async () => {
    await withStubbedServer({}, async () => {
      // No `statements` argument, so the workload comes from pg_stat_statements.
      // The stub's pool query returns no rows for the ranking select, which is
      // the "installed but nothing recorded" case.
      const result = (await pgIndexAdvisor.handler({})) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /recorded no statements/);
    });
  });

  it("errors with both fixes named when pg_stat_statements is absent and no statements were given", async () => {
    const originalConnect = pg.Pool.prototype.connect;
    const originalQuery = pg.Pool.prototype.query;
    const originalDbUrl = process.env.DATABASE_URL;
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
      const text = typeof sql === "string" ? sql : "";
      if (text.includes("server_version_num")) return Promise.resolve({ rows: [{ v: "180000" }] });
      if (text.includes("extname = 'hypopg'")) return Promise.resolve({ rows: [{ installed: true }] });
      // pg_stat_statements not installed: the extversion probe returns no rows.
      return Promise.resolve({ rows: [] });
    } as unknown as typeof pg.Pool.prototype.query;
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.reject(new Error("should not connect"));
    } as unknown as typeof pg.Pool.prototype.connect;
    try {
      const result = (await pgIndexAdvisor.handler({})) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /pass `statements` explicitly/);
      assert.match(result.error ?? "", /CREATE EXTENSION pg_stat_statements;/);
    } finally {
      pg.Pool.prototype.connect = originalConnect;
      pg.Pool.prototype.query = originalQuery;
      await shutdown();
      if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDbUrl;
    }
  });
});
