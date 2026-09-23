import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { runReadOnly, shutdown, withSharedClient } from "./api.js";
import { type McpToolResponse, wrapToolHandler } from "./mcp-wrapper.js";

// ─────────────────────────────────────────────────────────────────────────
// GAP 1: the index.ts MCP wrapper maps handler results to the MCP envelope.
//
// `wrapToolHandler` is the exact function index.ts registers on every tool
// (index.ts passes `wrapToolHandler(tool.handler, tool.name)` to
// `registerTool`). Testing it directly exercises the production mapping with no
// replication/drift. The second argument is what tags the tool's audit lines --
// see the audit-context test at the bottom of this file.
// ─────────────────────────────────────────────────────────────────────────

describe("wrapToolHandler: ok result -> content block (no isError)", () => {
  it("serializes data as pretty JSON in a single text block", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: { rows: [1, 2], count: 2 } }), "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, undefined, "success response must not set isError");
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0]!.type, "text");
    // Pretty-printed with 2-space indent (JSON.stringify(data, null, 2)).
    assert.equal(res.content[0]!.text, JSON.stringify({ rows: [1, 2], count: 2 }, null, 2));
    assert.match(res.content[0]!.text, /\n {2}"rows"/, "expected 2-space pretty indentation");
  });

  it("substitutes { success: true } when ok is true but data is absent", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true }), "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0]!.text, JSON.stringify({ success: true }, null, 2));
  });

  it("substitutes { success: true } when data is explicitly null/undefined", async () => {
    for (const data of [null, undefined]) {
      const wrapped = wrapToolHandler(async () => ({ ok: true, data }), "pg_test");
      const res = await wrapped({});
      // `data ?? { success: true }` -- nullish coalescing, so both null and
      // undefined fall through to the success sentinel.
      assert.equal(res.content[0]!.text, JSON.stringify({ success: true }, null, 2));
    }
  });

  it("preserves falsy-but-defined data (0, false, '', []) instead of the sentinel", async () => {
    // ?? only catches null/undefined, so a falsy-but-present payload must be
    // serialized verbatim -- NOT replaced by { success: true }.
    for (const data of [0, false, "", []] as const) {
      const wrapped = wrapToolHandler(async () => ({ ok: true, data }), "pg_test");
      const res = await wrapped({});
      assert.equal(res.content[0]!.text, JSON.stringify(data, null, 2));
      assert.equal(res.isError, undefined);
    }
  });
});

describe("wrapToolHandler: malformed (non-ApiResponse) result -> distinct isError block", () => {
  it("maps a result missing the `ok` property to the malformed-result message", async () => {
    // A handler that returns a raw value instead of the `{ ok, data? }`
    // contract must NOT collapse into 'Unknown error' -- it gets a distinct,
    // diagnosable message so the misbehaving handler is obvious.
    for (const value of [42, { rows: [] }, "plain string"] as const) {
      const wrapped = wrapToolHandler(async () => value, "pg_test");
      const res = await wrapped({});
      assert.equal(res.isError, true);
      assert.equal(res.content[0]!.text, "Error: tool handler returned a malformed result (missing ok)");
    }
  });

  it("maps a null result to the malformed-result message (not 'Unknown error')", async () => {
    const wrapped = wrapToolHandler(async () => null, "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "Error: tool handler returned a malformed result (missing ok)");
  });
});

describe("wrapToolHandler: bigint data serializes as a string (no JSON crash)", () => {
  it("serializes a top-level bigint payload as its decimal string", async () => {
    // JSON.stringify throws on BigInt by default; the replacer must convert it.
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: 10n }), "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, undefined, "bigint serialization must not be treated as an error");
    assert.equal(res.content[0]!.text, '"10"');
  });

  it("serializes nested bigint values inside an object payload", async () => {
    const wrapped = wrapToolHandler(
      async () => ({ ok: true, data: { id: 9007199254740993n, name: "row" } }),
      "pg_test",
    );
    const res = await wrapped({});
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0]!.text, JSON.stringify({ id: "9007199254740993", name: "row" }, null, 2));
  });
});

describe("wrapToolHandler: { ok: false } result -> isError 'Error: <msg>' block", () => {
  it("maps a handler error string to an isError text block", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: false, error: "permission denied for table users" }), "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0]!.type, "text");
    assert.equal(res.content[0]!.text, "Error: permission denied for table users");
  });

  it("falls back to 'Unknown error' when ok is false with no error string", async () => {
    // `response.error || "Unknown error"` -- empty/absent error -> sentinel.
    for (const handler of [
      async () => ({ ok: false }),
      async () => ({ ok: false, error: "" }),
      async () => ({ ok: false, error: undefined }),
    ]) {
      const wrapped = wrapToolHandler(handler, "pg_test");
      const res = await wrapped({});
      assert.equal(res.isError, true);
      assert.equal(res.content[0]!.text, "Error: Unknown error");
    }
  });
});

describe("wrapToolHandler: a THROWN exception -> its own isError block", () => {
  it("catches a thrown Error and surfaces err.message", async () => {
    const wrapped = wrapToolHandler(async () => {
      throw new Error("boom from inside the handler");
    }, "pg_test");
    // Must resolve (not reject) -- the wrapper's job is to never let a tool
    // throw bubble out and crash the server.
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "Error: boom from inside the handler");
  });

  it("stringifies a non-Error throw (String(err)) rather than crashing", async () => {
    const wrapped = wrapToolHandler(async () => {
      // Deliberately throwing a non-Error to exercise the String(err) branch.
      throw "a bare string rejection";
    }, "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "Error: a bare string rejection");
  });

  it("handles a rejected promise from the handler (async throw)", async () => {
    const wrapped = wrapToolHandler(() => Promise.reject(new Error("async rejection")), "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "Error: async rejection");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MCP structured tool output (spec revision 2025-06-18).
//
// index.ts declares an `outputSchema` on every tool, and from that point the
// SDK REJECTS any successful result whose `structuredContent` is missing or
// fails to parse. These tests pin the half of that contract this module owns:
// what goes into the key, that `content` keeps its pre-existing form beside it,
// and that no error path acquires one.
// ─────────────────────────────────────────────────────────────────────────

describe("wrapToolHandler: structuredContent mirrors the content text", () => {
  it("carries an object payload through unchanged, byte-identical to the text block", async () => {
    const data = { rows: [{ id: 1 }], rowCount: 1, nested: { a: [1, 2] } };
    const wrapped = wrapToolHandler(async () => ({ ok: true, data }), "pg_test");
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, data);
    // The two halves must never disagree -- a client reading `content` and one
    // reading `structuredContent` have to see the same answer.
    assert.deepEqual(res.structuredContent, JSON.parse(res.content[0]!.text));
  });

  it("wraps a BARE ARRAY payload as { rows } while content keeps the unwrapped array", async () => {
    // structuredContent must be a JSON object, but the list tools resolve to
    // arrays. The wrap lives here and in tools/output.ts:rowsOutput; `content`
    // stays unwrapped so no client reading it today sees a changed payload.
    const data = [{ schema_name: "public" }, { schema_name: "app" }];
    const wrapped = wrapToolHandler(async () => ({ ok: true, data }), "pg_test");
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, { rows: data });
    assert.equal(res.content[0]!.text, JSON.stringify(data, null, 2));
    assert.equal(Array.isArray(JSON.parse(res.content[0]!.text)), true, "content must stay a bare array");
  });

  it("wraps an EMPTY array too (an empty list is a real answer, not a missing one)", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: [] }), "pg_test");
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, { rows: [] });
    assert.equal(res.content[0]!.text, "[]");
  });

  it("carries the { success: true } sentinel when ok is true but data is absent", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true }), "pg_test");
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, { success: true });
  });

  it("omits structuredContent for a scalar payload rather than inventing a wrapper key", async () => {
    // 0/false/'' have no object form. Inventing one (`{ value: 0 }`) would
    // advertise a shape no tool's outputSchema declares, so the key is left
    // off and `content` still carries the value verbatim.
    for (const data of [0, false, "", 42, "plain"] as const) {
      const wrapped = wrapToolHandler(async () => ({ ok: true, data }), "pg_test");
      const res = await wrapped({});
      assert.equal("structuredContent" in res, false, `scalar ${JSON.stringify(data)} produced structuredContent`);
      assert.equal(res.content[0]!.text, JSON.stringify(data, null, 2));
      assert.equal(res.isError, undefined);
    }
  });

  it("stringifies bigints INSIDE structuredContent, not only in the text block", async () => {
    // structuredContent is a live object the transport serializes later. A
    // bigint left in it throws "Do not know how to serialize a BigInt" inside
    // the SDK, outside this module's try/catch, where nothing is left to shape
    // it into an error envelope -- so the value must already be a string here.
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: { id: 9007199254740993n, ok: true } }), "pg_test");
    const res = await wrapped({});
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { id: "9007199254740993", ok: true });
    // The whole envelope has to survive the transport's own JSON.stringify.
    assert.doesNotThrow(() => JSON.stringify(res));
  });
});

describe("wrapToolHandler: no error path carries structuredContent", () => {
  it("omits it on { ok: false }, on a throw, and on a malformed result", async () => {
    // The SDK skips output validation once isError is set, so a structured
    // body there would be an unvalidated object matching no outputSchema. The
    // error text is the entire answer an error response has.
    const handlers: ((input: unknown) => Promise<unknown>)[] = [
      async () => ({ ok: false, error: "permission denied" }),
      async () => ({ ok: false }),
      async () => {
        throw new Error("boom");
      },
      async () => null,
      async () => 42,
    ];
    for (const handler of handlers) {
      const res = await wrapToolHandler(handler, "pg_test")({});
      assert.equal(res.isError, true);
      assert.equal("structuredContent" in res, false, "an error envelope must not carry structuredContent");
      assert.match(res.content[0]!.text, /^Error: /);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GAP 2: withSharedClient connect failure propagates as a THROW (not
// {ok:false}); the index.ts wrapper's outer catch shapes it into an error
// response rather than crashing.
//
// Faithful boundary: we drive the REAL `withSharedClient` from api.ts with a
// deterministic connect failure (stub `pg.Pool.prototype.connect` to reject,
// the same pg client boundary api.test.ts stubs). No network, no live DB.
// ─────────────────────────────────────────────────────────────────────────

describe("withSharedClient connect failure propagates as a throw", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    // Force getPool() to rebuild a fresh pool against our stub. A DATABASE_URL
    // must be present or getPool() throws on construction before connect() is
    // ever reached -- that's a different failure path than the one under test.
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.reject(new Error("connect ECONNREFUSED: pool could not acquire a client"));
    } as typeof pg.Pool.prototype.connect;
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("rejects (does NOT swallow into {ok:false}) when the pool can't connect", async () => {
    // This pins the documented contract in api.ts:withSharedClient: connect
    // failures propagate as exceptions, unlike runInternal which catches them.
    await assert.rejects(
      withSharedClient(async (run) => run("SELECT 1")),
      /pool could not acquire a client/,
    );
  });

  it("throws the connect failure from the callback's first statement, and sends nothing after it", async () => {
    // The checkout happens inside the first statement's audited step (#42),
    // so the callback starts -- composing SQL is all any caller does before
    // its first statement -- and its first `run` is where the failure lands.
    let reachedSecond = false;
    await assert.rejects(
      withSharedClient(async (run) => {
        await run("SELECT 1");
        reachedSecond = true;
        return run("SELECT 2");
      }),
      /pool could not acquire a client/,
    );
    assert.equal(reachedSecond, false, "the callback must not get past the statement that found no connection");
  });
});

describe("withSharedClient discard: a connection with dirty session state is destroyed, not pooled", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalDbUrl = process.env.DATABASE_URL;
  let releases: unknown[] = [];

  beforeEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    releases = [];
    const client = {
      query: async () => ({ rows: [], rowCount: 0 }),
      release: (err?: unknown) => {
        releases.push(err);
      },
      on() {
        return this;
      },
      removeListener() {
        return this;
      },
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  // pg-pool keeps a client released with no argument and destroys one released
  // with an Error, so the release argument IS the contract.
  it("releases with no error when the callback does not discard", async () => {
    await withSharedClient(async (run) => run("SELECT 1"));
    assert.deepEqual(releases, [undefined]);
  });

  it("releases with the first discard reason, even when the callback then throws, and logs it", async () => {
    const first = new Error("first");
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await assert.rejects(
        withSharedClient(async (run, { discard }) => {
          // The checkout exists from the first statement (#42); a discard
          // before any statement would have nothing to destroy.
          await run("SELECT 1");
          discard(first);
          discard(new Error("second"));
          throw new Error("callback failed");
        }),
        /callback failed/,
      );
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(releases, [first]);
    // pg-pool drops the client silently; without this line a teardown that
    // keeps failing churns connections with no trace on stderr.
    assert.deepEqual(logged, ["[postgres-mcp] discarding pooled connection: first"]);
  });
});

describe("a checked-out client has an 'error' listener for as long as it is checked out", () => {
  // pg-pool removes its idle-error listener when a client is checked out and
  // re-adds it on release, and node-pg emits 'error' on the client when its
  // socket dies. A real EventEmitter stands in for the client because it does
  // what pg's does with no listener: throws from the emit. Measured on
  // PostgreSQL 15: pg_terminate_backend on a checked-out client raised two
  // uncaught exceptions with no listener and none with one.
  class FakeClient extends EventEmitter {
    releases: unknown[] = [];
    async query(sql: unknown) {
      const text = typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
      if (text.startsWith("FETCH")) return { rows: [{ n: 1 }], fields: [], command: "FETCH", rowCount: 1 };
      return { rows: [], fields: [], command: "", rowCount: 0 };
    }
    release(err?: unknown) {
      this.releases.push(err);
    }
  }
  const originalConnect = pg.Pool.prototype.connect;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalError = console.error;
  let client: FakeClient;
  let logged: string[];

  beforeEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    client = new FakeClient();
    logged = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  });

  afterEach(async () => {
    console.error = originalError;
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("withSharedClient: attached from the first statement's checkout, removed after release", async () => {
    assert.equal(client.listenerCount("error"), 0);
    await withSharedClient(async (run) => {
      // Nothing is checked out until the first statement asks (#42), so
      // there is nothing yet for a listener to guard.
      assert.equal(client.listenerCount("error"), 0, "checked out before the first statement");
      await run("SELECT 1");
      assert.equal(client.listenerCount("error"), 1, "no error listener while checked out");
      return undefined;
    });
    assert.equal(client.listenerCount("error"), 0, "the listener outlived the checkout");
    assert.deepEqual(client.releases, [undefined]);
  });

  it("withSharedClient: a socket death while checked out is logged, not thrown", async () => {
    await withSharedClient(async (run) => {
      await run("SELECT 1");
      // Exactly what node-pg does from the socket callback.
      client.emit("error", new Error("Connection terminated unexpectedly"));
      return undefined;
    });
    assert.deepEqual(logged, [
      "[postgres-mcp] connection error on a checked-out client: Connection terminated unexpectedly",
    ]);
  });

  it("runReadOnly: attached while the transaction runs, removed after release", async () => {
    let during = -1;
    const result = await runReadOnly("SELECT 1", [], {
      setup: async () => {
        during = client.listenerCount("error");
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(during, 1, "no error listener while checked out");
    assert.equal(client.listenerCount("error"), 0, "the listener outlived the checkout");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The row-cap DECLARE may fall back to a direct run ONLY when postgres says the
// statement cannot be a cursor (42601, 0A000 -- measured on 15/17/18 over 69
// statement classes). It used to fall back on ANY DECLARE failure. DECLARE is
// where a statement waits for its table locks, so a cancel landing on a
// lock-blocked statement was swallowed and the SQL sent again; a statement
// timeout got a second full timeout; and a terminate had its 57P01 replaced by
// the error of a ROLLBACK TO sent down the dead socket.
//
// The stub records every statement, so "was the SQL sent again" is a direct
// read of what reached the client and not an inference from the result.
// ─────────────────────────────────────────────────────────────────────────
describe("runUserQueryBounded: only a 'cannot be a cursor' DECLARE failure falls back", () => {
  const USER_SQL = "SELECT 42 AS answer";
  const originalConnect = pg.Pool.prototype.connect;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalError = console.error;
  let sent: string[];

  function installClient(declareError: Error) {
    sent = [];
    const client = {
      on() {
        return this;
      },
      removeListener() {
        return this;
      },
      release() {},
      async query(q: unknown) {
        const text = typeof q === "string" ? q : ((q as { text?: string }).text ?? "");
        sent.push(text);
        if (text.startsWith("DECLARE")) throw declareError;
        if (text === USER_SQL) return { rows: [{ answer: 42 }], fields: [], command: "SELECT", rowCount: 1 };
        return { rows: [], fields: [], command: "", rowCount: 0 };
      },
    };
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.resolve(client);
    } as unknown as typeof pg.Pool.prototype.connect;
  }

  const pgError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
  const sentDirectly = () => sent.filter((s) => s === USER_SQL).length;

  beforeEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    // finishTransaction logs the discard of a dead connection; keep it off the
    // test output.
    console.error = () => {};
  });

  afterEach(async () => {
    console.error = originalError;
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  for (const code of ["42601", "0A000"]) {
    it(`${code}: not cursorable -> rolls back to the savepoint and runs the SQL directly, once`, async () => {
      installClient(pgError("cannot be a cursor", code));
      const res = await runReadOnly(USER_SQL);
      assert.equal(res.ok, true, res.error);
      assert.deepEqual(res.data?.rows, [{ answer: 42 }]);
      assert.equal(sentDirectly(), 1);
      assert.ok(sent.includes("ROLLBACK TO SAVEPOINT __pgmcp_sp"), `no savepoint rollback in ${JSON.stringify(sent)}`);
    });
  }

  it("57014: a cancel or statement timeout inside DECLARE is surfaced, and the SQL is NOT sent again", async () => {
    installClient(pgError("canceling statement due to user request", "57014"));
    const res = await runReadOnly(USER_SQL);
    assert.equal(res.ok, false, "a cancelled statement came back as a success");
    assert.match(res.error ?? "", /canceling statement due to user request \(code: 57014\)/);
    assert.equal(sentDirectly(), 0, `the cancelled SQL was re-run: ${JSON.stringify(sent)}`);
  });

  it("57P01: a terminate inside DECLARE keeps its own SQLSTATE, and nothing is sent down the savepoint path", async () => {
    installClient(pgError("terminating connection due to administrator command", "57P01"));
    const res = await runReadOnly(USER_SQL);
    assert.equal(res.ok, false);
    // The old fallback sent ROLLBACK TO on the dead socket, and THAT error --
    // "Connection terminated unexpectedly", no code -- replaced this one.
    assert.match(res.error ?? "", /\(code: 57P01\)/);
    assert.equal(sent.includes("ROLLBACK TO SAVEPOINT __pgmcp_sp"), false);
    assert.equal(sentDirectly(), 0);
  });

  it("no SQLSTATE at all (a dead socket): surfaced, not retried", async () => {
    installClient(pgError("Connection terminated unexpectedly"));
    const res = await runReadOnly(USER_SQL);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Connection terminated unexpectedly/);
    assert.equal(sentDirectly(), 0);
  });

  it("42P01: a statement that is simply wrong is surfaced from DECLARE, once", async () => {
    installClient(pgError('relation "nope" does not exist', "42P01"));
    const res = await runReadOnly(USER_SQL);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /relation "nope" does not exist \(code: 42P01\)/);
    assert.equal(sentDirectly(), 0);
  });
});

describe("index.ts wrapper shapes a withSharedClient connect throw into an error response", () => {
  const originalConnect = pg.Pool.prototype.connect;
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
    pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
      return Promise.reject(new Error("connect ECONNREFUSED: pool could not acquire a client"));
    } as typeof pg.Pool.prototype.connect;
  });

  afterEach(async () => {
    pg.Pool.prototype.connect = originalConnect;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("returns isError envelope (process does not crash) for a handler that uses withSharedClient", async () => {
    // Mirror a real tool handler (pg_health etc.): the handler returns
    // withSharedClient(...), whose connect rejection bubbles out as a throw.
    // The wrapper's outer catch must convert it to an error content block.
    const handler = async () => withSharedClient(async (run) => run("SELECT version()"));
    const wrapped = wrapToolHandler(handler as (input: unknown) => Promise<unknown>, "pg_test");

    // Resolves, not rejects -- if the wrapper let the throw bubble, this await
    // would reject and fail the test. Reaching the assertions proves it
    // absorbed the throw into a response envelope.
    const res: McpToolResponse = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.type, "text");
    assert.match(res.content[0]!.text, /^Error: /);
    assert.match(res.content[0]!.text, /pool could not acquire a client/);
  });
});
