/**
 * Process-level tests for the CLI entrypoint.
 *
 * index.ts is the one module the suite cannot import: it calls
 * `server.connect(transport)` at the top level, so importing it would start a
 * stdio server inside the test runner. That left it with ZERO coverage --
 * including the argv handling that runs BEFORE the server starts, where a bad
 * condition breaks every MCP host launch while the rest of the suite stays
 * green.
 *
 * So drive the real emitted `dist/index.js` as a child process. No database is
 * touched: the pg pool is lazy, and none of these paths issue a query.
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Resolve the sibling emitted entrypoint. This file runs from dist/, so
// index.js sits next to it regardless of where the repo lives.
const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the entrypoint to completion with the given argv. */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    // These paths all exit promptly; a hang is itself a failure worth seeing.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within 20s for args ${JSON.stringify(args)}`));
    }, 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("CLI: version subcommand", () => {
  for (const flag of ["version", "--version"]) {
    it(`\`${flag}\` prints a semver line and exits 0`, async () => {
      const res = await runCli([flag]);
      assert.equal(res.code, 0, `expected exit 0, got ${res.code} (stderr: ${res.stderr})`);
      // post-publish-smoke.sh parses this exact output with `tail -1`, so the
      // version must be the last line on stdout and nothing else.
      assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/, `unexpected version output: ${JSON.stringify(res.stdout)}`);
    });
  }
});

describe("CLI: argv guard", () => {
  it("rejects an unknown bare subcommand with usage on stderr and exit 1", async () => {
    const res = await runCli(["doctor"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown subcommand 'doctor'/);
    // The usage block must survive to the reader -- this is why the guard uses
    // writeSync rather than process.stderr.write before process.exit().
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /postgres-mcp version/);
    assert.equal(res.stdout, "", "diagnostics must not go to stdout -- it is the MCP protocol channel");
  });

  it("points a positionally-passed connection string at DATABASE_URL", async () => {
    // This shape used to be silently ignored (DATABASE_URL supplied the real
    // DSN), so a generic "unknown subcommand" would read as a regression to
    // anyone who had it in their MCP config.
    for (const dsn of ["postgres://u:p@h/db", "postgresql://u:p@h/db"]) {
      const res = await runCli([dsn]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /DATABASE_URL/);
      assert.doesNotMatch(res.stderr, /unknown subcommand/);
    }
  });

  it("passes a leading-dash flag through instead of rejecting it", async () => {
    // MCP hosts may pass flags; the guard must only reject bare words. If this
    // regresses, the server refuses to start for those hosts. An unrecognized
    // flag is ignored, so the process should reach server startup -- proven by
    // the ready banner rather than by an exit.
    const child = spawn(process.execPath, [ENTRY, "--some-host-flag"], {
      env: { ...process.env, DATABASE_URL: "postgres://stub-host/stubdb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const banner = await waitForBanner(child);
      assert.match(banner, /ready/);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

/** Resolve once the startup banner (stderr, post-transport-connect) appears. */
function waitForBanner(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`no startup banner within 20s; stderr so far: ${stderr}`)), 20_000);
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.includes("ready")) {
        clearTimeout(timer);
        resolve(stderr);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`process exited before printing a banner; stderr: ${stderr}`));
    });
  });
}

describe("CLI: MCP stdio handshake with no args", () => {
  // The happy path -- and the only test that covers index.ts's tool
  // registration wiring (inputSchema.shape + annotations + wrapToolHandler).
  // A break here means every MCP host fails to launch the server.
  it("starts, completes initialize, and advertises every tool", async () => {
    const child = spawn(process.execPath, [ENTRY], {
      // A syntactically valid DSN is enough: the pool is lazy and nothing here
      // issues a query, so no postgres is contacted.
      env: { ...process.env, DATABASE_URL: "postgres://stub-host/stubdb" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const banner = await waitForBanner(child);
      assert.match(banner, /@yawlabs\/postgres-mcp v\d+\.\d+\.\d+ ready/, `unexpected banner: ${banner}`);
      // The banner states the write posture; ALLOW_WRITES is unset here.
      assert.match(banner, /read-only/);

      const initialize = await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "coverage-test", version: "0" },
        },
      });
      assert.equal(
        (initialize as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name,
        "@yawlabs/postgres-mcp",
      );

      // notifications/initialized carries no id and expects no response.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const listed = (await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
        result?: {
          tools?: {
            name: string;
            title?: string;
            description?: string;
            inputSchema?: unknown;
            annotations?: { title?: string };
          }[];
        };
      };
      const tools = listed.result?.tools ?? [];
      // Assert on the contract (shape + a couple of load-bearing names) rather
      // than an exact count, so adding a tool doesn't fail this test.
      assert.ok(tools.length >= 15, `expected the full tool set, got ${tools.length}`);
      const names = tools.map((t) => t.name);
      for (const required of ["pg_readonly", "pg_query", "pg_describe_table", "pg_kill"]) {
        assert.ok(names.includes(required), `${required} missing from tools/list: ${JSON.stringify(names)}`);
      }
      assert.ok(
        names.every((n) => n.startsWith("pg_")),
        `every tool name should be pg_-prefixed: ${JSON.stringify(names)}`,
      );
      // inputSchema must survive registration -- index.ts passes
      // `tool.inputSchema.shape`, and a regression there yields tools the host
      // cannot call.
      for (const tool of tools) {
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.inputSchema, `${tool.name} advertised no inputSchema`);
      }
      // The registerTool migration emits the display name in BOTH places on
      // purpose: `title` is where the current spec puts it, `annotations.title`
      // is the older location some hosts still read. Emitting only one leaves
      // half the hosts showing the raw `pg_*` name, and nothing else in the
      // suite looks at either field -- the wiring is only observable here, over
      // the actual protocol.
      for (const tool of tools) {
        assert.equal(typeof tool.title, "string", `${tool.name} advertised no top-level title`);
        assert.ok((tool.title ?? "").length > 0, `${tool.name} advertised an empty top-level title`);
        // Same string in both locations: a host that reads one and a host that
        // reads the other must not disagree about what the tool is called.
        assert.equal(
          tool.title,
          tool.annotations?.title,
          `${tool.name}: top-level title and annotations.title disagree`,
        );
        // A title that is just the tool name means the human-readable label was
        // lost somewhere and the raw identifier got copied in as a stand-in.
        assert.notEqual(tool.title, tool.name, `${tool.name} advertised its own name as its title`);
      }
    } finally {
      child.kill("SIGKILL");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Dual-era coverage.
//
// The 2026-07-28 spec's compatibility matrix makes "modern client against a
// legacy server" a hard failure, not a downgrade -- and a server hand-wired as
// `new McpServer().connect(new StdioServerTransport())` is legacy-only however
// new the SDK it is built against. index.ts avoids that by serving both eras
// from one factory through `serveStdio`, and NOTHING in the type system tells
// the two wirings apart: the difference is visible only over the actual
// protocol. So the 2025-era handshake above and the 2026-era one here are a
// pair -- a regression to a single-era wiring breaks exactly one of them, and
// keeping only the older test would let the modern half rot silently.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `_meta` envelope every 2026-07-28 request carries. There is no
 * `initialize` in the modern era -- the opening message declares its own era
 * inline, and that is what `serveStdio` pins the connection to.
 *
 * BOTH keys are required by the envelope validator. Dropping either one gets
 * the request answered with -32602 before it reaches any handler, which would
 * look exactly like the legacy-only rejection these tests exist to catch -- so
 * a failure here means "read the envelope" before it means "the port broke".
 */
const MODERN_ENVELOPE = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  },
} as const;

/**
 * Start the emitted entrypoint with a syntactically valid DSN and nothing else.
 *
 * `overlay` amends that environment the way runLauncher's does, `undefined`
 * DELETING a key rather than setting it empty. Deletion is the only way to
 * reach the no-DATABASE_URL paths: the runner's own environment supplies one
 * whenever the integration suite is armed, and an empty string is a THIRD state
 * -- getDatabaseUrl rejects it with the same message, but only after the empty
 * value has been read as present.
 */
function spawnServer(overlay: Record<string, string | undefined> = {}): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgres://stub-host/stubdb" };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
}

interface ToolsListResponse {
  error?: { code: number; message: string };
  result?: { tools?: { name: string; title?: string; annotations?: { title?: string } }[] };
}

describe("CLI: MCP stdio handshake with a 2026-07-28 client", () => {
  it("serves tools/list to a modern client with no initialize at all", async () => {
    const child = spawnServer();
    try {
      await waitForBanner(child);
      const listed = (await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { ...MODERN_ENVELOPE },
      })) as ToolsListResponse;

      // A legacy-only server answers this with an unsupported-protocol-version
      // error instead of a tool list, so the ABSENCE of `error` is the dual-era
      // assertion. The error body is reported because its code tells "wired to
      // one era" apart from "the envelope above is malformed".
      assert.equal(listed.error, undefined, `modern tools/list was rejected: ${JSON.stringify(listed.error)}`);

      const tools = listed.result?.tools ?? [];
      assert.ok(tools.length >= 15, `expected the full tool set, got ${tools.length}`);
      assert.ok(
        tools.every((t) => t.name.startsWith("pg_")),
        `every tool name should be pg_-prefixed: ${JSON.stringify(tools.map((t) => t.name))}`,
      );
      // ONE factory registers the tools for both eras, so the display-name
      // wiring has to survive here too. Asserting it only on the legacy path
      // would still pass if a refactor registered the full set on one era and a
      // stub on the other.
      for (const tool of tools) {
        assert.equal(typeof tool.title, "string", `${tool.name} advertised no top-level title`);
        assert.equal(tool.title, tool.annotations?.title, `${tool.name}: title and annotations.title disagree`);
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("answers server/discover, which only a modern-capable server can", async () => {
    // `server/discover` exists ONLY in the 2026 era: a legacy-only server has
    // no handler for it. This is the narrowest single frame that separates the
    // two wirings, so it fails loudly the moment someone "simplifies"
    // serveStdio back into connect(new StdioServerTransport()).
    const child = spawnServer();
    try {
      await waitForBanner(child);
      const discovered = (await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { ...MODERN_ENVELOPE },
      })) as { error?: { code: number }; result?: { supportedVersions?: unknown } };

      assert.equal(discovered.error, undefined, `server/discover was rejected: ${JSON.stringify(discovered.error)}`);
      assert.ok(discovered.result?.supportedVersions, "server/discover answered without supportedVersions");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("CLI: tools/call for a tool that does not exist", () => {
  // A BEHAVIORAL BREAK in SDK v2, pinned here because nothing else would catch
  // it. v1 RESOLVED an unknown or disabled tool call as an ordinary result
  // carrying `isError: true`; v2 REJECTS it as a JSON-RPC error with
  // ProtocolErrorCode.InvalidParams (-32602). mcp-wrapper.ts is not on this
  // path at all -- dispatch fails before any handler runs -- so its own tests
  // cannot see the change, and a caller that treated a missing tool as a soft
  // error would silently start receiving a protocol-level rejection.
  for (const era of ["legacy", "modern"] as const) {
    it(`rejects with -32602 rather than an isError envelope (${era} era)`, async () => {
      const child = spawnServer();
      try {
        await waitForBanner(child);
        if (era === "legacy") {
          await rpc(child, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "coverage-test", version: "0" },
            },
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        }

        const called = (await rpc(child, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "pg_definitely_not_a_tool",
            arguments: {},
            ...(era === "modern" ? MODERN_ENVELOPE : {}),
          },
        })) as { error?: { code: number; message: string }; result?: { isError?: boolean } };

        assert.equal(called.result, undefined, "an unknown tool must not resolve to a result envelope");
        assert.equal(called.error?.code, -32602, `expected -32602, got ${JSON.stringify(called.error)}`);
        // The tool name has to reach the message: a bare "Invalid params"
        // leaves a host unable to tell a missing tool from a bad argument.
        assert.match(called.error?.message ?? "", /pg_definitely_not_a_tool/);
      } finally {
        child.kill("SIGKILL");
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Audit attribution -- index.ts must hand each tool its OWN name.
//
// `wrapToolHandler(tool.handler, tool.name)` is what puts the `tool` field on
// every audit line the handler's SQL produces (mcp-wrapper.ts opens the
// AsyncLocalStorage frame audit.ts reads). Nine lines above that call, in the
// same object literal, sits `title: tool.annotations.title` -- a per-tool
// string of the same type. Swap one for the other and tsc stays quiet, every
// unit test stays green, and the trail an operator relies on to answer "which
// tool ran this DELETE" starts answering with a display name instead.
//
// Nothing else in the suite can see that argument. tools/tools.test.ts builds
// its own tool array and never imports index.ts; mcp-wrapper.test.ts calls
// wrapToolHandler directly and so supplies the name itself; and index.ts cannot
// be imported in-process at all -- it starts a stdio server. The wiring is only
// observable in the emitted binary, over the protocol, which is here.
// ─────────────────────────────────────────────────────────────────────────

/** One line of the JSON audit trail -- only the fields asserted below. */
interface AuditLine {
  tool?: string;
  source?: string;
  ok?: boolean;
}

/**
 * Resolve once `count` audit lines have arrived on the child's stderr.
 *
 * A wait rather than a sleep: audit.ts's `record()` writes its line
 * synchronously, BEFORE the tools/call response is serialized, so the line is
 * guaranteed written by the time that response arrives -- but it reaches this
 * process down a pipe, so it is not guaranteed READ. Attach before the
 * handshake so nothing emitted between spawn and the last call is missed.
 *
 * The startup banner shares this stream, hence the `{` filter; anything that is
 * not a JSON record is skipped rather than counted.
 */
function collectAuditLines(child: ChildProcessWithoutNullStreams, count: number): Promise<AuditLine[]> {
  return new Promise((resolve, reject) => {
    const lines: AuditLine[] = [];
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`only ${lines.length} of ${count} audit lines within 20s`)),
      20_000,
    );
    child.stderr.on("data", (d) => {
      buffer += String(d);
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        // The `sql` field carries newlines, but JSON.stringify escapes them, so
        // one audit record is always exactly one physical line.
        if (line.startsWith("{")) {
          try {
            lines.push(JSON.parse(line) as AuditLine);
          } catch {
            // Not an audit record -- keep reading.
          }
        }
        idx = buffer.indexOf("\n");
      }
      if (lines.length >= count) {
        clearTimeout(timer);
        resolve(lines);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`process exited after ${lines.length} of ${count} audit lines`));
    });
  });
}

describe("CLI: audit attribution", () => {
  it("tags each tool's statements with that tool's own name", async () => {
    // DATABASE_URL is unset ON PURPOSE. getPool() then throws inside
    // auditQuery's run(), and auditQuery's catch still records an ok:false line
    // carrying the tool field -- which is the whole field under test. So this
    // needs no database, opens no socket, and costs a fraction of a millisecond
    // per call. POSTGRES_AUDIT_LOG_FILE is cleared for a related reason: left
    // set in the ambient environment it would redirect the lines to a file, and
    // the failure would read as a missing tool field rather than a misdirected
    // sink.
    const child = spawnServer({
      DATABASE_URL: undefined,
      POSTGRES_AUDIT_LOG: "stderr",
      POSTGRES_AUDIT_LOG_FILE: undefined,
    });
    const audited = collectAuditLines(child, 2);
    // If an await below throws first, nothing ever awaits `audited`, and the
    // SIGKILL in the finally would surface its rejection as an unhandled one --
    // killing the runner instead of reporting the real failure.
    audited.catch(() => {});

    try {
      await waitForBanner(child);
      await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "coverage-test", version: "0" },
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      // Two runInternal-backed tools, both with an empty inputSchema, so the
      // arguments cannot be what tells the two audit lines apart -- only the
      // name index.ts passed to wrapToolHandler can.
      const called = ["pg_list_schemas", "pg_list_extensions"] as const;
      for (const [i, name] of called.entries()) {
        const res = (await rpc(child, {
          jsonrpc: "2.0",
          id: 2 + i,
          method: "tools/call",
          params: { name, arguments: {} },
        })) as { result?: { isError?: boolean } };
        // The missing DSN is the mechanism, so assert we actually landed on it.
        // A change that let these calls succeed -- or rejected them at the
        // protocol level -- would otherwise leave this test measuring some
        // other path while still passing.
        assert.equal(res.result?.isError, true, `expected an isError envelope for ${name}, got ${JSON.stringify(res)}`);
      }

      const lines = await audited;
      // One statement per tool, so two calls are two lines. A third would mean
      // a handler grew a fan-out and the positional pairing below no longer
      // holds -- worth failing on rather than silently re-indexing.
      assert.equal(lines.length, 2, `expected one audit line per call, got ${JSON.stringify(lines)}`);
      for (const [i, name] of called.entries()) {
        assert.equal(lines[i].ok, false, "these lines come from auditQuery's catch -- getPool() has no DSN");
        assert.equal(lines[i].source, "internal");
        // THE assertion. `tool.annotations.title` in place of `tool.name` at
        // the wrapToolHandler call yields "List schemas" / "List installed
        // extensions" here.
        assert.equal(
          lines[i].tool,
          name,
          `audit line ${i} is attributed to ${JSON.stringify(lines[i].tool)}, not ${name}`,
        );
      }
      // Equality with the name we CALLED is the load-bearing half above: the
      // annotations.title swap this test exists for produces two DISTINCT
      // values too, so distinctness alone would not catch it. Asserted anyway
      // because it is what an operator reads the trail for -- a `tool` field
      // holding one string on every line is useless whatever that string says.
      assert.notEqual(
        lines[0].tool,
        lines[1].tool,
        "both audit lines carry one tool name -- the field is not per-tool",
      );
    } finally {
      child.kill("SIGKILL");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// bin/postgres-mcp.mjs -- the runtime launcher (oam preferred, node fallback).
//
// The launcher is what package.json `bin` points at, so it is the entrypoint
// every npm consumer actually executes. It is NOT compiled by tsc (it lives in
// bin/, not src/), so nothing else in the suite would notice it breaking.
// ─────────────────────────────────────────────────────────────────────────

const LAUNCHER = fileURLToPath(new URL("../bin/postgres-mcp.mjs", import.meta.url));

/**
 * Run the launcher with an env overlay. `undefined` deletes a key.
 *
 * `nodeArgs` go to the Node running the launcher, BEFORE the launcher path --
 * the "already hosted on oam" tests use it to preload a `process.versions.oam`.
 * `timeoutMs` is a hang detector only; the discovery path boots up to three Node
 * processes, which can outrun the default on a contended Windows box.
 */
function runLauncher(
  args: string[],
  overlay: Record<string, string | undefined>,
  { nodeArgs = [], timeoutMs = 30_000 }: { nodeArgs?: string[]; timeoutMs?: number } = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, LAUNCHER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`launcher did not exit within ${timeoutMs / 1000}s for ${JSON.stringify(args)}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// A path that cannot exist, used to force the "oam not found" branch without
// depending on whether the machine actually has oam installed.
const NO_OAM = process.platform === "win32" ? "C:\\__no_such_oam__\\oam.exe" : "/__no_such_oam__/oam";

describe("launcher: runtime selection", () => {
  it("POSTGRES_MCP_RUNTIME=node runs in-process and never looks for oam", async () => {
    const res = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: "node", OAM_BIN: undefined });
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("falls back to node silently when oam is absent (the common case)", async () => {
    // auto + an OAM_BIN that does not exist. A user who has never heard of oam
    // must see exactly the old behavior, with no diagnostic noise on stderr.
    const res = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: undefined, OAM_BIN: NO_OAM });
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.equal(res.stderr, "", `fallback must be silent, got: ${res.stderr}`);
  });

  it("POSTGRES_MCP_RUNTIME=oam fails loudly when oam is absent rather than falling back", async () => {
    // An explicit demand for oam that silently ran node would hide a broken
    // deployment -- the operator asked for a specific runtime and did not get it.
    const res = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: "oam", OAM_BIN: NO_OAM });
    assert.equal(res.code, 1);
    // "runnable", not merely "present": the launcher now distinguishes a
    // binary that is absent from one that is unreadable or too old, and this
    // assertion drifted behind that wording. Kept specific rather than
    // loosened to /oam binary/ -- the word carries the distinction, so a
    // revert to a bare existsSync check should fail here.
    assert.match(res.stderr, /no runnable oam binary was found/);
    assert.match(res.stderr, /oamjs\.org/);
    // The remedies are the actionable half: an operator who demanded oam and
    // got an error needs the three ways out, not just the diagnosis.
    assert.match(res.stderr, /OAM_BIN/);
    assert.match(res.stderr, /POSTGRES_MCP_RUNTIME=node/);
  });

  it("passes the argv guard through to the server", async () => {
    const res = await runLauncher(["doctor"], { POSTGRES_MCP_RUNTIME: "node", OAM_BIN: undefined });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown subcommand 'doctor'/);
  });
});

// oam-dependent coverage. Resolved OUTSIDE the test so an absent oam reports
// as a SKIP rather than a silent pass -- the failure mode that let five
// postgres-mcp tests prove nothing when an extension was missing.
const oamBin = (() => {
  const isWin = process.platform === "win32";
  const name = isWin ? "oam.exe" : "oam";
  const candidates = [
    process.env.OAM_BIN,
    ...(process.env.PATH ?? "")
      .split(isWin ? ";" : ":")
      .filter(Boolean)
      .map((d) => `${d}${isWin ? "\\" : "/"}${name}`),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
})();

// node:test spells conditional skips `{ skip: <reason> }` -- there is no
// it.skipIf here (that is vitest). A string reason shows up in the TAP output,
// so a skipped run says WHY rather than looking like a pass.
const noOam = oamBin ? false : "oam not installed -- set OAM_BIN or install from oamjs.org";

describe("launcher: oam path", () => {
  it("runs the server under oam and preserves exit codes", { skip: noOam }, async () => {
    const version = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: "oam", OAM_BIN: oamBin as string });
    assert.equal(version.code, 0, `stderr: ${version.stderr}`);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/, "version must survive the oam hop unchanged");

    // A non-zero exit from the server must propagate through the launcher --
    // otherwise a host sees success for a failed launch.
    const bad = await runLauncher(["doctor"], { POSTGRES_MCP_RUNTIME: "oam", OAM_BIN: oamBin as string });
    assert.equal(bad.code, 1, "the child's exit code must be mirrored, not swallowed");
    assert.match(bad.stderr, /unknown subcommand 'doctor'/);
  });

  it("produces byte-identical version output on both runtimes", { skip: noOam }, async () => {
    const viaOam = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: "oam", OAM_BIN: oamBin as string });
    const viaNode = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: "node", OAM_BIN: undefined });
    assert.equal(viaOam.stdout, viaNode.stdout, "the two runtimes must not disagree about the version string");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher: already hosted on oam.
//
// A host that resolves the package `bin` and launches `oam run
// bin/postgres-mcp.mjs` (Yaw MCP does, and so does oam's sidecar regression
// matrix) used to get a SECOND, nested oam: the launcher discovered and spawned
// one without asking what it was already running on.
// ─────────────────────────────────────────────────────────────────────────

type Plan = "in-process" | "discover";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. The
 * sandbox allowlist test below reads the launcher's source the same way.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const source = readFileSync(LAUNCHER, "utf8");
  const pieces = [
    /const OAM_MIN = \[[^\]]*\];/,
    /function parseVersion\(text\) \{[\s\S]*?\r?\n\}/,
    /function atLeast\(v, min\) \{[\s\S]*?\r?\n\}/,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\r?\n\}/,
  ].map((pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `could not extract ${pattern} from bin/postgres-mcp.mjs -- renamed or reformatted?`);
    return match[0];
  });
  return new Function(`${pieces.join("\n")}\nreturn runtimePlan;`)() as RuntimePlan;
}

describe("launcher: runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // `auto` and `oam` both have to take the shortcut -- `oam` demands oam, and
    // the host already is one.
    //
    // 0.9.0 pins the floor as inclusive (it IS the supported release), and
    // 0.10.0 pins a numeric compare: it sorts BEFORE 0.9.0 as a string, so a
    // compare over the raw text would spawn a nested oam on every 0.10+ host.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.9.0", "0.10.0", "0.15.1", "1.0.0", "0.16.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the operator
    // asked for -- and the net grant pinned to DATABASE_URL with it -- a
    // security downgrade that no other symptom would reveal.
    for (const mode of ["auto", "oam"]) {
      assert.equal(runtimePlan({ mode, hostOam: "0.15.1", sandbox: true }), "discover", `mode=${mode}`);
    }
  });

  it("leaves a host oam below the floor on the discovery path", () => {
    // Same floor as a discovered binary. Below it, behaviour is exactly what it
    // was before the shortcut existed.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.8.9", "0.8.2", "0.0.1"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("runs POSTGRES_MCP_RUNTIME=node in-process whatever the host is", () => {
    for (const hostOam of [undefined, "0.8.2", "0.15.1"]) {
      assert.equal(runtimePlan({ mode: "node", hostOam, sandbox: false }), "in-process", `hostOam=${hostOam}`);
    }
  });
});

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

/**
 * Run the REAL launcher under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` and the sandbox
 * grant list -- which no amount of testing `runtimePlan` in isolation can. A
 * real oam cannot be assumed on every box this suite runs on, and the preload
 * changes exactly the one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, findOam returns that pinned Node, `node --version` clears the floor,
 * and the launcher spawns `node [flags] run <entry>` -- which has no `run`
 * subcommand, prints no version and exits non-zero. It also keeps a real oam
 * installed on the developer's box out of reach, since findOam checks the
 * override first and never scans past it.
 *
 * The selection variables are deleted so a POSTGRES_MCP_* exported by the
 * developer's shell cannot change what is being asserted.
 */
function runAsHost(hostOam: string | undefined, overlay: Record<string, string | undefined> = {}): Promise<RunResult> {
  const nodeArgs =
    hostOam === undefined
      ? []
      : [
          "--import",
          `data:text/javascript,${encodeURIComponent(
            `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`,
          )}`,
        ];
  return runLauncher(
    ["version"],
    { POSTGRES_MCP_RUNTIME: undefined, POSTGRES_MCP_SANDBOX: undefined, OAM_BIN: process.execPath, ...overlay },
    // Each case boots one to three Node processes, and a bare Node start has
    // been measured at ~11s on a contended Windows box.
    { nodeArgs, timeoutMs: 90_000 },
  );
}

const servedInProcess = (run: RunResult) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;

describe("launcher: already hosted on oam", () => {
  it("control: on plain Node the launcher still discovers and spawns", async () => {
    // Without this, the in-process cases below would also pass for a launcher
    // that ALWAYS runs in-process and never uses oam at all.
    const run = await runAsHost(undefined);
    assert.equal(servedInProcess(run), false, `expected a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });

  it("serves in-process instead of spawning a nested oam", async () => {
    for (const overlay of [{}, { POSTGRES_MCP_RUNTIME: "oam" }] as Record<string, string>[]) {
      const run = await runAsHost("0.15.1", overlay);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(overlay)} -> ${JSON.stringify(run)}`);
    }
  });

  it("still spawns under POSTGRES_MCP_SANDBOX=1, so --permission is not dropped", async () => {
    const run = await runAsHost("0.15.1", { POSTGRES_MCP_SANDBOX: "1" });
    assert.equal(servedInProcess(run), false, `the sandbox must force a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `postgres-mcp: `.
    assert.doesNotMatch(run.stderr, /^postgres-mcp: /m);
  });

  it("still discovers when the host oam is below the floor", async () => {
    const run = await runAsHost("0.8.9");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });
});

/** Send one JSON-RPC request and resolve its matching response. */
function rpc(child: ChildProcessWithoutNullStreams, request: { id: number; [k: string]: unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`no response to ${JSON.stringify(request.method)} within 20s`)),
      20_000,
    );
    const onData = (d: Buffer) => {
      buffer += String(d);
      // stdio MCP framing is newline-delimited JSON.
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as { id?: number };
            if (msg.id === request.id) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve(msg);
              return;
            }
          } catch {
            // Not our frame (or a partial line) -- keep reading.
          }
        }
        idx = buffer.indexOf("\n");
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// oam sandbox env allowlist.
//
// Under POSTGRES_MCP_SANDBOX=1 the launcher passes `--allow-env=<list>`, and
// oam DELETES any variable outside that list from process.env rather than
// throwing. So a config var added to src/ but forgotten in the launcher does
// not fail loudly -- the server reads undefined and silently takes its
// default. That already happened once: POSTGRES_APPLICATION_NAME shipped in
// api.ts without a matching allowlist entry, and the operator's configured
// name would have vanished under the sandbox with no diagnostic.
//
// This pins the invariant the CHANGELOG claims: the allowlist is derived from
// what the shipped bundle actually reads. Only STATICALLY literal reads can be
// checked -- the pg driver builds some of its own names by concatenation
// (`process.env['PG' + key.toUpperCase()]`), which no static scan can see, so
// those stay a manual entry.
// ─────────────────────────────────────────────────────────────────────────

describe("oam sandbox --allow-env allowlist", () => {
  it("covers every literal process.env read in the shipped bundle", async () => {
    const { readFileSync } = await import("node:fs");
    const launcherSrc = readFileSync(LAUNCHER, "utf8");
    const bundleSrc = readFileSync(ENTRY, "utf8");

    const listMatch = launcherSrc.match(/--allow-env=\$\{env\.join\(","\)\}/);
    assert.ok(listMatch, "launcher no longer builds --allow-env from an `env` array; update this test");

    const arrayMatch = launcherSrc.match(/const env = \[([^\]]*)\]/);
    assert.ok(arrayMatch, "could not locate the `env` array literal in the launcher");
    const allowed = new Set((arrayMatch[1].match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1)));
    assert.ok(allowed.size > 0, "parsed an empty allowlist");

    // Both spellings esbuild can emit for a literal read.
    const read = new Set<string>();
    for (const m of bundleSrc.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[1]);
    for (const m of bundleSrc.matchAll(/process\.env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g)) read.add(m[1]);

    // NODE_ENV and friends are read by bundled deps and are not ours to grant;
    // restrict the assertion to the config surface this server documents.
    const ours = [...read].filter((n) => n.startsWith("POSTGRES_") || n.startsWith("PG") || n === "ALLOW_WRITES");
    assert.ok(ours.length > 0, "found no config env reads in the bundle -- scan is broken");

    const missing = ours.filter((n) => !allowed.has(n));
    assert.deepEqual(
      missing,
      [],
      `these env vars are read by dist/index.js but absent from the launcher allowlist, ` +
        `so POSTGRES_MCP_SANDBOX=1 would silently drop them: ${JSON.stringify(missing)}`,
    );
  });
});
