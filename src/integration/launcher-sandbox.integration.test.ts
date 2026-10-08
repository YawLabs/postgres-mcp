// The POSTGRES_MCP_SANDBOX path against a REAL oam and a REAL database.
//
// Everything else that covers the sandbox (src/index.test.ts) asserts the argv
// the launcher would hand oam, through a preloaded fake. That proves the flags
// are spelled as intended; it cannot prove oam reads them as intended. oam
// 0.18.0 changed what a port-scoped --allow-net admits and how ERR_ACCESS_DENIED
// names the resource, and until this file the grant semantics were measured by
// hand on every floor bump. No release gate elsewhere runs the server under
// --permission either: oam's own sidecar matrix runs it unsandboxed.
//
// Gated on BOTH OAM_BIN and DATABASE_URL, not on POSTGRES_MCP_INTEGRATION: it
// needs a specific oam binary as much as a database, and it never writes, so it
// does not share the fixture schema the other integration files set up.
//
//   OAM_BIN=/path/to/oam DATABASE_URL=postgres://user@localhost:5432/db npm test

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../../bin/postgres-mcp.mjs", import.meta.url));
const OAM_BIN = process.env.OAM_BIN;
const DATABASE_URL = process.env.DATABASE_URL;

const skip =
  !OAM_BIN || !existsSync(OAM_BIN)
    ? "set OAM_BIN to an oam binary at or above the launcher floor to run the sandbox against real oam"
    : !DATABASE_URL
      ? "set DATABASE_URL to a reachable postgres to run the sandbox against a real database"
      : false;

type SandboxFns = {
  sandboxEndpoint: (
    dsn: string | undefined,
    pghost: string | undefined,
    pgport: string | undefined,
  ) => { grant?: string | null; refusal?: unknown };
  sandboxFlags: (grant: string | null) => string[];
};

/**
 * The launcher's OWN grant derivation and flag builder, read from its source as
 * src/index.test.ts does (importing the launcher would launch a server). The
 * denial probe below must be run under exactly the flags the launcher passes.
 */
function loadSandboxFns(): SandboxFns {
  const source = readFileSync(LAUNCHER, "utf8");
  const pieces = [
    /function sandboxEndpoint\(dsn, pghost, pgport\) \{[\s\S]*?\r?\n\}/,
    /const SANDBOX_ENV = \[[^\]]*\];/,
    /function sandboxFlags\(grant\) \{[\s\S]*?\r?\n\}/,
  ].map((pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `could not extract ${pattern} from bin/postgres-mcp.mjs`);
    return match[0];
  });
  return new Function(`${pieces.join("\n")}\nreturn { sandboxEndpoint, sandboxFlags };`)() as SandboxFns;
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Send one JSON-RPC request and resolve its matching response. */
function rpc(child: ChildProcessWithoutNullStreams, request: { id: number; [k: string]: unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`no response to ${JSON.stringify(request.method)} within 60s`)),
      60_000,
    );
    const onData = (d: Buffer) => {
      buffer += String(d);
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
            // A partial line, or not ours -- keep reading.
          }
        }
        idx = buffer.indexOf("\n");
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/** Run `oam <flags> run <file> -- <args>` and collect its output. */
function runOam(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(OAM_BIN as string, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
      reject(new Error("oam probe did not exit within 60s"));
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("integration: the --permission sandbox on a real oam", { skip }, () => {
  it("serves a handshake and `select 1` through the launcher with POSTGRES_MCP_SANDBOX=1", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, POSTGRES_MCP_SANDBOX: "1", POSTGRES_MCP_RUNTIME: "oam" };
    const child = spawn(process.execPath, [LAUNCHER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    try {
      const init = (await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sandbox-it", version: "0" } },
      })) as { result?: { serverInfo?: { name?: string } } };
      assert.equal(init.result?.serverInfo?.name, "@yawlabs/postgres-mcp", stderr);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const call = (await rpc(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "pg_readonly", arguments: { sql: "select 1 as one" } },
      })) as { result?: { isError?: boolean; structuredContent?: { rows?: { one?: unknown }[] } } };
      assert.notEqual(call.result?.isError, true, `${JSON.stringify(call)}\n${stderr}`);
      assert.equal(call.result?.structuredContent?.rows?.[0]?.one, 1, `${JSON.stringify(call)}\n${stderr}`);
      // The server is the sandboxed oam child, not Node: the launcher never
      // falls back under the sandbox, so nothing on stderr may say it did.
      assert.doesNotMatch(stderr, /refusing to start|instead/, stderr);
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

  it("admits the pinned endpoint and refuses the port next to it with ERR_ACCESS_DENIED", async () => {
    const { sandboxEndpoint, sandboxFlags } = loadSandboxFns();
    const endpoint = sandboxEndpoint(DATABASE_URL, process.env.PGHOST, process.env.PGPORT);
    assert.ok(typeof endpoint.grant === "string", `DATABASE_URL cannot be pinned: ${JSON.stringify(endpoint)}`);
    const grant = endpoint.grant as string;
    const sep = grant.lastIndexOf(":");
    const host = grant.slice(0, sep).replace(/^\[(.*)\]$/, "$1");
    const port = Number(grant.slice(sep + 1));
    const offPort = port === 65535 ? port - 1 : port + 1;

    // A plain net.connect, as pg's own dial is, under exactly the launcher's
    // flags. The script's path comes in on argv: the flags grant no fs read.
    const dir = mkdtempSync(join(tmpdir(), "postgres-mcp-sandbox-it-"));
    dirs.push(dir);
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      [
        'import net from "node:net";',
        "const [host, port] = process.argv.slice(-2);",
        "try {",
        "  const socket = net.connect({ host, port: Number(port) });",
        '  socket.on("connect", () => { console.log("CONNECTED"); socket.destroy(); });',
        '  socket.on("error", (e) => console.log("ERROR " + e.code));',
        '} catch (e) { console.log("ERROR " + e.code); }',
      ].join("\n"),
    );
    const flags = sandboxFlags(grant);

    const allowed = await runOam([...flags, "run", probe, "--", host, String(port)]);
    assert.match(allowed.stdout, /^CONNECTED$/m, JSON.stringify(allowed));

    const denied = await runOam([...flags, "run", probe, "--", host, String(offPort)]);
    assert.match(denied.stdout, /^ERROR ERR_ACCESS_DENIED$/m, JSON.stringify(denied));
  });
});
