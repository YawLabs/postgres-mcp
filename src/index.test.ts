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
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
// bin/postgres-mcp.mjs -- the runtime launcher (newest oam preferred, node fallback).
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
  // POSTGRES_MCP_SANDBOX is deleted unless the overlay says otherwise: a value
  // exported in the developer's shell would turn every launcher test below
  // into a sandbox test, and an invalid one would refuse them all.
  for (const [k, v] of Object.entries({ POSTGRES_MCP_SANDBOX: undefined, ...overlay })) {
    // Windows env names are case-insensitive, but a spread copy is a plain
    // object: overlaying `PATH` onto a copy that holds `Path` would hand the
    // child BOTH, and which one it reads is not defined. Drop every spelling.
    for (const existing of Object.keys(env)) {
      if (existing === k || (process.platform === "win32" && existing.toUpperCase() === k.toUpperCase())) {
        delete env[existing];
      }
    }
    if (v !== undefined) env[k] = v;
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

// A path that cannot exist, used to exercise an OAM_BIN that is wrong.
const NO_OAM = process.platform === "win32" ? "C:\\__no_such_oam__\\oam.exe" : "/__no_such_oam__/oam";

/**
 * An env overlay with no oam anywhere: HOME, USERPROFILE and LOCALAPPDATA point
 * at an empty directory, so the installed locations are empty, and PATH holds
 * only the directory of the Node running this test. Discovery scans past an
 * unusable OAM_BIN, so pointing OAM_BIN at a missing path no longer keeps a real
 * oam on the developer's box out of reach -- this does. The selection variables
 * are deleted so a POSTGRES_MCP_* exported by the developer's shell cannot
 * change what is being asserted.
 */
function noOamAnywhere(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const empty = mkdtempSync(join(tmpdir(), "postgres-mcp-launcher-home-"));
  return {
    PATH: dirname(process.execPath),
    HOME: empty,
    USERPROFILE: empty,
    LOCALAPPDATA: empty,
    OAM_BIN: undefined,
    POSTGRES_MCP_RUNTIME: undefined,
    POSTGRES_MCP_SANDBOX: undefined,
    ...extra,
  };
}

/** Pull named declarations out of the launcher source, loudly. */
function extractFromLauncher(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      assert.ok(match, `could not extract ${pattern} from bin/postgres-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\r?\n\}/;

type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/**
 * Evaluate the REAL `pickNewest` source, with the floor it closes over. See
 * loadRuntimePlan for why the launcher is read as text rather than imported.
 */
function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extractFromLauncher([
    OAM_MIN_DECL,
    ATLEAST_DECL,
    /function pickNewest\(candidates\) \{[\s\S]*?\r?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

describe("launcher: runtime selection", () => {
  it("POSTGRES_MCP_RUNTIME=node runs in-process and never looks for oam", async () => {
    const res = await runLauncher(["version"], { POSTGRES_MCP_RUNTIME: "node", OAM_BIN: undefined });
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("falls back to node silently when there is no oam anywhere (the common case)", async () => {
    // A user who has never heard of oam must see exactly the old behavior,
    // with no diagnostic noise on stderr.
    const res = await runLauncher(["version"], noOamAnywhere());
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.equal(res.stderr, "", `fallback must be silent, got: ${res.stderr}`);
  });

  it("names an OAM_BIN that does not exist instead of falling back silently", async () => {
    // A typo in OAM_BIN used to mean Node with no hint why.
    const res = await runLauncher(["version"], noOamAnywhere({ OAM_BIN: NO_OAM }));
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.match(res.stderr, /^postgres-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
  });

  it("POSTGRES_MCP_RUNTIME=oam fails loudly when no usable oam exists rather than falling back", async () => {
    // An explicit demand for oam that silently ran node would hide a broken
    // deployment -- the operator asked for a specific runtime and did not get it.
    const res = await runLauncher(["version"], noOamAnywhere({ POSTGRES_MCP_RUNTIME: "oam", OAM_BIN: NO_OAM }));
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "", "nothing may be served");
    // "usable", with the floor spelled out: absent, too old and unrunnable all
    // land here, and the note under it says which one it was.
    assert.match(res.stderr, /no usable oam \(0\.15\.2 or newer\) was found/);
    assert.match(res.stderr, /^ {2}OAM_BIN=.*does not exist$/m);
    assert.match(res.stderr, /oamjs\.org/);
    // The remedies are the actionable half: an operator who demanded oam and
    // got an error needs the three ways out, not just the diagnosis.
    assert.match(res.stderr, /OAM_BIN=\/path\/to\/oam/);
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
// postgres-mcp tests prove nothing when an extension was missing. Resolved to
// the newest oam at or above the launcher's floor, with the launcher's own
// pickNewest: the first binary on PATH may be an older copy the launcher would
// pass over, which would make these tests exercise discovery instead.
const oamBin = (() => {
  const isWin = process.platform === "win32";
  const name = isWin ? "oam.exe" : "oam";
  const paths = [
    process.env.OAM_BIN,
    ...(process.env.PATH ?? "")
      .split(isWin ? ";" : ":")
      .filter(Boolean)
      .map((d) => `${d}${isWin ? "\\" : "/"}${name}`),
  ].filter((c): c is string => Boolean(c) && existsSync(c as string));
  const candidates = paths.map((path) => {
    const out = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).stdout ?? "";
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return { path, version: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null };
  });
  return loadPickNewest().pickNewest(candidates)?.path ?? null;
})();

// node:test spells conditional skips `{ skip: <reason> }` -- there is no
// it.skipIf here (that is vitest). A string reason shows up in the TAP output,
// so a skipped run says WHY rather than looking like a pass.
const noOam = oamBin ? false : "no oam at or above the launcher floor -- set OAM_BIN or install from oamjs.org";

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
// launcher: already hosted on oam, and choosing which oam.
//
// A host that resolves the package `bin` and launches `oam run
// bin/postgres-mcp.mjs` (Yaw MCP does, and so does oam's sidecar regression
// matrix) used to get a SECOND, nested oam: the launcher discovered and spawned
// one without asking what it was already running on. And discovery used to
// stop at the first binary it found, so a stale copy hid a current one.
// ─────────────────────────────────────────────────────────────────────────

type Plan = "in-process" | "discover" | "handoff-node" | "refuse-sandbox";
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
  const pieces = extractFromLauncher([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\r?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\r?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

describe("launcher: runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // `auto` and `oam` both have to take the shortcut -- `oam` demands oam, and
    // the host already is one.
    //
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on a supported oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the operator
    // asked for -- and the net grant pinned to DATABASE_URL with it -- a
    // security downgrade that no other symptom would reveal.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "1.0.0"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: true }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("never serves in-process on a host oam below the floor, sandbox or not", () => {
    // Below the floor the host must hand off. Anything older than the latest
    // oam release is not what the server is verified on, and before 0.15.0
    // the sandbox's port grant was not exact.
    for (const mode of ["auto", "oam"]) {
      for (const sandbox of [false, true]) {
        for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
          assert.equal(
            runtimePlan({ mode, hostOam, sandbox }),
            "discover",
            `mode=${mode} hostOam=${hostOam} sandbox=${sandbox}`,
          );
        }
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

  it("runs POSTGRES_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    assert.equal(runtimePlan({ mode: "node", hostOam: undefined, sandbox: false }), "in-process");
    for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
      assert.equal(runtimePlan({ mode: "node", hostOam, sandbox: false }), "handoff-node", `hostOam=${hostOam}`);
    }
  });

  it("refuses POSTGRES_MCP_RUNTIME=node under the sandbox, on every host", () => {
    // Node has no --permission, so "node" and "sandboxed" cannot both be
    // honoured. This used to serve on Node (or hand off to it) and say nothing.
    // The refusal has to come BEFORE the node branch: a plan that checked the
    // mode first would hand a sandboxed request off to Node from an oam host.
    for (const hostOam of [undefined, "0.8.2", "0.15.2", "1.0.0", "dev"]) {
      assert.equal(runtimePlan({ mode: "node", hostOam, sandbox: true }), "refuse-sandbox", `hostOam=${hostOam}`);
    }
  });
});

describe("launcher: pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    assert.deepEqual(floor, [0, 15, 2]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 15, 1]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher: the sandbox fails closed (#41).
//
// POSTGRES_MCP_SANDBOX used to fail open four ways: any value but exactly `1`
// was ignored, a fallback to Node dropped `--permission` silently, the net
// grant was a bare `--allow-net` (every host) whenever DATABASE_URL did not
// parse to a hostname, and none of it printed a word. The pure functions
// below are extracted from the launcher source the same way runtimePlan is;
// the process tests further down prove the launcher wires them.
// ─────────────────────────────────────────────────────────────────────────

type SandboxSetting = { on: boolean; shown?: string; invalid?: string };
type Refusal = {
  code: string;
  part?: string | null;
  host?: string | null;
  port?: string;
  from?: string;
  hint?: string | null;
};
type Endpoint = { grant: string | null } | { refusal: Refusal };
type Problem = { problem: string; details?: string[]; remedy: string };
type SandboxFns = {
  parseSandboxSetting: (raw: string | undefined) => SandboxSetting;
  sandboxEndpoint: (dsn: string | undefined, pghost: string | undefined, pgport: string | undefined) => Endpoint;
  endpointProblem: (refusal: Refusal) => Problem;
  sandboxRefusal: (shown: string, problem: Problem) => string;
  sandboxChildEnv: (
    source: Record<string, string | undefined>,
    names: string[],
    platform: string,
  ) => Record<string, string | undefined>;
  sandboxFlags: (grant: string | null) => string[];
  SANDBOX_ENV: string[];
};

/** Evaluate the REAL sandbox functions, with the allowlist they close over. */
function loadSandboxFns(): SandboxFns {
  const pieces = extractFromLauncher([
    /function parseSandboxSetting\(raw\) \{[\s\S]*?\r?\n\}/,
    /function sandboxEndpoint\(dsn, pghost, pgport\) \{[\s\S]*?\r?\n\}/,
    /function endpointProblem\(\{ code, part, host, port, from, hint \}\) \{[\s\S]*?\r?\n\}/,
    /function sandboxRefusal\(shown, \{ problem, details = \[\], remedy \}\) \{[\s\S]*?\r?\n\}/,
    /function sandboxChildEnv\(source, names, platform\) \{[\s\S]*?\r?\n\}/,
    /const SANDBOX_ENV = \[[^\]]*\];/,
    /function sandboxFlags\(grant\) \{[\s\S]*?\r?\n\}/,
  ]);
  return new Function(
    `${pieces}\nreturn { parseSandboxSetting, sandboxEndpoint, endpointProblem, sandboxRefusal, sandboxChildEnv, sandboxFlags, SANDBOX_ENV };`,
  )() as SandboxFns;
}

const SANDBOX_ON = ["1", " 1", "1 ", "true", "TRUE", " True ", "\t1\n"];
const SANDBOX_OFF = [undefined, "0", "false", "off", "OFF", " 0"];
const SANDBOX_INVALID = ["yes", "on", "enabled", "1x", "2", " 1x"];
// Present but empty: what an MCP client hands over for an env entry such as
// "${SANDBOX}" whose variable is unset where the client runs. Only an ABSENT
// variable (the `undefined` in SANDBOX_OFF) counts as unset.
const SANDBOX_EMPTY = ["", "   ", "\t", " \n"];

describe("launcher: parseSandboxSetting()", () => {
  const { parseSandboxSetting } = loadSandboxFns();

  it("turns the sandbox on for 1 and true, trimmed and case-insensitively", () => {
    // `=== "1"` was the bug: `true`, ` 1` and `TRUE` all ran unsandboxed.
    for (const raw of SANDBOX_ON) {
      assert.deepEqual(parseSandboxSetting(raw), { on: true, shown: raw.trim() }, JSON.stringify(raw));
    }
    assert.equal(parseSandboxSetting(" TRUE ").shown, "TRUE");
  });

  it("reads an absent variable and the explicit off values as off", () => {
    for (const raw of SANDBOX_OFF) {
      assert.deepEqual(parseSandboxSetting(raw), { on: false }, JSON.stringify(raw));
    }
  });

  it("refuses a value that is set but empty, instead of reading it as unset", () => {
    // Reading "" as unset is the fail-open this flag exists to prevent: an
    // unexpanded "${SANDBOX}" would run the server unsandboxed for an operator
    // who asked for the sandbox. src/audit.ts refuses the same value for its
    // flags, and the parity test below holds the two together.
    for (const raw of SANDBOX_EMPTY) {
      const result = parseSandboxSetting(raw);
      assert.equal(result.on, false, JSON.stringify(raw));
      assert.ok(result.invalid, `${JSON.stringify(raw)} must refuse, not read as off`);
    }
    assert.equal(
      parseSandboxSetting("").invalid,
      "postgres-mcp: POSTGRES_MCP_SANDBOX is set but empty (an unexpanded variable in the MCP config?). Refusing to start rather than read it as unset, which would run the server without the sandbox.\n" +
        "Remove the variable or set POSTGRES_MCP_SANDBOX=0 to run without the sandbox, or set it to 1 to run under oam's --permission sandbox.\n",
    );
    // The message must not claim a typo: there is no value to echo back, and a
    // list of accepted values does not tell the operator their variable never
    // expanded.
    assert.equal(parseSandboxSetting("   ").invalid?.includes("is not a recognized value"), false);
  });

  it("refuses any other value with a message naming the accepted ones", () => {
    for (const raw of SANDBOX_INVALID) {
      const result = parseSandboxSetting(raw);
      assert.equal(result.on, false, JSON.stringify(raw));
      assert.ok(result.invalid, `${JSON.stringify(raw)} must be invalid`);
      assert.ok(result.invalid.includes(JSON.stringify(raw)), `the message must echo ${JSON.stringify(raw)}`);
    }
    assert.equal(
      parseSandboxSetting("yes").invalid,
      'postgres-mcp: POSTGRES_MCP_SANDBOX="yes" is not a recognized value; expected one of "1", "true", "0", "false", "off". Refusing to start rather than guess whether the sandbox should be on.\n' +
        "Set POSTGRES_MCP_SANDBOX=1 to run under oam's --permission sandbox, or 0 to run without it.\n",
    );
  });

  it("agrees with the audit variables' strict parsing in src/audit.ts", async () => {
    // The README promises the sandbox flag reads like POSTGRES_AUDIT_REDACT.
    // Classify every value through both and hold them to the same answer, so
    // neither vocabulary can drift without this turning red.
    const { getAuditConfig } = await import("./audit.js");
    const names = ["POSTGRES_AUDIT_LOG", "POSTGRES_AUDIT_LOG_FILE", "POSTGRES_AUDIT_REDACT"] as const;
    const saved = names.map((n) => process.env[n]);
    try {
      // SANDBOX_EMPTY is the row that caught a real drift: src/audit.ts began
      // refusing a present-but-empty flag while this launcher still read it as
      // off, and this test went red on exactly POSTGRES_MCP_SANDBOX="".
      for (const raw of [...SANDBOX_ON, ...SANDBOX_OFF, ...SANDBOX_INVALID, ...SANDBOX_EMPTY]) {
        for (const n of names) delete process.env[n];
        if (raw !== undefined) process.env.POSTGRES_AUDIT_REDACT = raw;
        let audit: "on" | "off" | "invalid";
        try {
          audit = getAuditConfig().redact ? "on" : "off";
        } catch {
          audit = "invalid";
        }
        const setting = parseSandboxSetting(raw);
        const launcher = setting.invalid ? "invalid" : setting.on ? "on" : "off";
        assert.equal(launcher, audit, `POSTGRES_MCP_SANDBOX=${JSON.stringify(raw)}`);
      }
    } finally {
      names.forEach((n, i) => {
        if (saved[i] === undefined) delete process.env[n];
        else process.env[n] = saved[i];
      });
    }
  });
});

describe("launcher: sandboxEndpoint() grants", () => {
  const { sandboxEndpoint } = loadSandboxFns();

  it("pins the host and port the pg driver dials, in the driver's own order", () => {
    // Each row is a resolution rule pg applies; each was measured against the
    // bundled driver (see the drift guard below). A wrong grant is not
    // harmless in either direction: too narrow denies the operator their own
    // database, too wide is the fail-open this fixes.
    const rows: [string, string | undefined, string | undefined, string][] = [
      ["postgres://u:hunter2@db.example.com:6543/app", undefined, undefined, "db.example.com:6543"],
      ["postgres://u:hunter2@db.example.com/app", undefined, undefined, "db.example.com:5432"],
      ["postgres://u:hunter2@db.example.com/app", undefined, "7000", "db.example.com:7000"],
      ["postgres://u:hunter2@db.example.com:6543/app", "other.example", "7000", "db.example.com:6543"],
      ["postgres:///app", undefined, undefined, "localhost:5432"],
      ["postgres:///app", "pg.example", "7000", "pg.example:7000"],
      ["postgres://u:hunter2@/app", "pg.example", undefined, "pg.example:5432"],
      ["postgres://db.example.com:6543/app?host=q.example&port=7777", undefined, undefined, "q.example:7777"],
      ["postgres://db.example.com/app?host=a.example&host=b.example", undefined, undefined, "b.example:5432"],
      ["postgres://db.example.com/app?host=", "x.example", undefined, "db.example.com:5432"],
      ["postgres://db%41.example/app", undefined, undefined, "dbA.example:5432"],
      ["postgres://u:p%zz@db.example.com:5432/app", undefined, undefined, "db.example.com:5432"],
      ["postgres://u:hunter2@[::1]:5432/app", undefined, undefined, "[::1]:5432"],
      ["postgres:///app", "::1", undefined, "::1:5432"],
      ["postgresql://DB.Example.COM:5432/app", undefined, undefined, "DB.Example.COM:5432"],
      ["POSTGRES://h.example/app", undefined, undefined, "h.example:5432"],
      ["postgres://h.example:05432/app", undefined, undefined, "h.example:5432"],
      ["postgres://h.example/app?port=5432abc", undefined, undefined, "h.example:5432"],
      ["\npostgres://h.example:1/app", undefined, undefined, "h.example:1"],
      ["postgres://db_x.example./app", undefined, undefined, "db_x.example.:5432"],
    ];
    for (const [dsn, pghost, pgport, expected] of rows) {
      assert.deepEqual(
        sandboxEndpoint(dsn, pghost, pgport),
        { grant: expected },
        JSON.stringify({ dsn, pghost, pgport }),
      );
    }
  });

  it("grants nothing at all when DATABASE_URL is unset or blank", () => {
    // No --allow-net means every connection is denied. The server then reports
    // the missing variable exactly as it does unsandboxed -- and `version` and
    // tools/list still work. What it must never be is a bare --allow-net.
    for (const dsn of [undefined, "", "  "]) {
      assert.deepEqual(sandboxEndpoint(dsn, "pg.example", "7000"), { grant: null }, JSON.stringify(dsn));
    }
  });
});

describe("launcher: sandboxEndpoint() refusals", () => {
  const { sandboxEndpoint } = loadSandboxFns();
  const refusal = (dsn: string | undefined, pghost?: string, pgport?: string) => {
    const result = sandboxEndpoint(dsn, pghost, pgport);
    assert.ok(
      "refusal" in result,
      `expected a refusal for ${JSON.stringify({ dsn, pghost, pgport })}, got ${JSON.stringify(result)}`,
    );
    return result.refusal;
  };

  it("reports what the pg driver itself would fail to read", () => {
    for (const dsn of [
      "postgres://u:hunter2#x@h.example/app",
      "postgres://:6543/app",
      "postgres://h.example:65536/app",
      // A comma in the PASSWORD, with a port pg rejects: the host-list sniff
      // must look after the last `@`, or this reads as a host list.
      "postgres://u:hun,ter2@h.example:99999/db",
    ]) {
      assert.deepEqual(refusal(dsn), { code: "unparseable", part: null }, dsn);
    }
    assert.deepEqual(refusal("postgres://u%E0@h.example/app"), { code: "unparseable", part: "user name" });
    assert.deepEqual(refusal("postgres://u:%E0@h.example/app"), { code: "unparseable", part: "password" });
    assert.deepEqual(refusal("postgres://u@h.example/%E0%A4%A"), { code: "unparseable", part: "database name" });
  });

  it("refuses a host list, which a grant would split and pg cannot dial", () => {
    assert.deepEqual(refusal("postgres://u:hunter2@h1.example:5432,h2.example:5433/app"), { code: "host-list" });
    assert.deepEqual(refusal("postgres://u:hunter2@h1.example,h2.example/app"), {
      code: "host-list",
      host: "h1.example,h2.example",
      from: "url",
    });
    assert.deepEqual(refusal("postgres://h1%2Ch2/app"), { code: "host-list", host: "h1,h2", from: "url" });
    assert.deepEqual(refusal("postgres://h.example/app?host=h1,h2"), {
      code: "host-list",
      host: "h1,h2",
      from: "query",
    });
    assert.deepEqual(refusal("postgres:///app", "h1,h2"), { code: "host-list", host: "h1,h2", from: "env" });
  });

  it("refuses anything that is not a postgres:// URL, with a hint at why", () => {
    for (const dsn of [
      "not a url",
      "mysql://u:hunter2@h.example/app",
      "http://h.example:80/app",
      "localhost:5432/app",
      "postgres:db.example.com",
    ]) {
      assert.deepEqual(refusal(dsn), { code: "not-postgres", hint: null }, dsn);
    }
    // pg parses a relative input against a placeholder base and would dial a
    // host named "base" -- a grant for "base:5432" is not a grant for anything.
    assert.deepEqual(refusal(" postgres://h.example/app"), { code: "not-postgres", hint: "whitespace" });
    assert.deepEqual(refusal('"postgres://h.example/app"'), { code: "not-postgres", hint: "quotes" });
    assert.deepEqual(refusal("host=db port=6543 dbname=app"), { code: "not-postgres", hint: "key-value" });
  });

  it("refuses a Unix socket, which oam cannot connect to at all", () => {
    // host: null, never the text: on the leading-"/" form the "host" IS the
    // DSN, so there is nothing to echo that could not carry a password. The
    // no-echo test below feeds this branch credentials.
    assert.deepEqual(refusal("/var/run/postgresql app"), { code: "unix-socket", host: null, from: "path" });
    assert.deepEqual(refusal("//u:hunter2@h.example/app"), { code: "unix-socket", host: null, from: "path" });
    assert.deepEqual(refusal("postgres://%2Fvar%2Frun%2Fpostgresql/app"), {
      code: "unix-socket",
      host: "/var/run/postgresql",
      from: "url",
    });
    assert.deepEqual(refusal("socket://u@/var/run/pg?db=app"), { code: "unix-socket", host: null, from: "url" });
    assert.deepEqual(refusal("postgres://h.example/app?host=/tmp"), {
      code: "unix-socket",
      host: "/tmp",
      from: "query",
    });
    assert.deepEqual(refusal("postgres:///app", "/tmp"), { code: "unix-socket", host: "/tmp", from: "env" });
  });

  it("refuses a host an exact grant could never match", () => {
    assert.deepEqual(refusal("postgres:///app", " h "), { code: "bad-host", host: " h ", from: "env" });
    assert.deepEqual(refusal("postgres:///app", "C:/tmp"), { code: "bad-host", host: "C:/tmp", from: "env" });
    assert.deepEqual(refusal("postgres://h.example/app?host=a+b"), { code: "bad-host", host: "a b", from: "query" });
    assert.deepEqual(refusal("postgres://b\u00fccher.example/app"), {
      code: "bad-host",
      host: "b\u00fccher.example",
      from: "url",
    });
    // The space forces pg's re-encode pass, after which the host is the
    // literal "%2Fvar%2Frun" rather than a socket directory.
    assert.deepEqual(refusal("postgres://u:hunter2 x@%2Fvar%2Frun/app"), {
      code: "bad-host",
      host: "%2Fvar%2Frun",
      from: "url",
    });
  });

  it("refuses a port outside 1-65535, wherever it came from", () => {
    // oam saturates a larger port to 65535 and parseInt turns "abc" into NaN;
    // either would grant something other than what pg dials.
    assert.deepEqual(refusal("postgres://h.example:0/app"), { code: "bad-port", port: "0", from: "url" });
    assert.deepEqual(refusal("postgres://h.example/app?port=0"), { code: "bad-port", port: "0", from: "query" });
    assert.deepEqual(refusal("postgres://h.example/app?port=abc"), { code: "bad-port", port: "abc", from: "query" });
    assert.deepEqual(refusal("postgres://h.example/app?port=99999"), {
      code: "bad-port",
      port: "99999",
      from: "query",
    });
    assert.deepEqual(refusal("postgres:///app", undefined, "0x1F90"), {
      code: "bad-port",
      port: "0x1F90",
      from: "env",
    });
  });
});

describe("launcher: sandbox refusal messages", () => {
  const { sandboxEndpoint, endpointProblem, sandboxRefusal } = loadSandboxFns();
  const PASSWORD = "hunter2";
  const message = (dsn: string, pghost?: string, pgport?: string) => {
    const result = sandboxEndpoint(dsn, pghost, pgport);
    assert.ok("refusal" in result, `expected a refusal for ${dsn}`);
    return sandboxRefusal("1", endpointProblem(result.refusal));
  };
  const cases: [string, string | undefined, string | undefined][] = [
    [`postgres://u:${PASSWORD}#x@h.example/app`, undefined, undefined],
    [`postgres://u:%E0${PASSWORD}@h.example/app`, undefined, undefined],
    [`postgres://u:${PASSWORD}@h1.example:5432,h2.example:5433/app`, undefined, undefined],
    [`postgres://u:${PASSWORD}@h1.example,h2.example/app`, undefined, undefined],
    [`mysql://u:${PASSWORD}@h.example/app`, undefined, undefined],
    [` postgres://u:${PASSWORD}@h.example/app`, undefined, undefined],
    [`"postgres://u:${PASSWORD}@h.example/app"`, undefined, undefined],
    [`host=db password=${PASSWORD}`, undefined, undefined],
    [`postgres://u:${PASSWORD}@%2Fvar%2Frun/app`, undefined, undefined],
    [`socket://u:${PASSWORD}@/var/run/pg?db=app`, undefined, undefined],
    // A leading "/" is pg's socket-directory form, and here the "host" is the
    // DSN itself, not a part pulled out of it. A URL that lost its scheme to an
    // unexpanded "${PROTO}//..." lands on this branch too, and its first token
    // used to be echoed whole -- password included.
    [`//u:${PASSWORD}@h.example/app`, undefined, undefined],
    [`/u:${PASSWORD}@h.example/app`, undefined, undefined],
    [`/var/run/postgresql?password=${PASSWORD}`, undefined, undefined],
    [`postgres://u:${PASSWORD}@h.example/app?host=/tmp`, undefined, undefined],
    ["postgres:///app", "/tmp", undefined],
    ["postgres:///app", "h1,h2", undefined],
    ["postgres:///app", " h ", undefined],
    [`postgres://u:${PASSWORD}@h.example/app?host=a+b`, undefined, undefined],
    [`postgres://u:${PASSWORD}@b\u00fccher.example/app`, undefined, undefined],
    [`postgres://u:${PASSWORD}@h.example:0/app`, undefined, undefined],
    [`postgres://u:${PASSWORD}@h.example/app?port=abc`, undefined, undefined],
    ["postgres:///app", undefined, "0x1F90"],
  ];

  it("share one shape: a standalone first line, indented details, the fix last", () => {
    for (const [dsn, pghost, pgport] of cases) {
      const text = message(dsn, pghost, pgport);
      const lines = text.replace(/\n$/, "").split("\n");
      assert.match(
        lines[0],
        /^postgres-mcp: POSTGRES_MCP_SANDBOX=1 limits network access to the one database host and port the pg driver connects to, but .*; refusing to start without the sandbox\.$/,
        dsn,
      );
      for (const detail of lines.slice(1, -1)) assert.match(detail, /^ {2}\S/, `${dsn}: ${detail}`);
      assert.match(lines[lines.length - 1], /^[A-Z].*\.$/, `${dsn}: remedy line`);
      assert.ok(text.endsWith(".\n"), dsn);
    }
  });

  it("never echo DATABASE_URL, and stay printable ASCII", () => {
    // A password in the DSN must not reach an MCP host's log through a refusal,
    // and a host with non-ASCII characters is escaped rather than printed raw.
    for (const [dsn, pghost, pgport] of cases) {
      const text = message(dsn, pghost, pgport);
      assert.ok(!text.includes(PASSWORD), `${dsn} -> ${text}`);
      assert.match(text, /^[\x20-\x7E\n]*$/, `${dsn} -> ${text}`);
    }
    assert.ok(message("postgres://u:hunter2@b\u00fccher.example/app").includes('"b\\u00fccher.example"'));
  });

  it("name the offending value, where it came from, and a remedy that fits", () => {
    assert.equal(
      message("postgres:///app", "h1,h2"),
      "postgres-mcp: POSTGRES_MCP_SANDBOX=1 limits network access to the one database host and port the pg driver connects to, but " +
        'the host "h1,h2" from PGHOST lists several hosts, and the pg driver does not support multi-host connection strings; refusing to start without the sandbox.\n' +
        "  the driver would look the whole list up as one host name and fail\n" +
        "Set PGHOST to a single host.\n",
    );
    assert.ok(
      message(" postgres://h.example/app").includes("  it starts with whitespace\n  DATABASE_URL is not shown"),
    );
    assert.ok(
      message("postgres:///app", "/tmp").includes("POSTGRES_MCP_RUNTIME=node"),
      "a socket has a no-sandbox way out",
    );
    // Unsetting the sandbox would not make a bad port work, so it is not offered.
    assert.ok(!message("postgres://h.example:0/app").includes("unset POSTGRES_MCP_SANDBOX"));
    assert.ok(message("postgres://h.example/app?port=abc").includes("the port= parameter in DATABASE_URL"));
    assert.ok(message("postgres:///app", undefined, "0x1F90").includes("Correct PGPORT"));
  });
});

describe("launcher: sandboxEndpoint() against the bundled pg driver", () => {
  it("grants exactly the host:port pg dials, on a generated corpus", async () => {
    // The launcher cannot import pg, so sandboxEndpoint restates pg's rules.
    // This holds the restatement to the driver itself: build a real pg.Client
    // with a fake socket that records what connect() is called with, and
    // compare. A pg upgrade that changes parsing turns this red on purpose.
    const { default: pg } = await import("pg");
    const { sandboxEndpoint } = loadSandboxFns();
    const { EventEmitter } = await import("node:events");

    const dial = (
      dsn: string,
      env: Record<string, string | undefined>,
    ): { host: string; port: number } | { threw: true } => {
      const keys = ["DATABASE_URL", "PGHOST", "PGPORT"];
      const saved = keys.map((k) => process.env[k]);
      for (const k of keys) delete process.env[k];
      process.env.DATABASE_URL = dsn;
      for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
      try {
        const record: { args?: unknown[] } = {};
        const fake = Object.assign(new EventEmitter(), {
          setNoDelay() {},
          setKeepAlive() {},
          connect(...args: unknown[]) {
            record.args = args;
          },
          write: () => true,
          end() {},
          destroy() {},
          writable: true,
        });
        const client = new pg.Client({ connectionString: dsn, stream: () => fake as never });
        client.connect().catch(() => {});
        const args = record.args ?? [];
        // A string first argument is a Unix socket path.
        if (typeof args[0] !== "number") return { threw: true };
        return { host: String(args[1]), port: args[0] };
      } catch {
        return { threw: true };
      } finally {
        keys.forEach((k, i) => {
          if (saved[i] === undefined) delete process.env[k];
          else process.env[k] = saved[i];
        });
      }
    };

    const schemes = [
      "postgres://",
      "postgresql://",
      "POSTGRES://",
      "socket://",
      "http://",
      "mysql://",
      "",
      " postgres://",
      "\tpostgres://",
      "postgres:",
      "postgres:/",
    ];
    const userinfos = ["", "u@", "u:p@", "u:p@ss@", "u:p ss@", "u:p%zz@", "u:p#s@", "u:p/s@", "u:%40@", "u:p%2F@"];
    const hosts = [
      "",
      "db.example.com",
      "DB.Example.COM",
      "db.example.com.",
      "127.0.0.1",
      "127.1",
      "[::1]",
      "[0:0::1]",
      "h1,h2",
      "db%2Eexample",
      "%2Fvar%2Frun",
      "b\u00fccher.example",
      "db_x",
      "a b",
      "%C3",
      "base",
    ];
    const ports = ["", ":", ":6543", ":0", ":05432", ":65535", ":65536", ":abc", ":5432,h2:5433"];
    const paths = ["", "/", "/app", "/var/run/pg", "/app#frag"];
    const queries = [
      "",
      "?host=q.example",
      "?port=7777",
      "?host=%2Ftmp",
      "?host=/tmp&port=6000",
      "?host=",
      "?port=",
      "?port=abc",
      "?port=99999",
      "?host=a+b",
      "?host=[::1]",
      "?host=::1",
      "?host=h1,h2",
      "?db=app",
      "?sslmode=require&hostaddr=10.0.0.1",
    ];
    const envs: Record<string, string | undefined>[] = [
      {},
      { PGHOST: "pg.example" },
      { PGPORT: "7000" },
      { PGHOST: "pg.example", PGPORT: "7000" },
      { PGHOST: "/sock" },
      { PGHOST: "::1", PGPORT: "x" },
      { PGHOST: "", PGPORT: "" },
    ];
    let seed = 12345;
    const rnd = <T>(arr: T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return arr[(seed >>> 12) % arr.length];
    };
    const dsns: string[] = [];
    for (let i = 0; i < 4000; i++)
      dsns.push(rnd(schemes) + rnd(userinfos) + rnd(hosts) + rnd(ports) + rnd(paths) + rnd(queries));
    dsns.push(
      "not a url",
      "localhost:5432/app",
      "host=db port=6543",
      "/var/run/postgresql app",
      "socket:%2Fvar%2Frun?db=app",
      "\npostgres://h:1/app",
      "postgres://h:1/app ",
      "   ",
    );

    let grants = 0;
    for (const dsn of dsns) {
      for (const env of [rnd(envs), envs[0]]) {
        const result = sandboxEndpoint(dsn, env.PGHOST, env.PGPORT);
        const truth = dial(dsn, env);
        const label = JSON.stringify({ dsn, env, result, truth });
        if ("grant" in result) {
          if (result.grant === null) continue; // unset or blank: deny-all, pg is not consulted
          grants++;
          assert.match(result.grant, /^[^\s,]+:\d{1,5}$/, label);
          assert.ok(!("threw" in truth), `granted where pg throws: ${label}`);
          assert.equal(result.grant, `${truth.host}:${truth.port}`, label);
        } else if (result.refusal.code === "unparseable") {
          assert.ok("threw" in truth, `refused as unparseable where pg parses: ${label}`);
        }
      }
    }
    assert.ok(grants >= 200, `only ${grants} grants exercised -- the corpus has degenerated`);
  });
});

describe("launcher: sandboxChildEnv()", () => {
  const { sandboxChildEnv } = loadSandboxFns();
  const names = ["PGHOST", "DATABASE_URL"];

  it("renames an allowlisted variable to its exact spelling on Windows", () => {
    // oam's --allow-env matches names exactly; Node on Windows does not. A
    // `pghost` that works on Node would be stripped inside the sandbox.
    assert.deepEqual(sandboxChildEnv({ pghost: "a", Path: "p", DATABASE_URL: "d" }, names, "win32"), {
      PGHOST: "a",
      Path: "p",
      DATABASE_URL: "d",
    });
  });

  it("keeps an exact spelling that is already present, and drops the others", () => {
    assert.deepEqual(sandboxChildEnv({ PGHOST: "a", pghost: "b" }, names, "win32"), { PGHOST: "a" });
    assert.deepEqual(sandboxChildEnv({ pghost: "a", PgHost: "b" }, names, "win32"), { PGHOST: "a" });
  });

  it("copies the environment unchanged elsewhere", () => {
    const source = { pghost: "a", DATABASE_URL: "d" };
    const out = sandboxChildEnv(source, names, "linux");
    assert.deepEqual(out, source);
    assert.notEqual(out, source, "must be a copy");
  });
});

describe("launcher: sandboxFlags()", () => {
  const { sandboxFlags, SANDBOX_ENV } = loadSandboxFns();

  it("emits --permission, the pinned net grant and the allowlist, in that order", () => {
    assert.deepEqual(sandboxFlags("db.example.com:6543"), [
      "--permission",
      "--allow-net=db.example.com:6543",
      `--allow-env=${SANDBOX_ENV.join(",")}`,
    ]);
  });

  it("emits no --allow-net at all for a null grant", () => {
    assert.deepEqual(sandboxFlags(null), ["--permission", `--allow-env=${SANDBOX_ENV.join(",")}`]);
  });

  it("has no bare --allow-net anywhere in the launcher", () => {
    // The open grant was the fail-open: a bare `--allow-net` admits every host.
    // The only spelling left in CODE must be the pinned one, exactly once;
    // comments may still name the bare flag to say it is never passed.
    const source = readFileSync(LAUNCHER, "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /["'`]--allow-net["'`]/, "a bare --allow-net grant is back");
    assert.equal(source.match(/`--allow-net=\$\{/g)?.length, 1);
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
 * path, the pinned Node answers `--version` with v22.x, which clears the floor,
 * so it is chosen and the launcher spawns `node [flags] run <entry>` -- which
 * has no `run` subcommand, prints no version and exits non-zero. A usable
 * OAM_BIN is taken before discovery runs, so a real oam on the developer's box
 * is never reached either.
 *
 * Every run also reports, at exit, what the LAUNCHER process's argv[1] ended up
 * as. runInProcess points it at dist/index.js; a spawn or handoff leaves it on
 * the launcher. That is the only way to tell "served in-process" from "handed
 * off to a child that printed the same version".
 *
 * The selection variables are deleted so a POSTGRES_MCP_* exported by the
 * developer's shell cannot change what is being asserted.
 *
 * `extraPreload` is appended to the same preload module, for a test that has to
 * change something else about the launcher's process before it runs.
 */
function runAsHost(
  hostOam: string | undefined,
  overlay: Record<string, string | undefined> = {},
  extraPreload = "",
): Promise<RunResult> {
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const nodeArgs = ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}${extraPreload}`)}`];
  return runLauncher(
    ["version"],
    { POSTGRES_MCP_RUNTIME: undefined, POSTGRES_MCP_SANDBOX: undefined, OAM_BIN: process.execPath, ...overlay },
    // Each case boots one to three Node processes, and a bare Node start has
    // been measured at ~11s on a contended Windows box.
    { nodeArgs, timeoutMs: 90_000 },
  );
}

/** Exit code the capturing spawn stub ends the launcher with. */
const SPAWN_SENTINEL = 97;
/** A DSN with a password, so a refusal that echoes it is caught. */
const SANDBOX_DSN = "postgres://u:hunter2@stub-host:6543/db";
type SpawnStep = "capture" | "throw" | "error" | "real";
type SpawnRecord = { cmd: string; args: string[]; step: SpawnStep; envKeys: string[] };

/**
 * A preload that replaces child_process.spawn inside the launcher, so the
 * exact argv it passes to "oam" can be asserted without a real oam. Every
 * call is logged to stderr as a SPAWN_ARGV line. `steps` says what the n-th
 * call does, the last one repeating: "capture" logs and exits with
 * SPAWN_SENTINEL, "throw" throws synchronously (spawn does that for EINVAL),
 * "error" spawns a path that does not exist (an async 'error', then 'close'),
 * "real" spawns for real.
 */
function spawnPreload(...steps: SpawnStep[]): string {
  return [
    'import childProcess from "node:child_process";',
    'import { writeSync as spawnLog } from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    `const steps = ${JSON.stringify(steps)};`,
    "let calls = 0;",
    "const realSpawn = childProcess.spawn;",
    "childProcess.spawn = function (cmd, args, opts) {",
    "  const step = steps[Math.min(calls++, steps.length - 1)];",
    "  const envKeys = Object.keys(opts?.env ?? {}).filter((k) => /^(pghost|pgport|database_url)$/i.test(k)).sort();",
    '  spawnLog(2, "SPAWN_ARGV=" + JSON.stringify({ cmd, args, step, envKeys }) + "\\n");',
    `  if (step === "capture") process.exit(${SPAWN_SENTINEL});`,
    '  if (step === "throw") throw new Error("spawn EINVAL (stubbed)");',
    '  if (step === "error") return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
    "  return realSpawn.call(this, cmd, args, opts);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");
}

const spawnsOf = (run: RunResult): SpawnRecord[] =>
  [...run.stderr.matchAll(/^SPAWN_ARGV=(.*)$/gm)].map((m) => JSON.parse(m[1]) as SpawnRecord);

/**
 * Run the launcher with the sandbox on, a pinned DSN, and the spawn stub.
 * Defaults to "capture"; the overlay can turn any of it off.
 */
function runSandboxed(
  hostOam: string | undefined,
  overlay: Record<string, string | undefined> = {},
  ...steps: SpawnStep[]
): Promise<RunResult> {
  return runAsHost(
    hostOam,
    { POSTGRES_MCP_SANDBOX: "1", DATABASE_URL: SANDBOX_DSN, PGHOST: undefined, PGPORT: undefined, ...overlay },
    spawnPreload(...(steps.length ? steps : (["capture"] as SpawnStep[]))),
  );
}

/** The allowlist as the launcher ships it, for exact argv comparisons. */
const ALLOWLIST = (
  readFileSync(LAUNCHER, "utf8")
    .match(/const SANDBOX_ENV = \[([^\]]*)\]/)?.[1]
    .match(/"([^"]+)"/g) ?? []
).map((s) => s.slice(1, -1));

const expectedArgv = (grant: string | null) => [
  "--permission",
  ...(grant ? [`--allow-net=${grant}`] : []),
  `--allow-env=${ALLOWLIST.join(",")}`,
  "run",
  ENTRY,
  "--",
  "version",
];

/** A sandbox refusal: exit 1, nothing served, nothing spawned, no password. */
function assertRefused(run: RunResult, pattern: RegExp): void {
  const shown = JSON.stringify(run);
  assert.equal(run.code, 1, shown);
  assert.equal(run.stdout, "", `nothing may be served: ${shown}`);
  assert.match(run.stderr, pattern, shown);
  assert.doesNotMatch(run.stderr, IN_PROCESS_MARK, `served in-process: ${shown}`);
  assert.doesNotMatch(run.stderr, /running on .*instead/, `handed off: ${shown}`);
  assert.deepEqual(
    spawnsOf(run).filter((s) => s.step === "capture" || s.step === "real"),
    [],
    `a child was spawned: ${shown}`,
  );
  assert.ok(!run.stderr.includes("hunter2"), `the DSN leaked: ${shown}`);
}

const servedInProcess = (run: RunResult) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;
const IN_PROCESS_MARK = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const HANDED_OFF_MARK = /LAUNCHER_ARGV1=.*postgres-mcp\.mjs/;

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
      const run = await runAsHost("0.15.2", overlay);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(overlay)} -> ${JSON.stringify(run)}`);
      assert.match(run.stderr, IN_PROCESS_MARK);
    }
  });

  it("still spawns under the sandbox, with --permission and the pinned grant before `run`", async () => {
    // Exact argv, on a Node host and on a supported oam host (which would
    // otherwise serve in-process and drop the sandbox). The flags are
    // process-level: after `run` oam rejects them.
    for (const hostOam of [undefined, "0.15.2"]) {
      const run = await runSandboxed(hostOam);
      assert.equal(run.code, SPAWN_SENTINEL, `hostOam=${hostOam} -> ${JSON.stringify(run)}`);
      const spawns = spawnsOf(run);
      assert.equal(spawns.length, 1, `hostOam=${hostOam}: exactly one spawn`);
      assert.equal(spawns[0].cmd, process.execPath);
      assert.deepEqual(spawns[0].args, expectedArgv("stub-host:6543"), `hostOam=${hostOam}`);
    }
  });

  it("reads `true` as on, and derives the grant from PGHOST/PGPORT when the URL names none", async () => {
    const run = await runSandboxed(undefined, {
      POSTGRES_MCP_SANDBOX: " TRUE ",
      DATABASE_URL: "postgres:///db",
      PGHOST: "pg.example",
      PGPORT: "7000",
    });
    assert.equal(run.code, SPAWN_SENTINEL, JSON.stringify(run));
    assert.deepEqual(spawnsOf(run)[0]?.args, expectedArgv("pg.example:7000"));
  });

  it("still discovers when the host oam is below the floor", async () => {
    const run = await runAsHost("0.15.1");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    assert.doesNotMatch(run.stderr, /^postgres-mcp: /m);
  });
});

describe("launcher: no usable oam", () => {
  it("hands a below-floor oam host off to Node rather than serving on it", async () => {
    const run = await runAsHost("0.9.0", noOamAnywhere({ OAM_BIN: NO_OAM }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node child must still serve");
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/i,
    );
    // Served by the child, not in the launcher process: argv[1] was never
    // pointed at dist/index.js.
    assert.match(run.stderr, HANDED_OFF_MARK);
  });

  it("refuses to serve on a below-floor oam host when there is no Node either", async () => {
    const noNode = mkdtempSync(join(tmpdir(), "postgres-mcp-launcher-nopath-"));
    const run = await runAsHost("0.9.0", noOamAnywhere({ PATH: noNode, OAM_BIN: join(noNode, "oam.exe") }));
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /no Node was found on PATH/);
  });

  it("hands POSTGRES_MCP_RUNTIME=node off to Node even on a supported oam host", async () => {
    const run = await runAsHost("0.15.2", noOamAnywhere({ POSTGRES_MCP_RUNTIME: "node" }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, HANDED_OFF_MARK);
  });

  it("still falls back when the chosen oam fails to spawn on an oam host", async () => {
    // The chosen binary passed its --version probe and then could not be
    // spawned (deleted or replaced in between). A failed spawn emits 'error'
    // and then 'close' with the negative errno, and on an oam host the launcher
    // waits for 'close' -- so an unguarded close handler exited the launcher
    // mid-fallback and nothing served. The preload makes the FIRST spawn target
    // a path that does not exist; the Node fallback spawns normally.
    const failFirstSpawn = [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const realSpawn = childProcess.spawn;",
      "let failed = false;",
      "childProcess.spawn = function (cmd, args, opts) {",
      "  if (failed) return realSpawn.call(this, cmd, args, opts);",
      "  failed = true;",
      '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
      "};",
      "syncBuiltinESMExports();",
    ].join("\n");
    const run = await runAsHost("0.9.0", noOamAnywhere({ OAM_BIN: process.execPath }), failFirstSpawn);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node fallback must still serve");
    assert.match(run.stderr, /failed to launch oam at .*using Node instead/);
    // Served by the Node child the fallback handed off to, not in this process.
    assert.match(run.stderr, HANDED_OFF_MARK);
  });
});

describe("launcher: the sandbox refuses instead of falling back", () => {
  it("refuses an unrecognized POSTGRES_MCP_SANDBOX before anything else", async () => {
    // With POSTGRES_MCP_RUNTIME=node this would otherwise serve in-process,
    // exit 0, and the operator who typed `yes` would believe they are sandboxed.
    const run = await runSandboxed(undefined, { POSTGRES_MCP_SANDBOX: "yes", POSTGRES_MCP_RUNTIME: "node" }, "real");
    assertRefused(run, /^postgres-mcp: POSTGRES_MCP_SANDBOX="yes" is not a recognized value;/m);
    assert.deepEqual(spawnsOf(run), []);
  });

  it("refuses POSTGRES_MCP_RUNTIME=node, on a Node host and on an oam host", async () => {
    for (const hostOam of [undefined, "0.15.2"]) {
      const run = await runSandboxed(hostOam, { POSTGRES_MCP_RUNTIME: "node" }, "real");
      assertRefused(run, /POSTGRES_MCP_SANDBOX=1 needs oam to apply --permission, but POSTGRES_MCP_RUNTIME=node/);
      assert.deepEqual(spawnsOf(run), [], `hostOam=${hostOam}`);
    }
  });

  it("refuses when no usable oam exists, under auto and oam, on every host", async () => {
    // This used to be the documented edge: `auto` served without the sandbox
    // -- in-process on Node or a supported oam host, handed off to Node from
    // an old one -- and only `oam` refused. Now every combination refuses, and
    // the remedy never points at POSTGRES_MCP_RUNTIME=node.
    const rows: [string | undefined, Record<string, string | undefined>, RegExp][] = [
      [undefined, {}, /^ {2}no oam binary was found in the installed locations or on PATH$/m],
      ["0.9.0", { OAM_BIN: NO_OAM }, /^ {2}OAM_BIN=.*does not exist$/m],
      ["0.15.2", {}, /refusing to start without the sandbox/],
      ["0.15.2", { POSTGRES_MCP_RUNTIME: "oam" }, /refusing to start without the sandbox/],
    ];
    for (const [hostOam, overlay, detail] of rows) {
      const run = await runSandboxed(
        hostOam,
        noOamAnywhere({
          POSTGRES_MCP_SANDBOX: "1",
          DATABASE_URL: SANDBOX_DSN,
          PGHOST: undefined,
          PGPORT: undefined,
          ...overlay,
        }),
        "real",
      );
      assertRefused(
        run,
        /needs a freshly launched oam to apply --permission, but no usable oam \(0\.15\.2 or newer\) was found; refusing to start without the sandbox\./,
      );
      assert.match(run.stderr, detail, `hostOam=${hostOam} ${JSON.stringify(overlay)}`);
      assert.doesNotMatch(run.stderr, /use POSTGRES_MCP_RUNTIME=node/, "the unsandboxed remedy must not be offered");
      assert.deepEqual(spawnsOf(run), [], `hostOam=${hostOam}`);
    }
  });

  it("refuses when the chosen oam fails to launch, sync or async, on every host", async () => {
    // Without the sandbox a failed spawn falls back (in-process on Node, a
    // handoff from an old oam host, in-process on a supported one). Under the
    // sandbox each of those would drop --permission, so each refuses instead.
    const rows: [string | undefined, SpawnStep][] = [
      [undefined, "error"],
      ["0.9.0", "throw"],
      ["0.15.2", "error"],
    ];
    for (const [hostOam, step] of rows) {
      const run = await runSandboxed(hostOam, {}, step, "capture");
      assertRefused(
        run,
        /^postgres-mcp: POSTGRES_MCP_SANDBOX=1 needs a freshly launched oam to apply --permission, but oam at .* failed to launch \(.*\); refusing to start without the sandbox\.$/m,
      );
      const spawns = spawnsOf(run);
      assert.equal(spawns.length, 1, `hostOam=${hostOam} step=${step}: only the failed launch`);
      assert.deepEqual(spawns[0].args, expectedArgv("stub-host:6543"));
    }
  });

  it("passes no --allow-net at all when DATABASE_URL is unset", async () => {
    // Deny-all, not the old bare `--allow-net` (every host). The server still
    // starts and reports the missing variable, as it does unsandboxed.
    const run = await runSandboxed(undefined, { DATABASE_URL: undefined });
    assert.equal(run.code, SPAWN_SENTINEL, JSON.stringify(run));
    assert.deepEqual(spawnsOf(run)[0]?.args, expectedArgv(null));
  });

  it("refuses an endpoint it cannot pin, before looking for an oam", async () => {
    // With no oam anywhere, the endpoint refusal must still be the one shown:
    // the operator fixes the DSN first and learns about oam second, not the
    // other way round. The password in the DSN must not appear.
    const run = await runSandboxed(
      undefined,
      noOamAnywhere({
        POSTGRES_MCP_SANDBOX: "1",
        DATABASE_URL: "postgres://u:hunter2@h1.example,h2.example/db",
        PGHOST: undefined,
        PGPORT: undefined,
      }),
      "real",
    );
    assertRefused(run, /lists several hosts, and the pg driver does not support multi-host/);
    assert.doesNotMatch(run.stderr, /no usable oam/);
  });

  it("passes the endpoint variables to oam in exact case, and derives the grant from them", {
    skip: process.platform !== "win32" && "Windows env-name case only",
  }, async () => {
    // Node on Windows reads `database_url` as DATABASE_URL; oam's exact-match
    // --allow-env would strip it. Both the grant and the child's environment
    // have to come from the normalized copy.
    const run = await runSandboxed(undefined, {
      DATABASE_URL: undefined,
      PGHOST: undefined,
      database_url: "postgres:///db",
      pghost: "pg.example",
    });
    assert.equal(run.code, SPAWN_SENTINEL, JSON.stringify(run));
    const [spawned] = spawnsOf(run);
    assert.equal(spawned?.args[1], "--allow-net=pg.example:5432");
    assert.deepEqual(spawned?.envKeys, ["DATABASE_URL", "PGHOST"]);
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

    const listMatch = launcherSrc.match(/--allow-env=\$\{SANDBOX_ENV\.join\(","\)\}/);
    assert.ok(listMatch, "launcher no longer builds --allow-env from the SANDBOX_ENV array; update this test");

    const arrayMatch = launcherSrc.match(/const SANDBOX_ENV = \[([^\]]*)\]/);
    assert.ok(arrayMatch, "could not locate the SANDBOX_ENV array literal in the launcher");
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
