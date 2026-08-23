import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import { healthTools } from "./health.js";

const pgHealth = healthTools.find((t) => t.name === "pg_health")!;

// ─────────────────────────────────────────────────────────────────────────
// pg_health WITHOUT a live DB.
//
// Same stubbed-connect pattern as the pg_advisor suite in
// src/tools/admin.test.ts: set DATABASE_URL so getPool() construction
// succeeds, then stub pg.Pool.prototype.connect to resolve a fake client.
// pg.Pool.prototype.query is stubbed alongside it even though pg_health has
// no version gate today -- anything that reaches the pool directly (a future
// getServerVersionNum() probe) would otherwise dial the real DATABASE_URL
// host and hang the suite on a connect timeout.
//
// The connections statement is asserted as SQL TEXT rather than through
// stubbed rows on purpose: the bucket arithmetic happens server-side, so a
// stub can return any numbers it likes and prove nothing about whether the
// filters actually partition pg_stat_activity.
// ─────────────────────────────────────────────────────────────────────────

type HealthQuery = "version" | "size" | "conns" | "active" | "dbStats" | "tableCount" | "unknown";

/**
 * Which fanout sub-query a given SQL string is. The connections and
 * active-queries statements both scan pg_stat_activity, so each is
 * discriminated on a column only it names.
 */
function categorize(sql: string): HealthQuery {
  if (sql.includes("cluster_client_backends")) return "conns";
  if (sql.includes("wait_event_type")) return "active";
  if (sql.includes("pg_stat_database")) return "dbStats";
  if (sql.includes("pg_database_size")) return "size";
  if (sql.includes("relkind IN ('r', 'p')")) return "tableCount";
  if (sql.includes("version()")) return "version";
  return "unknown";
}

/**
 * The wait-event pair the stubbed `active` row reports. Parameterized because
 * this vocabulary is the one thing pg_health surfaces that postgres renames
 * between majors -- a buffer-pin wait is ('BufferPin', 'BufferPin') through
 * PG18 and ('Buffer', 'BufferShared') from PG19 on -- so the passthrough cases
 * below can drive both spellings through the real handler.
 */
interface WaitEventPair {
  type: string | null;
  name: string | null;
}

const DEFAULT_WAIT_EVENT: WaitEventPair = { type: "Lock", name: "transactionid" };

function rowsFor(sql: string, waitEvent: WaitEventPair = DEFAULT_WAIT_EVENT): Record<string, unknown>[] {
  switch (categorize(sql)) {
    case "version":
      return [{ version: "PostgreSQL 17.4 on aarch64-unknown-linux-gnu" }];
    case "size":
      return [{ database: "stubdb", size_pretty: "12 MB", size_bytes: "12582912" }];
    case "conns":
      return [
        {
          total: "9",
          active: "2",
          idle: "4",
          idle_in_transaction: "1",
          idle_in_transaction_aborted: "1",
          other: "0",
          state_unavailable: "1",
          cluster_client_backends: "11",
          max_connections: 100,
          superuser_reserved_connections: 3,
          used_fraction: 0.11,
        },
      ];
    case "active":
      return [
        {
          pid: 4242,
          state: "active",
          duration_seconds: 3.5,
          transaction_age_seconds: 61.2,
          xact_start: "2026-08-22 10:00:00+00",
          wait_event_type: waitEvent.type,
          wait_event: waitEvent.name,
          backend_type: "client backend",
          query: "SELECT 1",
          application_name: "psql",
        },
      ];
    case "dbStats":
      return [
        {
          deadlocks: "3",
          temp_files: "2",
          // Past 2^53 deliberately: the ::text casts exist so node-pg hands
          // these back as strings instead of silently rounding a long-lived
          // cluster's temp_bytes.
          temp_bytes: "9007199254740993",
          temp_bytes_pretty: "8192 TB",
          conflicts: "0",
          blks_hit: "1000",
          blks_read: "10",
          cache_hit_ratio: 0.9901,
          stats_reset: "2026-01-01 00:00:00+00",
        },
      ];
    case "tableCount":
      return [{ count: "17" }];
    default:
      return [];
  }
}

interface HealthResponse {
  ok: boolean;
  error?: string;
  data?: {
    connected: boolean;
    version?: string;
    database: Record<string, unknown> | null | undefined;
    connections: Record<string, unknown> | null | undefined;
    active_queries: Record<string, unknown>[] | undefined;
    database_stats: Record<string, unknown> | null | undefined;
    table_count: string | null | undefined;
    _warnings?: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────
// A miniature evaluator for the FILTER predicates, so the reconciliation
// claim ("those six sum to total") is CHECKED rather than restated. Given a
// documented pg_stat_activity `state`, it answers which buckets would count
// that row. It deliberately throws on any clause shape it does not recognize:
// an edit that introduces a new predicate form has to come back here and say
// what it means for the partition, instead of quietly evaluating to false and
// leaving a bucket looking empty.
// ─────────────────────────────────────────────────────────────────────────

/** The full documented state set, plus NULL for rows whose state is hidden. */
const DOCUMENTED_STATES: (string | null)[] = [
  "active",
  "idle",
  "idle in transaction",
  "idle in transaction (aborted)",
  "starting",
  "fastpath function call",
  "disabled",
  null,
];

const BUCKETS = [
  "active",
  "idle",
  "idle_in_transaction",
  "idle_in_transaction_aborted",
  "other",
  "state_unavailable",
] as const;

/** The `FILTER (WHERE ...)` predicate that produces the given output alias. */
function filterFor(sql: string, alias: string): string {
  const aliasIdx = sql.search(new RegExp(`AS ${alias}\\b`));
  assert.ok(aliasIdx >= 0, `no output column aliased ${alias}`);
  const filterIdx = sql.lastIndexOf("FILTER (WHERE", aliasIdx);
  assert.ok(filterIdx >= 0, `${alias} is not produced by a FILTER`);
  // Balanced scan rather than a regex: the predicates contain nested parens
  // (current_database(), the NOT IN list, and the literal '... (aborted)').
  const open = sql.indexOf("(", filterIdx);
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) {
      return sql
        .slice(open + 1, i)
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  throw new Error(`unbalanced parens in the FILTER for ${alias}`);
}

function evalClause(clause: string, state: string | null): boolean {
  // Every imagined fixture row is in the current database, so the datname
  // guard is satisfied and the state predicate is what decides the bucket.
  if (clause === "datname = current_database()") return true;
  if (clause === "state IS NULL") return state === null;
  if (clause === "state IS NOT NULL") return state !== null;
  const eq = /^state = '(.+)'$/.exec(clause);
  if (eq) return state === eq[1];
  const notIn = /^state NOT IN \((.+)\)$/.exec(clause);
  if (notIn) {
    // `NULL NOT IN (...)` is NULL, never true -- mirror that rather than
    // treating an unreadable state as "some other state".
    const list = notIn[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    return state !== null && !list.includes(state);
  }
  throw new Error(`unrecognized FILTER clause: ${clause}`);
}

function bucketCounts(predicate: string, state: string | null): boolean {
  return predicate
    .replace(/^WHERE /, "")
    .split(/ AND /)
    .every((clause) => evalClause(clause.trim(), state));
}

describe("pg_health (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let seen: { sql: string; params: unknown[] }[] = [];

  /**
   * @param failing categories whose sub-query throws, standing in for the
   *   permission-gated catalogs on managed providers.
   * @param emptyVersionRow makes the version query succeed with zero rows,
   *   which is not a failure and so does not hit the early return.
   * @param waitEvent the wait-event pair the stubbed active row reports.
   */
  function installStub(failing: HealthQuery[] = [], emptyVersionRow = false, waitEvent = DEFAULT_WAIT_EVENT) {
    seen = [];
    pg.Pool.prototype.query = function queryStub(this: pg.Pool) {
      return Promise.resolve({ rows: [] });
    } as unknown as typeof pg.Pool.prototype.query;

    const client = {
      async query(sql: string, params: unknown[] = []) {
        seen.push({ sql, params });
        if (failing.includes(categorize(sql))) throw new Error("permission denied");
        if (emptyVersionRow && categorize(sql) === "version") return { rows: [] };
        return { rows: rowsFor(sql, waitEvent) };
      },
      release() {
        /* no-op */
      },
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  function sqlFor(category: HealthQuery): string {
    return seen.find((q) => categorize(q.sql) === category)?.sql ?? "";
  }

  beforeEach(async () => {
    // shutdown() rebuilds the pool against the stub and clears the
    // process-wide cached server_version_num, so no state leaks between cases
    // or in from a sibling suite in the same runner process.
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("issues exactly the six documented fanout sub-queries on one shared client", async () => {
    installStub();
    const res = (await pgHealth.handler({})) as HealthResponse;
    assert.equal(res.ok, true);
    // An uncategorized statement means a seventh query appeared (or one was
    // rewritten past its discriminator), which would also silently escape the
    // per-category failure coverage below.
    assert.deepEqual(seen.map((q) => categorize(q.sql)).sort(), [
      "active",
      "conns",
      "dbStats",
      "size",
      "tableCount",
      "version",
    ]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Bucket reconciliation. The six state buckets are documented to sum to
  // `total`; a state matching two filters double-counts and one matching none
  // vanishes, and either way the sum stops being a check the caller can run.
  // ───────────────────────────────────────────────────────────────────────

  it("every documented state lands in exactly one bucket", async () => {
    installStub();
    await pgHealth.handler({});
    const sql = sqlFor("conns");
    const predicates = BUCKETS.map((b) => [b, filterFor(sql, b)] as const);
    for (const state of DOCUMENTED_STATES) {
      const hits = predicates.filter(([, p]) => bucketCounts(p, state)).map(([b]) => b);
      assert.deepEqual(hits.length, 1, `state ${JSON.stringify(state)} landed in ${hits.length} buckets: ${hits}`);
    }
  });

  it("total counts every row the six buckets partition", async () => {
    installStub();
    await pgHealth.handler({});
    const total = filterFor(sqlFor("conns"), "total");
    // `total` filters on datname alone. A state predicate here would break the
    // sum-to-total invariant from the other side: the buckets would be
    // complete while the number they are checked against was not.
    assert.equal(total, "WHERE datname = current_database()");
    for (const state of DOCUMENTED_STATES) {
      assert.ok(bucketCounts(total, state), `total should count state ${JSON.stringify(state)}`);
    }
  });

  it("other is a NOT IN catch-all, so a future major's new state still reconciles", async () => {
    installStub();
    await pgHealth.handler({});
    const sql = sqlFor("conns");
    const other = filterFor(sql, "other");
    // An equality list (state IN ('starting', 'fastpath function call',
    // 'disabled')) passes every assertion above and still drops a state a
    // later major adds straight out of the sum.
    assert.match(other, /state NOT IN \(/);
    assert.doesNotMatch(other, /state IN \(/);
    const invented = "parallel worker startup";
    const hits = BUCKETS.filter((b) => bucketCounts(filterFor(sql, b), invented));
    assert.deepEqual(hits, ["other"]);
  });

  it("state_unavailable counts state IS NULL, making an unprivileged under-count visible", async () => {
    installStub();
    const res = (await pgHealth.handler({})) as HealthResponse;
    assert.match(filterFor(sqlFor("conns"), "state_unavailable"), /state IS NULL/);
    // Without this bucket a role lacking pg_read_all_stats / pg_monitor sees
    // its own sessions only and reports a confident `active: 0` on a busy
    // database. It is a visibility gap on a SUCCESSFUL query, so _warnings
    // cannot carry it -- the field is the only signal.
    assert.equal(res.data?.connections?.state_unavailable, "1");
    assert.equal((res.data?._warnings ?? []).length, 0);
  });

  it("counts cluster client backends separately from the current database's sessions", async () => {
    installStub();
    const res = (await pgHealth.handler({})) as HealthResponse;
    // One statement, two scopes: the per-database counters moved into FILTERs
    // so the cluster-wide slot count could ride along in the same scan.
    // Comparing one database's session count against a cluster-wide
    // max_connections under-reports pressure on a multi-tenant server.
    assert.match(
      sqlFor("conns"),
      /count\(\*\) FILTER \(WHERE backend_type = 'client backend'\)::text AS cluster_client_backends/,
    );
    assert.equal(res.data?.connections?.cluster_client_backends, "11");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Wait-event passthrough. wait_event_type / wait_event are the only values
  // pg_health surfaces whose vocabulary postgres renames between majors: the
  // same buffer-pin wait reports ('BufferPin', 'BufferPin') through PG18 and
  // ('Buffer', 'BufferShared') from PG19 on. A predicate or a CASE over those
  // literals in the handler would silently match nothing on the far side of
  // that rename -- rendering a database stalled on exactly that wait as one
  // with nothing waiting at all -- and no fixture-row assertion would catch
  // it, because a stub returns whatever it was told to either way. So the SQL
  // shape is what gets pinned here.
  // ───────────────────────────────────────────────────────────────────────

  it("selects the wait-event pair bare, never filtering or switching on the literals", async () => {
    installStub();
    await pgHealth.handler({});
    const sql = sqlFor("active");
    // Adjacent bare select items, exactly as written. A rewrite into
    // `CASE WHEN wait_event_type = 'BufferPin' THEN ... END AS wait_event_type`
    // breaks this and the occurrence counts below.
    assert.match(sql, /\n\s*wait_event_type,\n\s*wait_event,\n\s*backend_type,/);
    // The \b after `wait_event` does not fire inside `wait_event_type` --
    // the next character is a word character -- so the two counts below are
    // independent. One apiece means the select list is the ONLY place either
    // column is named anywhere in the statement.
    const typeMentions = sql.match(/\bwait_event_type\b/g) ?? [];
    const nameMentions = sql.match(/\bwait_event\b/g) ?? [];
    assert.equal(typeMentions.length, 1, "wait_event_type is named more than once");
    assert.equal(nameMentions.length, 1, "wait_event is named more than once");
    // Asserted separately from the counts so a regression that adds a
    // predicate reports WHERE it went wrong rather than just "count was 2".
    const where = sql.slice(sql.indexOf("WHERE"), sql.indexOf("ORDER BY"));
    assert.ok(where.length > 0, "the active-queries query should still have a WHERE clause");
    assert.doesNotMatch(where, /wait_event/);
  });

  // The same underlying wait, spelled either side of the PG19 rename. Neither
  // spelling is translated, normalized, or dropped on the way out -- which is
  // what lets the caller interpret it against the `version` in the same
  // response instead of this tool guessing.
  const WAIT_EVENT_SPELLINGS: [string, WaitEventPair][] = [
    ["PG18-and-older", { type: "BufferPin", name: "BufferPin" }],
    ["PG19", { type: "Buffer", name: "BufferShared" }],
  ];

  for (const [label, pair] of WAIT_EVENT_SPELLINGS) {
    it(`passes the ${label} wait-event spelling through verbatim`, async () => {
      installStub([], false, pair);
      const res = (await pgHealth.handler({})) as HealthResponse;
      const rows = res.data?.active_queries ?? [];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.wait_event_type, pair.type);
      assert.equal(rows[0]?.wait_event, pair.name);
    });
  }

  it("reports a null wait-event pair as null rather than a placeholder", async () => {
    // Both columns are NULL whenever the backend is running rather than
    // waiting, which is the common case. A COALESCE to 'none' here would
    // invent a wait event type the caller cannot find in any postgres
    // version's documentation.
    installStub([], false, { type: null, name: null });
    const res = (await pgHealth.handler({})) as HealthResponse;
    const rows = res.data?.active_queries ?? [];
    assert.equal(rows[0]?.wait_event_type, null);
    assert.equal(rows[0]?.wait_event, null);
  });

  // ───────────────────────────────────────────────────────────────────────
  // The cap, and the fraction read against it.
  // ───────────────────────────────────────────────────────────────────────

  it("casts max_connections and superuser_reserved_connections out of text", async () => {
    installStub();
    const res = (await pgHealth.handler({})) as HealthResponse;
    const sql = sqlFor("conns");
    // current_setting() returns text; without the ::int these arrive as
    // strings and a caller comparing them numerically gets string ordering
    // ("100" < "99") with no error to notice.
    assert.match(sql, /current_setting\('max_connections'\)::int AS max_connections/);
    assert.match(sql, /current_setting\('superuser_reserved_connections'\)::int AS superuser_reserved_connections/);
    assert.equal(res.data?.connections?.max_connections, 100);
    assert.equal(res.data?.connections?.superuser_reserved_connections, 3);
  });

  it("guards the used_fraction denominator with NULLIF", async () => {
    installStub();
    await pgHealth.handler({});
    // max_connections cannot be 0 on a real server, but the guard is what
    // keeps a pooler or a mangled GUC from turning the whole connections
    // sub-query into a division-by-zero error -- that would lose the entire
    // breakdown, not just the fraction.
    assert.match(sqlFor("conns"), /NULLIF\(current_setting\('max_connections'\)::numeric, 0\)/);
  });

  it("keeps the bigint counters as ::text so they survive past 2^53", async () => {
    installStub();
    const res = (await pgHealth.handler({})) as HealthResponse;
    assert.match(sqlFor("dbStats"), /temp_bytes::text AS temp_bytes/);
    // A JS number here would round to ...740992 and the caller would never
    // know the value it read was not the value stored.
    assert.equal(res.data?.database_stats?.temp_bytes, "9007199254740993");
    assert.equal(typeof res.data?.database_stats?.deadlocks, "string");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Partial failure. Several of these catalogs are permission-gated on
  // managed providers, so losing one while the rest are readable is the
  // expected path -- only the version/connectivity probe is fatal.
  // ───────────────────────────────────────────────────────────────────────

  const PARTIAL: [HealthQuery, RegExp, keyof NonNullable<HealthResponse["data"]>][] = [
    ["size", /database fetch failed: permission denied/, "database"],
    ["conns", /connections fetch failed: permission denied/, "connections"],
    ["active", /active_queries fetch failed: permission denied/, "active_queries"],
    ["dbStats", /database_stats fetch failed: permission denied/, "database_stats"],
    ["tableCount", /table_count fetch failed: permission denied/, "table_count"],
  ];

  for (const [category, warning, field] of PARTIAL) {
    it(`a failed ${category} sub-query warns without losing the rest of the snapshot`, async () => {
      installStub([category]);
      const res = (await pgHealth.handler({})) as HealthResponse;
      assert.equal(res.ok, true);
      assert.equal((res.data?._warnings ?? []).length, 1);
      assert.match((res.data?._warnings ?? []).join("\n"), warning);
      // active_queries degrades to [] and every other field to null. Either
      // way it must not be undefined, which JSON serialization drops -- an LLM
      // then reads "key missing" where the truth is "fetch failed".
      if (field === "active_queries") assert.deepEqual(res.data?.active_queries, []);
      else assert.equal(res.data?.[field], null);
      // The headline field and the other four still return.
      assert.match(res.data?.version ?? "", /PostgreSQL 17\.4/);
      for (const [, , other] of PARTIAL) {
        if (other === field) continue;
        assert.notEqual(res.data?.[other], null, `${other} should still be populated`);
      }
    });
  }

  it("only the version probe is fatal -- it means connectivity, not permissions", async () => {
    installStub(["version"]);
    const res = (await pgHealth.handler({})) as HealthResponse;
    // A half-empty success object here would report a database that cannot be
    // reached as merely partially readable.
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /permission denied/);
    assert.equal(res.data, undefined);
  });

  it("warns when the version query succeeds but returns no row", async () => {
    installStub([], true);
    const res = (await pgHealth.handler({})) as HealthResponse;
    // ok-but-empty is not a failure, so the early return does not fire and
    // `version` would otherwise go missing from the response with no signal.
    assert.equal(res.ok, true);
    assert.match((res.data?._warnings ?? []).join("\n"), /version unavailable despite successful query/);
    assert.equal(res.data?.version, undefined);
  });

  it("survives every sub-query except the version probe failing at once", async () => {
    installStub(["size", "conns", "active", "dbStats", "tableCount"]);
    const res = (await pgHealth.handler({})) as HealthResponse;
    assert.equal(res.ok, true);
    assert.equal((res.data?._warnings ?? []).length, 5);
    assert.equal(res.data?.connected, true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Input defaults.
  // ───────────────────────────────────────────────────────────────────────

  it("re-applies the activeQueryLimit default for direct callers that pass no input", async () => {
    installStub();
    await pgHealth.handler({});
    // Direct (non-MCP) callers bypass Zod, so an un-defaulted activeQueryLimit
    // would bind undefined into `LIMIT $1` and error the sub-query out to an
    // empty active_queries list.
    assert.deepEqual(seen.find((q) => categorize(q.sql) === "active")?.params, [10]);
  });

  it("passes an explicit activeQueryLimit through to the active-queries query", async () => {
    installStub();
    await pgHealth.handler({ activeQueryLimit: 42 });
    assert.deepEqual(seen.find((q) => categorize(q.sql) === "active")?.params, [42]);
  });
});
