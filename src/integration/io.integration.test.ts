// SERIALIZATION: these integration files MUST run serialized in one process
// (--test-concurrency=1 via scripts/run-tests.mjs). The pg pool, typeNameCache,
// and process.env are process-global singletons; running these files (or their
// tests) concurrently would let one test's pool swap / env mutation / cache
// reset race another's in-flight query. Do not parallelize without first
// removing those shared singletons.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PG16, PG18, runInternal } from "../api.js";
import { ioTools } from "../tools/io.js";
import { integrationEnabled, setupFixtures, teardownFixtures } from "./fixtures.js";

const ioStats = ioTools.find((t) => t.name === "pg_io_stats")!;

type IoStatsRow = {
  backend_type: string;
  io_object: string;
  io_context: string;
  reads: string | null;
  read_bytes: string | null;
  read_time_ms: number | null;
  writes: string | null;
  write_bytes: string | null;
  write_time_ms: number | null;
  writebacks: string | null;
  writeback_time_ms: number | null;
  extends: string | null;
  extend_bytes: string | null;
  extend_time_ms: number | null;
  hits: string | null;
  evictions: string | null;
  reuses: string | null;
  fsyncs: string | null;
  fsync_time_ms: number | null;
  stats_reset: string | null;
};

type AioStatsRow = {
  pid: number;
  io_id: number;
  op: string | null;
  state: string | null;
  off: string | null;
  length: string | null;
  target_desc: string | null;
};

// io_method / in_flight are optional on the TYPE for the same reason they are
// spread conditionally in the handler: below PG18 the keys are absent, not
// null. Declaring them non-optional here would quietly bless a regression that
// starts emitting `in_flight: []` on PG16/17.
type IoStatsData = {
  server_version_num: number;
  byte_accounting: string;
  include_zero_rows: boolean;
  io: IoStatsRow[] | null;
  io_method?: string | null;
  in_flight?: AioStatsRow[] | null;
  _warnings?: string[];
};

const COUNTER_FIELDS = ["reads", "writes", "extends", "writebacks", "hits", "evictions", "reuses", "fsyncs"] as const;

const TIMING_FIELDS = [
  "read_time_ms",
  "write_time_ms",
  "writeback_time_ms",
  "extend_time_ms",
  "fsync_time_ms",
] as const;

// Byte field paired with the counter that produces it on the PG16-17 branch.
// The pairing is what makes the NULL-propagation assertion possible: with
// `(reads::numeric * op_bytes)`, a NULL `reads` MUST yield a NULL byte figure.
const BYTE_FIELD_PAIRS = [
  ["read_bytes", "reads"],
  ["write_bytes", "writes"],
  ["extend_bytes", "extends"],
] as const;

// io_method values the tool's description documents. NULL is also legitimate:
// the handler reads the GUC through the two-argument current_setting(), which
// returns NULL rather than raising 42704 on a build that reports >= 180000
// without the parameter.
const IO_METHODS = ["worker", "io_uring", "sync"];

// Server-version capability probe. Asks the server directly rather than
// importing the handler's own getServerVersionNum(), for the same reason
// admin.integration.test.ts re-probes for the PG16-gated last_*_scan columns:
// getServerVersionNum is what the handler uses to PICK its SQL branch, so a
// regression in that probe (a stale process-wide cache surviving a pool swap,
// a 0-on-failure that silently downgrades the query) must not also move the
// expectation this file checks it against. Returns 0 when the probe itself
// fails, which callers treat as "cannot tell" and skip -- matching this
// suite's habit of skipping rather than failing when a capability is absent.
async function probeServerVersionNum(): Promise<number> {
  const res = await runInternal<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  if (!res.ok || !res.data?.length) return 0;
  const parsed = Number.parseInt(res.data[0].v, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function callIoStats(input: Record<string, unknown>): Promise<IoStatsData> {
  const res = (await ioStats.handler(input)) as { ok: boolean; data?: IoStatsData; error?: string };
  assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
  assert.ok(res.data, `expected data on a successful call, got ${JSON.stringify(res)}`);
  return res.data;
}

/**
 * Returns true when the named sub-query actually ran on this server.
 *
 * `pg_stat_io` and `pg_aios` are pg_monitor / superuser gated on several
 * managed providers, and the handler reports that as a `_warnings` entry with
 * the field nulled rather than a hard failure -- a capability absence, so the
 * caller skips. Every OTHER failure is exactly what this file exists to catch:
 * a wrong source column (42703), a bad `::numeric` cast on a float8 (42846),
 * or a mis-quoted keyword identifier such as `"object"` / `"off"` (42601) all
 * land in the same warnings array while the tool still returns ok:true. The 15
 * unit tests match SQL by substring against a stub, so nothing else in the
 * repo would notice; tolerating an unclassified warning here would leave this
 * tool's query text exactly as unverified as it is today.
 */
function subqueryRan(data: IoStatsData, prefix: string, label: string): boolean {
  const warning = (data._warnings ?? []).find((w) => w.startsWith(prefix));
  if (!warning) return true;
  assert.match(
    warning,
    /42501|permission denied|insufficient privilege/i,
    `${label}: only a permission denial is an acceptable sub-query failure -- got ${warning}`,
  );
  return false;
}

describe("integration: pg_io_stats", { skip: !integrationEnabled() }, () => {
  before(setupFixtures);
  after(teardownFixtures);

  // The single highest-value assertion in this file: it proves the whole
  // pg_stat_io statement PARSES and EXECUTES against a real server, on
  // whichever byte-accounting branch the version picks. The unit suite cannot
  // reach this -- its stub matches SQL by substring and returns canned rows,
  // so a query that would 42703 on every live server still passes there.
  it("executes the pg_stat_io query and returns rows on PG16+", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version < PG16) return; // covered by the refusal test below

    // Called with `{}` on purpose: direct (non-MCP) callers bypass the zod
    // schema, so the handler re-applies the defaults itself. `limit` is the
    // load-bearing one -- an undefined bound into `LIMIT $1` errors at bind
    // time rather than defaulting, which no unit test that always passes a
    // limit would catch.
    const data = await callIoStats({});

    assert.equal(
      data.server_version_num,
      version,
      "the echoed server_version_num must match a fresh probe -- a mismatch means the handler's " +
        "cached getServerVersionNum is describing a different (or torn-down) server",
    );
    assert.equal(typeof data.byte_accounting, "string");
    assert.ok(data.byte_accounting.length > 0, "byte_accounting must never be empty");
    assert.equal(data.include_zero_rows, false, "includeZeroRows must default to false for a direct caller");

    if (!subqueryRan(data, "io fetch failed", "pg_stat_io")) return;
    assert.ok(
      Array.isArray(data.io),
      `io must be an array when the sub-query succeeded, got ${JSON.stringify(data.io)}`,
    );
    // Any server that has served a single query has non-zero `hits` for at
    // least one combination, and setupFixtures just ran a schema's worth of
    // DDL immediately before this. An empty array here means the zero-filter
    // is dropping rows it should keep.
    assert.ok(
      (data.io ?? []).length > 0,
      "expected at least one active pg_stat_io row after fixture setup, got an empty array",
    );
  });

  // Every documented field, on every row, including the mostly-NULL ones that
  // only appear with the zero-filter off. A counter that stops being cast to
  // ::text comes back as a JS number from node-pg (int8 OID 20) and silently
  // loses precision past 2^53; a timing that loses its ::float8 tail comes
  // back as a numeric STRING instead. Both are invisible to a substring stub.
  it("returns every counter as a non-negative integer string and every timing as a finite number or null", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version < PG16) return;

    const data = await callIoStats({ includeZeroRows: true, limit: 1000 });
    if (!subqueryRan(data, "io fetch failed", "pg_stat_io")) return;
    const rows = data.io ?? [];
    assert.ok(rows.length > 0, "includeZeroRows:true must return the full matrix, got an empty array");

    for (const row of rows) {
      const label = `${row.backend_type}/${row.io_object}/${row.io_context}`;
      // The three identity columns are what a caller joins on, and two of them
      // are renamed out of quoted keywords ("object" AS io_object, context AS
      // io_context). A rename regression surfaces here as an undefined key.
      assert.equal(typeof row.backend_type, "string", `backend_type must be a string, got ${row.backend_type}`);
      assert.equal(typeof row.io_object, "string", `${label}: io_object must be a string`);
      assert.equal(typeof row.io_context, "string", `${label}: io_context must be a string`);

      for (const field of COUNTER_FIELDS) {
        const value = row[field];
        // null is a real answer, not a gap: pg_stat_io returns NULL where the
        // operation is impossible for the combination (a checkpointer never
        // reuses a strategy buffer). Asserting non-null would force a COALESCE
        // that reports "happened zero times" for "cannot happen here".
        if (value === null) continue;
        assert.equal(typeof value, "string", `${label}: ${field} must arrive as a ::text string, got ${typeof value}`);
        assert.match(value, /^\d+$/, `${label}: ${field} must be a bare decimal integer string, got ${value}`);
        const parsed = Number.parseInt(value, 10);
        assert.ok(
          Number.isInteger(parsed) && parsed >= 0,
          `${label}: ${field} must parse to a non-negative integer, got ${value}`,
        );
      }

      for (const field of TIMING_FIELDS) {
        const value = row[field];
        if (value === null) continue;
        assert.equal(
          typeof value,
          "number",
          `${label}: ${field} must arrive as a JS number (::numeric(18,2)::float8), got ${JSON.stringify(value)}`,
        );
        assert.ok(Number.isFinite(value) && value >= 0, `${label}: ${field} must be finite and >= 0, got ${value}`);
      }

      assert.ok(
        row.stats_reset === null || typeof row.stats_reset === "string",
        `${label}: stats_reset must be string | null, got ${JSON.stringify(row.stats_reset)}`,
      );
    }
  });

  // Both byte-accounting branches must produce the SAME three output names, so
  // a caller never branches on server version to read a byte figure. Only one
  // branch is reachable per server, so this is the assertion that pins whether
  // the branch the running server took is the RIGHT one: naming read_bytes on
  // PG16/17 (or op_bytes on PG18) is a 42703 that takes the whole query down.
  it("normalizes the byte fields on whichever accounting branch the server takes", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version < PG16) return;

    const data = await callIoStats({ includeZeroRows: true, limit: 1000 });
    const isPg18 = version >= PG18;
    // Matched loosely rather than byte-for-byte: the point is which SOURCE
    // produced the numbers, not the exact wording of the descriptor.
    if (isPg18) {
      assert.match(
        data.byte_accounting,
        /native/i,
        `PG18+ (${version}) must report native byte columns, got: ${data.byte_accounting}`,
      );
    } else {
      assert.match(
        data.byte_accounting,
        /op_bytes/,
        `PG16-17 (${version}) must report op_bytes accounting, got: ${data.byte_accounting}`,
      );
    }

    if (!subqueryRan(data, "io fetch failed", "pg_stat_io")) return;
    for (const row of data.io ?? []) {
      const label = `${row.backend_type}/${row.io_object}/${row.io_context}`;
      for (const [byteField, counterField] of BYTE_FIELD_PAIRS) {
        const value = row[byteField];
        if (value === null) continue;
        assert.equal(typeof value, "string", `${label}: ${byteField} must arrive as text, got ${typeof value}`);
        const parsed = Number(value);
        assert.ok(
          Number.isFinite(parsed) && parsed >= 0,
          `${label}: ${byteField} must be a finite non-negative number, got ${value}`,
        );
        assert.ok(Number.isInteger(parsed), `${label}: ${byteField} must be a whole byte count, got ${value}`);
        // Computed branch only: `reads::numeric * op_bytes` propagates NULL by
        // construction, so a non-NULL byte figure next to a NULL counter means
        // a COALESCE crept in and invented a "0 bytes read" measurement for a
        // combination where the operation is not possible at all.
        if (!isPg18) {
          assert.notEqual(
            row[counterField],
            null,
            `${label}: ${byteField}=${value} with ${counterField}=NULL -- the multiplication must propagate NULL`,
          );
        }
      }
    }
  });

  // A real property of the zero-filter, and the cheapest way to prove the
  // WHERE clause narrows rather than rewrites. Both calls use the max limit so
  // neither side is truncated -- pg_stat_io has well under 1000 combinations,
  // and a truncated superset would make the subset relation vacuously fragile.
  it("includeZeroRows:false returns a subset of includeZeroRows:true", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version < PG16) return;

    const all = await callIoStats({ includeZeroRows: true, limit: 1000 });
    const filtered = await callIoStats({ includeZeroRows: false, limit: 1000 });
    if (!subqueryRan(all, "io fetch failed", "pg_stat_io")) return;
    if (!subqueryRan(filtered, "io fetch failed", "pg_stat_io")) return;

    // The echo is what tells a caller whether an empty `io` means "no recorded
    // I/O" or "the view returned nothing", so it has to track the input.
    assert.equal(all.include_zero_rows, true);
    assert.equal(filtered.include_zero_rows, false);

    const key = (r: IoStatsRow) => `${r.backend_type}|${r.io_object}|${r.io_context}`;
    const allKeys = new Set((all.io ?? []).map(key));
    const filteredRows = filtered.io ?? [];
    assert.ok(
      filteredRows.length <= (all.io ?? []).length,
      `filtered (${filteredRows.length}) must not exceed unfiltered (${(all.io ?? []).length})`,
    );
    for (const row of filteredRows) {
      assert.ok(allKeys.has(key(row)), `${key(row)} appeared only with the zero-filter ON -- the filter must narrow`);
      // Self-consistent within one snapshot: the row carries the counters the
      // WHERE clause summed. A regression that drops `hits` from that sum (the
      // shared-buffers success story) shows up here as a surviving row whose
      // only non-zero counter is hits.
      const total = COUNTER_FIELDS.reduce((sum, f) => sum + Number.parseInt(row[f] ?? "0", 10), 0);
      assert.ok(total > 0, `${key(row)} has an all-zero counter set but survived the zero-filter`);
    }
  });

  it("respects limit", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version < PG16) return;

    const all = await callIoStats({ includeZeroRows: true, limit: 1000 });
    if (!subqueryRan(all, "io fetch failed", "pg_stat_io")) return;
    const total = (all.io ?? []).length;

    for (const limit of [1, 3]) {
      const capped = await callIoStats({ includeZeroRows: true, limit });
      if (!subqueryRan(capped, "io fetch failed", "pg_stat_io")) return;
      // Exact, not just <=: a LIMIT $1 that gets dropped in a rewrite returns
      // the full matrix, which a `<=` assertion would miss whenever the matrix
      // happens to be smaller than the requested cap.
      assert.equal(
        (capped.io ?? []).length,
        Math.min(limit, total),
        `limit=${limit} against ${total} available rows must return exactly ${Math.min(limit, total)}`,
      );
      // The same $1 bounds pg_aios, and on a busy PG18 server that list is the
      // one this parameter actually exists to cap.
      if (version >= PG18 && Array.isArray(capped.in_flight)) {
        assert.ok(capped.in_flight.length <= limit, `in_flight must respect limit=${limit}`);
      }
    }
  });

  // Absent vs null is deliberate and load-bearing: `in_flight: []` reads as
  // "nothing is stalled", which is a confident wrong answer on a server that
  // has no way to look. Asserted with Object.hasOwn rather than a null check
  // so a regression that emits the keys with null values still fails.
  it("exposes io_method and in_flight on PG18+ and omits BOTH keys below 18", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version < PG16) return;

    const data = await callIoStats({ includeZeroRows: false, limit: 200 });

    if (version < PG18) {
      const keys = Object.keys(data).join(", ");
      assert.ok(
        !Object.hasOwn(data, "io_method"),
        `io_method must be ABSENT below PG18 (server_version_num=${version}), got keys: ${keys}`,
      );
      assert.ok(
        !Object.hasOwn(data, "in_flight"),
        `in_flight must be ABSENT below PG18 (server_version_num=${version}), got keys: ${keys}`,
      );
      return;
    }

    assert.ok(Object.hasOwn(data, "io_method"), `io_method must be present on PG18+ (server_version_num=${version})`);
    assert.ok(Object.hasOwn(data, "in_flight"), `in_flight must be present on PG18+ (server_version_num=${version})`);

    if (subqueryRan(data, "io_method fetch failed", "io_method")) {
      const method = data.io_method;
      assert.ok(
        method === null || (typeof method === "string" && IO_METHODS.includes(method)),
        `io_method must be null or one of ${IO_METHODS.join(" / ")}, got ${JSON.stringify(method)}`,
      );
    }

    if (!subqueryRan(data, "in_flight fetch failed", "pg_aios")) return;
    // Non-null is the assertion that matters here: the pg_aios query quotes
    // "off" because OFF is a keyword, and a mis-quote is a syntax error the
    // handler swallows into _warnings while still returning ok:true. An empty
    // array is the normal answer on a quiet server (and the only possible
    // answer under io_method=sync), so length is not assertable -- null is.
    assert.ok(
      Array.isArray(data.in_flight),
      `in_flight must be an array on PG18+, got ${JSON.stringify(data.in_flight)}`,
    );
    for (const row of data.in_flight ?? []) {
      assert.equal(typeof row.pid, "number", `in_flight.pid must be a number, got ${JSON.stringify(row.pid)}`);
      assert.equal(typeof row.io_id, "number", `in_flight.io_id must be a number, got ${JSON.stringify(row.io_id)}`);
      // ::text on both, for the same int8-precision reason as the counters --
      // and because ::text is correct whether the column is int4 or int8.
      assert.ok(row.off === null || typeof row.off === "string", "in_flight.off must be string | null");
      assert.ok(row.length === null || typeof row.length === "string", "in_flight.length must be string | null");
    }
  });

  // PG15 is in the WSL matrix precisely for column coverage below the feature
  // gates, so this branch is reachable. The error has to distinguish "your
  // server is too old" (act: upgrade) from "we could not check" (act: retry) --
  // an undifferentiated version error sends an agent to the wrong remediation,
  // so the detected version number is part of the contract, not decoration.
  it("refuses below PG16 with an error naming the version requirement", async () => {
    const version = await probeServerVersionNum();
    if (version === 0 || version >= PG16) return;

    const res = (await ioStats.handler({ includeZeroRows: false, limit: 200 })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false, `expected a refusal on server_version_num=${version}, got ok:true`);
    assert.match(res.error ?? "", /PostgreSQL 16/, `error must name the version requirement, got: ${res.error}`);
    assert.match(res.error ?? "", /pg_stat_io/, `error must name the missing view, got: ${res.error}`);
    assert.match(
      res.error ?? "",
      new RegExp(`server_version_num=${version}\\b`),
      `error must report the detected version so "too old" differs from "could not check", got: ${res.error}`,
    );
  });
});
