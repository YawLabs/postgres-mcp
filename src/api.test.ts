import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import {
  getApplicationName,
  getConnectionTimeoutMs,
  getMaxRows,
  getPool,
  getPoolMax,
  getServerVersionNum,
  getSslConfig,
  getStatementTimeoutMs,
  isWritesAllowed,
  safeResolveTypeNames,
  shutdown,
} from "./api.js";

describe("isWritesAllowed", () => {
  const original = process.env.ALLOW_WRITES;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = original;
  });

  it("defaults to false when unset", () => {
    delete process.env.ALLOW_WRITES;
    assert.equal(isWritesAllowed(), false);
  });

  it("is true for '1'", () => {
    process.env.ALLOW_WRITES = "1";
    assert.equal(isWritesAllowed(), true);
  });

  it("is true for 'true'", () => {
    process.env.ALLOW_WRITES = "true";
    assert.equal(isWritesAllowed(), true);
  });

  it("is false for other truthy-looking strings (strict opt-in)", () => {
    for (const v of ["yes", "y", "on", "TRUE", "True", "0", "false", ""]) {
      process.env.ALLOW_WRITES = v;
      assert.equal(isWritesAllowed(), false, `ALLOW_WRITES=${JSON.stringify(v)} should be false`);
    }
  });
});

describe("getMaxRows", () => {
  const original = process.env.POSTGRES_MAX_ROWS;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_MAX_ROWS;
    else process.env.POSTGRES_MAX_ROWS = original;
  });

  it("defaults to 1000", () => {
    delete process.env.POSTGRES_MAX_ROWS;
    assert.equal(getMaxRows(), 1000);
  });

  it("accepts positive integers", () => {
    process.env.POSTGRES_MAX_ROWS = "50";
    assert.equal(getMaxRows(), 50);
  });

  it("floors fractional values", () => {
    process.env.POSTGRES_MAX_ROWS = "99.9";
    assert.equal(getMaxRows(), 99);
  });

  it("falls back to 1000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_MAX_ROWS = v;
      assert.equal(getMaxRows(), 1000, `POSTGRES_MAX_ROWS=${JSON.stringify(v)} should default`);
    }
  });
});

describe("getPoolMax", () => {
  const original = process.env.POSTGRES_POOL_MAX;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_POOL_MAX;
    else process.env.POSTGRES_POOL_MAX = original;
  });

  it("defaults to 5", () => {
    delete process.env.POSTGRES_POOL_MAX;
    assert.equal(getPoolMax(), 5);
  });

  it("accepts positive integers", () => {
    process.env.POSTGRES_POOL_MAX = "1";
    assert.equal(getPoolMax(), 1);
  });

  it("floors fractional values", () => {
    process.env.POSTGRES_POOL_MAX = "3.7";
    assert.equal(getPoolMax(), 3);
  });

  it("falls back to 5 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_POOL_MAX = v;
      assert.equal(getPoolMax(), 5, `POSTGRES_POOL_MAX=${JSON.stringify(v)} should default`);
    }
  });
});

describe("getConnectionTimeoutMs", () => {
  const original = process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    else process.env.POSTGRES_CONNECTION_TIMEOUT_MS = original;
  });

  it("defaults to 10000", () => {
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    assert.equal(getConnectionTimeoutMs(), 10_000);
  });

  it("accepts positive numbers", () => {
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "2500";
    assert.equal(getConnectionTimeoutMs(), 2500);
  });

  // Unlike getMaxRows / getPoolMax (which floor fractional values because row
  // counts and pool sizes must be integers), getConnectionTimeoutMs preserves
  // fractional input -- pg's connectionTimeoutMillis takes a float. Pinning
  // the design difference so a future "consistency" pass doesn't quietly
  // wrap this in Math.floor and shave sub-ms off configured timeouts.
  it("preserves fractional values (timeouts can be sub-ms)", () => {
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "2500.5";
    assert.equal(getConnectionTimeoutMs(), 2500.5);
  });

  it("falls back to 10000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_CONNECTION_TIMEOUT_MS = v;
      assert.equal(
        getConnectionTimeoutMs(),
        10_000,
        `POSTGRES_CONNECTION_TIMEOUT_MS=${JSON.stringify(v)} should default`,
      );
    }
  });
});

describe("getStatementTimeoutMs", () => {
  const original = process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
    else process.env.POSTGRES_STATEMENT_TIMEOUT_MS = original;
  });

  it("defaults to 30000", () => {
    delete process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
    assert.equal(getStatementTimeoutMs(), 30_000);
  });

  it("accepts positive numbers", () => {
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "5000";
    assert.equal(getStatementTimeoutMs(), 5000);
  });

  it("falls back to 30000 for invalid values", () => {
    for (const v of ["abc", "-5", "0", ""]) {
      process.env.POSTGRES_STATEMENT_TIMEOUT_MS = v;
      assert.equal(
        getStatementTimeoutMs(),
        30_000,
        `POSTGRES_STATEMENT_TIMEOUT_MS=${JSON.stringify(v)} should default`,
      );
    }
  });
});

describe("getSslConfig", () => {
  const original = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    else process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = original;
  });

  it("returns undefined when unset (let pg driver handle URL)", () => {
    delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    assert.equal(getSslConfig(), undefined);
  });

  it("returns rejectUnauthorized=false for 'false'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "false";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: false });
  });

  it("returns rejectUnauthorized=false for '0'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "0";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: false });
  });

  it("returns rejectUnauthorized=true for 'true'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "true";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: true });
  });

  it("returns rejectUnauthorized=true for '1'", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "1";
    assert.deepEqual(getSslConfig(), { rejectUnauthorized: true });
  });

  it("returns undefined for unrecognized values (defers to pg driver)", () => {
    // Stub console.error so the warning written by the unrecognized-value
    // path doesn't fill the test output. The warning itself is asserted in
    // the dedicated describe below.
    const originalErr = console.error;
    console.error = () => {};
    try {
      for (const v of ["yes", "no", "TRUE", "False", "", "maybe"]) {
        process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = v;
        assert.equal(
          getSslConfig(),
          undefined,
          `POSTGRES_SSL_REJECT_UNAUTHORIZED=${JSON.stringify(v)} should return undefined`,
        );
      }
    } finally {
      console.error = originalErr;
    }
  });
});

describe("getSslConfig stderr warning on unrecognized values", () => {
  const original = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
  const originalErr = console.error;
  let stderrCalls: string[] = [];

  beforeEach(() => {
    stderrCalls = [];
    console.error = (msg?: unknown) => {
      stderrCalls.push(String(msg));
    };
  });
  afterEach(() => {
    console.error = originalErr;
    if (original === undefined) delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    else process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = original;
  });

  it("warns once on an unrecognized value (typo, e.g. 'Flase')", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "Flase";
    getSslConfig();
    assert.equal(stderrCalls.length, 1, `expected one stderr line, got ${JSON.stringify(stderrCalls)}`);
    assert.match(stderrCalls[0]!, /POSTGRES_SSL_REJECT_UNAUTHORIZED/);
    assert.match(stderrCalls[0]!, /not recognized/i);
    // Echoes the offending value so the user can find the typo quickly.
    assert.match(stderrCalls[0]!, /Flase/);
  });

  it("warns on an empty string (assignment without value is still a misconfiguration)", () => {
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = "";
    getSslConfig();
    assert.equal(stderrCalls.length, 1);
    assert.match(stderrCalls[0]!, /not recognized/i);
  });

  it("does NOT warn for the recognized values 'true', 'false', '0', '1'", () => {
    for (const v of ["true", "false", "0", "1"]) {
      stderrCalls = [];
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = v;
      getSslConfig();
      assert.equal(stderrCalls.length, 0, `unexpected warning for recognized value ${JSON.stringify(v)}`);
    }
  });

  it("does NOT warn when the env var is unset", () => {
    delete process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
    getSslConfig();
    assert.equal(stderrCalls.length, 0);
  });
});

describe("getApplicationName", () => {
  const original = process.env.POSTGRES_APPLICATION_NAME;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_APPLICATION_NAME;
    else process.env.POSTGRES_APPLICATION_NAME = original;
  });

  it("defaults to 'postgres-mcp' when unset", () => {
    delete process.env.POSTGRES_APPLICATION_NAME;
    assert.equal(getApplicationName(), "postgres-mcp");
  });

  it("accepts a configured value", () => {
    process.env.POSTGRES_APPLICATION_NAME = "my-agent";
    assert.equal(getApplicationName(), "my-agent");
  });

  // An empty or whitespace-only assignment is the shape you get from
  // `POSTGRES_APPLICATION_NAME=` in a shell profile, or an MCP host env block
  // whose value was left blank. Passing that through would make the server
  // anonymous in pg_stat_activity -- the exact thing this var exists to
  // prevent -- so blank falls back to the default rather than to "".
  it("falls back to the default for blank values", () => {
    for (const v of ["", " ", "   ", "\t", "\n"]) {
      process.env.POSTGRES_APPLICATION_NAME = v;
      assert.equal(
        getApplicationName(),
        "postgres-mcp",
        `POSTGRES_APPLICATION_NAME=${JSON.stringify(v)} should default`,
      );
    }
  });

  // trim() is used only as a blankness TEST, not as a normalizer: a non-blank
  // value reaches pg verbatim, padding included. Pinned because the obvious
  // "consistency" refactor (`raw.trim() || "postgres-mcp"`) silently rewrites
  // an operator's configured name, and the only place that difference shows
  // up is a remote server's pg_stat_activity.
  it("returns a non-blank value verbatim, without trimming", () => {
    process.env.POSTGRES_APPLICATION_NAME = "  padded-name  ";
    assert.equal(getApplicationName(), "  padded-name  ");
  });
});

// safeResolveTypeNames is the wrapper around resolveTypeNames whose entire
// reason for existing is: a pg_type lookup failure must not lose the user's
// successful query rows. Engineering that failure against a real DB
// requires a permission-restricted role; a stub client whose .query rejects
// is the cleaner path here, and is the only place we cross the "no mocks"
// boundary in the codebase. The helper is exported from api.ts solely for
// this test.
describe("safeResolveTypeNames fallback on pg_type failure", () => {
  it("returns {} without throwing when the bootstrap pg_type query rejects", async () => {
    // Reset typeNameCache (held inside api.ts as module-scoped state) so
    // the bootstrap branch is forced. Otherwise a prior test in this
    // process may have populated the cache and resolveTypeNames would
    // short-circuit out before reaching the throwing query.
    await shutdown();

    const stubClient = {
      query: () => Promise.reject(new Error("simulated pg_type failure")),
    } as unknown as pg.PoolClient;

    const originalErr = console.error;
    const stderrCalls: string[] = [];
    console.error = (msg?: unknown) => {
      stderrCalls.push(String(msg));
    };
    try {
      // dataTypeID=23 is the int4 oid; the value doesn't matter for this
      // test, only that the field list is non-empty so the wrapper actually
      // attempts a lookup instead of short-circuiting on the empty-input
      // fast path.
      const result = await safeResolveTypeNames(stubClient, [{ dataTypeID: 23 }]);
      assert.deepEqual(result, {}, "wrapper must swallow the error and return an empty map");
      assert.ok(stderrCalls.length > 0, "expected a stderr warning on lookup failure");
      assert.match(stderrCalls[0]!, /type-name resolution failed/i);
      assert.match(stderrCalls[0]!, /simulated pg_type failure/);
    } finally {
      console.error = originalErr;
    }
  });

  it("returns {} (no work, no throw) when called with an empty field list", async () => {
    // No client interaction expected -- helper must short-circuit. Stub
    // throws if anyone touches it, which would surface as a rejection.
    const stubClient = {
      query: () => {
        throw new Error("safeResolveTypeNames should not have called .query on empty input");
      },
    } as unknown as pg.PoolClient;
    const result = await safeResolveTypeNames(stubClient, []);
    assert.deepEqual(result, {});
  });

  // shutdown() nulls the module-scoped typeNameCache, and it can land while
  // resolveTypeNames is suspended on the bootstrap query -- SIGTERM during a
  // tool call, or a test calling shutdown() between calls. Dereferencing the
  // module variable after the await then throws on null; the type names are
  // lost (swallowed by the wrapper) even though the query succeeded.
  //
  // The stub calls shutdown() DURING the bootstrap query, reproducing exactly
  // that interleaving without timing luck. Correct behavior: the resolved
  // names still come back, and no failure warning is written.
  it("still resolves type names when shutdown() lands mid-bootstrap", async () => {
    await shutdown();

    let queries = 0;
    const stubClient = {
      query: async () => {
        queries++;
        // Null the cache the way a signal handler would, mid-flight.
        await shutdown();
        return { rows: [{ oid: 23, typname: "int4" }] };
      },
    } as unknown as pg.PoolClient;

    const originalErr = console.error;
    const stderrCalls: string[] = [];
    console.error = (msg?: unknown) => {
      stderrCalls.push(String(msg));
    };
    try {
      const result = await safeResolveTypeNames(stubClient, [{ dataTypeID: 23 }]);
      assert.deepEqual(result, { 23: "int4" }, "a concurrent shutdown() must not lose the resolved type names");
      assert.equal(
        stderrCalls.length,
        0,
        `no failure warning expected, got ${JSON.stringify(stderrCalls)} -- the null-cache dereference is back`,
      );
      // One bootstrap only: the oid resolved from it, so no miss-fill round trip.
      assert.equal(queries, 1);
    } finally {
      console.error = originalErr;
    }
  });
});

describe("getPool without DATABASE_URL", () => {
  const original = process.env.DATABASE_URL;
  const originalPlatform = process.platform;

  function setPlatform(value: string) {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  afterEach(async () => {
    setPlatform(originalPlatform);
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    await shutdown();
  });

  // This is the first error a misconfigured user ever sees, and nothing
  // covered it -- the individual env getters are well tested but the
  // missing-DSN path was not.
  it("throws a clear error naming DATABASE_URL", async () => {
    await shutdown();
    delete process.env.DATABASE_URL;
    assert.throws(() => getPool(), /DATABASE_URL is not set/);
  });

  it("treats a whitespace-only DATABASE_URL as unset", async () => {
    await shutdown();
    process.env.DATABASE_URL = "   ";
    assert.throws(() => getPool(), /DATABASE_URL is not set/);
  });

  // The Windows-specific hint exists because env vars set in a bash/WSL
  // profile are invisible to an MCP server launched via cmd -- a real support
  // case. It is platform-gated, so it never runs on a Linux CI box unless the
  // platform is faked.
  it("appends the .mcp.json hint on win32 and omits it elsewhere", async () => {
    await shutdown();
    delete process.env.DATABASE_URL;

    setPlatform("win32");
    assert.throws(() => getPool(), /\.mcp\.json/, "win32 must surface the env-block hint");

    setPlatform("linux");
    assert.throws(
      () => getPool(),
      (err: unknown) =>
        err instanceof Error && /DATABASE_URL is not set/.test(err.message) && !/\.mcp\.json/.test(err.message),
      "non-win32 must not carry the Windows hint",
    );
  });
});

// shutdown() races `pool.end()` against a 5s timeout so a wedged query cannot
// stall process exit forever, and the LOSER of that race has to be cleaned up:
// an un-cleared setTimeout holds the event loop open for its full 5 seconds, so
// a process with nothing left to do still waits. Invisible under index.ts (a
// process.exit follows immediately) but a 5s stall for any in-process embedder
// -- or a test file -- that calls shutdown() and expects to carry on.
//
// process.getActiveResourcesInfo() names every handle currently keeping the
// loop alive, one "Timeout" entry per live timer. The assertion is a DELTA, not
// a count of zero: the test runner owns timers of its own, and only the ones
// this shutdown() adds are ours to answer for. Confirmed to distinguish the two
// shapes rather than pass vacuously -- with the clearTimeout removed the delta
// is 1 and the test process lingers ~5s at exit.
describe("shutdown timer cleanup", () => {
  const original = process.env.DATABASE_URL;
  afterEach(async () => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    await shutdown();
  });

  function liveTimers(): number {
    return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  }

  it("clears the 5s race timer instead of leaving a live handle behind", async () => {
    await shutdown();
    // A parseable DSN that nothing ever dials. getPool() only CONSTRUCTS the
    // pool -- pg connects lazily, on the first connect()/query() -- and end()
    // on a pool with no clients resolves immediately, so shutdown() gets a real
    // pool to race against without this becoming an integration test. The
    // non-null pool is load-bearing: with `pool === null` shutdown() returns
    // before the timer is ever created and the assertion below proves nothing.
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/postgres_mcp_never_dialed";
    assert.ok(getPool(), "sanity: shutdown() needs a real pool for the race to run at all");

    const before = liveTimers();
    await shutdown();
    assert.equal(
      liveTimers(),
      before,
      "shutdown() left its 5s race timer live -- the event loop stays open for the full timeout",
    );
  });
});

// getServerVersionNum gates nearly every version-dependent catalog query in
// the codebase, and its whole contract lives in module-scoped cache state:
// what is cached, what deliberately is not, and what a concurrent shutdown()
// is allowed to publish. Same stub-client approach as the safeResolveTypeNames
// tests above -- the probe is a single GUC read, so a stub whose .query
// resolves or rejects on demand reaches every branch without a live server.
describe("getServerVersionNum", () => {
  const original = process.env.DATABASE_URL;

  // Every test here starts from a cleared cache and leaves one behind, so a
  // stubbed version can never leak into another suite in this file.
  beforeEach(async () => {
    await shutdown();
  });
  afterEach(async () => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    await shutdown();
  });

  /** Stub probe that resolves `server_version_num` and counts its calls. */
  function countingProbe(value: string) {
    const state = { queries: 0 };
    const client = {
      query: async () => {
        state.queries++;
        return { rows: [{ v: value }] };
      },
    } as unknown as pg.PoolClient;
    return { client, state };
  }

  it("returns the parsed server_version_num from a successful probe", async () => {
    const { client } = countingProbe("180000");
    assert.equal(await getServerVersionNum(client), 180_000);
  });

  it("caches a successful read -- a second call does not re-probe", async () => {
    const { client, state } = countingProbe("160000");
    assert.equal(await getServerVersionNum(client), 160_000);
    assert.equal(await getServerVersionNum(client), 160_000);
    assert.equal(state.queries, 1, "second call re-queried; the version cache is not being consulted");
  });

  // Failures are deliberately NOT cached. Caching the 0 sentinel would pin the
  // process to degraded (pre-feature) output for its whole lifetime after one
  // transient blip on the very first tool call -- the probe is a single cheap
  // GUC read, so retrying costs far less than being permanently wrong.
  it("does not cache a failed probe -- a later call still gets the real version", async () => {
    const failing = {
      query: () => Promise.reject(new Error("simulated probe failure")),
    } as unknown as pg.PoolClient;
    assert.equal(await getServerVersionNum(failing), 0, "a throwing probe must report the assume-oldest sentinel");

    const { client, state } = countingProbe("170000");
    assert.equal(await getServerVersionNum(client), 170_000, "0 was cached; the process is stuck on degraded output");
    assert.equal(state.queries, 1);
  });

  // Same reasoning as the throwing probe, one branch over: a probe that
  // RESOLVES but with something unusable (empty result set, non-numeric GUC,
  // a non-positive number) also reports 0, and must not be cached either.
  it("does not cache an unparseable or non-positive reading", async () => {
    for (const bad of ["", "not-a-number", "0", "-1"]) {
      const stub = {
        query: async () => ({ rows: [{ v: bad }] }),
      } as unknown as pg.PoolClient;
      assert.equal(await getServerVersionNum(stub), 0, `v=${JSON.stringify(bad)} should report the 0 sentinel`);
    }

    const empty = { query: async () => ({ rows: [] }) } as unknown as pg.PoolClient;
    assert.equal(await getServerVersionNum(empty), 0, "an empty result set should report the 0 sentinel");

    const { client, state } = countingProbe("180000");
    assert.equal(await getServerVersionNum(client), 180_000, "a bad reading was cached and now serves 0 forever");
    assert.equal(state.queries, 1);
  });

  // getPool() throws when DATABASE_URL is missing, and that throw happens
  // INSIDE the try -- so a misconfigured server degrades to pre-feature
  // queries instead of every version-gated tool call blowing up.
  it("returns 0 rather than throwing when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    assert.equal(await getServerVersionNum(), 0);
  });

  // The explicit-client overload is what lets the probe ride along on the
  // shared client inside withSharedClient instead of checking out a second
  // connection. Deleting DATABASE_URL first makes the assertion load-bearing:
  // if the argument were ignored, getPool() would throw and this would be 0.
  it("uses an explicitly passed client instead of the pool", async () => {
    delete process.env.DATABASE_URL;
    const { client, state } = countingProbe("180000");
    assert.equal(await getServerVersionNum(client), 180_000);
    assert.equal(state.queries, 1, "the explicit client was never queried");
  });

  // A rebuilt pool may point at a different DATABASE_URL (tests in this file
  // do exactly that), so a version surviving shutdown() would gate catalog
  // queries against the wrong server.
  it("shutdown() clears the cached version", async () => {
    const first = countingProbe("160000");
    assert.equal(await getServerVersionNum(first.client), 160_000);
    assert.equal(await getServerVersionNum(first.client), 160_000);
    assert.equal(first.state.queries, 1);

    await shutdown();

    const second = countingProbe("180000");
    assert.equal(await getServerVersionNum(second.client), 180_000, "the pre-shutdown version survived the reset");
    assert.equal(second.state.queries, 1);
  });

  // Generation-counter race, the scalar twin of the "shutdown() lands
  // mid-bootstrap" case in safeResolveTypeNames above. A probe suspended on
  // its await when shutdown() lands describes a pool that no longer exists;
  // publishing that reading hands the NEW pool the OLD server's version. The
  // gate releases the probe only AFTER shutdown() has run, so the interleaving
  // is reproduced exactly rather than by timing luck.
  //
  // Correct behavior is split: the caller that asked still gets the reading
  // (it was true when it asked), but the cache stays empty so the next caller
  // re-probes the new pool.
  it("does not publish a version read across a shutdown() that landed mid-probe", async () => {
    let releaseProbe: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const stale = {
      query: async () => {
        await gate;
        return { rows: [{ v: "160000" }] };
      },
    } as unknown as pg.PoolClient;

    const inFlight = getServerVersionNum(stale);
    // Lands while the probe is parked on `gate` -- SIGTERM mid-tool-call, or
    // a test tearing the pool down between calls.
    await shutdown();
    releaseProbe();
    assert.equal(await inFlight, 160_000, "the caller that asked must still get its own reading");

    const fresh = countingProbe("180000");
    assert.equal(
      await getServerVersionNum(fresh.client),
      180_000,
      "the pre-shutdown version was republished into the new pool's cache",
    );
    assert.equal(fresh.state.queries, 1, "the stale reading short-circuited the fresh probe");
  });
});
