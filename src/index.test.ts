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
        result?: { tools?: { name: string; description?: string; inputSchema?: unknown }[] };
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
    } finally {
      child.kill("SIGKILL");
    }
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
