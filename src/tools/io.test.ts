import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";
import { ioTools } from "./io.js";

const pgIoStats = ioTools.find((t) => t.name === "pg_io_stats")!;

// ─────────────────────────────────────────────────────────────────────────
// pg_io_stats WITHOUT a live DB.
//
// Same stubbed-connect pattern as the pg_advisor suite in admin.test.ts: stub
// `pg.Pool.prototype.connect` for the shared client AND
// `pg.Pool.prototype.query`, because getServerVersionNum() probes through the
// POOL rather than the shared client. Leaving the pool query alone would send
// the probe at the fake DATABASE_URL host and hang on a connect timeout.
//
// This tool is entirely version-branched -- the server version decides which
// columns the SQL may NAME (`op_bytes` does not exist on PG18, `read_bytes`
// does not exist on PG16/17) and which response keys exist at all. None of
// that is reachable from a single live server, so a stub that captures the
// emitted SQL is the only place the cross-version column references can be
// checked at all.
// ─────────────────────────────────────────────────────────────────────────

/** Which of the tool's three sub-queries a given SQL string is. */
type IoCategory = "io" | "aios" | "method" | "unknown";

function categorize(sql: string): IoCategory {
  if (sql.includes("pg_stat_io")) return "io";
  if (sql.includes("pg_aios")) return "aios";
  if (sql.includes("io_method")) return "method";
  return "unknown";
}

function rowsFor(sql: string): Record<string, unknown>[] {
  switch (categorize(sql)) {
    case "io":
      // The OUTPUT names are deliberately version-invariant: both byte
      // branches alias to read_bytes / write_bytes / extend_bytes so a caller
      // never has to branch on server version. The fixture must not vary them
      // by version either, or it would bake in the bug it exists to catch.
      return [
        {
          backend_type: "client backend",
          io_object: "relation",
          io_context: "normal",
          reads: "48213",
          read_bytes: "394960896",
          read_time_ms: 0,
          writes: null,
          write_bytes: null,
          write_time_ms: null,
          writebacks: null,
          writeback_time_ms: null,
          extends: "12",
          extend_bytes: "98304",
          extend_time_ms: 0,
          hits: "9812344",
          evictions: "0",
          reuses: null,
          fsyncs: null,
          fsync_time_ms: null,
          stats_reset: "2026-08-01 00:00:00+00",
        },
      ];
    case "aios":
      return [
        {
          pid: 4821,
          io_id: 7,
          op: "read",
          state: "submitted",
          off: "8192",
          length: "16384",
          target_desc: "base/5/16385",
        },
      ];
    case "method":
      return [{ io_method: "worker" }];
    default:
      return [];
  }
}

/**
 * Strip every `AS <alias>` so what remains is only the SOURCE columns the
 * statement reads out of the catalog.
 *
 * Needed because the two byte branches deliberately emit the SAME output
 * names -- `(reads::numeric * op_bytes)::text AS read_bytes` on PG16-17 and
 * `read_bytes::text AS read_bytes` on PG18 -- so a naive search for
 * "read_bytes" in the raw SQL hits the alias on BOTH branches and proves
 * nothing. After stripping, a hit means the server column was genuinely
 * referenced, which is the thing that 42703s on the wrong major version.
 */
function sourceColumnsOf(sql: string): string {
  return sql.replace(/\bAS\s+"?[A-Za-z_][A-Za-z0-9_]*"?/g, "");
}

interface IoResponse {
  ok: boolean;
  data: {
    server_version_num: number;
    byte_accounting: string;
    include_zero_rows: boolean;
    io: Record<string, unknown>[] | null;
    io_method?: string | null;
    in_flight?: Record<string, unknown>[] | null;
    _warnings?: string[];
  };
}

describe("pg_io_stats (stubbed connect, no live DB)", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  let seen: { sql: string; params: unknown[] }[] = [];
  let connectCalls = 0;

  /**
   * @param versionNum server_version_num the probe reports; `null` makes the
   *   probe reject, exercising getServerVersionNum's "assume oldest" 0.
   * @param failing sub-queries that throw, standing in for the
   *   permission-gated catalogs on managed providers (pg_stat_io and pg_aios
   *   are both superuser / pg_monitor gated on several of them).
   */
  function installStub(versionNum: number | null, failing: IoCategory[] = []) {
    seen = [];
    connectCalls = 0;
    pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown) {
      if (versionNum === null) return Promise.reject(new Error("version probe unavailable"));
      const text = typeof sql === "string" ? sql : "";
      return Promise.resolve({ rows: text.includes("server_version_num") ? [{ v: String(versionNum) }] : [] });
    } as unknown as typeof pg.Pool.prototype.query;

    const client = {
      async query(sql: string, params: unknown[] = []) {
        seen.push({ sql, params });
        if (failing.includes(categorize(sql))) throw new Error("permission denied for view");
        return { rows: rowsFor(sql) };
      },
      release() {
        /* no-op */
      },
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      connectCalls += 1;
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  function sqlFor(category: IoCategory): string {
    return seen.find((q) => categorize(q.sql) === category)?.sql ?? "";
  }

  beforeEach(async () => {
    // shutdown() clears the pool AND the process-wide cached
    // server_version_num. Without it the first test's version leaks into every
    // later one and this whole suite becomes order-dependent -- the PG18 cases
    // would "pass" against a stub configured for PG15.
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

  // ── Version gate ───────────────────────────────────────────────────────

  it("PG15: refuses with a version error and issues no SQL at all", async () => {
    installStub(150_000);
    const res = (await pgIoStats.handler({})) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /PostgreSQL 16 or newer/);
    // The DETECTED version has to appear: an agent seeing only "requires 16+"
    // cannot tell whether the check actually ran.
    assert.match(res.error ?? "", /server_version_num=150000/);
    // Refusing BEFORE withSharedClient is the point -- pg_stat_io does not
    // exist here, so issuing the query would produce a 42P01 rather than an
    // actionable message.
    assert.equal(connectCalls, 0);
    assert.equal(seen.length, 0);
  });

  it("probe failure (0 sentinel): says 'could not be determined', not 'too old'", async () => {
    installStub(null);
    const res = (await pgIoStats.handler({})) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    // The two remediations differ -- "upgrade the server" vs "retry" -- so
    // collapsing them into one undifferentiated version error sends an agent to
    // the wrong fix. This catches a future simplification of the
    // `serverVersion > 0` branch.
    assert.match(res.error ?? "", /could not be determined/);
    assert.match(res.error ?? "", /retry once/);
    assert.doesNotMatch(res.error ?? "", /server_version_num=0\b/);
  });

  it("PG16 exactly: passes the gate (the check is `< PG16`, not `<=`)", async () => {
    installStub(160_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    assert.equal(res.ok, true);
    assert.equal(res.data.server_version_num, 160_000);
  });

  // ── Which columns each version is allowed to NAME ──────────────────────

  it("PG16: computes bytes from op_bytes and never reads the native byte columns", async () => {
    installStub(160_000);
    await pgIoStats.handler({});
    const sql = sqlFor("io");
    assert.match(sql, /reads::numeric \* op_bytes/);
    assert.match(sql, /writes::numeric \* op_bytes/);
    assert.match(sql, /extends::numeric \* op_bytes/);
    // read_bytes / write_bytes / extend_bytes do not exist before PG18;
    // referencing one is a 42703 that takes the whole tool down with it.
    assert.doesNotMatch(sourceColumnsOf(sql), /read_bytes|write_bytes|extend_bytes/);
  });

  it("PG17: still on the op_bytes branch (the cut point is PG18, not PG17)", async () => {
    installStub(170_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    const sql = sqlFor("io");
    assert.match(sql, /op_bytes/);
    assert.doesNotMatch(sourceColumnsOf(sql), /read_bytes|write_bytes|extend_bytes/);
    assert.match(res.data.byte_accounting, /op_bytes \* operation count/);
  });

  it("PG18: reads the native byte columns and NEVER names op_bytes", async () => {
    installStub(180_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    const sql = sqlFor("io");
    // op_bytes was REMOVED in PG18. Asserted against the RAW sql, not the
    // alias-stripped form, because op_bytes is never an output name here --
    // any occurrence at all is a hard error against a real PG18 server.
    assert.doesNotMatch(sql, /op_bytes/);
    const sources = sourceColumnsOf(sql);
    assert.match(sources, /read_bytes::text/);
    assert.match(sources, /write_bytes::text/);
    assert.match(sources, /extend_bytes::text/);
    assert.match(res.data.byte_accounting, /native read_bytes/);
  });

  it("PG17: pg_aios and io_method are never queried (pg_aios would be a 42P01)", async () => {
    installStub(170_000);
    await pgIoStats.handler({});
    // Not "issued and caught" -- not issued. A caught 42P01 still costs a round
    // trip and would land in _warnings as if something were wrong.
    assert.equal(seen.length, 1, `expected only the pg_stat_io query, saw: ${seen.map((s) => categorize(s.sql))}`);
    assert.equal(sqlFor("aios"), "");
    assert.equal(sqlFor("method"), "");
  });

  // ── Presence vs absence of the PG18-only keys ──────────────────────────

  it("PG18: the io_method and in_flight keys are PRESENT and populated", async () => {
    installStub(180_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    assert.equal(Object.hasOwn(res.data, "io_method"), true);
    assert.equal(Object.hasOwn(res.data, "in_flight"), true);
    assert.equal(res.data.io_method, "worker");
    assert.equal((res.data.in_flight ?? [])[0]?.pid, 4821);
  });

  it("PG16: io_method and in_flight are ABSENT keys, not null and not []", async () => {
    installStub(160_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    // Asserted with `in` / Object.hasOwn rather than truthiness on purpose:
    // `in_flight: []` reads as "nothing is stalled", a confident wrong answer
    // on a server that has no way to look. And `res.data.in_flight ===
    // undefined` would also pass for an explicit `undefined` value, which is
    // not the same thing as an absent key.
    assert.equal("io_method" in res.data, false);
    assert.equal("in_flight" in res.data, false);
    assert.equal(Object.hasOwn(res.data, "in_flight"), false);
    // server_version_num is echoed so a caller can tell WHY they are absent
    // without a second round-trip to version().
    assert.equal(res.data.server_version_num, 160_000);
  });

  it("PG18 with pg_aios denied: in_flight is present-but-null, never []", async () => {
    installStub(180_000, ["aios"]);
    const res = (await pgIoStats.handler({})) as IoResponse;
    assert.equal(res.ok, true);
    assert.equal(Object.hasOwn(res.data, "in_flight"), true);
    // null, not []: this tool gets called BECAUSE something is stalling, so a
    // permission denial rendered as an empty array points the investigation the
    // wrong way.
    assert.equal(res.data.in_flight, null);
    assert.match((res.data._warnings ?? []).join("\n"), /in_flight fetch failed/);
    // io_method is issued as its own query on purpose -- losing the
    // permission-gated view must not also lose the setting that explains what
    // the view would have held.
    assert.equal(res.data.io_method, "worker");
  });

  // ── Partial failure ───────────────────────────────────────────────────

  it("pg_stat_io denied: _warnings carries it, io is null, the rest still returns", async () => {
    installStub(180_000, ["io"]);
    const res = (await pgIoStats.handler({})) as IoResponse;
    assert.equal(res.ok, true);
    assert.match((res.data._warnings ?? []).join("\n"), /io fetch failed/);
    // null, not []: an empty array is a real and reachable answer here (a
    // freshly reset cluster), so it must not double as the error value.
    assert.equal(res.data.io, null);
    assert.equal((res.data.in_flight ?? []).length, 1);
    assert.equal(res.data.io_method, "worker");
    assert.match(res.data.byte_accounting, /native read_bytes/);
  });

  it("every sub-query denied on PG18: three warnings, still ok:true", async () => {
    installStub(180_000, ["io", "aios", "method"]);
    const res = (await pgIoStats.handler({})) as IoResponse;
    // Each check is an independent `if`, never an early return -- one failure
    // must not swallow the other two warnings.
    assert.equal(res.ok, true);
    assert.equal((res.data._warnings ?? []).length, 3);
    assert.equal(res.data.io, null);
    assert.equal(res.data.in_flight, null);
    assert.equal(res.data.io_method, null);
  });

  it("_warnings is absent entirely when nothing failed", async () => {
    installStub(180_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    // Conditionally spread. An empty array here would mean the spread guard
    // regressed and every clean call now ships a misleading empty key.
    assert.equal("_warnings" in res.data, false);
  });

  // ── Zod defaults for direct (non-MCP) callers ─────────────────────────

  it("re-applies the Zod defaults for a direct caller that passes no input", async () => {
    installStub(180_000);
    const res = (await pgIoStats.handler({})) as IoResponse;
    // Direct callers bypass the schema, so an un-defaulted `limit` binds
    // undefined into `LIMIT $1` and errors at bind time rather than defaulting.
    assert.deepEqual(
      seen.find((s) => categorize(s.sql) === "io")?.params,
      [200],
      "the pg_stat_io query should bind the re-applied limit default",
    );
    assert.deepEqual(
      seen.find((s) => categorize(s.sql) === "aios")?.params,
      [200],
      "the pg_aios query should bind the same re-applied default",
    );
    // includeZeroRows defaults to false, and that default is what emits the
    // all-zero filter; losing it silently returns the full noisy matrix.
    assert.match(sqlFor("io"), /WHERE \(COALESCE\(reads, 0\)/);
    assert.equal(res.data.include_zero_rows, false);
  });

  it("includeZeroRows:true drops the filter and an explicit limit binds through", async () => {
    installStub(180_000);
    const res = (await pgIoStats.handler({ includeZeroRows: true, limit: 7 })) as IoResponse;
    assert.doesNotMatch(sqlFor("io"), /WHERE/);
    assert.deepEqual(seen.find((s) => categorize(s.sql) === "io")?.params, [7]);
    assert.deepEqual(seen.find((s) => categorize(s.sql) === "aios")?.params, [7]);
    // Echoed because it changes what an empty `io` array MEANS: with the filter
    // on, empty is "no recorded I/O anywhere"; with it off, empty is "the view
    // itself returned nothing".
    assert.equal(res.data.include_zero_rows, true);
  });
});
