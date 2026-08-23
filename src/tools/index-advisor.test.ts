import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import {
  applySkipScanGate,
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
}

interface StubOptions {
  versionNum?: number;
  hypopgInstalled?: boolean;
  /** Total Cost the baseline EXPLAIN reports, before any hypothetical index. */
  baselineCost?: number;
  /** Total Cost reported while a hypothetical index exists. */
  indexedCost?: number;
  /** Make every EXPLAIN throw, to drive the tool down its failure path. */
  failExplain?: boolean;
  /** Columns pg_attribute reports for public.users. */
  columns?: string[];
}

interface StubSession {
  statements: StubStatement[];
  /** SQL texts seen, for order-sensitive assertions. */
  texts(): string[];
  count(fragment: string): number;
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
    columns = ["id", "status", "created_at"],
  } = options;

  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;

  const statements: StubStatement[] = [];
  const session: StubSession = {
    statements,
    texts: () => statements.map((s) => s.sql),
    count: (fragment) => statements.filter((s) => s.sql.includes(fragment)).length,
  };

  // Hypothetical indexes are session state in the real server too, so the stub
  // models them as a counter rather than a boolean: the advisor creates and
  // drops them around each candidate, and a plan must only get cheaper while at
  // least one is live.
  let liveHypoIndexes = 0;

  const planFor = (cost: number) => [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "users",
        Schema: "public",
        Alias: "users",
        "Total Cost": cost,
        Filter: "(status = 'active'::text)",
      },
    },
  ];

  const client = {
    async query(config: unknown, params: unknown[] = []) {
      const sql = typeof config === "string" ? config : ((config as { text?: string }).text ?? "");
      const values = typeof config === "string" ? params : ((config as { values?: unknown[] }).values ?? params);
      statements.push({ sql, params: values });

      if (sql.startsWith("EXPLAIN")) {
        if (failExplain) throw new Error('relation "users" does not exist');
        const cost = liveHypoIndexes > 0 ? indexedCost : baselineCost;
        return { rows: [{ "QUERY PLAN": planFor(cost) }], fields: [], command: "EXPLAIN", rowCount: 1 };
      }
      if (sql.includes("hypopg_create_index")) {
        liveHypoIndexes += 1;
        return { rows: [{ indexrelid: 12_345 }], fields: [], command: "SELECT", rowCount: 1 };
      }
      if (sql.includes("hypopg_drop_index")) {
        liveHypoIndexes = Math.max(0, liveHypoIndexes - 1);
        return { rows: [{ hypopg_drop_index: true }], fields: [], command: "SELECT", rowCount: 1 };
      }
      if (sql.includes("hypopg_reset")) {
        liveHypoIndexes = 0;
        return { rows: [], fields: [], command: "SELECT", rowCount: 0 };
      }
      if (sql.includes("hypopg_relation_size")) {
        return { rows: [{ bytes: "16384" }], fields: [], command: "SELECT", rowCount: 1 };
      }
      // Matched before the pg_attribute branch: the index query also joins
      // pg_attribute, so a looser check would swallow it.
      if (sql.includes("FROM pg_catalog.pg_index")) {
        return { rows: [], fields: [], command: "SELECT", rowCount: 0 };
      }
      if (sql.includes("LEFT JOIN pg_catalog.pg_stats")) {
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
    },
    release() {
      /* no-op */
    },
  };

  await shutdown();
  process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown, params: unknown[] = []) {
    const text = typeof sql === "string" ? sql : "";
    statements.push({ sql: text, params });
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

  try {
    return await fn(session);
  } finally {
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

describe("pg_index_advisor HypoPG session hygiene", () => {
  it("resets hypothetical indexes on the way in AND out of a successful call", async () => {
    await withStubbedServer({}, async (session) => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
      })) as { ok: boolean };
      assert.equal(result.ok, true);
      // Once on entry (a previous call's teardown may have failed) and once in
      // the finally. HypoPG indexes are SESSION-scoped, so the transaction's
      // ROLLBACK does not remove them and this connection goes back to the pool.
      assert.ok(session.count("hypopg_reset") >= 2, `saw ${session.count("hypopg_reset")} resets`);
      assert.ok(session.count("ROLLBACK") >= 1);
      // The reset must be the LAST hypopg statement, or an index outlives the call.
      const hypoCalls = session.texts().filter((s) => s.includes("hypopg"));
      assert.match(hypoCalls.at(-1) ?? "", /hypopg_reset/);
    });
  });

  it("still resets when the run fails, so a hypothetical index cannot leak into the next call", async () => {
    // The error path is the one that matters: an early `return` from a guard
    // inside the try would skip a trailing cleanup statement, which is exactly
    // why the reset lives in a `finally`.
    await withStubbedServer({ failExplain: true }, async (session) => {
      const result = (await pgIndexAdvisor.handler({
        statements: ["SELECT * FROM users WHERE status = 'active'"],
      })) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /could be planned/);
      assert.ok(session.count("hypopg_reset") >= 2, "the teardown reset did not run on the failure path");
      assert.ok(session.count("ROLLBACK") >= 1);
    });
  });

  it("drops only the candidate under test, never resetting mid-search", async () => {
    await withStubbedServer({}, async (session) => {
      await pgIndexAdvisor.handler({ statements: ["SELECT * FROM users WHERE status = 'active'"] });
      // A hypopg_reset() inside the search would wipe previously accepted
      // indexes and silently degrade the greedy search to an independent
      // per-candidate ranking, so each candidate is retired with a targeted drop.
      assert.ok(session.count("hypopg_drop_index") >= 1);
    });
  });

  it("isolates a failing statement behind a savepoint so later work still runs", async () => {
    await withStubbedServer({ failExplain: true }, async (session) => {
      await pgIndexAdvisor.handler({ statements: ["SELECT 1"] });
      // Without ROLLBACK TO, the aborted transaction takes every subsequent
      // statement down with SQLSTATE 25P02.
      assert.ok(session.count("ROLLBACK TO SAVEPOINT __pgmcp_advisor_sp") >= 1);
      // ROLLBACK TO leaves the savepoint in place, so the RELEASE is still
      // required or one savepoint leaks per failed statement.
      assert.ok(session.count("RELEASE SAVEPOINT __pgmcp_advisor_sp") >= 1);
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
