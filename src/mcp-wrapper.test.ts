import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { shutdown, withSharedClient } from "./api.js";
import { type McpToolResponse, wrapToolHandler } from "./mcp-wrapper.js";

// ─────────────────────────────────────────────────────────────────────────
// GAP 1: the index.ts MCP wrapper maps handler results to the MCP envelope.
//
// `wrapToolHandler` is the exact function index.ts registers on every tool
// (index.ts passes `wrapToolHandler(tool.handler)` to `server.tool`). Testing
// it directly exercises the production mapping with no replication/drift.
// ─────────────────────────────────────────────────────────────────────────

describe("wrapToolHandler: ok result -> content block (no isError)", () => {
  it("serializes data as pretty JSON in a single text block", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: { rows: [1, 2], count: 2 } }));
    const res = await wrapped({});
    assert.equal(res.isError, undefined, "success response must not set isError");
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0]!.type, "text");
    // Pretty-printed with 2-space indent (JSON.stringify(data, null, 2)).
    assert.equal(res.content[0]!.text, JSON.stringify({ rows: [1, 2], count: 2 }, null, 2));
    assert.match(res.content[0]!.text, /\n {2}"rows"/, "expected 2-space pretty indentation");
  });

  it("substitutes { success: true } when ok is true but data is absent", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true }));
    const res = await wrapped({});
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0]!.text, JSON.stringify({ success: true }, null, 2));
  });

  it("substitutes { success: true } when data is explicitly null/undefined", async () => {
    for (const data of [null, undefined]) {
      const wrapped = wrapToolHandler(async () => ({ ok: true, data }));
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
      const wrapped = wrapToolHandler(async () => ({ ok: true, data }));
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
      const wrapped = wrapToolHandler(async () => value);
      const res = await wrapped({});
      assert.equal(res.isError, true);
      assert.equal(res.content[0]!.text, "Error: tool handler returned a malformed result (missing ok)");
    }
  });

  it("maps a null result to the malformed-result message (not 'Unknown error')", async () => {
    const wrapped = wrapToolHandler(async () => null);
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "Error: tool handler returned a malformed result (missing ok)");
  });
});

describe("wrapToolHandler: bigint data serializes as a string (no JSON crash)", () => {
  it("serializes a top-level bigint payload as its decimal string", async () => {
    // JSON.stringify throws on BigInt by default; the replacer must convert it.
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: 10n }));
    const res = await wrapped({});
    assert.equal(res.isError, undefined, "bigint serialization must not be treated as an error");
    assert.equal(res.content[0]!.text, '"10"');
  });

  it("serializes nested bigint values inside an object payload", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: { id: 9007199254740993n, name: "row" } }));
    const res = await wrapped({});
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0]!.text, JSON.stringify({ id: "9007199254740993", name: "row" }, null, 2));
  });
});

describe("wrapToolHandler: { ok: false } result -> isError 'Error: <msg>' block", () => {
  it("maps a handler error string to an isError text block", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: false, error: "permission denied for table users" }));
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
      const wrapped = wrapToolHandler(handler);
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
    });
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
    });
    const res = await wrapped({});
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "Error: a bare string rejection");
  });

  it("handles a rejected promise from the handler (async throw)", async () => {
    const wrapped = wrapToolHandler(() => Promise.reject(new Error("async rejection")));
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
    const wrapped = wrapToolHandler(async () => ({ ok: true, data }));
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
    const wrapped = wrapToolHandler(async () => ({ ok: true, data }));
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, { rows: data });
    assert.equal(res.content[0]!.text, JSON.stringify(data, null, 2));
    assert.equal(Array.isArray(JSON.parse(res.content[0]!.text)), true, "content must stay a bare array");
  });

  it("wraps an EMPTY array too (an empty list is a real answer, not a missing one)", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: [] }));
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, { rows: [] });
    assert.equal(res.content[0]!.text, "[]");
  });

  it("carries the { success: true } sentinel when ok is true but data is absent", async () => {
    const wrapped = wrapToolHandler(async () => ({ ok: true }));
    const res = await wrapped({});
    assert.deepEqual(res.structuredContent, { success: true });
  });

  it("omits structuredContent for a scalar payload rather than inventing a wrapper key", async () => {
    // 0/false/'' have no object form. Inventing one (`{ value: 0 }`) would
    // advertise a shape no tool's outputSchema declares, so the key is left
    // off and `content` still carries the value verbatim.
    for (const data of [0, false, "", 42, "plain"] as const) {
      const wrapped = wrapToolHandler(async () => ({ ok: true, data }));
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
    const wrapped = wrapToolHandler(async () => ({ ok: true, data: { id: 9007199254740993n, ok: true } }));
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
      const res = await wrapToolHandler(handler)({});
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

  it("never invokes the callback when connect rejects", async () => {
    let callbackRan = false;
    await assert.rejects(
      withSharedClient(async (run) => {
        callbackRan = true;
        return run("SELECT 1");
      }),
    );
    assert.equal(callbackRan, false, "fn must not run when getPool().connect() rejects");
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
    const wrapped = wrapToolHandler(handler as (input: unknown) => Promise<unknown>);

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
