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
import { existsSync } from "node:fs";
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

// ─────────────────────────────────────────────────────────────────────────
// bin/postgres-mcp.mjs -- the runtime launcher (oam preferred, node fallback).
//
// The launcher is what package.json `bin` points at, so it is the entrypoint
// every npm consumer actually executes. It is NOT compiled by tsc (it lives in
// bin/, not src/), so nothing else in the suite would notice it breaking.
// ─────────────────────────────────────────────────────────────────────────

const LAUNCHER = fileURLToPath(new URL("../bin/postgres-mcp.mjs", import.meta.url));

/** Run the launcher with an env overlay. `undefined` deletes a key. */
function runLauncher(args: string[], overlay: Record<string, string | undefined>): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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
      reject(new Error(`launcher did not exit within 30s for ${JSON.stringify(args)}`));
    }, 30_000);
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
    assert.match(res.stderr, /no oam binary was found/);
    assert.match(res.stderr, /oamjs\.org/);
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
